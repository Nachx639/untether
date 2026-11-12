/**
 * Web Speech dictation (Safari/Chrome on iOS expose it as webkitSpeechRecognition).
 *
 * 2026-10-02 (user report: "the mic doesn't pick up my voice", permission granted): errors were
 * swallowed (onerror just stopped), so a recognizer that failed or never heard audio looked
 * like a dead button. Every event is now logged (they reach the server log), errors become
 * a readable reason, iOS runs one utterance at a time (continuous mode is unreliable there),
 * and a watchdog reports a recognizer that started but never opened the microphone.
 */
import { createLogger } from './logger.js';

const logger = createLogger('dictation');

export interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((event?: { error?: string; message?: string }) => void) | null;
  onstart?: (() => void) | null;
  onaudiostart?: (() => void) | null;
  onspeechstart?: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

export function speechRecognitionClass(): (new () => SpeechRecognitionLike) | undefined {
  const w = window as Window & {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

/** Why dictation can't run here at all, or null when it can try. */
export function dictationUnavailableReason(): DictationError | null {
  if (typeof window === 'undefined') return 'unsupported';
  if (window.isSecureContext === false) return 'insecure';
  return speechRecognitionClass() ? null : 'unsupported';
}

// Dictation always lets whisper detect the spoken language (2026-10-02, user request: no language
// picker; English on a Spanish phone must stay English). It transcribes, never translates.

export type DictationError =
  | 'unsupported'
  | 'insecure'
  | 'denied'
  | 'no-speech'
  | 'no-mic'
  | 'network'
  | 'no-audio'
  | 'failed';

/** i18n key for a dictation problem (all under `dictation.`). */
export function dictationErrorKey(error: DictationError): string {
  return `dictation.error.${error}`;
}

function toDictationError(code: string | undefined): DictationError {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'denied';
    case 'no-speech':
      return 'no-speech';
    case 'audio-capture':
      return 'no-mic';
    case 'network':
      return 'network';
    default:
      return 'failed';
  }
}

const isIOS = () =>
  typeof navigator !== 'undefined' &&
  (/iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.userAgent.includes('Macintosh') && navigator.maxTouchPoints > 1));

/** How long a started recognizer may go without opening the microphone. */
export const DICTATION_AUDIO_TIMEOUT_MS = 4000;

/**
 * Dictate into a field, appending to what it already holds. `onText` gets the whole new
 * value on every partial result; `onEnd` runs when listening stops; `onError` explains a
 * failure. Returns null when the browser can't dictate (onError is called with why).
 */
export function startDictation(
  current: string,
  onText: (value: string) => void,
  onEnd: () => void,
  onError?: (error: DictationError) => void
): SpeechRecognitionLike | null {
  const unavailable = dictationUnavailableReason();
  const Recognition = speechRecognitionClass();
  if (unavailable || !Recognition) {
    logger.warn(`dictation unavailable: ${unavailable}`);
    onError?.(unavailable ?? 'unsupported');
    return null;
  }
  const recognition = new Recognition();
  // The phone's language, not the UI's: the interface can be English while you speak Spanish.
  // The browser recognizer can't detect the language: it's only the fallback where audio
  // can't be recorded, so it follows the phone's language.
  recognition.lang = navigator.language || 'en-US';
  recognition.interimResults = true;
  // iOS's recognizer often never returns results in continuous mode: one utterance at a time.
  recognition.continuous = !isIOS();
  const before = current && !/\s$/.test(current) ? `${current} ` : current;
  let heardAudio = false;
  let failed = false;
  const fail = (error: DictationError) => {
    if (failed) return;
    failed = true;
    onError?.(error);
  };
  const watchdog = setTimeout(() => {
    if (heardAudio) return;
    logger.warn('dictation started but the microphone never opened');
    fail('no-audio');
    recognition.abort();
  }, DICTATION_AUDIO_TIMEOUT_MS);
  recognition.onstart = () => logger.log(`dictation started (lang ${recognition.lang})`);
  recognition.onaudiostart = () => {
    heardAudio = true;
    logger.log('dictation: microphone open');
  };
  recognition.onspeechstart = () => logger.log('dictation: speech detected');
  recognition.onresult = (event) => {
    heardAudio = true;
    let spoken = '';
    for (let i = 0; i < event.results.length; i++) spoken += event.results[i][0].transcript;
    onText(before + spoken.trimStart());
  };
  recognition.onerror = (event) => {
    logger.warn(`dictation error: ${event?.error ?? 'unknown'} ${event?.message ?? ''}`);
    // "aborted" is our own stop/abort, not a failure.
    if (event?.error !== 'aborted') fail(toDictationError(event?.error));
    recognition.stop();
  };
  recognition.onend = () => {
    clearTimeout(watchdog);
    logger.log('dictation ended');
    onEnd();
  };
  try {
    recognition.start();
  } catch (error) {
    clearTimeout(watchdog);
    logger.warn('dictation could not start', error);
    fail('failed');
    return null;
  }
  return recognition;
}

// ---------------------------------------------------------------------------------------
// Record on the phone, transcribe on the Mac: works in Safari AND Chrome on iOS (Chrome's
// WKWebView has no working Web Speech), as long as the Mac has whisper.cpp + ffmpeg.

/** 'starting': waiting for the mic (iOS permission prompt) or for the Mac to answer. */
export type DictationState = 'idle' | 'starting' | 'listening' | 'recording' | 'transcribing';

/** How long the Mac may take to transcribe before the phone gives up. */
export const TRANSCRIBE_TIMEOUT_MS = 3 * 60_000;

/** How long one recording may run before it stops by itself. */
export const MAX_RECORDING_MS = 2 * 60_000;

let serverAvailable: Promise<boolean> | null = null;

/** Whether the Mac can transcribe (asked once per page). */
export function serverDictationAvailable(headers: () => Record<string, string>): Promise<boolean> {
  const check =
    serverAvailable ??
    fetch('/api/dictation/status', { headers: headers() })
      .then(async (response) => response.ok && Boolean((await response.json()).available))
      .catch(() => false);
  // Remember only a yes: a network blip or an expired login mustn't turn dictation off
  // for the rest of the page's life.
  serverAvailable = check;
  void check.then((ok) => {
    if (!ok && serverAvailable === check) serverAvailable = null;
  });
  return check;
}

export function resetDictationForTests(): void {
  serverAvailable = null;
}

function canRecord(): boolean {
  const w =
    typeof window === 'undefined'
      ? undefined
      : (window as Window & {
          AudioContext?: typeof AudioContext;
          webkitAudioContext?: typeof AudioContext;
        });
  return (
    typeof navigator !== 'undefined' &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    Boolean(w && (w.AudioContext || w.webkitAudioContext))
  );
}

function newAudioContext(): AudioContext {
  const w = window as Window & {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  const Context = w.AudioContext || (w.webkitAudioContext as typeof AudioContext);
  return new Context();
}

/** Mono PCM (Float32 chunks at `rate`) → 16 kHz 16-bit WAV, the format whisper wants. */
export function encodeWav(chunks: Float32Array[], rate: number, targetRate = 16000): Blob {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const ratio = rate / targetRate;
  const length = Math.floor(total / ratio);
  const buffer = new ArrayBuffer(44 + length * 2);
  const view = new DataView(buffer);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, targetRate, true);
  view.setUint32(28, targetRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, length * 2, true);
  // Flatten once, then pick samples at the target rate (speech survives simple decimation).
  const all = new Float32Array(total);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.length;
  }
  for (let i = 0; i < length; i++) {
    const sample = Math.max(-1, Math.min(1, all[Math.floor(i * ratio)] ?? 0));
    view.setInt16(44 + i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

export interface DictationOptions {
  /** What the field holds now (the dictated text is appended). */
  getText: () => string;
  /** The field's new value (partial results while listening, the final text after). */
  setText: (value: string) => void;
  onState: (state: DictationState) => void;
  onError: (error: DictationError) => void;
  authHeaders: () => Record<string, string>;
  /**
   * While recording, how loud the microphone is now (0-1, about ten times a second): the
   * composer's recording capsule draws it as a level meter (phone-spec §3.5, 2026-10-12).
   */
  onLevel?: (level: number) => void;
}

/**
 * One mic button: tap to start, tap again to stop. On iOS (and wherever Web Speech is
 * missing) it records and the Mac transcribes; elsewhere the browser's recognizer runs.
 */
export class DictationController {
  state: DictationState = 'idle';
  private recognition: SpeechRecognitionLike | null = null;
  private context: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private stream: MediaStream | null = null;
  private pcm: Float32Array[] = [];
  private peak = 0;
  private stopTimer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped by every start and cancel: async work from an older run drops its result. */
  private run = 0;

  constructor(private readonly options: DictationOptions) {}

  private setState(state: DictationState) {
    this.state = state;
    this.options.onState(state);
  }

  async toggle(): Promise<void> {
    if (this.state === 'listening') {
      this.recognition?.stop();
      return;
    }
    if (this.state === 'recording') {
      void this.finishRecording();
      return;
    }
    if (this.state === 'transcribing' || this.state === 'starting') return;
    // Chosen synchronously when possible: iOS only grants the mic inside the tap. Recording
    // lets whisper detect the language; the browser recognizer is only the fallback.
    if (canRecord()) {
      await this.startRecording();
      return;
    }
    this.startListening();
  }

  /** Stop without delivering anything (leaving the screen, sending the message). */
  cancel(): void {
    this.run++;
    this.recognition?.abort();
    this.recognition = null;
    this.releaseMic();
    if (this.state !== 'idle') this.setState('idle');
  }

  private startListening() {
    const run = ++this.run;
    const recognition = startDictation(
      this.options.getText(),
      (value) => {
        if (run === this.run) this.options.setText(value);
      },
      () => {
        this.recognition = null;
        if (this.state === 'listening') this.setState('idle');
      },
      this.options.onError
    );
    if (!recognition) return;
    this.recognition = recognition;
    this.setState('listening');
  }

  /**
   * Raw PCM through Web Audio, encoded to WAV here: MediaRecorder gave 0 bytes in WebKit
   * (2026-10-02, iOS simulator), and this path is the same in Safari and Chrome on iOS.
   */
  private async startRecording() {
    const run = ++this.run;
    // Created inside the tap: iOS only lets audio start from a user gesture.
    const context = newAudioContext();
    this.context = context;
    this.setState('starting');
    // A tap or leaving the screen while we wait (the iOS permission prompt can sit there a
    // while) must not leave a microphone running nobody can stop.
    const stale = (stream?: MediaStream) => {
      if (run === this.run) return false;
      for (const track of stream?.getTracks() ?? []) track.stop();
      void context.close().catch(() => undefined);
      return true;
    };
    const available = serverDictationAvailable(this.options.authHeaders);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
      });
    } catch (error) {
      if (stale()) return;
      const name = (error as { name?: string })?.name;
      logger.warn(`microphone refused: ${name}`);
      this.releaseMic();
      this.setState('idle');
      this.options.onError(name === 'NotFoundError' ? 'no-mic' : 'denied');
      return;
    }
    if (stale(stream)) return;
    this.stream = stream;
    const canTranscribe = await available;
    if (stale(stream)) return;
    if (!canTranscribe) {
      this.releaseMic();
      this.setState('idle');
      // No transcription on the Mac: fall back to the browser's recognizer if it has one.
      if (speechRecognitionClass()) this.startListening();
      else this.options.onError('unsupported');
      return;
    }
    await context.resume().catch(() => undefined);
    if (stale(stream)) return;
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(4096, 1, 1);
    this.pcm = [];
    this.peak = 0;
    processor.onaudioprocess = (event) => {
      const data = event.inputBuffer.getChannelData(0);
      this.pcm.push(new Float32Array(data));
      let chunkPeak = 0;
      for (let i = 0; i < data.length; i += 64) chunkPeak = Math.max(chunkPeak, Math.abs(data[i]));
      this.peak = Math.max(this.peak, chunkPeak);
      // Speech peaks around 0.1-0.4: scaled so a normal voice fills most of the meter.
      this.options.onLevel?.(Math.min(1, chunkPeak * 3));
    };
    source.connect(processor);
    // Some WebKit builds only run the processor while it's connected to the output.
    processor.connect(context.destination);
    this.source = source;
    this.processor = processor;
    this.stopTimer = setTimeout(() => void this.finishRecording(), MAX_RECORDING_MS);
    logger.log(`recording PCM at ${context.sampleRate} Hz`);
    this.setState('recording');
  }

  private releaseMic() {
    if (this.processor) this.options.onLevel?.(0);
    if (this.stopTimer) clearTimeout(this.stopTimer);
    this.stopTimer = null;
    if (this.processor) this.processor.onaudioprocess = null;
    this.processor?.disconnect();
    this.source?.disconnect();
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    void this.context?.close().catch(() => undefined);
    this.processor = null;
    this.source = null;
    this.stream = null;
    this.context = null;
  }

  private async finishRecording() {
    const run = this.run;
    const rate = this.context?.sampleRate ?? 48000;
    const chunks = this.pcm;
    const peak = this.peak;
    this.pcm = [];
    this.releaseMic();
    if (run !== this.run) return;
    const samples = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    logger.log(`recorded ${samples} samples at ${rate} Hz, peak ${peak.toFixed(3)}`);
    if (samples === 0) {
      this.setState('idle');
      this.options.onError('no-audio');
      return;
    }
    if (peak < 0.01) {
      // The mic delivered pure silence: muted, in use elsewhere, or the wrong input.
      this.setState('idle');
      this.options.onError('no-audio');
      return;
    }
    const audio = encodeWav(chunks, rate);
    this.setState('transcribing');
    try {
      const lang = 'auto';
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), TRANSCRIBE_TIMEOUT_MS);
      const response = await fetch(`/api/dictation/transcribe?lang=${lang}`, {
        method: 'POST',
        headers: { 'Content-Type': 'audio/wav', ...this.options.authHeaders() },
        body: audio,
        signal: timeout.signal,
      }).finally(() => clearTimeout(timer));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const { text } = (await response.json()) as { text?: string };
      // Cancelled (sent, left the screen) or a newer dictation started: drop this text.
      if (run !== this.run) return;
      if (!text) {
        this.options.onError('no-speech');
      } else {
        const current = this.options.getText();
        const before = current && !/\s$/.test(current) ? `${current} ` : current;
        this.options.setText(before + text);
      }
    } catch (error) {
      logger.warn('transcription request failed', error);
      if (run === this.run) this.options.onError('network');
    } finally {
      if (run === this.run && this.state === 'transcribing') this.setState('idle');
    }
  }
}
