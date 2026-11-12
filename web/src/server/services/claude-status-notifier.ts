/**
 * Push notifications from Claude Code's own status: "finished" when a session goes from
 * busy to idle, "needs you" when it starts waiting for the user (permission, question),
 * and "replied" when a turn ends while background agents keep Claude "busy" (its "finished"
 * only comes once they all end, maybe an hour later).
 * The phone is usually locked while Claude works; this is the moment to look at it.
 *
 * Codex gets the same two (2026-11-10): its status comes from its rollout, in Claude's words
 * (`readAgents`, codex-session-status.ts), and goes through the same looks, so everything
 * learnt here holds for it too (first sightings, a status set twice between looks, mute, the
 * state kept across restarts). Not from Codex's own `notify`: that one also fires for the
 * internal thread that names the conversation, twice for one turn.
 */
import * as fs from 'fs';
import * as path from 'path';
import { agentPushTag, PUSH_AGENT_NAMES, type PushAgent } from '../../shared/agent-push.js';
import { compactDetail, type ScreenChoices } from '../../shared/claude-screen.js';
import { claudeConfigDir } from '../utils/claude-dir.js';
import { every } from '../utils/periodic-loop.js';
import { type ClaudeStatus, readClaudeStatuses } from './claude-chat.js';
import { menuKeyHash } from './menu-key-hash.js';
import type { NotificationPayload } from './push-notification-service.js';

export interface WatchedSession {
  id: string;
  name: string;
  /** The title the user gave the session: push notifications name it so. */
  userTitle?: string;
  pid?: number;
  status: string;
  muted?: boolean;
}

/** A session as the PTY manager lists it, and how it finds the program running in one. */
export interface WatchedSessionSource {
  listSessions(): Array<{
    id: string;
    name: string;
    userTitle?: string;
    pid?: number;
    status: string;
    muted?: boolean;
    shielded?: boolean;
  }>;
  programRootPid(session: { id: string; pid?: number; shielded?: boolean }): number | undefined;
}

/**
 * The sessions to watch, each with the pid its agent runs under: the program inside tmux for
 * a shielded session. Its own pid is tmux's client there, with no Claude under it, so shielded
 * sessions (the default) never sent "finished" or "needs you" (2026-10-03: no push all day).
 */
export function watchedSessions(source: WatchedSessionSource): WatchedSession[] {
  return source.listSessions().map((session) => ({
    id: session.id,
    name: session.name,
    userTitle: session.userTitle,
    pid: source.programRootPid(session),
    status: session.status,
    muted: session.muted,
  }));
}

type Notify = (payload: NotificationPayload) => void;

/** The agents whose status is pushed. */
export type NotifiedAgent = PushAgent;

/** An agent other than Claude seen in a session, its status in Claude's words. */
export interface AgentSighting {
  agent: Exclude<NotifiedAgent, 'claude'>;
  /**
   * Which run of the agent this is (its process, its conversation): another one in the same
   * session is a first look, like a new Claude.
   */
  program: string;
  status: ClaudeStatus;
}

/** Busy only because background agents or tasks run: the reply is over. */
export const BACKGROUND = 'busy:background';

/**
 * A session's Claude changed status (tracked: busy split into a turn and BACKGROUND).
 * `previous` is undefined on a first sighting (after a server restart, a new program).
 */
export type ClaudeTransitionListener = (
  sessionId: string,
  previous: string | undefined,
  status: string,
  claude: ClaudeStatus,
  /** Whose status it is: Claude's, or another agent's in Claude's words. */
  agent: NotifiedAgent
) => void;

/** Claude's status as the notifier tracks it: busy split into a turn and background work. */
function trackedStatus(claude: ClaudeStatus): string {
  return claude.status === 'busy' && claude.waitingForBackground ? BACKGROUND : claude.status;
}

export interface ClaudeStatusNotifierOptions {
  /**
   * One line for what the notifier drops or loses sight of (a muted session's push, a Claude
   * that stops being seen and comes back): a silent session can then be told apart from a
   * Claude that never finished. Session ids, statuses and counts only, never screen text.
   */
  log?: (message: string) => void;
  /**
   * Awaited before each look: brings the pids `listSessions` answers up to date (see
   * PtyManager.refreshProgramPids). A failure is reported and the look goes on.
   */
  refreshPids?: () => Promise<void>;
  /**
   * The size in bytes of the conversation's transcript (Claude Code's JSONL), undefined when
   * it can't be told. Defaults to looking it up under Claude's projects folder.
   */
  transcriptBytes?: (claude: ClaudeStatus) => number | undefined;
  /**
   * Where the status last seen per session is kept across server restarts (2026-11-02: each
   * restart made every session a first sighting, so a turn that ended or a question that came
   * up around it was never pushed). Unset: nothing is kept.
   */
  stateFile?: string;
  /**
   * The other agents running in these sessions (Codex), by session id. Claude's own status
   * wins where both are seen. A failure is reported and the look goes on with Claude's.
   */
  readAgents?: (
    sessions: WatchedSession[]
  ) => Promise<Map<string, AgentSighting>> | Map<string, AgentSighting>;
  now?: () => number;
}

/** A saved state older than this is not used: what happened since is unknown. */
export const STATUS_STATE_MAX_AGE_MS = 10 * 60_000;

const transcriptPaths = new Map<string, string>();

/**
 * The size of `<claude dir>/projects/<any>/<conversation id>.jsonl`, or undefined (no
 * conversation id, no transcript yet). The path is remembered: a stat per look after that.
 */
export function transcriptBytesOf(
  claude: Pick<ClaudeStatus, 'sessionId'>,
  claudeDir = claudeConfigDir()
): number | undefined {
  const id = claude.sessionId;
  if (!id || !/^[A-Za-z0-9-]+$/.test(id)) return undefined;
  const key = `${claudeDir}\0${id}`;
  const known = transcriptPaths.get(key);
  if (known) {
    try {
      return fs.statSync(known).size;
    } catch {
      transcriptPaths.delete(key);
    }
  }
  const projectsDir = path.join(claudeDir, 'projects');
  try {
    for (const dir of fs.readdirSync(projectsDir)) {
      const candidate = path.join(projectsDir, dir, `${id}.jsonl`);
      try {
        const size = fs.statSync(candidate).size;
        transcriptPaths.set(key, candidate);
        if (transcriptPaths.size > 200) {
          transcriptPaths.delete(transcriptPaths.keys().next().value as string);
        }
        return size;
      } catch {
        // not in this project folder
      }
    }
  } catch {
    // no projects folder
  }
  return undefined;
}

/**
 * Looks in a row without seeing a session's Claude before its last status is forgotten (15 s
 * at the 3 s tick). One look can miss it: a `ps` that ran while it forked, its session file
 * read while Claude rewrote it. Forgetting on that one miss made the next look a silent
 * "first sighting" that swallowed the "finished" in between: a likely cause of a shielded
 * session getting no push for two finished turns (2026-10-03, 22:13Z and 22:17Z).
 */
export const FORGET_AFTER_UNSEEN_TICKS = 5;

/**
 * The on-screen choices as they travel in a push: small (Web Push rejects payloads over
 * ~4 KB), and only what the answer sheet shows before it re-reads the live screen.
 */
export function pushChoices(
  choices: ScreenChoices | null | undefined
): { question: string; options: string[]; detail?: string[]; keyHash?: string } | undefined {
  if (!choices || choices.options.length < 2) return undefined;
  return {
    question: choices.question.slice(0, 160),
    options: choices.options.slice(0, 9).map((option) => option.slice(0, 80)),
    ...(choices.detail ? { detail: choices.detail.map((line) => line.slice(0, 120)) } : {}),
    // What an answer from the push's own choices is checked by (see menuKeyHash).
    ...(choices.key ? { keyHash: menuKeyHash(choices.key) } : {}),
  };
}

export class ClaudeStatusNotifier {
  /**
   * Per session: the status last seen, when Claude set it (its statusUpdatedAt), how many
   * looks in a row saw it before that, and how many in a row have not seen it since.
   */
  private last = new Map<
    string,
    {
      status: string;
      since?: number;
      seen: number;
      unseen: number;
      /** The agent's run this status is of ("claude:<pid>", "codex:<its process>"). */
      program?: string;
      /** Whose status it is (the log names it); Claude's when not said. */
      agent?: NotifiedAgent;
      /** The `since` of the waiting last pushed: the same question is pushed once. */
      waitingPushed?: number;
      /** The conversation and its transcript size at the last look that saw Claude idle. */
      idleTranscript?: { sessionId: string; bytes: number };
      /** Loaded from stateFile: the previous server saw it, this one has not yet. */
      restored?: boolean;
    }
  >();
  /** What was last written to stateFile. */
  private savedState = '';
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private rewrite: (payload: NotificationPayload) => NotificationPayload | null = (payload) =>
    payload;
  private transitionListeners: ClaudeTransitionListener[] = [];

  constructor(
    private listSessions: () => WatchedSession[],
    private notify: Notify,
    private readStatuses: (pids: number[]) => Promise<Map<number, ClaudeStatus>> = (pids) =>
      readClaudeStatuses(pids),
    private onError?: (error: unknown) => void,
    /** The prompt on the session's screen (numbered menu or yes/no), for the push. */
    private readChoices?: (sessionId: string) => Promise<ScreenChoices | null>,
    private options: ClaudeStatusNotifierOptions = {}
  ) {
    this.loadState();
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private loadState(): void {
    const file = this.options.stateFile;
    if (!file) return;
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as {
        at?: number;
        sessions?: Record<string, { status?: string; since?: number; program?: string }>;
      };
      if (typeof saved.at !== 'number' || this.now() - saved.at > STATUS_STATE_MAX_AGE_MS) return;
      for (const [id, entry] of Object.entries(saved.sessions ?? {})) {
        if (typeof entry?.status !== 'string' || typeof entry.program !== 'string') continue;
        this.last.set(id, {
          status: entry.status,
          ...(typeof entry.since === 'number' ? { since: entry.since } : {}),
          seen: 1,
          unseen: 0,
          program: entry.program,
          restored: true,
        });
      }
    } catch {
      // None yet, or unreadable: every session is a first sighting, as before.
    }
  }

  /** The statuses to stateFile when they changed (atomic: tmp + rename). */
  private saveState(): void {
    const file = this.options.stateFile;
    if (!file) return;
    const sessions: Record<string, { status: string; since?: number; program?: string }> = {};
    for (const [id, entry] of this.last) {
      sessions[id] = { status: entry.status, since: entry.since, program: entry.program };
    }
    const text = JSON.stringify(sessions);
    // Written when a status changed, and once a minute anyway so its age says it is current.
    const stale = this.now() - this.savedAt > 60_000;
    if (text === this.savedState && !stale) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ at: this.now(), sessions }), { mode: 0o600 });
      fs.renameSync(tmp, file);
      this.savedState = text;
      this.savedAt = this.now();
    } catch (error) {
      this.onError?.(error);
    }
  }

  private savedAt = 0;

  /**
   * Swap a push before it is sent (a task session's "finished" becomes "task finished"), or
   * drop it (null): the task engine sends its own.
   */
  setPayloadRewriter(rewrite: (payload: NotificationPayload) => NotificationPayload | null): void {
    this.rewrite = rewrite;
  }

  /**
   * Every status change of every session, muted or not and whether or not it makes a push
   * (the task engine follows its sessions through these).
   */
  onTransition(listener: ClaudeTransitionListener): void {
    this.transitionListeners.push(listener);
  }

  private emitTransition(
    sessionId: string,
    previous: string | undefined,
    status: string,
    claude: ClaudeStatus,
    agent: NotifiedAgent
  ): void {
    for (const listener of this.transitionListeners) {
      try {
        listener(sessionId, previous, status, claude, agent);
      } catch (error) {
        this.onError?.(error);
      }
    }
  }

  start(intervalMs = 3000): void {
    if (this.timer) return;
    this.timer = every('claude status notifier', () => this.tick(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.options.refreshPids?.().catch((error) => this.onError?.(error));
      const sessions = this.listSessions().filter((s) => s.status === 'running');
      // A read that fails outright (ps error) throws to the catch below: that look saw nothing,
      // so it counts against no session.
      const statuses = await this.readStatuses(
        sessions.filter((s) => s.pid).map((s) => s.pid as number)
      );
      let others = new Map<string, AgentSighting>();
      try {
        others = (await this.options.readAgents?.(sessions)) ?? others;
      } catch (error) {
        this.onError?.(error);
      }
      const seen = new Set<string>();
      for (const session of sessions) {
        const ofClaude = session.pid ? statuses.get(session.pid) : undefined;
        const other = ofClaude ? undefined : others.get(session.id);
        const claude = ofClaude ?? other?.status;
        if (!claude) continue;
        const agent: NotifiedAgent = other?.agent ?? 'claude';
        const name = PUSH_AGENT_NAMES[agent];
        const program = other ? `${other.agent}:${other.program}` : `claude:${session.pid}`;
        seen.add(session.id);
        const seenBefore = this.last.get(session.id);
        let status = trackedStatus(claude);
        // Claude's transcript; another agent's status is no screen read, so it has no redraws.
        const bytes = agent === 'claude' ? this.transcriptBytes(claude) : undefined;
        // 2026-10-20: opening or resizing a finished task's terminal on the phone redraws
        // Claude's TUI, and Claude Code's status reads as busy then idle (or idle again with a
        // new `since`): the task engine took it for another turn and ran the merge pipeline
        // again, five times in three minutes. A turn always writes to the conversation's
        // transcript; a "busy" from idle with no growth since that idle look is a redraw: it
        // stays idle until the transcript grows (one look later at worst for a real turn).
        const idleBefore = seenBefore?.idleTranscript;
        const grew =
          bytes === undefined ||
          idleBefore === undefined ||
          idleBefore.sessionId !== claude.sessionId ||
          bytes > idleBefore.bytes;
        const redraw =
          !grew &&
          seenBefore?.status === 'idle' &&
          seenBefore.program === program &&
          (status === 'busy' || status === BACKGROUND || status === 'idle');
        if (redraw && status !== 'idle') {
          this.options.log?.(
            `${name} status: session ${session.id} reads ${claude.status} with no new transcript activity; taken as a redraw`
          );
          status = 'idle';
        }
        if (seenBefore?.unseen) {
          this.options.log?.(
            `${name} status: session ${session.id} seen again (${claude.status}) after ${seenBefore.unseen} looks without it`
          );
        }
        this.last.set(session.id, {
          status,
          since: claude.since,
          seen: seenBefore && !seenBefore.unseen ? seenBefore.seen + 1 : 1,
          unseen: 0,
          program,
          agent,
          waitingPushed: seenBefore?.program === program ? seenBefore.waitingPushed : undefined,
          idleTranscript:
            status === 'idle' && claude.sessionId && bytes !== undefined
              ? { sessionId: claude.sessionId, bytes }
              : status === 'idle'
                ? undefined
                : seenBefore?.idleTranscript,
        });
        // 2026-10-04: a new program in the session (a shield restore after its tmux server went
        // away, a respawned pane, a relaunched Claude) is a first sighting too. The restore at
        // 03:30 sent two "Claude finished" pushes for turns that never happened.
        // The same for another agent in it: `codex` typed where Claude ran, or typed again.
        if (seenBefore?.program !== undefined && seenBefore.program !== program) {
          this.options.log?.(
            `${name} status: session ${session.id} has a new program (${seenBefore.program} → ${program}); taking it as a first look`
          );
          this.emitTransition(session.id, undefined, status, claude, agent);
          continue;
        }
        // First sighting only records the state: no burst of alerts after a server restart.
        // A session missed for a few looks still has its status from before the gap, so
        // busy → (unseen) → idle with a new `since` is a "finished".
        if (seenBefore === undefined) {
          this.emitTransition(session.id, undefined, status, claude, agent);
          continue;
        }
        // Seen by the server before this one (stateFile), same program: the tasks get a first
        // look as always (they take up a restart themselves), but a change since then is still
        // pushed: a turn that ended or a question that came up while the server restarted.
        const restored = seenBefore.restored === true;
        if (restored) this.emitTransition(session.id, undefined, status, claude, agent);
        let previous = seenBefore.status;
        if (previous === status) {
          // The same status set again in between two looks (3 s apart): a quick answer went
          // idle → busy → idle unseen, and its "finished" never came (2026-10-03). A new
          // waiting is a new question. Busy again says nothing about what was in between.
          // A Codex seen before its first turn has no status time yet (no rollout): its first
          // one is a turn that began and ended between two looks.
          const again =
            claude.since !== undefined &&
            (seenBefore.since !== undefined || agent !== 'claude') &&
            claude.since !== seenBefore.since;
          if (!again || claude.status === 'busy' || redraw) continue;
          previous = 'busy';
        }
        // Another agent's waiting is read off its screen in the middle of a turn (a Codex
        // approval): once answered, the rest of the turn may fit between two looks, and waiting
        // → idle with a turn that ended since is that turn over. Claude's waiting → idle stays
        // what it was: a question answered with no turn behind it.
        if (
          agent !== 'claude' &&
          previous === 'waiting' &&
          status === 'idle' &&
          claude.since !== undefined &&
          seenBefore.since !== undefined &&
          claude.since > seenBefore.since
        ) {
          previous = 'busy';
        }
        if (!restored) this.emitTransition(session.id, previous, status, claude, agent);
        const original = this.payloadFor(session, claude, previous, status, agent);
        if (!original) continue;
        // A waiting read off the screen (a Codex menu) can drop out for one look and come back:
        // the same question, by its time, is one push (2026-11-10).
        if (claude.status === 'waiting' && claude.since !== undefined) {
          const entry = this.last.get(session.id);
          if (entry?.waitingPushed === claude.since) {
            this.options.log?.(
              `${name} status: ${original.type} for session ${session.id} not pushed again: the same question as before`
            );
            continue;
          }
          if (entry) entry.waitingPushed = claude.since;
        }
        if (session.muted) {
          this.options.log?.(
            `${name} status: ${original.type} for session ${session.id} not pushed: session muted`
          );
          continue;
        }
        const payload = this.rewrite(original);
        if (!payload) continue;
        if (claude.status === 'waiting' && this.readChoices) {
          // A failed screen read still sends the push, just without choices.
          const read = await this.readChoices(session.id).catch(() => null);
          const choices = pushChoices(read);
          if (choices) payload.data = { ...payload.data, choices };
          // What it asks to do ("Create empty file nuevo.txt · touch nuevo.txt"), on the lock
          // screen instead of "permission prompt": enough to decide before opening anything.
          if (read?.detail?.length) {
            const asks = compactDetail(read.detail).slice(0, 200);
            payload.body = asks;
            payload.data = { ...payload.data, detail: asks };
          }
        }
        this.notify(payload);
      }
      for (const [id, entry] of this.last) {
        if (seen.has(id)) continue;
        entry.unseen++;
        if (entry.unseen === 1) {
          this.options.log?.(
            `${PUSH_AGENT_NAMES[entry.agent ?? 'claude']} status: session ${id} not seen (last ${entry.status}, after ${entry.seen} looks with it)`
          );
        }
        if (entry.unseen >= FORGET_AFTER_UNSEEN_TICKS) {
          this.last.delete(id);
          this.options.log?.(
            `${PUSH_AGENT_NAMES[entry.agent ?? 'claude']} status: session ${id} forgotten after ${entry.unseen} looks without it`
          );
        }
      }
      this.saveState();
    } catch (error) {
      // Runs on a timer: an unhandled rejection here would take the whole server down
      // (cli.ts exits on them). A failed ps or a vanished transcript just skips this tick.
      this.onError?.(error);
    } finally {
      this.ticking = false;
    }
  }

  private transcriptBytes(claude: ClaudeStatus): number | undefined {
    try {
      return (this.options.transcriptBytes ?? transcriptBytesOf)(claude);
    } catch {
      return undefined;
    }
  }

  private payloadFor(
    session: WatchedSession,
    claude: ClaudeStatus,
    previous: string,
    status: string,
    agent: NotifiedAgent
  ): NotificationPayload | null {
    const where = session.userTitle || claude.title || session.name;
    const name = PUSH_AGENT_NAMES[agent];
    let title: string;
    let body: string;
    let type: string;
    if (claude.status === 'waiting') {
      type = `${agent}-waiting`;
      title = `⏳ ${name} needs you · ${where}`;
      body = (claude.waitingFor || 'Waiting for your answer').slice(0, 200);
    } else if (claude.status === 'idle' && (previous === 'busy' || previous === BACKGROUND)) {
      // Background work ending is still Claude's busy → idle: the usual "finished".
      type = `${agent}-finished`;
      title = `✅ ${name} finished · ${where}`;
      body = claude.preview?.role === 'assistant' ? claude.preview.text : 'Your turn';
    } else if (status === BACKGROUND && previous === 'busy') {
      // Once per reply: background work going on (busy → busy) is not a "finished". Only
      // from a turn seen running, never from idle (a summary that still has the last turn).
      type = `${agent}-replied`;
      title = `💬 ${name} replied · ${where}`;
      body =
        claude.preview?.role === 'assistant'
          ? claude.preview.text
          : 'Background agents are still running';
    } else {
      return null;
    }
    const waiting = claude.status === 'waiting';
    return {
      type,
      title,
      body,
      icon: '/apple-touch-icon.png',
      badge: '/favicon-32.png',
      // One notification per session: a newer state replaces the older one.
      tag: agentPushTag(agent, session.id),
      requireInteraction: waiting,
      // "Answer" opens the answer sheet, like tapping the notification: never answers by itself.
      actions: [
        waiting ? { action: 'answer', title: 'Answer' } : { action: 'view-session', title: 'Open' },
        { action: 'dismiss', title: 'Dismiss' },
      ],
      // Raw fields so the service worker can rebuild the text in the user's language.
      data: {
        type,
        sessionId: session.id,
        timestamp: new Date().toISOString(),
        where,
        // Capped: Web Push payloads over ~4 KB are rejected outright.
        // Whose push it is: the service worker names it in the user's language.
        agent,
        detail: (waiting
          ? claude.waitingFor || ''
          : claude.preview?.role === 'assistant'
            ? claude.preview.text
            : ''
        ).slice(0, 200),
      },
    };
  }
}
