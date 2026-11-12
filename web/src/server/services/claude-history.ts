/**
 * Claude Code conversation history.
 *
 * Lists the conversations Claude Code keeps in <Claude dir>/projects/<cwd slug>/<id>.jsonl so the
 * phone can browse and resume them. Transcripts reach many megabytes (pasted images, tool
 * output), so a summary only reads a file's head (first prompt, cwd) and tail (title, last
 * reply, last timestamp), and is cached by path + mtime + size.
 */
import * as fs from 'fs';
import * as path from 'path';
import { claudeConfigDir } from '../utils/claude-dir.js';
import { parseTranscriptLine, plainPreview } from './claude-chat.js';

export interface ClaudeConversationSummary {
  /** Claude Code session id: `claude --resume <id>`. */
  id: string;
  /** Folder the conversation ran in (from the transcript itself, not the lossy slug). */
  cwd: string;
  title: string;
  /** ISO time of the last user or assistant message. */
  lastMessageAt: string;
  /** Approximate number of user + assistant entries. */
  messageCount: number;
  /** Claude's last reply as one plain line. */
  preview: string;
}

export interface ClaudeConversationPage {
  conversations: ClaudeConversationSummary[];
  hasMore: boolean;
}

const HEAD_BYTES = 32 * 1024;
const TAIL_BYTES = 64 * 1024;
/** A head or tail without a prompt / reply (huge tool output, pasted images) widens to this. */
const MAX_WINDOW_BYTES = 2 * 1024 * 1024;
const TITLE_MAX = 120;
const PREVIEW_MAX = 140;
const READ_CONCURRENCY = 32;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

interface CacheEntry {
  mtimeMs: number;
  size: number;
  summary: ClaudeConversationSummary | null;
}

const summaryCache = new Map<string, CacheEntry>();

interface Entry {
  type?: string;
  cwd?: unknown;
  timestamp?: unknown;
  isSidechain?: boolean;
  isMeta?: boolean;
  aiTitle?: unknown;
  customTitle?: unknown;
  summary?: unknown;
}

function oneLine(text: string, max: number): string {
  const plain = plainPreview(text);
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
}

async function readRange(handle: fs.promises.FileHandle, start: number, length: number) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, start);
  return buffer.subarray(0, bytesRead);
}

/** Complete lines of a byte window: a cut-off first or last line is dropped. */
function windowLines(buffer: Buffer, cutStart: boolean, cutEnd: boolean): string[] {
  let text = buffer.toString('utf8');
  if (cutStart) {
    const newline = text.indexOf('\n');
    text = newline < 0 ? '' : text.slice(newline + 1);
  }
  if (cutEnd) {
    const newline = text.lastIndexOf('\n');
    text = newline < 0 ? '' : text.slice(0, newline);
  }
  return text.split('\n').filter(Boolean);
}

function parse(line: string): Entry | null {
  try {
    const entry = JSON.parse(line);
    return entry && typeof entry === 'object' ? (entry as Entry) : null;
  } catch {
    return null;
  }
}

const isMessage = (entry: Entry) =>
  (entry.type === 'user' || entry.type === 'assistant') && !entry.isSidechain && !entry.isMeta;

interface HeadInfo {
  cwd?: string;
  firstPrompt?: string;
  summary?: string;
  messages: number;
}

function scanHead(lines: string[]): HeadInfo {
  const info: HeadInfo = { messages: 0 };
  for (const line of lines) {
    const entry = parse(line);
    if (!entry) continue;
    if (!info.cwd && typeof entry.cwd === 'string' && entry.cwd) info.cwd = entry.cwd;
    if (!info.summary && entry.type === 'summary' && typeof entry.summary === 'string') {
      info.summary = entry.summary;
    }
    if (!isMessage(entry)) continue;
    info.messages++;
    // A slash command (/clear, /model) says nothing about the conversation: not a title.
    if (!info.firstPrompt && entry.type === 'user' && !line.includes('<command-name>')) {
      const text = parseTranscriptLine(line).find((m) => m.role === 'user')?.text;
      if (text) info.firstPrompt = text;
    }
  }
  return info;
}

interface TailInfo {
  cwd?: string;
  title?: string;
  customTitle?: string;
  lastMessageAt?: string;
  lastReply?: string;
  messages: number;
}

function scanTail(lines: string[]): TailInfo {
  const info: TailInfo = { messages: 0 };
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const entry = parse(line);
    if (!entry) continue;
    if (!info.cwd && typeof entry.cwd === 'string' && entry.cwd) info.cwd = entry.cwd;
    if (!info.title && entry.type === 'ai-title' && typeof entry.aiTitle === 'string') {
      info.title = entry.aiTitle;
    }
    if (
      !info.customTitle &&
      entry.type === 'custom-title' &&
      typeof entry.customTitle === 'string'
    ) {
      info.customTitle = entry.customTitle;
    }
    if (!isMessage(entry)) continue;
    info.messages++;
    if (!info.lastMessageAt && typeof entry.timestamp === 'string') {
      info.lastMessageAt = entry.timestamp;
    }
    if (!info.lastReply && entry.type === 'assistant') {
      const text = parseTranscriptLine(line).find((m) => m.role === 'assistant')?.text;
      if (text) info.lastReply = text;
    }
  }
  return info;
}

/** Summary of one transcript from its head and tail; null when it is not a usable conversation. */
export async function summarizeTranscript(
  file: string,
  stat: { size: number; mtimeMs: number }
): Promise<ClaudeConversationSummary | null> {
  const id = path.basename(file, '.jsonl');
  if (!SESSION_ID.test(id)) return null;
  const handle = await fs.promises.open(file, 'r');
  try {
    const { size } = stat;
    let head: HeadInfo;
    let tail: TailInfo;
    let sampledBytes: number;
    if (size <= HEAD_BYTES + TAIL_BYTES) {
      const lines = windowLines(await readRange(handle, 0, size), false, true);
      head = scanHead(lines);
      tail = scanTail(lines);
      sampledBytes = 0; // whole file: counts are exact
    } else {
      let headBytes = HEAD_BYTES;
      for (;;) {
        const length = Math.min(size, headBytes);
        head = scanHead(windowLines(await readRange(handle, 0, length), false, length < size));
        if (head.firstPrompt || head.summary || length >= Math.min(size, MAX_WINDOW_BYTES)) break;
        headBytes *= 4;
      }
      let tailBytes = TAIL_BYTES;
      for (;;) {
        const start = Math.max(0, size - tailBytes);
        tail = scanTail(windowLines(await readRange(handle, start, size - start), start > 0, true));
        if (tail.lastReply || start === 0 || tailBytes >= MAX_WINDOW_BYTES) break;
        tailBytes *= 4;
      }
      sampledBytes = Math.min(size, headBytes) + Math.min(size, tailBytes);
    }
    const cwd = tail.cwd || head.cwd;
    const rawTitle = tail.customTitle || tail.title || head.summary || head.firstPrompt;
    if (!cwd || !rawTitle) return null;
    const messageCount = sampledBytes
      ? Math.round(((head.messages + tail.messages) * size) / sampledBytes)
      : tail.messages;
    return {
      id,
      cwd,
      title: oneLine(rawTitle, TITLE_MAX),
      lastMessageAt: tail.lastMessageAt ?? new Date(stat.mtimeMs).toISOString(),
      messageCount,
      preview: tail.lastReply ? oneLine(tail.lastReply, PREVIEW_MAX) : '',
    };
  } finally {
    await handle.close();
  }
}

async function transcriptFiles(projectsDir: string): Promise<string[]> {
  let dirs: fs.Dirent[];
  try {
    dirs = await fs.promises.readdir(projectsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const lists = await Promise.all(
    dirs
      .filter((dir) => dir.isDirectory())
      .map(async (dir) => {
        const folder = path.join(projectsDir, dir.name);
        try {
          return (await fs.promises.readdir(folder))
            .filter((name) => name.endsWith('.jsonl') && !name.startsWith('agent-'))
            .map((name) => path.join(folder, name));
        } catch {
          return [];
        }
      })
  );
  return lists.flat();
}

async function cachedSummary(file: string): Promise<ClaudeConversationSummary | null> {
  try {
    const stat = await fs.promises.stat(file);
    const cached = summaryCache.get(file);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.summary;
    }
    let summary: ClaudeConversationSummary | null = null;
    try {
      summary = await summarizeTranscript(file, stat);
    } catch {
      // unreadable or malformed: listed as nothing, retried when the file changes
    }
    summaryCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, summary });
    return summary;
  } catch {
    return null;
  }
}

/** Recent Claude Code conversations across all projects, newest first. */
export async function listClaudeConversations(
  options: { query?: string; limit?: number; offset?: number; claudeDir?: string } = {}
): Promise<ClaudeConversationPage> {
  const claudeDir = options.claudeDir ?? claudeConfigDir();
  const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? 50) || 50));
  const offset = Math.max(0, Math.floor(options.offset ?? 0) || 0);
  const query = options.query?.trim().toLowerCase() ?? '';

  const files = await transcriptFiles(path.join(claudeDir, 'projects'));
  const summaries: Array<ClaudeConversationSummary | null> = [];
  for (let i = 0; i < files.length; i += READ_CONCURRENCY) {
    summaries.push(...(await Promise.all(files.slice(i, i + READ_CONCURRENCY).map(cachedSummary))));
  }
  // Forget transcripts that were deleted.
  const seen = new Set(files);
  for (const key of summaryCache.keys()) {
    if (key.startsWith(claudeDir) && !seen.has(key)) summaryCache.delete(key);
  }

  const byId = new Map<string, ClaudeConversationSummary>();
  for (const summary of summaries) {
    if (!summary) continue;
    const existing = byId.get(summary.id);
    if (!existing || existing.lastMessageAt < summary.lastMessageAt) byId.set(summary.id, summary);
  }
  let conversations = [...byId.values()];
  if (query) {
    conversations = conversations.filter((c) =>
      [c.title, c.preview, c.cwd].some((field) => field.toLowerCase().includes(query))
    );
  }
  conversations.sort((a, b) => Date.parse(b.lastMessageAt) - Date.parse(a.lastMessageAt));
  return {
    conversations: conversations.slice(offset, offset + limit),
    hasMore: conversations.length > offset + limit,
  };
}
