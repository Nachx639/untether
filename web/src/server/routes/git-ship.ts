/**
 * Ship from the phone: commit, push and open a pull request for a session's git repository.
 *
 * Safety rules (each one has a test):
 * - every command is `execFile` with an argument array in the repo directory; never a shell,
 *   never string interpolation into a command line;
 * - file paths must resolve inside the repository and are passed as `:(literal)` pathspecs
 *   after `--`;
 * - commits run the repository hooks (no `--no-verify`) and surface their output on failure;
 * - pushes are never forced, refuse a detached HEAD, and refuse main/master unless the request
 *   carries the explicit `confirmMain` the confirm sheet sends when the user ticks it;
 * - one ship operation at a time per repository; every command has a timeout.
 */
import { type Request, type Response, Router } from 'express';
import type { SessionInfo } from '../../shared/types.js';
import { isSafeRefName, type RunResult, run } from '../utils/exec-file.js';
import { createLogger } from '../utils/logger.js';
import { type ChangedFile, getChanges, safeRepoRelative } from './git-changes.js';

const logger = createLogger('git-ship');

const READ_TIMEOUT_MS = 15_000;
/** Commit and push run hooks (lint, tests) and may talk to a remote: give them time. */
const WRITE_TIMEOUT_MS = 180_000;
const GH_TIMEOUT_MS = 60_000;
const MAX_MESSAGE_CHARS = 20_000;
const MAX_FILES = 2000;
const PROTECTED_BRANCHES = new Set(['main', 'master']);
/** Arguments that would rewrite remote history. Checked on every push before it runs. */
const FORCE_ARG = /^(-f|--force|--force-with-lease|--force-if-includes|--mirror|--delete|-d)(=|$)/;

class ShipError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly output?: string
  ) {
    super(message);
  }
}

const combined = (r: RunResult) =>
  [r.stdout, r.stderr]
    .filter((s) => s.trim())
    .join('\n')
    .trim();

async function git(repo: string, args: string[], timeout = READ_TIMEOUT_MS): Promise<RunResult> {
  return run('git', args, repo, timeout);
}

async function gitOk(repo: string, args: string[]): Promise<string | null> {
  const r = await git(repo, args);
  return r.code === 0 ? r.stdout.trim() : null;
}

export function assertNoForce(args: string[]): void {
  for (const a of args) {
    if (FORCE_ARG.test(a) || a.startsWith('+') || a.includes(':+') || a.startsWith(':')) {
      throw new ShipError(500, 'force-refused', `Refusing a destructive push argument: ${a}`);
    }
  }
}

export interface BranchState {
  branch: string | null;
  detached: boolean;
  head: string | null;
  upstream: string | null;
  upstreamRemote: string | null;
  upstreamBranch: string | null;
  ahead: number;
  behind: number;
  remotes: string[];
}

export async function getBranchState(repo: string): Promise<BranchState> {
  const branch = await gitOk(repo, ['symbolic-ref', '--short', '-q', 'HEAD']);
  const head = await gitOk(repo, ['rev-parse', '--verify', '-q', 'HEAD']);
  const remotesOut = await gitOk(repo, ['remote']);
  const remotes = remotesOut ? remotesOut.split('\n').filter(Boolean) : [];
  let upstream: string | null = null;
  let upstreamRemote: string | null = null;
  let upstreamBranch: string | null = null;
  let ahead = 0;
  let behind = 0;
  if (branch) {
    upstreamRemote = await gitOk(repo, ['config', '--get', `branch.${branch}.remote`]);
    const merge = await gitOk(repo, ['config', '--get', `branch.${branch}.merge`]);
    upstreamBranch = merge?.startsWith('refs/heads/') ? merge.slice('refs/heads/'.length) : null;
    upstream = await gitOk(repo, [
      'rev-parse',
      '--abbrev-ref',
      '--symbolic-full-name',
      `${branch}@{upstream}`,
    ]);
    if (upstream && head) {
      const counts = await gitOk(repo, [
        'rev-list',
        '--left-right',
        '--count',
        `${branch}...${branch}@{upstream}`,
      ]);
      const [a, b] = (counts ?? '0 0').split(/\s+/).map((n) => Number.parseInt(n, 10) || 0);
      ahead = a;
      behind = b;
    } else if (head && !upstream) {
      // Nothing upstream yet: everything not on any remote is "ahead".
      const count = await gitOk(repo, ['rev-list', '--count', 'HEAD', '--not', '--remotes']);
      ahead = Number.parseInt(count ?? '0', 10) || 0;
    }
    if (!upstream) {
      upstreamRemote = null;
      upstreamBranch = null;
    }
  }
  return {
    branch,
    detached: !branch && !!head,
    head,
    upstream,
    upstreamRemote,
    upstreamBranch,
    ahead,
    behind,
    remotes,
  };
}

export interface GhState {
  available: boolean;
  authenticated: boolean;
  defaultBranch?: string;
  message?: string;
}

async function getGhState(repo: string, ghBin: string): Promise<GhState> {
  const version = await run(ghBin, ['--version'], repo, GH_TIMEOUT_MS);
  if (version.spawnError) return { available: false, authenticated: false };
  const auth = await run(ghBin, ['auth', 'status'], repo, GH_TIMEOUT_MS);
  if (auth.code !== 0) {
    return { available: true, authenticated: false, message: combined(auth).slice(0, 2000) };
  }
  const view = await run(
    ghBin,
    ['repo', 'view', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'],
    repo,
    GH_TIMEOUT_MS
  );
  const defaultBranch = view.code === 0 ? view.stdout.trim() : '';
  return {
    available: true,
    authenticated: true,
    ...(isSafeRefName(defaultBranch) ? { defaultBranch } : {}),
  };
}

export interface CommitSummary {
  subject: string;
  body: string;
}

async function commitsSince(repo: string, base: string, remote: string | null) {
  const candidates = remote ? [`${remote}/${base}`, base] : [base];
  for (const ref of candidates) {
    if (
      !(await gitOk(repo, ['rev-parse', '--verify', '-q', `refs/remotes/${ref}`])) &&
      !(await gitOk(repo, ['rev-parse', '--verify', '-q', `refs/heads/${ref}`]))
    ) {
      continue;
    }
    const r = await git(repo, [
      'log',
      '--reverse',
      '--max-count=50',
      '--format=%s%x1f%b%x1e',
      `${ref}..HEAD`,
      '--',
    ]);
    if (r.code !== 0) continue;
    return r.stdout
      .split('\x1e')
      .map((c) => c.trim())
      .filter(Boolean)
      .map((c): CommitSummary => {
        const [subject, body = ''] = c.split('\x1f');
        return { subject: subject.trim(), body: body.trim() };
      });
  }
  return [];
}

/** PR title/body prefilled from the commits the PR would contain. */
export function prefillPr(commits: CommitSummary[], branch: string | null) {
  if (commits.length === 1) return { title: commits[0].subject, body: commits[0].body };
  const title =
    commits[0]?.subject ??
    (branch
      ? branch
          .replace(/^[^/]+\//, '')
          .replace(/[-_]+/g, ' ')
          .trim()
      : '');
  const body = commits.map((c) => `- ${c.subject}`).join('\n');
  return { title, body };
}

interface ShipPtyManager {
  getSession(sessionId: string): SessionInfo | null | undefined;
}

export interface GitShipRouteOptions {
  ptyManager: ShipPtyManager;
  /** The GitHub CLI binary; resolved through PATH by default. */
  ghBin?: string;
}

/**
 * GET  /sessions/:id/git/ship-status[?pr=1&base=<branch>]
 * POST /sessions/:id/git/commit  { files: [{path, oldPath?}], message }
 * POST /sessions/:id/git/push    { setUpstream?: boolean, confirmMain?: boolean }
 * POST /sessions/:id/git/pr      { title, body, base, draft? }
 */
export function createGitShipRoutes(options: GitShipRouteOptions): Router {
  const router = Router();
  const ghBin = options.ghBin ?? 'gh';
  const busy = new Set<string>();

  const repoFor = async (req: Request): Promise<string> => {
    const session = options.ptyManager.getSession(String(req.params.sessionId));
    if (!session) throw new ShipError(404, 'not-found', 'Session not found');
    const dir = session.workingDir || session.gitRepoPath;
    if (!dir) throw new ShipError(400, 'not-repo', 'This session has no folder');
    const root = await run('git', ['rev-parse', '--show-toplevel'], dir, READ_TIMEOUT_MS);
    if (root.code !== 0 || !root.stdout.trim()) {
      throw new ShipError(400, 'not-repo', 'This folder is not in a git repository');
    }
    return root.stdout.trim();
  };

  const withLock = async <T>(repo: string, fn: () => Promise<T>): Promise<T> => {
    if (busy.has(repo)) {
      throw new ShipError(409, 'busy', 'Another git operation is running in this repository');
    }
    busy.add(repo);
    try {
      return await fn();
    } finally {
      busy.delete(repo);
    }
  };

  const fail = (res: Response, error: unknown) => {
    if (error instanceof ShipError) {
      return res.status(error.status).json({
        error: error.message,
        code: error.code,
        ...(error.output ? { output: error.output } : {}),
      });
    }
    logger.error('git ship error:', error);
    return res.status(500).json({ error: 'Git operation failed', code: 'failed' });
  };

  router.get('/sessions/:sessionId/git/ship-status', async (req, res) => {
    try {
      const repo = await repoFor(req);
      const [state, changes] = await Promise.all([getBranchState(repo), getChanges(repo)]);
      const result: Record<string, unknown> = {
        repoPath: repo,
        ...state,
        protectedBranch: !!state.branch && PROTECTED_BRANCHES.has(state.branch),
        files: changes.files,
        untrackedTruncated: changes.untrackedTruncated ?? false,
      };
      if (req.query.pr === '1') {
        const gh = await getGhState(repo, ghBin);
        const requested = typeof req.query.base === 'string' ? req.query.base : '';
        const base = isSafeRefName(requested) ? requested : (gh.defaultBranch ?? 'main');
        const commits = await commitsSince(
          repo,
          base,
          state.upstreamRemote ?? (state.remotes.includes('origin') ? 'origin' : null)
        );
        const branchesOut = await gitOk(repo, [
          'for-each-ref',
          '--format=%(refname:lstrip=3)',
          'refs/remotes/',
        ]);
        const bases = [
          ...new Set(
            [base, ...(branchesOut ?? '').split('\n')].filter(
              (b) => isSafeRefName(b) && b !== 'HEAD' && b !== state.branch
            )
          ),
        ].slice(0, 100);
        result.pr = { gh, base, bases, commits, ...prefillPr(commits, state.branch) };
      }
      return res.json(result);
    } catch (error) {
      return fail(res, error);
    }
  });

  router.post('/sessions/:sessionId/git/commit', async (req, res) => {
    try {
      const repo = await repoFor(req);
      const { files, message } = req.body ?? {};
      if (typeof message !== 'string' || !message.trim()) {
        throw new ShipError(400, 'invalid', 'The commit message is empty');
      }
      if (message.length > MAX_MESSAGE_CHARS || message.includes('\0')) {
        throw new ShipError(400, 'invalid', 'The commit message is too long');
      }
      if (!Array.isArray(files) || files.length === 0 || files.length > MAX_FILES) {
        throw new ShipError(400, 'invalid', 'Choose at least one file');
      }
      const rels = new Set<string>();
      for (const f of files) {
        const entries = typeof f === 'string' ? [f] : [f?.path, f?.oldPath].filter(Boolean);
        if (entries.length === 0) throw new ShipError(400, 'invalid', 'Invalid file');
        for (const p of entries) {
          const rel = typeof p === 'string' ? safeRepoRelative(repo, p) : null;
          if (!rel) throw new ShipError(400, 'outside-repo', 'File is outside the repository');
          rels.add(rel);
        }
      }
      const pathspecs = [...rels].map((r) => `:(literal)${r}`);
      const out = await withLock(repo, async () => {
        const add = await git(repo, ['add', '-A', '--', ...pathspecs], WRITE_TIMEOUT_MS);
        if (add.code !== 0) throw new ShipError(422, 'add-failed', 'git add failed', combined(add));
        // --only: exactly the chosen paths, even when other files were staged beforehand.
        const commit = await git(
          repo,
          ['commit', '--only', '-m', message, '--', ...pathspecs],
          WRITE_TIMEOUT_MS
        );
        if (commit.code !== 0) {
          throw new ShipError(422, 'commit-failed', 'The commit failed', combined(commit));
        }
        return commit;
      });
      const head = await gitOk(repo, ['rev-parse', 'HEAD']);
      return res.json({ ok: true, commit: head, output: combined(out) });
    } catch (error) {
      return fail(res, error);
    }
  });

  router.post('/sessions/:sessionId/git/push', async (req, res) => {
    try {
      const repo = await repoFor(req);
      const { setUpstream, confirmMain } = req.body ?? {};
      const result = await withLock(repo, async () => {
        const state = await getBranchState(repo);
        if (!state.branch) {
          throw new ShipError(409, 'detached', 'HEAD is detached: check out a branch to push');
        }
        if (!state.head) throw new ShipError(409, 'no-commits', 'There are no commits to push');
        let args: string[];
        let target: string;
        if (state.upstream && state.upstreamRemote && state.upstreamBranch) {
          target = state.upstreamBranch;
          args = [
            'push',
            '--porcelain',
            state.upstreamRemote,
            `refs/heads/${state.branch}:refs/heads/${state.upstreamBranch}`,
          ];
        } else {
          if (setUpstream !== true) {
            throw new ShipError(409, 'no-upstream', 'This branch has no upstream yet');
          }
          if (!state.remotes.includes('origin')) {
            throw new ShipError(409, 'no-origin', 'There is no "origin" remote');
          }
          target = state.branch;
          args = [
            'push',
            '--porcelain',
            '-u',
            'origin',
            `refs/heads/${state.branch}:refs/heads/${state.branch}`,
          ];
        }
        if (
          (PROTECTED_BRANCHES.has(state.branch) || PROTECTED_BRANCHES.has(target)) &&
          confirmMain !== true
        ) {
          throw new ShipError(409, 'protected', `Pushing to ${target} needs explicit confirmation`);
        }
        assertNoForce(args);
        const push = await git(repo, args, WRITE_TIMEOUT_MS);
        if (push.code !== 0)
          throw new ShipError(422, 'push-failed', 'The push failed', combined(push));
        return { push, target };
      });
      const state = await getBranchState(repo);
      return res.json({ ok: true, output: combined(result.push), ...state });
    } catch (error) {
      return fail(res, error);
    }
  });

  router.post('/sessions/:sessionId/git/pr', async (req, res) => {
    try {
      const repo = await repoFor(req);
      const { title, body, base, draft } = req.body ?? {};
      if (typeof title !== 'string' || !title.trim() || title.length > 500) {
        throw new ShipError(400, 'invalid', 'The PR title is empty');
      }
      if (body !== undefined && (typeof body !== 'string' || body.length > MAX_MESSAGE_CHARS)) {
        throw new ShipError(400, 'invalid', 'The PR description is too long');
      }
      if (!isSafeRefName(base)) throw new ShipError(400, 'invalid', 'Invalid base branch');
      const url = await withLock(repo, async () => {
        const state = await getBranchState(repo);
        if (!state.branch) throw new ShipError(409, 'detached', 'HEAD is detached');
        if (state.branch === base) {
          throw new ShipError(409, 'same-branch', 'The branch is the same as the base');
        }
        const version = await run(ghBin, ['--version'], repo, GH_TIMEOUT_MS);
        if (version.spawnError) {
          throw new ShipError(412, 'gh-missing', 'The GitHub CLI (gh) is not installed on the Mac');
        }
        const auth = await run(ghBin, ['auth', 'status'], repo, GH_TIMEOUT_MS);
        if (auth.code !== 0) {
          throw new ShipError(412, 'gh-unauthenticated', 'gh is not signed in', combined(auth));
        }
        const args = [
          'pr',
          'create',
          `--title=${title}`,
          `--body=${typeof body === 'string' ? body : ''}`,
          `--base=${base}`,
          `--head=${state.branch}`,
        ];
        if (draft === true) args.push('--draft');
        const pr = await run(ghBin, args, repo, GH_TIMEOUT_MS);
        if (pr.code !== 0)
          throw new ShipError(422, 'pr-failed', 'gh pr create failed', combined(pr));
        const found = pr.stdout.match(/https?:\/\/\S+/g);
        if (!found)
          throw new ShipError(422, 'pr-failed', 'gh did not return a PR URL', combined(pr));
        return found[found.length - 1];
      });
      return res.json({ ok: true, url });
    } catch (error) {
      return fail(res, error);
    }
  });

  return router;
}

export type { ChangedFile };
