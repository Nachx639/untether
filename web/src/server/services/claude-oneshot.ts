/**
 * One question to Claude through the user's subscription (`claude -p`, the copilot's flags in
 * copilot/brain.ts): no tools, no settings, the reply read from the stream-json `result` line.
 *
 * Never in the way: no claude, no token, a spawn error or no answer within `timeoutMs` (the
 * process is then killed) all resolve to null, and the caller goes on without an opinion.
 * Same mechanism as task-router-llm.ts; used by the git-init review (project-git-init.ts).
 */
import { spawn as nodeSpawn } from 'child_process';
import { streamEventModel } from '../../shared/agent-models.js';
import {
  baseArgs,
  DEFAULT_MODEL,
  defaultTokenFile,
  findClaude,
  oauthEnv,
} from './copilot/brain.js';
import { modelRecorder } from './model-observations.js';
import type { RouteChild, RouteSpawner } from './task-router-llm.js';

export type ClaudeChild = RouteChild;
export type ClaudeSpawner = RouteSpawner;

export interface ClaudeOnceOptions {
  spawn?: ClaudeSpawner;
  /** The claude program; null = none. Default: found like the copilot finds it. */
  claudeBin?: string | null;
  tokenFile?: string;
  timeoutMs: number;
  model?: string;
  /** Where claude runs (default: the server's own folder). */
  cwd?: string;
  /** What it is for, for the record of real models (model-observations.ts): `task review`. */
  purpose?: string;
}

/** The reply text, or null when there is none (see the file comment). */
export function askClaudeOnce(
  options: ClaudeOnceOptions,
  systemPrompt: string,
  question: string
): Promise<string | null> {
  const spawn: ClaudeSpawner =
    options.spawn ??
    ((bin, args, { env, cwd }) =>
      nodeSpawn(bin, args, { env, cwd, stdio: ['ignore', 'pipe', 'ignore'] }));
  return new Promise((resolve) => {
    const bin = options.claudeBin === undefined ? findClaude() : options.claudeBin;
    if (!bin) return resolve(null);
    const env = oauthEnv(options.tokenFile ?? defaultTokenFile());
    if (typeof env === 'string') return resolve(null);

    const model = options.model ?? DEFAULT_MODEL;
    const noteModel = modelRecorder(options.purpose ?? 'claude -p', model);
    let child: ClaudeChild;
    try {
      child = spawn(bin, [...baseArgs(model, systemPrompt), question], {
        env,
        ...(options.cwd ? { cwd: options.cwd } : {}),
      });
    } catch {
      return resolve(null);
    }
    let settled = false;
    let reply: string | null = null;
    let buffer = '';
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      finish(null);
      try {
        child.kill('SIGKILL');
      } catch {
        // Gone already.
      }
    }, options.timeoutMs);
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
      finish(reply);
    });
  });
}
