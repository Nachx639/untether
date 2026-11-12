/**
 * "While you were away": what an agent session did since the user last looked at it, built
 * deterministically from the chat the transcript readers already keep (bounded tail, cached
 * per transcript). No model call: files edited, commands run, errors, messages and status.
 */
import type { ClaudeChat, ClaudeChatMessage } from './claude-chat.js';

export type AwayStatus = 'working' | 'waiting' | 'done' | 'unknown';

export interface AwayFile {
  path: string;
  edits: number;
}

export interface AwayCommand {
  command: string;
  isError?: boolean;
  exitCode?: number;
  /** No result yet: still running (or interrupted). */
  pending?: boolean;
  timestamp?: string;
}

export interface AwayError {
  tool: string;
  target?: string;
  text: string;
  timestamp?: string;
}

export interface AwaySummary {
  available: boolean;
  agent?: string;
  /** The `since` the summary covers (ISO), rounded down to the cache bucket. */
  since?: string;
  /** Latest agent step in the summary (ISO). */
  lastActivityAt?: string;
  toolCalls: number;
  messages: number;
  files: AwayFile[];
  commands: AwayCommand[];
  errors: AwayError[];
  /** Excerpt of the agent's last message since `since` (plain text). */
  lastMessage?: string;
  status: AwayStatus;
  /** True when the agent's history kept in memory starts after `since`. */
  partial?: boolean;
}

const MAX_FILES = 40;
const MAX_COMMANDS = 40;
const MAX_ERRORS = 20;
const COMMAND_MAX = 200;
const ERROR_MAX = 240;
const LAST_MESSAGE_MAX = 400;
/** The chat readers keep this many messages; reaching it means older ones were dropped. */
const CHAT_MESSAGE_CAP = 400;

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const COMMAND_TOOLS = new Set(['Bash', 'shell', 'exec_command', 'run_shell_command']);

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

function editedFiles(tool: ClaudeChatMessage): string[] {
  const detail = tool.detail ?? '';
  // MultiEdit's detail is its input as JSON (possibly cut short): take file_path from it.
  const json = detail.match(/"(?:file_path|notebook_path)"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (json) {
    try {
      return [JSON.parse(`"${json[1]}"`) as string];
    } catch {
      return [json[1]];
    }
  }
  // Claude: one path. Codex apply_patch: one path per line.
  const lines = detail
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length > 0) return lines;
  return tool.text ? [tool.text] : [];
}

function commandOf(tool: ClaudeChatMessage): string {
  const detail = tool.detail?.startsWith('$ ') ? tool.detail.slice(2) : tool.detail;
  return clip((detail || tool.text || '').replace(/\s+/g, ' ').trim(), COMMAND_MAX);
}

function exitCodeOf(result: string | undefined): number | undefined {
  const match = result?.match(/exit(?:ed with)? code:?\s*(-?\d+)/i);
  return match ? Number(match[1]) : undefined;
}

function plain(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function statusOf(chat: ClaudeChat): AwayStatus {
  const last = chat.messages[chat.messages.length - 1];
  if (chat.status === 'waiting') return 'waiting';
  // Background agents keep Claude "busy" after its reply: the turn is done.
  if (chat.status === 'busy' && chat.waitingForBackground) return 'done';
  if (chat.status === 'busy') {
    // AskUserQuestion with no answer yet: Claude waits for the user even while "busy".
    return last?.role === 'tool' && last.question && last.result === undefined
      ? 'waiting'
      : 'working';
  }
  if (chat.status === 'idle') return 'done';
  return 'unknown';
}

/** Summary of the agent's work after `sinceMs` (pure: exported for tests). */
export function buildAwaySummary(chat: ClaudeChat, sinceMs: number): AwaySummary {
  const summary: AwaySummary = {
    available: chat.available,
    agent: (chat as { agent?: string }).agent ?? (chat.available ? 'claude' : undefined),
    since: Number.isFinite(sinceMs) ? new Date(sinceMs).toISOString() : undefined,
    toolCalls: 0,
    messages: 0,
    files: [],
    commands: [],
    errors: [],
    status: chat.available ? statusOf(chat) : 'unknown',
  };
  if (!chat.available) return summary;

  const files = new Map<string, AwayFile>();
  let lastAt = Number.NEGATIVE_INFINITY;
  let firstSeenAt: number | undefined;
  for (const message of chat.messages) {
    const at = message.timestamp ? Date.parse(message.timestamp) : Number.NaN;
    if (Number.isNaN(at)) continue;
    if (firstSeenAt === undefined) firstSeenAt = at;
    if (at <= sinceMs) continue;
    if (message.role === 'assistant') {
      summary.messages++;
      summary.lastMessage = clip(plain(message.text), LAST_MESSAGE_MAX);
    } else if (message.role === 'tool') {
      summary.toolCalls++;
      const tool = message.tool ?? '';
      if (EDIT_TOOLS.has(tool)) {
        for (const file of editedFiles(message)) {
          const entry = files.get(file) ?? { path: file, edits: 0 };
          entry.edits++;
          files.set(file, entry);
        }
      } else if (COMMAND_TOOLS.has(tool)) {
        const exitCode = exitCodeOf(message.isError ? message.result : undefined);
        summary.commands.push({
          command: commandOf(message),
          isError: message.isError || undefined,
          exitCode,
          pending: message.result === undefined || undefined,
          timestamp: message.timestamp,
        });
      }
      if (message.isError) {
        const firstLines = (message.result ?? '').split('\n').slice(0, 3).join(' ');
        summary.errors.push({
          tool,
          target: message.text ? clip(message.text, 80) : undefined,
          text: clip(firstLines.replace(/\s+/g, ' ').trim(), ERROR_MAX),
          timestamp: message.timestamp,
        });
      }
    } else {
      continue;
    }
    lastAt = Math.max(lastAt, at);
  }
  if (lastAt > Number.NEGATIVE_INFINITY) summary.lastActivityAt = new Date(lastAt).toISOString();
  if (
    chat.messages.length >= CHAT_MESSAGE_CAP &&
    firstSeenAt !== undefined &&
    firstSeenAt > sinceMs
  ) {
    summary.partial = true;
  }
  // Most edited first; the most recent commands and errors are the ones that matter.
  summary.files = [...files.values()].sort((a, b) => b.edits - a.edits).slice(0, MAX_FILES);
  summary.commands = summary.commands.slice(-MAX_COMMANDS);
  summary.errors = summary.errors.slice(-MAX_ERRORS);
  return summary;
}
