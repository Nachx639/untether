import { mkdtempSync, rmSync } from 'node:fs';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TaskRecord } from '../shared/tasks.js';
import { RM_TEST_DIR } from '../test/helpers/rm-test-dir.js';
import { MessageBuilder, MessageParser, MessageType, parsePayload } from './pty/socket-protocol.js';

// Real unix socket in a throwaway control dir: `ut task …` → api.sock → task-commands.ts.
describe('ut task over the API socket', () => {
  let dir: string;
  let server: import('./api-socket-server.js').ApiSocketServer;
  let scheduler: import('./services/task-scheduler.js').TaskScheduler;
  const notify = vi.fn();

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vtt-sock-'));
    process.env.UNTETHER_CONTROL_DIR = dir;
    const { ApiSocketServer } = await import('./api-socket-server.js');
    const { TaskScheduler } = await import('./services/task-scheduler.js');
    const { TaskCommands } = await import('./services/task-commands.js');
    const { ProjectSettingsStore } = await import('./services/project-settings.js');
    let sessions = 0;
    scheduler = new TaskScheduler({
      storePath: join(dir, 'tasks.json'),
      launch: async () => ({ sessionId: `task-session-${++sessions}` }),
      notify: vi.fn(),
      sessionStatus: () => 'running',
      deliver: () => true,
    });
    await scheduler.start(0);
    const commands = new TaskCommands({
      scheduler: () => scheduler,
      settings: new ProjectSettingsStore(join(dir, 'projects.json')),
      notify,
      commandFor: (agent) => [agent],
    });
    server = new ApiSocketServer();
    // As wired in server.ts.
    server.setTaskHandler((request) =>
      commands.run(request.op, request.args, {
        kind: 'cli',
        ...(request.callerSessionId ? { sessionId: request.callerSessionId } : {}),
      })
    );
    await server.start();
  });

  afterAll(() => {
    server?.stop();
    scheduler?.stop();
    if (dir) rmSync(dir, RM_TEST_DIR);
  });

  it('creates and lists tasks, and refuses what the caller may not do', async () => {
    const { SocketApiClient } = await import('./socket-api-client.js');
    const client = new SocketApiClient();
    const created = await client.task(
      'new',
      { prompt: 'Resume el repo', cwd: dir, isolation: 'none' },
      {}
    );
    expect(created).toMatchObject({ ok: true, status: 'done' });
    const task = (created as { data: { task: TaskRecord } }).data.task;
    expect(task).toMatchObject({ name: 'Resume el repo', state: 'working', command: ['claude'] });

    const listed = await client.task('list', {}, {});
    expect((listed as { data: { tasks: TaskRecord[] } }).data.tasks.map((t) => t.id)).toEqual([
      task.id,
    ]);

    // The task's own session reports done, and may not send to itself.
    const own = { sessionId: task.sessionId };
    expect(await client.task('send', { ref: task.id, text: 'x' }, own)).toMatchObject({
      ok: false,
      code: 'forbidden',
    });
    expect(await client.task('done', { summary: 'Resumido' }, own)).toMatchObject({
      ok: true,
      data: { task: { summary: 'Resumido' } },
    });

    // Another session's message waits for the user's OK.
    const other = await client.task('send', { ref: task.id, text: 'y más' }, { sessionId: 'x' });
    expect(other).toMatchObject({
      ok: true,
      status: 'pending-confirmation',
      confirmation: { kind: 'send', detail: ['y más'] },
    });
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'task-confirm' }));
  });

  it('answers the CLI end to end (runTaskCli → socket → commands)', async () => {
    const { SocketApiClient } = await import('./socket-api-client.js');
    const { runTaskCli } = await import('./task-cli.js');
    const client = new SocketApiClient();
    const out: string[] = [];
    const err: string[] = [];
    const exit = await runTaskCli('task', ['list', '--all'], {
      task: (op, args, caller) => client.task(op, args, caller),
      env: {},
      cwd: dir,
      readStdin: async () => '',
      out: (text) => out.push(text),
      err: (text) => err.push(text),
    });
    expect(exit).toBe(0);
    expect(out.join('\n')).toContain('Resume el repo');
    expect(
      await runTaskCli('task', ['done'], {
        task: (op, args, caller) => client.task(op, args, caller),
        env: { UNTETHER_SESSION_ID: 'not-a-task' },
        cwd: dir,
        readStdin: async () => '',
        out: (text) => out.push(text),
        err: (text) => err.push(text),
      })
    ).toBe(1);
    expect(err.at(-1)).toBe("Error: 'ut task done' only works inside a task's own session");
  });

  it('answers a malformed request with bad-request instead of dropping it', async () => {
    const socket = net.createConnection(join(dir, 'api.sock'));
    await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
    const parser = new MessageParser();
    const reply = new Promise<unknown>((resolve) => {
      socket.on('data', (chunk) => {
        parser.addData(chunk);
        for (const { type, payload } of parser.parseMessages()) {
          if (type === MessageType.TASK_RESPONSE) resolve(parsePayload(type, payload));
        }
      });
    });
    socket.write(
      MessageBuilder.taskRequest({ op: 42, args: 'nope' } as unknown as {
        op: string;
        args: Record<string, unknown>;
      })
    );
    expect(await reply).toEqual({
      ok: false,
      code: 'bad-request',
      message: 'Malformed task request',
    });
    socket.destroy();
  });
});

describe('ut task without a task handler', () => {
  it('says tasks are not available', async () => {
    const other = mkdtempSync(join(tmpdir(), 'vtt-none-'));
    const previous = process.env.UNTETHER_CONTROL_DIR;
    process.env.UNTETHER_CONTROL_DIR = other;
    try {
      const { ApiSocketServer } = await import('./api-socket-server.js');
      const { SocketApiClient } = await import('./socket-api-client.js');
      const server = new ApiSocketServer();
      await server.start();
      try {
        expect(await new SocketApiClient().task('list', {})).toEqual({
          ok: false,
          code: 'unavailable',
          message: 'Tasks are not available on this server',
        });
      } finally {
        server.stop();
      }
    } finally {
      process.env.UNTETHER_CONTROL_DIR = previous;
      rmSync(other, RM_TEST_DIR);
    }
  });
});
