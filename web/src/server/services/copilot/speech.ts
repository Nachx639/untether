/**
 * The copilot's voice and ears, on the server's own engines: Qwen (Spanish) and Kokoro
 * (services/tts.ts) and the
 * resident whisper-server (routes/dictation.ts), shared with read-aloud and dictation. No
 * sidecar of its own.
 *
 *  - Sentences in the language the copilot speaks (no guessing from the text), with a small
 *    cache for the short fixed lines that come back often ("Hecho.", "Di confirmo.").
 *  - Interjection clips («A ver.», «Voy.») rendered once, trimmed of Kokoro's lead and tail
 *    silence, kept on disk next to the control dir so a restart has them at once. A clip the
 *    fallback voice rendered (Qwen off or still loading) is rendered again once Qwen reads.
 *  - Utterances transcribed with the session names as whisper's prompt (so «login» is not
 *    «Lojin»), temperature 0 and a 15 s audio context (the page caps utterances at 14 s).
 */
import { createHash } from 'crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import * as path from 'path';
import { normalizeSpeechLanguage } from '../../../shared/tts-text.js';
import { residentWhisper, transcribeUtterance, type WhisperHints } from '../../routes/dictation.js';
import { createLogger } from '../../utils/logger.js';
import {
  availableEngines,
  KOKORO_VOICES,
  QWEN_VOICE,
  residentKokoro,
  residentQwen,
  synthesizeForced,
} from '../tts.js';
import { CLIPS, type Clip, clipKey } from './clips.js';

const logger = createLogger('copilot-speech');

/** Audio context for copilot utterances (0 = whisper's default 30 s window). */
const AUDIO_CTX = Number(process.env.UNTETHER_COPILOT_WHISPER_AC ?? 768);

/** The engines behind the copilot's speech; tests pass their own. */
export interface SpeechEngines {
  synthesize(text: string, lang: string): Promise<{ audio: Buffer; engine: string } | null>;
  transcribe(wav: Buffer, lang: string, hints: WhisperHints): Promise<string | null>;
  /** The engine that reads `lang` when everything is loaded (any language when omitted). */
  ttsEngine(lang?: string): string | null;
  /**
   * The engine that reads `lang` right now: Kokoro while Qwen loads, is skipped by the memory
   * guard or is backing off after a crash. Defaults to `ttsEngine`.
   */
  ttsEngineNow?(lang: string): string | null;
  ttsReady(): boolean;
  sttAvailable(): boolean;
  /** Load the models that read `lang` (Qwen only for Spanish). */
  warmTts(lang: string): Promise<void>;
  keepAlive(): void;
}

export const serverEngines: SpeechEngines = {
  async synthesize(text, lang) {
    if (availableEngines().length === 0) return null;
    const r = await synthesizeForced(text, lang);
    return { audio: r.audio, engine: r.engine };
  },
  transcribe: (wav, lang, hints) => transcribeUtterance(wav, lang, hints),
  ttsEngine: (lang) =>
    availableEngines(lang === undefined ? undefined : (normalizeSpeechLanguage(lang) ?? 'es'))[0] ??
    null,
  ttsEngineNow: (lang) => {
    const engines = availableEngines(normalizeSpeechLanguage(lang) ?? 'es');
    if (engines[0] !== 'qwen') return engines[0] ?? null;
    return residentQwen()?.ready ? 'qwen' : (engines[1] ?? null);
  },
  ttsReady: () => {
    const engine = availableEngines()[0];
    if (engine !== 'kokoro' && engine !== 'qwen') return Boolean(engine);
    // Loaded (warmed, or started by the clips): the next sentence needs no model load. While
    // Qwen loads, Kokoro reads.
    const kokoro = residentKokoro();
    return Boolean(residentQwen()?.ready || kokoro?.ready || kokoro?.running);
  },
  sttAvailable: () => residentWhisper() !== null,
  /**
   * Kokoro (the fallback, and English) and, for Spanish, Qwen (if memory allows) loaded side
   * by side. An English conversation never loads Qwen's ~3 GB.
   */
  warmTts: async (lang) => {
    const speechLang = normalizeSpeechLanguage(lang) ?? 'es';
    await Promise.all([
      availableEngines().includes('kokoro') ? residentKokoro()?.warm() : undefined,
      availableEngines(speechLang)[0] === 'qwen' ? residentQwen()?.warm() : undefined,
    ]);
  },
  keepAlive: () => {
    residentKokoro()?.keepAlive();
    residentQwen()?.keepAlive();
    residentWhisper()?.keepAlive();
  },
};

export class CopilotSpeech {
  /** Short lines with the engine that read them (a hit counts only in today's voice). */
  private readonly cache = new Map<string, { audio: Buffer; engine: string }>();
  /** Interjection clips, never evicted (replaced once the preferred voice can read them). */
  readonly clipPool = new Map<string, Buffer>();
  readonly clipMsMap = new Map<string, number>();
  /** The engine each clip in the pool was rendered with. */
  readonly clipEngines = new Map<string, string>();
  readonly clipFailed: string[] = [];
  private clipsRendering: Promise<void> | null = null;
  private sttWarm: Promise<void> | null = null;

  constructor(
    private readonly clipDir: string | null,
    readonly engines: SpeechEngines = serverEngines
  ) {}

  private engineNow(lang: string): string | null {
    return this.engines.ttsEngineNow
      ? this.engines.ttsEngineNow(lang)
      : this.engines.ttsEngine(lang);
  }

  /** A WAV for one sentence, or null. */
  async synthesize(text: string, lang: string): Promise<Buffer | null> {
    const key = `${lang}|${text}`;
    const hit = this.cache.get(key);
    // Only in the voice that reads now: a Kokoro line cached while Qwen loaded (or was off)
    // is read again by Qwen once it is ready, instead of coming back in the other voice.
    if (hit && hit.engine === this.engineNow(lang)) return hit.audio;
    const r = await this.engines.synthesize(text, lang).catch((error) => {
      logger.warn(`speech failed: ${error}`);
      return null;
    });
    if (!r) return null;
    if (text.length <= 80) {
      this.cache.delete(key);
      this.cache.set(key, { audio: r.audio, engine: r.engine });
      if (this.cache.size > 96) this.cache.delete(this.cache.keys().next().value as string);
    }
    return r.audio;
  }

  /** Synthesize lines ahead of time (the fixed ones, the greeting). */
  async prewarm(texts: string[], lang: string): Promise<void> {
    for (const t of texts) await this.synthesize(t, lang);
  }

  /** `prompt`: session names and the copilot's words. Null when whisper is not available. */
  async transcribe(
    wav: Buffer,
    lang: string,
    prompt: string
  ): Promise<{ text: string; ms: number } | null> {
    const t0 = Date.now();
    const text = await this.engines
      .transcribe(wav, lang, { prompt, temperature: 0, audioCtx: AUDIO_CTX || undefined })
      .catch((error) => {
        logger.warn(`transcription failed: ${error}`);
        return null;
      });
    if (text === null) return null;
    return { text: text.replace(/\s+/g, ' ').trim(), ms: Date.now() - t0 };
  }

  /** Kokoro (and Qwen for Spanish) loaded, whisper loaded and past its slow first inference. */
  warm(lang = 'es'): void {
    void this.engines
      .warmTts(lang)
      .catch(() => undefined)
      // Qwen just became ready: clips the fallback voice rendered are rendered again.
      .then(() => (this.clipPool.size ? this.renderClips() : undefined));
    this.sttWarm ??= (async () => {
      if (!this.engines.sttAvailable()) return;
      await this.engines.transcribe(silentWav(500), 'es', {}).catch(() => null);
    })().finally(() => {
      this.sttWarm = null;
    });
  }

  keepAlive(): void {
    this.engines.keepAlive();
    if (this.clipPool.size) void this.renderClips();
  }

  status() {
    return {
      tts: this.engines.ttsEngine(),
      ttsReady: this.engines.ttsReady(),
      stt: this.engines.sttAvailable(),
    };
  }

  clip(c: Pick<Clip, 'lang' | 'id'>): Buffer | undefined {
    return this.clipPool.get(clipKey(c.lang, c.id));
  }

  clipMs(c: Pick<Clip, 'lang' | 'id'>): number | undefined {
    return this.clipMsMap.get(clipKey(c.lang, c.id));
  }

  /** Not in the pool (and not failed), or in a fallback voice the preferred one can now replace. */
  private needsRender(c: Clip): boolean {
    const k = clipKey(c.lang, c.id);
    if (!this.clipPool.has(k)) return !this.clipFailed.includes(k);
    const preferred = this.engines.ttsEngine(c.lang);
    return this.clipEngines.get(k) !== preferred && this.engineNow(c.lang) === preferred;
  }

  /**
   * Every clip, from the disk cache or rendered (one retry). Resolves once every clip is in
   * the pool; clips the fallback voice rendered are re-rendered in the background once the
   * preferred voice reads (each call checks; a call with nothing to do costs nothing).
   */
  renderClips(): Promise<void> {
    if (this.clipsRendering) return this.clipsRendering;
    if (!this.engines.ttsEngine()) return Promise.resolve();
    const todo = CLIPS.filter((c) => this.needsRender(c));
    if (!todo.length) return Promise.resolve();
    const missing = todo.some((c) => !this.clipPool.has(clipKey(c.lang, c.id)));
    const pass = this.renderPass(todo)
      .catch((error) => {
        logger.warn(`clips failed: ${error}`);
      })
      .finally(() => {
        if (this.clipsRendering === pass) this.clipsRendering = null;
      });
    this.clipsRendering = pass;
    return missing ? pass : Promise.resolve();
  }

  private async renderPass(todo: Clip[]): Promise<void> {
    if (this.clipDir) {
      try {
        mkdirSync(this.clipDir, { recursive: true });
      } catch {
        // No disk cache: clips are rendered in memory only.
      }
    }
    const t0 = Date.now();
    const warmed = new Map<string, Promise<void>>();
    let rendered = 0;
    const failed: string[] = [];
    for (const c of todo) {
      const k = clipKey(c.lang, c.id);
      const had = this.clipPool.has(k);
      const clipEngine = this.engines.ttsEngine(c.lang) ?? this.engines.ttsEngine() ?? '';
      const voice = clipEngine === 'qwen' ? QWEN_VOICE : (KOKORO_VOICES[c.lang]?.voice ?? c.lang);
      const hash = createHash('sha1')
        .update(`trim1|${clipEngine}|${voice}|${c.text}`)
        .digest('hex');
      const file = this.clipDir ? path.join(this.clipDir, `${hash.slice(0, 16)}.wav`) : null;
      let wav: Buffer | null = null;
      let engine = clipEngine;
      try {
        if (file) wav = readFileSync(file);
      } catch {
        wav = null;
      }
      // Not on disk and read by Qwen: wait (once) for it to load, so the clips come out in
      // the voice that reads the answers (a few seconds; the clips are not on the hot path).
      // Kokoro's clips (English) never wait for Qwen.
      if (!wav && clipEngine === 'qwen') {
        let w = warmed.get(c.lang);
        if (!w) {
          w = this.engines.warmTts(c.lang).catch(() => undefined);
          warmed.set(c.lang, w);
        }
        await w;
      }
      for (let attempt = 0; attempt < 2 && !wav; attempt++) {
        const raw = await this.engines.synthesize(c.text, c.lang).catch(() => null);
        const trimmed = raw && trimClip(raw.audio);
        if (!raw || !trimmed) continue;
        // Re-rendering a fallback clip only helps in the preferred voice.
        if (had && raw.engine !== clipEngine) break;
        wav = trimmed.wav;
        engine = raw.engine;
        try {
          // A fallback voice's clip stays in memory only: the next server renders it again.
          if (file && raw.engine === clipEngine) writeFileSync(file, wav, { mode: 0o600 });
        } catch {
          // Kept in memory.
        }
      }
      const w = wav && readWav(wav);
      if (!wav || !w) {
        if (!had) {
          this.clipFailed.push(k);
          failed.push(k);
        }
        continue;
      }
      this.clipPool.set(k, wav);
      this.clipEngines.set(k, engine);
      this.clipMsMap.set(k, Math.round((w.samples.length / w.rate) * 1000));
      rendered++;
    }
    logger.log(
      `clips ${rendered}/${todo.length} ready in ${Date.now() - t0} ms (pool ${this.clipPool.size}/${CLIPS.length})${failed.length ? `; failed: ${failed.join(', ')}` : ''}`
    );
  }
}

/** PCM 16 mono WAV → samples + rate. */
export function readWav(wav: Buffer): { rate: number; samples: Int16Array } | null {
  if (wav.length < 12) return null;
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    return null;
  }
  let rate = 0;
  let channels = 1;
  let bits = 16;
  for (let o = 12; o + 8 <= wav.length; ) {
    const id = wav.toString('ascii', o, o + 4);
    const size = wav.readUInt32LE(o + 4);
    const body = o + 8;
    if (id === 'fmt ') {
      channels = wav.readUInt16LE(body + 2);
      rate = wav.readUInt32LE(body + 4);
      bits = wav.readUInt16LE(body + 14);
    } else if (id === 'data') {
      if (bits !== 16 || channels !== 1 || !rate) return null;
      const end = Math.min(wav.length, body + size);
      const n = Math.floor((end - body) / 2);
      const samples = new Int16Array(n);
      for (let i = 0; i < n; i++) samples[i] = wav.readInt16LE(body + i * 2);
      return { rate, samples };
    }
    o = body + size + (size & 1);
  }
  return null;
}

export function writeWav(samples: Int16Array, rate: number): Buffer {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + samples.length * 2, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) b.writeInt16LE(samples[i], 44 + i * 2);
  return b;
}

/**
 * Lead and tail silence off (below −45 dBFS, in 5 ms windows), 15 ms fade-in, 25 ms fade-out:
 * a clip must start sounding the moment it is scheduled.
 */
export function trimClip(wav: Buffer): { wav: Buffer; leadMs: number; ms: number } | null {
  const w = readWav(wav);
  if (!w || !w.samples.length) return null;
  const { rate, samples } = w;
  const th = 32768 * 10 ** (-45 / 20);
  const win = Math.max(1, Math.round(rate * 0.005));
  const loud = (i: number) => {
    let s = 0;
    const end = Math.min(samples.length, i + win);
    for (let j = i; j < end; j++) s += samples[j] * samples[j];
    return Math.sqrt(s / Math.max(1, end - i)) > th;
  };
  let start = 0;
  while (start < samples.length && !loud(start)) start += win;
  let end = samples.length;
  while (end > start && !loud(Math.max(start, end - win))) end -= win;
  if (end <= start) return null;
  // Keep 10 ms before the onset and 60 ms of decay after the last loud window.
  const s0 = Math.max(0, start - Math.round(rate * 0.01));
  const s1 = Math.min(samples.length, end + Math.round(rate * 0.06));
  const out = samples.slice(s0, s1);
  const fin = Math.round(rate * 0.015);
  const fout = Math.round(rate * 0.025);
  for (let i = 0; i < Math.min(fin, out.length); i++) out[i] = Math.round(out[i] * (i / fin));
  for (let i = 0; i < Math.min(fout, out.length); i++) {
    out[out.length - 1 - i] = Math.round(out[out.length - 1 - i] * (i / fout));
  }
  return {
    wav: writeWav(out, rate),
    leadMs: Math.round((s0 / rate) * 1000),
    ms: Math.round((out.length / rate) * 1000),
  };
}

export function silentWav(ms: number, rate = 16000): Buffer {
  return writeWav(new Int16Array(Math.round((rate / 1000) * ms)), rate);
}
