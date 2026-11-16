/** Qoder 1.1.87 transcripts: hook-bound JSONL, including its active parent/leaf branch. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SessionInfo } from '../../shared/types.js';
import type { AgentSnapshot } from './agent-events.js';
import {
  type ClaudeChat,
  type ClaudeChatMessage,
  parseToolResults,
  parseTranscriptLine,
} from './claude-chat.js';
import { sessionStateOf } from './session-state-events.js';

const MAX_BYTES = 20 * 1024 * 1024;
const cache = new Map<string, { mtime: number; size: number; chat: QoderChat }>();
export interface QoderChat extends ClaudeChat {
  agent: 'qoder';
}

export function parseQoderTranscript(raw: string, sessionId: string): QoderChat {
  const records = new Map<string, { raw: string; parent?: string }>();
  let leaf: string | undefined;
  let title: string | undefined;
  for (const line of raw.split('\n')) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || entry.sessionId !== sessionId || entry.isSidechain) continue;
    if (entry.type === 'ai-title' && typeof entry.aiTitle === 'string') title = entry.aiTitle;
    if (entry.type === 'active-leaf' && typeof entry.leafUuid === 'string') leaf = entry.leafUuid;
    if (typeof entry.uuid !== 'string') continue;
    records.set(entry.uuid, {
      raw: line,
      parent: typeof entry.parentUuid === 'string' ? entry.parentUuid : undefined,
    });
  }
  let lines = [...records.values()].map((record) => record.raw);
  if (leaf && records.has(leaf)) {
    const branch: string[] = [];
    const seen = new Set<string>();
    while (leaf && !seen.has(leaf)) {
      seen.add(leaf);
      const record = records.get(leaf);
      if (!record) break;
      branch.push(record.raw);
      leaf = record.parent;
    }
    lines = branch.reverse();
  }
  const messages: ClaudeChatMessage[] = [];
  const tools = new Map<string, ClaudeChatMessage>();
  for (const line of lines) {
    for (const message of parseTranscriptLine(line)) {
      messages.push(message);
      if (message.toolUseId) tools.set(message.toolUseId, message);
      if (!title && message.role === 'user') title = message.text.replace(/\s+/g, ' ').slice(0, 80);
    }
    for (const result of parseToolResults(line)) {
      const tool = tools.get(result.toolUseId);
      if (tool) {
        tool.result = result.text;
        tool.isError = result.isError;
      }
    }
  }
  return { available: true, agent: 'qoder', title, messages: messages.slice(-400) };
}

/** The binding is supplied by Qoder's hook, never guessed from newest files in a directory. */
export function readQoderChat(
  session: Pick<SessionInfo, 'qoderSession'>,
  snapshot?: AgentSnapshot
): QoderChat {
  const state = snapshot ? sessionStateOf(snapshot.state) : undefined;
  const withState = (chat: QoderChat): QoderChat => ({
    ...chat,
    ...(state ? { status: state.state, waitingFor: snapshot?.asking } : {}),
  });
  const empty: QoderChat = { available: true, agent: 'qoder', messages: [] };
  const binding = session.qoderSession;
  if (
    !binding ||
    !path.isAbsolute(binding.transcriptPath) ||
    !binding.transcriptPath.endsWith('.jsonl')
  )
    return withState(empty);
  try {
    const stat = fs.statSync(binding.transcriptPath);
    if (!stat.isFile() || stat.size > MAX_BYTES) return withState(empty);
    const key = `${binding.id}\0${binding.transcriptPath}`;
    const hit = cache.get(key);
    if (hit?.mtime === stat.mtimeMs && hit.size === stat.size) return withState(hit.chat);
    const chat = parseQoderTranscript(fs.readFileSync(binding.transcriptPath, 'utf8'), binding.id);
    cache.delete(key);
    cache.set(key, { mtime: stat.mtimeMs, size: stat.size, chat });
    while (cache.size > 20) cache.delete(cache.keys().next().value!);
    return withState(chat);
  } catch {
    return withState(empty);
  }
}
