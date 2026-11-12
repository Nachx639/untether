import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import type { RoutableTask } from './task-router.js';
import {
  createLlmRouter,
  createTierClassifier,
  decideTier,
  LLM_ROUTE_MODEL,
  parseOpinion,
  parseTierOpinion,
  ROUTE_SYSTEM_PROMPT,
  type RouteChild,
  type RouteSpawner,
  routeQuestion,
  TIER_SYSTEM_PROMPT,
} from './task-router-llm.js';

/** A claude that prints `lines` (stream-json) and exits, or hangs when `hang`. */
class FakeChild extends EventEmitter implements RouteChild {
  stdout = new PassThrough();
  killed: string | undefined;
  kill(signal?: NodeJS.Signals) {
    this.killed = signal ?? 'SIGTERM';
    return true;
  }
}

const login: RoutableTask = {
  id: 'login',
  title: 'Login con Google',
  prompt: 'Añade login con Google',
  followUps: [{ text: 'que recuerde la sesión' }],
  branch: 'ut/login-google',
  files: ['src/auth.ts'],
  state: 'working',
};
const csv: RoutableTask = {
  id: 'csv',
  title: 'Exportar a CSV',
  prompt: 'Botón para exportar facturas',
  state: 'ready',
};

describe('task-router-llm', () => {
  let tmp: string;
  let tokenFile: string;
  let calls: Array<{ bin: string; args: string[]; env: NodeJS.ProcessEnv }>;
  let child: FakeChild;

  const spawner =
    (script: (child: FakeChild) => void): RouteSpawner =>
    (bin, args, { env }) => {
      calls.push({ bin, args, env });
      child = new FakeChild();
      const current = child;
      setImmediate(() => script(current));
      return current;
    };

  const reply = (text: string) => (current: FakeChild) => {
    current.stdout.write(`${JSON.stringify({ type: 'system', subtype: 'init' })}\n`);
    current.stdout.write(`${JSON.stringify({ type: 'result', result: text })}`);
    current.stdout.end();
    setImmediate(() => current.emit('close'));
  };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-router-llm-'));
    tokenFile = path.join(tmp, 'oauth-token');
    fs.writeFileSync(tokenFile, 'tok-123\n');
    calls = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tmp, RM_TEST_DIR);
  });

  it('asks Claude Haiku with no tools and no settings, and takes its pick', async () => {
    const router = createLlmRouter({
      claudeBin: '/bin/claude',
      tokenFile,
      spawn: spawner(reply('{"taskId": "login", "confident": true}')),
    });
    await expect(router('y que también pida el email', [login, csv])).resolves.toEqual({
      taskId: 'login',
      confident: true,
    });
    const [{ bin, args, env }] = calls;
    expect(bin).toBe('/bin/claude');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('tok-123');
    expect(args.slice(0, 7)).toEqual([
      '-p',
      '--model',
      LLM_ROUTE_MODEL,
      '--tools',
      '',
      '--setting-sources',
      '',
    ]);
    expect(LLM_ROUTE_MODEL).toBe('claude-haiku-5-5');
    expect(args).toContain(ROUTE_SYSTEM_PROMPT);
    expect(args[args.length - 1]).toBe(routeQuestion('y que también pida el email', [login, csv]));
  });

  it('takes "new" and an unsure answer as they are', async () => {
    const isNew = createLlmRouter({
      claudeBin: '/bin/claude',
      tokenFile,
      spawn: spawner(reply('Sure: {"taskId": null, "confident": true}')),
    });
    await expect(isNew('otra cosa', [login])).resolves.toEqual({ taskId: null, confident: true });
    const unsure = createLlmRouter({
      claudeBin: '/bin/claude',
      tokenFile,
      spawn: spawner(reply('{"taskId": "csv", "confident": false}')),
    });
    await expect(unsure('el botón', [login, csv])).resolves.toEqual({
      taskId: 'csv',
      confident: false,
    });
  });

  it('has no opinion on a task that is not a candidate, or on a reply that is not JSON', async () => {
    const other = createLlmRouter({
      claudeBin: '/bin/claude',
      tokenFile,
      spawn: spawner(reply('{"taskId": "merged-one", "confident": true}')),
    });
    await expect(other('x', [login])).resolves.toBeNull();
    const prose = createLlmRouter({
      claudeBin: '/bin/claude',
      tokenFile,
      spawn: spawner(reply('It goes with login.')),
    });
    await expect(prose('x', [login])).resolves.toBeNull();
  });

  it('gives up after 4 s and kills the process', async () => {
    vi.useFakeTimers();
    const router = createLlmRouter({
      claudeBin: '/bin/claude',
      tokenFile,
      spawn: spawner(() => {}),
    });
    const pending = router('x', [login]);
    await vi.advanceTimersByTimeAsync(3999);
    expect(child.killed).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBeNull();
    expect(child.killed).toBe('SIGKILL');
  });

  it('starts nothing without a token, without claude or without candidates', async () => {
    const spawn = vi.fn();
    const noToken = createLlmRouter({
      claudeBin: '/bin/claude',
      tokenFile: path.join(tmp, 'missing'),
      spawn,
    });
    await expect(noToken('x', [login])).resolves.toBeNull();
    const noClaude = createLlmRouter({ claudeBin: null, tokenFile, spawn });
    await expect(noClaude('x', [login])).resolves.toBeNull();
    const nothing = createLlmRouter({ claudeBin: '/bin/claude', tokenFile, spawn });
    await expect(nothing('x', [])).resolves.toBeNull();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('has no opinion when the process fails to start', async () => {
    const router = createLlmRouter({
      claudeBin: '/bin/claude',
      tokenFile,
      spawn: spawner((current) => current.emit('error', new Error('ENOENT'))),
    });
    await expect(router('x', [login])).resolves.toBeNull();
  });

  it('describes each candidate briefly', () => {
    const question = routeQuestion('añade logout', [login, csv]);
    expect(question).toContain('Request: añade logout');
    expect(question).toContain('- id: login');
    expect(question).toContain('branch: ut/login-google');
    expect(question).toContain('later: que recuerde la sesión');
    expect(question).toContain('files: src/auth.ts');
    expect(question).toContain('- id: csv');
    expect(parseOpinion('{"taskId": "csv"}', ['csv'])).toBeNull();
  });

  describe('model by difficulty (createTierClassifier)', () => {
    it('asks the same cheap model with its own prompt and reads its level', async () => {
      const classify = createTierClassifier({
        claudeBin: '/bin/claude',
        tokenFile,
        spawn: spawner(reply('{"tier": "fast", "confident": true, "reason": "a one-word rename"}')),
      });
      await expect(classify('Renombra getUser a fetchUser')).resolves.toEqual({
        tier: 'fast',
        confident: true,
        reason: 'a one-word rename',
      });
      const [{ args }] = calls;
      expect(args.slice(0, 3)).toEqual(['-p', '--model', LLM_ROUTE_MODEL]);
      expect(args).toContain(TIER_SYSTEM_PROMPT);
      expect(args[args.length - 1]).toBe('Request: Renombra getUser a fetchUser');
    });

    it('no claude, no answer or a reply that is not one: no opinion', async () => {
      await expect(createTierClassifier({ claudeBin: null, tokenFile })('x')).resolves.toBeNull();
      const junk = createTierClassifier({
        claudeBin: '/bin/claude',
        tokenFile,
        spawn: spawner(reply('{"tier": "medium", "confident": true}')),
      });
      await expect(junk('x')).resolves.toBeNull();
      vi.useFakeTimers();
      const slow = createTierClassifier({
        claudeBin: '/bin/claude',
        tokenFile,
        timeoutMs: 50,
        spawn: spawner(() => {}),
      });
      const answer = slow('x');
      await vi.advanceTimersByTimeAsync(60);
      await expect(answer).resolves.toBeNull();
      expect(child.killed).toBe('SIGKILL');
    });

    it('decides fast only on a confident fast; capable when unsure or without an answer', () => {
      expect(decideTier({ tier: 'fast', confident: true, reason: 'typo' })).toEqual({
        tier: 'fast',
        by: 'router',
        reason: 'typo',
      });
      expect(decideTier({ tier: 'fast', confident: false, reason: 'maybe' })).toMatchObject({
        tier: 'capable',
        by: 'default',
      });
      expect(decideTier({ tier: 'capable', confident: false, reason: 'auth' })).toMatchObject({
        tier: 'capable',
        by: 'router',
      });
      expect(decideTier(null)).toMatchObject({ tier: 'capable', by: 'default' });
      expect(parseTierOpinion('{"tier": "capable", "confident": "yes"}')).toBeNull();
    });
  });
});
