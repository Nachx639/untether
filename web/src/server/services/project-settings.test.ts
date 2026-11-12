import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PROJECT_SETTINGS } from '../../shared/projects.js';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { KeyedMutex } from '../utils/repo-mutex.js';
import {
  normalizeRepoPath,
  ProjectSettingsError,
  type ProjectSettingsPatch,
  ProjectSettingsStore,
} from './project-settings.js';

describe('project settings', () => {
  let tmp: string;
  let file: string;
  let repo: string;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ut-projects-')));
    file = path.join(tmp, 'untether', 'projects.json');
    repo = path.join(tmp, 'app');
    fs.mkdirSync(repo);
  });

  afterEach(() => {
    fs.rmSync(tmp, RM_TEST_DIR);
  });

  it('gives the defaults for a project without settings', () => {
    const store = new ProjectSettingsStore(file);
    expect(store.get(repo)).toEqual(DEFAULT_PROJECT_SETTINGS);
    expect(store.get(repo)).toMatchObject({
      mergePolicy: 'auto',
      allowMergeWithoutCheck: false,
      verifyTimeoutSec: 900,
      // 2026-10-20: nothing merges without an AI review; a project may still turn it off.
      aiReview: true,
    });
    expect(store.getStored(repo)).toEqual({});
    expect(store.list()).toEqual([]);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('saves a change atomically, keyed by the normalized repo path, and clears with null', () => {
    const store = new ProjectSettingsStore(file);
    const saved = store.update(`${repo}/`, {
      mergePolicy: 'ask',
      checkCommand: '  pnpm run check  ',
      riskIgnore: ['docs/**'],
    });
    expect(saved).toMatchObject({ mergePolicy: 'ask', checkCommand: 'pnpm run check' });
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(onDisk).toEqual({
      version: 1,
      projects: {
        [repo]: { mergePolicy: 'ask', checkCommand: 'pnpm run check', riskIgnore: ['docs/**'] },
      },
    });
    expect(fs.readdirSync(path.dirname(file))).toEqual(['projects.json']);

    // Another store (a restart) reads it back; a symlinked path is the same project.
    const link = path.join(tmp, 'link');
    fs.symlinkSync(repo, link);
    expect(new ProjectSettingsStore(file).get(link).checkCommand).toBe('pnpm run check');

    expect(store.update(repo, { aiReview: false }).aiReview).toBe(false);
    store.update(repo, { aiReview: null });
    expect(store.get(repo).aiReview).toBe(true);
    // The circuit breaker's pause is a setting the user may clear.
    const until = new Date(Date.now() + 60_000).toISOString();
    expect(
      store.update(repo, { autoMergePausedUntil: until, autoMergePausedReason: 'two undone' })
    ).toMatchObject({ autoMergePausedUntil: until, autoMergePausedReason: 'two undone' });
    store.update(repo, { autoMergePausedUntil: null, autoMergePausedReason: null });
    expect(store.getStored(repo).autoMergePausedUntil).toBeUndefined();
    store.update(repo, { checkCommand: null, mergePolicy: null });
    expect(store.getStored(repo)).toEqual({ riskIgnore: ['docs/**'] });
    store.update(repo, { riskIgnore: null });
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).projects).toEqual({});
  });

  it('writes projects.json readable by the user only (0600, 2026-10-20)', () => {
    const store = new ProjectSettingsStore(file);
    store.update('/repo', { mergePolicy: 'ask', autoMergePausedCode: 'failures' });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(store.get('/repo').autoMergePausedCode).toBe('failures');
  });

  it('refuses bad values as a whole', () => {
    const store = new ProjectSettingsStore(file);
    store.update(repo, { mergePolicy: 'ask' });
    for (const bad of [
      { mergePolicy: 'sometimes' },
      { baseBranch: '--force' },
      { worktreeRoot: 'relative/dir' },
      { cloneDirs: ['../outside'] },
      { cloneDirs: ['/abs'] },
      { verifyTimeoutSec: 1 },
      { checkCommand: '' },
      { defaultAgent: 'gemini' },
      { aiReview: 'yes' },
      { unknownKey: true },
      { savingHoldoutPct: 101 },
      { savingAutoOff: [{ feature: 'loop-nudge', version: 0, at: 'x', reason: '' }] },
    ]) {
      expect(() => store.update(repo, bad as never)).toThrow(ProjectSettingsError);
    }
    expect(store.getStored(repo)).toEqual({ mergePolicy: 'ask' });
    // Saving features (2026-11-03): known ids, a share, what the guard turned off.
    const autoOff = [
      { feature: 'loop-nudge', version: 1, at: '2026-11-03T00:00:00.000Z', reason: 'worse' },
    ];
    store.update(repo, {
      savingHoldoutPct: 20,
      savingAutoOff: autoOff,
    });
    expect(store.get(repo)).toMatchObject({ savingHoldoutPct: 20, savingAutoOff: autoOff });
  });

  it('keeps provider connectors by where their credential is, never a value (2026-10-26)', () => {
    const store = new ProjectSettingsStore(file);
    const connector = {
      provider: 'tailscale' as const,
      credential: { from: 'keychain' as const, name: 'some-service', account: 'someone' },
      options: { tag: 'tag:web', sharedPorts: '443' },
    };
    expect(store.update(repo, { securityConnectors: [connector] }).securityConnectors).toEqual([
      connector,
    ]);
    for (const bad of [
      [{ ...connector, provider: 'unknown' }],
      [{ ...connector, credential: { from: 'env', name: 'NOT A VARIABLE' } }],
      [{ ...connector, credential: { from: 'keychain', name: '-w' } }],
      [{ ...connector, credential: { from: 'file', name: '/etc/passwd' } }],
      [{ ...connector, credential: { ...connector.credential, value: 'x' } }],
      [{ ...connector, options: { 'bad key': 'x' } }],
    ]) {
      expect(() => store.update(repo, { securityConnectors: bad } as never)).toThrow(
        ProjectSettingsError
      );
    }
  });

  it('picks up hand edits and keeps what does not validate as it is (2026-10-20)', () => {
    const onError = vi.fn();
    const store = new ProjectSettingsStore(file, onError);
    store.update(repo, { allowMergeWithoutCheck: true });
    const other = path.join(tmp, 'other');
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        projects: {
          [repo]: { verifyTimeoutSec: 60, futureKey: { a: 1 } },
          [other]: { mergePolicy: 'never', aiReview: true },
          'relative/path': { mergePolicy: 'ask' },
        },
      })
    );
    // A different mtime: the store reads the file again.
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(file, later, later);
    expect(store.get(repo)).toMatchObject({ verifyTimeoutSec: 60, allowMergeWithoutCheck: false });
    // The valid fields of a record with a bad one still apply.
    expect(store.get(other)).toMatchObject({ mergePolicy: 'auto', aiReview: true });
    expect(store.list().map((entry) => entry.repoPath)).toEqual([repo, other]);
    expect(onError).toHaveBeenCalledTimes(3);
    // A copy of the file as it was.
    expect(
      fs.readdirSync(path.dirname(file)).some((name) => name.startsWith('projects.json.bad-'))
    ).toBe(true);

    // The next write keeps everything it did not understand.
    store.update(repo, { aiReview: true });
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8')).projects;
    expect(onDisk[repo]).toEqual({ verifyTimeoutSec: 60, futureKey: { a: 1 }, aiReview: true });
    expect(onDisk[other]).toEqual({ mergePolicy: 'never', aiReview: true });
    expect(onDisk['relative/path']).toEqual({ mergePolicy: 'ask' });
    // Setting the bad field again replaces it.
    store.update(other, { mergePolicy: 'ask' });
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).projects[other]).toEqual({
      mergePolicy: 'ask',
      aiReview: true,
    });
  });

  it('never overwrites a file it cannot read (2026-10-20)', () => {
    const onError = vi.fn();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"version": 1, "projects": {');
    const store = new ProjectSettingsStore(file, onError);
    expect(store.list()).toEqual([]);
    expect(() => store.update(repo, { aiReview: true })).toThrow(ProjectSettingsError);
    expect(fs.readFileSync(file, 'utf8')).toBe('{"version": 1, "projects": {');
    fs.writeFileSync(file, JSON.stringify({ version: 99, projects: { [repo]: {} } }));
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(file, later, later);
    expect(store.list()).toEqual([]);
    expect(() => store.update(repo, { aiReview: true })).toThrow(ProjectSettingsError);
    // Fixed by hand: writable again.
    fs.writeFileSync(file, JSON.stringify({ version: 1, projects: {} }));
    const evenLater = new Date(Date.now() + 10_000);
    fs.utimesSync(file, evenLater, evenLater);
    expect(store.update(repo, { aiReview: true }).aiReview).toBe(true);
  });

  it("never takes the server's identity fields in a change", () => {
    const store = new ProjectSettingsStore(file);
    expect(() =>
      store.update(repo, { gitRoot: 'a'.repeat(40) } as unknown as ProjectSettingsPatch)
    ).toThrow(ProjectSettingsError);
  });

  it('normalizes repo paths', () => {
    expect(normalizeRepoPath(`${repo}///`)).toBe(repo);
    expect(normalizeRepoPath(path.join(repo, '..', 'app'))).toBe(repo);
    expect(normalizeRepoPath('/no/such/dir/')).toBe('/no/such/dir');
  });
});

describe('KeyedMutex', () => {
  it('runs jobs of one key one at a time in order, other keys in parallel, past failures', async () => {
    const mutex = new KeyedMutex();
    const events: string[] = [];
    const job =
      (name: string, ms: number, fail = false) =>
      async () => {
        events.push(`start ${name}`);
        await new Promise((resolve) => setTimeout(resolve, ms));
        events.push(`end ${name}`);
        if (fail) throw new Error(name);
        return name;
      };
    const a1 = mutex.run('a', job('a1', 20, true));
    const a2 = mutex.run('a', job('a2', 1));
    const b1 = mutex.run('b', job('b1', 1));
    expect(mutex.isBusy('a')).toBe(true);
    await expect(a1).rejects.toThrow('a1');
    expect(await a2).toBe('a2');
    expect(await b1).toBe('b1');
    expect(events.indexOf('end a1')).toBeLessThan(events.indexOf('start a2'));
    expect(events.indexOf('start b1')).toBeLessThan(events.indexOf('end a1'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mutex.isBusy('a')).toBe(false);
  });
});

describe('projects follow their folder (2026-10-20: skylark renamed to inkwell)', () => {
  let tmp: string;
  let file: string;

  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      stdio: 'pipe',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
      },
    })
      .toString()
      .trim();
  const makeRepo = (dir: string, content = 'x') => {
    fs.mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(dir, 'a.txt'), content);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'first');
    return git(dir, 'rev-list', '--max-parents=0', 'HEAD');
  };
  /** A new store (a restart), so nothing is cached between the steps. */
  const reload = () => new ProjectSettingsStore(file, () => {});

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ut-moves-')));
    file = path.join(tmp, 'untether', 'projects.json');
  });

  afterEach(() => {
    fs.rmSync(tmp, RM_TEST_DIR);
  });

  it('backfills the identity, then moves the record to the renamed folder with all its fields', async () => {
    const skylark = path.join(tmp, 'Projects', 'skylark');
    const root = makeRepo(skylark);
    makeRepo(path.join(tmp, 'Projects', 'other'), 'other');
    const store = reload();
    store.update(skylark, {
      pinnedAt: '2026-10-18T17:28:12.025Z',
      orchestratorSessionId: 's-1',
      orchestratorAdopted: true,
    });
    expect(await store.followMoves()).toEqual({ moved: [], missing: [] });
    expect(store.getStored(skylark)).toMatchObject({ gitRoot: root, folderName: 'skylark' });

    const inkwell = path.join(tmp, 'Projects', 'inkwell');
    fs.renameSync(skylark, inkwell);
    const after = reload();
    const heard: unknown[] = [];
    after.followedBy('test', (moved) => {
      heard.push(moved);
      return moved.length;
    });
    // Nothing known yet: a follower hears nothing when it registers.
    expect(heard).toEqual([]);
    expect(await after.followMoves()).toEqual({
      moved: [{ from: skylark, to: inkwell }],
      missing: [],
    });
    // Followers (the task scheduler, the orchestrators…) hear of the move once.
    expect(heard).toEqual([[{ from: skylark, to: inkwell }]]);
    await after.followMoves();
    expect(heard).toHaveLength(1);
    expect(after.list().map((entry) => entry.repoPath)).toEqual([inkwell]);
    expect(after.getStored(inkwell)).toMatchObject({
      pinnedAt: '2026-10-18T17:28:12.025Z',
      orchestratorSessionId: 's-1',
      orchestratorAdopted: true,
      gitRoot: root,
      folderName: 'inkwell',
      movedFrom: skylark,
      formerPaths: [skylark],
    });
    expect(reload().getStored(inkwell).movedFrom).toBe(skylark);
  });

  it('tells a follower that registers late the moves already known, and finds old paths', async () => {
    // 2026-10-25: toolshed renamed to bakery; orchestrators.json stayed on toolshed.
    const toolshed = path.join(tmp, 'Projects', 'toolshed');
    const root = makeRepo(toolshed);
    const store = reload();
    store.update(toolshed, { orchestratorSessionId: 's-1' });
    await store.followMoves();
    const bakery = path.join(tmp, 'Projects', 'bakery');
    fs.renameSync(toolshed, bakery);
    const after = reload();
    await after.followMoves();
    const den = path.join(tmp, 'Projects', 'den');
    fs.renameSync(bakery, den);
    const last = reload();
    await last.followMoves();
    expect(last.getStored(den)).toMatchObject({ gitRoot: root, formerPaths: [toolshed, bakery] });

    // Every old folder maps straight to the current one, inside folders too.
    expect(last.knownMoves()).toEqual([
      { from: toolshed, to: den },
      { from: bakery, to: den },
    ]);
    expect(last.currentPath(toolshed)).toBe(den);
    expect(last.currentPath(path.join(bakery, 'web'))).toBe(path.join(den, 'web'));
    expect(last.currentPath(den)).toBeNull();

    const stale = new Map([[toolshed, 'kept']]);
    const follow = (moved: ReadonlyArray<{ from: string; to: string }>) => {
      let changed = 0;
      for (const { from, to } of moved) {
        const value = stale.get(from);
        if (value === undefined) continue;
        stale.delete(from);
        stale.set(to, value);
        changed++;
      }
      return changed;
    };
    last.followedBy('late store', follow);
    expect([...stale]).toEqual([[den, 'kept']]);
    // The doctor's replay: nothing left to heal now; a store put back on the old folder is.
    expect(await last.replayMoves()).toEqual([]);
    stale.set(bakery, 'again');
    stale.delete(den);
    expect(await last.replayMoves()).toEqual([{ name: 'late store', changed: 1 }]);
    expect([...stale]).toEqual([[den, 'again']]);

    // A new repository at an old folder is no longer a move.
    makeRepo(toolshed);
    expect(last.currentPath(toolshed)).toBeNull();
  });

  it("finds a folder moved elsewhere through a live session's folder", async () => {
    const old = path.join(tmp, 'Projects', 'app');
    makeRepo(old);
    const store = reload();
    store.update(old, { mergePolicy: 'ask' });
    await store.followMoves();
    const moved = path.join(tmp, 'Elsewhere', 'app2');
    fs.mkdirSync(path.dirname(moved), { recursive: true });
    fs.renameSync(old, moved);
    fs.mkdirSync(path.join(moved, 'src'));
    const after = reload();
    after.setLiveDirs(() => [path.join(moved, 'src'), '/no/such/dir']);
    expect((await after.followMoves()).moved).toEqual([{ from: old, to: moved }]);
    expect(after.get(moved).mergePolicy).toBe('ask');
  });

  it('marks a record missing when no folder (or more than one) holds its repository', async () => {
    const old = path.join(tmp, 'Projects', 'app');
    makeRepo(old);
    const store = reload();
    store.update(old, { mergePolicy: 'ask' });
    await store.followMoves();
    // Two clones of it next to where it was: which one is it? Neither is taken.
    execFileSync('git', ['clone', '-q', old, path.join(tmp, 'Projects', 'copy-a')]);
    execFileSync('git', ['clone', '-q', old, path.join(tmp, 'Projects', 'copy-b')]);
    fs.rmSync(old, RM_TEST_DIR);
    const after = reload();
    expect(await after.followMoves()).toEqual({ moved: [], missing: [old] });
    expect(after.getStored(old)).toMatchObject({ mergePolicy: 'ask' });
    expect(after.getStored(old).missingSince).toBeDefined();
    // It comes back: no longer missing.
    const newRoot = makeRepo(old, 'another');
    const back = reload();
    await back.followMoves();
    expect(back.getStored(old).missingSince).toBeUndefined();
    expect(back.getStored(old).gitRoot).toBe(newRoot);
  });
});
