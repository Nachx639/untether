/**
 * The voice copilot («Conversar») inside the Untether server: the `/copilot` WebSocket, the
 * conversations, and who hears what.
 *
 * Two modes, one component: «Conversar» inside a session's chat talks about that session only
 * (session mode); the home page's button talks about every session (global mode). Each scope is
 * one conversation (its own Copilot and warm brain); pages on the same scope (the app and a
 * Safari tab) share it, and a user turn's audio goes only to the page it came from.
 *
 * Nothing starts with the server. The first page's `hello` starts the session state source,
 * the brain, Kokoro, whisper and the clips; a conversation with no page for IDLE_STOP_MS stops
 * its brain and forgets what was said, and the last one stops the source too.
 *
 * Logs carry lengths and timings only, never what was said or what is on a screen.
 */
import type { EventEmitter } from 'events';
import * as path from 'path';
import type { WebSocket } from 'ws';
import {
  CLIP_TURN,
  COPILOT_MAX_UTTERANCE_BYTES,
  COPILOT_PROTOCOL_VERSION,
  type CopilotClientMessage,
  type CopilotScope,
  type CopilotServerMessage,
  type CopilotSessionChip,
  type CopilotSessionStatus,
  encodeAudioFrame,
} from '../../../shared/copilot-protocol.js';
import type { SessionInput } from '../../../shared/types.js';
import { createLogger } from '../../utils/logger.js';
import { every } from '../../utils/periodic-loop.js';
import { Brain, type BrainConfig } from './brain.js';
import { CLIPS } from './clips.js';
import { Copilot, type CopilotObserver, detectLang, type TurnRecord } from './copilot.js';
import { Observer } from './observer.js';
import { SYSTEM_PROMPT } from './prompt.js';
import { ScopedObserver } from './scoped-observer.js';
import type { AccessAnswer, SessionAccess } from './session-access.js';
import { SessionStateSource } from './session-source.js';
import { CopilotSpeech } from './speech.js';

const logger = createLogger('copilot');

const IDLE_STOP_MS = 5 * 60_000;
const KEEP_ALIVE_MS = 60_000;

/** Lines the code says often: synthesized when the first page connects. */
const FIXED_PHRASES = [
  'Hecho.',
  'Hecho, se lo he dicho.',
  'Dicho.',
  'Vale, se lo paso.',
  'Ya se lo he pasado.',
  'Hecho: lo hará al acabar.',
  'Para eso, dime confirmo.',
  'Eso, solo con un confirmo.',
  'Vale, que siga esperando.',
  'Para dejarle, di confirmo.',
  '¿Cuál?',
  'Parado.',
  'Hecho, solo esta vez.',
  'Le he dicho que no.',
  'Vale, que no.',
  'Di confirmo.',
  'Solo si dices confirmo.',
  'No hay nada pendiente.',
  'Vale, nada.',
  'Vale.',
  'Ya no está esa pregunta.',
  'No he podido.',
  '¿Le dejo?',
];

export interface CopilotServiceDeps {
  access: SessionAccess;
  /** PtyManager: `sessionStarted` / `sessionExited` trigger a look. */
  sessionEvents?: EventEmitter;
  refreshPids?: () => Promise<void>;
  /** Untether's data folder (the control dir's parent): clip cache, brain pid file. */
  dataDir: string;
  claudeDir?: string;
  brain?: BrainConfig;
  /** Tests: their own brain, speech and timings. */
  makeBrain?: () => Brain;
  speech?: CopilotSpeech;
  idleStopMs?: number;
  observerOptions?: ConstructorParameters<typeof Observer>[2];
  sourceOptions?: { busyTickMs?: number; idleTickMs?: number; debounceMs?: number };
}

interface Peek {
  epoch: number;
  result: Promise<{ text: string; ms: number } | null>;
  /** When the user began saying it (arrival minus the audio's length). */
  startedAt: number;
}

/** Length of a 16 kHz mono 16-bit WAV utterance, in ms. */
function wavMs(wav: Buffer) {
  return Math.max(0, Math.round(((wav.length - 44) / 32_000) * 1000));
}

interface Page {
  id: string;
  ws: WebSocket;
  conv?: Conversation;
  readOnly: boolean;
  clipLang?: 'es' | 'en';
  nextIsPeek: boolean;
  peek?: Peek;
  lastState?: string;
}

interface Conversation {
  key: string;
  scope: CopilotScope;
  view: CopilotObserver & { dispose?: () => void };
  copilot: Copilot;
  brain: Brain;
  pages: Set<Page>;
  active?: Page;
  turnOwner: Map<number, Page>;
  turnOrigin: Map<number, string>;
  cancelledTurns: Set<number>;
  ttsChain: Promise<void>;
  sttLang?: string;
  idleTimer?: ReturnType<typeof setTimeout>;
  lastGreet?: string;
}

const scopeKey = (scope: CopilotScope) =>
  scope.mode === 'session' ? `session:${scope.sessionId}` : 'all';

/**
 * TTS pieces for one sentence: the first piece of a turn is cut at the first ":", "," or ";"
 * after two words (first audio sooner), later pieces near 60 characters (Kokoro costs ~7 ms
 * per character).
 */
export function splitPieces(text: string, first: boolean): string[] {
  const out: string[] = [];
  let rest = text.trim();
  let isFirst = first;
  for (let guard = 0; guard < 6; guard++) {
    if (!isFirst && rest.length <= 70) break;
    const m = rest.match(/^([^\s,:;]+(?:\s+[^\s,:;]+)+?[:,;])\s+([\s\S]+)$/);
    if (!m || m[2].split(/\s+/).length < 2) break;
    if (!isFirst && m[1].length < 25) {
      const m2 = rest.match(/^([\s\S]{25,}?[:,;])\s+([\s\S]+)$/);
      if (!m2 || m2[2].split(/\s+/).length < 2) break;
      out.push(m2[1]);
      rest = m2[2];
    } else {
      out.push(m[1]);
      rest = m[2];
    }
    isFirst = false;
  }
  out.push(rest);
  return out;
}

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

export class CopilotService {
  private readonly deps: CopilotServiceDeps;
  readonly speech: CopilotSpeech;
  private source: SessionStateSource | null = null;
  private observer: Observer | null = null;
  private readonly conversations = new Map<string, Conversation>();
  private readonly pages = new Set<Page>();
  private pageSeq = 0;
  private keepAliveTimer?: ReturnType<typeof setInterval>;
  /** Recent turns for the status route: timings and outcomes, no text. */
  private readonly turns: {
    turn: number;
    scope: string;
    origin: string;
    fastPath?: string;
    actions: { kind: string; outcome: string }[];
    timings: TurnRecord['timings'];
    cancelled: boolean;
  }[] = [];
  private readonly sttMs: number[] = [];
  private readonly outcomes: Record<string, number> = {};
  private closed = false;

  constructor(deps: CopilotServiceDeps) {
    this.deps = deps;
    this.speech = deps.speech ?? new CopilotSpeech(path.join(deps.dataDir, 'copilot', 'clips'));
  }

  /** Nothing runs until a page says hello. */
  get started(): boolean {
    return this.observer !== null;
  }

  // ------------------------------------------------------------------ pages

  attach(ws: WebSocket): void {
    if (this.closed) {
      ws.close();
      return;
    }
    const page: Page = { id: `p${++this.pageSeq}`, ws, readOnly: false, nextIsPeek: false };
    this.pages.add(page);
    ws.on('close', () => this.detach(page));
    ws.on('error', () => undefined);
    ws.on('message', (data, isBinary) => {
      void this.onMessage(page, data as Buffer | ArrayBuffer | Buffer[], isBinary).catch((error) =>
        logger.warn(`message from ${page.id} failed: ${error}`)
      );
    });
  }

  private detach(page: Page) {
    this.pages.delete(page);
    this.leave(page);
    if (!this.pages.size && this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = undefined;
    }
  }

  private leave(page: Page) {
    const conv = page.conv;
    if (!conv) return;
    page.conv = undefined;
    conv.pages.delete(page);
    if (conv.active === page) conv.active = undefined;
    if (!conv.pages.size) this.scheduleIdleStop(conv);
  }

  private send(page: Page, msg: CopilotServerMessage) {
    if (page.ws.readyState === page.ws.OPEN) page.ws.send(JSON.stringify(msg));
  }

  private broadcast(conv: Conversation, msg: CopilotServerMessage) {
    for (const p of conv.pages) this.send(p, msg);
  }

  private isOpen(page?: Page): page is Page {
    return Boolean(page && page.ws.readyState === page.ws.OPEN && page.conv);
  }

  private activePage(conv: Conversation): Page | undefined {
    if (this.isOpen(conv.active) && conv.active.conv === conv) return conv.active;
    return [...conv.pages].reverse().find((p) => this.isOpen(p));
  }

  private ownerOf(conv: Conversation, turn: number): Page | undefined {
    const p = conv.turnOwner.get(turn);
    return this.isOpen(p) && p.conv === conv ? p : this.activePage(conv);
  }

  private async onMessage(
    page: Page,
    data: Buffer | ArrayBuffer | Buffer[],
    isBinary: boolean
  ): Promise<void> {
    if (isBinary) {
      const wav = Buffer.isBuffer(data)
        ? data
        : Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.from(data);
      const conv = page.conv;
      if (!conv || wav.length > COPILOT_MAX_UTTERANCE_BYTES) return;
      conv.active = page;
      if (page.nextIsPeek) {
        // Tentative: transcribe now, decide on utt-commit / utt-resume.
        page.nextIsPeek = false;
        page.peek = {
          epoch: conv.copilot.utteranceEpoch(),
          result: this.transcribe(conv, wav),
          startedAt: Date.now() - wavMs(wav),
        };
        return;
      }
      page.peek = undefined;
      const at = Date.now();
      const epoch = conv.copilot.utteranceEpoch();
      const startedAt = at - wavMs(wav);
      this.utterance(conv, page, await this.transcribe(conv, wav), at, epoch, 'full', startedAt);
      return;
    }
    let msg: CopilotClientMessage;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (msg.type === 'hello') {
      this.hello(page, msg);
      return;
    }
    const conv = page.conv;
    if (!conv) return;
    const copilot = conv.copilot;
    switch (msg.type) {
      case 'text':
        conv.active = page;
        if (typeof msg.text === 'string' && msg.text.trim()) {
          const text = msg.text.slice(0, 2000);
          const accepted = copilot.userSaid(text, Date.now(), { source: page.id });
          this.send(page, { type: 'transcript', text, ignored: !accepted });
        }
        break;
      case 'vad':
        if (msg.speaking) conv.active = page;
        copilot.setUserSpeaking(Boolean(msg.speaking));
        break;
      case 'utt-peek':
        page.nextIsPeek = true;
        break;
      case 'utt-resume':
        page.peek = undefined;
        break;
      case 'utt-commit': {
        const pk = page.peek;
        page.peek = undefined;
        if (!pk) {
          this.send(page, { type: 'transcript', text: '', error: 'stt' });
          break;
        }
        const at = Date.now();
        // A continuation after the peek was taken (epoch moved) is still handled by userSaid.
        this.utterance(
          conv,
          page,
          await pk.result,
          at,
          Math.min(pk.epoch, copilot.utteranceEpoch()),
          'peek',
          pk.startedAt
        );
        break;
      }
      case 'utt-drop':
        page.peek = undefined;
        copilot.utteranceDropped();
        break;
      case 'barge':
        conv.active = page;
        if (msg.cont === true) {
          // The user went on talking soon after an utterance whose answer was not heard yet:
          // they had only paused. Their words so far join the next utterance.
          page.peek = undefined;
          const t = copilot.continueUtterance();
          if (t !== undefined) conv.cancelledTurns.add(t);
          break;
        }
        if (typeof msg.turn === 'number') {
          conv.cancelledTurns.add(msg.turn);
          for (const t of conv.cancelledTurns) if (t < msg.turn - 50) conv.cancelledTurns.delete(t);
        }
        // Also cuts the turn still being generated (the user spoke while it was thinking).
        copilot.bargeIn();
        break;
      case 'focus': {
        if (conv.scope.mode === 'session') break;
        const sid =
          typeof msg.sessionId === 'string' && this.observer
            ? this.observer.sessions.get(msg.sessionId)?.sid
            : undefined;
        copilot.setFocus(sid);
        this.pushState(conv, true);
        break;
      }
      case 'read-only':
        page.readOnly = Boolean(msg.on);
        this.pushState(conv, true);
        break;
    }
  }

  private hello(page: Page, msg: Extract<CopilotClientMessage, { type: 'hello' }>) {
    if (msg.v !== COPILOT_PROTOCOL_VERSION) {
      this.send(page, { type: 'error', code: 'scope' });
      return;
    }
    const scope: CopilotScope =
      msg.mode === 'session' && typeof msg.sessionId === 'string' && msg.sessionId
        ? { mode: 'session', sessionId: msg.sessionId }
        : { mode: 'global' };
    page.readOnly = Boolean(msg.readOnly);
    if (msg.clipLang === 'en' || msg.clipLang === 'es') page.clipLang = msg.clipLang;
    if (page.clipLang && this.observer) this.observer.lang = page.clipLang;
    if (page.conv && page.conv.key !== scopeKey(scope)) this.leave(page);
    const conv = page.conv ?? this.conversation(scope);
    if (!page.conv) {
      page.conv = conv;
      conv.pages.add(page);
    }
    if (conv.idleTimer) clearTimeout(conv.idleTimer);
    conv.idleTimer = undefined;
    conv.active = page;
    page.lastState = undefined;
    this.keepAlive();
    this.pushState(conv, true);
    void this.sendClips(page, page.clipLang ?? (conv.copilot.lang === 'en' ? 'en' : 'es'));
    this.speech.warm(conv.copilot.lang);
    void this.speech.prewarm(FIXED_PHRASES, 'es');
    void this.warmBrain(conv);
    const greet = () => {
      if (page.conv === conv) conv.copilot.greet(page.id);
    };
    if (conv.view.firstPollDone) greet();
    else conv.view.once('poll', greet);
  }

  private async warmBrain(conv: Conversation) {
    const ok = await conv.brain.warm().catch(() => false);
    if (!ok && conv.brain.problem) {
      logger.warn(`copilot brain not started: ${conv.brain.problem}`);
      this.broadcast(conv, { type: 'error', code: conv.brain.problem });
    } else if (!ok) {
      this.broadcast(conv, { type: 'error', code: 'brain' });
    }
    this.pushState(conv, true);
  }

  private keepAlive() {
    if (this.keepAliveTimer) return;
    this.keepAliveTimer = every(
      'copilot keep alive',
      () => {
        if (this.pages.size) this.speech.keepAlive();
      },
      KEEP_ALIVE_MS
    );
    this.keepAliveTimer.unref?.();
  }

  // ------------------------------------------------------------------ conversations

  /** The shared source and observer, started with the first conversation. */
  private core(): Observer {
    if (this.observer) return this.observer;
    this.source = new SessionStateSource({
      access: this.deps.access,
      sessionEvents: this.deps.sessionEvents,
      refreshPids: this.deps.refreshPids,
      ...(this.deps.claudeDir ? { claudeDir: this.deps.claudeDir } : {}),
      ...this.deps.sourceOptions,
    });
    const observer = new Observer(this.source, this.deps.access, this.deps.observerOptions);
    observer.on('poll', () => {
      for (const conv of this.conversations.values()) this.pushState(conv, false);
    });
    observer.on('poll-error', (error) => logger.debug(`session look failed: ${error}`));
    this.observer = observer;
    observer.start();
    logger.log('copilot started');
    return observer;
  }

  private conversation(scope: CopilotScope): Conversation {
    const key = scopeKey(scope);
    const existing = this.conversations.get(key);
    if (existing) return existing;
    // Another scope nobody is on any more: its brain goes now (memory on the Mac).
    for (const other of Array.from(this.conversations.values())) {
      if (!other.pages.size) this.dispose(other);
    }
    const observer = this.core();
    const view: Conversation['view'] =
      scope.mode === 'session' ? new ScopedObserver(observer, scope.sessionId) : observer;
    const brain =
      this.deps.makeBrain?.() ??
      new Brain(SYSTEM_PROMPT, {
        pidFile: path.join(this.deps.dataDir, `copilot-brain-${key.replace(/[^\w-]/g, '_')}.pids`),
        ...this.deps.brain,
      });
    const conv: Conversation = {
      key,
      scope,
      view,
      brain,
      pages: new Set(),
      turnOwner: new Map(),
      turnOrigin: new Map(),
      cancelledTurns: new Set(),
      ttsChain: Promise.resolve(),
      copilot: new Copilot(view, this.loggedActions(), {
        brain,
        readonly: (source?: string) => {
          if (source) {
            const p = [...conv.pages].find((x) => x.id === source);
            return p ? p.readOnly : true;
          }
          // An announcement's turn (no page): never acts anyway; watch-only if any page is.
          return [...conv.pages].some((p) => p.readOnly);
        },
        clipMs: (c) => this.speech.clipMs(c) ?? 180 + 45 * c.text.length,
      }),
    };
    this.wire(conv);
    this.conversations.set(key, conv);
    return conv;
  }

  private scheduleIdleStop(conv: Conversation) {
    if (conv.idleTimer) clearTimeout(conv.idleTimer);
    conv.idleTimer = setTimeout(() => {
      if (!conv.pages.size) this.dispose(conv);
    }, this.deps.idleStopMs ?? IDLE_STOP_MS);
    conv.idleTimer.unref?.();
  }

  private dispose(conv: Conversation) {
    if (conv.idleTimer) clearTimeout(conv.idleTimer);
    conv.copilot.removeAllListeners();
    conv.copilot.shutdown();
    conv.view.dispose?.();
    this.conversations.delete(conv.key);
    if (!this.conversations.size && this.observer) {
      this.observer.stop();
      this.observer.removeAllListeners();
      this.observer = null;
      this.source = null;
      logger.log('copilot stopped (idle)');
    }
  }

  /** Session actions through the routes' code, logged without any text. */
  private loggedActions(): Pick<SessionAccess, 'input' | 'prompt' | 'answer' | 'reply'> {
    const access = this.deps.access;
    const note = (what: string, id: string, detail: string, r: AccessAnswer) => {
      logger.log(
        `copilot: ${what} ${id}${detail ? ` ${detail}` : ''} → ${r.status}${r.status === 200 ? '' : ` ${String(r.body.error ?? '')}`}`
      );
      return r;
    };
    return {
      prompt: (id) => access.prompt(id),
      input: async (id, input: SessionInput) =>
        note(
          input.key ? 'key' : 'text',
          id,
          input.key ? input.key : `(${input.text?.length ?? 0} chars)`,
          await access.input(id, input)
        ),
      answer: async (id, body) =>
        note('answer', id, `option ${body.option}`, await access.answer(id, body)),
      reply: async (id, body) =>
        note('reply', id, `(${body.text.length} chars)`, await access.reply(id, body)),
    };
  }

  // ------------------------------------------------------------------ copilot → pages

  private wire(conv: Conversation) {
    const copilot = conv.copilot;
    copilot.on('turn-start', (r: TurnRecord) => {
      conv.turnOrigin.set(r.turn, r.origin);
      for (const k of conv.turnOrigin.keys()) if (k < r.turn - 100) conv.turnOrigin.delete(k);
      for (const k of conv.turnOwner.keys()) if (k < r.turn - 100) conv.turnOwner.delete(k);
      const owner =
        (r.source && [...conv.pages].find((p) => p.id === r.source)) || this.activePage(conv);
      if (owner) conv.turnOwner.set(r.turn, owner);
      for (const p of conv.pages) {
        this.send(p, { type: 'turn-start', turn: r.turn, origin: r.origin, own: p === owner });
      }
    });
    copilot.on('sentence', (s: { turn: number; text: string; lang: string; index: number }) => {
      this.broadcast(conv, { type: 'sentence', ...s });
      // One sentence at a time, in order; dropped if its turn was cut, held while the user
      // talks (an announcement never lands on top of them).
      conv.ttsChain = conv.ttsChain.then(async () => {
        if (conv.cancelledTurns.has(s.turn) || !conv.pages.size) return;
        const isEvent = conv.turnOrigin.get(s.turn) === 'event';
        for (const piece of splitPieces(s.text, s.index === 0)) {
          const t0 = Date.now();
          const wav = await this.speech.synthesize(piece, s.lang);
          if (!wav || conv.cancelledTurns.has(s.turn)) return;
          for (
            let i = 0;
            i < (isEvent ? 300 : 40) && copilot.userSpeaking && !conv.cancelledTurns.has(s.turn);
            i++
          ) {
            await new Promise((r) => setTimeout(r, 50));
          }
          if (conv.cancelledTurns.has(s.turn)) return;
          logger.debug(`tts ${Date.now() - t0} ms (${piece.length} chars)`);
          const owner = this.ownerOf(conv, s.turn);
          if (owner) owner.ws.send(encodeAudioFrame(s.turn, s.index, wav));
        }
      });
    });
    copilot.on('turn-end', (r: TurnRecord) => {
      this.recordTurn(conv, r);
      // After the turn's last audio frame went out (2026-10-13, review: the page saw the end before
      // the answer's audio and flickered to «Mantén pulsado para hablar»).
      const end = () => this.sendTurnEnd(conv, r);
      if (r.speech.length) conv.ttsChain = conv.ttsChain.then(end, end);
      else end();
    });
    copilot.on(
      'action',
      (a: { kind: string; sid?: string; outcome: string; say?: string }, turn: number) => {
        this.outcomes[a.outcome] = (this.outcomes[a.outcome] ?? 0) + 1;
        this.broadcast(conv, {
          type: 'action',
          turn,
          kind: a.kind,
          sid: a.sid,
          outcome: a.outcome as never,
          say: a.say,
        });
      }
    );
    copilot.on('interject', (c: { turn: number; id: string; stage: string; lang: 'es' | 'en' }) => {
      if (conv.cancelledTurns.has(c.turn) || !this.speech.clip(c)) return;
      const owner = this.ownerOf(conv, c.turn);
      if (owner) {
        this.send(owner, {
          type: 'clip',
          turn: c.turn,
          id: c.id,
          lang: c.lang,
          stage: c.stage as 'A' | 'B' | 'hold',
        });
      }
    });
    copilot.on('earcon', (kind: 'done' | 'needs' | 'error' | 'tick') => {
      const p = this.activePage(conv);
      if (p) this.send(p, { type: 'earcon', kind });
    });
    copilot.on('stop-audio', () => this.broadcast(conv, { type: 'stop-audio' }));
    copilot.on('brain-error', () =>
      this.broadcast(conv, { type: 'error', code: conv.brain.problem ?? 'brain' })
    );
  }

  private recordTurn(conv: Conversation, r: TurnRecord) {
    const t = r.timings;
    logger.log(
      `turn ${r.turn} ${conv.key === 'all' ? 'global' : 'session'} ${r.origin}${r.fastPath ? `/${r.fastPath}` : ''}: ${r.actions.length} actions, ${r.speech.length} sentences, first sentence ${t.firstSentenceMs ?? '-'} ms, first token ${t.firstTokenMs ?? '-'} ms${t.fromTransitionMs !== undefined ? `, ${t.fromTransitionMs} ms after the change` : ''}${r.cancelled ? ', cut' : ''}`
    );
    this.turns.push({
      turn: r.turn,
      scope: conv.scope.mode,
      origin: r.origin,
      fastPath: r.fastPath,
      actions: r.actions.map((a) => ({ kind: a.kind, outcome: a.outcome })),
      timings: { ...t },
      cancelled: Boolean(r.cancelled),
    });
    if (this.turns.length > 200) this.turns.shift();
  }

  private chips(conv: Conversation): CopilotSessionChip[] {
    return conv.view.list().map((s) => ({
      sid: s.sid,
      sessionId: s.id,
      name: s.name,
      status: s.status as CopilotSessionStatus,
      error: Boolean(s.lastError) && s.status === 'idle',
      focus: conv.copilot.focusSid === s.sid,
      muted: Boolean(s.muted),
    }));
  }

  private stateFor(conv: Conversation, page: Page): CopilotServerMessage {
    return {
      type: 'state',
      scope: conv.scope,
      sessions: this.chips(conv),
      pending: conv.copilot.gate.fresh()?.restatement ?? null,
      readOnly: page.readOnly,
      speech: this.speech.status(),
      brain: conv.brain.state,
      connected: conv.view.connected,
    };
  }

  /** The state to every page of `conv` whose copy changed (or to all, `force`). */
  private pushState(conv: Conversation, force: boolean) {
    for (const p of conv.pages) {
      const m = JSON.stringify(this.stateFor(conv, p));
      if (!force && m === p.lastState) continue;
      p.lastState = m;
      if (p.ws.readyState === p.ws.OPEN) p.ws.send(m);
    }
    // The greeting for the new state, synthesized ahead: connecting plays it at once.
    const g = conv.copilot.greetText();
    if (g !== conv.lastGreet && conv.pages.size) {
      conv.lastGreet = g;
      void this.speech.synthesize(g, conv.copilot.lang);
    }
  }

  /** The interjection pool for one language: a manifest, then one binary frame per clip. */
  private async sendClips(page: Page, lang: 'es' | 'en') {
    page.clipLang = lang;
    await this.speech.renderClips();
    if (page.ws.readyState !== page.ws.OPEN) return;
    const list = CLIPS.map((c, n) => ({ n, c })).filter(
      ({ c }) => c.lang === lang && this.speech.clip(c)
    );
    this.send(page, {
      type: 'clips',
      lang,
      clips: list.map(({ n, c }) => ({ n, id: c.id, cat: c.cat, text: c.text })),
    });
    for (const { n, c } of list) {
      const wav = this.speech.clip(c);
      if (wav) page.ws.send(encodeAudioFrame(CLIP_TURN, n, wav));
    }
  }

  private sendTurnEnd(conv: Conversation, r: TurnRecord) {
    const owner = this.ownerOf(conv, r.turn);
    for (const p of conv.pages) {
      this.send(p, {
        type: 'turn-end',
        turn: r.turn,
        origin: r.origin,
        speech: r.speech,
        actions: r.actions.map((a) => ({ kind: a.kind, sid: a.sid, outcome: a.outcome })),
        timings: r.timings,
        cancelled: Boolean(r.cancelled),
        own: p === owner,
      });
    }
    this.pushState(conv, true);
  }

  // ------------------------------------------------------------------ utterances

  /** Transcribe one utterance: names in the prompt so «login» is not «Lojin». */
  private transcribe(conv: Conversation, wav: Buffer) {
    // Detect the language on the first utterance, then keep the conversation's (detecting
    // costs ~0.5 s per utterance).
    const lang = conv.sttLang ?? 'auto';
    // Every session's name, in session mode too (2026-10-13, review: «mediguiapp» became
    // «Mediguiap» when only the open session was hinted). The scope's own name goes first.
    const names = [...conv.view.list(), ...(conv.view.others?.() ?? [])]
      .filter((x) => x.running)
      .map((x) => x.name)
      .slice(0, 8)
      .join(', ');
    const prompt = `${names ? `${names}. ` : ''}confirmo, déjale, para, sí, no.`;
    return this.speech.transcribe(wav, lang, prompt);
  }

  private utterance(
    conv: Conversation,
    page: Page,
    r: { text: string; ms: number } | null,
    at: number,
    epoch: number,
    how: string,
    startedAt?: number
  ) {
    if (!r) {
      this.send(page, { type: 'transcript', text: '', error: 'stt' });
      return;
    }
    conv.sttLang = detectLang(r.text, conv.copilot.lang);
    this.sttMs.push(r.ms);
    if (this.sttMs.length > 200) this.sttMs.shift();
    logger.debug(`stt ${r.ms} ms (${how}, ${r.text.length} chars, ready ${Date.now() - at} ms)`);
    const accepted = conv.copilot.userSaid(r.text, at, { epoch, source: page.id, startedAt });
    this.send(page, { type: 'transcript', text: r.text, ms: r.ms, ignored: !accepted });
    const want = conv.copilot.lang === 'en' ? 'en' : 'es';
    if (page.clipLang && page.clipLang !== want) void this.sendClips(page, want);
    if (this.observer) this.observer.lang = want;
  }

  // ------------------------------------------------------------------ status, shutdown

  status() {
    const series = (pick: (t: TurnRecord['timings']) => number | undefined) => {
      const values = this.turns
        .map((t) => pick(t.timings))
        .filter((v): v is number => v !== undefined);
      return { n: values.length, p50: percentile(values, 50), p90: percentile(values, 90) };
    };
    const userTurns = (pick: (t: TurnRecord['timings']) => number | undefined) =>
      series((t) => pick(t));
    return {
      started: this.started,
      pages: this.pages.size,
      conversations: [...this.conversations.values()].map((c) => ({
        scope: c.scope.mode,
        pages: c.pages.size,
        brain: c.brain.state,
        problem: c.brain.problem,
      })),
      speech: this.speech.status(),
      clips: {
        ready: this.speech.clipPool.size,
        total: CLIPS.length,
        failed: this.speech.clipFailed,
      },
      source: this.source
        ? {
            looks: this.source.looks,
            lastLookMs: this.source.lastLookMs,
            watching: this.source.watching,
          }
        : null,
      outcomes: { ...this.outcomes },
      latency: {
        sttMs: {
          n: this.sttMs.length,
          p50: percentile(this.sttMs, 50),
          p90: percentile(this.sttMs, 90),
        },
        firstTokenMs: userTurns((t) => t.firstTokenMs),
        firstSentenceMs: userTurns((t) => t.firstSentenceMs),
        firstContentMs: userTurns((t) => t.firstContentMs),
        interjectMs: userTurns((t) => t.interjectMs),
        fromTransitionMs: userTurns((t) => t.fromTransitionMs),
      },
      turns: this.turns.slice(-20),
    };
  }

  shutdown(): void {
    this.closed = true;
    for (const conv of Array.from(this.conversations.values())) this.dispose(conv);
    for (const p of this.pages) {
      try {
        p.ws.close();
      } catch {
        // Gone.
      }
    }
    this.pages.clear();
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
  }
}
