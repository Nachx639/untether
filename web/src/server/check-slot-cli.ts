/**
 * `ut check-slot …`: a place in the Mac's check slots (services/check-slots.ts) for a heavy
 * run Untether does not start itself, through the API socket. The same slots as the merge
 * pipeline's verification runs: at most checkLoad.maxConcurrent heavy runs at once, none while
 * the Mac is over its load threshold.
 *
 *   run -- <command…>   waits its turn, runs the command with this terminal, gives the slot
 *                       back; its exit code is the command's.
 *   acquire             waits its turn and prints the ticket (stdout); nothing printed: no
 *                       slot (the caller runs anyway). For a shell that runs the command
 *                       itself (the task agents' hook, check-slot-wrap.ts): `--pid $$`.
 *   release <ticket>    gives it back (`--exit N`: how its run ended).
 *   status              what runs and what waits.
 *
 * A run that is a check and nothing else (`run` of a test or check command; `acquire
 * --command`) is not made when the same command passed on the very same files before
 * (services/check-results.ts): `run` says so and ends with 0, `acquire` ends with
 * SLOT_REUSED_EXIT. `--fresh` runs it whatever was kept.
 *
 * It never keeps a run from happening: no server, an older server, a wait past the limit
 * (checkLoad.maxSlotWaitSec) or an error of its own, and the command runs without a slot, said
 * on stderr. Inside a run that holds a slot already (UNTETHER_CHECK_SLOT set: a wrapped
 * agent command, a verification run) nothing is asked for.
 */
import type { TaskResponse } from './pty/socket-protocol.js';
import {
  CHECK_SLOT_ENV,
  heavyCheck,
  onlyCheck,
  SLOT_REUSED_EXIT,
} from './services/check-slot-wrap.js';
import type { CheckSlotView } from './services/check-slots.js';
import { quote } from './services/task-output.js';

export const CHECK_SLOT_CLI_HELP = `Usage:
  ut check-slot run [--label TEXT] [--max-wait SEC] [--fresh] -- <command> [args…]
  ut check-slot acquire [--pid PID] [--label TEXT] [--max-wait SEC] [--command TEXT]
  ut check-slot release <ticket> [--exit CODE]
  ut check-slot status [--json]

One heavy check at a time per slot on this Mac (config.json checkLoad.maxConcurrent, by default
one per 6 cores), shared with the checks Untether runs before a merge, and none starts while
the Mac is over its load threshold (checkLoad.maxLoadPerCore).
  run      waits for a slot (it says how many are ahead), runs the command, frees the slot.
           Exit code: the command's. One argument is run with sh -c.
  acquire  waits for a slot and prints its ticket; the caller runs its command and then
           'release <ticket>'. --pid: the process that holds it (default: the caller's
           parent); the slot is freed when that process ends.
  --max-wait SEC  run without a slot after this long (default: checkLoad.maxSlotWaitSec, 1800)
A test or check run whose command passed before on the very same files (same git tree,
uncommitted and new files included, same lockfiles) is not run again: 'run' says
"check: reused, same tree as …" and ends with 0. A failed run is never reused; one byte of
difference and it runs. --fresh runs it whatever was kept.
  --command TEXT  (acquire) the caller runs this check and nothing else: when it passed before
                  on the same files nothing is printed and the exit code is 10 (do not run it);
                  else 'release <ticket> --exit CODE' says how it ended.
A wait cut short (Ctrl-C, a timeout of the caller) keeps its place in line for 15 minutes: the
same command asked again goes back where it was. Without a server the command just runs.`;

/** How often a waiting ticket asks where it stands. */
export const SLOT_POLL_MS = 2_000;
/** The waiting line is said again at least this often. */
export const SLOT_SAY_EVERY_MS = 60_000;
/** A server that stops answering for this long while a ticket waits: the run goes on alone. */
export const SLOT_OUTAGE_MS = 90_000;

export interface CheckSlotCliDeps {
  task: (op: string, args: Record<string, unknown>) => Promise<TaskResponse>;
  env: Record<string, string | undefined>;
  cwd: string;
  /** This process, and its parent (the shell that called `acquire`). */
  pid: number;
  ppid: number;
  out: (text: string) => void;
  err: (text: string) => void;
  /** Runs the command with this terminal; its exit code. */
  spawn: (argv: string[], env: Record<string, string | undefined>) => Promise<number>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Whether the user (or the caller's timeout) interrupted: the wait stops there. */
  interrupted?: () => boolean;
}

class UsageError extends Error {}

const minutes = (ms: number): string => {
  const sec = Math.round(ms / 1000);
  return sec < 90 ? `${sec} s` : `${Math.round(sec / 60)} min`;
};

/** "waiting for a check slot: 2 ahead (2 of 2 running)". */
export function waitingLine(view: CheckSlotView): string {
  if (view.busy) {
    const why = view.busy.memory
      ? `the Mac is short of ${view.busy.memory}`
      : `the Mac's load is ${view.busy.load}, over ${view.busy.threshold}`;
    return `waiting for a check slot: ${why}${view.ahead ? `, ${view.ahead} ahead` : ''}`;
  }
  return `waiting for a check slot: ${view.ahead} ahead (${view.running} of ${view.limit} running)`;
}

type Got =
  | { kind: 'held'; id: string; waitedMs: number }
  /** Not to be run: the same command passed on the same files (when, and how long it took). */
  | { kind: 'reused'; at: number; ms: number; tree: string }
  | { kind: 'inside' }
  | { kind: 'none'; why: string }
  | { kind: 'interrupted' };

/** Asks for a slot and waits for it; never throws. */
export async function waitForSlot(
  deps: CheckSlotCliDeps,
  request: { pid: number; label: string; maxWaitSec?: number; command?: string }
): Promise<Got> {
  if (deps.env[CHECK_SLOT_ENV]) return { kind: 'inside' };
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const started = now();
  const say = (text: string) => deps.err(`[untether] ${text}`);
  const taskId = deps.env.UNTETHER_TASK_ID;
  let since: number | undefined;
  const ask = async (): Promise<CheckSlotView | string> => {
    try {
      const response = await deps.task('check-slot', {
        action: 'acquire',
        pid: request.pid,
        label: request.label,
        cwd: deps.cwd,
        ...(taskId ? { taskId } : {}),
        ...(since !== undefined ? { since } : {}),
        ...(request.command ? { command: request.command } : {}),
      });
      if (!response.ok) return response.message;
      if (response.status !== 'done' || typeof response.data.id !== 'string') {
        return 'the server does not know check slots (older build)';
      }
      const got = response.data as unknown as CheckSlotView;
      // Only a run that said what it is can be told not to run.
      if (got.state === 'reused' && !(request.command && got.reused)) {
        return 'unexpected answer';
      }
      return got;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };
  const giveBack = async (id: string, keepPlace: boolean) => {
    try {
      await deps.task('check-slot', { action: 'release', id, keepPlace });
    } catch {
      // The server frees a waiting ticket nobody asks about.
    }
  };
  let view = await ask();
  if (typeof view === 'string') return { kind: 'none', why: view };
  since = view.since;
  const maxWaitMs = (request.maxWaitSec ?? view.maxWaitSec) * 1000;
  let said = '';
  let saidAt = 0;
  let silentSince: number | undefined;
  while (view.state === 'waiting') {
    if (deps.interrupted?.()) {
      await giveBack(view.id, true);
      return { kind: 'interrupted' };
    }
    const waited = now() - started;
    if (waited >= maxWaitMs) {
      await giveBack(view.id, true);
      return { kind: 'none', why: `still none after ${minutes(waited)}` };
    }
    const line = waitingLine(view);
    if (line !== said || now() - saidAt >= SLOT_SAY_EVERY_MS) {
      say(
        said
          ? `${line} · ${minutes(waited)} so far`
          : `${line}. It starts by itself at its turn; if this call times out first, run the same command again: it keeps its place in line.`
      );
      said = line;
      saidAt = now();
    }
    await sleep(SLOT_POLL_MS);
    let next: CheckSlotView | string;
    try {
      const response = await deps.task('check-slot', { action: 'status', id: view.id });
      if (response.ok && response.status === 'done') {
        next = response.data as unknown as CheckSlotView;
      } else if (!response.ok && response.code === 'not-found') {
        // The server started again (or dropped a silent ticket): back in line, same place.
        next = await ask();
      } else {
        next = response.ok ? 'unexpected answer' : response.message;
      }
    } catch (error) {
      next = error instanceof Error ? error.message : String(error);
    }
    if (typeof next === 'string') {
      silentSince ??= now();
      if (now() - silentSince >= SLOT_OUTAGE_MS) return { kind: 'none', why: next };
      continue;
    }
    silentSince = undefined;
    view = next;
  }
  const waitedMs = now() - started;
  if (view.state === 'reused' && view.reused) return { kind: 'reused', ...view.reused };
  if (said) say(`check slot taken after ${minutes(waitedMs)}`);
  return { kind: 'held', id: view.id, waitedMs };
}

function parse(argv: string[]): {
  flags: Map<string, string | true>;
  positional: string[];
  command: string[];
} {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  const dash = argv.indexOf('--');
  const head = dash >= 0 ? argv.slice(0, dash) : argv;
  for (let i = 0; i < head.length; i++) {
    const arg = head[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq > 0 ? arg.slice(2, eq) : arg.slice(2);
    if (name === 'json' || name === 'fresh') {
      flags.set(name, true);
      continue;
    }
    if (!['label', 'max-wait', 'pid', 'command', 'exit'].includes(name)) {
      throw new UsageError(`unknown option ${arg}`);
    }
    const value = eq > 0 ? arg.slice(eq + 1) : head[++i];
    if (value === undefined || value === '') throw new UsageError(`--${name} needs a value`);
    flags.set(name, value);
  }
  return { flags, positional, command: dash >= 0 ? argv.slice(dash + 1) : [] };
}

export async function runCheckSlotCli(argv: string[], deps: CheckSlotCliDeps): Promise<number> {
  const sub = argv[0];
  if (!sub || sub === 'help' || argv.includes('--help') || argv.includes('-h')) {
    // Only before `--`: `ut check-slot run -- pnpm test --help` is the command's own flag.
    const dash = argv.indexOf('--');
    const own = dash >= 0 ? argv.slice(0, dash) : argv;
    if (!sub || sub === 'help' || own.includes('--help') || own.includes('-h')) {
      deps.out(CHECK_SLOT_CLI_HELP);
      return sub ? 0 : 1;
    }
  }
  let parsed: ReturnType<typeof parse>;
  let maxWaitSec: number | undefined;
  let pid: number | undefined;
  try {
    parsed = parse(argv.slice(1));
    const maxWait = parsed.flags.get('max-wait');
    if (maxWait !== undefined) {
      maxWaitSec = Number(maxWait);
      if (!(maxWaitSec >= 0)) throw new UsageError('--max-wait needs a number of seconds');
    }
    const pidText = parsed.flags.get('pid');
    if (pidText !== undefined) {
      pid = Number(pidText);
      if (!Number.isInteger(pid) || pid <= 1) throw new UsageError('--pid needs a process id');
    }
    if (sub === 'run' && !parsed.command.length) {
      throw new UsageError('ut check-slot run needs a command after --');
    }
    if (sub === 'release' && !parsed.positional.length) return 0; // no ticket: nothing held
    if (!['run', 'acquire', 'release', 'status'].includes(sub)) {
      throw new UsageError(`unknown command: ut check-slot ${sub}`);
    }
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    deps.err(`Error: ${error.message}`);
    deps.err("Run 'ut check-slot --help' for usage.");
    return 1;
  }
  const { flags, positional, command } = parsed;
  const label = typeof flags.get('label') === 'string' ? (flags.get('label') as string) : undefined;

  if (sub === 'status') {
    const response = await deps.task('check-slot', { action: 'list' });
    if (!response.ok || response.status !== 'done') {
      deps.err(`Error: ${response.ok ? 'unexpected answer' : response.message}`);
      return 1;
    }
    if (flags.get('json')) {
      deps.out(JSON.stringify(response.data));
      return 0;
    }
    const data = response.data as {
      running: number;
      limit: number;
      queued: number;
      tickets: Array<{ id: string; pid: number; taskId?: string; label: string; state: string }>;
    };
    deps.out(`Check slots: ${data.running} of ${data.limit} running, ${data.queued} waiting`);
    for (const ticket of data.tickets) {
      deps.out(
        `  ${ticket.state.padEnd(7)} ${ticket.id} pid ${ticket.pid}${ticket.taskId ? ` task ${ticket.taskId.slice(0, 8)}` : ''} · ${ticket.label}`
      );
    }
    return 0;
  }

  if (sub === 'release') {
    // How its run ended: a pass on files that did not change meanwhile is kept.
    const exit = flags.get('exit');
    const exitCode = typeof exit === 'string' && /^\d+$/.test(exit) ? Number(exit) : undefined;
    try {
      await deps.task('check-slot', {
        action: 'release',
        id: positional[0],
        ...(exitCode !== undefined ? { exitCode } : {}),
      });
    } catch {
      // The server frees it when its holder ends.
    }
    return 0;
  }

  // The run is a check and nothing else: `acquire` is told so (--command, the hook's wrap);
  // `run` sees it in a command given as one shell line.
  const asked = flags.get('command');
  let check: string | undefined;
  if (!flags.get('fresh')) {
    if (sub === 'acquire' && typeof asked === 'string') check = asked;
    // As one shell line: the single argument (run with sh -c), or the words quoted.
    const line = command.length === 1 ? command[0] : command.map(quote).join(' ');
    if (sub === 'run' && heavyCheck(line) && onlyCheck(line)) check = line;
  }
  const got = await waitForSlot(deps, {
    pid: pid ?? (sub === 'run' ? deps.pid : deps.ppid),
    label: label ?? (command.length ? command.join(' ') : 'check'),
    ...(maxWaitSec !== undefined ? { maxWaitSec } : {}),
    ...(check ? { command: check } : {}),
  });
  if (got.kind === 'interrupted') return 130;
  if (got.kind === 'reused') {
    const now = (deps.now ?? Date.now)();
    deps.err(
      `[untether] check: reused, same tree as ${new Date(got.at).toISOString()} (${minutes(Math.max(0, now - got.at))} ago; it passed in ${minutes(got.ms)} on these very files, tree ${got.tree.slice(0, 12)}): not run again. To run it anyway: ut check-slot run --fresh -- '<command>'`
    );
    return sub === 'acquire' ? SLOT_REUSED_EXIT : 0;
  }
  if (got.kind === 'none') deps.err(`[untether] no check slot (${got.why}): running without one`);

  if (sub === 'acquire') {
    if (got.kind === 'held') deps.out(got.id);
    return 0;
  }

  const env = got.kind === 'held' ? { ...deps.env, [CHECK_SLOT_ENV]: got.id } : { ...deps.env };
  let exitCode: number | undefined;
  try {
    exitCode = await deps.spawn(
      command.length === 1 ? ['/bin/sh', '-c', command[0]] : command,
      env
    );
    return exitCode;
  } finally {
    if (got.kind === 'held') {
      try {
        await deps.task('check-slot', {
          action: 'release',
          id: got.id,
          ...(exitCode !== undefined ? { exitCode } : {}),
        });
      } catch {
        // Freed when this process ends.
      }
    }
  }
}
