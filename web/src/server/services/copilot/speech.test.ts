import { mkdtempSync, readdirSync, rmSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { RM_TEST_DIR } from '../../../test/helpers/rm-test-dir.js';
import { CLIPS } from './clips';
import {
  CopilotSpeech,
  readWav,
  type SpeechEngines,
  silentWav,
  trimClip,
  writeWav,
} from './speech';

/** 22.05 kHz tone with silence around it, like a Kokoro clip. */
function toneWav(leadMs: number, toneMs: number, tailMs: number, rate = 22050) {
  const n = (ms: number) => Math.round((rate / 1000) * ms);
  const samples = new Int16Array(n(leadMs) + n(toneMs) + n(tailMs));
  for (let i = 0; i < n(toneMs); i++) {
    samples[n(leadMs) + i] = Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / rate));
  }
  return writeWav(samples, rate);
}

function engines(over: Partial<SpeechEngines> = {}) {
  const calls: { text: string; lang: string }[] = [];
  const stt: { lang: string; prompt?: string; audioCtx?: number; temperature?: number }[] = [];
  const e: SpeechEngines = {
    synthesize: async (text, lang) => {
      calls.push({ text, lang });
      return { audio: toneWav(120, 300, 200), engine: 'kokoro' };
    },
    transcribe: async (_wav, lang, hints) => {
      stt.push({ lang, ...hints });
      return '  hola   login ';
    },
    ttsEngine: () => 'kokoro',
    ttsReady: () => true,
    sttAvailable: () => true,
    warmTts: async () => undefined,
    keepAlive: () => undefined,
    ...over,
  };
  return { e, calls, stt };
}

const until = async (check: () => boolean, ms = 3000) => {
  for (const end = Date.now() + ms; !check(); ) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, RM_TEST_DIR);
});

describe('copilot speech', () => {
  it('reads and writes 16-bit mono WAVs', () => {
    const wav = writeWav(new Int16Array([0, 1000, -1000, 32767]), 16000);
    expect(readWav(wav)).toEqual({ rate: 16000, samples: new Int16Array([0, 1000, -1000, 32767]) });
    expect(readWav(Buffer.from('nope'))).toBeNull();
    expect(readWav(silentWav(500))?.samples.length).toBe(8000);
  });

  it('trims lead and tail silence off a clip', () => {
    const t = trimClip(toneWav(200, 300, 300));
    expect(t).not.toBeNull();
    // 300 ms of tone, plus 10 ms before and up to 60 ms after.
    expect(t?.ms).toBeGreaterThanOrEqual(300);
    expect(t?.ms).toBeLessThanOrEqual(380);
    expect(t?.leadMs).toBeGreaterThanOrEqual(185);
    expect(trimClip(silentWav(300))).toBeNull();
  });

  it('keeps the language it is given, and caches short lines', async () => {
    const { e, calls } = engines();
    const speech = new CopilotSpeech(null, e);
    await speech.synthesize('Hecho.', 'es');
    await speech.synthesize('Hecho.', 'es');
    await speech.synthesize('Done.', 'en');
    expect(calls).toEqual([
      { text: 'Hecho.', lang: 'es' },
      { text: 'Done.', lang: 'en' },
    ]);
  });

  it('gives whisper the names, temperature 0 and a short audio context', async () => {
    const { e, stt } = engines();
    const speech = new CopilotSpeech(null, e);
    const r = await speech.transcribe(silentWav(100), 'es', 'login. confirmo, para.');
    expect(r?.text).toBe('hola login');
    expect(stt[0]).toMatchObject({ lang: 'es', prompt: 'login. confirmo, para.', temperature: 0 });
    expect(stt[0].audioCtx).toBe(768);
  });

  it('says null when there is no whisper', async () => {
    const { e } = engines({ transcribe: async () => null });
    expect(await new CopilotSpeech(null, e).transcribe(silentWav(100), 'es', '')).toBeNull();
  });

  it('renders every clip once and keeps them on disk', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'copilot-clips-'));
    dirs.push(dir);
    const first = engines();
    const a = new CopilotSpeech(dir, first.e);
    await a.renderClips();
    // Clips with the same words in the same voice are rendered once.
    expect(first.calls.length).toBe(new Set(CLIPS.map((c) => `${c.lang}|${c.text}`)).size);
    expect(a.clipPool.size).toBe(CLIPS.length);
    expect(readdirSync(dir).length).toBeGreaterThan(0);
    // A restart reads them back without rendering.
    const second = engines();
    const b = new CopilotSpeech(dir, second.e);
    await b.renderClips();
    expect(second.calls.length).toBe(0);
    expect(b.clipMs(CLIPS[0])).toBeGreaterThan(0);
  });

  it('serves cached lines and clips only in the voice that reads now', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'copilot-clips-'));
    dirs.push(dir);
    let qwenReady = false;
    const warms: string[] = [];
    const { e, calls } = engines({
      // Spanish is Qwen's; until it is loaded Kokoro answers.
      ttsEngine: (lang) => (lang === 'en' ? 'kokoro' : 'qwen'),
      ttsEngineNow: (lang) => (lang === 'es' && qwenReady ? 'qwen' : 'kokoro'),
      synthesize: async (text, lang) => {
        calls.push({ text, lang });
        const engine = lang === 'es' && qwenReady ? 'qwen' : 'kokoro';
        return { audio: toneWav(120, 300, 200), engine };
      },
      warmTts: async (lang) => {
        warms.push(lang);
      },
    });
    const speech = new CopilotSpeech(dir, e);
    // While Qwen loads (or is off), Kokoro's line is reused.
    await speech.synthesize('Hecho.', 'es');
    await speech.synthesize('Hecho.', 'es');
    expect(calls).toHaveLength(1);
    await speech.renderClips();
    // Only the Spanish clips (Qwen's) waited for a model load, once.
    expect(warms).toEqual(['es']);
    // Every clip is usable now, but only the English ones (in their final voice) hit the disk.
    expect(speech.clipPool.size).toBe(CLIPS.length);
    const english = new Set(CLIPS.filter((c) => c.lang === 'en').map((c) => c.text)).size;
    expect(readdirSync(dir).length).toBe(english);
    // Nothing to redo while Kokoro still reads Spanish.
    calls.length = 0;
    await speech.renderClips();
    expect(calls).toHaveLength(0);
    // Qwen is ready: the line is read again in its voice (then cached), and the Spanish clips
    // are rendered again in the background and written to disk.
    qwenReady = true;
    await speech.synthesize('Hecho.', 'es');
    await speech.synthesize('Hecho.', 'es');
    expect(calls).toHaveLength(1);
    calls.length = 0;
    const es = CLIPS.filter((c) => c.lang === 'es');
    speech.keepAlive();
    await until(() => es.every((c) => speech.clipEngines.get(`es|${c.id}`) === 'qwen'));
    expect(calls.every((c) => c.lang === 'es')).toBe(true);
    expect(readdirSync(dir).length).toBe(english + new Set(es.map((c) => c.text)).size);
    calls.length = 0;
    await speech.renderClips();
    expect(calls).toHaveLength(0);
  });

  it('renders no clips without any voice', async () => {
    const { e, calls } = engines({ ttsEngine: () => null });
    const s = new CopilotSpeech(null, e);
    await s.renderClips();
    expect(calls).toEqual([]);
    expect(s.clipPool.size).toBe(0);
  });
});
