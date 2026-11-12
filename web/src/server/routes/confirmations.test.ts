import express from 'express';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { ProjectSettingsStore } from '../services/project-settings.js';
import { TaskCommands } from '../services/task-commands.js';
import { TaskScheduler } from '../services/task-scheduler.js';
import { createConfirmationRoutes } from './confirmations.js';

describe('confirmation routes', () => {
  let tmp: string;
  let app: express.Express;
  let scheduler: TaskScheduler;
  let commands: TaskCommands;
  let deliver: ReturnType<typeof vi.fn>;
  let authMethod: string;
  let taskId: string;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-confirm-routes-'));
    deliver = vi.fn(() => true);
    scheduler = new TaskScheduler({
      storePath: path.join(tmp, 'tasks.json'),
      launch: async () => ({ sessionId: 'task-session' }),
      notify: vi.fn(),
      sessionStatus: () => 'running',
      deliver,
    });
    await scheduler.start(0);
    commands = new TaskCommands({
      scheduler: () => scheduler,
      settings: new ProjectSettingsStore(path.join(tmp, 'projects.json')),
      notify: vi.fn(),
    });
    const created = await commands.run(
      'new',
      { name: 'Resumen', prompt: 'Resume el repo', workingDir: tmp, command: ['claude'] },
      { kind: 'ui' }
    );
    taskId = ((created as { data: { task: { id: string } } }).data.task as { id: string }).id;
    authMethod = 'password';
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as { authMethod?: string }).authMethod = authMethod;
      next();
    });
    app.use('/api', createConfirmationRoutes({ commands }));
  });

  afterEach(() => {
    scheduler.stop();
    fs.rmSync(tmp, RM_TEST_DIR);
  });

  async function pendingSend(text: string): Promise<string> {
    const result = await commands.run(
      'send',
      { ref: taskId, text },
      { kind: 'cli', sessionId: 'some-session' }
    );
    if (!result.ok || result.status !== 'pending-confirmation') throw new Error('not pending');
    return result.confirmation.id;
  }

  it('lists the pending ones and runs one approved in the app, once', async () => {
    const id = await pendingSend('y el logout');
    const list = await request(app).get('/api/confirmations');
    expect(list.status).toBe(200);
    expect(list.body.confirmations).toEqual([
      expect.objectContaining({ id, kind: 'send', taskId, detail: ['y el logout'] }),
    ]);
    const approved = await request(app).post(`/api/confirmations/${id}`).send({ approve: true });
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ status: 'approved', result: { task: { id: taskId } } });
    // Typed under its message id and sender (agent-messages.ts, 2026-11-10): the session that
    // wrote it, not the user who only approved sending it.
    expect(deliver).toHaveBeenCalledWith(
      'task-session',
      expect.stringMatching(
        /^\[untether\] Message m[a-z2-9]{6} from session some-ses \(another agent; the user approved sending it\):\ny el logout$/
      ),
      'claude'
    );
    const again = await request(app).post(`/api/confirmations/${id}`).send({ approve: true });
    expect(again.status).toBe(404);
    expect(again.body.error).toBe('gone');
    expect((await request(app).get('/api/confirmations')).body.confirmations).toEqual([]);
  });

  it('declines, and refuses bad bodies', async () => {
    const id = await pendingSend('nada');
    expect((await request(app).post(`/api/confirmations/${id}`).send({})).status).toBe(400);
    const declined = await request(app).post(`/api/confirmations/${id}`).send({ approve: false });
    expect(declined.body).toEqual({ status: 'declined' });
    expect(deliver).not.toHaveBeenCalled();
  });

  it('never lets a request without a login see or answer them (the asker approving itself)', async () => {
    const id = await pendingSend('aprueba esto');
    authMethod = 'local-bypass';
    expect((await request(app).get('/api/confirmations')).status).toBe(403);
    const answer = await request(app).post(`/api/confirmations/${id}`).send({ approve: true });
    expect(answer.status).toBe(403);
    expect(deliver).not.toHaveBeenCalled();
    authMethod = 'password';
    expect((await request(app).get('/api/confirmations')).body.confirmations).toHaveLength(1);
  });

  it('reports an approved action that could not run', async () => {
    const id = await pendingSend('tarde');
    await scheduler.discard(taskId, { confirm: true });
    const answer = await request(app).post(`/api/confirmations/${id}`).send({ approve: true });
    expect(answer.status).toBe(409);
    expect(answer.body).toMatchObject({ error: 'not-open', status: 'approved' });
  });
});
