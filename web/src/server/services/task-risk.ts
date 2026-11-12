/**
 * Risk rules for a task's diff (base...HEAD), checked before a task is merged on its own.
 *
 * A finished task merges into the base branch without asking when its check passes, there are
 * no conflicts and nothing here fires. Every finding below makes the merge wait for the user
 * («te necesita»), with the rule and the file shown. The rules are deliberately broad: a false
 * alarm costs one tap, a silent bad merge costs the user's trust.
 *
 *  - big deletions: >500 lines deleted and more than twice the insertions; ≥5 files deleted;
 *    a file over 200 lines losing more than 60 %; a deleted test file.
 *  - secrets: key/credential files (.env* except example/sample, *.pem, *.key, *.p12, id_rsa*,
 *    id_ed25519*, .npmrc, .netrc, credentials*), and added lines that look like tokens.
 *  - deploy/infra/CI config (workflows, Docker, Terraform, k8s, signing, release, other CI).
 *  - database migrations and schema files (2026-10-20: only a `migrations/` folder was seen).
 *  - server-side auth and permission code (a server/api/middleware file named for it, or
 *    *auth*.ts|py|go|rb…), and changed lines that touch token/JWT verification, session
 *    secrets, password hashing or permission checks; UI, tests, docs and copy never count.
 *  - verification tampering: the check's own config (package.json scripts, Makefile, test runner,
 *    linter and tsconfig files) and added `.skip(` / `.only(` / `xit(` / `@ts-nocheck`.
 *  - binaries over 5 MB and submodule pointer changes.
 *  - added merge conflict markers (`<<<<<<< ` / `>>>>>>> ` lines): a conflict committed as is.
 *
 * `assessRisk` is pure; `collectRiskInput` gathers its input from git (argv arrays, timeouts).
 * `riskIgnore` globs (per project) exempt files from every rule, aggregate counts included.
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { NAMES_SECRET } from './copilot/safety.js';

export type RiskRule =
  | 'mass-deletion'
  | 'files-deleted'
  | 'file-gutted'
  | 'test-deleted'
  | 'secret-file'
  | 'secret-content'
  | 'deploy'
  | 'check-config'
  | 'test-disabled'
  | 'binary'
  | 'submodule'
  | 'conflict-marker'
  | 'migration'
  | 'auth';

export interface RiskFinding {
  rule: RiskRule;
  file?: string;
  detail: string;
}

/** One changed path, as git reports it for base...HEAD. */
export interface RiskFileChange {
  /** Path after the change (the old path for deletions). */
  path: string;
  /** Path before a rename/copy. */
  oldPath?: string;
  /** First letter of git's status: A M D R C T. */
  status: string;
  /** null for binary files. */
  insertions: number | null;
  deletions: number | null;
  binary?: boolean;
  /** Size of the new blob in bytes (collected for binaries). */
  sizeBytes?: number;
  /** Line count of the file at base (collected when the deletions could gut it). */
  linesBefore?: number;
  /** The `+` lines of the diff, without the leading `+`. */
  addedLines?: string[];
  /** The `-` lines of the diff, without the leading `-` (an auth check taken out). */
  removedLines?: string[];
  /** The path is a submodule (gitlink, mode 160000) on either side. */
  submodule?: boolean;
  /** For package.json files: the `scripts` object on each side (undefined when absent). */
  packageScripts?: { before?: Record<string, string>; after?: Record<string, string> };
}

export interface RiskInput {
  files: RiskFileChange[];
}

const MASS_DELETION_LINES = 500;
const FILES_DELETED_LIMIT = 5;
const GUTTED_MIN_LINES = 200;
const GUTTED_FRACTION = 0.6;
/** Share of a gutted file's lost lines that new files beside it must hold to count as a split. */
const SPLIT_COVERED = 0.8;
const BINARY_LIMIT_BYTES = 5 * 1024 * 1024;

const TEST_FILE =
  /(^|\/)(__tests__|__test__|tests?|spec|e2e)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py|rb)$|(^|\/)test_[^/]+\.py$|Tests?\.swift$|_spec\.rb$/;

export const SECRET_FILE =
  /(^|\/)\.env(\.[^/]*)?$|\.(pem|key|p12|pfx|keystore|jks)$|(^|\/)(id_rsa|id_ed25519|id_ecdsa)[^/]*$|(^|\/)\.npmrc$|(^|\/)\.netrc$|(^|\/)credentials[^/]*$|(^|\/)\.pypirc$/i;
export const SECRET_FILE_EXEMPT =
  /(^|\/)\.env\.(example|sample|template|dist)$|\.(example|sample)$/i;

export const SECRET_CONTENT: { name: string; re: RegExp }[] = [
  { name: 'AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { name: 'GitHub token', re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { name: 'Anthropic key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'API secret key', re: /\bsk-(proj-|live_|test_)?[A-Za-z0-9_-]{20,}/ },
  { name: 'Slack token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  {
    // Not a dotted key of short words such as an i18n message id (2026-11-01: `tokens:
    // 'board.budget.tokens'` held a merge as a hard-coded secret). A JWT's long segments
    // still match.
    name: 'hard-coded secret',
    re: /\b[\w.-]*(api[_-]?key|secret|token|passwd|password|private[_-]?key|access[_-]?key)[\w.-]*["']?\s*[:=]\s*["'](?![a-z][a-z0-9_-]{0,24}(?:\.[a-z0-9_-]{1,24})+["'])[^"'\s$<>{}]{12,}["']/i,
  },
];

const DEPLOY_FILE =
  /(^|\/)\.github\/(workflows|actions)\/|(^|\/)\.gitlab-ci\.ya?ml$|(^|\/)\.circleci\/|(^|\/)\.buildkite\/|(^|\/)Jenkinsfile$|(^|\/)azure-pipelines\.ya?ml$|(^|\/)bitbucket-pipelines\.ya?ml$|(^|\/)cloudbuild\.ya?ml$|(^|\/)serverless\.ya?ml$|(^|\/)(ansible|pulumi|terraform|infra|deploy)\/|(^|\/)(vercel\.json|netlify\.toml|fly\.toml|wrangler\.(toml|jsonc?)|firebase\.json|\.firebaserc|Procfile|app\.ya?ml)$|(^|\/)Dockerfile[^/]*$|(^|\/)docker-compose[^/]*$|(^|\/)compose\.ya?ml$|\.tf$|\.tfvars$|(^|\/)k8s\/|(^|\/)helm\/|\.entitlements$|(^|\/)scripts\/release[^/]*$|(^|\/)docs\/RELEASE\.md$/;
/** Database migrations and schemas: data that a revert does not bring back. */
const MIGRATION_FILE =
  /(^|\/)(migrations?|migrate)\/|(^|\/)alembic\/versions\/|(^|\/)schema\.(prisma|rb|sql)$|(^|\/)structure\.sql$|\.migration\.[cm]?[jt]s$/i;
/**
 * Server-side authentication and permission code (2026-10-20: the rule fired on any path that
 * mentioned login, role, auth or permission — LoginButton.tsx, role-badge.tsx, i18n copy, a
 * README — so harmless UI changes waited for the user). Now it is: a source file named for
 * auth in a server, backend, api or middleware folder, a server-language file named *auth* or
 * *jwt*, or one in an auth/, authz/, rbac/ or acl/ folder; never a UI component, client code,
 * a test, docs or strings. Auth logic elsewhere is caught by
 * what the diff does (AUTH_CONTENT) and by the AI review's security pass, which blocks a
 * medium or high finding and hands it to the agent before the user.
 */
const SERVER_EXT = '(ts|js|mjs|cjs|py|go|rb|rs|java|kt|php|cs|ex|exs)';
const SERVER_DIR = /(^|\/)(server|servers|backend|api|middlewares?)\//i;
/**
 * Bare "session" is not auth: in terminal and chat tools it names a terminal or a
 * conversation (2026-11-02: exited-session-cleanup.ts and session-recordings.ts held a merge).
 * Login sessions still show by their store, middleware, cookie or token in the name, by an
 * auth folder, and by what the lines do (session secrets, AUTH_CONTENT).
 */
const AUTH_NAME = new RegExp(
  `(^|/)[^/]*(auth(?!or)|login|logout|session[-_]?(store|middleware|auth|token|cookie|secret)|cookie[-_]?session|passwords?|permissions?|rbac|acl|roles?|jwt|oauth|csrf|guards?|access[-_]?control)[^/]*\\.${SERVER_EXT}$`,
  'i'
);
const AUTH_FILE_NAME = new RegExp(`(^|/)[^/]*(auth(?!or)|jwt)[^/]*\\.${SERVER_EXT}$`, 'i');
/** A folder that holds auth logic by its name (auth/, authz/, rbac/, acl/). */
const AUTH_DIR = new RegExp(
  `(^|/)(auth|authn|authz|authentication|authorization|rbac|acl)/(.*/)?[^/]+\\.${SERVER_EXT}$`,
  'i'
);
/** Not auth logic, whatever its name says: UI, tests, docs and user-facing strings. */
const UI_FILE = /\.(tsx|jsx|vue|svelte|astro|html?|css|scss)$/i;
const DOC_OR_COPY =
  /\.(md|mdx|txt|rst|adoc|json|ya?ml|po|pot|xliff|strings|stringsdict)$|(^|\/)(docs?|i18n|l10n|locales?|lang|translations?|strings|copy)(\/|[-_.])|(^|\/)[^/]*(strings|copy|messages|i18n|locale)[^/]*\.[^/]+$/i;
/** A client-side file (a React hook or store, a client or component folder). */
const CLIENT_FILE =
  /(^|\/)(client|components?|screens?|views?|ui|hooks?|stores?|frontend|app\/\(.*\))\/|(^|\/)use[A-Z][^/]*$/;
/**
 * Added or removed lines that change how a request is authenticated or authorized: token or
 * JWT verification, session secrets, password hashing, permission and role checks.
 */
const AUTH_CONTENT: RegExp[] = [
  /\bjwt\.(verify|decode|sign)\b|\bjwtVerify\b|\bverify(Jwt|JWT|Token|IdToken|AccessToken|Signature)\b/,
  /\btimingSafeEqual\b|\bcompare_digest\b|\bhmac\.(new|compare)\b/i,
  /\b(SESSION_SECRET|COOKIE_SECRET|JWT_SECRET|SECRET_KEY)\b|\bsession\w*\(\s*\{[^}]*\bsecret\b|\bsecret\s*:\s*process\.env\b/,
  /\b(bcrypt|argon2|scrypt|pbkdf2)\w*\b|\b(hash|verify|check|compare)_?Password\b|\bcheck_password\b|\bpassword_(hash|verify)\b/i,
  /\b(hasPermission|checkPermission|requirePermission|requireAuth|requireRole|requireAdmin|isAuthorized|isAuthenticated|ensureAuthenticated|authorize)\s*\(|@(PreAuthorize|Secured|RolesAllowed|login_required|permission_required)\b|\bpassport\.authenticate\b/,
];

/** The file is server-side auth code by its path. */
function authPath(file: string): boolean {
  if (UI_FILE.test(file) || DOC_OR_COPY.test(file) || CLIENT_FILE.test(file)) return false;
  if (TEST_FILE.test(file)) return false;
  return (
    (SERVER_DIR.test(file) && AUTH_NAME.test(file)) ||
    AUTH_FILE_NAME.test(file) ||
    AUTH_DIR.test(file)
  );
}

/** A changed line of a code file (not UI, tests, docs or strings) that touches auth logic. */
function authLine(file: string, lines: readonly string[]): string | undefined {
  if (UI_FILE.test(file) || DOC_OR_COPY.test(file) || TEST_FILE.test(file)) return undefined;
  return lines.find((line) => line.length < 500 && AUTH_CONTENT.some((re) => re.test(line)));
}
const SIGNING_LINE = /CODE_SIGN|DEVELOPMENT_TEAM|PROVISIONING_PROFILE|OTHER_CODE_SIGN_FLAGS/;

const CHECK_CONFIG_FILE =
  /(^|\/)(GNU)?[Mm]akefile$|(^|\/)(vitest|vite|jest|playwright)\.config\.[cm]?[jt]s$|(^|\/)vitest\.workspace\.[cm]?[jt]s$|(^|\/)biome\.jsonc?$|(^|\/)\.eslintrc[^/]*$|(^|\/)eslint\.config\.[cm]?[jt]s$|(^|\/)tsconfig[^/]*\.json$/;
/**
 * Test fixtures and sample projects: a config inside one is test data, not this project's
 * check (2026-11-02: test/fixtures/leaky-run/vitest.config.ts held a merge as check-config).
 */
const FIXTURE_DIR = /(^|\/)(fixtures?|__fixtures__|testdata|test-data|examples?|samples?)\//;
/**
 * A test switched off or narrowed. `.skip(` / `.only(` count only on a test runner's call
 * (it, test, describe, suite, context, bench, and chains like test.concurrent.skip):
 * 2026-11-01 `options.skip(full)` in plain code held a merge as a disabled test.
 */
const TEST_DISABLED =
  /\b(it|test|describe|suite|context|bench)(\.\w+)*\.(skip|only)\(|\bxit\(|\bxdescribe\(|\bfit\(|@ts-nocheck/;
/**
 * A line that disables a test in code, not one that only quotes such a call inside a string
 * (2026-11-04: a guard test's fixture `"describe.skip('y', ...",` held a merge). The match
 * counts when the quotes before it on the line are balanced.
 */
function disablesTest(line: string): boolean {
  const match = TEST_DISABLED.exec(line);
  if (!match) return false;
  const before = line.slice(0, match.index);
  return ["'", '"', '`'].every((quote) => before.split(quote).length % 2 === 1);
}
/**
 * A conflict marker line (2026-10-20: nothing stopped an agent from committing a half-resolved
 * merge, markers and all, and having it merged on its own).
 */
const CONFLICT_MARKER = /^(<{7}|>{7})(\s|$)/;

/** Minimal glob → RegExp: `**` any depth, `*` within a segment, `?` one char. No slash: basename. */
export function globToRegExp(glob: string): RegExp {
  let pattern = glob.trim().replace(/^\.\//, '');
  const anchored = pattern.includes('/');
  if (pattern.endsWith('/')) pattern += '**';
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        i++;
        if (pattern[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(anchored ? `^${re.replace(/^\//, '')}$` : `(^|/)${re}$`);
}

function isIgnored(file: RiskFileChange, ignore: RegExp[]): boolean {
  return ignore.some((re) => re.test(file.path) || (file.oldPath ? re.test(file.oldPath) : false));
}

function scriptsChanged(scripts: RiskFileChange['packageScripts']): string[] {
  if (!scripts) return [];
  const before = scripts.before ?? {};
  const after = scripts.after ?? {};
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...names].filter((name) => before[name] !== after[name]).sort();
}

/** Every rule that fires for this diff. Order: aggregates first, then per file in input order. */
export function assessRisk(input: RiskInput, riskIgnore: readonly string[] = []): RiskFinding[] {
  const ignore = riskIgnore.filter((g) => g.trim()).map(globToRegExp);
  const files = input.files.filter((f) => !isIgnored(f, ignore));
  const findings: RiskFinding[] = [];

  const inserted = files.reduce((n, f) => n + (f.insertions ?? 0), 0);
  const deleted = files.reduce((n, f) => n + (f.deletions ?? 0), 0);
  if (deleted > MASS_DELETION_LINES && deleted > 2 * inserted) {
    findings.push({ rule: 'mass-deletion', detail: `-${deleted} / +${inserted} lines` });
  }
  const deletedFiles = files.filter((f) => f.status === 'D');
  if (deletedFiles.length >= FILES_DELETED_LIMIT) {
    findings.push({ rule: 'files-deleted', detail: `${deletedFiles.length} files deleted` });
  }

  const movedTests = new Set(
    files
      .filter((f) => (f.status === 'A' || f.status === 'R') && TEST_FILE.test(f.path))
      .map((f) => path.posix.basename(f.path))
  );
  const splitInto = (filePath: string, lost: number): boolean => {
    const dir = path.posix.dirname(filePath);
    const prefix = dir === '.' ? '' : `${dir}/`;
    const moved = files
      .filter((o) => o.status === 'A' && o.path.startsWith(prefix))
      .reduce((n, o) => n + (o.insertions ?? 0), 0);
    return moved >= SPLIT_COVERED * lost;
  };
  for (const f of files) {
    const add = (rule: RiskRule, detail: string) => findings.push({ rule, file: f.path, detail });
    const added = f.addedLines ?? [];

    if (
      f.status !== 'D' &&
      f.status !== 'A' &&
      f.linesBefore !== undefined &&
      f.linesBefore > GUTTED_MIN_LINES
    ) {
      const lost = (f.deletions ?? 0) - (f.insertions ?? 0);
      // 2026-11-02: a file split into modules (its lines moved into files added under its own
      // folder in the same diff) is not gutted.
      if (lost > GUTTED_FRACTION * f.linesBefore && !splitInto(f.path, lost)) {
        add('file-gutted', `${f.linesBefore} → ${f.linesBefore - lost} lines`);
      }
    }
    // 2026-11-02: a test moved and rewritten (git sees D + A, under its rename threshold) is
    // not a deleted test: one with the same name added elsewhere in the diff carries it on.
    if (
      f.status === 'D' &&
      TEST_FILE.test(f.path) &&
      !movedTests.has(path.posix.basename(f.path))
    ) {
      add('test-deleted', 'test file deleted');
    }

    if (f.status !== 'D' && SECRET_FILE.test(f.path) && !SECRET_FILE_EXEMPT.test(f.path)) {
      add('secret-file', 'key or credentials file');
    } else if (f.status !== 'D' && !SECRET_FILE_EXEMPT.test(f.path) && NAMES_SECRET.test(f.path)) {
      add('secret-file', 'key or credentials path');
    }
    const secret = SECRET_CONTENT.find(({ re }) => added.some((line) => re.test(line)));
    if (secret) add('secret-content', `added line looks like a ${secret.name}`);

    const either = (re: RegExp) => re.test(f.path) || (!!f.oldPath && re.test(f.oldPath));
    if (either(MIGRATION_FILE)) add('migration', 'database migration or schema');
    if (authPath(f.path) || (!!f.oldPath && authPath(f.oldPath))) {
      add('auth', 'server-side authentication or permission code');
    } else {
      const line = authLine(f.path, [...added, ...(f.removedLines ?? [])]);
      if (line) add('auth', `changes an auth check: ${line.trim().slice(0, 100)}`);
    }
    if (DEPLOY_FILE.test(f.path) || (f.oldPath && DEPLOY_FILE.test(f.oldPath))) {
      add('deploy', 'deploy, infrastructure or CI config');
    } else if (f.path.endsWith('.xcconfig') && added.some((line) => SIGNING_LINE.test(line))) {
      add('deploy', 'code signing settings');
    }

    if (path.posix.basename(f.path) === 'package.json') {
      const changed = scriptsChanged(f.packageScripts);
      if (changed.length) add('check-config', `package.json scripts: ${changed.join(', ')}`);
    } else if (CHECK_CONFIG_FILE.test(f.path) && !FIXTURE_DIR.test(f.path)) {
      add('check-config', 'test, lint or typecheck config');
    }
    const disabled = added.find((line) => disablesTest(line));
    if (disabled) add('test-disabled', disabled.trim().slice(0, 120));

    if (f.binary && (f.sizeBytes ?? 0) > BINARY_LIMIT_BYTES) {
      add('binary', `${((f.sizeBytes ?? 0) / 1024 / 1024).toFixed(1)} MB binary`);
    }
    if (f.submodule) add('submodule', 'submodule pointer changed');
    const marker = added.find((line) => CONFLICT_MARKER.test(line));
    if (marker) add('conflict-marker', `conflict marker: ${marker.trim().slice(0, 80)}`);
  }
  return findings;
}

// ---------------------------------------------------------------------------------------------
// Collecting the input from git
// ---------------------------------------------------------------------------------------------

const GIT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT = 64 * 1024 * 1024;
const MAX_ADDED_LINES_PER_FILE = 5_000;
/** Blob reads (line counts, sizes, package.json) are capped so a huge diff stays cheap. */
const MAX_BLOB_READS = 60;

function git(cwd: string, args: string[], timeout = GIT_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'core.quotePath=false', ...args],
      {
        cwd,
        timeout,
        maxBuffer: MAX_OUTPUT,
        encoding: 'utf8',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1' },
      },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`git ${args[0]} failed: ${(stderr || error.message).trim()}`));
        else resolve(stdout);
      }
    );
  });
}

interface RawEntry {
  status: string;
  path: string;
  oldPath?: string;
  oldMode: string;
  newMode: string;
  oldSha: string;
  newSha: string;
}

/** `git diff --raw -z` → entries (`:old new oldSha newSha STATUS\0path\0[newPath\0]`). */
export function parseRawZ(out: string): RawEntry[] {
  const parts = out.split('\0');
  const entries: RawEntry[] = [];
  for (let i = 0; i < parts.length; i++) {
    const meta = parts[i];
    if (!meta.startsWith(':')) continue;
    const [oldMode, newMode, oldSha, newSha, statusField] = meta.slice(1).split(' ');
    const status = (statusField ?? '').charAt(0);
    if (status === 'R' || status === 'C') {
      entries.push({
        status,
        oldPath: parts[i + 1],
        path: parts[i + 2],
        oldMode,
        newMode,
        oldSha,
        newSha,
      });
      i += 2;
    } else {
      entries.push({ status, path: parts[i + 1], oldMode, newMode, oldSha, newSha });
      i += 1;
    }
  }
  return entries;
}

/** `git diff --numstat -z` → path → {insertions, deletions} (null for binaries). */
export function parseNumstatZ(
  out: string
): Map<string, { insertions: number | null; deletions: number | null }> {
  const result = new Map<string, { insertions: number | null; deletions: number | null }>();
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(parts[i]);
    if (!m) continue;
    const insertions = m[1] === '-' ? null : Number(m[1]);
    const deletions = m[2] === '-' ? null : Number(m[2]);
    let file = m[3];
    if (file === '') {
      // Rename/copy: the old and new paths follow as their own fields.
      file = parts[i + 2] ?? '';
      i += 2;
    }
    result.set(file, { insertions, deletions });
  }
  return result;
}

/** `git diff -U0` → path → added lines (capped per file). */
export function parseAddedLines(out: string): Map<string, string[]> {
  return parseChangedLines(out).added;
}

/** `git diff -U0` → path → added and removed lines (capped per file). */
export function parseChangedLines(out: string): {
  added: Map<string, string[]>;
  removed: Map<string, string[]>;
} {
  const added = new Map<string, string[]>();
  const removed = new Map<string, string[]>();
  let current: string | null = null;
  let oldPath: string | null = null;
  const push = (map: Map<string, string[]>, file: string, line: string) => {
    const list = map.get(file) ?? [];
    if (list.length < MAX_ADDED_LINES_PER_FILE) list.push(line);
    map.set(file, list);
  };
  // Inside a hunk, "--- x" / "+++ x" are a removed "-- x" / an added "++ x", not headers.
  let inHunk = false;
  for (const line of out.split('\n')) {
    if (line.startsWith('diff --git ')) {
      current = null;
      oldPath = null;
      inHunk = false;
    } else if (line.startsWith('@@')) {
      inHunk = true;
    } else if (!inHunk && line.startsWith('--- ')) {
      const source = line.slice(4);
      oldPath = source === '/dev/null' ? null : source.startsWith('a/') ? source.slice(2) : source;
    } else if (!inHunk && line.startsWith('+++ ')) {
      const target = line.slice(4);
      current =
        target === '/dev/null' ? oldPath : target.startsWith('b/') ? target.slice(2) : target;
      if (current && target !== '/dev/null' && !added.has(current)) added.set(current, []);
    } else if (current && line.startsWith('+')) {
      push(added, current, line.slice(1));
    } else if (current && line.startsWith('-')) {
      push(removed, current, line.slice(1));
    }
  }
  return { added, removed };
}

function parseScripts(json: string | null): Record<string, string> | undefined {
  if (json === null) return undefined;
  try {
    const scripts = (JSON.parse(json) as { scripts?: unknown }).scripts;
    if (!scripts || typeof scripts !== 'object') return undefined;
    return Object.fromEntries(
      Object.entries(scripts as Record<string, unknown>).map(([k, v]) => [k, String(v)])
    );
  } catch {
    return { '<unparseable package.json>': json.length.toString() };
  }
}

const ZERO_SHA = /^0+$/;
const GITLINK = '160000';

/**
 * Everything `assessRisk` needs for `base...head` (the changes since the merge base) in `repoDir`.
 * Throws when git fails (not a repo, unknown ref); the caller treats that as a blocker.
 */
export async function collectRiskInput(
  repoDir: string,
  base: string,
  head = 'HEAD'
): Promise<RiskInput> {
  const range = `${base}...${head}`;
  const [raw, numstat, patch] = await Promise.all([
    git(repoDir, ['diff', '--raw', '-z', '-M', '--no-abbrev', range]),
    git(repoDir, ['diff', '--numstat', '-z', '-M', range]),
    git(repoDir, ['diff', '-U0', '-M', '--no-color', '--no-ext-diff', range]),
  ]);
  const stats = parseNumstatZ(numstat);
  const { added, removed } = parseChangedLines(patch);
  let blobReads = 0;
  const readBlob = async (sha: string): Promise<string | null> => {
    if (ZERO_SHA.test(sha) || blobReads >= MAX_BLOB_READS) return null;
    blobReads++;
    try {
      return await git(repoDir, ['cat-file', 'blob', sha]);
    } catch {
      return null;
    }
  };

  const files: RiskFileChange[] = [];
  for (const entry of parseRawZ(raw)) {
    const stat = stats.get(entry.path) ?? { insertions: null, deletions: null };
    const submodule = entry.oldMode === GITLINK || entry.newMode === GITLINK;
    const binary = !submodule && stat.insertions === null;
    const file: RiskFileChange = {
      path: entry.path,
      status: entry.status,
      insertions: stat.insertions,
      deletions: stat.deletions,
    };
    if (entry.oldPath) file.oldPath = entry.oldPath;
    if (submodule) file.submodule = true;
    if (binary) {
      file.binary = true;
      if (!ZERO_SHA.test(entry.newSha)) {
        try {
          const size = await git(repoDir, ['cat-file', '-s', entry.newSha]);
          file.sizeBytes = Number(size.trim()) || 0;
        } catch {
          // Size unknown: the binary rule just does not fire.
        }
      }
    }
    const lines = added.get(entry.path);
    if (lines?.length) file.addedLines = lines;
    const gone = removed.get(entry.path);
    if (gone?.length) file.removedLines = gone;
    const deletions = stat.deletions ?? 0;
    if (
      !submodule &&
      !binary &&
      entry.status !== 'A' &&
      entry.status !== 'D' &&
      deletions > GUTTED_MIN_LINES * GUTTED_FRACTION
    ) {
      const before = await readBlob(entry.oldSha);
      if (before !== null)
        file.linesBefore = before.split('\n').length - (before.endsWith('\n') ? 1 : 0);
    }
    if (!submodule && path.posix.basename(entry.path) === 'package.json') {
      const [before, after] = await Promise.all([readBlob(entry.oldSha), readBlob(entry.newSha)]);
      file.packageScripts = { before: parseScripts(before), after: parseScripts(after) };
    }
    files.push(file);
  }
  return { files };
}
