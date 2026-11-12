/**
 * Audio for «Conversar» (the voice copilot): one AudioContext unlocked inside the opening tap,
 * the microphone (echo cancellation, noise suppression, auto gain), a playback queue where the
 * copilot's sentences and interjection clips never overlap, ducking under the user's voice,
 * earcons, and the screen wake lock. Turn-taking itself is copilot-vad.ts.
 */
import { createLogger } from './logger.js';

const logger = createLogger('copilot-audio');

export type SourceKind = 'answer' | 'clip' | 'hold';

interface Playing {
  src: AudioBufferSourceNode;
  gain: GainNode;
  kind: SourceKind;
  t0: number;
  t1: number;
}

/** Why the microphone can't be used, in the sheet's words. */
export type MicProblem = 'insecure' | 'denied' | 'denied-frame' | 'none' | 'other';

export function micProblem(error: unknown): MicProblem {
  if (typeof window === 'undefined' || !window.isSecureContext) return 'insecure';
  if (!navigator.mediaDevices?.getUserMedia) return 'insecure';
  const name = (error as { name?: string } | null)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return window.top !== window ? 'denied-frame' : 'denied';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'none';
  return 'other';
}

function newAudioContext(): AudioContext {
  const w = window as Window & { webkitAudioContext?: typeof AudioContext };
  const Context = window.AudioContext || (w.webkitAudioContext as typeof AudioContext);
  return new Context();
}

/** Mono Float32 chunks at `from` Hz → 16 kHz 16-bit WAV (linear interpolation). */
export function wav16k(parts: Float32Array[], from: number): ArrayBuffer {
  const to = 16000;
  const n = parts.reduce((s, p) => s + p.length, 0);
  const all = new Float32Array(n);
  let o = 0;
  for (const p of parts) {
    all.set(p, o);
    o += p.length;
  }
  const ratio = from / to;
  const len = Math.floor(n / ratio);
  const buf = new ArrayBuffer(44 + len * 2);
  const v = new DataView(buf);
  const w = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i));
  };
  w(0, 'RIFF');
  v.setUint32(4, 36 + len * 2, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, to, true);
  v.setUint32(28, to * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, 'data');
  v.setUint32(40, len * 2, true);
  for (let i = 0; i < len; i++) {
    const x = i * ratio;
    const i0 = Math.floor(x);
    const f = x - i0;
    const s = Math.max(-1, Math.min(1, (all[i0] ?? 0) * (1 - f) + (all[i0 + 1] ?? 0) * f));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}

const EARCONS: Record<string, Array<[number, number]>> = {
  tick: [[1400, 0.04]],
  done: [
    [660, 0.07],
    [990, 0.09],
  ],
  needs: [
    [330, 0.08],
    [330, 0.08],
  ],
  error: [
    [700, 0.07],
    [440, 0.1],
  ],
};

export class CopilotAudio {
  ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sources: Playing[] = [];
  private queueEnd = 0;
  private ducked = false;
  private stream: MediaStream | null = null;
  private micNode: MediaStreamAudioSourceNode | null = null;
  private proc: ScriptProcessorNode | null = null;
  private micPending: Promise<boolean> | null = null;
  /** Something stopped playing and nothing else is queued. */
  onIdle: (() => void) | null = null;
  /** The context was suspended or came back (a call, Siri, another app). */
  onState: ((running: boolean) => void) | null = null;

  /** Creates (or resumes) the context. Call inside a tap the first time. */
  ensure(): AudioContext {
    if (!this.ctx) {
      const ctx = newAudioContext();
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.master.connect(ctx.destination);
      ctx.onstatechange = () => this.onState?.(ctx.state === 'running');
    }
    if (this.ctx.state !== 'running') void this.ctx.resume().catch(() => undefined);
    return this.ctx;
  }

  /** iOS: audio plays later only if something played inside the tap (0.1 s of silence). */
  unlock(): void {
    const ctx = this.ensure();
    const b = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * 0.1), ctx.sampleRate);
    const s = ctx.createBufferSource();
    s.buffer = b;
    s.connect(ctx.destination);
    s.start();
  }

  get running(): boolean {
    return this.ctx?.state === 'running';
  }

  get hasMic(): boolean {
    return Boolean(this.stream);
  }

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 48000;
  }

  playing(): boolean {
    return Boolean(this.ctx && this.ctx.currentTime < this.queueEnd - 0.02);
  }

  /** Only interjection or hold clips are playing: no answer audio yet. */
  onlyClipsPlaying(): boolean {
    return this.sources.length > 0 && this.sources.every((s) => s.kind !== 'answer');
  }

  /** performance.now() of a context time. */
  perfAt(t: number): number {
    return performance.now() + (t - (this.ctx?.currentTime ?? 0)) * 1000;
  }

  decode(data: ArrayBuffer): Promise<AudioBuffer> {
    const ctx = this.ensure();
    return new Promise((resolve, reject) => {
      // Safari's decodeAudioData still has the callback form only on some versions.
      const p = ctx.decodeAudioData(data, resolve, reject);
      p?.catch?.(reject);
    });
  }

  /** Queue one buffer after whatever plays: returns its start (context time). */
  schedule(audio: AudioBuffer, kind: SourceKind): number {
    const ctx = this.ensure();
    const master = this.master as GainNode;
    master.gain.cancelScheduledValues(ctx.currentTime);
    master.gain.setValueAtTime(this.ducked ? 0.25 : 1, ctx.currentTime);
    const src = ctx.createBufferSource();
    src.buffer = audio;
    const gain = ctx.createGain();
    src.connect(gain);
    gain.connect(master);
    const start = Math.max(ctx.currentTime + 0.02, this.queueEnd);
    src.start(start);
    this.queueEnd = start + audio.duration;
    const entry: Playing = { src, gain, kind, t0: start, t1: start + audio.duration };
    this.sources.push(entry);
    src.onended = () => {
      this.sources = this.sources.filter((s) => s !== entry);
      if (!this.playing()) this.onIdle?.();
    };
    return start;
  }

  /**
   * A hold clip («Un momento.») with more than 200 ms left fades out in 80 ms when the answer
   * arrives; whatever was queued after it moves up. Returns the new end of the last hold clip.
   */
  fadeHoldClips(): number | null {
    const ctx = this.ctx;
    if (!ctx) return null;
    const now = ctx.currentTime;
    let end: number | null = null;
    for (const s of this.sources) {
      if (s.kind !== 'hold' || s.t1 - now < 0.2) continue;
      const at = Math.max(now, s.t0);
      s.gain.gain.setValueAtTime(1, at);
      s.gain.gain.linearRampToValueAtTime(0, at + 0.08);
      try {
        s.src.stop(at + 0.09);
      } catch {
        // already stopped
      }
      const cut = s.t1 - (at + 0.09);
      s.t1 = at + 0.09;
      this.queueEnd = Math.max(now, this.queueEnd - cut);
      end = s.t1;
    }
    return end;
  }

  /** Everything stops within 80 ms. */
  stop(): void {
    const ctx = this.ctx;
    this.ducked = false;
    if (!ctx || !this.master) return;
    const t = ctx.currentTime;
    const g = this.master.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(0, t + 0.08);
    for (const s of this.sources) {
      try {
        s.src.stop(t + 0.09);
      } catch {
        // already stopped
      }
    }
    this.sources = [];
    this.queueEnd = 0;
  }

  /** The user's voice over the copilot: down to 25 %, back on a false start. */
  duck(on: boolean): void {
    if (!this.ctx || !this.master || this.ducked === on) return;
    this.ducked = on;
    const t = this.ctx.currentTime;
    const g = this.master.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(on ? 0.25 : 1, t + 0.06);
  }

  earcon(kind: string): void {
    const ctx = this.ctx;
    const notes = EARCONS[kind];
    if (!ctx || !notes) return;
    let t = ctx.currentTime + 0.01;
    for (const [f, d] of notes) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      o.connect(g);
      g.connect(ctx.destination);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(kind === 'tick' ? 0.05 : 0.12, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0005, t + d);
      o.start(t);
      o.stop(t + d + 0.02);
      t += d + 0.03;
    }
  }

  /**
   * Opens the microphone once (ask inside the tap on iOS). Frames go to `onFrame`. Resolves
   * false with the problem when it can't be used; a second call while asking waits for the first.
   */
  openMic(
    onFrame: (frame: Float32Array) => void,
    onProblem: (problem: MicProblem) => void
  ): Promise<boolean> {
    this.ensure();
    if (this.stream) return Promise.resolve(true);
    if (this.micPending) return this.micPending;
    this.micPending = this.attachMic(onFrame, onProblem).finally(() => {
      this.micPending = null;
    });
    return this.micPending;
  }

  private async attachMic(
    onFrame: (frame: Float32Array) => void,
    onProblem: (problem: MicProblem) => void
  ): Promise<boolean> {
    let stream: MediaStream;
    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        throw new Error('insecure');
      }
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (error) {
      logger.log(`microphone refused: ${(error as { name?: string } | null)?.name ?? error}`);
      onProblem(micProblem(error));
      return false;
    }
    const ctx = this.ctx;
    if (!ctx) {
      for (const track of stream.getTracks()) track.stop();
      return false;
    }
    this.stream = stream;
    const node = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(1024, 1, 1);
    node.connect(proc);
    // WebKit only runs the processor while it is connected to the output (it writes silence).
    proc.connect(ctx.destination);
    proc.onaudioprocess = (e) => {
      const data = new Float32Array(e.inputBuffer.getChannelData(0));
      e.outputBuffer.getChannelData(0).fill(0);
      onFrame(data);
    };
    this.micNode = node;
    this.proc = proc;
    return true;
  }

  close(): void {
    this.stop();
    if (this.proc) this.proc.onaudioprocess = null;
    this.proc?.disconnect();
    this.micNode?.disconnect();
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.proc = null;
    this.micNode = null;
    this.stream = null;
    const ctx = this.ctx;
    this.ctx = null;
    this.master = null;
    if (ctx) {
      ctx.onstatechange = null;
      void ctx.close().catch(() => undefined);
    }
  }
}

/** Keeps the screen on (hands-free) where the Wake Lock API exists. */
export class ScreenAwake {
  private lock: { release(): Promise<void> } | null = null;
  private wanted = false;

  private readonly onVisible = () => {
    if (this.wanted && document.visibilityState === 'visible') void this.acquire();
  };

  async acquire(): Promise<void> {
    this.wanted = true;
    document.addEventListener('visibilitychange', this.onVisible);
    try {
      const nav = navigator as Navigator & {
        wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> };
      };
      const lock = (await nav.wakeLock?.request('screen')) ?? null;
      // Released while the request was pending, or asked twice (coming back to the page):
      // a lock nobody holds a reference to keeps the screen on until the page closes
      // (2026-11-10).
      if (!this.wanted) {
        void lock?.release().catch(() => undefined);
        return;
      }
      void this.lock?.release().catch(() => undefined);
      this.lock = lock;
    } catch (error) {
      logger.debug('wake lock refused', error);
    }
  }

  release(): void {
    this.wanted = false;
    document.removeEventListener('visibilitychange', this.onVisible);
    void this.lock?.release().catch(() => undefined);
    this.lock = null;
  }
}
