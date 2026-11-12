/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';
import { createTestSession, createTestTask as task } from '@/test/utils/test-factories';
import type { Session } from '../../shared/types.js';
import {
  buildProjectBoard,
  DONE_LIMIT,
  folderGroupKey,
  GROUP_LEAD_MS,
  groupMenuOf,
  groupSessionsAndTasksByRepo,
  groupSessionsByRepo,
  moveGroupInOrder,
  moveSessionInOrder,
  placeInGroup,
  repoFamilies,
  SESSION_ORDER_MAX,
  stickyGroupOrder,
  taskRepoKey,
  withManualOrder,
  withManualSessionOrder,
} from './project-groups.js';

const session = (id: string, repo: string | null, overrides: Partial<Session> = {}): Session => ({
  ...createTestSession({ id, workingDir: repo ?? '/tmp' }),
  ...(repo ? { gitRepoPath: repo } : {}),
  ...overrides,
});

describe('project groups', () => {
  it('test sessions tie on activity, however far apart they are made', async () => {
    const first = createTestSession();
    await new Promise((resolve) => setTimeout(resolve, 3));
    const second = createTestSession();
    expect(second.lastModified).toBe(first.lastModified);
    expect(second.startedAt).toBe(first.startedAt);
  });

  it('folds nested repos and known worktrees into their main repo', () => {
    const family = repoFamilies(
      ['/r/app', '/r/app/packages/web', '/wt/app-feature', '/r/other'],
      new Map([['/r/app', [{ path: '/r/app' }, { path: '/private/wt/app-feature' }]]])
    );
    expect(family('/r/app/packages/web')).toBe('/r/app');
    expect(family('/wt/app-feature')).toBe('/r/app');
    expect(family('/r/other')).toBe('/r/other');
  });

  it('groups sessions by repo family, no repo under null', () => {
    const groups = groupSessionsByRepo([
      session('a', '/r/app'),
      session('b', null),
      session('c', '/r/app/sub'),
      session('d', '/r/two'),
    ]);
    expect([...groups.keys()]).toEqual(['/r/app', null, '/r/two']);
    expect(groups.get('/r/app')?.map((s) => s.id)).toEqual(['a', 'c']);
  });

  it('keys a task by its main checkout, else its folder', () => {
    expect(taskRepoKey({ repoPath: '/private/var/r/app/', workingDir: '/x' })).toBe('/var/r/app');
    expect(taskRepoKey({ workingDir: '/r/app' })).toBe('/r/app');
    expect(taskRepoKey({ workingDir: '~' })).toBeNull();
  });

  it('puts tasks with their project and shows a task session only in its row', () => {
    const taskSession = session('ts', '/repos/.untether-worktrees/app/login', {
      gitMainRepoPath: '/repos/app',
      gitIsWorktree: true,
    } as Partial<Session>);
    const board = buildProjectBoard({
      sessions: [session('loose', '/repos/app'), taskSession, session('tmp', null)],
      tasks: [task({ id: 't1', sessionId: 'ts' })],
    });
    expect(board.groups.map((g) => g.key)).toEqual(['/repos/app', null]);
    const [app, others] = board.groups;
    expect(app.tasks.map((t) => t.id)).toEqual(['t1']);
    expect(app.sessions.map((s) => s.id)).toEqual(['loose']);
    expect(others.sessions.map((s) => s.id)).toEqual(['tmp']);
    expect(board.taskSessionIds.has('ts')).toBe(true);
  });

  it('a project with only tasks is a group too; plain tasks are not on the board', () => {
    const board = buildProjectBoard({
      sessions: [],
      tasks: [task({ id: 't1' }), task({ id: 'plain', isolation: 'none', workingDir: '/r/x' })],
    });
    expect(board.groups).toHaveLength(1);
    expect(board.groups[0].tasks.map((t) => t.id)).toEqual(['t1']);
  });

  it('moves a project with something waiting for you up; "Otras" stays last', () => {
    const quiet = session('q', '/r/quiet', { lastModified: new Date().toISOString() });
    const first = buildProjectBoard({
      sessions: [quiet, session('o', null)],
      tasks: [task({ id: 't', repoPath: '/r/busy', workingDir: '/r/busy' })],
    });
    expect(first.groups.map((g) => g.key)).toEqual([...first.order, null]);
    const waiting = buildProjectBoard({
      sessions: [quiet, session('o', null)],
      tasks: [task({ id: 't', repoPath: '/r/busy', workingDir: '/r/busy', state: 'needs_you' })],
      previousOrder: ['/r/quiet', '/r/busy'],
    });
    expect(waiting.groups.map((g) => g.key)).toEqual(['/r/busy', '/r/quiet', null]);
    expect(waiting.groups[0].needsYou).toBe(true);
  });

  it('keeps "Hechas" to the newest merged and discarded tasks', () => {
    const tasks = Array.from({ length: DONE_LIMIT + 5 }, (_, i) =>
      task({
        id: `d${i}`,
        state: i % 2 ? 'merged' : 'discarded',
        finishedAt: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(),
      })
    );
    const board = buildProjectBoard({ sessions: [], tasks });
    expect(board.done).toHaveLength(DONE_LIMIT);
    expect(board.done[0].id).toBe(`d${DONE_LIMIT + 4}`);
    expect(board.groups).toHaveLength(0);
  });

  it('only lets a group climb on a clear lead (no reshuffle every poll)', () => {
    const name = (key: string) => key;
    const activity = new Map([
      ['a', 1_000_000],
      ['b', 1_000_000 + GROUP_LEAD_MS - 1],
    ]);
    const needsYou = new Map<string, boolean>();
    expect(
      stickyGroupOrder(['a', 'b'], { activity, needsYou, previous: ['a', 'b'], name })
    ).toEqual(['a', 'b']);
    activity.set('b', 1_000_000 + GROUP_LEAD_MS + 1);
    expect(
      stickyGroupOrder(['a', 'b'], { activity, needsYou, previous: ['a', 'b'], name })
    ).toEqual(['b', 'a']);
  });

  it('gives a project folder without git a group of its own (2026-10-18: tele-ambiente)', () => {
    const home = '/Users/n';
    const tele = session('tele', null, { workingDir: `${home}/Projects/tele-ambiente` });
    const teleWeb = session('tele-web', null, {
      workingDir: `${home}/Projects/tele-ambiente/webos`,
    });
    const projects = session('projects', null, { workingDir: `${home}/Projects` });
    const atHome = session('home', null, { workingDir: home });
    const atlas = session('atlas', `${home}/Projects/atlas`);
    const board = buildProjectBoard({
      sessions: [tele, teleWeb, projects, atHome, atlas],
      tasks: [],
    });
    const byKey = new Map(board.groups.map((group) => [group.key, group]));
    expect(byKey.get(`${home}/Projects/tele-ambiente`)).toMatchObject({
      folder: true,
      sessions: [tele, teleWeb],
    });
    expect(byKey.get(`${home}/Projects/atlas`)?.folder).toBeUndefined();
    expect(byKey.get(null)?.sessions).toEqual([projects, atHome]);

    expect(folderGroupKey({ workingDir: '/tmp/x/y' })).toBeNull();
    expect(folderGroupKey({ workingDir: `${home}/Projects` })).toBeNull();
    // A folder holding a repo is a folder of projects, never a group swallowing it.
    const holder = session('holder', null, { workingDir: `${home}/Work/clients` });
    const inside = session('inside', `${home}/Work/clients/acme`);
    const nested = buildProjectBoard({ sessions: [holder, inside], tasks: [] });
    expect(nested.groups.map((group) => group.key)).toEqual([`${home}/Work/clients/acme`, null]);
  });

  it('groups a session where its agent works now (2026-10-18: opened in ~/Projects)', () => {
    const home = '/Users/n';
    const inRepo = session('inRepo', null, {
      workingDir: `${home}/Projects`,
      workDir: `${home}/Projects/untether/web`,
      workRepoPath: `${home}/Projects/untether`,
    });
    const inFolder = session('inFolder', null, {
      workingDir: `${home}/Projects`,
      workDir: `${home}/Projects/tele-ambiente`,
    });
    // Its agent went to /tmp for a moment: it stays with the repo it started in.
    const visiting = session('visiting', `${home}/Projects/atlas`, { workDir: '/tmp/x' });
    const board = buildProjectBoard({ sessions: [inRepo, inFolder, visiting], tasks: [] });
    const byKey = new Map(board.groups.map((group) => [group.key, group]));
    expect(byKey.get(`${home}/Projects/untether`)?.sessions).toEqual([inRepo]);
    expect(byKey.get(`${home}/Projects/tele-ambiente`)).toMatchObject({
      folder: true,
      sessions: [inFolder],
    });
    expect(byKey.get(`${home}/Projects/atlas`)?.sessions).toEqual([visiting]);
    expect(byKey.has(null)).toBe(false);
  });

  it('keeps a session in its own project when its agent visits another (2026-10-25)', () => {
    // Real data: juego-de-cartas's orchestrator ran `cd ~/Projects/tele-ambiente` to read
    // webos/appinfo.json and showed under tele-ambiente, without its badge or its own group.
    const home = '/Users/n';
    const tele = `${home}/Projects/tele-ambiente`;
    const juego = `${home}/Projects/juego-de-cartas`;
    const teleOrch = session('6b2b8c6c', tele, { gitMainRepoPath: tele });
    const juegoOrch = session('0c8888e8', juego, {
      gitMainRepoPath: juego,
      workDir: tele,
      workRepoPath: tele,
    });
    // A session in a git repo whose agent reads a project folder outside git stays too.
    const reading = session('reading', juego, { workDir: `${home}/Projects/notas` });
    const orchestrators = [
      { repoPath: tele, sessionId: '6b2b8c6c' },
      { repoPath: juego, sessionId: '0c8888e8' },
    ];

    // Split-view sidebar.
    const sidebar = groupSessionsByRepo([teleOrch, juegoOrch, reading]);
    expect(sidebar.get(tele)?.map((s) => s.id)).toEqual(['6b2b8c6c']);
    expect(sidebar.get(juego)?.map((s) => s.id)).toEqual(['0c8888e8', 'reading']);

    // Phone board, juego-de-cartas pinned, orchestrator alone in its group.
    const board = buildProjectBoard({
      sessions: [teleOrch, juegoOrch],
      tasks: [],
      orchestrators,
      pinned: [{ repoPath: juego, git: true }],
    });
    expect(board.groups.map((group) => [group.key, group.sessions.map((s) => s.id)])).toEqual([
      [juego, ['0c8888e8']],
      [tele, ['6b2b8c6c']],
    ]);
    expect(board.groups[0].pinned).toBe(true);
  });

  it('a session the user anchored stays in that group, over the automatic one (2026-11-04)', () => {
    const home = '/Users/n';
    const bakery = `${home}/Projects/bakery`;
    const finanzas = `${home}/Projects/finanzas`;
    const untether = `${home}/Projects/untether`;
    // Opened in ~, its agent works in bakery: automatic grouping puts it there.
    const insights = session('insights', null, {
      workingDir: home,
      workDir: bakery,
      workRepoPath: bakery,
    });
    const other = session('other', bakery);
    const own = session('own', untether);
    const anchored = (s: Session, groupPin: Session['groupPin']) => ({ ...s, groupPin });
    const keys = (board: ReturnType<typeof buildProjectBoard>) =>
      board.groups.map((group) => [group.key, group.sessions.map((s) => s.id), !!group.folder]);

    expect(keys(buildProjectBoard({ sessions: [insights, other], tasks: [] }))).toEqual([
      [bakery, ['insights', 'other'], false],
    ]);
    // "Mover a… Otras".
    const toOthers = anchored(insights, { repoPath: null });
    expect(keys(buildProjectBoard({ sessions: [toOthers, other], tasks: [] }))).toEqual([
      [bakery, ['other'], false],
      [null, ['insights'], false],
    ]);
    expect(
      groupSessionsByRepo([toOthers, other])
        .get(null)
        ?.map((s) => s.id)
    ).toEqual(['insights']);
    // "Mover a… finanzas" (a folder outside git, no other session there).
    const toFolder = anchored(insights, { repoPath: finanzas });
    expect(keys(buildProjectBoard({ sessions: [toFolder, other], tasks: [] }))).toEqual([
      [bakery, ['other'], false],
      [finanzas, ['insights'], true],
    ]);
    // A session in its own repo, and an orchestrator, move too: the anchor wins.
    const ownMoved = anchored(own, { repoPath: bakery, git: true });
    const board = buildProjectBoard({
      sessions: [ownMoved, other],
      tasks: [],
      orchestrators: [{ repoPath: untether, sessionId: 'own' }],
    });
    expect(keys(board)).toEqual([[bakery, ['own', 'other'], false]]);
    expect(
      groupSessionsByRepo([ownMoved, other], new Map(), [{ repoPath: untether, sessionId: 'own' }])
        .get(bakery)
        ?.map((s) => s.id)
    ).toEqual(['own', 'other']);

    // The menu: every group, "Otras" always offered last, and where each session is.
    const menu = groupMenuOf(
      buildProjectBoard({ sessions: [toFolder, other, own], tasks: [] }),
      (key) => key.split('/').pop() ?? key
    );
    expect(menu.choices.map((choice) => [choice.key, choice.name, choice.folder])).toEqual([
      [bakery, 'bakery', false],
      [finanzas, 'finanzas', true],
      [untether, 'untether', false],
      [null, '', false],
    ]);
    expect(menu.groupOf.get('insights')).toBe(finanzas);
    expect(menu.groupOf.get('own')).toBe(untether);
  });

  it('puts an orchestrator in its project in the sidebar wherever it was opened', () => {
    const orch = session('orch', null, { workingDir: '/Users/n' });
    const groups = groupSessionsByRepo([orch], new Map(), [
      { repoPath: '/private/Users/n/Projects/app/', sessionId: 'orch' },
    ]);
    expect([...groups.keys()]).toEqual(['/Users/n/Projects/app']);
  });

  it('keeps a paused orchestrator in its project (2026-10-31)', () => {
    const paused = session('paused', null, {
      workingDir: '/Users/n/Projects',
      status: 'exited',
      suspended: {
        at: '2026-10-31T11:45:00Z',
        claudeSessionId: 'c1',
        command: ['claude'],
        workingDir: '/Users/n/Projects',
        shielded: true,
        idleMinutes: 120,
        orchestratorOf: '/private/Users/n/Projects/app/',
      },
    });
    expect([...groupSessionsByRepo([paused]).keys()]).toEqual(['/Users/n/Projects/app']);
    const board = buildProjectBoard({ sessions: [paused], tasks: [] });
    expect(board.groups.map((group) => group.key)).toEqual(['/Users/n/Projects/app']);
  });

  it('groups a folder session by its project root, not the folder of its last file (2026-10-20)', () => {
    const home = '/Users/n';
    // Started in the project, writing src/a.js: the project, not "src".
    const writing = session('writing', null, {
      workingDir: `${home}/Projects/tele-ambiente`,
      workDir: `${home}/Projects/tele-ambiente/src`,
    });
    // Started in ~, writing deep inside a project: the folder two levels under home.
    const fromHome = session('fromHome', null, {
      workingDir: home,
      workDir: `${home}/Projects/skylark/app/lib`,
    });
    expect(folderGroupKey(writing)).toBe(`${home}/Projects/tele-ambiente`);
    expect(folderGroupKey(fromHome)).toBe(`${home}/Projects/skylark`);
    // Started in a subfolder of the project: that folder holds what it writes.
    expect(
      folderGroupKey({ workingDir: `${home}/Projects/x/web`, workDir: `${home}/Projects/x/web/a` })
    ).toBe(`${home}/Projects/x/web`);
    const board = buildProjectBoard({ sessions: [writing, fromHome], tasks: [] });
    expect(board.groups.map((group) => group.key).sort()).toEqual([
      `${home}/Projects/skylark`,
      `${home}/Projects/tele-ambiente`,
    ]);
  });

  it('a session in a subfolder of a pinned project joins it (2026-10-20)', () => {
    const home = '/Users/n';
    const inside = session('inside', null, { workingDir: `${home}/Projects/notes/drafts` });
    const board = buildProjectBoard({
      sessions: [inside],
      tasks: [],
      pinned: [{ repoPath: `${home}/Projects/notes`, git: false }],
    });
    expect(board.groups.map((group) => [group.key, group.sessions])).toEqual([
      [`${home}/Projects/notes`, [inside]],
    ]);
  });

  it("puts an orchestrator's session in its project wherever it was opened", () => {
    const home = '/Users/n';
    const orch = session('orch', null, { workingDir: home });
    const board = buildProjectBoard({
      sessions: [orch],
      tasks: [],
      orchestrators: [{ repoPath: `${home}/Projects/untether/`, sessionId: 'orch' }],
    });
    expect(board.groups.map((group) => [group.key, group.sessions])).toEqual([
      [`${home}/Projects/untether`, [orch]],
    ]);
  });

  it('puts pinned projects first in pin order, shown even when empty (2026-10-18)', () => {
    const a = session('a', '/r/a');
    const b = session('b', '/r/b');
    const board = buildProjectBoard({
      sessions: [a, b, session('c', null)],
      tasks: [],
      pinned: [
        { repoPath: '/r/empty', git: true },
        { repoPath: '/r/b/', git: true },
        { repoPath: '/Users/n/Projects/notes', git: false },
      ],
    });
    expect(board.groups.map((group) => [group.key, group.sessions.length, !!group.pinned])).toEqual(
      [
        ['/r/empty', 0, true],
        ['/r/b', 1, true],
        ['/Users/n/Projects/notes', 0, true],
        ['/r/a', 1, false],
        [null, 1, false],
      ]
    );
    expect(board.groups[2].folder).toBe(true);
    expect(board.groups[0].folder).toBeUndefined();
    expect(board.order).not.toContain('/r/b');
  });

  // 2026-11-07: the order the user drags (TaskStore groupOrder) wins over the automatic one.
  describe('the group order the user chose', () => {
    it('saved groups in its order, after the ones it does not hold yet', () => {
      expect(withManualOrder(['/a', '/b', '/c'], [])).toEqual(['/a', '/b', '/c']);
      expect(withManualOrder(['/a', '/b', '/c', '/new'], ['/c', '/gone', '/a', '/b'])).toEqual([
        '/new',
        '/c',
        '/a',
        '/b',
      ]);
    });

    it('a move keeps the groups not shown where they were among the others', () => {
      // Shown as withManualOrder shows them: /d (new) first, then /c, /a.
      const manual = ['/c', '/hidden', '/a'];
      expect(moveGroupInOrder(manual, ['/d', '/c', '/a'], '/a', '/d', 'before')).toEqual([
        '/a',
        '/d',
        '/hidden',
        '/c',
      ]);
      expect(moveGroupInOrder([], ['/a', '/b', '/c'], '/a', '/c', 'after')).toEqual([
        '/b',
        '/c',
        '/a',
      ]);
      // On "Otras" (null): last.
      expect(moveGroupInOrder([], ['/a', '/b', '/c'], '/a', null, 'before')).toEqual([
        '/b',
        '/c',
        '/a',
      ]);
      // A group not shown is not moved.
      expect(moveGroupInOrder(['/x'], ['/a'], '/zz', '/a', 'before')).toEqual(['/x']);
    });

    it('the board follows it among the pinned and among the rest; "Otras" stays last', () => {
      const board = buildProjectBoard({
        sessions: [
          session('a', '/r/a'),
          session('b', '/r/b'),
          session('c', '/r/c'),
          session('o', null),
        ],
        tasks: [],
        pinned: [
          { repoPath: '/r/p1', git: true },
          { repoPath: '/r/p2', git: true },
        ],
        manualOrder: ['/r/c', '/r/p2', '/r/a', '/r/p1', '/r/b'],
      });
      expect(board.groups.map((group) => group.key)).toEqual([
        '/r/p2',
        '/r/p1',
        '/r/c',
        '/r/a',
        '/r/b',
        null,
      ]);
    });
  });

  // 2026-11-07, user request: rows dragged up and down inside their group.
  describe('the session order the user chose', () => {
    const ids = (list: Array<{ id: string }>) => list.map((entry) => entry.id);

    // Review 2026-11-07: a new session goes where it would by activity, not after the ordered.
    it('ordered sessions keep their order among themselves; the others (a new one) keep their place', () => {
      const shown = ['n', 'a', 'b', 'c'].map((id) => ({ id }));
      expect(ids(withManualSessionOrder(shown, ['c', 'x', 'a']))).toEqual(['n', 'c', 'b', 'a']);
      // The whole group ordered by a drop, then a new, most active session: on top.
      expect(ids(withManualSessionOrder(shown, ['c', 'b', 'a']))).toEqual(['n', 'c', 'b', 'a']);
      expect(ids(withManualSessionOrder([...shown, { id: 'old' }], ['c', 'b', 'a', 'n']))).toEqual([
        'c',
        'b',
        'a',
        'n',
        'old',
      ]);
      expect(ids(withManualSessionOrder(shown, []))).toEqual(['n', 'a', 'b', 'c']);
    });

    it('a drop saves the whole group in its new order, wherever the session came from', () => {
      expect(placeInGroup(['a', 'b', 'c'], 'c', 'a', 'before')).toEqual(['c', 'a', 'b']);
      expect(placeInGroup(['a', 'b'], 'z', 'a', 'after')).toEqual(['a', 'z', 'b']);
      expect(placeInGroup(['a', 'b'], 'z', null, 'after')).toEqual(['a', 'b', 'z']);
      // Other groups' ids stay; gone sessions go.
      expect(
        moveSessionInOrder(
          ['q', 'b', 'gone', 'a'],
          ['a', 'b', 'c'],
          'c',
          'a',
          'before',
          new Set(['q', 'a', 'b', 'c'])
        )
      ).toEqual(['q', 'c', 'a', 'b']);
      const many = Array.from({ length: SESSION_ORDER_MAX }, (_, index) => `s${index}`);
      const capped = moveSessionInOrder(many, ['x', 'y'], 'y', 'x', 'before');
      expect(capped).toHaveLength(SESSION_ORDER_MAX);
      expect(capped.slice(-2)).toEqual(['y', 'x']);
      expect(capped[0]).toBe('s2');
    });

    it('the board (the phone and the home) puts each group in that order', () => {
      const board = buildProjectBoard({
        sessions: [session('a1', '/r/a'), session('a2', '/r/a'), session('a3', '/r/a')],
        tasks: [],
        manualSessionOrder: ['a3', 'a1'],
      });
      expect(ids(board.groups[0].sessions)).toEqual(['a3', 'a2', 'a1']);
    });
  });
});

describe('groupSessionsAndTasksByRepo (split-view sidebar)', () => {
  const taskIn = (id: string, repoPath: string) => task({ id, repoPath, workingDir: repoPath });

  it('puts a task in its project, and gives a project with only tasks its group', () => {
    const { sessions, tasks } = groupSessionsAndTasksByRepo(
      [session('s', '/repos/app')],
      [taskIn('t', '/repos/app'), taskIn('alone', '/repos/other')]
    );
    expect([...sessions.keys()]).toEqual(['/repos/app']);
    expect(tasks.get('/repos/app')?.map((task) => task.id)).toEqual(['t']);
    expect(tasks.get('/repos/other')?.map((task) => task.id)).toEqual(['alone']);
  });

  it('a task on the outer repo folds a nested repo’s sessions into the same family', () => {
    const { sessions, tasks } = groupSessionsAndTasksByRepo(
      [session('s', '/repos/app/packages/ui')],
      [taskIn('t', '/repos/app')]
    );
    expect([...sessions.keys()]).toEqual(['/repos/app']);
    expect([...tasks.keys()]).toEqual(['/repos/app']);
  });
});
