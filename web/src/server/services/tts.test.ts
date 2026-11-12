import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chunkForSpeech,
  detectSpeechLanguage,
  MAX_TTS_CHARS,
  splitSentences,
} from '../../shared/tts-text';
import { snapshotEnv } from '../../test/helpers/env-snapshot.js';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { createTtsRoutes } from '../routes/tts';
import {
  availableEngines,
  cleanForSpeech,
  QWEN_SIDECAR,
  qwenSetup,
  ResidentQwen,
  reclaimableMemory,
  residentQwen,
  stopResidentKokoroForTests,
  synthesize,
  synthesizeForced,
} from './tts';

describe('chunkForSpeech', () => {
  it('starts with a short chunk and groups the rest by sentence', () => {
    const reply =
      'He revisado el código. Todo compila sin errores y los tests pasan. ' +
      'También he limpiado dos funciones que no se usaban, y he actualizado la documentación ' +
      'del módulo de dictado para que explique el nuevo flujo. ¿Quieres que lo suba?';
    const chunks = chunkForSpeech(reply);
    expect(chunks[0]).toBe('He revisado el código. Todo compila sin errores y los tests pasan.');
    expect(chunks.join(' ')).toBe(reply);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(320);
  });

  it('cuts a sentence that has no punctuation for a long time', () => {
    const long = `${'palabra '.repeat(200)}fin.`;
    const parts = splitSentences(long);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(320);
    expect(parts.join(' ')).toBe(long.trim());
    for (const chunk of chunkForSpeech(long))
      expect(chunk.length).toBeLessThanOrEqual(MAX_TTS_CHARS);
  });

  it('gives nothing for blank text', () => {
    expect(chunkForSpeech('  \n ')).toEqual([]);
  });
});

describe('detectSpeechLanguage', () => {
  it.each([
    ['He terminado de revisar el código y todo está bien.', 'es'],
    ['I finished reviewing the code and everything is fine.', 'en'],
    ["J'ai fini de relire le code et tout est bon pour vous.", 'fr'],
    ['Eu terminei de revisar o código e está tudo certo, não há erros.', 'pt'],
    ['我已经检查了代码，一切正常。', 'zh'],
    ['Vale, ya está.', 'es'],
  ])('%s -> %s', (text, lang) => {
    expect(detectSpeechLanguage(text)).toBe(lang);
  });

  it('uses the hint when the text is too short to tell', () => {
    expect(detectSpeechLanguage('OK.', 'es')).toBe('es');
  });
});

it('drops code blocks, links and markdown before reading', () => {
  expect(cleanForSpeech('**Hecho**: mira `app.ts` ```\nrm -rf\n``` en https://x.y/z 🎉')).toBe(
    'Hecho : mira app.ts en'
  );
});

describe('engines', () => {
  let dir: string;
  /** The fake engines, written once for the file (see beforeAll). */
  let bins: string;
  let restoreEnv: () => void;

  /*
   * 2026-11-02: macOS checks a program the first time it runs (~70-100 ms here, more under
   * load), and every test wrote its fake engines afresh: most of this file's time. The fakes
   * are written once per file and told the test's folder and behaviour through the
   * environment their parent passes on (FAKE_TTS_DIR and the FAKE_* below).
   */
  beforeAll(() => {
    bins = mkdtempSync(join(tmpdir(), 'ut-tts-bins-'));
    // A fake `say`: logs its arguments (each followed by \x1f, each call by \x1e) and writes
    // a tiny WAV to the -o path. A shell script: `say` itself is not what this file checks.
    const say = (failVoice: boolean) => `#!/bin/sh
log="$FAKE_TTS_DIR/say.log"
for arg in "$@"; do printf '%s\\037' "$arg"; done >> "$log"
printf '\\036' >> "$log"
if ${failVoice} && [ "$1" = "-v" ]; then exit 1; fi
out=; prev=
for arg in "$@"; do [ "$prev" = "-o" ] && out=$arg; prev=$arg; done
printf 'RIFF' > "$out"
head -c 96 /dev/zero >> "$out"
`;
    writeFileSync(join(bins, 'say'), say(false));
    writeFileSync(join(bins, 'say-no-voice'), say(true));
    // A fake Kokoro "python": speaks the sidecar protocol and writes a WAV per request.
    writeFileSync(
      join(bins, 'kokoro'),
      `#!${process.execPath}
const fs = require('fs');
const dir = process.env.FAKE_TTS_DIR;
const failText = process.env.FAKE_KOKORO_FAIL_TEXT;
fs.appendFileSync(dir + '/kokoro.starts', 'x');
console.log(JSON.stringify({ ready: true }));
require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const req = JSON.parse(line);
  fs.appendFileSync(dir + '/kokoro.log', line + '\\n');
  if (failText !== undefined && req.text === failText) return console.log(JSON.stringify({ id: req.id, ok: false, error: 'boom' }));
  fs.writeFileSync(req.out, Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(200)]));
  console.log(JSON.stringify({ id: req.id, ok: true }));
});
`
    );
    // A fake Qwen "python": the sidecar protocol, ready after FAKE_QWEN_READY_MS, cancels
    // honoured, FAKE_QWEN_FAIL_TEXT answers an error, "slow…" texts take 300 ms.
    writeFileSync(
      join(bins, 'qwen'),
      `#!${process.execPath}
const fs = require('fs');
const dir = process.env.FAKE_TTS_DIR;
const failText = process.env.FAKE_QWEN_FAIL_TEXT;
fs.appendFileSync(dir + '/qwen.starts', JSON.stringify(process.argv.slice(2)) + '\\n');
const cancelled = new Set();
setTimeout(() => {
  console.log('Loaded speech tokenizer');
  console.log(JSON.stringify({ ready: true }));
}, Number(process.env.FAKE_QWEN_READY_MS || 0));
require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const req = JSON.parse(line);
  fs.appendFileSync(dir + '/qwen.log', line + '\\n');
  if ('cancel' in req) return cancelled.add(req.cancel);
  if (failText !== undefined && req.text === failText) return console.log(JSON.stringify({ id: req.id, ok: false, error: 'boom' }));
  setTimeout(() => {
    if (cancelled.has(req.id)) return console.log(JSON.stringify({ id: req.id, ok: false, error: 'aborted' }));
    fs.writeFileSync(req.out, Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(300)]));
    console.log(JSON.stringify({ id: req.id, ok: true }));
  }, req.text.startsWith('slow') ? 300 : 0);
});
`
    );
    for (const name of ['say', 'say-no-voice', 'kokoro', 'qwen'])
      chmodSync(join(bins, name), 0o755);
  });

  afterAll(() => {
    rmSync(bins, RM_TEST_DIR);
  });

  /** The fake `say` (one that fails with `-v` when `failVoice`). */
  function fakeSay(failVoice = false) {
    return join(bins, failVoice ? 'say-no-voice' : 'say');
  }

  /** The argument lists the fake `say` was called with, in order. */
  const sayCalls = () =>
    readFileSync(join(dir, 'say.log'), 'utf8')
      .split('\x1e')
      .filter(Boolean)
      .map((call) => call.split('\x1f').slice(0, -1));

  /** Fake Kokoro set up: its models under the TTS dir, `failText` answered with an error. */
  function fakeKokoro(failText?: string) {
    if (failText === undefined) delete process.env.FAKE_KOKORO_FAIL_TEXT;
    else process.env.FAKE_KOKORO_FAIL_TEXT = failText;
    const models = join(dir, 'tts', 'models');
    mkdirSync(models, { recursive: true });
    writeFileSync(join(models, 'kokoro-v1.0.fp16.onnx'), '');
    writeFileSync(join(models, 'voices-v1.0.bin'), '');
    process.env.UNTETHER_TTS_DIR = join(dir, 'tts');
    process.env.UNTETHER_TTS_PYTHON = join(bins, 'kokoro');
    process.env.UNTETHER_CONTROL_DIR = join(dir, 'control', 'x');
    mkdirSync(join(dir, 'control'), { recursive: true });
  }

  /**
   * A fake Qwen install under the TTS dir: refs and model/config.json, and the fake sidecar
   * (ready after `readyMs`, cancels honoured, `failText` answers an error).
   */
  function fakeQwen({ failText, readyMs = 0 }: { failText?: string; readyMs?: number } = {}) {
    const home = process.env.UNTETHER_TTS_DIR as string;
    const qwen = join(home, 'qwen');
    mkdirSync(join(qwen, 'model'), { recursive: true });
    mkdirSync(join(qwen, 'refs'), { recursive: true });
    writeFileSync(join(qwen, 'model', 'config.json'), '{}');
    for (const f of ['ref_en1_s4.wav', 'ref_en1_s4.txt', 'spk_M1.wav']) {
      writeFileSync(join(qwen, 'refs', f), '');
    }
    if (failText === undefined) delete process.env.FAKE_QWEN_FAIL_TEXT;
    else process.env.FAKE_QWEN_FAIL_TEXT = failText;
    process.env.FAKE_QWEN_READY_MS = String(readyMs);
    process.env.UNTETHER_QWEN_PYTHON = join(bins, 'qwen');
    process.env.UNTETHER_QWEN_MIN_FREE_MB = '0';
  }

  const starts = () => {
    try {
      return readFileSync(join(dir, 'qwen.starts'), 'utf8').trim().split('\n').filter(Boolean);
    } catch {
      return [];
    }
  };

  const qwenRequests = () =>
    readFileSync(join(dir, 'qwen.log'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));

  const until = async (check: () => boolean, ms = 3000) => {
    for (const end = Date.now() + ms; !check(); ) {
      if (Date.now() > end) throw new Error('timed out waiting');
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  beforeEach(() => {
    restoreEnv = snapshotEnv();
    dir = mkdtempSync(join(tmpdir(), 'ut-tts-'));
    process.env.FAKE_TTS_DIR = dir;
    process.env.UNTETHER_TTS_DIR = join(dir, 'none');
    process.env.UNTETHER_PIPER = join(dir, 'no-piper');
    process.env.UNTETHER_SAY = join(dir, 'no-say');
    // Whatever the developer's shell sets for the real engines stays out of the fakes' way.
    for (const key of [
      'UNTETHER_TTS_PYTHON',
      'UNTETHER_TTS_ENGINE',
      'UNTETHER_TTS_QWEN',
      'UNTETHER_QWEN_PYTHON',
      'UNTETHER_QWEN_MIN_FREE_MB',
      'UNTETHER_KOKORO_MODEL',
      'UNTETHER_KOKORO_VOICES',
      'UNTETHER_PIPER_MODEL',
      'UNTETHER_CONTROL_DIR',
    ])
      delete process.env[key];
  });

  afterEach(() => {
    stopResidentKokoroForTests();
    restoreEnv();
    rmSync(dir, RM_TEST_DIR);
  });

  it('reads with `say` and the voice for the language, as an argument array', async () => {
    process.env.UNTETHER_SAY = fakeSay();
    const speech = await synthesize('Hola, ¿qué tal estás? Todo está listo.', undefined);
    expect(speech.engine).toBe('say');
    expect(speech.lang).toBe('es');
    const calls = sayCalls();
    expect(calls).toHaveLength(1);
    const args = calls[0];
    expect(args.slice(0, 2)).toEqual(['-v', 'Mónica']);
    expect(args.slice(-2)).toEqual(['--', 'Hola, ¿qué tal estás? Todo está listo.']);
  });

  it('falls back to the system voice when that voice is missing', async () => {
    process.env.UNTETHER_SAY = fakeSay(true);
    const speech = await synthesize('-v Hello there, this is the end of it.', 'en');
    expect(speech.engine).toBe('say');
    const calls = sayCalls();
    expect(calls).toHaveLength(2);
    expect(calls[1][0]).toBe('-o');
    // Text that looks like an option still comes after "--".
    expect(calls[1].slice(-2)).toEqual(['--', '-v Hello there, this is the end of it.']);
  });

  it('uses resident Kokoro first (started once) and falls back to say when it fails', async () => {
    fakeKokoro('Esto falla y lo lee say.');
    process.env.UNTETHER_SAY = fakeSay();
    const first = await synthesize('Hola, he terminado la tarea.', 'es');
    const second = await synthesize('I finished the task, and it is fine.', 'es');
    expect([first.engine, second.engine]).toEqual(['kokoro', 'kokoro']);
    expect(second.lang).toBe('en');
    const requests = readFileSync(join(dir, 'kokoro.log'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(requests.map((r) => [r.voice, r.lang])).toEqual([
      ['ef_dora', 'es'],
      ['af_heart', 'en-us'],
    ]);
    expect(readFileSync(join(dir, 'kokoro.starts'), 'utf8')).toBe('x');
    const fallback = await synthesize('Esto falla y lo lee say.', 'es');
    expect(fallback.engine).toBe('say');
  });

  it('removes its temporary files', async () => {
    process.env.UNTETHER_SAY = fakeSay();
    const work = join(dir, 'tmp');
    mkdirSync(work);
    process.env.TMPDIR = work;
    await synthesize('Hello there, all is good.', 'en', undefined, undefined, null);
    expect(readdirSync(work)).toEqual([]);
  });

  describe('qwen (Spanish voice)', () => {
    it('comes first for Spanish only, and only when installed', () => {
      fakeKokoro();
      process.env.UNTETHER_SAY = fakeSay();
      expect(qwenSetup()).toBeNull();
      expect(availableEngines('es')).toEqual(['kokoro', 'say']);
      fakeQwen();
      expect(availableEngines('es')).toEqual(['qwen', 'kokoro', 'say']);
      expect(availableEngines('en')).toEqual(['kokoro', 'say']);
      expect(availableEngines('fr')).toEqual(['kokoro', 'say']);
      expect(availableEngines()).toEqual(['qwen', 'kokoro', 'say']);
      process.env.UNTETHER_TTS_QWEN = '0';
      expect(availableEngines('es')).toEqual(['kokoro', 'say']);
    });

    it('answers with Kokoro while it loads, then reads Spanish itself', async () => {
      fakeKokoro();
      fakeQwen({ readyMs: 300 });
      const cold = await synthesizeForced('Hola, ya he terminado.', 'es');
      expect(cold.engine).toBe('kokoro');
      // The cold reply started the load in the background, once.
      await until(() => residentQwen()?.ready === true);
      const warm = await synthesizeForced('Tienes 11 sesiones abiertas.', 'es');
      expect(warm.engine).toBe('qwen');
      expect(warm.audio.toString('ascii', 0, 4)).toBe('RIFF');
      expect(starts()).toHaveLength(1);
      const args = JSON.parse(starts()[0]);
      expect(args.slice(0, 2)).toEqual(['-u', '-c']);
      expect(args[2]).toBe(QWEN_SIDECAR);
      expect(args).toContain('--speaker');
      expect(args[args.indexOf('--speaker') + 1]).toMatch(/spk_M1\.wav$/);
      expect(args[args.indexOf('--ref-audio') + 1]).toMatch(/ref_en1_s4\.wav$/);
      expect(qwenRequests().map((r) => r.text)).toEqual(['Tienes 11 sesiones abiertas.']);
      // English stays with Kokoro; so does the queued path's chain.
      expect((await synthesizeForced('I am done with the task.', 'en')).engine).toBe('kokoro');
      expect((await synthesize('Vale, ya está hecho todo.', 'es')).engine).toBe('qwen');
      expect((await synthesize('All done, the tests pass.', 'en')).engine).toBe('kokoro');
    });

    it('falls back to Kokoro when it fails', async () => {
      fakeKokoro();
      fakeQwen({ failText: 'Esto falla.' });
      await residentQwen()?.warm();
      expect((await synthesizeForced('Esto falla.', 'es')).engine).toBe('kokoro');
      expect((await synthesize('Esto falla.', 'es')).engine).toBe('kokoro');
      expect((await synthesizeForced('Esto no falla.', 'es')).engine).toBe('qwen');
    });

    it('falls back when the sidecar cannot start', async () => {
      fakeKokoro();
      fakeQwen();
      const broken = join(dir, 'qwen-broken');
      writeFileSync(
        broken,
        '#!/usr/bin/env node\nconsole.log(JSON.stringify({ fatal: true, error: "no mlx" }));process.exit(1);\n'
      );
      chmodSync(broken, 0o755);
      process.env.UNTETHER_QWEN_PYTHON = broken;
      expect(await residentQwen()?.warm()).toBe(false);
      expect((await synthesizeForced('Hola, ¿qué tal?', 'es')).engine).toBe('kokoro');
      expect(residentQwen()?.running).toBe(false);
    });

    it('is not started when memory is short, and Kokoro reads', async () => {
      fakeKokoro();
      fakeQwen();
      process.env.UNTETHER_QWEN_MIN_FREE_MB = '5120';
      const setup = qwenSetup();
      if (!setup) throw new Error('no setup');
      const pid = join(dir, 'control', 'qwen.pid');
      const low = new ResidentQwen(setup, 60_000, pid, async () => 3 * 2 ** 30);
      expect(await low.warm()).toBe(false);
      expect(low.running).toBe(false);
      expect(starts()).toEqual([]);
      expect(
        (await synthesizeForced('Hola, aquí estoy.', 'es', undefined, undefined, low)).engine
      ).toBe('kokoro');
      const roomy = new ResidentQwen(setup, 60_000, pid, async () => 8 * 2 ** 30);
      expect(await roomy.warm()).toBe(true);
      roomy.stop();
    });

    it('reads reclaimable memory from vm_stat', async () => {
      const vmStat = [
        'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
        'Pages free:                                    1000.',
        'Pages active:                                 99999.',
        'Pages inactive:                                2000.',
        'Pages speculative:                              100.',
      ].join('\n');
      const run = (async () => ({ stdout: vmStat, stderr: '' })) as never;
      expect(await reclaimableMemory(run)).toBe(16384 * 3100);
    });

    it('stops after the idle time and cancels an aborted reply', async () => {
      fakeQwen();
      const setup = qwenSetup();
      if (!setup) throw new Error('no setup');
      const qwen = new ResidentQwen(setup, 150, join(dir, 'control', 'qwen.pid'), async () => 0);
      process.env.UNTETHER_QWEN_MIN_FREE_MB = '0';
      expect(await qwen.warm()).toBe(true);
      const abort = new AbortController();
      const pending = qwen.synthesize('slow sentence', join(dir, 'slow.wav'), abort.signal);
      setTimeout(() => abort.abort(), 50);
      expect(await pending).toBe(false);
      await until(() => qwenRequests().some((r) => 'cancel' in r));
      expect(qwen.running).toBe(true);
      await until(() => !qwen.running, 2000);
      expect(qwen.ready).toBe(false);
    });

    it('stops after the idle time when it was loaded but never asked for anything', async () => {
      fakeQwen();
      const setup = qwenSetup();
      if (!setup) throw new Error('no setup');
      const qwen = new ResidentQwen(setup, 150, join(dir, 'control', 'qwen.pid'), async () => 0);
      expect(await qwen.warm()).toBe(true);
      expect(qwen.running).toBe(true);
      await until(() => !qwen.running, 2000);
      expect(starts()).toHaveLength(1);
    });

    it('backs off after crashes, and gives up after three in 10 minutes', async () => {
      fakeKokoro();
      fakeQwen();
      const setup = qwenSetup();
      if (!setup) throw new Error('no setup');
      const pidFile = join(dir, 'control', 'qwen.pid');
      const qwen = new ResidentQwen(setup, 60_000, pidFile, async () => 0);
      const realNow = Date.now.bind(Date);
      let skew = 0;
      vi.spyOn(Date, 'now').mockImplementation(() => realNow() + skew);
      const crash = async () => {
        process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL');
        await until(() => !qwen.running);
      };
      try {
        expect(await qwen.warm()).toBe(true);
        await crash();
        expect(existsSync(pidFile)).toBe(false);
        // The next reply goes to Kokoro and does not reload Qwen.
        expect(
          (await synthesizeForced('Hola otra vez.', 'es', undefined, undefined, qwen)).engine
        ).toBe('kokoro');
        expect(await qwen.warm()).toBe(false);
        expect(qwen.usable).toBe(false);
        expect(starts()).toHaveLength(1);
        skew += 61_000;
        expect(await qwen.warm()).toBe(true);
        await crash();
        skew += 61_000;
        expect(await qwen.warm()).toBe(false);
        skew += 5 * 60_000;
        expect(await qwen.warm()).toBe(true);
        await crash();
        skew += 60 * 60_000;
        expect(await qwen.warm()).toBe(false);
        expect(starts()).toHaveLength(3);
      } finally {
        vi.restoreAllMocks();
        qwen.stop();
      }
    });

    it('does not spawn when stopped while the memory check runs', async () => {
      fakeQwen();
      const setup = qwenSetup();
      if (!setup) throw new Error('no setup');
      let release: (bytes: number) => void = () => undefined;
      const memory = new Promise<number>((resolve) => {
        release = resolve;
      });
      const qwen = new ResidentQwen(setup, 60_000, join(dir, 'control', 'qwen.pid'), () => memory);
      const warming = qwen.warm();
      qwen.stop();
      release(8 * 2 ** 30);
      expect(await warming).toBe(false);
      expect(qwen.running).toBe(false);
      expect(starts()).toEqual([]);
      // Not a failure: a later start is not held back.
      expect(await qwen.warm()).toBe(true);
      qwen.stop();
    });
  });

  describe('routes', () => {
    async function withServer(fn: (base: string) => Promise<void>) {
      const app = express();
      app.use('/api', createTtsRoutes());
      const server = app.listen(0, '127.0.0.1');
      try {
        await new Promise((resolve) => server.once('listening', resolve));
        const { port } = server.address() as AddressInfo;
        await fn(`http://127.0.0.1:${port}/api`);
      } finally {
        server.close();
      }
    }

    it('POST /api/tts answers WAV audio and names the engine', async () => {
      process.env.UNTETHER_SAY = fakeSay();
      await withServer(async (base) => {
        const response = await fetch(`${base}/tts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: 'Vale, ya está hecho.', lang: 'es-ES' }),
          signal: AbortSignal.timeout(5000),
        });
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('audio/wav');
        expect(response.headers.get('x-tts-engine')).toBe('say');
        expect(Buffer.from(await response.arrayBuffer()).toString('ascii', 0, 4)).toBe('RIFF');
      });
    });

    it('refuses empty and overlong text, and reports when no engine exists', async () => {
      await withServer(async (base) => {
        const post = (body: unknown) =>
          fetch(`${base}/tts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
        expect((await post({ text: ' ' })).status).toBe(400);
        expect((await post({ text: 'x'.repeat(MAX_TTS_CHARS + 1) })).status).toBe(413);
        expect((await post({ text: 'hola' })).status).toBe(503);
        const status = await (await fetch(`${base}/tts/status`)).json();
        expect(status).toMatchObject({ available: false, engine: null });
      });
    });

    it('GET /api/tts/status names Kokoro when it is set up', async () => {
      fakeKokoro();
      process.env.UNTETHER_SAY = fakeSay();
      await withServer(async (base) => {
        const status = await (await fetch(`${base}/tts/status`)).json();
        expect(status).toMatchObject({
          available: true,
          engine: 'kokoro',
          engines: ['kokoro', 'say'],
        });
      });
    });
  });
});
