import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { describe, expect, it, vi } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import {
  createDictationRoutes,
  DictationBusyError,
  isAppWav,
  isWhisperCommand,
  ResidentWhisper,
  transcribe,
  whisperLanguage,
} from './dictation';

const tools = { ffmpeg: '/bin/ffmpeg', whisper: '/bin/whisper-cli', model: '/m.bin' };

/** execFile double: ffmpeg succeeds; whisper answers per language. */
function fakeRun(byLanguage: Record<string, string>, delayMs = 0) {
  return vi.fn(async (file: string, args: string[]) => {
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (file === tools.ffmpeg) return { stdout: '', stderr: '' };
    const language = args[args.indexOf('-l') + 1];
    return { stdout: byLanguage[language] ?? '', stderr: '' };
  });
}

describe('whisperLanguage', () => {
  it.each([
    ['es-ES', 'es'],
    ['nb-NO', 'no'],
    ['pt_BR', 'pt'],
    ['xx-YY', 'auto'],
    [undefined, 'auto'],
    ['-l', 'auto'],
  ])('%s -> %s', (input, expected) => {
    expect(whisperLanguage(input)).toBe(expected);
  });
});

describe('transcribe', () => {
  it('retries with auto-detection when the chosen language gives nothing', async () => {
    const run = fakeRun({ es: '', auto: ' Hello there ' });
    await expect(transcribe(Buffer.from('x'), 'es', tools, run as never)).resolves.toBe(
      'Hello there'
    );
    const languages = run.mock.calls
      .filter(([file]) => file === tools.whisper)
      .map(([, args]) => (args as string[])[(args as string[]).indexOf('-l') + 1]);
    expect(languages).toEqual(['es', 'auto']);
  });

  it('forces WAV from a local file for ffmpeg', async () => {
    const run = fakeRun({ es: 'hola' });
    await transcribe(Buffer.from('x'), 'es', tools, run as never);
    const ffmpegArgs = run.mock.calls.find(([file]) => file === tools.ffmpeg)?.[1] as string[];
    expect(ffmpegArgs.slice(ffmpegArgs.indexOf('-f'), ffmpegArgs.indexOf('-i'))).toEqual([
      '-f',
      'wav',
      '-protocol_whitelist',
      'file',
    ]);
  });

  it('refuses more than two recordings waiting behind the current one', async () => {
    const run = fakeRun({ es: 'hola' }, 50);
    const jobs = [0, 1, 2].map(() => transcribe(Buffer.from('x'), 'es', tools, run as never));
    await expect(transcribe(Buffer.from('x'), 'es', tools, run as never)).rejects.toBeInstanceOf(
      DictationBusyError
    );
    await Promise.all(jobs);
  });

  it('skips a queued recording whose request was abandoned', async () => {
    const run = fakeRun({ es: 'hola' }, 30);
    const first = transcribe(Buffer.from('x'), 'es', tools, run as never);
    const abort = new AbortController();
    const second = transcribe(Buffer.from('x'), 'es', tools, run as never, abort.signal);
    abort.abort();
    await first;
    await expect(second).rejects.toThrow('aborted');
    expect(run).toHaveBeenCalledTimes(2); // only the first job's ffmpeg + whisper
  });
});

describe('POST /api/dictation/transcribe', () => {
  it('answers with the text (the route used to abort itself and hang)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ut-dictation-route-'));
    const script = (name: string, body: string) => {
      const file = join(dir, name);
      writeFileSync(file, `#!/bin/sh\n${body}\n`);
      chmodSync(file, 0o755);
      return file;
    };
    const model = join(dir, 'ggml-test.bin');
    writeFileSync(model, '');
    vi.stubEnv('UNTETHER_FFMPEG', script('ffmpeg', 'exit 0'));
    vi.stubEnv('UNTETHER_WHISPER_CLI', script('whisper-cli', 'echo " hola mundo "'));
    vi.stubEnv('UNTETHER_WHISPER_MODEL', model);
    vi.stubEnv('UNTETHER_WHISPER_SERVER', 'off');
    const app = express();
    app.use('/api', createDictationRoutes());
    const server = app.listen(0, '127.0.0.1');
    try {
      await new Promise((resolve) => server.once('listening', resolve));
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/api/dictation/transcribe?lang=es`, {
        method: 'POST',
        headers: { 'Content-Type': 'audio/wav' },
        body: Buffer.from('RIFF....WAVE'),
        signal: AbortSignal.timeout(5000),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ text: 'hola mundo' });
    } finally {
      server.close();
      vi.unstubAllEnvs();
      rmSync(dir, RM_TEST_DIR);
    }
  });
});

/** A 16 kHz mono 16-bit WAV with `samples` silent samples. */
function appWav(samples = 1600): Buffer {
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + samples * 2, 4);
  wav.write('WAVEfmt ', 8, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24);
  wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(samples * 2, 40);
  return wav;
}

describe('resident whisper-server', () => {
  it("recognizes the app's own WAV (no ffmpeg needed)", () => {
    expect(isAppWav(appWav())).toBe(true);
    expect(isAppWav(Buffer.from('#EXTM3U\nfile:///etc/hosts'))).toBe(false);
  });

  it('starts once, keeps serving, and skips ffmpeg for the app WAV', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ut-whisper-server-'));
    const bin = join(dir, 'whisper-server');
    const starts = join(dir, 'starts');
    // Stand-in server: node listening on the --port it's given, counting how often it starts.
    writeFileSync(
      bin,
      `#!/usr/bin/env node
require('fs').appendFileSync(${JSON.stringify(starts)}, 'x');
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
require('http').createServer((req, res) => {
  if (req.url === '/inference') { req.resume(); req.on('end', () => res.end(JSON.stringify({ text: ' hola rapido ' }))); return; }
  res.end('ok');
}).listen(port, '127.0.0.1');
`
    );
    chmodSync(bin, 0o755);
    const server = new ResidentWhisper(bin, '/model.bin', 60_000, join(dir, 'pid'));
    const run = vi.fn(async () => ({ stdout: 'cli', stderr: '' }));
    try {
      const toolsWithServer = { ...tools, server: bin };
      for (let i = 0; i < 2; i++) {
        await expect(
          transcribe(appWav(), 'es', toolsWithServer, run as never, undefined, server)
        ).resolves.toBe('hola rapido');
      }
      expect(run).not.toHaveBeenCalled(); // neither ffmpeg nor whisper-cli
      expect(readFileSync(starts, 'utf8')).toBe('x');
    } finally {
      server.stop();
      rmSync(dir, RM_TEST_DIR);
    }
  }, 20_000);
});

// 2026-10-20 (security audit): the pid file's pid got SIGTERM without checking what it was.
describe('stopping an orphaned whisper-server', () => {
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it('recognizes whisper-server by its executable name only', () => {
    expect(
      isWhisperCommand(
        '/opt/homebrew/Cellar/whisper-cpp/1.8/bin/whisper-server',
        '/opt/homebrew/bin/whisper-server'
      )
    ).toBe(true);
    expect(isWhisperCommand('/usr/bin/vim', '/opt/homebrew/bin/whisper-server')).toBe(false);
    expect(isWhisperCommand(null, '/opt/homebrew/bin/whisper-server')).toBe(false);
  });

  it('leaves a process that is not whisper alone, and stops one that is', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ut-whisper-orphan-'));
    const pidFile = join(dir, 'pid');
    const victim = spawn('sleep', ['30'], { stdio: 'ignore' });
    try {
      const pid = victim.pid as number;
      writeFileSync(pidFile, String(pid));
      // Real `ps` lookup: the pid is a `sleep`, not whisper-server.
      const real = new ResidentWhisper(
        '/opt/homebrew/bin/whisper-server',
        '/m.bin',
        60_000,
        pidFile
      );
      (real as unknown as { stopOrphan(): void }).stopOrphan();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(alive(pid)).toBe(true);

      const whisper = new ResidentWhisper(
        '/opt/homebrew/bin/whisper-server',
        '/m.bin',
        60_000,
        pidFile,
        () => '/opt/homebrew/bin/whisper-server'
      );
      const exited = new Promise((resolve) => victim.once('exit', resolve));
      (whisper as unknown as { stopOrphan(): void }).stopOrphan();
      await exited;
      expect(alive(pid)).toBe(false);
    } finally {
      victim.kill('SIGKILL');
      rmSync(dir, RM_TEST_DIR);
    }
  });
});
