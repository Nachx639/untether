/**
 * `ut events`: the public event log (services/event-log.ts) through the API socket.
 * It prints the events after an id and, at the end, the id to resume from; `--follow` keeps
 * long-polling (server restarts included) until interrupted, then prints that id too.
 */
import * as path from 'path';
import type { TaskResponse } from './pty/socket-protocol.js';
import type { EventPage, UntetherEvent } from './services/event-log.js';

export const EVENTS_CLI_HELP = `Usage:
  ut events [--follow] [--after ID] [--type T[,T…]] [--project DIR] [--limit N] [--json]

Untether's event log: task states (with why), agent sessions (busy, waiting, idle, exited),
the doctor's findings, pushes. Every event has an id, one above the last one.
  --after ID     only events after this id (default: from the oldest kept)
  --follow       keep printing new events until Ctrl-C
  --type T       task, session, doctor, push, or a full type (task.state, session.state,
                 doctor.finding, doctor.cleared); several with commas or the flag again
  --project DIR  one project: its tasks, and the sessions in its folder
  --limit N      at most N events (without --follow; default 500, at most 1000)
  --json         one JSON object per line (for jq and scripts)
At the end it prints "resume: ut events --after ID" on stderr; scripts read it with --json too.`;

/** How long each long poll waits on the server for news. */
export const FOLLOW_WAIT_MS = 10_000;
/** `--follow` gives up after the server is unavailable this long in a row. */
export const FOLLOW_OUTAGE_MS = 300_000;

export interface EventsCliDeps {
  task: (op: string, args: Record<string, unknown>) => Promise<TaskResponse>;
  cwd: string;
  out: (text: string) => void;
  err: (text: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Resolves when the user interrupts (Ctrl-C): --follow stops there. */
  interrupted?: Promise<void>;
}

const VALUE_FLAGS = new Set(['after', 'type', 'project', 'limit']);
const SWITCHES = new Set(['follow', 'json']);

class UsageError extends Error {}

/** --after/--type/--project/--limit take a value (also as --flag=value; --type repeats). */
export function parseEventsArgs(argv: string[]): {
  switches: Set<string>;
  values: Map<string, string[]>;
} {
  const switches = new Set<string>();
  const values = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new UsageError(`unexpected ${arg}`);
    const eq = arg.indexOf('=');
    const name = eq > 0 ? arg.slice(2, eq) : arg.slice(2);
    if (SWITCHES.has(name) && eq < 0) {
      switches.add(name);
      continue;
    }
    if (!VALUE_FLAGS.has(name)) throw new UsageError(`unknown option ${arg}`);
    const value = eq > 0 ? arg.slice(eq + 1) : argv[++i];
    if (value === undefined || value === '') throw new UsageError(`--${name} needs a value`);
    values.set(name, [...(values.get(name) ?? []), value]);
  }
  return { switches, values };
}

const DETAIL_FIELDS = ['reason', 'message', 'severity', 'check', 'healed', 'pushType', 'title'];

/** One line: "#12 10:04:01 task.state needs_you ← working · ut/foo · permission: …". */
export function formatEvent(event: UntetherEvent): string {
  const time = event.at.slice(11, 19);
  const parts = [`#${event.id}`, time, event.type];
  if (event.state) parts.push(event.from ? `${event.state} ← ${event.from}` : String(event.state));
  const who = event.branch ?? event.name ?? event.key ?? event.taskId ?? event.sessionId;
  const where = event.project ?? event.dir;
  const tail: string[] = [];
  if (who) tail.push(String(who));
  if (where) tail.push(path.basename(String(where)));
  const details = DETAIL_FIELDS.flatMap((field) =>
    event[field] === undefined ? [] : [String(event[field])]
  );
  if (event.background) details.push('background work');
  return [parts.join(' '), ...tail, ...(details.length ? [details.join(': ')] : [])].join(' · ');
}

export async function runEventsCli(argv: string[], deps: EventsCliDeps): Promise<number> {
  if (argv[0] === 'help' || argv.includes('--help') || argv.includes('-h')) {
    deps.out(EVENTS_CLI_HELP);
    return 0;
  }
  const bad = (message: string) => {
    deps.err(`Error: ${message}`);
    deps.err("Run 'ut events --help' for usage.");
    return 1;
  };
  let parsed: ReturnType<typeof parseEventsArgs>;
  try {
    parsed = parseEventsArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) return bad(error.message);
    throw error;
  }
  const { switches, values } = parsed;
  const one = (name: string): string | undefined => {
    const list = values.get(name);
    if (list && list.length > 1) throw new UsageError(`--${name} given twice`);
    return list?.[0];
  };
  let afterText: string | undefined;
  let limitText: string | undefined;
  let project: string | undefined;
  try {
    afterText = one('after');
    limitText = one('limit');
    project = one('project');
  } catch (error) {
    if (error instanceof UsageError) return bad(error.message);
    throw error;
  }
  const json = switches.has('json');
  const follow = switches.has('follow');
  const types = (values.get('type') ?? [])
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean);
  let after = afterText === undefined ? 0 : Number(afterText);
  if (!Number.isSafeInteger(after) || after < 0) return bad('--after needs a whole number');
  const limit = limitText === undefined ? undefined : Number(limitText);
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
    return bad('--limit needs a whole number above 0');
  }
  if (follow && limit !== undefined) return bad('--limit does not go with --follow');
  const args: Record<string, unknown> = {
    ...(types.length ? { types } : {}),
    ...(project ? { project: path.resolve(deps.cwd, project) } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
  const print = (page: EventPage) => {
    if (page.reset) {
      deps.err(`Note: the event log started over (its last id is ${page.lastId}); from its start.`);
    }
    if (page.gap) {
      deps.err(`Note: events after ${after} up to ${page.oldestId - 1} were rotated away.`);
    }
    for (const event of page.events) deps.out(json ? JSON.stringify(event) : formatEvent(event));
    after = page.cursor;
  };
  const resume = () => deps.err(`resume: ut events --after ${after}`);
  const ask = async (wait: number): Promise<EventPage | number> => {
    const response = await deps.task('events', { ...args, after, wait });
    if (!response.ok) {
      deps.err(`Error: ${response.message}`);
      return 1;
    }
    if (response.status !== 'done') {
      deps.err('Error: unexpected answer from the server');
      return 1;
    }
    return response.data as unknown as EventPage;
  };

  if (!follow) {
    const page = await ask(0);
    if (typeof page === 'number') return page;
    print(page);
    resume();
    return 0;
  }

  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  let stop = false;
  void deps.interrupted?.then(() => {
    stop = true;
  });
  const stopped = deps.interrupted?.then(() => 'stopped' as const);
  let outageSince: number | undefined;
  let toldOutage = false;
  while (!stop) {
    let page: EventPage | number;
    try {
      const asked = ask(FOLLOW_WAIT_MS);
      const first = stopped ? await Promise.race([asked, stopped]) : await asked;
      if (first === 'stopped') break;
      page = first;
      outageSince = undefined;
      toldOutage = false;
    } catch (error) {
      // A restart of the server: the log is on disk, so we go on from the same id.
      outageSince ??= now();
      if (now() - outageSince >= FOLLOW_OUTAGE_MS) {
        resume();
        throw error;
      }
      if (!toldOutage) {
        toldOutage = true;
        deps.err(
          `Untether server unavailable (${error instanceof Error ? error.message : String(error)}); still following...`
        );
      }
      await sleep(1000);
      continue;
    }
    if (typeof page === 'number') {
      resume();
      return page;
    }
    print(page);
  }
  resume();
  return 0;
}
