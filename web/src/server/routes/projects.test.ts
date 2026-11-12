import * as childProcess from 'child_process';
import express from 'express';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskRecord } from '../../shared/tasks.js';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { Orchestrator } from '../services/orchestrator.js';
import { createProjectCreator, NEW_PROJECT_COMMIT_MESSAGE } from '../services/project-create.js';
import { createGitInit } from '../services/project-git-init.js';
import { ProjectSettingsStore } from '../services/project-settings.js';
import { TaskCommands } from '../services/task-commands.js';
import type { TaskScheduler } from '../services/task-scheduler.js';
import { createProjectRoutes } from './projects.js';

const GIT_ENV = {
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

function git(cwd: string, ...args: string[]): string {
  return childProcess
    .execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, ...GIT_ENV } })
    .toString()
    .trim();
}

describe('project routes', () => {
  let tmp: string;
  let repo: string;
  let app: express.Express;
  let store: ProjectSettingsStore;
  let tasks: Partial<TaskRecord>[];
  let authMethod: string;
  let commands: TaskCommands;
  let notify: ReturnType<typeof vi.fn>;
  // 2026-11-02: the committed web + mac repo is built once per file and copied into each test's
  // folder (3 git processes per test became 0). A repo without worktrees or remotes holds no
  // absolute paths, so the copy is the same state.
  let template: string;

  beforeAll(() => {
    template = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ut-project-routes-tpl-')));
    fs.mkdirSync(path.join(template, 'web', 'src'), { recursive: true });
    git(template, 'init', '-q', '-b', 'main');
    fs.writeFileSync(
      path.join(template, 'web', 'package.json'),
      JSON.stringify({ scripts: { lint: 'biome check', test: 'vitest run' } })
    );
    fs.writeFileSync(path.join(template, 'web', 'pnpm-lock.yaml'), '');
    fs.writeFileSync(path.join(template, 'web', 'src', 'a.ts'), 'x\n');
    fs.mkdirSync(path.join(template, 'mac', 'My App.xcodeproj'), { recursive: true });
    fs.writeFileSync(path.join(template, 'mac', 'My App.xcodeproj', 'project.pbxproj'), '{}\n');
    git(template, 'add', '.');
    git(template, 'commit', '-q', '-m', 'init');
  });

  afterAll(() => {
    fs.rmSync(template, RM_TEST_DIR);
  });

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ut-project-routes-')));
    repo = path.join(tmp, 'app');
    fs.cpSync(template, repo, { recursive: true });
    store = new ProjectSettingsStore(path.join(tmp, 'projects.json'));
    tasks = [
      { id: '1', repoPath: repo, state: 'working' },
      { id: '2', repoPath: repo, state: 'merged' },
      { id: '3', state: 'ready' },
    ];
    const scheduler = () => ({ list: () => tasks }) as unknown as TaskScheduler;
    authMethod = 'password';
    notify = vi.fn();
    commands = new TaskCommands({ scheduler, settings: store, notify });
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as { authMethod?: string }).authMethod = authMethod;
      next();
    });
    app.use('/api', createProjectRoutes({ settings: store, scheduler, commands }));
  });

  afterEach(() => {
    fs.rmSync(tmp, RM_TEST_DIR);
  });

  it('reads and writes a project settings from any folder inside it', async () => {
    const empty = await request(app)
      .get('/api/projects/settings')
      .query({ repo: `${repo}/web` });
    expect(empty.status).toBe(200);
    expect(empty.body).toMatchObject({
      repoPath: repo,
      settings: { mergePolicy: 'auto', verifyTimeoutSec: 900 },
      stored: {},
    });

    const put = await request(app)
      .put('/api/projects/settings')
      .send({
        repoPath: path.join(repo, 'web', 'src'),
        settings: { mergePolicy: 'ask', checkCommand: 'make check' },
      });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({
      repoPath: repo,
      settings: { mergePolicy: 'ask', checkCommand: 'make check' },
      stored: { mergePolicy: 'ask', checkCommand: 'make check' },
    });
    const cleared = await request(app)
      .put('/api/projects/settings')
      .send({ repoPath: repo, settings: { checkCommand: null } });
    expect(cleared.body.stored).toEqual({ mergePolicy: 'ask' });

    for (const bad of [
      { repoPath: repo, settings: { mergePolicy: 'never' } },
      { repoPath: repo },
      { repoPath: tmp, settings: {} },
    ]) {
      expect((await request(app).put('/api/projects/settings').send(bad)).status).toBe(400);
    }
    expect((await request(app).get('/api/projects/settings').query({ repo: tmp })).status).toBe(
      400
    );
    expect((await request(app).get('/api/projects/settings')).status).toBe(400);
  });

  it('a change without a login waits for the user OK; approved, it applies', async () => {
    authMethod = 'local-bypass';
    const put = await request(app)
      .put('/api/projects/settings')
      .send({ repoPath: repo, settings: { checkCommand: 'true', mergePolicy: 'auto' } });
    expect(put.status).toBe(202);
    expect(put.body.confirmation).toMatchObject({
      kind: 'project-set',
      repoPath: repo,
      detail: ['mergePolicy: (default) → auto', 'checkCommand: (default) → true'],
    });
    expect(store.getStored(repo)).toEqual({});
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'task-confirm' }));
    // Reading needs no OK; nobody but the app may hand out the orchestrator role.
    expect((await request(app).get('/api/projects/settings').query({ repo })).status).toBe(200);
    const orchestrator = await request(app)
      .put('/api/projects/settings')
      .send({ repoPath: repo, settings: { orchestratorSessionId: 'me' } });
    expect(orchestrator.status).toBe(403);

    const answer = await commands.answerConfirmation(put.body.confirmation.id, true, {
      kind: 'ui',
    });
    expect(answer.status).toBe('approved');
    expect(store.getStored(repo)).toEqual({ checkCommand: 'true', mergePolicy: 'auto' });
  });

  it('lists projects with settings or tasks, counting open tasks', async () => {
    const other = path.join(tmp, 'other');
    fs.mkdirSync(other);
    git(other, 'init', '-q');
    store.update(other, { mergePolicy: 'ask' });
    const res = await request(app).get('/api/projects');
    expect(res.body.projects).toEqual([
      expect.objectContaining({ name: 'app', repoPath: repo, openTasks: 1 }),
      expect.objectContaining({
        name: 'other',
        openTasks: 0,
        settings: expect.objectContaining({ mergePolicy: 'ask' }),
      }),
    ]);
  });

  it('detects the check each package would run, and only suggests one for Xcode', async () => {
    const res = await request(app).get('/api/projects/detect-check').query({ repo });
    expect(res.status).toBe(200);
    expect(res.body.checks).toEqual([
      expect.objectContaining({ dir: 'web', command: 'pnpm run lint && pnpm run test' }),
    ]);
    expect(res.body.suggestions).toEqual([
      expect.objectContaining({
        command:
          "xcodebuild test -project 'mac/My App.xcodeproj' -scheme 'My App' -destination 'platform=macOS'",
      }),
    ]);
    expect(res.body.override).toBeNull();
  });

  it('forgets a project (2026-10-20): its record goes, never its folder; refused with open tasks', async () => {
    const gone = path.join(tmp, 'gone');
    store.update(gone, { pinnedAt: '2026-10-18T17:28:12.025Z', mergePolicy: 'ask' });
    const res = await request(app).delete('/api/projects').query({ repo: gone });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ repoPath: gone, forgotten: true });
    expect(store.list().map((entry) => entry.repoPath)).not.toContain(gone);
    // A project with open tasks stays.
    store.update(repo, { mergePolicy: 'ask' });
    const busy = await request(app).delete('/api/projects').query({ repo });
    expect(busy.status).toBe(409);
    expect(busy.body).toMatchObject({ error: 'open-tasks', openTasks: 1 });
    expect(fs.existsSync(repo)).toBe(true);
    expect(store.getStored(repo).mergePolicy).toBe('ask');
  });

  it('without a login, forgets a project only once the user approves it (2026-10-24)', async () => {
    const gone = path.join(tmp, 'prueba-encargo');
    store.update(gone, { pinnedAt: '2026-10-18T17:28:12.025Z' });
    authMethod = 'local-bypass';
    const asked = await request(app).delete('/api/projects').query({ repo: gone });
    expect(asked.status).toBe(202);
    expect(asked.body.confirmation).toMatchObject({
      kind: 'project-forget',
      where: 'prueba-encargo',
      repoPath: gone,
      summary: 'Forget the project prueba-encargo',
    });
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'task-confirm' }));
    expect(store.list().map((entry) => entry.repoPath)).toContain(gone);
    // Nothing to ask about: no record of it.
    const unknown = await request(app)
      .delete('/api/projects')
      .query({ repo: path.join(tmp, 'never') });
    expect(unknown.status).toBe(404);
    // Open tasks refuse it before anyone is asked.
    store.update(repo, { mergePolicy: 'ask' });
    const busy = await request(app).delete('/api/projects').query({ repo });
    expect(busy.status).toBe(409);
    expect(busy.body).toMatchObject({ error: 'open-tasks', openTasks: 1 });

    const answer = await commands.answerConfirmation(asked.body.confirmation.id, true, {
      kind: 'ui',
    });
    expect(answer).toMatchObject({
      status: 'approved',
      result: { ok: true, data: { repoPath: gone, forgotten: true } },
    });
    expect(store.list().map((entry) => entry.repoPath)).not.toContain(gone);
    expect(store.getStored(repo).mergePolicy).toBe('ask');
  });

  it('with autoApprove on, an agent forgets a project at once and the user is told', async () => {
    const auto = new TaskCommands({
      scheduler: () => ({ list: () => tasks }) as unknown as TaskScheduler,
      settings: store,
      notify,
      autoApprove: { get: () => true, set: () => {} },
    });
    const gone = path.join(tmp, 'prueba-orquestador');
    store.update(gone, { mergePolicy: 'ask' });
    const result = await auto.run(
      'project-forget',
      { repo: gone },
      { kind: 'cli', sessionId: 'cobot' }
    );
    expect(result).toMatchObject({
      ok: true,
      status: 'done',
      data: { repoPath: gone, forgotten: true, autoApproved: { summary: expect.any(String) } },
    });
    expect(store.list().map((entry) => entry.repoPath)).not.toContain(gone);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'task-auto-approved',
        data: expect.objectContaining({ kind: 'project-forget' }),
      })
    );
    // Open tasks still refuse it, autoApprove or not.
    store.update(repo, { mergePolicy: 'ask' });
    expect(await auto.run('project-forget', { repo }, { kind: 'cli' })).toMatchObject({
      ok: false,
      data: { error: 'open-tasks' },
    });
    expect(store.getStored(repo).mergePolicy).toBe('ask');
  });

  it('the circuit breaker pause clears through the settings route ("Reactivar")', async () => {
    store.update(repo, {
      autoMergePausedUntil: new Date(Date.now() + 3600_000).toISOString(),
      autoMergePausedReason: 'two undone',
    });
    const put = await request(app)
      .put('/api/projects/settings')
      .send({
        repoPath: repo,
        settings: { autoMergePausedUntil: null, autoMergePausedReason: null },
      });
    expect(put.status).toBe(200);
    expect(store.getStored(repo).autoMergePausedUntil).toBeUndefined();
  });

  // P7: the app starts and stops a project's orchestrator; nobody else may.
  it('pins a project (a folder without git too) on top, in pin order, and unpins it', async () => {
    const folder = path.join(tmp, 'notes');
    fs.mkdirSync(folder);
    expect(
      (await request(app).post('/api/projects/pin').send({ repoPath: folder, pinned: true })).body
    ).toEqual({ repoPath: folder, pinned: true });
    await request(app).post('/api/projects/pin').send({ repoPath: repo, pinned: true });
    expect(store.pinned()).toEqual([folder, repo]);
    await request(app).post('/api/projects/pin').send({ repoPath: folder, pinned: false });
    expect(store.pinned()).toEqual([repo]);

    authMethod = 'local-bypass';
    expect(
      (await request(app).post('/api/projects/pin').send({ repoPath: folder, pinned: true })).status
    ).toBe(403);
    authMethod = 'password';
    expect(
      (await request(app).post('/api/projects/pin').send({ repoPath: 'rel', pinned: true })).status
    ).toBe(400);
  });

  describe('orchestrator', () => {
    let orch: express.Express;
    let created: string[][];
    let stopped: string[];
    let running: Set<string>;

    beforeEach(() => {
      created = [];
      stopped = [];
      running = new Set();
      // Starting one from a request without a login waits for the user's OK (2026-10-23):
      // the approved action runs through the commands, so they reach the orchestrator.
      commands = new TaskCommands({
        scheduler: () => null,
        settings: store,
        notify,
        orchestrator: () => orchestrator,
      });
      const orchestrator: Orchestrator = new Orchestrator({
        commands,
        settings: store,
        tasks: () => null,
        createSession: async (command) => {
          created.push(command);
          running.add('orch-1');
          return { sessionId: 'orch-1' };
        },
        deliver: () => true,
        sessionStatus: (id) => (running.has(id) ? 'running' : undefined),
        stopSession: async (id) => {
          stopped.push(id);
          running.delete(id);
        },
        claudeCommand: () => ['claude'],
        resolveRepo: async (dir) => (dir.startsWith(repo) && fs.existsSync(repo) ? repo : null),
      });
      orch = express();
      orch.use(express.json());
      orch.use((req, _res, next) => {
        (req as { authMethod?: string }).authMethod = authMethod;
        next();
      });
      orch.use(
        '/api',
        createProjectRoutes({
          settings: store,
          scheduler: () => null,
          commands,
          orchestrator: () => orchestrator,
        })
      );
    });

    it('POST starts it (a second goal reuses it), DELETE stops it', async () => {
      const started = await request(orch)
        .post('/api/projects/orchestrator')
        .send({ repoPath: path.join(repo, 'web'), goal: 'Añade login' });
      expect(started.status).toBe(200);
      expect(started.body).toEqual({ repoPath: repo, sessionId: 'orch-1', reused: false });
      expect(created[0]).toContain('Bash(ut task:*)');
      expect(store.get(repo).orchestratorSessionId).toBe('orch-1');
      expect(commands.roleFor({ kind: 'cli', sessionId: 'orch-1' }, repo)).toBe('orchestrator');

      const again = await request(orch)
        .post('/api/projects/orchestrator')
        .send({ repoPath: repo, goal: 'Y el logout' });
      expect(again.body).toMatchObject({ sessionId: 'orch-1', reused: true });
      expect(created).toHaveLength(1);

      const gone = await request(orch).delete(
        `/api/projects/orchestrator?repo=${encodeURIComponent(repo)}`
      );
      expect(gone.status).toBe(200);
      expect(gone.body).toEqual({ sessionId: 'orch-1' });
      expect(stopped).toEqual(['orch-1']);
      expect(store.get(repo).orchestratorSessionId).toBeUndefined();
      expect(
        (await request(orch).delete(`/api/projects/orchestrator?repo=${encodeURIComponent(repo)}`))
          .status
      ).toBe(404);
    });

    it('without a login, starts only once the user approves it on the phone', async () => {
      authMethod = 'local-bypass';
      const asked = await request(orch)
        .post('/api/projects/orchestrator')
        .send({ repoPath: path.join(repo, 'web'), goal: 'Monta el proyecto\ncon tests' });
      expect(asked.status).toBe(202);
      expect(asked.body.status).toBe('pending-confirmation');
      const confirmation = asked.body.confirmation;
      expect(confirmation).toMatchObject({
        kind: 'project-orchestrate',
        where: 'app',
        repoPath: repo,
        summary: 'Start the orchestrator of app',
        detail: [
          `Project: ${repo}`,
          'Untether will trust this folder for Claude Code.',
          'Goal:',
          'Monta el proyecto',
          'con tests',
        ],
      });
      expect(created).toHaveLength(0);
      expect(store.get(repo).orchestratorSessionId).toBeUndefined();
      expect(notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'task-confirm' }));
      // Asking again does not push a second time.
      const again = await request(orch)
        .post('/api/projects/orchestrator')
        .send({ repoPath: repo, goal: 'Monta el proyecto\ncon tests' });
      expect(again.body.confirmation.id).toBe(confirmation.id);
      // Nobody without a login answers it.
      expect(
        (await commands.answerConfirmation(confirmation.id, true, { kind: 'cli' })).status
      ).toBe('forbidden');
      expect(created).toHaveLength(0);

      const answer = await commands.answerConfirmation(confirmation.id, true, { kind: 'ui' });
      expect(answer).toMatchObject({
        status: 'approved',
        result: { ok: true, data: { repoPath: repo, sessionId: 'orch-1', reused: false } },
      });
      expect(created).toHaveLength(1);
      expect(store.get(repo).orchestratorSessionId).toBe('orch-1');
      expect(commands.roleFor({ kind: 'cli', sessionId: 'orch-1' }, repo)).toBe('orchestrator');
    });

    it('without a login, a declined request starts nothing', async () => {
      authMethod = 'local-bypass';
      const asked = await request(orch)
        .post('/api/projects/orchestrator')
        .send({ repoPath: repo, goal: 'x' });
      expect(asked.status).toBe(202);
      expect(
        (await commands.answerConfirmation(asked.body.confirmation.id, false, { kind: 'ui' }))
          .status
      ).toBe('declined');
      expect(created).toHaveLength(0);
      expect(store.get(repo).orchestratorSessionId).toBeUndefined();
      expect(commands.confirmations.outcome(asked.body.confirmation.id)?.status).toBe('declined');
    });

    it('forgetting a project whose folder is gone stops its running orchestrator first', async () => {
      await request(orch).post('/api/projects/orchestrator').send({ repoPath: repo, goal: 'x' });
      expect(store.get(repo).orchestratorSessionId).toBe('orch-1');
      fs.rmSync(repo, RM_TEST_DIR);
      const res = await request(orch).delete('/api/projects').query({ repo });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ repoPath: repo, forgotten: true });
      expect(stopped).toEqual(['orch-1']);
      expect(store.list().map((entry) => entry.repoPath)).not.toContain(repo);
      expect(commands.roleFor({ kind: 'cli', sessionId: 'orch-1' }, repo)).toBe('session');
    });

    it('refuses adopting or stopping without a login, and bad input', async () => {
      authMethod = 'local-bypass';
      expect(
        (
          await request(orch)
            .post('/api/projects/orchestrator/adopt')
            .send({ repoPath: repo, sessionId: 's' })
        ).status
      ).toBe(403);
      expect(
        (await request(orch).post('/api/projects/orchestrator').send({ repoPath: tmp, goal: 'x' }))
          .status
      ).toBe(400);
      expect(created).toHaveLength(0);
      expect(
        (await request(orch).delete(`/api/projects/orchestrator?repo=${encodeURIComponent(repo)}`))
          .status
      ).toBe(403);
      authMethod = 'password';
      expect(
        (await request(orch).post('/api/projects/orchestrator').send({ repoPath: repo })).status
      ).toBe(400);
      expect(
        (await request(orch).post('/api/projects/orchestrator').send({ repoPath: tmp, goal: 'x' }))
          .status
      ).toBe(400);
      // A server without orchestrators (an HQ).
      expect(
        (await request(app).post('/api/projects/orchestrator').send({ repoPath: repo, goal: 'x' }))
          .status
      ).toBe(503);
    });
  });

  describe('git-init', () => {
    let gitApp: express.Express;
    let folder: string;
    const reviewer = vi.fn(async () => ({
      status: 'done' as const,
      summary: 'Todo bien',
      verdicts: [{ path: 'notes.txt', action: 'include' as const, reason: 'Notas' }],
    }));

    beforeEach(() => {
      folder = path.join(tmp, 'Projects', 'tele');
      fs.mkdirSync(path.join(folder, 'node_modules', 'x'), { recursive: true });
      fs.writeFileSync(path.join(folder, 'node_modules', 'x', 'i.js'), '');
      fs.writeFileSync(path.join(folder, 'notes.txt'), 'hola\n');
      fs.writeFileSync(path.join(folder, '.env'), 'TOKEN=1\n');
      gitApp = express();
      gitApp.use(express.json());
      gitApp.use((req, _res, next) => {
        (req as { authMethod?: string }).authMethod = authMethod;
        next();
      });
      const scheduler = () => null;
      gitApp.use(
        '/api',
        createProjectRoutes({
          settings: store,
          scheduler,
          commands,
          gitInit: createGitInit({ home: tmp, reviewer }),
        })
      );
    });

    it('previews, reviews and makes the repository for the signed-in app', async () => {
      const preview = await request(gitApp).post('/api/projects/git-init/preview').send({ folder });
      expect(preview.status).toBe(200);
      expect(preview.body).toMatchObject({ folder, files: 1, capped: false, flagged: [] });
      expect(preview.body.ignore.map((entry: { pattern: string }) => entry.pattern)).toEqual(
        expect.arrayContaining(['node_modules/', '.env'])
      );

      const review = await request(gitApp)
        .post('/api/projects/git-init/review')
        .send({ folder, locale: 'es' });
      expect(review.status).toBe(200);
      expect(review.body).toMatchObject({ status: 'done', summary: 'Todo bien' });
      expect(reviewer).toHaveBeenCalledWith(expect.anything(), 'es');

      const init = await request(gitApp)
        .post('/api/projects/git-init')
        .send({ folder, exclude: [] });
      expect(init.status).toBe(200);
      expect(init.body).toMatchObject({ repoPath: folder, files: 2 });
      expect(git(folder, 'ls-files').split('\n').sort()).toEqual(['.gitignore', 'notes.txt']);

      const again = await request(gitApp).post('/api/projects/git-init').send({ folder });
      expect(again.status).toBe(409);
      // A folder holding the repo's main checkout (the fixture repo) is refused too.
      expect(
        (await request(gitApp).post('/api/projects/git-init/preview').send({ folder: repo })).status
      ).toBe(409);
    });

    it('refuses callers without a login (an agent with curl) and bad input', async () => {
      authMethod = 'local-bypass';
      for (const route of ['/preview', '/review', '']) {
        const res = await request(gitApp).post(`/api/projects/git-init${route}`).send({ folder });
        expect(res.status).toBe(403);
      }
      expect(fs.existsSync(path.join(folder, '.git'))).toBe(false);
      authMethod = 'password';
      expect((await request(gitApp).post('/api/projects/git-init').send({})).status).toBe(400);
      expect(
        (await request(gitApp).post('/api/projects/git-init/preview').send({ folder: tmp })).status
      ).toBe(400);
      expect(
        (
          await request(gitApp)
            .post('/api/projects/git-init')
            .send({ folder, exclude: ['../escape'] })
        ).status
      ).toBe(400);
    });
  });

  describe('new project (2026-10-24)', () => {
    let newApp: express.Express;
    let parent: string;
    let lastParent: string | undefined;
    let start: ReturnType<typeof vi.fn>;

    // The user's git starts repositories on "trunk": the first commit is on that branch.
    const USER_GIT = {
      ...GIT_ENV,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'init.defaultBranch',
      GIT_CONFIG_VALUE_0: 'trunk',
    };

    beforeEach(() => {
      parent = path.join(tmp, 'Projects');
      fs.mkdirSync(parent);
      lastParent = undefined;
      start = vi.fn(async (dir: string) => ({
        ok: true as const,
        repoPath: dir,
        sessionId: 'orch-9',
        reused: false,
      }));
      commands = new TaskCommands({
        scheduler: () => null,
        settings: store,
        notify,
        createProject: createProjectCreator({ env: USER_GIT }),
        orchestrator: () => ({
          start,
          taskEvent: () => false,
          notice: () => false,
          relay: () => false,
        }),
      });
      newApp = express();
      newApp.use(express.json());
      newApp.use((req, _res, next) => {
        (req as { authMethod?: string }).authMethod = authMethod;
        next();
      });
      newApp.use(
        '/api',
        createProjectRoutes({
          settings: store,
          scheduler: () => null,
          commands,
          home: tmp,
          newProjectParent: {
            get: () => lastParent,
            set: (dir) => {
              lastParent = dir;
            },
          },
        })
      );
    });

    it('makes the folder, git and a first commit, pins it, and remembers where', async () => {
      // «Dónde» starts at home the first time: only a starting point, nothing is made there.
      expect((await request(newApp).get('/api/projects/new')).body).toEqual({ parent: tmp });

      const made = await request(newApp)
        .post('/api/projects/new')
        .send({ name: 'Tele Ambiente', dir: parent });
      expect(made.status).toBe(200);
      const repoPath = path.join(parent, 'tele-ambiente');
      expect(made.body).toMatchObject({ repoPath, name: 'Tele Ambiente', branch: 'trunk' });
      expect(made.body.orchestrator).toBeUndefined();
      expect(git(repoPath, 'rev-parse', 'HEAD')).toBe(made.body.commit);
      expect(git(repoPath, 'log', '--format=%s')).toBe(NEW_PROJECT_COMMIT_MESSAGE);
      expect(git(repoPath, 'ls-files')).toBe('README.md');
      expect(fs.readFileSync(path.join(repoPath, 'README.md'), 'utf8')).toBe('# Tele Ambiente\n');
      expect(git(repoPath, 'status', '--porcelain')).toBe('');
      // Registered and pinned: the board shows it at once, with its «Orquestar».
      expect(store.getStored(repoPath).pinnedAt).toEqual(expect.any(String));
      expect(start).not.toHaveBeenCalled();
      // Next time «Dónde» starts where the user picked.
      expect(lastParent).toBe(parent);
      expect((await request(newApp).get('/api/projects/new')).body).toEqual({ parent });
    });

    it('refuses an existing folder, a name that is a path, no parent and a parent in a repo', async () => {
      fs.mkdirSync(path.join(parent, 'mi-app'));
      const exists = await request(newApp)
        .post('/api/projects/new')
        .send({ name: 'Mi App', dir: parent });
      expect(exists.status).toBe(409);
      expect(exists.body.error).toBe('exists');
      expect(fs.readdirSync(path.join(parent, 'mi-app'))).toEqual([]);

      for (const name of ['../x', 'a/b', '..', '.', '   ']) {
        const bad = await request(newApp).post('/api/projects/new').send({ name, dir: parent });
        expect(bad.status).toBe(400);
        expect(bad.body.error).toBe('bad-name');
      }
      expect(fs.existsSync(path.join(tmp, 'x'))).toBe(false);

      // Where to create it is never a default.
      const noDir = await request(newApp).post('/api/projects/new').send({ name: 'Otra' });
      expect(noDir.status).toBe(400);
      expect(noDir.body.error).toBe('bad-parent');
      const relative = await request(newApp)
        .post('/api/projects/new')
        .send({ name: 'Otra', dir: 'Projects' });
      expect(relative.body.error).toBe('bad-parent');
      const missing = await request(newApp)
        .post('/api/projects/new')
        .send({ name: 'Otra', dir: path.join(tmp, 'nope') });
      expect(missing.body.error).toBe('parent-missing');
      const nested = await request(newApp)
        .post('/api/projects/new')
        .send({ name: 'Otra', dir: path.join(repo, 'web') });
      expect(nested.status).toBe(409);
      expect(nested.body.error).toBe('inside-repo');
      expect(fs.existsSync(path.join(repo, 'web', 'otra'))).toBe(false);
      expect(lastParent).toBeUndefined();
    });

    it('with a goal, starts its orchestrator on it', async () => {
      const made = await request(newApp)
        .post('/api/projects/new')
        .send({ name: 'Atlas', dir: parent, goal: 'Un bot de recados\ncon tests' });
      expect(made.status).toBe(200);
      const repoPath = path.join(parent, 'atlas');
      expect(start).toHaveBeenCalledWith(repoPath, 'Un bot de recados\ncon tests');
      expect(made.body.orchestrator).toEqual({ ok: true, sessionId: 'orch-9' });
      expect(fs.readFileSync(path.join(repoPath, 'README.md'), 'utf8')).toBe(
        '# Atlas\n\nUn bot de recados\ncon tests\n'
      );
    });

    it('from an agent, waits for the user OK; approved, it is made and orchestrated', async () => {
      authMethod = 'local-bypass';
      const asked = await request(newApp)
        .post('/api/projects/new')
        .send({ name: 'Atlas', dir: parent, goal: 'Un bot' });
      expect(asked.status).toBe(202);
      const repoPath = path.join(parent, 'atlas');
      expect(asked.body.confirmation).toMatchObject({
        kind: 'project-new',
        where: 'atlas',
        repoPath,
        summary: 'Create the project Atlas',
      });
      expect(asked.body.confirmation.detail).toContain(`Folder: ${repoPath}`);
      expect(asked.body.confirmation.detail).toContain('Un bot');
      expect(notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'task-confirm' }));
      expect(fs.existsSync(repoPath)).toBe(false);
      expect(start).not.toHaveBeenCalled();
      // A folder that exists is refused before anyone is asked.
      fs.mkdirSync(path.join(parent, 'taken'));
      const taken = await request(newApp)
        .post('/api/projects/new')
        .send({ name: 'Taken', dir: parent });
      expect(taken.status).toBe(409);

      const answer = await commands.answerConfirmation(asked.body.confirmation.id, true, {
        kind: 'ui',
      });
      expect(answer).toMatchObject({
        status: 'approved',
        result: { ok: true, data: { repoPath, orchestrator: { ok: true, sessionId: 'orch-9' } } },
      });
      expect(git(repoPath, 'ls-files')).toBe('README.md');
      expect(start).toHaveBeenCalledWith(repoPath, 'Un bot');
      // An agent's project does not move where the user's «Dónde» starts.
      expect(lastParent).toBeUndefined();
    });

    it('with autoApprove on, an agent makes it at once and the user is told', async () => {
      const auto = new TaskCommands({
        scheduler: () => null,
        settings: store,
        notify,
        createProject: createProjectCreator({ env: USER_GIT }),
        autoApprove: { get: () => true, set: () => {} },
      });
      const result = await auto.run(
        'project-new',
        { name: 'Recados', dir: parent },
        { kind: 'cli', sessionId: 'cobot' }
      );
      expect(result).toMatchObject({
        ok: true,
        status: 'done',
        data: { repoPath: path.join(parent, 'recados'), autoApproved: expect.any(Object) },
      });
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'task-auto-approved',
          data: expect.objectContaining({ kind: 'project-new' }),
        })
      );
    });
  });
});
