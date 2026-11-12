/**
 * POST /api/tts {text, lang?} → WAV audio of `text` read by a local voice (voice mode).
 * GET /api/tts/status → which engine would answer; `?warm=1` loads Kokoro (and Qwen, the
 * Spanish voice, when installed and memory allows) ahead of the first reply so the phone
 * doesn't wait for the model. Behind the /api login like the rest.
 */
import express, { type Request, type Response, Router } from 'express';
import { MAX_TTS_CHARS } from '../../shared/tts-text.js';
import {
  availableEngines,
  residentKokoro,
  residentQwen,
  synthesize,
  TtsBusyError,
} from '../services/tts.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('tts');

export function createTtsRoutes(): Router {
  const router = Router();

  router.get('/tts/status', (req: Request, res: Response) => {
    const engines = availableEngines();
    const kokoro = engines.includes('kokoro') ? residentKokoro() : null;
    const qwen = engines[0] === 'qwen' ? residentQwen() : null;
    if (req.query.warm === '1') {
      void kokoro?.warm().catch(() => undefined);
      void qwen?.warm();
    }
    // Ready = the next reply needs no model load (Kokoro reads Spanish while Qwen loads).
    const resident = engines[0] === 'qwen' || engines[0] === 'kokoro';
    res.json({
      available: engines.length > 0,
      engine: engines[0] ?? null,
      engines,
      ready: resident ? Boolean(qwen?.ready || kokoro?.ready) : engines.length > 0,
      maxChars: MAX_TTS_CHARS,
    });
  });

  router.post('/tts', express.json({ limit: '16kb' }), async (req: Request, res: Response) => {
    const { text, lang } = (req.body ?? {}) as { text?: unknown; lang?: unknown };
    if (typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'No text to read' });
    }
    if (text.length > MAX_TTS_CHARS) {
      return res.status(413).json({ error: `At most ${MAX_TTS_CHARS} characters per request` });
    }
    if (availableEngines().length === 0) {
      return res.status(503).json({ error: 'No text-to-speech engine on this Mac' });
    }
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) abort.abort();
    });
    const started = Date.now();
    try {
      const speech = await synthesize(text, lang, abort.signal);
      logger.log(
        `${speech.engine} (${speech.lang}) read ${text.length} chars in ${Date.now() - started} ms`
      );
      res.set({
        'Content-Type': speech.contentType,
        'Cache-Control': 'no-store',
        'X-TTS-Engine': speech.engine,
        'X-TTS-Lang': speech.lang,
      });
      res.send(speech.audio);
    } catch (error) {
      if (error instanceof TtsBusyError) {
        return res.status(429).json({ error: 'Busy reading, try again in a moment' });
      }
      if (abort.signal.aborted) return;
      logger.error('speech failed:', error);
      res.status(500).json({ error: 'Speech failed' });
    }
  });

  return router;
}
