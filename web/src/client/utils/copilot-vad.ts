/**
 * Turn-taking for «Conversar» (the voice copilot): decides from the microphone's frames when
 * the user starts and stops talking, when to duck or cut the copilot's own voice (barge-in) and
 * when to send the utterance ahead (peek). Pure: no DOM, no audio, no network; the sheet feeds
 * it frames and acts on the events it returns. Energy-based (RMS over an adaptive floor).
 *
 * Timings from the copilot prototype, tuned on the phone (2026-10-12/13): the end of speech is
 * 350 ms of silence after a short utterance and 600 ms after a long one; the utterance so far is
 * sent after 200 ms of silence (`peek`) so its transcript is nearly ready when the end is
 * certain, and talking again before that drops the peek (`resume`). Over the copilot's voice the
 * thresholds are stricter (its own echo must not count): it is ducked after 120 ms of voice and
 * cut at 300 ms (at 120 ms when only an interjection clip is playing).
 */

export interface VadThresholds {
  /** Absolute RMS below which nothing is voice, however quiet the room. */
  minRms: number;
  /** Voice is this many times louder than the noise floor. */
  ratio: number;
  /** Voice must last this long to open an utterance. */
  minMs: number;
}

export const NORMAL: VadThresholds = { minRms: 0.015, ratio: 3, minMs: 250 };
/** While the copilot talks: louder and longer, so its own voice leaking in doesn't count. */
export const BARGE: VadThresholds = { minRms: 0.06, ratio: 4, minMs: 300 };
export const DUCK_MS = 120;
export const PREROLL_MS = 400;
export const PEEK_SILENCE_MS = 200;
export const END_SILENCE_SHORT_MS = 350;
export const END_SILENCE_LONG_MS = 600;
/** Spoken this long or more: the longer end-of-speech silence applies. */
export const SHORT_UTTERANCE_MS = 1200;
/** Shorter utterances are dropped (a tap, a cough). */
export const MIN_UTTERANCE_MS = 400;
/** The transcription window is about 15 s: an utterance is cut and sent at 14 s. */
export const MAX_UTTERANCE_MS = 14_000;

export interface FrameContext {
  /** performance.now() at the end of this frame. */
  now: number;
  /** The copilot's audio is playing. */
  speakingOut: boolean;
  /** …and it is only interjection clips, no answer yet. */
  clipsOnly: boolean;
  /** Hands-free: the voice alone opens and closes utterances. */
  handsFree: boolean;
  /** The page waits for the answer to the last utterance. */
  thinking: boolean;
}

export type TurnEvent =
  | { type: 'duck'; on: boolean }
  /** Voice over the copilot (or while it thinks): cut it. `voiceAt` is when the voice began. */
  | { type: 'barge'; voiceAt: number }
  | { type: 'start' }
  | { type: 'peek'; chunks: Float32Array[] }
  | { type: 'resume' }
  /** `peeked`: nothing new since the peek, the server only needs `utt-commit`. */
  | {
      type: 'end';
      chunks: Float32Array[];
      peeked: boolean;
      durMs: number;
      spokenMs: number;
      silentMs: number;
    }
  | { type: 'drop' };

export function rms(frame: Float32Array): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  return Math.sqrt(sum / frame.length);
}

export class TurnTaker {
  /** Running estimate of the room's background level. */
  floor = 0.005;
  /** Level of the last frame (the orb follows it). */
  level = 0;
  private voicedMs = 0;
  private silentMs = 0;
  private recording = false;
  private held = false;
  private peekSent = false;
  private ducked = false;
  private voiceStartAt = 0;
  private chunks: Float32Array[] = [];
  private samples = 0;
  private preroll: Float32Array[] = [];
  private prerollMs = 0;

  constructor(readonly rate: number) {}

  /** An utterance is being recorded (by voice or while the orb is held). */
  get listening(): boolean {
    return this.recording;
  }

  get pushToTalk(): boolean {
    return this.held;
  }

  private recordedMs(): number {
    return (this.samples / this.rate) * 1000;
  }

  frame(data: Float32Array, c: FrameContext): TurnEvent[] {
    const out: TurnEvent[] = [];
    const ms = (data.length / this.rate) * 1000;
    const level = rms(data);
    this.level = level;
    const th = c.speakingOut ? BARGE : NORMAL;
    const voiced = level > Math.max(th.minRms, this.floor * th.ratio);
    if (!voiced && !this.recording) this.floor = this.floor * 0.95 + level * 0.05;
    if (this.recording) {
      this.chunks.push(data);
      this.samples += data.length;
      if (this.recordedMs() > MAX_UTTERANCE_MS) {
        out.push(...this.end());
        return out;
      }
    } else {
      this.preroll.push(data);
      this.prerollMs += ms;
      while (this.prerollMs > PREROLL_MS && this.preroll.length > 1) {
        const first = this.preroll.shift() as Float32Array;
        this.prerollMs -= (first.length / this.rate) * 1000;
      }
    }
    if (this.held || !c.handsFree) {
      if (this.ducked) out.push(this.duck(false));
      return out;
    }
    if (voiced) {
      if (this.voicedMs === 0) this.voiceStartAt = c.now - ms;
      this.voicedMs += ms;
      this.silentMs = 0;
    } else {
      this.silentMs += ms;
      if (!this.recording) this.voicedMs = Math.max(0, this.voicedMs - ms);
    }
    if (c.speakingOut && !this.recording) {
      const want = this.voicedMs >= DUCK_MS;
      if (want !== this.ducked) out.push(this.duck(want));
    } else if (this.ducked && !c.speakingOut) {
      out.push(this.duck(false));
    }
    if (!this.recording && this.voicedMs >= (c.clipsOnly ? DUCK_MS : th.minMs)) {
      if (c.speakingOut || c.thinking) {
        out.push({ type: 'barge', voiceAt: this.voiceStartAt });
        // Cutting the audio restores its volume for whatever plays next.
        this.ducked = false;
      }
      out.push(this.begin());
    }
    if (this.recording) {
      if (voiced && this.peekSent) {
        this.peekSent = false;
        out.push({ type: 'resume' });
      }
      const recorded = this.recordedMs();
      const spokenMs = recorded - this.silentMs;
      const endMs = spokenMs >= SHORT_UTTERANCE_MS ? END_SILENCE_LONG_MS : END_SILENCE_SHORT_MS;
      if (
        !this.peekSent &&
        this.silentMs >= PEEK_SILENCE_MS &&
        this.silentMs < endMs &&
        recorded >= MIN_UTTERANCE_MS
      ) {
        this.peekSent = true;
        out.push({ type: 'peek', chunks: this.chunks.slice() });
      }
      if (this.silentMs >= endMs) out.push(...this.end());
    }
    return out;
  }

  /** The orb is pressed: record until it is released (the preroll keeps the first syllable). */
  press(): TurnEvent[] {
    if (this.recording) {
      this.held = true;
      return [];
    }
    this.held = true;
    return [this.begin()];
  }

  /** The orb is released. A short press sends nothing. */
  release(): TurnEvent[] {
    if (!this.held) return [];
    this.held = false;
    return this.end();
  }

  /** Hands-free went off (or the page hid) mid-phrase: end it as it is. */
  finish(): TurnEvent[] {
    this.held = false;
    return this.end();
  }

  /** The phrase can't finish (audio paused by a call, the page hidden): drop it. */
  abort(): TurnEvent[] {
    if (!this.recording && !this.held) return [];
    this.reset();
    return [{ type: 'drop' }];
  }

  private reset() {
    this.recording = false;
    this.held = false;
    this.voicedMs = 0;
    this.silentMs = 0;
    this.chunks = [];
    this.samples = 0;
    this.peekSent = false;
  }

  private duck(on: boolean): TurnEvent {
    this.ducked = on;
    return { type: 'duck', on };
  }

  private begin(): TurnEvent {
    this.recording = true;
    this.peekSent = false;
    this.chunks = this.preroll;
    this.samples = this.preroll.reduce((n, c) => n + c.length, 0);
    this.preroll = [];
    this.prerollMs = 0;
    this.silentMs = 0;
    return { type: 'start' };
  }

  private end(): TurnEvent[] {
    if (!this.recording) {
      this.held = false;
      return [];
    }
    const durMs = this.recordedMs();
    const silentMs = this.silentMs;
    const chunks = this.chunks;
    const peeked = this.peekSent;
    this.reset();
    if (durMs < MIN_UTTERANCE_MS) return [{ type: 'drop' }];
    return [
      {
        type: 'end',
        chunks,
        peeked,
        durMs: Math.round(durMs),
        spokenMs: Math.round(durMs - silentMs),
        silentMs: Math.round(silentMs),
      },
    ];
  }
}
