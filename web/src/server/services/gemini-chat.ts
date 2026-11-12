/**
 * Google Gemini CLI chat reader.
 *
 * Gemini CLI is a full-screen TUI like Claude Code and Codex, so the phone chat view reads the
 * conversation from Gemini's own chat recording instead of the screen. Gemini keeps one folder
 * per project under ~/.gemini/tmp (or $GEMINI_CLI_HOME/.gemini/tmp):
 *  - older releases: tmp/<sha256 hex of the project root>/chats/session-<UTC minute>-<id>.json,
 *    one JSON document rewritten on every change;
 *  - newer releases: tmp/<short name>/chats/session-<UTC minute>-<id>.jsonl, where the short
 *    name comes from ~/.gemini/projects.json ({ projects: { "/abs/root": "name" } }); the file
 *    is a metadata line followed by appended message records and `$set` / `$patch` /
 *    `$rewindTo` updates.
 * (Both layouts checked on macOS against real ~/.gemini folders, 2026-10-02.)
 * An Untether session running `gemini` is matched to the newest chat started in its
 * directory after the session began. The result has the same shape as the Claude chat.
 *
 * Read-only: nothing here writes, and nothing shells out.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ClaudeChat, ClaudeChatMessage } from './claude-chat.js';
import { commandProgram } from './codex-chat.js';

export interface GeminiChat extends ClaudeChat {
  agent: 'gemini';
}

/** Where Gemini keeps its state (~/.gemini, or $GEMINI_CLI_HOME/.gemini). */
export function defaultGeminiDir(): string {
  return path.join(process.env.GEMINI_CLI_HOME || os.homedir(), '.gemini');
}

/** Whether a session command runs Gemini CLI (`gemini`, `/opt/bin/gemini …`, `zsh -lc "gemini"`). */
export function isGeminiCommand(command: string[] | undefined): boolean {
  if (!Array.isArray(command)) return false;
  // Another agent that only names it is not Gemini (see isCodexCommand).
  if (['claude', 'codex'].includes(commandProgram(command))) return false;
  return command.some((arg) =>
    arg
      .trim()
      .split(/\s+/)
      .some((word) => word.split('/').pop() === 'gemini')
  );
}

const MAX_MESSAGES = 400;
/** Chat files are read whole: skip absurdly large ones. */
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_CACHED_CHATS = 20;
/** File names carry the UTC minute; Gemini may also stamp it before the session start. */
const START_SKEW_MS = 90_000;
/** A prompt or a tool call without result counts as running this long after the last write. */
const BUSY_WINDOW_MS = 2 * 60_000;
const MATCH_RECHECK_MS = 10_000;
const MAX_RESULT_CHARS = 1500;
const MAX_RESULT_LINES = 20;
const TITLE_MAX = 80;

const truncate = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

function truncateResult(text: string): string {
  const lines = text.split('\n');
  let result = lines.slice(0, MAX_RESULT_LINES).join('\n');
  if (result.length > MAX_RESULT_CHARS) result = result.slice(0, MAX_RESULT_CHARS);
  return result.length < text.trimEnd().length ? `${result.trimEnd()}\n…` : result.trimEnd();
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const str = (value: unknown) => (typeof value === 'string' ? value : '');

/** Text of a Gemini content value: a string or a list of `{ text }` parts. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (isObject(part) && typeof part.text === 'string' ? part.text : ''))
    .join('');
}

/** What a tool call row shows: a familiar tool name and its subject. */
function toolSummary(name: string, args: Json): { tool: string; text: string; detail?: string } {
  const file = str(args.file_path) || str(args.absolute_path) || str(args.path);
  switch (name) {
    case 'run_shell_command': {
      const command = str(args.command);
      return { tool: 'Bash', text: command, detail: command ? `$ ${command}` : undefined };
    }
    case 'read_file':
      return { tool: 'Read', text: path.basename(file), detail: file || undefined };
    case 'write_file':
      return { tool: 'Write', text: path.basename(file), detail: file || undefined };
    case 'replace':
    case 'edit':
      return { tool: 'Edit', text: path.basename(file), detail: file || undefined };
    case 'list_directory': {
      const dir = str(args.dir_path) || file;
      return { tool: 'LS', text: dir, detail: dir || undefined };
    }
    case 'glob':
      return { tool: 'Glob', text: str(args.pattern) };
    case 'search_file_content':
    case 'grep_search':
    case 'grep':
      return { tool: 'Grep', text: str(args.pattern) };
    case 'google_web_search':
      return { tool: 'WebSearch', text: str(args.query) };
    case 'web_fetch':
      return { tool: 'WebFetch', text: truncate(str(args.prompt) || str(args.url), 120) };
    default: {
      const detail = Object.keys(args).length ? JSON.stringify(args) : '';
      return { tool: name, text: '', detail: truncate(detail, 400) || undefined };
    }
  }
}

/** Output of a finished tool call (undefined while it has none yet). */
function toolResult(call: Json): { text: string; isError: boolean } | undefined {
  const status = str(call.status);
  const isError = status === 'error' || status === 'cancelled';
  let text = '';
  if (Array.isArray(call.result)) {
    for (const part of call.result) {
      const response =
        isObject(part) && isObject(part.functionResponse)
          ? part.functionResponse.response
          : undefined;
      if (!isObject(response)) continue;
      text = str(response.output) || str(response.error) || text;
    }
  }
  if (!text && typeof call.resultDisplay === 'string') text = call.resultDisplay;
  if (!text && !status && call.result === undefined) return undefined;
  // run_shell_command answers "Command: …\nDirectory: …\nOutput: …\nExit Code: …".
  if (text.startsWith('Command: ')) {
    const start = text.indexOf('\nOutput: ');
    if (start >= 0) {
      const lines = text.slice(start + '\nOutput: '.length).split('\n');
      const trailer = /^(?:Error|Exit Code|Signal|Background PIDs|Process Group PGID): /;
      while (lines.length > 1 && trailer.test(lines[lines.length - 1])) lines.pop();
      text = lines.join('\n');
      if (text === '(empty)') text = '';
    }
  }
  return { text: truncateResult(text), isError };
}

/** Chat messages of one Gemini message record (exported for tests). */
export function geminiRecordMessages(record: Json): ClaudeChatMessage[] {
  const id = str(record.id);
  const timestamp = str(record.timestamp) || undefined;
  const type = record.type;
  if (type === 'user') {
    const text = contentText(record.displayContent ?? record.content).trim();
    return text ? [{ id, role: 'user', text, timestamp }] : [];
  }
  if (type === 'info' || type === 'error' || type === 'warning') {
    const text = contentText(record.content).trim();
    return type !== 'info' && text ? [{ id, role: 'note', text, timestamp }] : [];
  }
  if (type !== 'gemini') return [];
  const messages: ClaudeChatMessage[] = [];
  const text = contentText(record.content).trim();
  if (text) messages.push({ id, role: 'assistant', text, timestamp });
  const calls = Array.isArray(record.toolCalls) ? record.toolCalls : [];
  calls.forEach((call, i) => {
    if (!isObject(call)) return;
    const name = str(call.name) || 'tool';
    const summary = toolSummary(name, isObject(call.args) ? call.args : {});
    const result = toolResult(call);
    messages.push({
      id: `${id}:tool:${i}`,
      role: 'tool',
      ...summary,
      timestamp: str(call.timestamp) || timestamp,
      toolUseId: str(call.id) || undefined,
      result: result?.text,
      isError: result?.isError || undefined,
    });
  });
  return messages;
}

/** Message records of a chat file, in order (`.json` document or `.jsonl` log). */
export function parseGeminiChatFile(raw: string, jsonl: boolean): Json[] {
  if (!jsonl) {
    try {
      const doc = JSON.parse(raw);
      return isObject(doc) && Array.isArray(doc.messages) ? doc.messages.filter(isObject) : [];
    } catch {
      return [];
    }
  }
  const records = new Map<string, Json>();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue; // a line still being written
    }
    if (!isObject(record)) continue;
    if (typeof record.$rewindTo === 'string') {
      let found = false;
      for (const id of Array.from(records.keys())) {
        if (id === record.$rewindTo) found = true;
        if (found) records.delete(id);
      }
      if (!found) records.clear();
    } else if (isObject(record.$patch)) {
      const patch = record.$patch;
      const updates = [patch, ...(Array.isArray(patch.updates) ? patch.updates : [])];
      for (const update of updates) {
        if (!isObject(update) || typeof update.id !== 'string') continue;
        const existing = records.get(update.id);
        if (!existing) continue;
        if (update.content !== undefined) existing.content = update.content;
        if (Array.isArray(update.toolCalls) && Array.isArray(existing.toolCalls)) {
          for (const callPatch of update.toolCalls) {
            if (!isObject(callPatch)) continue;
            const call = existing.toolCalls.find(
              (c: unknown) => isObject(c) && c.id === callPatch.id
            );
            if (isObject(call)) Object.assign(call, callPatch);
          }
        }
      }
      if (Array.isArray(patch.removeIds)) {
        for (const id of patch.removeIds) if (typeof id === 'string') records.delete(id);
      }
    } else if (isObject(record.$set)) {
      if (Array.isArray(record.$set.messages)) {
        records.clear();
        for (const message of record.$set.messages) {
          if (isObject(message) && typeof message.id === 'string') records.set(message.id, message);
        }
      }
    } else if (typeof record.id === 'string') {
      // A record with a known id replaces it (a streamed message or a finished tool call).
      records.delete(record.id);
      records.set(record.id, record);
    } else if (Array.isArray(record.messages)) {
      // Metadata line of a rewritten log.
      for (const message of record.messages) {
        if (isObject(message) && typeof message.id === 'string') records.set(message.id, message);
      }
    }
  }
  return [...records.values()];
}

interface ChatCache {
  mtimeMs: number;
  size: number;
  messages: ClaudeChatMessage[];
  title?: string;
}

const chatCache = new Map<string, ChatCache>();

function readChat(chatPath: string): ChatCache {
  const stat = fs.statSync(chatPath);
  const cached = chatCache.get(chatPath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    chatCache.delete(chatPath);
    chatCache.set(chatPath, cached);
    return cached;
  }
  const cache: ChatCache = { mtimeMs: stat.mtimeMs, size: stat.size, messages: [] };
  if (stat.size <= MAX_FILE_BYTES) {
    const records = parseGeminiChatFile(
      fs.readFileSync(chatPath, 'utf8'),
      chatPath.endsWith('.jsonl')
    );
    for (const record of records) {
      for (const message of geminiRecordMessages(record)) {
        cache.messages.push(message);
        if (!cache.title && message.role === 'user') {
          cache.title = truncate(message.text.replace(/\s+/g, ' ').trim(), TITLE_MAX);
        }
      }
    }
    if (cache.messages.length > MAX_MESSAGES) cache.messages = cache.messages.slice(-MAX_MESSAGES);
  }
  chatCache.delete(chatPath);
  chatCache.set(chatPath, cache);
  while (chatCache.size > MAX_CACHED_CHATS) {
    chatCache.delete(chatCache.keys().next().value as string);
  }
  return cache;
}

/** "busy" right after a prompt or while a tool call has no result, else "idle". */
function statusOf(chat: ChatCache, now = Date.now()): 'busy' | 'idle' {
  if (now - chat.mtimeMs >= BUSY_WINDOW_MS) return 'idle';
  const last = chat.messages[chat.messages.length - 1];
  if (last?.role === 'user') return 'busy';
  if (last?.role === 'tool' && last.result === undefined) return 'busy';
  return 'idle';
}

/** Project folders Gemini may use for `cwd`: registry short name, then the sha256 hash. */
export function geminiProjectDirs(geminiDir: string, cwd: string): string[] {
  const tmp = path.join(geminiDir, 'tmp');
  const roots = [path.resolve(cwd)];
  try {
    const real = fs.realpathSync(cwd);
    if (!roots.includes(real)) roots.push(real);
  } catch {
    // keep the path as given
  }
  let projects: Json = {};
  try {
    const registry = JSON.parse(fs.readFileSync(path.join(geminiDir, 'projects.json'), 'utf8'));
    if (isObject(registry) && isObject(registry.projects)) projects = registry.projects;
  } catch {
    // older Gemini: no registry
  }
  const dirs: string[] = [];
  for (const root of roots) {
    const slug = projects[root];
    if (typeof slug === 'string' && slug && !slug.includes('/') && !slug.startsWith('.')) {
      dirs.push(path.join(tmp, slug));
    }
    dirs.push(path.join(tmp, crypto.createHash('sha256').update(root).digest('hex')));
  }
  return [...new Set(dirs)];
}

/** UTC start of a chat from its file name (`session-2026-04-30T14-14-<id>.json[l]`). */
export function chatFileStart(file: string): number | undefined {
  const match = file.match(/^session-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})/);
  if (!match) return undefined;
  const at = Date.parse(`${match[1]}T${match[2]}:${match[3]}:00Z`);
  return Number.isNaN(at) ? undefined : at;
}

/**
 * Newest chat Gemini started (or resumed) in `cwd` at or after `since` (epoch ms), skipping
 * `claimed` ones (chats already shown for another session in the same directory).
 */
export function findGeminiChat(
  geminiDir: string,
  cwd: string,
  since: number,
  claimed: Set<string> = new Set()
): string | null {
  let best: { path: string; mtimeMs: number; started: boolean } | null = null;
  for (const dir of geminiProjectDirs(geminiDir, cwd)) {
    const chatsDir = path.join(dir, 'chats');
    let files: string[];
    try {
      files = fs.readdirSync(chatsDir).filter((f) => /^session-.*\.jsonl?$/.test(f));
    } catch {
      continue;
    }
    for (const file of files) {
      const candidate = path.join(chatsDir, file);
      if (claimed.has(candidate)) continue;
      const start = chatFileStart(file);
      const started = start !== undefined && start >= since - START_SKEW_MS;
      let mtimeMs: number;
      try {
        mtimeMs = fs.statSync(candidate).mtimeMs;
      } catch {
        continue;
      }
      // An older chat written after the session began was resumed in it.
      if (!started && mtimeMs < since) continue;
      if (
        !best ||
        (started && !best.started) ||
        (started === best.started && mtimeMs > best.mtimeMs)
      ) {
        best = { path: candidate, mtimeMs, started };
      }
    }
  }
  return best?.path ?? null;
}

export interface GeminiSessionRef {
  id: string;
  workingDir: string;
  startedAt: string;
}

const matches = new Map<
  string,
  { path: string | null; at: number; geminiDir: string; key: string }
>();

/** The chat file of an Untether session, re-checked now and then for a newer one. */
function chatFor(session: GeminiSessionRef, geminiDir: string): string | null {
  const cached = matches.get(session.id);
  const key = `${session.workingDir}\0${session.startedAt}`;
  if (
    cached &&
    cached.geminiDir === geminiDir &&
    cached.key === key &&
    Date.now() - cached.at < MATCH_RECHECK_MS
  ) {
    return cached.path;
  }
  const since = Date.parse(session.startedAt);
  if (Number.isNaN(since) || !session.workingDir) return null;
  const claimed = new Set<string>();
  for (const [id, match] of matches) if (id !== session.id && match.path) claimed.add(match.path);
  const found = findGeminiChat(geminiDir, session.workingDir, since, claimed);
  matches.delete(session.id);
  matches.set(session.id, { path: found, at: Date.now(), geminiDir, key });
  if (matches.size > 200) matches.delete(matches.keys().next().value as string);
  return found;
}

/** Forget a session's chat match (it exited). */
export function forgetGeminiSession(sessionId: string) {
  matches.delete(sessionId);
}

/** The Gemini conversation of a running Untether session. */
export function readGeminiChat(
  session: GeminiSessionRef,
  geminiDir = defaultGeminiDir()
): GeminiChat {
  const chatPath = chatFor(session, geminiDir);
  const empty: GeminiChat = { available: true, agent: 'gemini', status: 'idle', messages: [] };
  if (!chatPath) return empty;
  let chat: ChatCache;
  try {
    chat = readChat(chatPath);
  } catch {
    matches.delete(session.id);
    return empty;
  }
  const status = statusOf(chat);
  const last = chat.messages[chat.messages.length - 1];
  return {
    available: true,
    agent: 'gemini',
    status,
    title: chat.title,
    activity:
      status === 'busy'
        ? last?.role === 'tool' && last.result === undefined
          ? {
              kind: 'tool',
              tool: last.tool,
              target: last.text ? truncate(last.text.replace(/\s+/g, ' '), 60) : undefined,
              since: last.timestamp ? Date.parse(last.timestamp) : undefined,
            }
          : { kind: 'thinking', since: chat.mtimeMs }
        : undefined,
    messages: chat.messages,
  };
}
