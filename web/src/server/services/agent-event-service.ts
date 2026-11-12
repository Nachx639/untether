/**
 * Reads the agents' structured events into their state (agent-events.ts): the mailboxes the
 * Claude Code hooks fill (claude-hooks.ts) and the rollouts Codex writes. Read on every look
 * (`snapshot`) and on a short timer (`poll`), so the mailboxes stay small and a state is
 * fresh when the scheduler asks.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  type AgentEvent,
  type AgentSnapshot,
  AgentStateTracker,
  CodexRolloutReader,
  claudeHookEvent,
} from './agent-events.js';
import { HOOK_INPUT_MAX_BYTES } from './claude-hooks.js';

/** Event files read per session and look: a backlog drains over a few looks. */
const MAX_FILES_PER_LOOK = 2000;
/** Rollout bytes read per look; a new rollout is read from its last part only. */
const ROLLOUT_READ_BYTES = 4 * 1024 * 1024;
const ROLLOUT_TAIL_BYTES = 2 * 1024 * 1024;
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
/**
 * Each session's tracked state, next to its mailbox (2026-11-03): a server restart kept nothing,
 * so a Claude busy in one long tool call looked hook-silent to the doctor and the stall clock
 * started over. A dot name: the mailbox reader takes it for no event.
 */
export const AGENT_STATE_FILE = '.state.json';
/** A changed state is written at most this often (and on flush). */
const STATE_WRITE_EVERY_MS = 2000;

interface PersistedState {
  tracked: unknown;
  rollout?: { path: string; offset: number };
}

/** Fields read from an event file cut at 64 KB (a huge tool input): enough for its state. */
function partialHookInput(raw: string, event: string): Record<string, unknown> {
  const field = (name: string) =>
    new RegExp(`"${name}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(raw)?.[1];
  const input: Record<string, unknown> = { hook_event_name: event };
  for (const name of [
    'session_id',
    'tool_name',
    'tool_use_id',
    'notification_type',
    'error',
    'source',
    'trigger',
  ]) {
    const value = field(name);
    if (value !== undefined) input[name] = value;
  }
  return input;
}

interface RolloutFollow {
  path: string;
  offset: number;
  skipPartialLine: boolean;
  reader: CodexRolloutReader;
}

export interface AgentEventServiceOptions {
  /** The Claude hooks' mailboxes (claude-hooks.ts claudeHookFiles().eventsDir). */
  eventsDir: string;
  /** The rollout of a session that runs Codex, or null (not Codex, no rollout yet). */
  codexRollout?: (sessionId: string) => string | null;
  log?: (message: string) => void;
  now?: () => number;
}

export class AgentEventService {
  readonly tracker = new AgentStateTracker();
  private rollouts = new Map<string, RolloutFollow>();
  /** Sessions that got any structured event: their screen is a fallback only. */
  private covered = new Set<string>();
  /** Sessions whose written state was looked for already (once per server run). */
  private loaded = new Set<string>();
  /** Sessions whose state changed since it was last written, and when each was last written. */
  private dirty = new Set<string>();
  private written = new Map<string, number>();

  constructor(private readonly options: AgentEventServiceOptions) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private stateFile(sessionId: string): string {
    return path.join(this.options.eventsDir, sessionId, AGENT_STATE_FILE);
  }

  /** The state this session had before a restart, taken back the first time it is looked at. */
  private load(sessionId: string): void {
    if (this.loaded.has(sessionId)) return;
    this.loaded.add(sessionId);
    let persisted: PersistedState;
    try {
      persisted = JSON.parse(fs.readFileSync(this.stateFile(sessionId), 'utf8')) as PersistedState;
    } catch {
      return; // none written, or unreadable: its events start over
    }
    if (!persisted || !this.tracker.restore(sessionId, persisted.tracked)) return;
    this.covered.add(sessionId);
    const rollout = persisted.rollout;
    if (rollout && typeof rollout.path === 'string' && Number.isFinite(rollout.offset)) {
      // Read on from where the last run stopped, not its tail again.
      this.rollouts.set(sessionId, {
        path: rollout.path,
        offset: rollout.offset,
        skipPartialLine: false,
        reader: new CodexRolloutReader(),
      });
    }
  }

  /** Writes the changed states, each at most every STATE_WRITE_EVERY_MS unless `all`. */
  flush(all = false): void {
    const now = this.now();
    for (const id of this.dirty) {
      if (!all && now - (this.written.get(id) ?? 0) < STATE_WRITE_EVERY_MS) continue;
      const tracked = this.tracker.dump(id);
      this.dirty.delete(id);
      if (!tracked) continue;
      const follow = this.rollouts.get(id);
      const state: PersistedState = {
        tracked,
        ...(follow ? { rollout: { path: follow.path, offset: follow.offset } } : {}),
      };
      const file = this.stateFile(id);
      const tmp = `${file}.${process.pid}.tmp`;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
        fs.renameSync(tmp, file);
        this.written.set(id, now);
      } catch (error) {
        try {
          fs.rmSync(tmp, { force: true });
        } catch {
          // nothing written
        }
        this.options.log?.(`[agent-state] could not write the state of ${id}: ${error}`);
      }
    }
  }

  /** The session's agent state from its events, read up to now; undefined without any. */
  snapshot(sessionId: string): AgentSnapshot | undefined {
    if (!SESSION_ID.test(sessionId)) return undefined;
    this.load(sessionId);
    this.readMailbox(sessionId);
    this.readRollout(sessionId);
    this.flush();
    return this.tracker.get(sessionId);
  }

  /** See AgentStateTracker.actedSince; reads the session's events first. */
  actedSince(sessionId: string, since: number): boolean | undefined {
    if (!this.snapshot(sessionId)) return undefined;
    return this.tracker.actedSince(sessionId, since);
  }

  /** Whether any structured event of this session was ever seen. */
  isCovered(sessionId: string): boolean {
    return this.covered.has(sessionId);
  }

  /**
   * Reads every mailbox and the rollouts of `codexSessions`; drops what belongs to sessions no
   * longer alive (`alive`), so nothing piles up for a session nobody asks about.
   */
  poll(alive: Set<string>, codexSessions: Iterable<string> = []): void {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(this.options.eventsDir);
    } catch {
      // no mailbox yet
    }
    for (const id of entries) {
      if (!SESSION_ID.test(id)) continue;
      if (alive.has(id)) {
        this.load(id);
        this.readMailbox(id);
      } else this.dropMailbox(id);
    }
    for (const id of codexSessions) {
      if (!alive.has(id)) continue;
      this.load(id);
      this.readRollout(id);
    }
    for (const id of this.tracker.sessionIds()) {
      if (!alive.has(id)) this.forget(id);
    }
    this.flush();
  }

  /** Drops what is known of the session, its written state included. */
  forget(sessionId: string): void {
    this.tracker.forget(sessionId);
    this.rollouts.delete(sessionId);
    this.covered.delete(sessionId);
    this.loaded.delete(sessionId);
    this.dirty.delete(sessionId);
    this.written.delete(sessionId);
    if (!SESSION_ID.test(sessionId)) return;
    try {
      fs.rmSync(this.stateFile(sessionId), { force: true });
    } catch {
      // gone already
    }
  }

  private apply(sessionId: string, event: AgentEvent): void {
    this.covered.add(sessionId);
    this.tracker.apply(sessionId, event);
    this.dirty.add(sessionId);
  }

  private dropMailbox(sessionId: string): void {
    try {
      fs.rmSync(path.join(this.options.eventsDir, sessionId), { recursive: true, force: true });
    } catch {
      // gone already
    }
  }

  private readMailbox(sessionId: string): void {
    const dir = path.join(this.options.eventsDir, sessionId);
    let names: string[];
    try {
      // Dot names are the script's temporaries and the session's written state.
      names = fs.readdirSync(dir).filter((name) => name.endsWith('.json') && !name.startsWith('.'));
    } catch {
      return;
    }
    if (names.length === 0) return;
    const files: Array<{ name: string; at: number }> = [];
    for (const name of names) {
      try {
        files.push({ name, at: fs.statSync(path.join(dir, name)).mtimeMs });
      } catch {
        // taken meanwhile
      }
    }
    files.sort((a, b) => a.at - b.at || a.name.localeCompare(b.name));
    for (const { name, at } of files.slice(0, MAX_FILES_PER_LOOK)) {
      const file = path.join(dir, name);
      let raw = '';
      try {
        raw = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      } finally {
        try {
          fs.unlinkSync(file);
        } catch {
          // gone already
        }
      }
      const eventName = /-([A-Za-z]+)\.json$/.exec(name)?.[1];
      if (!eventName) continue;
      let input: Record<string, unknown>;
      try {
        const parsed = JSON.parse(raw) as unknown;
        input = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
      } catch {
        // Cut at 64 KB (or written by something else): what its first part says.
        if (Buffer.byteLength(raw) < HOOK_INPUT_MAX_BYTES) continue;
        input = partialHookInput(raw, eventName);
      }
      // The event is the one the hook was registered for, whatever the file says.
      input.hook_event_name = eventName;
      const event = claudeHookEvent(input, Math.round(at));
      if (event) this.apply(sessionId, event);
    }
  }

  private readRollout(sessionId: string): void {
    const rolloutPath = this.options.codexRollout?.(sessionId);
    if (!rolloutPath) return;
    let follow = this.rollouts.get(sessionId);
    let size: number;
    try {
      size = fs.statSync(rolloutPath).size;
    } catch {
      return;
    }
    if (!follow || follow.path !== rolloutPath || size < follow.offset) {
      const start = Math.max(0, size - ROLLOUT_TAIL_BYTES);
      follow = {
        path: rolloutPath,
        offset: start,
        skipPartialLine: start > 0,
        reader: new CodexRolloutReader(),
      };
      this.rollouts.set(sessionId, follow);
    }
    if (size <= follow.offset) return;
    let fd: number | undefined;
    try {
      fd = fs.openSync(rolloutPath, 'r');
      const buffer = Buffer.alloc(Math.min(size - follow.offset, ROLLOUT_READ_BYTES));
      fs.readSync(fd, buffer, 0, buffer.length, follow.offset);
      let start = 0;
      if (follow.skipPartialLine) {
        const newline = buffer.indexOf(0x0a);
        if (newline < 0) {
          follow.offset += buffer.length;
          return;
        }
        start = newline + 1;
        follow.skipPartialLine = false;
      }
      const lastNewline = buffer.lastIndexOf(0x0a);
      if (lastNewline < start) {
        // One line longer than a read: skipped.
        if (buffer.length === ROLLOUT_READ_BYTES) {
          follow.offset += buffer.length;
          follow.skipPartialLine = true;
        } else {
          follow.offset += start;
        }
        return;
      }
      for (const line of buffer.subarray(start, lastNewline).toString('utf8').split('\n')) {
        if (!line) continue;
        const event = follow.reader.line(line);
        if (event) this.apply(sessionId, event);
      }
      follow.offset += lastNewline + 1;
      this.dirty.add(sessionId);
    } catch (error) {
      this.options.log?.(
        `[agent-state] could not read the Codex rollout of ${sessionId}: ${error}`
      );
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
}
