/**
 * What a task's agent processed, read from the agent's own records (2026-11-01, task budgets:
 * shared/task-budget.ts; 2026-11-03, by kind for the task's metrics: shared/task-metrics.ts):
 *  Claude: each assistant message's `usage` in the conversation's JSONL (input, cache writes,
 *    cache reads and output; a message split over several lines repeats it: counted once per
 *    message id), and its compactions (compact_boundary). A reopened conversation may repeat
 *    earlier messages: one set of ids per task.
 *  Codex: the last `token_count` event's total_token_usage in its rollout (its input holds
 *    the cached input), one model call per new total, and its `compacted` entries.
 * Read incrementally (from where the last read stopped); after a restart each file is read
 * once from the start. Read-only.
 */
import * as fs from 'fs';
import { isRealModel } from '../../shared/agent-models.js';
import { type AgentUsage, emptyUsage } from '../../shared/task-metrics.js';
import type { TaskRecord } from '../../shared/tasks.js';
import { findClaudeTranscript } from './claude-chat.js';
import { defaultCodexDir, findCodexRollout } from './codex-chat.js';

/** Bytes read per file per call at most (a huge transcript is caught up over a few calls). */
const MAX_READ_BYTES = 16 * 1024 * 1024;

interface FileState {
  offset: number;
  usage: AgentUsage;
  /** Codex: the running total of the last token_count event counted (a repeated one is no call). */
  codexTotal: number;
  /** Bytes after the last newline (a line still being written). */
  partial: string;
}

interface TaskState {
  files: Map<string, FileState>;
  seen: Set<string>;
}

const count = (record: Record<string, unknown> | undefined, key: string): number => {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
};

/**
 * Adds one Claude JSONL line to `usage`: an assistant message's usage (a message split over
 * several lines repeats it: counted once per message id) or a compaction (compact_boundary,
 * once per uuid). True when it counted.
 */
export function addClaudeLine(line: string, seen: Set<string>, usage: AgentUsage): boolean {
  const hasUsage = line.includes('"usage"');
  const compaction = line.includes('"compact_boundary"');
  if (!hasUsage && !compaction) return false;
  let entry: {
    type?: string;
    subtype?: string;
    uuid?: string;
    requestId?: string;
    timestamp?: string;
    message?: { id?: string; model?: string; usage?: Record<string, unknown> };
  };
  try {
    entry = JSON.parse(line);
  } catch {
    return false;
  }
  if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
    const key = `compact:${entry.uuid ?? line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    usage.compactions += 1;
    return true;
  }
  const raw = entry.message?.usage;
  if (!raw || typeof raw !== 'object') return false;
  const id = entry.message?.id ?? entry.requestId;
  if (id) {
    if (seen.has(id)) return false;
    seen.add(id);
  }
  const input = count(raw, 'input_tokens');
  const cacheWrite = count(raw, 'cache_creation_input_tokens');
  const cacheRead = count(raw, 'cache_read_input_tokens');
  const output = count(raw, 'output_tokens');
  usage.input += input;
  usage.cacheWrite += cacheWrite;
  usage.cacheRead += cacheRead;
  usage.output += output;
  usage.turns += 1;
  usage.maxContext = Math.max(usage.maxContext, input + cacheWrite + cacheRead);
  // By model (model-providers.ts per-model cost): the model that produced this message.
  const model = entry.message?.model;
  if (model) {
    usage.byModel ??= {};
    usage.byModel[model] ??= { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
    const into = usage.byModel[model];
    into.input += input;
    into.cacheWrite += cacheWrite;
    into.cacheRead += cacheRead;
    into.output += output;
  }
  // The model it really runs with (2026-11-08): the newest real one (not `<synthetic>`).
  if (isRealModel(model)) noteModel(usage, model, entry.timestamp);
  return true;
}

/** The newest model seen: a line without a time counts as now-ordered (the later line wins). */
function noteModel(usage: AgentUsage, model: string, timestamp: string | undefined): void {
  const at = timestamp && Number.isFinite(Date.parse(timestamp)) ? timestamp : usage.lastModel?.at;
  if (usage.lastModel && at && at < usage.lastModel.at) return;
  usage.lastModel = { model, at: at ?? new Date(0).toISOString() };
}

/**
 * Adds one Codex rollout line to `usage`: a token_count event's running totals replace the
 * token counts (its input_tokens hold the cached ones), each new total is one model call, the
 * last call's input is its context; a `compacted` entry is a compaction. Returns the running
 * total now (`total` when the line changed nothing).
 */
export function addCodexLine(line: string, total: number, usage: AgentUsage): number {
  const tokenCount = line.includes('"token_count"');
  const turnContext = line.includes('"turn_context"');
  if (!tokenCount && !turnContext && !line.includes('"compacted"')) return total;
  let entry: {
    type?: string;
    timestamp?: string;
    payload?: {
      type?: string;
      model?: unknown;
      info?: {
        total_token_usage?: Record<string, unknown>;
        last_token_usage?: Record<string, unknown>;
      } | null;
    };
  };
  try {
    entry = JSON.parse(line);
  } catch {
    return total;
  }
  if (entry.type === 'compacted') {
    usage.compactions += 1;
    return total;
  }
  // The model of its turns (2026-11-08): each turn_context names it.
  if (entry.type === 'turn_context') {
    if (isRealModel(entry.payload?.model)) noteModel(usage, entry.payload.model, entry.timestamp);
    return total;
  }
  const info = entry.payload?.type === 'token_count' ? entry.payload.info : undefined;
  const totals = info?.total_token_usage;
  if (!totals) return total;
  const now = count(totals, 'total_tokens');
  if (now <= total) return total;
  const cacheRead = count(totals, 'cached_input_tokens');
  const cacheWrite = count(totals, 'cache_write_input_tokens');
  const output = count(totals, 'output_tokens');
  // total = input (cached included) + output; a total without the breakdown is all input.
  usage.input = Math.max(0, now - output - cacheRead - cacheWrite);
  usage.cacheRead = cacheRead;
  usage.cacheWrite = cacheWrite;
  usage.output = output;
  usage.turns += 1;
  usage.maxContext = Math.max(usage.maxContext, count(info?.last_token_usage, 'input_tokens'));
  return now;
}

/** A Codex rollout (sessions/…/rollout-*.jsonl); anything else is a Claude transcript. */
export function isCodexRollout(file: string): boolean {
  return /(^|\/)rollout-[^/]*\.jsonl$/.test(file);
}

export interface AgentUsageReaderOptions {
  /** The Claude conversation last seen in a session. */
  claudeConversation?: (sessionId: string) => string | undefined;
  claudeDir?: string;
  codexDir?: string;
}

/**
 * A reader of tasks' usage: given a task (and the files already known for it, keys of
 * TaskMetrics.usageBy), the usage per file. Undefined when there is nothing to read.
 */
export function createAgentUsageReader(options: AgentUsageReaderOptions) {
  const tasks = new Map<string, TaskState>();

  const currentFile = (task: TaskRecord): string | null => {
    const cwd = task.worktreePath ?? task.workingDir;
    if (task.agent === 'codex') {
      const since = Date.parse(task.startedAt ?? task.createdAt);
      if (!Number.isFinite(since)) return null;
      return findCodexRollout(options.codexDir ?? defaultCodexDir(), cwd, since);
    }
    const conversation = task.sessionId ? options.claudeConversation?.(task.sessionId) : undefined;
    return conversation ? findClaudeTranscript(cwd, conversation, options.claudeDir) : null;
  };

  const readFile = async (task: TaskRecord, state: TaskState, file: string): Promise<void> => {
    let entry = state.files.get(file);
    if (!entry) {
      entry = { offset: 0, usage: emptyUsage(), codexTotal: 0, partial: '' };
      state.files.set(file, entry);
    }
    let handle: fs.promises.FileHandle | undefined;
    try {
      handle = await fs.promises.open(file, 'r');
      const { size } = await handle.stat();
      if (size < entry.offset) {
        // Rewritten: read again from the start.
        entry.offset = 0;
        entry.usage = emptyUsage();
        entry.codexTotal = 0;
        entry.partial = '';
      }
      const length = Math.min(size - entry.offset, MAX_READ_BYTES);
      if (length <= 0) return;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, entry.offset);
      entry.offset += bytesRead;
      const text = entry.partial + buffer.subarray(0, bytesRead).toString('utf8');
      const lines = text.split('\n');
      entry.partial = lines.pop() ?? '';
      // Read by the file's own format, not the task's agent now: a task that went on with
      // another agent (2026-11-01, agentFallback) keeps the other one's file in its count.
      const codexFile = isCodexRollout(file);
      for (const line of lines) {
        if (codexFile) entry.codexTotal = addCodexLine(line, entry.codexTotal, entry.usage);
        else addClaudeLine(line, state.seen, entry.usage);
      }
    } catch {
      // Gone or unreadable: what was counted stays.
    } finally {
      await handle?.close().catch(() => undefined);
    }
  };

  return {
    async read(
      task: TaskRecord,
      known: readonly string[] = []
    ): Promise<Record<string, AgentUsage> | undefined> {
      let state = tasks.get(task.id);
      if (!state) {
        state = { files: new Map(), seen: new Set() };
        tasks.set(task.id, state);
      }
      const files = new Set(known.filter((file) => file.startsWith('/')));
      const current = currentFile(task);
      if (current) files.add(current);
      if (!files.size) return undefined;
      for (const file of files) await readFile(task, state, file);
      return Object.fromEntries(
        [...files].map((file) => [file, { ...(state.files.get(file)?.usage ?? emptyUsage()) }])
      );
    },
    forget(taskId: string): void {
      tasks.delete(taskId);
    },
  };
}

export type AgentUsageReader = ReturnType<typeof createAgentUsageReader>;
