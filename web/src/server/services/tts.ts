/**
 * Text to speech on the Mac for the phone's voice mode ("Conversar"): Claude's replies are
 * read aloud with a natural local voice instead of the phone's robotic speechSynthesis.
 *
 * Engines, best first: for Spanish only, Qwen3-TTS 0.6B with the cloned voice hy-M1xEn1s4
 * (MLX, resident, ~0.16 s to first audio and ~3 GB, chosen by the user 2026-10-14) when it is
 * installed under ~/.untether/tts/qwen, loaded and memory allows; then Kokoro-82M (kokoro-onnx
 * in its own venv, kept resident like whisper-server: ~0.45 s for a 3.5 s Spanish sentence,
 * measured 2026-10-02), Piper when it is already installed, and macOS `say`, which is always
 * there. Every program runs with an argument array, never a shell; one synthesis at a time
 * behind a small queue.
 */
import { type ChildProcess, execFile, spawn } from 'child_process';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createInterface } from 'readline';
import { promisify } from 'util';
import {
  detectSpeechLanguage,
  MAX_TTS_CHARS,
  normalizeSpeechLanguage,
  type SpeechLanguage,
} from '../../shared/tts-text.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('tts');
const execFileAsync = promisify(execFile);

export { MAX_TTS_CHARS };
/** Requests allowed to wait behind the one being synthesized. */
export const MAX_TTS_WAITING = 4;
export const TTS_TIMEOUT_MS = 30_000;

export type TtsEngineName = 'qwen' | 'kokoro' | 'piper' | 'say';

/** Kokoro voice + espeak language per language (espeak rejects "zh": it wants "cmn"). */
export const KOKORO_VOICES: Partial<Record<SpeechLanguage, { voice: string; lang: string }>> = {
  es: { voice: 'ef_dora', lang: 'es' },
  en: { voice: 'af_heart', lang: 'en-us' },
  pt: { voice: 'pf_dora', lang: 'pt-br' },
  fr: { voice: 'ff_siwis', lang: 'fr-fr' },
  it: { voice: 'if_sara', lang: 'it' },
  hi: { voice: 'hf_alpha', lang: 'hi' },
  zh: { voice: 'zf_xiaoxiao', lang: 'cmn' },
};

/** macOS voices per language (installed by default on Spanish/English Macs). */
export const SAY_VOICES: Record<SpeechLanguage, string> = {
  es: 'Mónica',
  en: 'Samantha',
  fr: 'Thomas',
  pt: 'Luciana',
  it: 'Alice',
  zh: 'Tingting',
  hi: 'Lekha',
  ar: 'Majed',
  bn: 'Piya',
};

/** Where the Kokoro venv and models live (created by hand, see docs in the report). */
export function ttsHome(): string {
  return process.env.UNTETHER_TTS_DIR || path.join(os.homedir(), '.untether', 'tts');
}

function firstExisting(candidates: Array<string | undefined>): string | null {
  for (const candidate of candidates) if (candidate && existsSync(candidate)) return candidate;
  return null;
}

export interface KokoroSetup {
  python: string;
  model: string;
  voices: string;
}

export function kokoroSetup(): KokoroSetup | null {
  const home = ttsHome();
  const python = firstExisting([
    process.env.UNTETHER_TTS_PYTHON,
    path.join(home, 'venv', 'bin', 'python3'),
  ]);
  const models = path.join(home, 'models');
  // fp16 first: 0.43 s vs 0.55 s per sentence on this Mac, and half the size.
  const model = firstExisting([
    process.env.UNTETHER_KOKORO_MODEL,
    path.join(models, 'kokoro-v1.0.fp16.onnx'),
    path.join(models, 'kokoro-v1.0.onnx'),
  ]);
  const voices = firstExisting([
    process.env.UNTETHER_KOKORO_VOICES,
    path.join(models, 'voices-v1.0.bin'),
  ]);
  return python && model && voices ? { python, model, voices } : null;
}

function findBinary(name: string, envVar: string): string | null {
  const fromEnv = process.env[envVar];
  if (fromEnv) return existsSync(fromEnv) ? fromEnv : null;
  const dirs = [
    ...(process.env.PATH ?? '').split(':'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
  ];
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Piper counts only when it's installed with a voice model (we never install it). */
export function piperSetup(): { bin: string; model: string } | null {
  const bin = findBinary('piper', 'UNTETHER_PIPER');
  if (!bin) return null;
  const fromEnv = process.env.UNTETHER_PIPER_MODEL;
  if (fromEnv) return existsSync(fromEnv) ? { bin, model: fromEnv } : null;
  const dir = path.join(ttsHome(), 'piper');
  try {
    const model = readdirSync(dir).find((name) => name.endsWith('.onnx'));
    return model ? { bin, model: path.join(dir, model) } : null;
  } catch {
    return null;
  }
}

export function sayBinary(): string | null {
  return findBinary('say', 'UNTETHER_SAY');
}

/**
 * The engines a request would try, in order: UNTETHER_TTS_ENGINE pins one (tests, debugging).
 * With `lang`, only those that speak it (Qwen is Spanish only); without, every installed one.
 */
export function availableEngines(lang?: SpeechLanguage): TtsEngineName[] {
  const pinned = process.env.UNTETHER_TTS_ENGINE;
  const engines: TtsEngineName[] = [];
  if ((!lang || QWEN_LANGS.includes(lang)) && qwenSetup()) engines.push('qwen');
  if (kokoroSetup()) engines.push('kokoro');
  if (piperSetup()) engines.push('piper');
  if (sayBinary()) engines.push('say');
  return pinned ? engines.filter((engine) => engine === pinned) : engines;
}

/**
 * The resident Kokoro process. Newline-delimited JSON: it prints {"ready":true} once the
 * model is loaded, then answers each {"id","text","voice","lang","out"} with {"id","ok"}.
 * Adapted from CanvasIO's kokoro sidecar; kept inline so the server needs no extra file.
 */
export const KOKORO_SIDECAR = `
import sys, json, argparse
def emit(o):
    sys.stdout.write(json.dumps(o) + "\\n"); sys.stdout.flush()
ap = argparse.ArgumentParser()
ap.add_argument("--model", required=True)
ap.add_argument("--voices", required=True)
args = ap.parse_args()
try:
    from kokoro_onnx import Kokoro
    import soundfile as sf
    k = Kokoro(args.model, args.voices)
except Exception as e:
    emit({"fatal": True, "error": str(e)}); sys.exit(1)
emit({"ready": True})
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    rid = None
    try:
        req = json.loads(line); rid = req.get("id")
        samples, sr = k.create(req["text"], voice=req["voice"], speed=req.get("speed", 1.0), lang=req["lang"])
        sf.write(req["out"], samples, sr, subtype="PCM_16")
        emit({"id": rid, "ok": True})
    except Exception as e:
        emit({"id": rid, "ok": False, "error": str(e)})
`;

/**
 * The resident Qwen3-TTS process (voice hy-M1xEn1s4, Spanish with a Castilian accent).
 * Same protocol as Kokoro's, plus {"cancel": id} to stop a reply mid-generation. The recipe
 * is the one the voice was approved with: speaker x-vector taken once from `--speaker` and
 * forced for every generation (timbre), in-context prompt `--ref-audio` + its transcript
 * (accent and prosody), temperature 0.9, a warm-up «Hola.» after seed 0, then seed 7 before
 * every utterance so the same text always gives the same audio. Output 24 kHz 16-bit mono.
 * Requests are read on a thread so a cancel lands while the main thread generates.
 */
export const QWEN_SIDECAR = `
import sys, os, json, argparse, threading, queue, warnings
warnings.filterwarnings("ignore")
os.environ.setdefault("HF_HUB_OFFLINE", "1")
lock = threading.Lock()
def emit(o):
    with lock:
        sys.stdout.write(json.dumps(o) + "\\n"); sys.stdout.flush()
ap = argparse.ArgumentParser()
ap.add_argument("--model", required=True)
ap.add_argument("--ref-audio", required=True)
ap.add_argument("--ref-text", required=True)
ap.add_argument("--speaker", required=True)
ap.add_argument("--temperature", type=float, default=0.9)
ap.add_argument("--seed", type=int, default=7)
args = ap.parse_args()
try:
    import numpy as np, soundfile as sf, mlx.core as mx
    from mlx_audio.tts.utils import load_model
    from mlx_audio.utils import load_audio
    m = load_model(args.model)
    _orig = type(m).extract_speaker_embedding
    _e = _orig(m, load_audio(args.speaker, sample_rate=24000)); mx.eval(_e)
    m.extract_speaker_embedding = lambda audio, sr=24000, _e=_e: _e
    ref_text = open(args.ref_text).read().strip()
    def gen(t):
        return m.generate(text=t, ref_audio=args.ref_audio, ref_text=ref_text, lang_code="spanish",
                          stream=True, streaming_interval=0.32, temperature=args.temperature)
    mx.random.seed(0)
    for _ in gen("Hola."): pass
except Exception as e:
    emit({"fatal": True, "error": str(e)}); sys.exit(1)
def clear_cache():
    try:
        (getattr(mx, "clear_cache", None) or mx.metal.clear_cache)()
    except Exception:
        pass
clear_cache()
requests = queue.Queue(); cancelled = set()
def read_requests():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            continue
        if "cancel" in req:
            cancelled.add(req["cancel"])
        else:
            requests.put(req)
    requests.put(None)
threading.Thread(target=read_requests, daemon=True).start()
emit({"ready": True})
while True:
    req = requests.get()
    if req is None:
        break
    rid = req.get("id")
    try:
        parts = []; sr = 24000; aborted = rid in cancelled
        if not aborted:
            mx.random.seed(args.seed)
            for r in gen(req["text"]):
                if rid in cancelled:
                    aborted = True; break
                parts.append(np.array(r.audio, dtype=np.float32).reshape(-1)); sr = r.sample_rate
        cancelled.discard(rid)
        if aborted:
            emit({"id": rid, "ok": False, "error": "aborted"})
        elif not parts:
            emit({"id": rid, "ok": False, "error": "no audio"})
        else:
            sf.write(req["out"], np.concatenate(parts), sr, subtype="PCM_16")
            emit({"id": rid, "ok": True})
    except Exception as e:
        emit({"id": rid, "ok": False, "error": str(e)})
    clear_cache()
`;

interface SidecarResult {
  ok: boolean;
  error?: string;
}

function controlPidFile(name: string): string {
  return path.join(
    process.env.UNTETHER_CONTROL_DIR
      ? path.dirname(process.env.UNTETHER_CONTROL_DIR)
      : path.join(os.homedir(), '.untether'),
    name
  );
}

/**
 * A python model kept loaded between replies and stopped after 15 idle minutes.
 * Newline-delimited JSON: {"ready":true} once loaded (or {"fatal":true,"error"}), then one
 * {"id","ok","error"?} per request, in order. A pid file lets the next server stop the one a
 * killed server left behind.
 */
abstract class ResidentSidecar {
  protected child: ChildProcess | null = null;
  protected starting: Promise<boolean> | null = null;
  /** The sidecar printed {"ready":true}. */
  protected loaded = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped by stop(): an async start that began before it must not spawn afterwards. */
  protected generation = 0;
  private nextId = 1;
  private waiting = new Map<number, (result: SidecarResult) => void>();

  constructor(
    protected readonly name: string,
    protected readonly idleMs: number,
    protected readonly pidFile: string,
    private readonly startTimeoutMs: number
  ) {}

  protected abstract command(): { bin: string; args: string[]; cwd?: string };

  /** A server killed abruptly leaves its sidecar behind: stop the one we recorded. */
  private stopOrphan() {
    try {
      const pid = Number(readFileSync(this.pidFile, 'utf8'));
      if (Number.isInteger(pid) && pid > 1) process.kill(pid, 'SIGTERM');
    } catch {
      // No pid file, or that process is gone.
    }
  }

  get running(): boolean {
    return this.child !== null;
  }

  start(): Promise<boolean> {
    return this.starting ?? this.spawnSidecar();
  }

  protected spawnSidecar(): Promise<boolean> {
    this.stopOrphan();
    const { bin, args, cwd } = this.command();
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'ignore'], cwd });
    // A sidecar that died between two writes: its exit resets us, the broken pipe must not
    // be an uncaught exception (2026-11-10).
    child.stdin?.on('error', () => undefined);
    this.child = child;
    this.loaded = false;
    try {
      if (child.pid) writeFileSync(this.pidFile, String(child.pid));
    } catch {
      // Best effort.
    }
    let ready: (ok: boolean) => void = () => undefined;
    const readyPromise = new Promise<boolean>((resolve) => {
      ready = resolve;
    });
    const lines = createInterface({ input: child.stdout as NodeJS.ReadableStream });
    lines.on('line', (line) => {
      let message: { ready?: boolean; fatal?: boolean; id?: number; ok?: boolean; error?: string };
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.ready) {
        if (this.child === child) this.loaded = true;
        ready(true);
      } else if (message.fatal) {
        logger.warn(`${this.name} could not start: ${message.error}`);
        ready(false);
      } else if (typeof message.id === 'number') {
        this.waiting.get(message.id)?.({ ok: Boolean(message.ok), error: message.error });
        this.waiting.delete(message.id);
      }
    });
    const reset = () => {
      ready(false);
      if (this.child !== child) return;
      // Not via stop(): it died on its own. Its pid file goes too, or the next start's
      // stopOrphan() could signal an unrelated process that reused the pid.
      if (this.loaded) this.onCrash();
      try {
        rmSync(this.pidFile, { force: true });
      } catch {
        // Unwritable control dir: nothing recorded.
      }
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.idleTimer = null;
      for (const done of this.waiting.values()) done({ ok: false, error: `${this.name} exited` });
      this.waiting.clear();
      this.child = null;
      this.starting = null;
      this.loaded = false;
    };
    child.on('exit', reset);
    child.on('error', reset);
    const timer = setTimeout(() => ready(false), this.startTimeoutMs);
    this.starting = readyPromise.then((ok) => {
      clearTimeout(timer);
      if (ok) {
        logger.log(`${this.name} ready`);
        // Loaded in the background and never asked for anything (review 2026-10-14: a Qwen
        // warmed for one reply Kokoro answered stayed at ~3 GB until the server restarted):
        // the idle clock starts at load, not at the first request.
        if (this.child === child) this.keepAlive();
      } else if (this.child === child) this.stop();
      return ok;
    });
    return this.starting;
  }

  /** Sends one request to the loaded sidecar; false when it failed, timed out or was aborted. */
  protected async request(payload: Record<string, unknown>, signal?: AbortSignal) {
    if (signal?.aborted || !this.child?.stdin) return false;
    this.keepAlive();
    const id = this.nextId++;
    const result = await new Promise<SidecarResult>((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        resolve({ ok: false, error: 'timeout' });
        // A stuck sidecar would hold every later request: start a fresh one next time.
        this.onCrash();
        this.stop();
      }, TTS_TIMEOUT_MS);
      const finish = (value: SidecarResult) => {
        clearTimeout(timer);
        resolve(value);
      };
      this.waiting.set(id, finish);
      signal?.addEventListener(
        'abort',
        () => {
          this.onAbort(id);
          finish({ ok: false, error: 'aborted' });
        },
        { once: true }
      );
      this.child?.stdin?.write(`${JSON.stringify({ id, ...payload })}\n`);
    });
    if (!result.ok && result.error !== 'aborted')
      logger.warn(`${this.name} failed: ${result.error}`);
    return result.ok;
  }

  /** The request was abandoned (its answer is ignored when it comes). */
  protected onAbort(_id: number): void {}

  /** The loaded sidecar exited on its own, or hung on a request. */
  protected onCrash(): void {}

  /** Restart the idle clock while someone is talking with the copilot (no reload mid-talk). */
  keepAlive(): void {
    if (!this.child) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stop(), this.idleMs);
    this.idleTimer.unref?.();
  }

  stop(): void {
    this.generation++;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    try {
      if (this.child) rmSync(this.pidFile, { force: true });
    } catch {
      // Unwritable control dir: nothing recorded, nothing to remove.
    }
    for (const done of this.waiting.values()) done({ ok: false, error: `${this.name} stopped` });
    this.waiting.clear();
    this.child?.kill();
    this.child = null;
    this.starting = null;
    this.loaded = false;
  }
}

/** Kokoro kept loaded between replies; stopped after 15 idle minutes. */
export class ResidentKokoro extends ResidentSidecar {
  private warmed = false;

  constructor(
    private readonly setup: KokoroSetup,
    idleMs = 15 * 60_000,
    pidFile = controlPidFile('kokoro-tts.pid')
  ) {
    super('kokoro', idleMs, pidFile, 60_000);
  }

  protected command() {
    const { python, model, voices } = this.setup;
    return {
      bin: python,
      args: ['-u', '-c', KOKORO_SIDECAR, '--model', model, '--voices', voices],
    };
  }

  /** Loaded and warmed up: the next reply gets the fast path. */
  get ready(): boolean {
    return this.child !== null && this.warmed;
  }

  /**
   * Load the model and run one tiny synthesis: the first real reply after a cold start took
   * ~1 s instead of ~0.45 s (onnxruntime warms up on its first run).
   */
  async warm(): Promise<void> {
    if (this.running) return;
    if (!(await this.start())) return;
    const child = this.child;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ut-tts-warm-'));
    try {
      // Each language's first sentence is slow once (its phonemizer loads): warm the two
      // the user speaks.
      await this.synthesize('Hola.', 'ef_dora', 'es', path.join(dir, 'es.wav'));
      await this.synthesize('Hi.', 'af_heart', 'en-us', path.join(dir, 'en.wav'));
      if (this.child === child) this.warmed = true;
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  /** Writes a WAV to `out`; false when Kokoro isn't usable (the caller tries the next engine). */
  async synthesize(text: string, voice: string, lang: string, out: string, signal?: AbortSignal) {
    if (!(await this.start())) return false;
    return this.request({ text, voice, lang, out }, signal);
  }

  stop(): void {
    super.stop();
    this.warmed = false;
  }
}

export interface QwenSetup {
  dir: string;
  python: string;
  model: string;
  refAudio: string;
  refText: string;
  speaker: string;
}

/** The voice the Qwen sidecar speaks with (the name it was chosen under). */
export const QWEN_VOICE = 'hy-M1xEn1s4';
export const QWEN_LANGS: readonly SpeechLanguage[] = ['es'];

/**
 * The Qwen3-TTS install under $UNTETHER_TTS_DIR/qwen (venv/, model/, refs/; see its
 * README.txt). Missing pieces, or UNTETHER_TTS_QWEN=0, leave the engine out of the chain.
 */
export function qwenSetup(): QwenSetup | null {
  if (process.env.UNTETHER_TTS_QWEN === '0') return null;
  const dir = path.join(ttsHome(), 'qwen');
  const python = firstExisting([
    process.env.UNTETHER_QWEN_PYTHON,
    path.join(dir, 'venv', 'bin', 'python3'),
  ]);
  const model = path.join(dir, 'model');
  const refs = path.join(dir, 'refs');
  const setup = {
    dir,
    python: python ?? '',
    model,
    refAudio: path.join(refs, 'ref_en1_s4.wav'),
    refText: path.join(refs, 'ref_en1_s4.txt'),
    speaker: path.join(refs, 'spk_M1.wav'),
  };
  const files = [path.join(model, 'config.json'), setup.refAudio, setup.refText, setup.speaker];
  return python && files.every((file) => existsSync(file)) ? setup : null;
}

/**
 * Memory the system can hand out without swapping: free + inactive + speculative pages from
 * `vm_stat` (inactive and speculative are file cache macOS drops on demand; `os.freemem()`
 * counts only the free pages, which on a busy Mac is a few hundred MB even when GBs are
 * reclaimable). Falls back to `os.freemem()` where vm_stat is missing.
 */
export async function reclaimableMemory(run: Run = execFileAsync): Promise<number> {
  try {
    const { stdout } = await run('/usr/bin/vm_stat', [], { timeout: 2_000 });
    const text = String(stdout);
    const pageSize = Number(/page size of (\d+) bytes/.exec(text)?.[1] ?? 0);
    const pages = (label: string) =>
      Number(new RegExp(`Pages ${label}:\\s+(\\d+)`).exec(text)?.[1] ?? 0);
    const bytes = pageSize * (pages('free') + pages('inactive') + pages('speculative'));
    if (bytes > 0) return bytes;
  } catch {
    // Not macOS, or vm_stat failed.
  }
  return os.freemem();
}

/**
 * Below this, Qwen is not started and Kokoro reads instead: the sidecar's footprint reaches
 * ~5 GB (3.15 GB MLX peak plus the Python process), and the Mac runs other models too.
 * UNTETHER_QWEN_MIN_FREE_MB overrides it.
 */
export function qwenMinFreeBytes(): number {
  const mb = Number(process.env.UNTETHER_QWEN_MIN_FREE_MB);
  const fromEnv = process.env.UNTETHER_QWEN_MIN_FREE_MB;
  return (fromEnv && Number.isFinite(mb) && mb >= 0 ? mb : 5120) * 2 ** 20;
}

/**
 * Qwen kept loaded between replies; stopped after 15 idle minutes to give back its ~3-5 GB.
 * It never makes a reply wait for its cold load (~3-12 s): until it is ready the caller asks
 * `warm()` and reads that reply with Kokoro.
 */
export class ResidentQwen extends ResidentSidecar {
  /** No new start before this time (after a failed start, a crash or a memory skip). */
  private retryAt = 0;
  /** When the loaded sidecar crashed or hung, within the last CRASH_WINDOW_MS. */
  private crashes: number[] = [];

  constructor(
    private readonly setup: QwenSetup,
    idleMs = 15 * 60_000,
    pidFile = controlPidFile('qwen-tts.pid'),
    private readonly freeMemory: () => Promise<number> = () => reclaimableMemory()
  ) {
    super('qwen', idleMs, pidFile, 120_000);
  }

  protected command() {
    const s = this.setup;
    return {
      bin: s.python,
      args: [
        '-u',
        '-c',
        QWEN_SIDECAR,
        '--model',
        s.model,
        '--ref-audio',
        s.refAudio,
        '--ref-text',
        s.refText,
        '--speaker',
        s.speaker,
      ],
      cwd: s.dir,
    };
  }

  /** Loaded and past its warm-up (the sidecar warms itself before it says ready). */
  get ready(): boolean {
    return this.child !== null && this.loaded;
  }

  start(): Promise<boolean> {
    if (this.starting) return this.starting;
    if (Date.now() < this.retryAt) return Promise.resolve(false);
    const generation = this.generation;
    let superseded = false;
    const attempt = (async () => {
      const free = await this.freeMemory().catch(() => Number.POSITIVE_INFINITY);
      // stop() ran (shutdown, or residentQwen() replaced this instance) while memory was
      // checked: a child spawned now would outlive every handle that could stop it.
      if (this.generation !== generation) {
        superseded = true;
        return false;
      }
      const min = qwenMinFreeBytes();
      if (free < min) {
        logger.log(
          `qwen not started: ${(free / 2 ** 30).toFixed(1)} GB reclaimable < ${(min / 2 ** 30).toFixed(1)} GB; Kokoro reads`
        );
        this.retryAt = Date.now() + 60_000;
        return false;
      }
      return this.spawnSidecar();
    })();
    this.starting = attempt;
    void attempt.then((ok) => {
      if (ok || superseded) return;
      if (this.starting === attempt) this.starting = null;
      // A broken install would otherwise be retried (and logged) on every reply.
      this.retryAt = Math.max(this.retryAt, Date.now() + 60_000);
    });
    return attempt;
  }

  /** Start loading in the background (the memory guard decides); never throws. */
  warm(): Promise<boolean> {
    return this.start().catch(() => false);
  }

  /** Writes a WAV to `out` when Qwen is ready; false (and a background load) when it isn't. */
  async synthesize(text: string, out: string, signal?: AbortSignal): Promise<boolean> {
    if (!this.ready) {
      void this.warm();
      return false;
    }
    return this.request({ text, out }, signal);
  }

  protected onAbort(id: number): void {
    this.child?.stdin?.write(`${JSON.stringify({ cancel: id })}\n`);
  }

  /**
   * A Qwen that dies after loading (Metal OOM, a text that trips a bug) would otherwise be
   * reloaded (~3 GB, seconds of disk) by the very next Spanish reply, every time (review
   * 2026-10-14, reproduced with kill -9). Back off 1 min, then 5 min; after the third crash
   * within 10 min Kokoro reads Spanish until the server restarts.
   */
  protected onCrash(): void {
    const now = Date.now();
    this.crashes = this.crashes.filter((at) => now - at < QWEN_CRASH_WINDOW_MS);
    this.crashes.push(now);
    const n = this.crashes.length;
    const wait = n >= 3 ? Number.POSITIVE_INFINITY : n === 2 ? 5 * 60_000 : 60_000;
    this.retryAt = Math.max(this.retryAt, now + wait);
    logger.warn(
      n >= 3
        ? `qwen crashed ${n} times in 10 min: off until the server restarts; Kokoro reads`
        : `qwen crashed: no reload for ${wait / 60_000} min; Kokoro reads`
    );
  }

  /** Not off: ready, loading, or allowed to load on the next reply. */
  get usable(): boolean {
    return this.child !== null || this.starting !== null || Date.now() >= this.retryAt;
  }
}

const QWEN_CRASH_WINDOW_MS = 10 * 60_000;

let resident: ResidentKokoro | null = null;
let residentKey = '';

export function residentKokoro(): ResidentKokoro | null {
  const setup = kokoroSetup();
  if (!setup) return null;
  const key = `${setup.python}|${setup.model}|${setup.voices}`;
  if (!resident || residentKey !== key) {
    resident?.stop();
    resident = new ResidentKokoro(setup);
    residentKey = key;
  }
  return resident;
}

let qwenResident: ResidentQwen | null = null;
let qwenKey = '';

export function residentQwen(): ResidentQwen | null {
  const setup = qwenSetup();
  if (!setup) {
    qwenResident?.stop();
    qwenResident = null;
    qwenKey = '';
    return null;
  }
  const key = JSON.stringify(setup);
  if (!qwenResident || qwenKey !== key) {
    qwenResident?.stop();
    qwenResident = new ResidentQwen(setup);
    qwenKey = key;
  }
  return qwenResident;
}

export function stopResidentKokoroForTests(): void {
  resident?.stop();
  resident = null;
  residentKey = '';
  qwenResident?.stop();
  qwenResident = null;
  qwenKey = '';
}

process.on('exit', () => {
  resident?.stop();
  qwenResident?.stop();
});

/** Text a voice should read: no markdown, links shortened, emoji dropped. */
export function cleanForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[*_#>|~]+/g, ' ')
    .replace(/\p{Extended_Pictographic}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export class TtsBusyError extends Error {}

export interface SpeechResult {
  audio: Buffer;
  contentType: string;
  engine: TtsEngineName;
  lang: SpeechLanguage;
}

type Run = typeof execFileAsync;

let queue: Promise<unknown> = Promise.resolve();
let pending = 0;

/**
 * Synthesize `text` with the best engine that works, falling back down the chain. `lang`
 * is a hint (the language the user spoke); the text's own language wins when it's clear.
 */
export async function synthesize(
  text: string,
  langHint: unknown,
  signal?: AbortSignal,
  run: Run = execFileAsync,
  kokoro: ResidentKokoro | null = residentKokoro(),
  qwen: ResidentQwen | null = residentQwen()
): Promise<SpeechResult> {
  const spoken = cleanForSpeech(text).slice(0, MAX_TTS_CHARS);
  const lang = detectSpeechLanguage(spoken, normalizeSpeechLanguage(langHint) ?? 'en');
  if (pending >= 1 + MAX_TTS_WAITING) throw new TtsBusyError('busy');
  pending++;
  const job = queue.then(async () => {
    if (signal?.aborted) throw new Error('aborted');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ut-tts-'));
    try {
      for (const engine of availableEngines(lang)) {
        const out = path.join(dir, `${engine}.wav`);
        let ok = false;
        try {
          ok = await runEngine(engine, spoken, lang, out, run, kokoro, qwen, signal);
        } catch (error) {
          if (signal?.aborted) throw error;
          logger.warn(`${engine} failed:`, error);
        }
        if (ok && existsSync(out)) {
          const audio = await fs.readFile(out);
          if (audio.length > 44) return { audio, contentType: 'audio/wav', engine, lang };
        }
        if (signal?.aborted) throw new Error('aborted');
      }
      throw new Error('no text-to-speech engine worked');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
  queue = job.catch(() => undefined);
  return job.finally(() => {
    pending--;
  });
}

async function runEngine(
  engine: TtsEngineName,
  text: string,
  lang: SpeechLanguage,
  out: string,
  run: Run,
  kokoro: ResidentKokoro | null,
  qwen: ResidentQwen | null,
  signal?: AbortSignal
): Promise<boolean> {
  // Not loaded yet: this reply goes to Kokoro while Qwen loads in the background.
  if (engine === 'qwen') return qwen ? qwen.synthesize(text, out, signal) : false;
  if (engine === 'kokoro') {
    const voice = KOKORO_VOICES[lang];
    if (!voice || !kokoro) return false;
    return kokoro.synthesize(text, voice.voice, voice.lang, out, signal);
  }
  if (engine === 'piper') {
    const piper = piperSetup();
    if (!piper) return false;
    await runWithInput(piper.bin, ['--model', piper.model, '--output_file', out], text, signal);
    return true;
  }
  const say = sayBinary();
  if (!say) return false;
  const args = ['-o', out, '--file-format=WAVE', '--data-format=LEI16@22050', '--', text];
  try {
    await run(say, ['-v', SAY_VOICES[lang], ...args], { timeout: TTS_TIMEOUT_MS, signal });
  } catch (error) {
    if (signal?.aborted) throw error;
    // That voice isn't installed on this Mac: the system voice is better than silence.
    await run(say, args, { timeout: TTS_TIMEOUT_MS, signal });
  }
  return true;
}

function runWithInput(bin: string, args: string[], input: string, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'ignore', 'ignore'], signal });
    const timer = setTimeout(() => child.kill(), TTS_TIMEOUT_MS);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`${path.basename(bin)} exited with ${code}`));
    });
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(input);
  });
}

let forcedSeq = 0;

/** One resident engine's WAV for `text`, or null; the temporary file is always removed. */
async function readResident(render: (out: string) => Promise<boolean>): Promise<Buffer | null> {
  const out = path.join(os.tmpdir(), `ut-copilot-tts-${process.pid}-${++forcedSeq}.wav`);
  try {
    if (!(await render(out))) return null;
    const audio = await fs.readFile(out);
    return audio.length > 44 ? audio : null;
  } finally {
    await fs.rm(out, { force: true });
  }
}

/**
 * One sentence for the voice copilot, in the language it is told (the copilot knows which one
 * it speaks: `synthesize` would guess again from the text, and a Spanish sentence full of
 * English words could come out in the English voice). Qwen (Spanish, once loaded) or Kokoro
 * directly, without the shared queue (each sidecar answers one request at a time anyway); the
 * rest of the chain when neither can.
 */
export async function synthesizeForced(
  text: string,
  lang: 'es' | 'en' | string,
  signal?: AbortSignal,
  kokoro: ResidentKokoro | null = residentKokoro(),
  qwen: ResidentQwen | null = residentQwen()
): Promise<SpeechResult> {
  const spoken = cleanForSpeech(text).slice(0, MAX_TTS_CHARS);
  const speechLang = normalizeSpeechLanguage(lang) ?? 'es';
  const engines = availableEngines(speechLang);
  const result = (audio: Buffer, engine: TtsEngineName): SpeechResult => ({
    audio,
    contentType: 'audio/wav',
    engine,
    lang: speechLang,
  });
  const qwenFirst = qwen && engines[0] === 'qwen';
  if (qwenFirst) {
    const audio = await readResident((out) => qwen.synthesize(spoken, out, signal));
    if (audio) return result(audio, 'qwen');
    if (signal?.aborted) throw new Error('aborted');
  }
  const voice = KOKORO_VOICES[speechLang];
  const kokoroNext = kokoro && voice && engines.find((e) => e !== 'qwen') === 'kokoro';
  if (kokoroNext) {
    const audio = await readResident((out) =>
      kokoro.synthesize(spoken, voice.voice, voice.lang, out, signal)
    );
    if (audio) return result(audio, 'kokoro');
    if (signal?.aborted) throw new Error('aborted');
  }
  // Neither resident engine answered: the rest of the chain, without trying them again.
  return synthesize(
    spoken,
    speechLang,
    signal,
    execFileAsync,
    kokoroNext ? null : kokoro,
    qwenFirst ? null : qwen
  );
}
