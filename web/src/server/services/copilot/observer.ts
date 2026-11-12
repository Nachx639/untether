/**
 * Watches every local session through SessionStateSource and turns Claude status transitions
 * into copilot events (done, needs_you, failed, replied_bg, exited, stuck).
 *
 * The transition rules mirror the push notifier (claude-status-notifier.ts): busy→idle is
 * "finished", →waiting is "needs you", busy with background work only is "replied".
 */
import { EventEmitter } from 'events';
import type { Session } from '../../../shared/types.js';
import type { ClaudeChatMessage } from '../claude-chat.js';
import { spokenNames } from './naming.js';
import { menuRisk, optionRisk } from './safety.js';
import type { MenuChoices, SessionAccess } from './session-access.js';
import type { SessionStateSource } from './session-source.js';

type ChatMessage = ClaudeChatMessage;
type ClaudeChoices = MenuChoices;

export type EventKind =
  | 'done'
  | 'needs_you'
  | 'failed'
  | 'replied_bg'
  | 'exited'
  | 'stuck'
  | 'started';

export interface CopilotEvent {
  kind: EventKind;
  sid: string; // short id (s1, s2…)
  id: string;
  name: string;
  at: number; // when the transition was seen (ms)
  priority: number; // higher first
  summary: string; // compact text for the brain
  /** needs_you: the menu's key when it was seen (to refuse answering a menu that changed). */
  key?: string;
  /** The user muted this session: nothing about it is announced unprompted. */
  muted?: boolean;
}

export interface ToolDigest {
  tool?: string;
  text: string;
  isError?: boolean;
  result?: string;
}

export interface SessionState {
  id: string;
  sid: string;
  name: string;
  title?: string;
  /** Working directory (writes outside it are sensitive). */
  cwd?: string;
  running: boolean;
  isAgent: boolean;
  status: string; // idle | busy | waiting | shell | exited
  background: boolean;
  activity?: { kind: string; tool?: string; target?: string; since?: number };
  waitingFor?: string;
  choices?: ClaudeChoices | null;
  since?: number;
  busySince?: number;
  preview?: string;
  lastLine?: string;
  // From the transcript, refreshed on transitions or on demand:
  lastAssistant?: string;
  lastUser?: string;
  tools: ToolDigest[];
  lastError?: ToolDigest;
  files: string[];
  digestAt?: number;
  stuckWarned?: boolean;
  /** Key of the last menu seen while waiting. */
  menuKey?: string;
  /** The user muted this session's notifications: nothing about it is announced unprompted. */
  muted?: boolean;
  lastEventKind?: EventKind;
  /** When the current waiting spell started, and whether it was announced (with or without a menu). */
  waitingSeenAt?: number;
  waitAnnounced?: boolean;
  announcedNoMenu?: boolean;
}

export interface ObserverOptions {
  doneDebounceMs?: number;
  stuckMs?: number;
}

const PRIORITY: Record<EventKind, number> = {
  needs_you: 5,
  failed: 4,
  done: 3,
  replied_bg: 2,
  stuck: 2,
  exited: 1,
  started: 0,
};

export class Observer extends EventEmitter {
  readonly source: SessionStateSource;
  readonly access: Pick<SessionAccess, 'chat'>;
  readonly opts: Required<ObserverOptions>;
  /** Language the copilot speaks: «web dos» or «web two» for names that need a number. */
  lang = 'es';
  readonly sessions = new Map<string, SessionState>();
  private shortIds = new Map<string, string>();
  private nextShort = 1;
  private pendingDone = new Map<string, ReturnType<typeof setTimeout>>();
  private running = false;
  firstPollDone = false;
  pollErrors = 0;
  /** Consecutive failed looks (0 = connected). */
  failStreak = 0;
  connected = true;
  private readonly onChange = (sessions: Session[]) => this.apply(sessions);
  private readonly onError = (error: unknown) => this.lookFailed(error);

  constructor(
    source: SessionStateSource,
    access: Pick<SessionAccess, 'chat'>,
    opts: ObserverOptions = {}
  ) {
    super();
    this.source = source;
    this.access = access;
    this.opts = {
      doneDebounceMs: opts.doneDebounceMs ?? 700,
      stuckMs: opts.stuckMs ?? 10 * 60_000,
    };
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.source.on('change', this.onChange);
    this.source.on('error', this.onError);
    this.source.start();
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    this.source.off('change', this.onChange);
    this.source.off('error', this.onError);
    this.source.stop();
    for (const t of this.pendingDone.values()) clearTimeout(t);
    this.pendingDone.clear();
  }

  /** Look again now and fast for a few seconds (after the copilot acted). */
  hurry(ms = 5000) {
    this.source.refreshSoon(ms);
  }

  /** A busy→idle seen and being debounced: its "done" event is about to arrive. */
  settling(id: string) {
    return this.pendingDone.has(id);
  }

  bySid(sid: string) {
    for (const s of this.sessions.values()) if (s.sid === sid) return s;
    return undefined;
  }

  list(): SessionState[] {
    return [...this.sessions.values()].filter(
      (s) => s.running || Date.now() - (s.since ?? 0) < 10 * 60_000
    );
  }

  /** The short id (s1, s2…) of a session, given on first sight and kept. */
  sidFor(id: string) {
    let sid = this.shortIds.get(id);
    if (!sid) {
      sid = `s${this.nextShort++}`;
      this.shortIds.set(id, sid);
    }
    return sid;
  }

  /** One look at every session (from the source). */
  apply(all: Session[]): void {
    const now = Date.now();
    const shown = all.filter(
      (s) =>
        s.status === 'running' ||
        (this.sessions.has(s.id) && now - (this.sessions.get(s.id)?.since ?? 0) < 10 * 60_000)
    );
    const names = spokenNames(shown, undefined, this.lang);
    const seen = new Set<string>();
    for (const s of all) {
      if (s.status !== 'running' && !this.sessions.has(s.id)) continue;
      seen.add(s.id);
      this.update(s, names.get(s.id));
    }
    for (const [id, st] of this.sessions) {
      if (!seen.has(id) && st.running) {
        st.running = false;
        st.status = 'exited';
        this.emitEvent(st, 'exited', 'la sesión se ha cerrado');
      } else if (!seen.has(id) && Date.now() - (st.since ?? 0) >= 10 * 60_000) {
        // Gone from the list and past the time list() still shows it: forgotten, with its
        // last answer (2026-11-10: every session seen while Conversar was open was kept).
        this.sessions.delete(id);
      }
    }
    this.firstPollDone = true;
    this.failStreak = 0;
    if (!this.connected) {
      this.connected = true;
      this.emit('connection', true);
    }
    this.emit('poll');
  }

  private lookFailed(error: unknown) {
    this.pollErrors++;
    this.failStreak++;
    this.emit('poll-error', error);
    // Session state unreadable for a while: say it once the streak is real.
    if (this.connected && this.failStreak >= 5) {
      this.connected = false;
      this.emit('connection', false);
    }
  }

  private update(s: Session, spoken?: string) {
    const prev = this.sessions.get(s.id);
    const cs = s.claudeStatus;
    const isAgent = Boolean(cs);
    const running = s.status === 'running';
    const status = !running ? 'exited' : cs ? cs.status : 'shell';
    const st: SessionState = prev ?? {
      id: s.id,
      sid: this.sidFor(s.id),
      name: spoken ?? s.id.slice(0, 6),
      running,
      isAgent,
      status,
      background: false,
      tools: [],
      files: [],
    };
    const prevStatus = prev?.status;
    const prevSince = prev?.since;
    const prevRunning = prev?.running;
    const prevBackground = prev?.background ?? false;
    st.name = spoken ?? st.name;
    st.title = cs?.title ?? s.claudeTitle ?? s.codexTitle ?? s.geminiTitle;
    st.muted = Boolean(s.muted);
    st.cwd = s.workingDir;
    st.running = running;
    st.isAgent = isAgent;
    st.status = status;
    st.background = Boolean(cs?.waitingForBackground);
    st.activity = cs?.activity;
    st.waitingFor = cs?.waitingFor;
    st.choices = cs?.choices ?? null;
    st.preview = cs?.preview?.role === 'assistant' ? cs.preview.text : st.preview;
    st.lastLine = s.lastLine;
    if (status === 'busy' && prevStatus !== 'busy') {
      st.busySince = cs?.since ?? Date.now();
      st.stuckWarned = false;
    }
    st.since = cs?.since ?? st.since;
    this.sessions.set(s.id, st);
    if (!prev) return; // first sight: no event (the greeting covers it)
    // Any status change: poll fast for a few seconds (the next change usually follows soon).
    if (prevStatus !== status) this.hurry(3000);

    if (prevRunning && !running) {
      this.emitEvent(st, 'exited', 'la sesión se ha cerrado');
      return;
    }
    if (!isAgent) return;
    // Needs you: a new menu or question (also a different menu right after another).
    // A read can miss the menu for a poll: compare with the last menu seen, not the last read.
    const key = st.choices?.key ?? st.choices?.question;
    const known = st.menuKey;
    if (status === 'waiting' && key) st.menuKey = key;
    if (status !== 'waiting') {
      st.menuKey = undefined;
      st.waitAnnounced = false;
      st.announcedNoMenu = false;
    }
    if (status === 'waiting') {
      // 2026-10-12 (judge round 2): "needs you" was announced before the menu was readable, and
      // never again once it was. Wait up to 600 ms for the options; re-announce when they appear.
      const now = Date.now();
      const fresh = prevStatus !== 'waiting' || Boolean(key && known && key !== known);
      if (fresh) {
        this.cancelDone(st.id);
        st.waitingSeenAt = now;
        st.waitAnnounced = false;
        st.announcedNoMenu = false;
      }
      if (!st.waitAnnounced) {
        if (key || now - (st.waitingSeenAt ?? now) >= 600) {
          st.waitAnnounced = true;
          st.announcedNoMenu = !key;
          // The template needs no transcript: emit now, read the transcript in the background.
          void this.refreshDigest(st);
          this.emitEvent(st, 'needs_you', this.describeWaiting(st));
        } else this.hurry(2000);
      } else if (key && !known && st.announcedNoMenu) {
        st.announcedNoMenu = false;
        void this.refreshDigest(st);
        this.emitEvent(st, 'needs_you', this.describeWaiting(st));
      }
      return;
    }
    if (status === 'busy' && st.background && !prevBackground) {
      void this.refreshDigest(st).finally(() =>
        this.emitEvent(st, 'replied_bg', 'ha respondido; sigue algo en segundo plano')
      );
      return;
    }
    if ((prevStatus === 'busy' || prevStatus === 'waiting') && status === 'idle') {
      this.scheduleDone(st);
      return;
    }
    // A whole turn between two polls (busy for less than a poll): idle again, but a newer status.
    if (
      prevStatus === 'idle' &&
      status === 'idle' &&
      cs?.since &&
      prevSince &&
      cs.since > prevSince
    ) {
      this.scheduleDone(st, true);
      return;
    }
    if (status === 'busy') {
      this.cancelDone(st.id);
      if (prevStatus !== 'busy') this.emit('activity', st, 'started');
      // Stuck = the same tool call running for long (background work is not stuck).
      const since = st.activity?.kind === 'tool' && !st.background ? st.activity.since : undefined;
      if (!st.stuckWarned && since && Date.now() - since > this.opts.stuckMs) {
        st.stuckWarned = true;
        this.emitEvent(
          st,
          'stuck',
          `lleva ${Math.round((Date.now() - since) / 60000)} minutos en lo mismo`
        );
      }
    }
  }

  private cancelDone(id: string) {
    const t = this.pendingDone.get(id);
    if (t) clearTimeout(t);
    this.pendingDone.delete(id);
  }

  /** busy→idle is only "done" if it stays idle (Claude often goes straight back to busy). */
  private scheduleDone(st: SessionState, onlyIfNew = false) {
    this.cancelDone(st.id);
    const answerBefore = st.lastAssistant;
    const digestBefore = st.digestAt;
    const seenAt = Date.now();
    // Read the transcript now, in parallel with the debounce (not after it).
    const early = this.refreshDigest(st);
    const mine = () => this.pendingDone.get(st.id) === handle;
    const drop = () => {
      if (mine()) this.pendingDone.delete(st.id);
    };
    const handle: ReturnType<typeof setTimeout> = setTimeout(async () => {
      if (!mine()) return;
      await early;
      if (!mine()) return;
      if (st.status !== 'idle') return drop();
      if (!st.lastAssistant || st.lastAssistant === answerBefore || st.digestAt === digestBefore) {
        await this.refreshDigest(st);
        if (!st.lastAssistant || st.lastAssistant === answerBefore) {
          // The transcript can lag the status file: one more look before speaking.
          await new Promise((r) => setTimeout(r, 500));
          await this.refreshDigest(st);
        }
      }
      if (!mine()) return;
      drop();
      if (st.status !== 'idle') return;
      if (onlyIfNew && st.lastAssistant === answerBefore) return;
      const failed = this.turnFailed(st);
      this.emitEvent(st, failed ? 'failed' : 'done', this.describeDone(st, failed), seenAt);
    }, this.opts.doneDebounceMs);
    this.pendingDone.set(st.id, handle);
  }

  /** Re-read the transcript tail: last answer, recent tools, errors, files touched. */
  async refreshDigest(st: SessionState): Promise<void> {
    if (!st.isAgent || !st.running) return;
    try {
      const chat = await this.access.chat(st.id);
      if (!chat.available) return;
      applyDigest(st, chat.messages);
    } catch {
      // keep the old digest
    }
  }

  private turnFailed(st: SessionState): boolean {
    if (st.lastError) return true;
    return /\b(failed|failing|falla|fallan|ha fallado|error:|no he podido|could not|couldn't)\b/i.test(
      st.lastAssistant ?? ''
    );
  }

  describeWaiting(st: SessionState): string {
    const c = st.choices;
    if (!c) return `espera algo (${st.waitingFor ?? 'respuesta'}), sin menú legible`;
    const detail = (c.detail ?? []).join(' · ');
    const opts = c.options.map((o: string, i: number) => `${i + 1}) ${clip(o, 70)}`).join(' ');
    const risk = menuRisk(c.question, c.detail, st.cwd, 'es', c.options);
    const riskyOpts = c.options.map((o, i) => ({ i, r: optionRisk(o) })).filter((x) => x.r.risky);
    const risky = risk.risky
      ? ` (ARRIESGADO: es ${risk.verb}; hará falta «confirmo»)`
      : riskyOpts.length
        ? ` (OJO: la opción ${riskyOpts.map((x) => x.i + 1).join(' y ')} es ${riskyOpts[0].r.verb}; dilo y hará falta «confirmo»)`
        : risk.verb
          ? ` (en palabras normales: ${risk.verb})`
          : '';
    return `pregunta: ${c.question}${detail ? ` [${clip(detail, 200)}]` : ''} opciones: ${opts}${risky}`;
  }

  private describeDone(st: SessionState, failed: boolean): string {
    const parts: string[] = [];
    if (failed && st.lastError) {
      parts.push(
        `error en ${st.lastError.tool ?? 'herramienta'} «${clip(st.lastError.text, 80)}»: ${clip(st.lastError.result ?? '', 300)}`
      );
    }
    parts.push(
      `respuesta final de Claude: «${clip(st.lastAssistant ?? st.preview ?? '(sin texto)', 1400)}»`
    );
    if (st.files.length) parts.push(`ficheros tocados: ${st.files.slice(-6).join(', ')}`);
    return parts.join(' | ');
  }

  private emitEvent(st: SessionState, kind: EventKind, summary: string, at = Date.now()) {
    st.lastEventKind = kind;
    const ev: CopilotEvent = {
      kind,
      sid: st.sid,
      id: st.id,
      name: st.name,
      at,
      priority: PRIORITY[kind],
      summary,
      key: kind === 'needs_you' ? st.choices?.key : undefined,
      muted: st.muted,
    };
    this.emit('event', ev);
  }
}

export function clip(text: string, max: number) {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** The current turn = messages after the last user message. */
export function applyDigest(st: SessionState, messages: ChatMessage[]) {
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      lastUserIdx = i;
      break;
    }
  }
  const turn = messages.slice(lastUserIdx + 1);
  st.lastUser = lastUserIdx >= 0 ? messages[lastUserIdx].text : undefined;
  const assistants = turn.filter((m) => m.role === 'assistant');
  st.lastAssistant = assistants.length ? assistants[assistants.length - 1].text : undefined;
  if (!st.lastAssistant) {
    const any = [...messages].reverse().find((m) => m.role === 'assistant');
    st.lastAssistant = any?.text;
  }
  const tools = turn.filter((m) => m.role === 'tool');
  st.tools = tools.slice(-8).map((t) => ({
    tool: t.tool,
    text: t.text || t.detail || '',
    isError: t.isError,
    result: t.result,
  }));
  const errors = tools.filter((t) => t.isError);
  const last = errors[errors.length - 1];
  st.lastError = last
    ? { tool: last.tool, text: last.detail || last.text, isError: true, result: last.result }
    : undefined;
  const files = new Set<string>();
  for (const t of messages.slice(-80)) {
    if (
      t.role === 'tool' &&
      ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(t.tool ?? '') &&
      t.text
    )
      files.add(t.text);
  }
  st.files = [...files];
  st.digestAt = Date.now();
}
