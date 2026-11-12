import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RM_TEST_DIR } from '../../../test/helpers/rm-test-dir.js';
import { runTaskCli } from '../../task-cli.js';
import { ProjectSettingsStore } from '../project-settings.js';
import { type TaskCaller, type TaskCommandResult, TaskCommands } from '../task-commands.js';
import { ConnectorTokens } from './connector-tokens.js';

const UI: TaskCaller = { kind: 'ui' };
const AGENT: TaskCaller = { kind: 'cli', sessionId: 'agent-session' };

describe('ut project connector (task-commands)', () => {
  let tmp: string;
  let tokens: ConnectorTokens;
  let commands: TaskCommands;
  let autoApprove: boolean;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'connector-cmd-'));
    tokens = new ConnectorTokens({ storePath: path.join(tmp, 'connector', 'tokens.json') });
    autoApprove = false;
    commands = new TaskCommands({
      scheduler: () => null,
      settings: new ProjectSettingsStore(path.join(tmp, 'projects.json')),
      notify: vi.fn(),
      resolveRepo: async (dir) => (dir.startsWith('/repo') ? '/repo' : null),
      autoApprove: { get: () => autoApprove, set: (on) => (autoApprove = on) },
      connector: {
        add: (input) => tokens.add(input),
        activate: (id) => tokens.activate(id),
        setConfirmation: (id, confirmationId) => tokens.setConfirmation(id, confirmationId),
        list: (repoPath) => tokens.list(repoPath),
        revoke: (ref, repoPath) => tokens.revoke(ref, repoPath),
        url: async () => 'http://127.0.0.1:4023',
      },
    });
  });

  afterEach(() => fs.rmSync(tmp, RM_TEST_DIR));

  const tokenOf = (result: TaskCommandResult) =>
    (result.ok ? (result.data?.token as string) : undefined) ?? '';

  it("the user's token is active at once and shown once", async () => {
    const result = await commands.run('connector-add', { cwd: '/repo', name: 'bakery-app' }, UI);
    expect(result).toMatchObject({
      ok: true,
      status: 'done',
      data: { channel: { name: 'bakery-app', active: true }, url: 'http://127.0.0.1:4023' },
    });
    expect(tokens.authenticate(tokenOf(result))?.repoPath).toBe('/repo');
    const listed = await commands.run('connector-list', { cwd: '/repo' }, AGENT);
    expect(JSON.stringify(listed)).not.toContain(tokenOf(result));
    expect(JSON.stringify(listed)).not.toContain('hash');
  });

  it("an agent's token lets nobody in until the user approves it on the phone", async () => {
    const result = await commands.run('connector-add', { cwd: '/repo', name: 'from-agent' }, AGENT);
    expect(result).toMatchObject({
      ok: true,
      status: 'pending-confirmation',
      confirmation: { kind: 'connector-add', where: 'repo' },
      data: { channel: { active: false } },
    });
    const token = tokenOf(result);
    expect(tokens.authenticate(token)).toBeNull();
    // The agent can't activate it itself, not even by calling the internal op.
    const channelId = result.ok
      ? ((result.data?.channel as { id: string } | undefined)?.id ?? '')
      : '';
    expect(await commands.run('connector-activate', { id: channelId }, AGENT)).toMatchObject({
      ok: false,
      code: 'forbidden',
    });
    if (!result.ok || result.status !== 'pending-confirmation') throw new Error('not pending');
    expect(await commands.answerConfirmation(result.confirmation.id, true, AGENT)).toEqual({
      status: 'forbidden',
    });
    await commands.answerConfirmation(result.confirmation.id, true, UI);
    expect(tokens.authenticate(token)?.name).toBe('from-agent');
  });

  it('declined: the waiting token is dropped', async () => {
    const result = await commands.run('connector-add', { cwd: '/repo', name: 'declined' }, AGENT);
    if (!result.ok || result.status !== 'pending-confirmation') throw new Error('not pending');
    await commands.answerConfirmation(result.confirmation.id, false, UI);
    tokens.dropWaiting((id) => !!commands.confirmations.get(id));
    expect(tokens.list()).toEqual([]);
  });

  it('with autoApprove on it is active at once and the token is still handed over', async () => {
    autoApprove = true;
    const result = await commands.run('connector-add', { cwd: '/repo', name: 'auto' }, AGENT);
    expect(result).toMatchObject({ ok: true, status: 'done', data: { channel: { active: true } } });
    expect(tokens.authenticate(tokenOf(result))?.name).toBe('auto');
  });

  it('refuses a bad name, a duplicate, outside a repository; anyone may revoke', async () => {
    expect(
      await commands.run('connector-add', { cwd: '/repo', name: 'Bad Name!' }, UI)
    ).toMatchObject({ ok: false, code: 'bad-request' });
    await commands.run('connector-add', { cwd: '/repo', name: 'app' }, UI);
    expect(await commands.run('connector-add', { cwd: '/repo', name: 'app' }, UI)).toMatchObject({
      ok: false,
      code: 'busy',
    });
    expect(await commands.run('connector-add', { cwd: '/tmp', name: 'x' }, UI)).toMatchObject({
      ok: false,
      code: 'bad-request',
    });
    expect(
      await commands.run('connector-revoke', { cwd: '/repo', ref: 'app' }, AGENT)
    ).toMatchObject({ ok: true, data: { channel: { name: 'app' } } });
    expect(tokens.list()).toEqual([]);
  });

  it('the CLI builds the ops and prints the token once', async () => {
    const out: string[] = [];
    const calls: Array<{ op: string; args: unknown }> = [];
    const deps = {
      cwd: '/repo',
      env: {},
      out: (line: string) => out.push(line),
      err: (line: string) => out.push(`ERR ${line}`),
      readStdin: async () => '',
      task: async (op: string, args: Record<string, unknown>) => {
        calls.push({ op, args });
        return commands.run(op, args, UI);
      },
    };
    expect(
      await runTaskCli('project', ['connector', 'add', '--name', 'bakery-app'], deps as never)
    ).toBe(0);
    expect(calls[0]).toEqual({
      op: 'connector-add',
      args: { cwd: '/repo', name: 'bakery-app', repo: undefined },
    });
    expect(out.join('\n')).toMatch(/Token \(shown only now.*\): utc_[0-9a-f]{12}_/);
    expect(out.join('\n')).toContain('host.docker.internal:4023');
    out.length = 0;
    expect(await runTaskCli('project', ['connector', 'list'], deps as never)).toBe(0);
    expect(out.join('\n')).toContain('bakery-app  active');
    expect(out.join('\n')).not.toContain('utc_');
    expect(await runTaskCli('project', ['connector', 'revoke', 'bakery-app'], deps as never)).toBe(
      0
    );
    expect(tokens.list()).toEqual([]);
  });
});
