import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  githubRepoOf,
  PUBLIC_RULES_EVERY_MS,
  publishGuardCheck,
} from '../../server/services/doctor-checks.js';
import { RM_TEST_DIR } from '../helpers/rm-test-dir';

/**
 * What keeps the working history out of the public repository (2026-11-12: the working
 * repository is private, the public one receives the clean copy of scripts/public-export.sh,
 * and the only guard was a hook written by hand in one Mac's .git/hooks). Three layers, each
 * tried here against toy repositories and a made-up `gh`: nothing talks to GitHub.
 */
const ROOT = path.resolve(__dirname, '../../../..');
const HOOKS = path.join(ROOT, 'scripts/git-hooks');
const RULES_SCRIPT = path.join(ROOT, 'scripts/public-repo-rules.sh');

// The names in pieces: the test that keeps the public repository's address written one way
// reads this file too.
const WORK = ['Nachx639', 'untether-dev'].join('/');
const PUBLIC = ['Nachx639', 'untether'].join('/');
const HOST = ['github', 'com'].join('.');

const env: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Someone Private',
  GIT_AUTHOR_EMAIL: 'someone@private.invalid',
  GIT_COMMITTER_NAME: 'Someone Private',
  GIT_COMMITTER_EMAIL: 'someone@private.invalid',
};
for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[name];

const sh = (command: string, args: string[], cwd: string, extra: NodeJS.ProcessEnv = {}) => {
  const run = spawnSync(command, args, { cwd, env: { ...env, ...extra }, encoding: 'utf8' });
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
};
const git = (cwd: string, ...args: string[]) => {
  const run = sh('git', args, cwd);
  if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.output}`);
  return run.output.trim();
};

/**
 * An `ssh` that reaches no network: whatever host git asks for, the push lands in a bare
 * repository of the test. So a push to a GitHub address is a real `git push`, hook included.
 */
function fakeSsh(dir: string, bare: string): NodeJS.ProcessEnv {
  const file = path.join(dir, 'fake-ssh');
  fs.writeFileSync(file, `#!/bin/sh\nexec git-receive-pack '${bare}'\n`, { mode: 0o755 });
  return { GIT_SSH_COMMAND: file, GIT_SSH_VARIANT: 'simple' };
}

// The public copy does not carry the working repository's hook (scripts/public-export.rules).
describe.skipIf(process.platform === 'win32' || !fs.existsSync(HOOKS))(
  "the working repository's push guard",
  () => {
    let dir: string;
    let repo: string;
    let bare: string;

    beforeEach(() => {
      dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ut-push-guard-')));
      repo = path.join(dir, 'work');
      bare = path.join(dir, 'remote.git');
      fs.mkdirSync(path.join(repo, 'scripts/git-hooks'), { recursive: true });
      git(repo, 'init', '--quiet', '--initial-branch=main');
      git(dir, 'init', '--quiet', '--bare', '--initial-branch=main', bare);
      for (const name of ['pre-push', 'install.sh']) {
        fs.copyFileSync(path.join(HOOKS, name), path.join(repo, 'scripts/git-hooks', name));
      }
      fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
      git(repo, 'add', '-A');
      git(repo, 'commit', '--quiet', '-m', 'a private commit');
    });

    afterEach(() => {
      fs.rmSync(dir, RM_TEST_DIR);
    });

    const hook = (url: string) => sh('sh', [path.join(HOOKS, 'pre-push'), 'origin', url], repo);
    const install = (...args: string[]) =>
      sh('bash', [path.join(repo, 'scripts/git-hooks/install.sh'), ...args], repo);
    const pushed = () => sh('git', ['rev-parse', '--verify', '--quiet', 'refs/heads/main'], bare);

    it('lets the private working repository through, by https or ssh', () => {
      for (const url of [
        `https://${HOST}/${WORK}`,
        `https://${HOST}/${WORK}.git`,
        `https://${HOST}/${WORK}/`,
        `git@${HOST}:${WORK}.git`,
        `ssh://git@${HOST}/${WORK}.git`,
        `https://${HOST}/${WORK.toLowerCase()}.git`,
      ]) {
        expect(hook(url), url).toEqual({ status: 0, output: '' });
      }
    });

    it('refuses the public repository and every other destination, saying why', () => {
      for (const url of [
        `https://${HOST}/${PUBLIC}`,
        `https://${HOST}/${PUBLIC}.git`,
        `git@${HOST}:${PUBLIC}.git`,
        `ssh://git@${HOST}/${PUBLIC}.git`,
        `https://${HOST}/someone-else/untether-dev.git`,
        `https://${HOST}/${WORK}-fork.git`,
        `https://${HOST}/${WORK}/extra`,
        `https://gitlab.com/${WORK}.git`,
        `https://${HOST}.evil.example/${WORK}.git`,
        '/some/folder/on/this/mac',
        '',
      ]) {
        const run = hook(url);
        expect(run.status, url).toBe(1);
        expect(run.output, url).toContain('pre-push: BLOCKED');
        expect(run.output, url).toContain(`destination refused: ${url || '<none>'}`);
        expect(run.output, url).toContain('scripts/public-export.sh');
      }
    });

    it('is installed in the hooks git runs, and a real push obeys it', () => {
      // A fresh clone: nothing installed, and git pushes anywhere.
      expect(install('--check').status).toBe(1);
      const first = install();
      expect(first.output).toContain('push-guard: installed');
      expect(first.status).toBe(0);
      expect(install('--check')).toEqual({ status: 0, output: '' });
      expect(install().output).toContain('in place');

      const ssh = fakeSsh(dir, bare);
      // The public repository: the fake ssh would take it, the hook does not let it leave.
      git(repo, 'remote', 'add', 'public', `git@${HOST}:${PUBLIC}.git`);
      const refused = sh('git', ['push', 'public', 'main'], repo, ssh);
      expect(refused.status).not.toBe(0);
      expect(refused.output).toContain('pre-push: BLOCKED');
      expect(pushed().status).not.toBe(0);
      // A folder of this Mac, with no remote at all.
      expect(sh('git', ['push', bare, 'main'], repo).output).toContain('pre-push: BLOCKED');
      expect(pushed().status).not.toBe(0);

      // The private working repository: the very same push goes through.
      git(repo, 'remote', 'add', 'origin', `git@${HOST}:${WORK}.git`);
      const allowed = sh('git', ['push', 'origin', 'main'], repo, ssh);
      expect(allowed.output).not.toContain('BLOCKED');
      expect(allowed.status).toBe(0);
      expect(pushed().status).toBe(0);
    });

    it('covers every worktree, whatever its branch holds', () => {
      expect(install().status).toBe(0);
      // A branch from before the guard existed: its tree has no scripts/git-hooks at all.
      git(repo, 'checkout', '--quiet', '--orphan', 'old');
      git(repo, 'rm', '-r', '--quiet', '--force', '.');
      fs.writeFileSync(path.join(repo, 'old.txt'), 'old\n');
      git(repo, 'add', '-A');
      git(repo, 'commit', '--quiet', '-m', 'an old branch');
      git(repo, 'checkout', '--quiet', 'main');
      const worktree = path.join(dir, 'worktree');
      git(repo, 'worktree', 'add', '--quiet', worktree, 'old');
      expect(fs.existsSync(path.join(worktree, 'scripts'))).toBe(false);
      const run = sh('git', ['push', bare, 'old'], worktree);
      expect(run.status).not.toBe(0);
      expect(run.output).toContain('pre-push: BLOCKED');
    });

    it('renews a hook that is not the tracked one, and --check says which is wrong', () => {
      const target = path.join(repo, '.git/hooks/pre-push');
      fs.writeFileSync(target, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const differs = install('--check');
      expect(differs.status).toBe(1);
      expect(differs.output).toContain('is not scripts/git-hooks/pre-push');
      expect(fs.readFileSync(target, 'utf8')).toBe('#!/bin/sh\nexit 0\n');

      expect(install().status).toBe(0);
      expect(fs.readFileSync(target, 'utf8')).toBe(
        fs.readFileSync(path.join(HOOKS, 'pre-push'), 'utf8')
      );
      fs.chmodSync(target, 0o644);
      expect(install('--check').output).toContain('is not executable');
      expect(install().status).toBe(0);
      expect(fs.statSync(target).mode & 0o111).not.toBe(0);
    });

    it('fails when core.hooksPath would keep git from running it', () => {
      git(repo, 'config', 'core.hooksPath', '.hooks');
      for (const args of [[], ['--check']]) {
        const run = install(...args);
        expect(run.status).toBe(1);
        expect(run.output).toContain("core.hooksPath is '.hooks'");
      }
      expect(fs.existsSync(path.join(repo, '.git/hooks/pre-push'))).toBe(false);
    });

    // 2026-11-12 review: with extensions.worktreeConfig one worktree can switch its hooks off.
    it('fails when a worktree has a core.hooksPath of its own', () => {
      expect(install().status).toBe(0);
      const worktree = path.join(dir, 'worktree');
      git(repo, 'worktree', 'add', '--quiet', '-b', 'side', worktree);
      git(repo, 'config', 'extensions.worktreeConfig', 'true');
      git(worktree, 'config', '--worktree', 'core.hooksPath', path.join(dir, 'no-hooks'));
      const run = install('--check');
      expect(run.status).toBe(1);
      expect(run.output).toContain(`in ${worktree}`);
      git(worktree, 'config', '--worktree', '--unset', 'core.hooksPath');
      expect(install('--check').status).toBe(0);
    });

    it('installs nothing outside a checkout of the repository itself', () => {
      // A copy of the files inside another repository: that repository's hooks are not ours.
      const outer = path.join(dir, 'outer');
      const inner = path.join(outer, 'vendor/untether/scripts/git-hooks');
      fs.mkdirSync(inner, { recursive: true });
      git(outer, 'init', '--quiet');
      for (const name of ['pre-push', 'install.sh']) {
        fs.copyFileSync(path.join(HOOKS, name), path.join(inner, name));
      }
      const run = sh('bash', [path.join(inner, 'install.sh')], outer);
      expect(run.status).toBe(0);
      expect(run.output).toContain('nothing to install');
      expect(fs.existsSync(path.join(outer, '.git/hooks/pre-push'))).toBe(false);
    });
  }
);

/** A `gh` that answers `gh api` from a file of the test and writes down every call. */
const FAKE_GH = `#!/usr/bin/env node
const fs = require('node:fs');
const dir = process.env.FAKE_GH_DIR;
const file = dir + '/state.json';
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
if (args[0] !== 'api') process.exit(2);
let method = 'GET';
let input;
let route = '';
for (let i = 1; i < args.length; i++) {
  if (args[i] === '-X') method = args[++i];
  else if (args[i] === '--input') input = args[++i];
  else route = args[i];
}
fs.appendFileSync(dir + '/calls.log', method + ' ' + route + '\\n');
const fail = (message, status) => {
  console.log(JSON.stringify({ message, status: String(status) }));
  console.error('gh: ' + message + ' (HTTP ' + status + ')');
  process.exit(1);
};
if (state.fail === 'network') {
  console.error('error connecting to api.github.com');
  process.exit(1);
}
const match = /^repos\\/([^/]+\\/[^/?]+)(\\/rulesets(?:\\/(\\d+))?)?(?:\\?.*)?$/.exec(route);
if (!match || match[1] !== state.repo) fail('Not Found', 404);
if (!match[2]) {
  console.log(JSON.stringify({ visibility: state.visibility, private: state.visibility !== 'public', default_branch: state.default_branch }));
  process.exit(0);
}
if (state.visibility !== 'public') fail('Upgrade to GitHub Pro or make this repository public to enable this feature.', 403);
const id = match[3] ? Number(match[3]) : undefined;
if (method === 'GET' && id === undefined) {
  console.log(JSON.stringify(state.rulesets.map(({ id, name, target, enforcement }) => ({ id, name, target, enforcement }))));
} else if (method === 'GET') {
  const found = state.rulesets.find((ruleset) => ruleset.id === id);
  if (!found) fail('Not Found', 404);
  console.log(JSON.stringify(found));
} else {
  if (state.fail === 'write') fail('Validation Failed', 422);
  if (method === 'DELETE') {
    state.rulesets = state.rulesets.filter((ruleset) => ruleset.id !== id);
    fs.writeFileSync(file, JSON.stringify(state));
    process.exit(0);
  }
  const body = JSON.parse(fs.readFileSync(input, 'utf8'));
  if (method === 'POST') state.rulesets.push({ id: Math.max(100, ...state.rulesets.map((r) => r.id)) + 1, ...body });
  else state.rulesets = state.rulesets.map((ruleset) => (ruleset.id === id ? { id, ...body } : ruleset));
  fs.writeFileSync(file, JSON.stringify(state));
  console.log(JSON.stringify(body));
}
`;

interface Ruleset {
  id: number;
  name: string;
  target: string;
  enforcement: string;
  bypass_actors: unknown[];
  conditions: { ref_name: { include: string[]; exclude: string[] } };
  rules: Array<{ type: string }>;
}

describe.skipIf(process.platform === 'win32')('scripts/public-repo-rules.sh', () => {
  let dir: string;
  const state = () =>
    JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')) as { rulesets: Ruleset[] };
  const setState = (value: Record<string, unknown>) =>
    fs.writeFileSync(
      path.join(dir, 'state.json'),
      JSON.stringify({ repo: 'toy-owner/toy', default_branch: 'main', rulesets: [], ...value })
    );
  const calls = () => {
    const file = path.join(dir, 'calls.log');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n') : [];
  };
  const writes = () => calls().filter((call) => !call.startsWith('GET '));
  const rules = (...args: string[]) =>
    sh('bash', [RULES_SCRIPT, '--repo', 'toy-owner/toy', ...args], dir, {
      PATH: `${path.join(dir, 'bin')}:${process.env.PATH ?? ''}`,
      FAKE_GH_DIR: dir,
    });

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ut-repo-rules-')));
    fs.mkdirSync(path.join(dir, 'bin'));
    fs.writeFileSync(path.join(dir, 'bin/gh'), FAKE_GH, { mode: 0o755 });
  });

  afterEach(() => {
    fs.rmSync(dir, RM_TEST_DIR);
  });

  it('says a private repository cannot hold the rules yet, and writes nothing', () => {
    setState({ visibility: 'private' });
    for (const mode of ['--check', '--apply']) {
      const run = rules(mode);
      expect(run.status, mode).toBe(4);
      expect(run.output).toContain('toy-owner/toy is private');
      expect(run.output).toContain('Upgrade to GitHub Pro or make this repository public');
      expect(run.output).toContain('--apply right after making it public');
    }
    expect(writes()).toEqual([]);
  });

  it('names what a public repository lacks, creates it, and then finds it in place', () => {
    setState({ visibility: 'public' });
    const before = rules('--check');
    expect(before.status).toBe(1);
    expect(before.output.match(/^MISSING /gm)).toHaveLength(4);
    expect(before.output).toContain('run scripts/public-repo-rules.sh --apply');
    expect(writes()).toEqual([]);

    const apply = rules('--apply');
    expect(apply.output).toContain('the rulesets are in place');
    expect(apply.status).toBe(0);
    expect(writes()).toEqual(Array(4).fill('POST repos/toy-owner/toy/rulesets'));

    const byRules = (types: string[]) =>
      state().rulesets.filter(
        (ruleset) =>
          JSON.stringify(ruleset.rules.map((rule) => rule.type).sort()) ===
          JSON.stringify(types.sort())
      );
    for (const ruleset of state().rulesets) {
      expect(ruleset.enforcement).toBe('active');
      expect(ruleset.bypass_actors).toEqual([]);
    }
    // Every branch but main, and every tag that is not a release's (v*): nothing created,
    // updated or deleted.
    const closed = byRules(['creation', 'update', 'deletion']);
    expect(closed.map((ruleset) => [ruleset.target, ruleset.conditions.ref_name]).sort()).toEqual([
      ['branch', { include: ['~ALL'], exclude: ['refs/heads/main'] }],
      ['tag', { include: ['~ALL'], exclude: ['refs/tags/v*'] }],
    ]);
    // A release tag can be created (mac/scripts/release.sh), and then stays where it is.
    const pinned = byRules(['update', 'deletion']);
    expect(pinned.map((ruleset) => [ruleset.target, ruleset.conditions.ref_name])).toEqual([
      ['tag', { include: ['refs/tags/v*'], exclude: [] }],
    ]);
    // main: no force-push, no deletion.
    const main = byRules(['non_fast_forward', 'deletion']);
    expect(main.map((ruleset) => [ruleset.target, ruleset.conditions.ref_name])).toEqual([
      ['branch', { include: ['refs/heads/main'], exclude: [] }],
    ]);

    expect(rules('--check').status).toBe(0);
    // Applied twice: nothing is written again.
    const again = rules('--apply');
    expect(again.status).toBe(0);
    expect(writes()).toHaveLength(4);
  });

  it('corrects a ruleset somebody weakened: a bypass list, a rule gone, switched off', () => {
    setState({ visibility: 'public' });
    expect(rules('--apply').status).toBe(0);
    const weakened = state();
    weakened.rulesets[0].bypass_actors = [{ actor_id: 5, actor_type: 'RepositoryRole' }];
    weakened.rulesets[1].rules = [{ type: 'deletion' }];
    weakened.rulesets[2].enforcement = 'disabled';
    setState({ visibility: 'public', rulesets: weakened.rulesets });

    const check = rules('--check');
    expect(check.status).toBe(1);
    expect(check.output).toContain('1 bypass actor(s)');
    expect(check.output).toContain('rules are ["deletion"]');
    expect(check.output).toContain('enforcement is disabled');

    fs.rmSync(path.join(dir, 'calls.log'));
    expect(rules('--apply').status).toBe(0);
    expect(writes().sort()).toEqual(
      [101, 102, 103].map((id) => `PUT repos/toy-owner/toy/rulesets/${id}`)
    );
    expect(rules('--check').status).toBe(0);
  });

  // 2026-11-12: "untether: no tags yet" became two rulesets with other names. Found by name,
  // the old one would have stayed, refusing every tag, with --check saying all was in place.
  it("retires an earlier ruleset of its own that is no longer wanted, and nobody else's", () => {
    const old = (id: number, name: string): Ruleset => ({
      id,
      name,
      target: 'tag',
      enforcement: 'active',
      bypass_actors: [],
      conditions: { ref_name: { include: ['~ALL'], exclude: [] } },
      rules: ['creation', 'update', 'deletion'].map((type) => ({ type })),
    });
    setState({ visibility: 'public' });
    expect(rules('--apply').status).toBe(0);
    setState({
      visibility: 'public',
      rulesets: [
        ...state().rulesets,
        old(7, 'untether: no tags yet'),
        old(8, 'somebody else: tags'),
      ],
    });

    const check = rules('--check');
    expect(check.status).toBe(1);
    expect(check.output).toContain('STALE    untether: no tags yet');
    expect(check.output).not.toContain('somebody else');
    expect(writes()).toHaveLength(4);

    fs.rmSync(path.join(dir, 'calls.log'));
    const apply = rules('--apply');
    expect(apply.status).toBe(0);
    expect(writes()).toEqual(['DELETE repos/toy-owner/toy/rulesets/7']);
    expect(
      state()
        .rulesets.map((ruleset) => ruleset.name)
        .sort()
    ).toEqual([
      'somebody else: tags',
      'untether: main only moves forward',
      'untether: only main exists',
      'untether: only release tags',
      'untether: release tags never move',
    ]);
    expect(rules('--check').status).toBe(0);
  });

  it('does not call a repository protected when main is not its default branch', () => {
    setState({ visibility: 'public', default_branch: 'trunk' });
    expect(rules('--apply').status).toBe(1);
    expect(rules('--check').output).toContain("the default branch of toy-owner/toy is 'trunk'");
  });

  it('cannot tell without GitHub, and says so instead of "missing"', () => {
    setState({ visibility: 'public', fail: 'network' });
    const offline = rules('--check');
    expect(offline.status).toBe(3);
    expect(offline.output).toContain('cannot tell');
    setState({ visibility: 'public', repo: 'toy-owner/another' });
    const unknown = rules('--check');
    expect(unknown.status).toBe(3);
    expect(unknown.output).toContain('does not exist or this account cannot see it');
  });

  it('fails when GitHub refuses a write', () => {
    setState({ visibility: 'public', fail: 'write' });
    const run = rules('--apply');
    expect(run.status).toBe(1);
    expect(run.output).toContain('could not create');
  });

  it('needs a mode', () => {
    expect(rules().status).toBe(2);
    expect(rules('--check', '--apply').status).toBe(2);
  });
});

describe("the doctor's publish-guard check", () => {
  const REPO = '/repo';
  const INSTALLER = `${REPO}/scripts/git-hooks/install.sh`;
  const RULES = `${REPO}/scripts/public-repo-rules.sh`;

  /** A checkout whose commands answer from a table; every command run is written down. */
  function setup(
    answers: {
      check?: number;
      install?: number;
      remotes?: string;
      /** `git worktree list --porcelain`, and the remotes any worktree but the checkout sees. */
      worktrees?: string;
      otherRemotes?: string;
      rules?: { code: number; output: string };
      files?: string[];
    } = {}
  ) {
    const ran: string[] = [];
    const state = { now: 0, ...answers };
    const check = publishGuardCheck({
      repo: REPO,
      publicRepo: () => 'toy-owner/toy',
      exists: (file) => (state.files ?? [INSTALLER, RULES]).includes(file),
      now: () => state.now,
      run: async (command, args) => {
        ran.push([command, ...args].join(' '));
        if (command === 'git' && args[2] === 'worktree') {
          return { code: 0, output: state.worktrees ?? `worktree ${REPO}\nHEAD abc\n` };
        }
        if (command === 'git') {
          return { code: 0, output: (args[1] === REPO ? state.remotes : state.otherRemotes) ?? '' };
        }
        if (args[0] === RULES) return state.rules ?? { code: 0, output: 'in place' };
        if (args[1] === '--check') {
          return {
            code: state.check ?? 0,
            output: 'push-guard: /repo/.git/hooks/pre-push is missing\n',
          };
        }
        return { code: state.install ?? 0, output: "push-guard: core.hooksPath is '.hooks'\n" };
      },
    });
    return { check, ran, state };
  }

  it('finds nothing when the guard, the remotes and the rules are right', async () => {
    const { check, ran } = setup({
      remotes: `remote.origin.url https://${HOST}/toy-owner/toy-dev.git\n`,
    });
    expect(await check.run()).toEqual([]);
    expect(ran).toEqual([
      `bash ${INSTALLER} --check`,
      `git -C ${REPO} worktree list --porcelain`,
      `git -C ${REPO} config --get-regexp ^remote\\..*\\.(url|pushurl)$`,
      `bash ${RULES} --check`,
    ]);
  });

  it('is not for the public copy or the installed app: no tracked hook, nothing run', async () => {
    const { check, ran } = setup({ files: [RULES] });
    expect(await check.run()).toEqual([]);
    expect(ran).toEqual([]);
  });

  it('installs a missing guard again, and warns only when it cannot', async () => {
    const healed = setup({ check: 1 });
    expect(await healed.check.run()).toEqual([
      {
        key: 'publish-guard:hook',
        check: 'publish-guard',
        severity: 'info',
        problem:
          'The push guard of the working repository was not in place (push-guard: /repo/.git/hooks/pre-push is missing)',
        healed: 'installed again',
      },
    ]);
    expect(healed.ran).toContain(`bash ${INSTALLER}`);

    const stuck = setup({ check: 1, install: 1 });
    const [finding] = await stuck.check.run();
    expect(finding.severity).toBe('warning');
    expect(finding.healed).toBeUndefined();
    expect(finding.problem).toContain(
      "could not be installed: push-guard: core.hooksPath is '.hooks'"
    );
  });

  it('warns about a remote that points at the public repository, by https or ssh', async () => {
    const { check } = setup({
      remotes: [
        `remote.origin.url https://${HOST}/toy-owner/toy-dev.git`,
        `remote.public.url https://${HOST}/Toy-Owner/toy.git`,
        `remote.mirror.pushurl git@${HOST}:toy-owner/toy.git`,
        '',
      ].join('\n'),
    });
    const findings = await check.run();
    expect(findings.map((finding) => [finding.key, finding.severity])).toEqual([
      ['publish-guard:remote:public', 'warning'],
      ['publish-guard:remote:mirror', 'warning'],
    ]);
    expect(findings[0].problem).toContain('git -C /repo remote remove public');
  });

  // 2026-11-12 review: with extensions.worktreeConfig a worktree can have remotes of its own,
  // which the checkout's configuration does not show.
  it('reads the remotes of every worktree, and tells each remote once', async () => {
    const { check, ran } = setup({
      files: [INSTALLER, RULES, '/worktrees/task'],
      worktrees: `worktree ${REPO}\nHEAD abc\n\nworktree /worktrees/task\nHEAD def\n\nworktree /worktrees/gone\nHEAD 123\n`,
      remotes: `remote.origin.url https://${HOST}/toy-owner/toy-dev.git\n`,
      otherRemotes: `remote.origin.url https://${HOST}/toy-owner/toy-dev.git\nremote.leak.url https://${HOST}/toy-owner/toy.git\n`,
    });
    const findings = await check.run();
    expect(findings.map((finding) => finding.key)).toEqual(['publish-guard:remote:leak']);
    expect(findings[0].problem).toContain('git -C /worktrees/task remote remove leak');
    expect(ran.filter((command) => command.includes('--get-regexp'))).toHaveLength(2);
  });

  it('warns when the public repository is visible without its rules, with what is missing', async () => {
    const { check } = setup({
      rules: {
        code: 1,
        output:
          'public-repo-rules: toy-owner/toy (public)\nok       a\nMISSING  untether: only release tags (missing)\nSTALE    untether: no tags yet (replaced)\nnot protected yet\n',
      },
    });
    expect(await check.run()).toEqual([
      {
        key: 'publish-guard:rules',
        check: 'publish-guard',
        severity: 'warning',
        problem: `The public repository toy-owner/toy is visible without its rules: untether: only release tags (missing); untether: no tags yet (replaced). Run: ${RULES} --apply`,
      },
    ]);
  });

  it('only notes a repository still private, or GitHub out of reach', async () => {
    const still = setup({ rules: { code: 4, output: 'toy-owner/toy is private' } });
    expect((await still.check.run()).map((finding) => [finding.key, finding.severity])).toEqual([
      ['publish-guard:rules-unknown:private', 'info'],
    ]);
    const offline = setup({
      rules: { code: 3, output: 'public-repo-rules: cannot tell: gh is not installed\n' },
    });
    const [finding] = await offline.check.run();
    expect(finding.severity).toBe('info');
    expect(finding.problem).toContain('cannot tell: gh is not installed');
  });

  it('asks GitHub once an hour, not on every run', async () => {
    const { check, ran, state } = setup();
    const asked = () => ran.filter((command) => command.includes(RULES)).length;
    await check.run();
    await check.run();
    expect(asked()).toBe(1);
    state.now = PUBLIC_RULES_EVERY_MS;
    await check.run();
    expect(asked()).toBe(2);
  });

  it('reads owner/name from any GitHub address, and nothing from another host', () => {
    expect(githubRepoOf(`https://${HOST}/Toy-Owner/Toy.git`)).toBe('toy-owner/toy');
    expect(githubRepoOf(`git@${HOST}:toy-owner/toy`)).toBe('toy-owner/toy');
    expect(githubRepoOf(`ssh://git@${HOST}/toy-owner/toy.git/`)).toBe('toy-owner/toy');
    expect(githubRepoOf(`https://token@${HOST}/toy-owner/toy`)).toBe('toy-owner/toy');
    expect(githubRepoOf('https://gitlab.com/toy-owner/toy.git')).toBeUndefined();
    expect(githubRepoOf('/some/folder')).toBeUndefined();
  });
});
