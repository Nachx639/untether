/**
 * Tokens read from the agent's own records for task budgets (2026-11-01): Claude's JSONL
 * repeats a message's usage on each of its lines (counted once), Codex's rollout carries a
 * running total.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type AgentUsage, emptyUsage, sumUsage, usageTokens } from '../../shared/task-metrics.js';
import type { TaskRecord } from '../../shared/tasks.js';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import {
  addClaudeLine,
  addCodexLine,
  createAgentUsageReader,
  isCodexRollout,
} from './agent-usage.js';

/** Tokens per file, every kind together (what the budget counts). */
const tokens = (byFile: Record<string, AgentUsage> | undefined) =>
  byFile && Object.fromEntries(Object.entries(byFile).map(([f, u]) => [f, usageTokens(u)]));

const usage = (id: string, u: Record<string, number>) =>
  JSON.stringify({ type: 'assistant', requestId: `r-${id}`, message: { id, usage: u } });

describe('agent usage', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-usage-'));
  });
  afterEach(() => fs.rmSync(dir, RM_TEST_DIR));

  it('counts a Claude message once, every kind of token, its context and compactions', () => {
    const seen = new Set<string>();
    const u = emptyUsage();
    const line = usage('m1', {
      input_tokens: 3,
      cache_creation_input_tokens: 100,
      cache_read_input_tokens: 5000,
      output_tokens: 40,
    });
    expect(addClaudeLine(line, seen, u)).toBe(true);
    expect(addClaudeLine(line, seen, u)).toBe(false);
    expect(addClaudeLine('{"type":"user"}', seen, u)).toBe(false);
    expect(addClaudeLine('not json "usage"', seen, u)).toBe(false);
    addClaudeLine(
      usage('m2', { input_tokens: 10, cache_read_input_tokens: 6000, output_tokens: 1 }),
      seen,
      u
    );
    const compact = JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid: 'u1' });
    expect(addClaudeLine(compact, seen, u)).toBe(true);
    expect(addClaudeLine(compact, seen, u)).toBe(false);
    expect(u).toEqual({
      input: 13,
      cacheWrite: 100,
      cacheRead: 11000,
      output: 41,
      turns: 2,
      maxContext: 6010,
      compactions: 1,
    });
    expect(usageTokens(u)).toBe(11154);
  });

  it('splits tokens by model when the message names one (model-providers per-model cost)', () => {
    const seen = new Set<string>();
    const u = emptyUsage();
    const withModel = (id: string, model: string, tokens: Record<string, number>) =>
      JSON.stringify({
        type: 'assistant',
        requestId: `r-${id}`,
        message: { id, model, usage: tokens },
      });
    addClaudeLine(withModel('a', 'large-flash', { input_tokens: 10, output_tokens: 2 }), seen, u);
    addClaudeLine(withModel('b', 'large-v2', { input_tokens: 5, output_tokens: 3 }), seen, u);
    addClaudeLine(withModel('c', 'large-flash', { input_tokens: 1, output_tokens: 1 }), seen, u);
    expect(u.byModel).toEqual({
      'large-flash': { input: 11, cacheWrite: 0, cacheRead: 0, output: 3 },
      'large-v2': { input: 5, cacheWrite: 0, cacheRead: 0, output: 3 },
    });
    // A message without a model never creates a byModel bucket.
    const plain = emptyUsage();
    addClaudeLine(usage('m', { input_tokens: 7, output_tokens: 1 }), new Set(), plain);
    expect(plain.byModel).toBeUndefined();
  });

  it("reads a Codex rollout's running totals by kind, one call per new total", () => {
    const event = (total: Record<string, number>, last: Record<string, number>) =>
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { total_token_usage: total, last_token_usage: last },
        },
      });
    const u = emptyUsage();
    let total = addCodexLine(
      event(
        { input_tokens: 14423, cached_input_tokens: 12032, output_tokens: 6, total_tokens: 14429 },
        { input_tokens: 14423 }
      ),
      0,
      u
    );
    expect(total).toBe(14429);
    // The same total again (a rate-limit update) is no call; an event without usage neither.
    total = addCodexLine(
      event(
        { input_tokens: 14423, cached_input_tokens: 12032, output_tokens: 6, total_tokens: 14429 },
        {}
      ),
      total,
      u
    );
    total = addCodexLine(
      '{"type":"event_msg","payload":{"type":"token_count","info":null}}',
      total,
      u
    );
    total = addCodexLine(
      event(
        {
          input_tokens: 30000,
          cached_input_tokens: 26000,
          output_tokens: 900,
          total_tokens: 30900,
        },
        { input_tokens: 15577 }
      ),
      total,
      u
    );
    total = addCodexLine('{"type":"compacted","payload":{"message":""}}', total, u);
    expect(total).toBe(30900);
    expect(u).toEqual({
      input: 4000,
      cacheWrite: 0,
      cacheRead: 26000,
      output: 900,
      turns: 2,
      maxContext: 15577,
      compactions: 1,
    });
    expect(usageTokens(u)).toBe(30900);
  });

  it('reads a transcript as it grows, and a reopened one without counting twice', async () => {
    const projects = path.join(dir, 'claude', 'projects', '-wt-1');
    fs.mkdirSync(projects, { recursive: true });
    const first = path.join(projects, 'c1.jsonl');
    fs.writeFileSync(first, `${usage('m1', { input_tokens: 10, output_tokens: 5 })}\n`);
    let conversation = 'c1';
    const reader = createAgentUsageReader({
      claudeConversation: () => conversation,
      claudeDir: path.join(dir, 'claude'),
    });
    const task = {
      id: 't1',
      agent: 'claude',
      sessionId: 's1',
      workingDir: '/wt/1',
      worktreePath: '/wt/1',
      createdAt: new Date().toISOString(),
    } as TaskRecord;
    expect(tokens(await reader.read(task))).toEqual({ [first]: 15 });
    // A line half written, then finished.
    const line = usage('m2', { input_tokens: 100, output_tokens: 1 });
    fs.appendFileSync(first, line.slice(0, 20));
    expect(tokens(await reader.read(task, [first]))).toEqual({ [first]: 15 });
    fs.appendFileSync(first, `${line.slice(20)}\n`);
    expect(tokens(await reader.read(task, [first]))).toEqual({ [first]: 116 });
    // Reopened as another conversation that repeats m1 and m2 and adds m3.
    const second = path.join(projects, 'c2.jsonl');
    fs.writeFileSync(
      second,
      [
        usage('m1', { input_tokens: 10, output_tokens: 5 }),
        line,
        usage('m3', { input_tokens: 7 }),
        '',
      ].join('\n')
    );
    conversation = 'c2';
    expect(tokens(await reader.read(task, [first]))).toEqual({ [first]: 116, [second]: 7 });
  });

  it("a task that went on with another agent keeps the old one's file in its count, read in its own format (2026-11-01)", async () => {
    // Codex worked first, then Claude took over (agentFallback); the reader starts afresh
    // after a restart with both files known.
    const rollout = path.join(dir, 'codex', 'sessions', '2026', '11', '01', 'rollout-a.jsonl');
    fs.mkdirSync(path.dirname(rollout), { recursive: true });
    fs.writeFileSync(
      rollout,
      `${JSON.stringify({
        type: 'event_msg',
        payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 5000 } } },
      })}\n`
    );
    const projects = path.join(dir, 'claude', 'projects', '-wt-1');
    fs.mkdirSync(projects, { recursive: true });
    const transcript = path.join(projects, 'c1.jsonl');
    fs.writeFileSync(transcript, `${usage('m1', { input_tokens: 40, output_tokens: 2 })}\n`);
    const reader = createAgentUsageReader({
      claudeConversation: () => 'c1',
      claudeDir: path.join(dir, 'claude'),
      codexDir: path.join(dir, 'codex'),
    });
    const task = {
      id: 't2',
      agent: 'claude',
      sessionId: 's2',
      workingDir: '/wt/1',
      worktreePath: '/wt/1',
      createdAt: new Date().toISOString(),
    } as TaskRecord;
    expect(tokens(await reader.read(task, [rollout]))).toEqual({
      [rollout]: 5000,
      [transcript]: 42,
    });
    expect(isCodexRollout(rollout)).toBe(true);
    expect(isCodexRollout(transcript)).toBe(false);
  });

  // 2026-11-08: tasks ran on claude-opus-4-8 for days unseen; the real model is read.
  it('reads the real model: the newest message’s, never <synthetic>, newest across files', () => {
    const seen = new Set<string>();
    const u = emptyUsage();
    const line = (id: string, model: string, timestamp: string) =>
      JSON.stringify({
        type: 'assistant',
        timestamp,
        message: { id, model, usage: { input_tokens: 1, output_tokens: 1 } },
      });
    addClaudeLine(line('a', 'claude-opus-4-8', '2026-11-08T10:00:00.000Z'), seen, u);
    expect(u.lastModel).toEqual({ model: 'claude-opus-4-8', at: '2026-11-08T10:00:00.000Z' });
    addClaudeLine(line('b', '<synthetic>', '2026-11-08T10:05:00.000Z'), seen, u);
    expect(u.lastModel?.model).toBe('claude-opus-4-8');
    addClaudeLine(line('c', 'claude-opus-5-5', '2026-11-08T10:06:00.000Z'), seen, u);
    expect(u.lastModel?.model).toBe('claude-opus-5-5');
    const older = emptyUsage();
    addClaudeLine(line('d', 'claude-sonnet-5-5', '2026-11-08T09:00:00.000Z'), seen, older);
    expect(sumUsage([u, older]).lastModel?.model).toBe('claude-opus-5-5');
    expect(sumUsage([older, u]).lastModel?.model).toBe('claude-opus-5-5');

    const codex = emptyUsage();
    const context = JSON.stringify({
      timestamp: '2026-11-08T08:11:56.157Z',
      type: 'turn_context',
      payload: { model: 'gpt-6-astra', cwd: '/x' },
    });
    expect(addCodexLine(context, 7, codex)).toBe(7);
    expect(codex.lastModel).toEqual({ model: 'gpt-6-astra', at: '2026-11-08T08:11:56.157Z' });
  });
});
