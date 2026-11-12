/**
 * Untether's public event log (2026-11-08, idea from Herdr's events.subscribe): what scripts
 * and outside tools can hook on, like "task X needs you" or "session Y is waiting". Orchestrators
 * get notes and digests; nothing else could follow those moments without scraping.
 *
 * - Durable and append-only: JSONL segments in `<controlDir>/events/`, one event per line,
 *   each with an id one above the last one (monotonic across restarts: read back at start).
 * - Rotated: a segment closes at `segmentBytes` or once a day; closed segments go after
 *   `retentionDays` or past `totalBytes`. The newest segment always stays, so the last id
 *   is never lost.
 * - No secrets (redactSecrets on every text), no prompt content: only the fields listed in
 *   EVENT_FIELDS are kept, texts cut to EVENT_TEXT_MAX.
 * - Read by id (`after`) with type and project filters; a reader that resumes from its
 *   `cursor` sees every event once, in order. `gap` tells it events it asked for were rotated
 *   away; `reset` that the log started over (its folder was removed).
 */
import * as fs from 'fs';
import * as path from 'path';
import { redactSecrets } from './security-sweep.js';

/** The kinds of event, by family: a filter `task` takes every `task.*`. */
export const EVENT_TYPES = [
  'task.state',
  'session.state',
  'doctor.finding',
  'doctor.cleared',
  'push',
] as const;
export type UntetherEventType = (typeof EVENT_TYPES)[number];
export const EVENT_FAMILIES = ['task', 'session', 'doctor', 'push'] as const;

/** The fields an event may carry besides id, at and type; anything else is dropped. */
const EVENT_FIELDS = [
  'project',
  'dir',
  'taskId',
  'sessionId',
  'branch',
  'agent',
  'name',
  'state',
  'from',
  'reason',
  'message',
  'background',
  'severity',
  'key',
  'check',
  'healed',
  'pushType',
  'title',
] as const;
type EventField = (typeof EVENT_FIELDS)[number];

export type EventInput = { type: UntetherEventType } & Partial<
  Record<EventField, string | boolean | undefined>
>;

export interface UntetherEvent {
  id: number;
  /** ISO time it was recorded. */
  at: string;
  type: UntetherEventType;
  [field: string]: string | number | boolean;
}

export interface EventQuery {
  /** Events with an id above this one (0: from the oldest kept). */
  after?: number;
  /** Types or families (`task`, `session.state`); none: all. */
  types?: string[];
  /** A project folder: its tasks, and sessions in it or below it. */
  project?: string;
  limit?: number;
}

export interface EventPage {
  events: UntetherEvent[];
  /** Where to resume: the next read with `after: cursor` misses nothing and repeats nothing. */
  cursor: number;
  /** The newest id in the log (0: none yet). */
  lastId: number;
  /** The oldest id still kept (0: none). */
  oldestId: number;
  /** Events after `after` were rotated away before they were read. */
  gap: boolean;
  /** `after` is beyond the log: it started over; read from its start. */
  reset: boolean;
}

export const EVENT_TEXT_MAX = 300;
export const EVENT_PAGE_MAX = 1000;
const DEFAULT_PAGE = 500;
const CACHE_MAX = 2000;
const SEGMENT = /^events-(\d{12})\.jsonl$/;
export const SESSION_STATES_FILE = 'session-states.json';
const SESSION_STATES_MAX = 2000;

export interface EventLogOptions {
  dir: string;
  /** A segment closes past this size (default 4 MB). */
  segmentBytes?: number;
  /** A segment closes once its first event is this old (default a day). */
  segmentMaxAgeMs?: number;
  /** Closed segments older than this go (default 14 days). */
  retentionDays?: number;
  /** All segments together stay under this (default 64 MB; the newest always stays). */
  totalBytes?: number;
  now?: () => number;
  onError?: (message: string) => void;
}

/** A project path compared as given, without a trailing slash. */
function normalizeDir(dir: string): string {
  const resolved = path.resolve(dir);
  return resolved.length > 1 ? resolved.replace(/\/+$/, '') : resolved;
}

function within(dir: unknown, project: string): boolean {
  if (typeof dir !== 'string' || !dir) return false;
  const value = normalizeDir(dir);
  return value === project || value.startsWith(`${project}/`);
}

/** Whether an event passes a query's filters (not its `after`). */
export function eventMatches(
  event: UntetherEvent,
  query: Pick<EventQuery, 'types' | 'project'>
): boolean {
  if (query.types?.length) {
    const ok = query.types.some((t) => event.type === t || event.type.startsWith(`${t}.`));
    if (!ok) return false;
  }
  if (query.project) {
    const project = normalizeDir(query.project);
    if (!within(event.project, project) && !within(event.dir, project)) return false;
  }
  return true;
}

/** Only known fields, every text redacted and cut. */
export function sanitizeEvent(input: EventInput): Omit<UntetherEvent, 'id' | 'at'> {
  const out: Record<string, string | boolean> = { type: input.type };
  for (const field of EVENT_FIELDS) {
    const value = input[field];
    if (value === undefined || value === '') continue;
    if (typeof value === 'boolean') out[field] = value;
    else if (typeof value === 'string') {
      const clean = redactSecrets(value.replace(/\s+/g, ' ').trim());
      out[field] = clean.length > EVENT_TEXT_MAX ? `${clean.slice(0, EVENT_TEXT_MAX - 1)}…` : clean;
    }
  }
  return out as Omit<UntetherEvent, 'id' | 'at'>;
}

function parseLine(line: string): UntetherEvent | null {
  if (!line) return null;
  try {
    const event = JSON.parse(line) as UntetherEvent;
    return Number.isSafeInteger(event.id) && event.id > 0 && typeof event.type === 'string'
      ? event
      : null;
  } catch {
    return null;
  }
}

interface Segment {
  file: string;
  firstId: number;
}

export class EventLog {
  private readonly dir: string;
  private readonly segmentBytes: number;
  private readonly segmentMaxAgeMs: number;
  private readonly retentionMs: number;
  private readonly totalBytes: number;
  private readonly now: () => number;
  private readonly onError: (message: string) => void;
  private lastId = 0;
  private active: { file: string; bytes: number; firstAt: number } | null = null;
  /** The newest events, in order: most reads (followers) never touch the disk. */
  private cache: UntetherEvent[] = [];
  private readonly listeners = new Set<(event: UntetherEvent) => void>();
  /**
   * Each live session's last session.state event, as written (exited ones drop out). Kept on
   * disk (SESSION_STATES_FILE) and caught up from the segments at start, so what was last told
   * of a session is known after a restart however long ago it was (2026-11-08 review: read from
   * the newest events only, an older state was told again).
   */
  private readonly sessionStates = new Map<string, UntetherEvent>();

  constructor(options: EventLogOptions) {
    this.dir = options.dir;
    this.segmentBytes = options.segmentBytes ?? 4 * 1024 * 1024;
    this.segmentMaxAgeMs = options.segmentMaxAgeMs ?? 24 * 60 * 60_000;
    this.retentionMs = (options.retentionDays ?? 14) * 24 * 60 * 60_000;
    this.totalBytes = options.totalBytes ?? 64 * 1024 * 1024;
    this.now = options.now ?? Date.now;
    this.onError = options.onError ?? (() => {});
    this.load();
    this.loadSessionStates();
  }

  /** The newest id recorded (0: none). */
  get last(): number {
    return this.lastId;
  }

  /**
   * Records one event; returns it as stored, or null when it could not be written (reported,
   * never thrown). A failed write is not an event: its id is not used, readers never see it
   * (2026-11-08 review: published but lost on restart, its id was given again to another).
   */
  record(input: EventInput): UntetherEvent | null {
    const at = this.now();
    const event = {
      id: this.lastId + 1,
      at: new Date(at).toISOString(),
      ...sanitizeEvent(input),
    } as UntetherEvent;
    try {
      this.write(event, `${JSON.stringify(event)}\n`, at);
    } catch (error) {
      this.onError(`event ${input.type} not recorded: ${String(error)}`);
      return null;
    }
    this.lastId = event.id;
    if (event.type === 'session.state') this.noteSessionState(event, true);
    this.cache.push(event);
    if (this.cache.length > CACHE_MAX) this.cache.splice(0, this.cache.length - CACHE_MAX);
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.onError(`event listener failed: ${String(error)}`);
      }
    }
    return event;
  }

  /** The last session.state event written for a session still alive (none once exited). */
  latestSessionState(sessionId: string): UntetherEvent | undefined {
    return this.sessionStates.get(sessionId);
  }

  /** Called with every event recorded from now on; returns the unsubscribe. */
  subscribe(listener: (event: UntetherEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  read(query: EventQuery = {}): EventPage {
    const limit = Math.min(Math.max(1, Math.floor(query.limit ?? DEFAULT_PAGE)), EVENT_PAGE_MAX);
    let after = Math.max(0, Math.floor(query.after ?? 0));
    const segments = this.segments();
    // A segment is named after its first event's id.
    const oldestId = segments[0]?.firstId ?? 0;
    const reset = after > this.lastId;
    if (reset) after = 0;
    const gap = !reset && oldestId > 0 && after < oldestId - 1 && after > 0;
    const events: UntetherEvent[] = [];
    let cursor = Math.max(after, gap ? oldestId - 1 : after);
    const take = (event: UntetherEvent): boolean => {
      if (event.id <= after) return true;
      if (!eventMatches(event, query)) {
        cursor = event.id;
        return true;
      }
      events.push(event);
      cursor = event.id;
      return events.length < limit;
    };
    const cached = this.cache.length && after >= this.cache[0].id - 1;
    if (cached) {
      for (const event of this.cache) if (!take(event)) break;
    } else {
      outer: for (let i = 0; i < segments.length; i++) {
        const next = segments[i + 1];
        if (next && next.firstId - 1 <= after) continue;
        for (const line of this.readLines(segments[i].file)) {
          const event = parseLine(line);
          if (event && !take(event)) break outer;
        }
      }
    }
    // Everything up to the newest id was looked at: resume past it.
    if (events.length < limit) cursor = Math.max(cursor, this.lastId);
    return { events, cursor, lastId: this.lastId, oldestId, gap, reset };
  }

  /**
   * read(), and when nothing matches yet, waits up to `timeoutMs` for an event that does (a
   * long poll: `ut events --follow` over the API socket).
   */
  async wait(query: EventQuery, timeoutMs: number): Promise<EventPage> {
    const first = this.read(query);
    if (first.events.length || first.reset || timeoutMs <= 0) return first;
    await new Promise<void>((resolve) => {
      let off = () => {};
      const timer = setTimeout(() => done(), timeoutMs);
      const done = () => {
        clearTimeout(timer);
        off();
        resolve();
      };
      off = this.subscribe((event) => {
        if (eventMatches(event, query)) done();
      });
    });
    return this.read({ ...query, after: first.cursor });
  }

  private noteSessionState(event: UntetherEvent, save: boolean): void {
    const id = event.sessionId;
    if (typeof id !== 'string') return;
    this.sessionStates.delete(id);
    if (event.state !== 'exited') this.sessionStates.set(id, event);
    // Sessions that ended while the server was down never say exited: the oldest go.
    while (this.sessionStates.size > SESSION_STATES_MAX) {
      this.sessionStates.delete(this.sessionStates.keys().next().value as string);
    }
    if (save) this.saveSessionStates();
  }

  /** Written whole (temporary file, then renamed); a failure only makes the next start replay more. */
  private saveSessionStates(): void {
    const file = path.join(this.dir, SESSION_STATES_FILE);
    const body = JSON.stringify({ upTo: this.lastId, states: [...this.sessionStates.values()] });
    try {
      fs.writeFileSync(`${file}.tmp`, body, { mode: 0o600 });
      fs.renameSync(`${file}.tmp`, file);
    } catch (error) {
      this.onError(`session states not saved: ${String(error)}`);
    }
  }

  /** The saved states, then every session.state event written after them (a crash between). */
  private loadSessionStates(): void {
    let upTo = 0;
    try {
      const saved = JSON.parse(
        fs.readFileSync(path.join(this.dir, SESSION_STATES_FILE), 'utf8')
      ) as { upTo?: unknown; states?: unknown };
      // Past the log's last id: the log started over without it; it says nothing then.
      if (
        Number.isSafeInteger(saved.upTo) &&
        (saved.upTo as number) <= this.lastId &&
        Array.isArray(saved.states)
      ) {
        upTo = saved.upTo as number;
        for (const state of saved.states as UntetherEvent[]) {
          if (state && state.type === 'session.state') this.noteSessionState(state, false);
        }
      }
    } catch {
      // none yet, or unreadable: everything kept is replayed
    }
    if (upTo >= this.lastId) return;
    const segments = this.segments();
    for (let i = 0; i < segments.length; i++) {
      const next = segments[i + 1];
      if (next && next.firstId - 1 <= upTo) continue;
      for (const line of this.readLines(segments[i].file)) {
        const event = parseLine(line);
        if (event && event.id > upTo && event.type === 'session.state') {
          this.noteSessionState(event, false);
        }
      }
    }
    this.saveSessionStates();
  }

  private segments(): Segment[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return [];
    }
    return names
      .flatMap((name) => {
        const match = SEGMENT.exec(name);
        return match ? [{ file: path.join(this.dir, name), firstId: Number(match[1]) }] : [];
      })
      .sort((a, b) => a.firstId - b.firstId);
  }

  private readLines(file: string): string[] {
    try {
      return fs.readFileSync(file, 'utf8').split('\n');
    } catch {
      return [];
    }
  }

  /** The last id and the newest events back from disk; a line cut by a crash is dropped. */
  private load(): void {
    const segments = this.segments();
    const newest = segments[segments.length - 1];
    if (!newest) return;
    this.lastId = newest.firstId - 1;
    let text: string;
    try {
      text = fs.readFileSync(newest.file, 'utf8');
    } catch (error) {
      this.onError(`event log unreadable: ${String(error)}`);
      return;
    }
    // A write cut mid-line (a crash): keep up to the last whole line, or the next append
    // would glue onto it.
    if (text && !text.endsWith('\n')) {
      const end = text.lastIndexOf('\n') + 1;
      text = text.slice(0, end);
      try {
        fs.truncateSync(newest.file, Buffer.byteLength(text));
      } catch (error) {
        this.onError(`event log cut line not dropped: ${String(error)}`);
      }
    }
    const events = text.split('\n').flatMap((line) => parseLine(line) ?? []);
    const lastEvent = events[events.length - 1];
    if (lastEvent) this.lastId = Math.max(this.lastId, lastEvent.id);
    this.cache = events.slice(-CACHE_MAX);
    const firstAt = events[0] ? Date.parse(events[0].at) : this.now();
    this.active = {
      file: newest.file,
      bytes: Buffer.byteLength(text),
      firstAt: Number.isFinite(firstAt) ? firstAt : this.now(),
    };
    this.prune(segments);
  }

  private write(event: UntetherEvent, line: string, at: number): void {
    const bytes = Buffer.byteLength(line);
    let target = this.active;
    if (
      !target ||
      (target.bytes > 0 &&
        (target.bytes + bytes > this.segmentBytes || at - target.firstAt >= this.segmentMaxAgeMs))
    ) {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const name = `events-${String(event.id).padStart(12, '0')}.jsonl`;
      target = { file: path.join(this.dir, name), bytes: 0, firstAt: at };
    }
    try {
      fs.appendFileSync(target.file, line, { mode: 0o600 });
    } catch (error) {
      // A part written (a full disk) would glue the next event onto it: back to before.
      try {
        if (target.bytes > 0) fs.truncateSync(target.file, target.bytes);
        else fs.rmSync(target.file, { force: true });
      } catch {
        // nothing was written, or it can't be touched at all
      }
      throw error;
    }
    const opened = target !== this.active;
    target.bytes += bytes;
    this.active = target;
    if (opened) this.prune(this.segments());
  }

  /** Closed segments past their days or over the total size go, oldest first. */
  private prune(segments: Segment[]): void {
    const closed = segments.filter((segment) => segment.file !== this.active?.file);
    const sized = closed.map((segment) => {
      try {
        const stat = fs.statSync(segment.file);
        return { ...segment, bytes: stat.size, mtime: stat.mtimeMs };
      } catch {
        return { ...segment, bytes: 0, mtime: 0 };
      }
    });
    let total = sized.reduce((sum, s) => sum + s.bytes, 0) + (this.active?.bytes ?? 0);
    const cutoff = this.now() - this.retentionMs;
    for (const segment of sized) {
      if (segment.mtime >= cutoff && total <= this.totalBytes) continue;
      try {
        fs.unlinkSync(segment.file);
        total -= segment.bytes;
      } catch (error) {
        this.onError(`old event segment not removed: ${String(error)}`);
      }
    }
  }
}

/** A long poll waits at most this long (the API socket's request timeout is 15 s). */
export const EVENT_WAIT_MAX_MS = 10_000;

export class EventQueryError extends Error {}

/**
 * A query from the CLI's args or a URL's: after, types (list or comma text), project, limit,
 * wait (ms). Bad values are an EventQueryError; `project` resolves to its repository.
 */
export async function parseEventQuery(
  input: Record<string, unknown>,
  resolveProject: (dir: string) => Promise<string | null>
): Promise<EventQuery & { wait: number }> {
  const whole = (name: string, value: unknown, max: number): number | undefined => {
    if (value === undefined || value === '') return undefined;
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isSafeInteger(n) || n < 0 || n > max) {
      throw new EventQueryError(`${name} must be a whole number from 0 to ${max}`);
    }
    return n;
  };
  const rawTypes = input.types;
  const types = (
    Array.isArray(rawTypes) ? rawTypes : typeof rawTypes === 'string' ? rawTypes.split(',') : []
  )
    .map((t) => String(t).trim())
    .filter(Boolean);
  const known = new Set<string>([...EVENT_TYPES, ...EVENT_FAMILIES]);
  const unknown = types.filter((t) => !known.has(t));
  if (unknown.length) {
    throw new EventQueryError(
      `unknown event type ${unknown.join(', ')} (known: ${[...EVENT_FAMILIES, ...EVENT_TYPES].join(', ')})`
    );
  }
  let project: string | undefined;
  if (input.project !== undefined && input.project !== '') {
    if (typeof input.project !== 'string' || !path.isAbsolute(input.project)) {
      throw new EventQueryError('project must be an absolute folder');
    }
    project = (await resolveProject(input.project)) ?? input.project;
  }
  const after = whole('after', input.after, Number.MAX_SAFE_INTEGER);
  const limit = whole('limit', input.limit, EVENT_PAGE_MAX);
  return {
    ...(after !== undefined ? { after } : {}),
    ...(types.length ? { types } : {}),
    ...(project ? { project } : {}),
    ...(limit ? { limit } : {}),
    wait: whole('wait', input.wait, EVENT_WAIT_MAX_MS) ?? 0,
  };
}
