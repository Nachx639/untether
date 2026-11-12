/**
 * Share with phone: the only way the server runs AppleScript. While the Mac's screen is locked
 * an Apple Event to Terminal or iTerm2 hangs with no reply and no error, and a pending
 * Automation prompt blocks it too, so every call is a child process that can be killed:
 *
 * - `/usr/bin/osascript -e <line> … <args>`: the script is fixed text registered with
 *   defineOsascript; values only arrive as `argv`, never interpolated into the script;
 * - an argument starting with `-` or containing NUL is refused, so osascript can't read one as
 *   an option and nothing is cut short;
 * - a hard timeout (5 s) kills the child's whole process group with SIGKILL, then checks the
 *   child is gone, so a hung osascript is never left behind;
 * - one call per terminal app at a time: a second one while the first is pending is refused
 *   (`in-flight`), and the caller treats it as "can't script it right now";
 * - children still running when the runner is disposed, or when the server exits, are killed;
 * - the log names the script, the app, the outcome and the time, never an argument or output.
 */
import { type ChildProcess, spawn } from 'child_process';
import { createLogger } from '../../utils/logger.js';
import { assertRealScanAllowed } from './process-tree.js';

const logger = createLogger('mac-share-osascript');

export const OSASCRIPT_PATH = '/usr/bin/osascript';
export const OSASCRIPT_TIMEOUT_MS = 5000;
/** A tab's visible contents is a few KB; anything this big is not ours to read. */
const MAX_OUTPUT_BYTES = 1024 * 1024;

export interface OsascriptScript {
  readonly name: string;
  readonly lines: readonly string[];
}

const registered = new WeakSet<OsascriptScript>();

/** A script the runner accepts: fixed lines, one `-e` each. */
export function defineOsascript(name: string, lines: readonly string[]): OsascriptScript {
  for (const line of lines) {
    if (/[\0\r\n]/.test(line)) throw new Error(`osascript ${name}: a line can't break`);
  }
  const script = Object.freeze({ name, lines: Object.freeze([...lines]) });
  registered.add(script);
  return script;
}

/**
 * What the trailing `(-NNNN)` of osascript's error says.
 * denied: -1743, the user (or MDM) refused Automation of that app.
 * event-timeout: -1712, the app didn't answer within the script's `with timeout`.
 * not-running: -600. gone: -1728 or -1719, the window, tab or session isn't there any more.
 */
export type OsascriptError = 'denied' | 'event-timeout' | 'not-running' | 'gone' | 'failed';

export type OsascriptOutcome =
  | { kind: 'ok'; stdout: string; pid: number }
  | { kind: 'timeout'; pid: number }
  | { kind: 'error'; error: OsascriptError; code?: number; pid?: number }
  | { kind: 'in-flight' }
  | { kind: 'refused'; why: 'unknown-script' | 'bad-arg' }
  | { kind: 'disposed'; pid?: number };

export function classifyOsascriptError(stderr: string): { error: OsascriptError; code?: number } {
  const match = /\((-?\d+)\)\s*$/.exec(stderr.trim());
  const code = match ? Number(match[1]) : undefined;
  switch (code) {
    case -1743:
      return { error: 'denied', code };
    case -1712:
      return { error: 'event-timeout', code };
    case -600:
      return { error: 'not-running', code };
    case -1728:
    case -1719:
      return { error: 'gone', code };
    default:
      return code === undefined ? { error: 'failed' } : { error: 'failed', code };
  }
}

/** Refuses what osascript could read as an option, and what would be cut at a NUL. */
export function isSafeOsascriptArg(value: unknown): value is string {
  return typeof value === 'string' && !value.startsWith('-') && !value.includes('\0');
}

function isGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/** Every child of every runner, killed if the server exits with them still running. */
const liveChildren = new Set<ChildProcess>();
let exitHookInstalled = false;

function killGroup(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    // Detached: the child leads its own process group, so this reaches anything it started.
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    for (const child of liveChildren) killGroup(child);
  });
}

export interface OsascriptRunnerOptions {
  /** Tests point this at a fake; the real one needs allowRealInTests under vitest. */
  binary?: string;
  timeoutMs?: number;
  allowRealInTests?: boolean;
  /** Where the one-line outcome goes; never given arguments or output. */
  log?: (message: string) => void;
}

export class OsascriptRunner {
  private readonly binary: string;
  private readonly timeoutMs: number;
  private readonly log: (message: string) => void;
  private readonly pending = new Map<string, ChildProcess | null>();
  /** This runner's children, each with how to stop it. */
  private readonly stops = new Map<ChildProcess, () => void>();
  private disposed = false;

  constructor(options: OsascriptRunnerOptions = {}) {
    this.binary = options.binary ?? OSASCRIPT_PATH;
    this.timeoutMs = options.timeoutMs ?? OSASCRIPT_TIMEOUT_MS;
    this.log = options.log ?? ((message) => logger.debug(message));
    if (this.binary === OSASCRIPT_PATH && !options.allowRealInTests) {
      assertRealScanAllowed('osascript');
    }
  }

  /** Calls still running, all apps together. */
  get inFlight(): number {
    return this.stops.size;
  }

  /** Runs `script` against `app` (the key for "one at a time") with `args` as its argv. */
  run(
    app: string,
    script: OsascriptScript,
    args: readonly string[] = []
  ): Promise<OsascriptOutcome> {
    const now = (outcome: OsascriptOutcome) =>
      Promise.resolve(this.done(app, script, Date.now(), outcome));
    if (this.disposed) return now({ kind: 'disposed' });
    if (!registered.has(script)) return now({ kind: 'refused', why: 'unknown-script' });
    if (!args.every(isSafeOsascriptArg)) return now({ kind: 'refused', why: 'bad-arg' });
    if (this.pending.has(app)) return now({ kind: 'in-flight' });
    this.pending.set(app, null);
    const started = Date.now();
    return new Promise<OsascriptOutcome>((resolve) => {
      const argv = script.lines.flatMap((line) => ['-e', line]).concat(args);
      let child: ChildProcess;
      try {
        child = spawn(this.binary, argv, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch {
        this.pending.delete(app);
        resolve(this.done(app, script, started, { kind: 'error', error: 'failed' }));
        return;
      }
      this.pending.set(app, child);
      liveChildren.add(child);
      installExitHook();

      type Ending = 'timeout' | 'overflow' | 'disposed';
      const pid = child.pid ?? -1;
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let size = 0;
      let ending: Ending | undefined;
      let exitCode: number | null | undefined;
      let settled = false;

      const finish = (outcome: OsascriptOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.stops.delete(child);
        liveChildren.delete(child);
        if (this.pending.get(app) === child) this.pending.delete(app);
        resolve(this.done(app, script, started, outcome));
      };
      const ended = (why: Ending) => {
        if (why === 'timeout') finish({ kind: 'timeout', pid });
        else if (why === 'disposed') finish({ kind: 'disposed', pid });
        else finish({ kind: 'error', error: 'failed', pid });
      };
      const stop = (why: Ending) => {
        if (ending || settled) return;
        ending = why;
        killGroup(child);
        // SIGKILL always brings the exit; should it not, answer anyway.
        setTimeout(() => {
          if (settled) return;
          this.log(`osascript ${script.name} ${app}: no exit after SIGKILL`);
          ended(why);
        }, 1000).unref();
      };
      const complete = () => {
        if (exitCode === 0) {
          const text = Buffer.concat(stdout).toString('utf8').replace(/\n$/, '');
          finish({ kind: 'ok', stdout: text, pid });
        } else {
          const text = Buffer.concat(stderr).toString('utf8');
          finish({ kind: 'error', ...classifyOsascriptError(text), pid });
        }
      };
      const collect = (into: Buffer[]) => (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_OUTPUT_BYTES) stop('overflow');
        else into.push(chunk);
      };

      const timer = setTimeout(() => stop('timeout'), this.timeoutMs);
      this.stops.set(child, () => stop('disposed'));
      child.stdout?.on('data', collect(stdout));
      child.stderr?.on('data', collect(stderr));
      child.on('error', () => finish({ kind: 'error', error: 'failed' }));
      child.on('exit', (code) => {
        if (ending) {
          if (!isGone(pid)) this.log(`osascript ${script.name} ${app}: still there after SIGKILL`);
          ended(ending);
          return;
        }
        exitCode = code;
        // 'close' follows once the pipes are drained; a grandchild holding them open must not
        // keep the call waiting.
        setTimeout(complete, 500).unref();
      });
      child.on('close', () => {
        if (!ending && exitCode !== undefined) complete();
      });
    });
  }

  /** Kills every call still running (they answer `disposed`) and refuses new ones. */
  dispose(): void {
    this.disposed = true;
    for (const stop of this.stops.values()) stop();
  }

  private done(
    app: string,
    script: OsascriptScript,
    started: number,
    outcome: OsascriptOutcome
  ): OsascriptOutcome {
    const detail =
      outcome.kind === 'error'
        ? ` ${outcome.error}${outcome.code ? ` (${outcome.code})` : ''}`
        : '';
    this.log(
      `osascript ${script.name} ${app}: ${outcome.kind}${detail} in ${Date.now() - started} ms`
    );
    return outcome;
  }
}
