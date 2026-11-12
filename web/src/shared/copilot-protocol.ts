/**
 * The voice copilot's WebSocket protocol (`/copilot`, behind the same login as `/ws`; the
 * browser passes `?token=` like the terminal socket does).
 *
 * Text frames are JSON messages. Binary frames carry audio:
 *  - page → server: one utterance, a 16 kHz mono 16-bit WAV (at most COPILOT_MAX_UTTERANCE_BYTES);
 *    after `utt-peek` the next binary frame is the tentative utterance so far.
 *  - server → page: an 8-byte header `[u32 turn][u32 index]` (little endian) and a WAV. `index`
 *    is the sentence's index in its turn; turn CLIP_TURN means an interjection clip for the
 *    page's pool, `index` then being the clip number from the `clips` manifest.
 *
 * Safety lives on the server: a page sends words (audio or text), never actions.
 */

export const COPILOT_PROTOCOL_VERSION = 1;
export const COPILOT_PATH = '/copilot';
/** Turn number of an interjection clip frame. */
export const CLIP_TURN = 0xffffffff;
export const COPILOT_MAX_UTTERANCE_BYTES = 2 * 1024 * 1024;

/** session: «Conversar» inside one session's chat; global: from the home page, every session. */
export type CopilotScope = { mode: 'global' } | { mode: 'session'; sessionId: string };

export type CopilotClientMessage =
  | ({
      type: 'hello';
      v: number;
      /** Solo mirar: this page's turns never act on a session. */
      readOnly?: boolean;
      /** Language of the clip pool the page wants first. */
      clipLang?: 'es' | 'en';
    } & CopilotScope)
  | { type: 'text'; text: string }
  | { type: 'vad'; speaking: boolean }
  | { type: 'utt-peek' }
  | { type: 'utt-commit' }
  | { type: 'utt-resume' }
  | { type: 'utt-drop' }
  | { type: 'barge'; turn?: number; cont?: boolean }
  | { type: 'focus'; sessionId: string | null }
  | { type: 'read-only'; on: boolean };

export type CopilotSessionStatus = 'busy' | 'waiting' | 'idle' | 'shell' | 'exited';

export interface CopilotSessionChip {
  /** Short id the copilot uses (s1, s2…). */
  sid: string;
  sessionId: string;
  /** Spoken name («ecografía», «mediguiapp»). */
  name: string;
  status: CopilotSessionStatus;
  /** Its last turn ended with an error. */
  error: boolean;
  /** The session orders go to when the user names none. */
  focus: boolean;
  muted: boolean;
}

export type BrainState = 'off' | 'starting' | 'ready' | 'error';

export type CopilotErrorCode = 'no-token' | 'no-claude' | 'brain' | 'stt' | 'tts' | 'scope';

export type ActionOutcome = 'done' | 'held' | 'blocked' | 'error' | 'readonly' | 'skipped';

export interface CopilotTimings {
  firstTokenMs?: number;
  firstSentenceMs?: number;
  firstContentMs?: number;
  interjectMs?: number;
  holdMs?: number;
  fromTransitionMs?: number;
  totalMs?: number;
  sttMs?: number;
  cold?: boolean;
  raced?: boolean;
}

export type CopilotServerMessage =
  | {
      type: 'state';
      scope: CopilotScope;
      /** session mode: just that session; global: every session. */
      sessions: CopilotSessionChip[];
      /** What a «confirmo» would run now, in words, or null. */
      pending: string | null;
      readOnly: boolean;
      speech: { tts: string | null; ttsReady: boolean; stt: boolean };
      brain: BrainState;
      /** False while the server cannot read session state. */
      connected: boolean;
    }
  | {
      type: 'clips';
      lang: 'es' | 'en';
      clips: { n: number; id: string; cat: string; text: string }[];
    }
  | {
      type: 'turn-start';
      turn: number;
      origin: 'user' | 'event' | 'greeting' | 'system';
      /** Owned by this page: only the owner plays its audio. */
      own: boolean;
    }
  | { type: 'sentence'; turn: number; index: number; text: string; lang: string }
  | {
      type: 'action';
      turn: number;
      kind: string;
      sid?: string;
      outcome: ActionOutcome;
      say?: string;
    }
  | { type: 'clip'; turn: number; id: string; lang: 'es' | 'en'; stage: 'A' | 'B' | 'hold' }
  | { type: 'earcon'; kind: 'done' | 'needs' | 'error' | 'tick' }
  | { type: 'stop-audio' }
  | { type: 'transcript'; text: string; ms?: number; ignored?: boolean; error?: 'stt' }
  | {
      type: 'turn-end';
      turn: number;
      origin: 'user' | 'event' | 'greeting' | 'system';
      speech: string[];
      actions: { kind: string; sid?: string; outcome: ActionOutcome }[];
      timings: CopilotTimings;
      cancelled: boolean;
      own: boolean;
    }
  | { type: 'error'; code: CopilotErrorCode };

/** `[u32 turn][u32 index]` + payload. */
export function encodeAudioFrame(turn: number, index: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, turn >>> 0, true);
  view.setUint32(4, index >>> 0, true);
  out.set(payload, 8);
  return out;
}

export function decodeAudioFrame(
  frame: ArrayBuffer | Uint8Array
): { turn: number; index: number; payload: Uint8Array } | null {
  const bytes = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
  if (bytes.length < 8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    turn: view.getUint32(0, true),
    index: view.getUint32(4, true),
    payload: bytes.subarray(8),
  };
}
