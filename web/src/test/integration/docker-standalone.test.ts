import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RM_TEST_DIR } from '../helpers/rm-test-dir.js';

function isDockerAvailable(): boolean {
  const result = spawnSync('docker', ['info'], { stdio: 'ignore' });
  return result.status === 0;
}

function runDocker(args: string[], cwd: string): { stdout: string; stderr: string } {
  const result = spawnSync('docker', args, {
    cwd,
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    throw new Error(
      `docker ${args.join(' ')} failed with code ${result.status ?? 'null'}\n` +
        `stdout:\n${result.stdout || ''}\n` +
        `stderr:\n${result.stderr || ''}`
    );
  }

  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function currentGitCommit(cwd: string): string | undefined {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd,
    encoding: 'utf8',
  });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

// 2026-10-25: pnpm install in the image failed (ENOENT patches/authenticate-pam@1.0.5.patch)
// for weeks unseen, as this build only runs where Docker runs. Without Docker: every file
// pnpm needs to install (patchedDependencies) is copied before the install.
describe('Dockerfile.standalone install inputs', () => {
  it('copies every patched dependency file before pnpm install', () => {
    const dockerfile = readFileSync('Dockerfile.standalone', 'utf8');
    const beforeInstall = dockerfile.slice(0, dockerfile.indexOf('RUN pnpm install'));
    const copied = [...beforeInstall.matchAll(/^COPY\s+(\S+)\s/gm)].map((m) => m[1]);
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    const patches = Object.values<string>(pkg.pnpm?.patchedDependencies ?? {});
    expect(patches.length).toBeGreaterThan(0);
    for (const file of patches) {
      expect(copied.some((src) => file === src || file.startsWith(`${src}/`))).toBe(true);
    }
  });
});

/**
 * The image fetches ut-fwd's sources, at one exact commit, from UT_FWD_REPOSITORY (or the
 * default one) without credentials. 2026-10-25: with the repository private, every build
 * failed there: skip then.
 *
 * 2026-11-12: the default repository became public, so it could be read, and the build failed
 * all the same ("upload-pack: not our ref"): it is a clean copy, and a commit of the working
 * repository is never in it. What has to be there is the commit, so that is what is asked,
 * with the fetch the image makes.
 */
function canFetchUtFwdSources(commit: string | undefined): boolean {
  const fallback = /^ARG UT_FWD_REPOSITORY=(\S+)/m.exec(
    readFileSync('Dockerfile.standalone', 'utf8')
  )?.[1];
  const repository = process.env.UT_FWD_REPOSITORY || fallback;
  if (!repository || !commit) return false;
  const probe = mkdtempSync(path.join(tmpdir(), 'ut-fwd-probe-'));
  const git = (...args: string[]) =>
    spawnSync('git', args, {
      cwd: probe,
      stdio: 'ignore',
      timeout: 120_000,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: 'echo',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
      },
    }).status === 0;
  try {
    return (
      git('init', '--quiet') &&
      git('fetch', '--quiet', '--depth', '1', '--filter=blob:none', repository, commit)
    );
  } finally {
    rmSync(probe, RM_TEST_DIR);
  }
}

/** The commit whose ut-fwd sources the image is built with. */
function utFwdCommit(): string | undefined {
  return process.env.UT_FWD_COMMIT || process.env.GITHUB_SHA || currentGitCommit(process.cwd());
}

/** On every image and container this test makes, so they can all be removed. */
const TEST_LABEL = 'dev.untether.test=docker-standalone';

const describeDocker =
  isDockerAvailable() && canFetchUtFwdSources(utFwdCommit()) ? describe : describe.skip;

describeDocker('Dockerfile.standalone', () => {
  const projectRoot = process.cwd();
  const imageTag = `untether-standalone-test:${Date.now()}`;

  // 2026-10-31: a failed build left its intermediate containers (exited, pnpm install / cargo)
  // and three untagged 2 GB images in the user's Docker. Builds now remove intermediate
  // containers even on failure (--force-rm), label what they make, and afterwards everything
  // with the label goes, and so do the untagged step images (the legacy builder's cache, which
  // carries no label) that were not there before this test, whatever the outcome.
  const untaggedImages = () =>
    new Set(
      spawnSync('docker', ['images', '-a', '-q', '--no-trunc', '--filter', 'dangling=true'], {
        encoding: 'utf8',
      })
        .stdout.split('\n')
        .filter(Boolean)
    );
  let untaggedBefore = new Set<string>();
  beforeAll(() => {
    untaggedBefore = untaggedImages();
  });

  afterAll(() => {
    spawnSync('docker', ['image', 'rm', '-f', imageTag], { stdio: 'ignore' });
    spawnSync('docker', ['container', 'prune', '-f', '--filter', `label=${TEST_LABEL}`], {
      stdio: 'ignore',
    });
    spawnSync('docker', ['image', 'prune', '-f', '--filter', `label=${TEST_LABEL}`], {
      stdio: 'ignore',
    });
    const left = [...untaggedImages()].filter((id) => !untaggedBefore.has(id));
    if (left.length) spawnSync('docker', ['image', 'rm', ...left], { stdio: 'ignore' });
  });

  it(
    'builds and runs --version',
    () => {
      const buildArgs = [
        'build',
        '--force-rm',
        '--label',
        TEST_LABEL,
        '-f',
        'Dockerfile.standalone',
        '-t',
        imageTag,
      ];
      const repository = process.env.UT_FWD_REPOSITORY;
      const commit = utFwdCommit();

      if (repository) {
        buildArgs.push('--build-arg', `UT_FWD_REPOSITORY=${repository}`);
      }
      if (!commit) {
        throw new Error('Unable to determine an exact UT_FWD_COMMIT for the Docker build');
      }
      buildArgs.push('--build-arg', `UT_FWD_COMMIT=${commit}`);

      buildArgs.push('.');
      runDocker(buildArgs, projectRoot);
      const runResult = runDocker(['run', '--rm', imageTag, '--version'], projectRoot);
      expect(runResult.stdout).toContain('Untether');
    },
    10 * 60 * 1000
  );
});
