/**
 * A second opinion for routing, only when the rules (task-router.ts) are unsure: the prompt
 * and the candidate tasks go to Claude Haiku through the user's subscription (the copilot's
 * `claude -p`, copilot/brain.ts) and it answers {"taskId": "<id>" | null, "confident": bool}.
 *
 * Never in the way: no token or no claude → no opinion; no answer within 4 s → no opinion
 * (the process is killed); an answer naming a task that is not a candidate → no opinion. The
 * caller then asks the user as it would have anyway.
 */
import { spawn as nodeSpawn } from 'child_process';
import type { Readable } from 'stream';
import { streamEventModel } from '../../shared/agent-models.js';
import { extractJsonObject } from './ai-json-reply.js';
import {
  baseArgs,
  DEFAULT_MODEL,
  defaultTokenFile,
  findClaude,
  oauthEnv,
} from './copilot/brain.js';
import { modelRecorder } from './model-observations.js';
import type { RoutableTask } from './task-router.js';

export const LLM_ROUTE_TIMEOUT_MS = 4000;
export const LLM_ROUTE_MODEL = DEFAULT_MODEL;

/** What a spawned claude must offer (a ChildProcess, or a fake in tests). */
export interface RouteChild {
  stdout: Readable | null;
  on(event: 'close', listener: () => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
}

export type RouteSpawner = (
  bin: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; cwd?: string }
) => RouteChild;

export interface LlmRouteOpinion {
  /** The task it goes with, or null for a new task. */
  taskId: string | null;
  confident: boolean;
}

export interface LlmRouterOptions {
  spawn?: RouteSpawner;
  /** The claude program; null = none. Default: found like the copilot finds it. */
  claudeBin?: string | null;
  tokenFile?: string;
  timeoutMs?: number;
  model?: string;
}

export const ROUTE_SYSTEM_PROMPT = [
  'You route a developer request to one of their open coding tasks in the same repository.',
  'Each task is an agent already working on its own branch. If the request continues, fixes or',
  'extends one of the listed tasks, answer with that task id; if it is separate work, answer',
  'null. Set confident to false when it could reasonably go either way.',
  'Answer with one line of JSON and nothing else: {"taskId": "<id>" | null, "confident": true | false}',
].join(' ');

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** The user message: the request, then each candidate task. */
export function routeQuestion(text: string, candidates: readonly RoutableTask[]): string {
  const lines = [`Request: ${clip(text.trim(), 1500)}`, '', 'Open tasks:'];
  for (const task of candidates) {
    lines.push(`- id: ${task.id}`);
    lines.push(`  title: ${clip(task.title, 120)}`);
    if (task.branch) lines.push(`  branch: ${task.branch}`);
    lines.push(`  prompt: ${clip(task.prompt.replace(/\s+/g, ' '), 400)}`);
    for (const followUp of (task.followUps ?? []).slice(-2)) {
      lines.push(`  later: ${clip(followUp.text.replace(/\s+/g, ' '), 200)}`);
    }
    if (task.files?.length) lines.push(`  files: ${task.files.slice(0, 10).join(', ')}`);
  }
  return lines.join('\n');
}

/** The opinion in a reply, when it is one (valid JSON, a candidate's id or null). */
export function parseOpinion(
  reply: string,
  candidateIds: readonly string[]
): LlmRouteOpinion | null {
  const read = extractJsonObject(
    reply,
    (value): LlmRouteOpinion | null => {
      const { taskId, confident } = value as { taskId?: unknown; confident?: unknown };
      if (typeof confident !== 'boolean') return null;
      if (taskId === null) return { taskId: null, confident };
      if (typeof taskId !== 'string' || !candidateIds.includes(taskId)) return null;
      return { taskId, confident };
    },
    { unique: true }
  );
  return read.ok ? read.value : null;
}

/**
 * One question to Claude Haiku (`claude -p`, stream-json): resolves to `parse(reply)`, or null
 * whenever there is no usable answer (no claude, no token, too slow, unreadable).
 */
function askClaude<T>(
  options: LlmRouterOptions,
  defaults: { timeoutMs: number },
  system: string,
  question: string,
  parse: (reply: string) => T | null
): Promise<T | null> {
  const spawn: RouteSpawner =
    options.spawn ??
    ((bin, args, { env }) => nodeSpawn(bin, args, { env, stdio: ['ignore', 'pipe', 'ignore'] }));
  const timeoutMs = options.timeoutMs ?? defaults.timeoutMs;
  const model = options.model ?? LLM_ROUTE_MODEL;
  return new Promise((resolve) => {
    const bin = options.claudeBin === undefined ? findClaude() : options.claudeBin;
    if (!bin) return resolve(null);
    const env = oauthEnv(options.tokenFile ?? defaultTokenFile());
    if (typeof env === 'string') return resolve(null);

    const noteModel = modelRecorder('task router', model);
    let child: RouteChild;
    try {
      child = spawn(bin, [...baseArgs(model, system), question], { env });
    } catch {
      return resolve(null);
    }
    let settled = false;
    let reply = '';
    let buffer = '';
    const finish = (answer: T | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(answer);
    };
    const timer = setTimeout(() => {
      finish(null);
      try {
        child.kill('SIGKILL');
      } catch {
        // Gone already.
      }
    }, timeoutMs);
    const readLine = (line: string) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line) as { type?: string; result?: unknown };
        noteModel(streamEventModel(event));
        if (event.type === 'result' && typeof event.result === 'string') reply = event.result;
      } catch {
        // Not JSON: ignored.
      }
    };
    child.stdout?.on('data', (chunk: Buffer | string) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) readLine(line);
    });
    child.on('error', () => finish(null));
    child.on('close', () => {
      readLine(buffer);
      finish(parse(reply));
    });
  });
}

/**
 * A router asking Claude Haiku; resolves to null whenever it has no usable opinion. The
 * process's stream-json output ends in a `result` line holding the reply.
 */
export function createLlmRouter(options: LlmRouterOptions = {}) {
  return async (
    text: string,
    candidates: readonly RoutableTask[]
  ): Promise<LlmRouteOpinion | null> => {
    if (!candidates.length) return null;
    return askClaude(
      options,
      { timeoutMs: LLM_ROUTE_TIMEOUT_MS },
      ROUTE_SYSTEM_PROMPT,
      routeQuestion(text, candidates),
      (reply) =>
        parseOpinion(
          reply,
          candidates.map((task) => task.id)
        )
    );
  };
}

export type LlmRouter = ReturnType<typeof createLlmRouter>;

/*
 * Model by difficulty (2026-11-01, ProjectSettings.modelRouting): the same cheap question
 * picks the level of model a task's agent runs with. Fast only for work that is simple and
 * mechanical and said so with confidence; anything else (unsure, no answer) is capable.
 */

/** Longer than routing: it runs once per task, before its agent starts. */
export const LLM_TIER_TIMEOUT_MS = 8000;

export const TIER_SYSTEM_PROMPT = [
  'You pick the model level for a coding agent about to work on a developer request.',
  'Answer "fast" only when the work is simple and mechanical: a rename, a typo, a version bump,',
  'a small text or config edit, adding an obvious test, running a known command, a short lookup.',
  'Answer "capable" for anything else: design, debugging, several files or components, security,',
  'auth, data migrations, concurrency, performance, money, anything unclear or risky.',
  'Set confident to false when it could reasonably go either way. reason: at most 12 words.',
  'Answer with one line of JSON and nothing else:',
  '{"tier": "fast" | "capable", "confident": true | false, "reason": "<why>"}',
].join(' ');

export interface TierOpinion {
  tier: 'fast' | 'capable';
  confident: boolean;
  reason: string;
}

/** The opinion in a reply, when it is one. */
export function parseTierOpinion(reply: string): TierOpinion | null {
  const read = extractJsonObject(
    reply,
    (value): TierOpinion | null => {
      const { tier, confident, reason } = value as {
        tier?: unknown;
        confident?: unknown;
        reason?: unknown;
      };
      if (tier !== 'fast' && tier !== 'capable') return null;
      if (typeof confident !== 'boolean') return null;
      const why = typeof reason === 'string' ? clip(reason.replace(/\s+/g, ' ').trim(), 160) : '';
      return { tier, confident, reason: why };
    },
    { unique: true }
  );
  return read.ok ? read.value : null;
}

/** The decision for a prompt: fast only on a confident "fast", capable otherwise. */
export function decideTier(opinion: TierOpinion | null): {
  tier: 'fast' | 'capable';
  by: 'router' | 'default';
  reason: string;
} {
  if (!opinion) return { tier: 'capable', by: 'default', reason: 'no classification: capable' };
  if (opinion.tier === 'fast' && !opinion.confident) {
    return {
      tier: 'capable',
      by: 'default',
      reason: `unsure${opinion.reason ? ` (${opinion.reason})` : ''}: capable`,
    };
  }
  return { tier: opinion.tier, by: 'router', reason: opinion.reason || opinion.tier };
}

/** Classifies a task's prompt; resolves to null whenever it has no usable opinion. */
export function createTierClassifier(options: LlmRouterOptions = {}) {
  return (prompt: string): Promise<TierOpinion | null> =>
    askClaude(
      options,
      { timeoutMs: LLM_TIER_TIMEOUT_MS },
      TIER_SYSTEM_PROMPT,
      `Request: ${clip(prompt.trim(), 3000)}`,
      parseTierOpinion
    );
}

export type TierClassifier = ReturnType<typeof createTierClassifier>;
