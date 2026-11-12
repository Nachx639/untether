/**
 * One line on the home's cards (2026-11-08, user report: the home cards said too much):
 * what an agent session is doing now, or why it stopped, in ≤ 80 characters and the user's
 * language, written by a cheap model (taskModels' Claude fast level when set, else haiku) from
 * the end of its conversation. Idea from Herdr's agent.explain.
 *
 * Never in the way of the session list: `explain()` answers from the cache at once and, only
 * when what the list shows of the session changed (its fingerprint: status, what it waits for,
 * its current step, its last message), starts one model call in the background. A session is
 * asked again at most every `minIntervalMs` while it works (each tool call changes its step),
 * sooner when its status itself changes; every session together at most `maxPerHour` times an
 * hour, `maxConcurrent` at a time. Secrets are masked (security-sweep redactSecrets) before
 * anything leaves the Mac and again in the reply. A line written for another status (it said
 * «ejecutando los tests» and the session now waits for the user) is not shown: the card falls
 * back to its own short status until the new one is in. Off with the `agentExplain` setting.
 */
import { createHash } from 'node:crypto';
import type { Session } from '../../shared/types.js';
import type { ClaudeChat, ClaudeChatMessage } from './claude-chat.js';
import { redactSecrets } from './security-sweep.js';

/** What a card shows: the line, and when it was written (epoch ms). */
export interface AgentExplanation {
  text: string;
  at: number;
}

/** The longest line a card shows. */
export const EXPLAIN_MAX_CHARS = 80;
/** While it works: a session is asked again at most this often. */
export const EXPLAIN_MIN_INTERVAL_MS = 2 * 60_000;
/** Its status changed (working → waiting, idle…): asked again after this at the soonest. */
export const EXPLAIN_STATUS_INTERVAL_MS = 15_000;
/** Every session together, per hour. */
export const EXPLAIN_MAX_PER_HOUR = 60;
export const EXPLAIN_MAX_CONCURRENT = 2;
/** The conversation's end the model reads: so many messages, each and all clipped. */
const TAIL_MESSAGES = 8;
const MESSAGE_CHARS = 500;
const MATERIAL_CHARS = 3500;
/** Each status line at most this long, so the status always fits whole (4 lines). */
const HEAD_LINE_CHARS = 600;
/** A line that could not be written (no answer, an error) is tried again so many times. */
const MAX_FAILURES = 3;
const MAX_ENTRIES = 300;

/** Languages the client speaks (i18n SUPPORTED_LOCALES), by their English name for the model. */
const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  es: 'Spanish (Spain)',
  fr: 'French',
  'pt-BR': 'Brazilian Portuguese',
  'zh-CN': 'Simplified Chinese',
  hi: 'Hindi',
  ar: 'Arabic',
  bn: 'Bengali',
};

export function explainLanguage(lang: unknown): string {
  return typeof lang === 'string' && lang in LANGUAGE_NAMES ? lang : 'en';
}

export const EXPLAIN_SYSTEM_PROMPT = [
  'You write the one status line a dashboard shows for a coding agent session.',
  'From the end of its conversation, say what the agent is doing right now or, if it stopped,',
  'why (finished, waiting for an answer or a permission, an error, a usage limit).',
  'At most 80 characters, one line, in the language asked for. No quotes, no markdown, no',
  'emoji, no file paths longer than a file name, no secrets or tokens. Start with a verb or the',
  'reason; never with the agent name. Reply with the line only.',
].join(' ');

/** One line, clipped to `max` characters with an ellipsis. */
export function clipLine(text: string, max = EXPLAIN_MAX_CHARS): string {
  const line = text
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = [...line];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : line;
}

/** The model's reply as a card line: first non-empty line, no quotes or markdown, redacted. */
export function cleanExplanation(reply: string | null | undefined): string {
  if (!reply) return '';
  const first =
    reply
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean) ?? '';
  const bare = first
    .replace(/^[-*#>\s]+/, '')
    .replace(/^["'«“`]+|["'»”`]+$/g, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .trim();
  return clipLine(redactSecrets(bare));
}

type ListSession = Pick<
  Session,
  'id' | 'status' | 'claudeStatus' | 'codexActive' | 'geminiActive' | 'lastLine'
>;

/** Sessions with an agent conversation to explain: running Claude, Codex or Gemini. */
export function explainable(session: ListSession): boolean {
  if (session.status !== 'running') return false;
  return Boolean(session.claudeStatus || session.codexActive || session.geminiActive);
}

/** The status part of the fingerprint: a line is only shown under the status it was made for. */
export function explainStatusKey(session: ListSession): string {
  const claude = session.claudeStatus;
  if (!claude) return session.codexActive ? 'codex' : session.geminiActive ? 'gemini' : '';
  const status = claude.waitingForBackground ? 'background' : claude.status;
  return [status, claude.waitingFor ?? ''].join('|');
}

/**
 * What the list shows of a session that a new line would have to account for: its status,
 * its current step (tool and subject, not its start time) and its last message.
 */
export function explainFingerprint(session: ListSession): string {
  const claude = session.claudeStatus;
  const parts = [
    explainStatusKey(session),
    claude?.activity ? `${claude.activity.kind}|${claude.activity.tool ?? ''}` : '',
    claude?.activity?.target ?? '',
    claude?.preview ? `${claude.preview.role}|${claude.preview.text}` : '',
    claude?.choices ? `${claude.choices.question}|${(claude.choices.detail ?? []).join(' ')}` : '',
    claude ? '' : (session.lastLine ?? ''),
  ];
  return createHash('sha1').update(parts.join('\0')).digest('base64url').slice(0, 16);
}

function messageLine(message: ClaudeChatMessage): string {
  if (message.role === 'tool') {
    const subject = (message.detail || message.text || '').replace(/\s+/g, ' ').trim();
    const result = message.isError
      ? ` → error: ${(message.result ?? '').split('\n').slice(0, 2).join(' ')}`
      : message.result === undefined
        ? ' (running)'
        : '';
    return clipLine(`[tool ${message.tool ?? ''}] ${subject}${result}`, MESSAGE_CHARS);
  }
  return clipLine(`[${message.role}] ${message.text}`, MESSAGE_CHARS);
}

/** What the model reads: the status and the end of the conversation, secrets masked. */
export function explainMaterial(
  session: ListSession,
  chat: Pick<ClaudeChat, 'available' | 'messages'> | null
): string {
  const claude = session.claudeStatus;
  const head = [
    `Status: ${claude?.waitingForBackground ? 'reply done, background agents still running' : (claude?.status ?? 'running')}`,
    claude?.waitingFor ? `Waiting for: ${claude.waitingFor}` : '',
    claude?.activity
      ? `Current step: ${claude.activity.kind}${claude.activity.tool ? ` ${claude.activity.tool}` : ''}${claude.activity.target ? ` ${claude.activity.target}` : ''}`
      : '',
    claude?.choices
      ? `On screen: ${claude.choices.question} ${(claude.choices.detail ?? []).join(' ')} [${claude.choices.options.join(' / ')}]`
      : '',
  ]
    .filter(Boolean)
    .map((line) => clipLine(line, HEAD_LINE_CHARS));
  const tail = chat?.available
    ? chat.messages.slice(-TAIL_MESSAGES).map(messageLine)
    : [
        claude?.preview ? `[${claude.preview.role}] ${claude.preview.text}` : '',
        session.lastLine ? `[screen] ${session.lastLine}` : '',
      ].filter(Boolean);
  // The status always goes whole (a pending permission is not in the transcript); only the
  // conversation is cut, from its start: the newest lines matter most.
  const top = [...head, 'Conversation end:'].join('\n');
  let conversation = tail.join('\n');
  const room = MATERIAL_CHARS - top.length - 1;
  if (conversation.length > room)
    conversation = `…${conversation.slice(conversation.length - room + 1)}`;
  return redactSecrets(`${top}\n${conversation}`);
}

export interface AgentExplainerOptions {
  /** Asks the model; null = no answer (no claude, no login, timed out). */
  ask: (systemPrompt: string, question: string) => Promise<string | null>;
  /** The session's conversation (null when it can't be read: the list's own fields then). */
  readChat: (sessionId: string) => Promise<Pick<ClaudeChat, 'available' | 'messages'> | null>;
  /** The setting (default on). */
  enabled?: () => boolean;
  now?: () => number;
  minIntervalMs?: number;
  statusIntervalMs?: number;
  maxPerHour?: number;
  maxConcurrent?: number;
  onError?: (error: unknown) => void;
}

interface Entry {
  /** The fingerprint the line (or the call under way) is for. */
  fingerprint: string;
  statusKey: string;
  text?: string;
  /** The status key the shown line was made for. */
  textStatusKey?: string;
  at?: number;
  /** When the last call started. */
  askedAt: number;
  pending: boolean;
  /** Calls in a row for this fingerprint with no usable answer (retried up to MAX_FAILURES). */
  failures: number;
}

export interface AgentExplainer {
  /**
   * The line for a session as the list shows it now, if one fits its status; starts a new one
   * in the background when the session changed and the limits allow it.
   */
  explain(session: ListSession, lang?: string): AgentExplanation | undefined;
  /** Model calls started so far (tests, doctor). */
  readonly calls: number;
  /** Resolves when every call under way is over (tests). */
  idle(): Promise<void>;
  /** Forget sessions that are gone. */
  prune(liveIds: ReadonlySet<string>): void;
}

export function createAgentExplainer(options: AgentExplainerOptions): AgentExplainer {
  const now = options.now ?? Date.now;
  const minInterval = options.minIntervalMs ?? EXPLAIN_MIN_INTERVAL_MS;
  const statusInterval = options.statusIntervalMs ?? EXPLAIN_STATUS_INTERVAL_MS;
  const maxPerHour = options.maxPerHour ?? EXPLAIN_MAX_PER_HOUR;
  const maxConcurrent = options.maxConcurrent ?? EXPLAIN_MAX_CONCURRENT;
  const entries = new Map<string, Entry>();
  const recentCalls: number[] = [];
  const inFlight = new Set<Promise<void>>();
  let calls = 0;

  const roomForCall = (at: number) => {
    while (recentCalls.length && at - (recentCalls[0] as number) >= 3_600_000) recentCalls.shift();
    return recentCalls.length < maxPerHour && inFlight.size < maxConcurrent;
  };

  /**
   * No usable answer (no claude or login yet, a timeout, an error): the same fingerprint is
   * asked again after the usual wait, up to MAX_FAILURES times, so a session that stays as it
   * is still gets its line once the model answers again (2026-11-08 review). A line written
   * earlier stays shown meanwhile.
   */
  const failed = (entry: Entry) => {
    entry.failures++;
  };

  const start = (key: string, entry: Entry, session: ListSession, lang: string) => {
    const at = now();
    entry.pending = true;
    entry.askedAt = at;
    recentCalls.push(at);
    calls++;
    const statusKey = entry.statusKey;
    const job = (async () => {
      try {
        const chat = await options.readChat(session.id).catch(() => null);
        const question = `Language: ${LANGUAGE_NAMES[lang]}\n\n${explainMaterial(session, chat)}`;
        const text = cleanExplanation(await options.ask(EXPLAIN_SYSTEM_PROMPT, question));
        const current = entries.get(key);
        if (!current) return;
        current.pending = false;
        if (!text) {
          failed(current);
          return;
        }
        current.failures = 0;
        // Even when the session moved on meanwhile: shown only under the status it fits.
        current.text = text;
        current.textStatusKey = statusKey;
        current.at = now();
      } catch (error) {
        const current = entries.get(key);
        if (current) {
          current.pending = false;
          failed(current);
        }
        options.onError?.(error);
      }
    })();
    inFlight.add(job);
    void job.finally(() => inFlight.delete(job));
  };

  return {
    explain(session, langRaw) {
      if (options.enabled && !options.enabled()) return undefined;
      if (!explainable(session)) return undefined;
      const lang = explainLanguage(langRaw);
      const key = `${session.id}\0${lang}`;
      const fingerprint = explainFingerprint(session);
      const statusKey = explainStatusKey(session);
      let entry = entries.get(key);
      const at = now();
      if (!entry) {
        entry = {
          fingerprint: '',
          statusKey,
          askedAt: Number.NEGATIVE_INFINITY,
          pending: false,
          failures: 0,
        };
        entries.set(key, entry);
        while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value as string);
      }
      const changed = entry.fingerprint !== fingerprint;
      const retry = !changed && entry.failures > 0 && entry.failures < MAX_FAILURES;
      if ((changed || retry) && !entry.pending) {
        const wait = entry.statusKey !== statusKey ? statusInterval : minInterval;
        if (at - entry.askedAt >= wait && roomForCall(at)) {
          if (changed) entry.failures = 0;
          entry.fingerprint = fingerprint;
          entry.statusKey = statusKey;
          start(key, entry, session, lang);
        }
      }
      if (entry.text && entry.at !== undefined && entry.textStatusKey === statusKey) {
        return { text: entry.text, at: entry.at };
      }
      return undefined;
    },
    get calls() {
      return calls;
    },
    async idle() {
      while (inFlight.size) await Promise.all(inFlight);
    },
    prune(liveIds) {
      for (const key of entries.keys()) {
        if (!liveIds.has(key.split('\0')[0] as string)) entries.delete(key);
      }
    },
  };
}
