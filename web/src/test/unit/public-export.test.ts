import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RM_TEST_DIR } from '../helpers/rm-test-dir';

/**
 * scripts/public-export.sh against a toy repository (2026-11-11: the working repository stays
 * private and what is published is the copy this script makes). A copy with a personal trace, a
 * secret, a file nobody looked at or a broken LICENSE must not come out, and a failed export
 * must leave nothing behind that looks like a good one.
 */
const SCRIPT = path.resolve(__dirname, '../../../../scripts/public-export.sh');
const GUARD = path.resolve(__dirname, '../../../../scripts/public-export.pre-push');

const hasTrufflehog = spawnSync('trufflehog', ['--version']).status === 0;

const RULES = `
list-over-mb 1
fail-over-mb 2
exclude internal/**
forbid **/.env
forbid **/*.cast
allow fixtures/made-up.cast
media-ok art/logo.png
`;

const LICENSE = `MIT License

Copyright (c) 2026 Untether contributors
Copyright (c) 2025 Amantus Machina

Permission is hereby granted.
`;

describe.skipIf(process.platform === 'win32')('scripts/public-export.sh', () => {
  let dir: string;
  let repo: string;
  let dest: string;

  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 'Someone Private',
    GIT_AUTHOR_EMAIL: 'someone@private.invalid',
    GIT_COMMITTER_NAME: 'Someone Private',
    GIT_COMMITTER_EMAIL: 'someone@private.invalid',
  };
  delete (env as Record<string, string | undefined>).PUBLIC_EXPORT_AUTHOR_NAME;
  delete (env as Record<string, string | undefined>).PUBLIC_EXPORT_AUTHOR_EMAIL;

  const git = (cwd: string, ...args: string[]) => {
    const run = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr}`);
    return run.stdout.trim();
  };
  const write = (file: string, content: string | Buffer) => {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), content);
  };
  const commit = (message: string) => {
    git(repo, 'add', '-A');
    git(repo, 'commit', '--quiet', '-m', message);
  };
  const exportTo = (target = dest) => {
    const run = spawnSync('bash', [SCRIPT, '--source', repo, target], { env, encoding: 'utf8' });
    return { status: run.status, output: `${run.stdout}${run.stderr}` };
  };
  /** What the export left next to the destination: its temporary folder must never stay. */
  const leftovers = () => fs.readdirSync(dir).filter((name) => name.includes('.export.'));

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ut-public-export-')));
    repo = path.join(dir, 'private');
    dest = path.join(dir, 'public');
    fs.mkdirSync(repo);
    git(repo, 'init', '--quiet', '--initial-branch=main');
    write('LICENSE', LICENSE);
    write('scripts/public-export.rules', RULES);
    write('scripts/public-export.pre-push', fs.readFileSync(GUARD));
    write(
      'web/package.json',
      '{\n  "name": "toy",\n  "version": "1.2.3",\n  "homepage": "https://github.com/Toy-Owner/toy"\n}\n'
    );
    write('src/main.ts', 'export const answer = 42;\n');
    write('internal/notes.md', 'How one machine was checked.\n');
    write('art/logo.png', Buffer.from('89504e470d0a1a0a', 'hex'));
    write('fixtures/made-up.cast', '{"version":2}\n');
    commit('first private commit');
    write('src/more.ts', 'export const more = 1;\n');
    commit('second private commit');
  });

  afterEach(() => {
    fs.rmSync(dir, RM_TEST_DIR);
  });

  it('makes a repository of one commit by a neutral author, without remotes or history', () => {
    // Untracked and uncommitted work stays behind: only HEAD travels.
    write('untracked.txt', 'not committed\n');
    const run = exportTo();
    expect(run.output).toContain('OK');
    expect(run.status).toBe(0);

    expect(git(dest, 'rev-list', '--count', 'HEAD')).toBe('1');
    expect(git(dest, 'log', '-1', '--format=%an <%ae> | %cn <%ce> | %s')).toBe(
      'Untether contributors <contributors@untether.invalid> | Untether contributors <contributors@untether.invalid> | Untether 1.2.3'
    );
    expect(git(dest, 'log', '--format=%an%cn%B')).not.toContain('Private');
    expect(git(dest, 'remote')).toBe('');
    expect(git(dest, 'status', '--porcelain')).toBe('');
    expect(git(dest, 'ls-files').split('\n').sort()).toEqual([
      'LICENSE',
      'art/logo.png',
      'fixtures/made-up.cast',
      'scripts/public-export.pre-push',
      'scripts/public-export.rules',
      'src/main.ts',
      'src/more.ts',
      'web/package.json',
    ]);
    expect(fs.existsSync(path.join(dest, 'internal'))).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it('adds one commit on top when the destination is the public clone, and none when nothing changed', () => {
    expect(exportTo().status).toBe(0);
    const same = exportTo();
    expect(same.status).toBe(0);
    expect(same.output).toContain('nothing to publish');
    expect(git(dest, 'rev-list', '--count', 'HEAD')).toBe('1');

    write('src/main.ts', 'export const answer = 43;\n');
    fs.rmSync(path.join(repo, 'src/more.ts'));
    commit('third private commit');
    expect(exportTo().status).toBe(0);
    expect(git(dest, 'rev-list', '--count', 'HEAD')).toBe('2');
    expect(git(dest, 'status', '--porcelain')).toBe('');
    expect(fs.readFileSync(path.join(dest, 'src/main.ts'), 'utf8')).toContain('43');
    expect(fs.existsSync(path.join(dest, 'src/more.ts'))).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it('fails on a vetoed name and on a real home folder, and writes nothing', () => {
    // In pieces: this file is tracked and read by the same guard.
    const person = ['na', 'cho'].join('');
    write('src/notes.ts', `// asked by ${person}\nconst home = '/Users/${person}639/Projects';\n`);
    commit('a personal trace');
    const run = exportTo();
    expect(run.status).not.toBe(0);
    expect(run.output).toContain('personal trace: src/notes.ts:1: name: a vetoed name');
    expect(run.output).toContain('personal trace: src/notes.ts:2: home:');
    expect(fs.existsSync(dest)).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it('leaves a public clone as it was when a later export fails', () => {
    expect(exportTo().status).toBe(0);
    const before = git(dest, 'rev-parse', 'HEAD');
    write('config/.env', 'A=1\n');
    commit('a local configuration file');
    const run = exportTo();
    expect(run.status).not.toBe(0);
    expect(run.output).toContain('forbidden file (**/.env): config/.env');
    expect(git(dest, 'rev-parse', 'HEAD')).toBe(before);
    expect(git(dest, 'status', '--porcelain')).toBe('');
    expect(leftovers()).toEqual([]);
  });

  it.skipIf(!hasTrufflehog)('fails on a secret trufflehog finds, without printing it', () => {
    // Made here, never written in the repository: a real private key that opens nothing.
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    write('deploy/key.txt', privateKey);
    commit('a key');
    const run = exportTo();
    expect(run.status).not.toBe(0);
    expect(run.output).toContain('secret: deploy/key.txt:1 (PrivateKey)');
    expect(run.output).not.toContain(privateKey.split('\n')[1]);
    expect(fs.existsSync(dest)).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  // 2026-11-11 review: the script that reads trufflehog's findings ended in `|| true`, so findings
  // it could not read counted as none.
  it('fails closed when the findings of trufflehog cannot be read', () => {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, 'trufflehog'),
      '#!/bin/sh\n[ "$1" = --version ] && { echo fake; exit 0; }\necho \'{"DetectorName": broken\'\n',
      { mode: 0o755 }
    );
    const run = spawnSync('bash', [SCRIPT, '--source', repo, dest], {
      env: { ...env, PATH: `${bin}:${process.env.PATH ?? ''}` },
      encoding: 'utf8',
    });
    expect(run.status).not.toBe(0);
    expect(`${run.stdout}${run.stderr}`).toContain("trufflehog's findings could not be read");
    expect(fs.existsSync(dest)).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  // Same review: the commit of a later export was made from the clone's folder, where files
  // git ignores stayed, and a tracked file .gitignore names was dropped from the copy.
  it('publishes exactly the tree it checked, whatever the clone holds or .gitignore names', () => {
    write('.gitignore', 'dist/\n');
    write('dist/kept.js', 'tracked although ignored\n');
    git(repo, 'add', '-A', '--force');
    git(repo, 'commit', '--quiet', '-m', 'a tracked file that is ignored');
    expect(exportTo().status).toBe(0);
    expect(git(dest, 'ls-files')).toContain('dist/kept.js');

    fs.writeFileSync(path.join(dest, 'dist/local.js'), 'only on this machine\n');
    write('src/main.ts', 'export const answer = 44;\n');
    commit('a change');
    const run = exportTo();
    expect(run.status).toBe(0);
    expect(run.output).toContain('not part of the publication');
    expect(git(dest, 'rev-list', '--count', 'HEAD')).toBe('2');
    expect(git(dest, 'ls-files')).not.toContain('dist/local.js');
    expect(git(dest, 'ls-files')).toContain('dist/kept.js');
    expect(git(dest, 'log', '-1', '--format=%an|%cn')).toBe(
      'Untether contributors|Untether contributors'
    );
    // Its tree is the source's, minus what the rules leave out.
    git(repo, 'rm', '-r', '--quiet', 'internal');
    expect(git(dest, 'rev-parse', 'HEAD^{tree}')).toBe(git(repo, 'write-tree'));
  });

  it('fails on media nobody looked at, a forbidden file, a file too large, a stale rule and a LICENSE without both copyrights', () => {
    write('docs/shot.PNG', Buffer.from('89504e470d0a1a0a', 'hex'));
    write('big.bin', Buffer.alloc(3 * 1024 * 1024, 1));
    write('recordings/real.cast', '{"version":2}\n');
    write('LICENSE', LICENSE.replace('Copyright (c) 2025 Amantus Machina\n', ''));
    fs.rmSync(path.join(repo, 'internal'), RM_TEST_DIR);
    commit('everything wrong at once');
    const run = exportTo();
    expect(run.status).not.toBe(0);
    expect(run.output).toContain('media nobody looked at: docs/shot.PNG');
    expect(run.output).toContain('file above 2 MB: big.bin');
    expect(run.output).toContain('exclude internal/**: matches no tracked file');
    expect(run.output).toContain('LICENSE lost its copyright line of Amantus Machina');
    expect(run.output).toContain('forbidden file (**/*.cast): recordings/real.cast');
    expect(run.output).not.toContain('made-up.cast');
    expect(run.output).toContain('5 problem(s)');
    expect(fs.existsSync(dest)).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  // 2026-11-11: workflows answer issues and pull requests from anybody with the repository's
  // permissions. None travels, and no rule lets one through.
  it('refuses a GitHub Actions workflow or action even when a rule allows it', () => {
    write(
      'scripts/public-export.rules',
      `${RULES}forbid **/.github/**\nallow .github/**\nallow tools/.github/**\n`
    );
    write('.github/ISSUE_TEMPLATE/bug_report.md', 'What happened?\n');
    commit('an issue form');
    expect(exportTo().status).toBe(0);
    expect(git(dest, 'ls-files')).toContain('.github/ISSUE_TEMPLATE/bug_report.md');

    write('.github/workflows/ci.yml', 'on: issue_comment\n');
    write('.github/actions/setup/action.yml', 'name: setup\n');
    write('tools/.github/workflows/nested.yaml', 'on: push\n');
    commit('workflows');
    const before = git(dest, 'rev-parse', 'HEAD');
    const run = exportTo();
    expect(run.status).not.toBe(0);
    expect(run.output).toContain('GitHub Actions file: .github/workflows/ci.yml');
    expect(run.output).toContain('GitHub Actions file: .github/actions/setup/action.yml');
    expect(run.output).toContain('GitHub Actions file: tools/.github/workflows/nested.yaml');
    expect(run.output).toContain('3 problem(s)');
    expect(git(dest, 'rev-parse', 'HEAD')).toBe(before);
    expect(leftovers()).toEqual([]);
  });

  // Whatever else lands in .github (dependabot, CODEOWNERS, FUNDING) names accounts: it is read first.
  it('refuses a new file under .github until a rule says somebody read it', () => {
    write(
      'scripts/public-export.rules',
      `${RULES}forbid **/.github/**\nallow .github/ISSUE_TEMPLATE/bug_report.md\n`
    );
    write('.github/ISSUE_TEMPLATE/bug_report.md', 'What happened?\n');
    write('.github/FUNDING.yml', 'github: someone\n');
    commit('funding');
    const run = exportTo();
    expect(run.status).not.toBe(0);
    expect(run.output).toContain('forbidden file (**/.github/**): .github/FUNDING.yml');
    expect(run.output).toContain('1 problem(s)');
    expect(fs.existsSync(dest)).toBe(false);
  });

  // 2026-11-12: the copy's pre-push hook was put by hand in one clone. Every export writes it.
  describe('the push guard of the copy', () => {
    const hookOf = (folder: string) => path.join(folder, '.git/hooks/pre-push');
    /** An `ssh` that reaches no network: the push lands in a bare repository of the test. */
    const push = (remote: string, url: string, ref = 'main') => {
      const bare = path.join(dir, `${remote}.git`);
      if (!fs.existsSync(bare)) git(dir, 'init', '--quiet', '--bare', bare);
      const ssh = path.join(dir, `ssh-${remote}`);
      fs.writeFileSync(ssh, `#!/bin/sh\nexec git-receive-pack '${bare}'\n`, { mode: 0o755 });
      const run = spawnSync('git', ['push', url, ref], {
        cwd: dest,
        env: { ...env, GIT_SSH_COMMAND: ssh, GIT_SSH_VARIANT: 'simple' },
        encoding: 'utf8',
      });
      const landed =
        spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${ref}`], { cwd: bare })
          .status === 0;
      return { status: run.status, output: `${run.stdout}${run.stderr}`, landed };
    };

    it('is written on the first export and lets only the exporter out, only to the public repository', () => {
      const run = exportTo();
      expect(run.status).toBe(0);
      expect(run.output).toContain('only to github.com/toy-owner/toy');
      const hook = fs.readFileSync(hookOf(dest), 'utf8');
      expect(hook).toContain('ALLOWED="toy-owner/toy"');
      expect(hook).not.toContain('@PUBLIC_REPO@');
      expect(fs.statSync(hookOf(dest)).mode & 0o111).not.toBe(0);
      // The hook is the repository's, not a file of the publication.
      expect(git(dest, 'status', '--porcelain', '--ignored')).toBe('');

      const elsewhere = push('elsewhere', 'git@github.com:toy-owner/toy-dev.git');
      expect(elsewhere.status).not.toBe(0);
      expect(elsewhere.output).toContain('pre-push: BLOCKED');
      expect(elsewhere.landed).toBe(false);

      const published = push('public', 'git@github.com:Toy-Owner/toy.git');
      expect(published.output).not.toContain('BLOCKED');
      expect(published.status).toBe(0);
      expect(published.landed).toBe(true);
    });

    it('refuses a commit the exporter did not make, and history of the working repository', () => {
      expect(exportTo().status).toBe(0);
      fs.writeFileSync(path.join(dest, 'by-hand.txt'), 'edited in the copy\n');
      git(dest, 'add', '-A');
      git(dest, 'commit', '--quiet', '-m', 'a commit made by hand');
      const byHand = push('public', 'git@github.com:toy-owner/toy.git');
      expect(byHand.status).not.toBe(0);
      expect(byHand.output).toContain('Commits the exporter did not make');
      expect(byHand.output).toContain('someone@private.invalid');
      expect(byHand.landed).toBe(false);

      // The working history, fetched into the copy and pushed as a branch.
      git(dest, 'fetch', '--quiet', repo, 'main:work');
      const history = push('public', 'git@github.com:toy-owner/toy.git', 'work');
      expect(history.status).not.toBe(0);
      expect(history.output).toContain('Commits the exporter did not make');
      expect(history.landed).toBe(false);
    });

    it('is put back on every later export, even one with nothing to publish', () => {
      expect(exportTo().status).toBe(0);
      const hook = fs.readFileSync(hookOf(dest), 'utf8');
      fs.rmSync(hookOf(dest));
      expect(exportTo().output).toContain('nothing to publish');
      expect(fs.readFileSync(hookOf(dest), 'utf8')).toBe(hook);

      // Somebody replaced it and pointed git at another hooks folder.
      fs.writeFileSync(hookOf(dest), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      git(dest, 'config', 'core.hooksPath', '.other-hooks');
      write('src/main.ts', 'export const answer = 45;\n');
      commit('a change');
      const run = exportTo();
      expect(run.status).toBe(0);
      expect(run.output).toContain('had core.hooksPath set');
      expect(fs.readFileSync(hookOf(dest), 'utf8')).toBe(hook);
      expect(git(dest, 'config', 'core.hooksPath')).toBe('.git/hooks');
    });

    // 2026-11-12 review: only the clone's own core.hooksPath was looked at. A global one (a
    // hooks manager for every repository) or a worktree-level one left the hook written and
    // never run, with the export saying the copy was protected.
    it('runs whatever core.hooksPath the person or a worktree configuration sets', () => {
      const elsewhere = path.join(dir, 'global-hooks');
      fs.mkdirSync(elsewhere);
      const globalConfig = path.join(dir, 'gitconfig');
      fs.writeFileSync(globalConfig, `[core]\n\thooksPath = ${elsewhere}\n`);
      expect(exportTo().status).toBe(0);
      // The clone names its own hooks folder, which wins over the global one.
      expect(git(dest, 'config', '--local', 'core.hooksPath')).toBe('.git/hooks');
      const bare = path.join(dir, 'other.git');
      git(dir, 'init', '--quiet', '--bare', bare);
      const asThePerson = { ...env, GIT_CONFIG_GLOBAL: globalConfig };
      const run = spawnSync('git', ['push', bare, 'main'], {
        cwd: dest,
        env: asThePerson,
        encoding: 'utf8',
      });
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain('pre-push: BLOCKED');

      // The folder is renamed: the hook still runs.
      const renamed = path.join(dir, 'public-renamed');
      fs.renameSync(dest, renamed);
      const after = spawnSync('git', ['push', bare, 'main'], {
        cwd: renamed,
        env: asThePerson,
        encoding: 'utf8',
      });
      expect(after.stderr).toContain('pre-push: BLOCKED');
      fs.renameSync(renamed, dest);

      // A worktree-level value, above the clone's own: removed by the next export.
      git(dest, 'config', 'extensions.worktreeConfig', 'true');
      git(dest, 'config', '--worktree', 'core.hooksPath', elsewhere);
      expect(git(dest, 'config', 'core.hooksPath')).toBe(elsewhere);
      expect(exportTo().status).toBe(0);
      expect(git(dest, 'config', 'core.hooksPath')).toBe('.git/hooks');
    });

    it('fails the export when the copy does not name its public repository', () => {
      write('web/package.json', '{\n  "name": "toy",\n  "version": "1.2.3"\n}\n');
      commit('no homepage');
      const run = exportTo();
      expect(run.status).not.toBe(0);
      expect(run.output).toContain("the copy's push guard cannot be written");
      expect(fs.existsSync(dest)).toBe(false);
      expect(leftovers()).toEqual([]);
    });
  });

  it('refuses a destination inside the repository or one holding something else', () => {
    expect(exportTo(path.join(repo, 'out')).status).toBe(2);
    fs.mkdirSync(dest);
    fs.writeFileSync(path.join(dest, 'mine.txt'), 'keep me\n');
    const run = exportTo();
    expect(run.status).toBe(2);
    expect(fs.readdirSync(dest)).toEqual(['mine.txt']);
    expect(leftovers()).toEqual([]);
  });
});
