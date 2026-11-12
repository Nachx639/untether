/**
 * Voice dictation that works in every phone browser: the phone records audio
 * (getUserMedia + MediaRecorder) and the Mac transcribes it locally with whisper.cpp.
 *
 * 2026-10-02 (user report): the chat mic relied on the Web Speech API, which Chrome on iOS doesn't
 * provide (and iOS Safari's is flaky), so it "didn't pick up his voice". Behind the /api
 * login like every other route; ffmpeg and whisper-cli run with argument arrays, never a
 * shell; one transcription at a time.
 */
import { type ChildProcess, execFile, execFileSync, spawn } from 'child_process';
import express, { type Request, type Response, Router } from 'express';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('dictation');
const execFileAsync = promisify(execFile);

// Two minutes of the 16 kHz mono WAV the app sends is about 3.8 MB.
export const MAX_DICTATION_BYTES = 8 * 1024 * 1024;
/** Recordings allowed to wait behind the one being transcribed. */
export const MAX_DICTATION_WAITING = 2;

// whisper's languages; anything else (e.g. "nb" from nb-NO) made whisper-cli print an error,
// exit 0 with no text, and the phone showed "nothing heard" every time.
const WHISPER_LANGUAGES = new Set(
  (
    'en zh de es ru ko fr ja pt tr pl ca nl ar sv it id hi fi vi he uk el ms cs ro da hu ta no ' +
    'th ur hr bg lt la mi ml cy sk te fa lv bn sr az sl kn et mk br eu is hy ne mn bs kk sq sw ' +
    'gl mr pa si km sn yo so af oc ka be tg sd gu am yi lo uz fo ht ps tk nn mt sa lb my bo tl ' +
    'mg as tt haw ln ha ba jw su yue'
  ).split(' ')
);
const LANGUAGE_ALIASES: Record<string, string> = { nb: 'no', iw: 'he', in: 'id', fil: 'tl' };

function findBinary(name: string, envVar: string): string | null {
  const fromEnv = process.env[envVar];
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  // The Mac app's server may start with a minimal PATH: check Homebrew's places too.
  const dirs = [...(process.env.PATH ?? '').split(':'), '/opt/homebrew/bin', '/usr/local/bin'];
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function findModel(): string | null {
  const fromEnv = process.env.UNTETHER_WHISPER_MODEL;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const dir = path.join(os.homedir(), '.local', 'share', 'whisper-cpp');
  try {
    const models = readdirSync(dir).filter((name) => /^ggml-.*\.bin$/.test(name));
    // Prefer the multilingual turbo/large models; English-only ".en" ones can't do Spanish.
    const ranked = models
      .filter((name) => !name.includes('.en.'))
      .sort((a, b) => score(b) - score(a));
    return ranked[0] ? path.join(dir, ranked[0]) : null;
  } catch {
    return null;
  }
}

function score(model: string): number {
  if (model.includes('large-v3-turbo')) return 5;
  if (model.includes('large')) return 4;
  if (model.includes('medium')) return 3;
  if (model.includes('small')) return 2;
  return 1;
}

export interface DictationTools {
  ffmpeg: string;
  whisper: string;
  model: string;
  /** whisper-server, when installed: keeps the model loaded between dictations. */
  server?: string;
}

export function dictationTools(): DictationTools | null {
  const ffmpeg = findBinary('ffmpeg', 'UNTETHER_FFMPEG');
  const whisper = findBinary('whisper-cli', 'UNTETHER_WHISPER_CLI');
  const model = findModel();
  const server =
    process.env.UNTETHER_WHISPER_SERVER === 'off'
      ? undefined
      : (findBinary('whisper-server', 'UNTETHER_WHISPER_SERVER') ?? undefined);
  return ffmpeg && whisper && model ? { ffmpeg, whisper, model, server } : null;
}

/** "es", "pt", "zh"… from a browser language ("es-ES"); "auto" when it doesn't look like one. */
export function whisperLanguage(lang: unknown): string {
  if (typeof lang !== 'string') return 'auto';
  const raw = lang.toLowerCase().split(/[-_]/)[0];
  const base = LANGUAGE_ALIASES[raw] ?? raw;
  return WHISPER_LANGUAGES.has(base) ? base : 'auto';
}

function cleanTranscript(text: string): string {
  return text
    .replace(/\[BLANK_AUDIO\]|\(.*?silencio.*?\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The 16 kHz mono 16-bit PCM WAV the app sends: whisper reads it as is, no ffmpeg. */
export function isAppWav(audio: Buffer): boolean {
  return (
    audio.length > 44 &&
    audio.toString('ascii', 0, 4) === 'RIFF' &&
    audio.toString('ascii', 8, 12) === 'WAVE' &&
    audio.readUInt16LE(20) === 1 && // PCM
    audio.readUInt16LE(22) === 1 && // mono
    audio.readUInt32LE(24) === 16000 &&
    audio.readUInt16LE(34) === 16
  );
}

/** The executable path (or name) of process `pid`, or null when it is gone. */
function processCommand(pid: number): string | null {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'comm='], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Whether `command` (from `ps -o comm=`) is the whisper-server binary `bin`.
 * 2026-10-20 (security audit): the pid file's pid was sent SIGTERM unchecked; after a reboot
 * or pid reuse that pid could be any of the user's processes.
 */
export function isWhisperCommand(command: string | null, bin: string): boolean {
  if (!command) return false;
  const name = path.basename(command.trim());
  return name === path.basename(bin) || /^whisper-server$/i.test(name);
}

export interface WhisperHints {
  prompt?: string;
  temperature?: number;
  /** Audio context in frames (768 ≈ 15 s instead of the full 30 s window). */
  audioCtx?: number;
}

/**
 * whisper-server kept running with the model loaded, started on first use and stopped after
 * 15 idle minutes. whisper-cli loads the model on every call: a 7 s phrase took 1.3-2.1 s,
 * resident it takes ~0.65 s (measured 2026-10-02). Bound to 127.0.0.1 on a random port.
 */
export class ResidentWhisper {
  private child: ChildProcess | null = null;
  private port = 0;
  private starting: Promise<boolean> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly bin: string,
    private readonly model: string,
    private readonly idleMs = 15 * 60_000,
    // Next to this server's control dir, so two Untether servers (e.g. a dev copy on
    // another port) don't stop each other's whisper.
    private readonly pidFile = path.join(
      process.env.UNTETHER_CONTROL_DIR
        ? path.dirname(process.env.UNTETHER_CONTROL_DIR)
        : path.join(os.homedir(), '.untether'),
      'whisper-server.pid'
    ),
    private readonly commandOf: (pid: number) => string | null = processCommand
  ) {}

  /**
   * A server restarted abruptly (dev watcher, crash) never ran its exit hook, leaving a
   * 1.6 GB whisper-server behind; the next one would start another. Stop the one we recorded.
   */
  private stopOrphan() {
    try {
      const pid = Number(readFileSync(this.pidFile, 'utf8'));
      if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return;
      // Only a whisper-server: the pid may have been reused by anything since.
      if (isWhisperCommand(this.commandOf(pid), this.bin)) process.kill(pid, 'SIGTERM');
    } catch {
      // No pid file, or that process is gone.
    }
  }

  private start(): Promise<boolean> {
    if (this.starting) return this.starting;
    this.stopOrphan();
    this.port = 20000 + Math.floor(Math.random() * 40000);
    const child = spawn(
      this.bin,
      ['-m', this.model, '--host', '127.0.0.1', '--port', String(this.port)],
      { stdio: 'ignore' }
    );
    this.child = child;
    child.unref();
    try {
      if (child.pid) writeFileSync(this.pidFile, String(child.pid), { mode: 0o600 });
    } catch {
      // Best effort: without the file an orphan just lives until the 15-minute idle stop.
    }
    const reset = () => {
      if (this.child === child) {
        this.child = null;
        this.starting = null;
      }
    };
    child.on('exit', reset);
    child.on('error', reset);
    this.starting = (async () => {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline && this.child === child) {
        try {
          await fetch(`http://127.0.0.1:${this.port}/`, { signal: AbortSignal.timeout(1000) });
          logger.log(`whisper-server ready on port ${this.port}`);
          return true;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
      this.stop();
      return false;
    })();
    return this.starting;
  }

  /** Started and answering: the next transcription needs no model load. */
  get running(): boolean {
    return this.child !== null;
  }

  /** Restart the idle clock while someone is talking with the copilot (no reload mid-talk). */
  keepAlive(): void {
    if (!this.child) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stop(), this.idleMs);
    this.idleTimer.unref?.();
  }

  /**
   * The text, or null when the resident server isn't usable (the caller uses whisper-cli).
   * `hints`: the voice copilot's words for whisper (`prompt`: names it should hear right,
   * temperature 0, a shorter audio context for short utterances).
   */
  async transcribe(
    wav: Buffer,
    language: string,
    signal?: AbortSignal,
    hints: WhisperHints = {}
  ): Promise<string | null> {
    if (!(await this.start())) return null;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stop(), this.idleMs);
    this.idleTimer.unref?.();
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'audio.wav');
    form.append('language', language);
    form.append('response_format', 'json');
    if (hints.prompt) form.append('prompt', hints.prompt);
    if (hints.temperature !== undefined) form.append('temperature', String(hints.temperature));
    if (hints.audioCtx) form.append('audio_ctx', String(hints.audioCtx));
    const timeout = AbortSignal.timeout(120_000);
    const response = await fetch(`http://127.0.0.1:${this.port}/inference`, {
      method: 'POST',
      body: form,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) return null;
    const { text } = (await response.json()) as { text?: unknown };
    return typeof text === 'string' ? cleanTranscript(text) : null;
  }

  stop(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.child) rmSync(this.pidFile, { force: true });
    this.child?.kill();
    this.child = null;
    this.starting = null;
  }
}

let resident: ResidentWhisper | null = null;
let residentKey = '';

function residentFor(tools: DictationTools): ResidentWhisper | null {
  if (!tools.server) return null;
  const key = `${tools.server}|${tools.model}`;
  if (!resident || residentKey !== key) {
    resident?.stop();
    resident = new ResidentWhisper(tools.server, tools.model);
    residentKey = key;
  }
  return resident;
}

process.on('exit', () => resident?.stop());

let queue: Promise<unknown> = Promise.resolve();
/** Jobs not finished yet: the one running plus those waiting. */
let pending = 0;

export class DictationBusyError extends Error {}

/** The resident whisper-server for these tools, or null without one (the voice copilot's view). */
export function residentWhisper(): ResidentWhisper | null {
  const tools = dictationTools();
  return tools ? residentFor(tools) : null;
}

/**
 * One short utterance from the voice copilot (16 kHz mono WAV from the page), in the same queue
 * as dictation, straight to the resident server: no temporary files, no whisper-cli fallback
 * (a model load per utterance would be slower than saying "didn't catch that"). Null when the
 * resident server is not available.
 */
export async function transcribeUtterance(
  wav: Buffer,
  lang: string,
  hints: WhisperHints = {},
  server: ResidentWhisper | null = residentWhisper()
): Promise<string | null> {
  if (!server) return null;
  if (pending >= 1 + MAX_DICTATION_WAITING) throw new DictationBusyError('busy');
  pending++;
  const job = queue.then(() => server.transcribe(wav, lang, undefined, hints));
  queue = job.catch(() => undefined);
  return job.finally(() => {
    pending--;
  });
}

/** Transcribe one recording (any format ffmpeg reads) to plain text. */
export async function transcribe(
  audio: Buffer,
  lang: string,
  tools: DictationTools,
  run = execFileAsync,
  signal?: AbortSignal,
  server: ResidentWhisper | null = residentFor(tools)
): Promise<string> {
  // A logged-in client can't pile up work: a small queue, and abandoned requests are skipped
  // or killed (each held up to 150 s of CPU before).
  if (pending >= 1 + MAX_DICTATION_WAITING) throw new DictationBusyError('busy');
  pending++;
  const job = queue.then(async () => {
    if (signal?.aborted) throw new Error('aborted');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ut-dictation-'));
    try {
      const wav = path.join(dir, 'audio.wav');
      if (isAppWav(audio)) {
        await fs.writeFile(wav, audio);
      } else {
        const input = path.join(dir, 'input');
        await fs.writeFile(input, audio);
        await run(
          tools.ffmpeg,
          [
            '-loglevel',
            'error',
            '-y',
            // Only WAV and only local files: a probed format could be a playlist/concat
            // file that makes ffmpeg read other paths or URLs.
            '-f',
            'wav',
            '-protocol_whitelist',
            'file',
            '-i',
            input,
            '-ar',
            '16000',
            '-ac',
            '1',
            '-c:a',
            'pcm_s16le',
            wav,
          ],
          { timeout: 30_000, signal }
        );
      }
      const wavBytes = server ? await fs.readFile(wav) : null;
      const whisper = async (language: string) => {
        if (server && wavBytes) {
          const fast = await server.transcribe(wavBytes, language, signal).catch((error) => {
            if (signal?.aborted) throw error;
            logger.warn('whisper-server failed, using whisper-cli:', error);
            return null;
          });
          if (fast !== null) return fast;
        }
        const { stdout } = await run(
          tools.whisper,
          ['-m', tools.model, '-l', language, '-nt', '-np', '-f', wav],
          { timeout: 120_000, maxBuffer: 4 * 1024 * 1024, signal }
        );
        return cleanTranscript(String(stdout));
      };
      const text = await whisper(lang);
      // Nothing in the chosen language: let whisper detect it before saying "nothing heard".
      return text || lang === 'auto' ? text : whisper('auto');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
  queue = job.catch(() => undefined);
  return job.finally(() => {
    pending--;
  });
}

export function createDictationRoutes(): Router {
  const router = Router();

  router.get('/dictation/status', (_req: Request, res: Response) => {
    res.json({ available: dictationTools() !== null });
  });

  router.post(
    '/dictation/transcribe',
    express.raw({ type: () => true, limit: MAX_DICTATION_BYTES }),
    async (req: Request, res: Response) => {
      const tools = dictationTools();
      if (!tools) {
        return res.status(503).json({ error: 'Transcription is not installed on this Mac' });
      }
      const audio = req.body;
      if (!Buffer.isBuffer(audio) || audio.length === 0) {
        return res.status(400).json({ error: 'No audio received' });
      }
      const started = Date.now();
      const abort = new AbortController();
      // The RESPONSE closing before we answered means the phone gave up. (req's 'close'
      // fires as soon as the body has been read in current Node: listening to it aborted
      // every transcription and the request hung with no answer — 2026-10-02.)
      res.on('close', () => {
        if (!res.writableFinished) abort.abort();
      });
      try {
        const text = await transcribe(
          audio,
          whisperLanguage(req.query.lang),
          tools,
          execFileAsync,
          abort.signal
        );
        logger.log(
          `transcribed ${Math.round(audio.length / 1024)} KB in ${Date.now() - started} ms (${text.length} chars)`
        );
        res.json({ text });
      } catch (error) {
        if (error instanceof DictationBusyError) {
          return res.status(429).json({ error: 'Busy transcribing, try again in a moment' });
        }
        if (abort.signal.aborted) return; // the phone gave up; nobody is listening
        logger.error('transcription failed:', error);
        res.status(500).json({ error: 'Transcription failed' });
      }
    }
  );

  return router;
}
