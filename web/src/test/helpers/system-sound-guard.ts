/**
 * Tests never make the Mac play a sound: this watches for the macOS alert sound (NSBeep) from
 * the processes a test run started, and the run fails naming the test and the process.
 *
 * 2026-11-03, user report: an alert sound every so often at night. The macOS log showed
 * Playwright's WebKit (ms-playwright/webkit-*\/Playwright.app) asking systemsoundserverd for a
 * sound right then: WebKit beeps when an editing command has nothing to act on (Cmd+C with
 * nothing selected in terminal-copy.browser.ts, run by every task check; an editing shortcut
 * with no editable element focused). Watched by every vitest run (global-setup.ts, with the
 * test of each worker from setup.ts), the Playwright suite (system-sound-reporter.ts) and
 * terminal-copy.browser.ts (by step).
 *
 * How: `log stream` shows systemsoundserverd's "Incoming Request : …, inClientPID 56123
 * (Playwright), …" for every sound it is asked to play (even with the Mac muted), and the
 * client's own "activating connection … name=com.apple.audio.SystemSoundServer-OSX" in case
 * the server's wording changes. A sound counts when its process descends from this run's root
 * process, by its chain of parents (the browser runs in a process group of its own, and other
 * worktrees run browser tests at the same time: their sounds are not this run's). Not on macOS,
 * or without /usr/bin/log (in zsh, `log` is a builtin), nothing is watched.
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface SystemSound {
  /** When the log saw it (ms since the epoch). */
  at: number;
  pid: number;
  process: string;
  /** The process and its parents up to (not including) the run's root, nearest first. */
  chain: Array<{ pid: number; name: string }>;
}

export interface SystemSoundGuard {
  /** False when the log cannot be read (not macOS, no `log`): nothing is watched. */
  readonly watching: boolean;
  /** What runs from now on, for the report (a test, a step). */
  mark(label: string): void;
  /** The sounds seen so far (waits for the log to deliver the last ones first). */
  sounds(): Promise<SystemSound[]>;
  /** Stops watching; returns every sound seen. */
  stop(): Promise<SystemSound[]>;
  /** One line per sound with its process chain and what was running then; '' for none. */
  describe(sounds: SystemSound[]): string;
}

const LOG = '/usr/bin/log';
const PREDICATE =
  '(process == "systemsoundserverd" AND eventMessage CONTAINS "Incoming Request") OR ' +
  '(process != "systemsoundserverd" AND eventMessage CONTAINS "SystemSoundServer")';
// The log can lag a little behind the sound.
const FLUSH_MS = 600;
const PID_POLL_MS = 400;
// One sound shows as the client's connection and the server's request: one per process in 2 s.
const SAME_SOUND_MS = 2000;

/** "2026-11-03 01:25:55.733786+0100" (log's ndjson) → ms since the epoch. */
export function parseLogTimestamp(value: string): number {
  const m = value.match(/^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)(\.\d{1,3})?\d*([+-]\d\d)(\d\d)$/);
  if (!m) return Number.NaN;
  return Date.parse(`${m[1]}T${m[2]}${m[3] ?? ''}${m[4]}:${m[5]}`);
}

export interface ProcessInfo {
  ppid: number;
  name: string;
}

/**
 * The chain from `pid` up to `root` (not included), nearest first; null when `pid` does not
 * descend from `root`.
 */
export function chainTo(
  pid: number,
  root: number,
  table: ReadonlyMap<number, ProcessInfo>
): SystemSound['chain'] | null {
  const chain: SystemSound['chain'] = [];
  let at = pid;
  for (let step = 0; step < 64; step++) {
    if (at === root) return chain;
    const info = table.get(at);
    if (!info || at <= 1) return null;
    chain.push({ pid: at, name: info.name });
    at = info.ppid;
  }
  return null;
}

function readProcessTable(into: Map<number, ProcessInfo>): void {
  let out: string;
  try {
    out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,comm='], { encoding: 'utf8' });
  } catch {
    return;
  }
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*?)\s*$/);
    if (m) into.set(Number(m[1]), { ppid: Number(m[2]), name: path.basename(m[3]) });
  }
}

/** A sound some process asked for, from one ndjson line of `log stream` (chain still empty). */
export function soundFromLogLine(line: string): SystemSound | null {
  let entry: {
    eventMessage?: unknown;
    timestamp?: unknown;
    processID?: unknown;
    processImagePath?: unknown;
  };
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof entry.eventMessage !== 'string' || typeof entry.timestamp !== 'string') return null;
  const at = parseLogTimestamp(entry.timestamp);
  const request = entry.eventMessage.match(/Incoming Request\b.*?\binClientPID (\d+)\(([^)]*)\)/);
  if (request) return { at, pid: Number(request[1]), process: request[2], chain: [] };
  const image = typeof entry.processImagePath === 'string' ? entry.processImagePath : '';
  if (
    /SystemSoundServer/.test(entry.eventMessage) &&
    typeof entry.processID === 'number' &&
    path.basename(image) !== 'systemsoundserverd'
  ) {
    return { at, pid: entry.processID, process: path.basename(image) || '?', chain: [] };
  }
  return null;
}

/** The marks: what each process (a vitest worker) was running from when on. */
export interface Mark {
  pid: number;
  at: number;
  label: string;
}

/** What ran when the sound played: the latest mark of the nearest marked process in its chain. */
export function markAt(sound: SystemSound, marks: readonly Mark[]): string | undefined {
  for (const { pid } of sound.chain) {
    const own = marks.filter((m) => m.pid === pid && m.at <= sound.at + 50);
    if (own.length > 0) return own.reduce((a, b) => (b.at >= a.at ? b : a)).label;
  }
  return undefined;
}

/** One line per sound: when, the process chain, and what ran then. */
export function describeSounds(
  sounds: readonly SystemSound[],
  during: (sound: SystemSound) => string | undefined
): string {
  return sounds
    .map((sound) => {
      const chain = sound.chain.map((p) => `${p.name}(${p.pid})`).join(' ← ');
      const what = during(sound);
      return `system alert sound (NSBeep) at ${new Date(sound.at).toISOString()} from ${chain || `${sound.process}(${sound.pid})`}${what ? `, during "${what}"` : ''}`;
    })
    .join('\n');
}

// --- Marks across processes (vitest: the workers write, the main process reads) -------------

/** Where vitest's workers write what they run (set by global-setup.ts). */
export const MARKS_ENV = 'UNTETHER_TEST_SOUND_MARKS';

/** Appends "this process runs `label` from now on" to the run's marks file, if any. */
export function writeMark(label: string): void {
  const file = process.env[MARKS_ENV];
  if (!file) return;
  try {
    fs.appendFileSync(file, `${process.pid}\t${Date.now()}\t${label.replace(/[\t\n]/g, ' ')}\n`);
  } catch {
    // The report only names the test less precisely.
  }
}

export function readMarks(file: string): Mark[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  return text.split('\n').flatMap((line) => {
    const [pid, at, label] = line.split('\t');
    return label ? [{ pid: Number(pid), at: Number(at), label }] : [];
  });
}

// --- The watcher ---------------------------------------------------------------------------

const idle: SystemSoundGuard = {
  watching: false,
  mark() {},
  sounds: async () => [],
  stop: async () => [],
  describe: () => '',
};

export async function watchSystemSounds(
  options: {
    /** The run's process: sounds count from it and its descendants (default: this process). */
    root?: number;
    /** A command printing log lines instead of `log stream` (the guard's own test). */
    source?: string[];
  } = {}
): Promise<SystemSoundGuard> {
  const source = options.source ?? [LOG, 'stream', '--style', 'ndjson', '--predicate', PREDICATE];
  if (!options.source && (process.platform !== 'darwin' || !fs.existsSync(LOG))) return idle;
  const root = options.root ?? process.pid;
  // Every process seen during the run, dead ones included: a browser that beeped and closed
  // before the sound arrived is still traced to its test.
  const table = new Map<number, ProcessInfo>();
  const refresh = () => readProcessTable(table);
  const marks: Mark[] = [];
  const seen: SystemSound[] = [];
  const pending: SystemSound[] = [];
  const last = new Map<number, number>();
  const take = (sound: SystemSound): boolean => {
    const chain = chainTo(sound.pid, root, table);
    if (!chain) return false;
    sound.chain = chain;
    const before = last.get(sound.pid);
    last.set(sound.pid, sound.at);
    if (before === undefined || Math.abs(sound.at - before) > SAME_SOUND_MS) seen.push(sound);
    return true;
  };

  let child: ChildProcess;
  try {
    // The source dies with this process even on SIGKILL: a shell watches it (2026-11-03: in
    // bakery a check killed with KILL left its `log stream` running).
    child = spawn(
      '/bin/sh',
      [
        '-c',
        '"$@" & c=$!; trap \'kill $c 2>/dev/null; exit 0\' TERM INT; ' +
          'while kill -0 "$P" 2>/dev/null && kill -0 $c 2>/dev/null; do sleep 1; done; kill $c 2>/dev/null',
        'sound-guard',
        ...source,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, P: String(process.pid) } }
    );
  } catch {
    return idle;
  }
  const kill = () => child.kill();
  process.once('exit', kill);
  child.unref();
  (child.stdout as NodeJS.ReadableStream & { unref?: () => void }).unref?.();
  (child.stderr as NodeJS.ReadableStream & { unref?: () => void }).unref?.();

  // `log stream` says "Filtering the log data using …" once it is listening.
  const ready = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 5000);
    let buffer = '';
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.startsWith('Filtering the log data')) {
          clearTimeout(timer);
          resolve(true);
        }
        const sound = soundFromLogLine(line);
        if (sound) {
          // At once, while the process most likely still runs.
          refresh();
          if (!take(sound)) pending.push(sound);
        }
        newline = buffer.indexOf('\n');
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('error', () => resolve(false));
    child.once('exit', () => resolve(false));
  });
  if (!ready) {
    kill();
    process.removeListener('exit', kill);
    return idle;
  }

  refresh();
  const poll = setInterval(refresh, PID_POLL_MS);
  poll.unref();
  let stopped = false;

  const settle = async () => {
    await new Promise((resolve) => setTimeout(resolve, FLUSH_MS));
    // A process gone before the sound arrived: the table may have seen it by then.
    for (const sound of pending.splice(0)) if (!take(sound)) pending.push(sound);
    return [...seen].sort((a, b) => a.at - b.at);
  };

  return {
    watching: true,
    mark(label) {
      marks.push({ pid: process.pid, at: Date.now(), label });
    },
    sounds: settle,
    async stop() {
      if (stopped) return [...seen];
      const result = await settle();
      stopped = true;
      clearInterval(poll);
      kill();
      process.removeListener('exit', kill);
      return result;
    },
    describe(sounds) {
      return describeSounds(sounds, (sound) => {
        const before = marks.filter((m) => m.at <= sound.at + 50);
        return before.length > 0 ? before[before.length - 1].label : undefined;
      });
    },
  };
}
