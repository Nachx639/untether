/**
 * "Read aloud" with the Mac's voice (the chat's speaker button): sentence chunks from
 * `/api/tts`, fetched one ahead of playback.
 */
import { chunkForSpeech } from '../../shared/tts-text.js';
import { encodeWav } from './dictation.js';
import { createLogger } from './logger.js';

const logger = createLogger('read-aloud');

let silenceUrl: string | undefined;

/**
 * Reads replies with the Mac's voice: sentence chunks fetched one ahead of playback, played
 * through one <audio> element unlocked in the opening tap (iOS refuses play() otherwise).
 */
export class VoicePlayer {
  private readonly audio: HTMLAudioElement;

  constructor(private readonly headers: () => Record<string, string>) {
    this.audio = new Audio();
    this.audio.setAttribute('playsinline', '');
  }

  /** Call synchronously inside the user's tap. */
  unlock(): void {
    // 0.1 s of silence played inside the tap: after that iOS lets this element play freely.
    // One URL for the life of the page: a new one per tap was never revoked.
    silenceUrl ??= URL.createObjectURL(encodeWav([new Float32Array(1600)], 16000));
    this.audio.src = silenceUrl;
    void this.audio.play().catch(() => undefined);
  }

  private async fetchChunk(text: string, lang: string, signal: AbortSignal): Promise<Blob> {
    const response = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.headers() },
      body: JSON.stringify({ text, lang }),
      signal,
    });
    if (!response.ok) throw new Error(`tts HTTP ${response.status}`);
    return response.blob();
  }

  /** Speak `text`; resolves when finished or when `signal` aborts (stops at once). */
  async speak(text: string, lang: string, signal: AbortSignal): Promise<void> {
    const chunks = chunkForSpeech(text);
    if (chunks.length === 0 || signal.aborted) return;
    const started = performance.now();
    let next: Promise<Blob> | null = this.fetchChunk(chunks[0], lang, signal);
    for (let i = 0; i < chunks.length && next; i++) {
      let blob: Blob;
      try {
        blob = await next;
      } catch (error) {
        if (signal.aborted) return;
        throw error;
      }
      // Fetch the next sentence while this one plays.
      next = i + 1 < chunks.length ? this.fetchChunk(chunks[i + 1], lang, signal) : null;
      next?.catch(() => undefined);
      if (i === 0) logger.log(`first audio after ${Math.round(performance.now() - started)} ms`);
      await this.play(blob, signal);
      if (signal.aborted) return;
    }
  }

  private play(blob: Blob, signal: AbortSignal): Promise<void> {
    const url = URL.createObjectURL(blob);
    const audio = this.audio;
    return new Promise<void>((resolve) => {
      const done = () => {
        audio.removeEventListener('ended', done);
        audio.removeEventListener('error', done);
        signal.removeEventListener('abort', stop);
        URL.revokeObjectURL(url);
        resolve();
      };
      const stop = () => {
        audio.pause();
        done();
      };
      audio.addEventListener('ended', done);
      audio.addEventListener('error', done);
      signal.addEventListener('abort', stop, { once: true });
      audio.src = url;
      audio.play().catch((error) => {
        logger.warn('playback refused', error);
        done();
      });
    });
  }

  stop(): void {
    this.audio.pause();
  }
}
