/**
 * Version control for a project folder without git, from the phone (2026-10-18: "+ Tarea" and
 * "Orquestar" on ~/Projects/tele-ambiente, a folder group of the home). Never automatic: the
 * sheet shows what the first commit would hold and the user taps "Activar".
 *
 *  1. preview (rules, instant): walks the folder (no .git, no ignored folder, at most
 *     GIT_INIT_MAX_FILES files), proposes .gitignore lines for what is actually there
 *     (node_modules/, caches, build output next to a manifest, *.log, .env*, keys, …; .DS_Store
 *     and .env always), asks git itself which files `git add -A` would then take (a throwaway
 *     git dir in the temp folder, the folder's own .gitignore files and the user's global
 *     excludes included) and flags the suspicious ones: big (> 5 MB), named like a key or
 *     credentials, or holding something that looks like a token (task-risk.ts patterns).
 *  2. review (AI, optional): Claude Haiku through the user's subscription (claude-oneshot.ts)
 *     gets the file list, the flags and the start of flagged/doubtful text files (token-looking
 *     values redacted) and answers per-file verdicts. No claude, no login, no answer in 60 s or
 *     nothing usable → { status: 'unavailable' }, and the sheet says so.
 *  3. init: merges the .gitignore (never drops a line; explicit lines for the files the user
 *     left out), `git init -b main`, `git add -A`, one commit "Untether: control de versiones"
 *     with the user's identity (a repo-local "Untether <untether@localhost>" when there is
 *     none). Touches nothing but .gitignore and .git; a failure puts both back as they were.
 *
 * Refused: a folder inside a repository, the home folder, anything not a folder under home.
 * Every git call is execFile with an argument array.
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  GIT_INIT_BIG_FILE_BYTES,
  GIT_INIT_MAX_FILES,
  type GitInitFlaggedFile,
  type GitInitFlagReason,
  type GitInitIgnorePattern,
  type GitInitPreview,
  type GitInitResult,
  type GitInitReview,
  type GitInitVerdict,
} from '../../shared/git-init.js';
import { clearGitInfoCacheUnder } from '../utils/git-info.js';
import { askForJson, extractJsonObject } from './ai-json-reply.js';
import { askClaudeOnce, type ClaudeOnceOptions } from './claude-oneshot.js';
import { SECRET_CONTENT, SECRET_FILE, SECRET_FILE_EXEMPT } from './task-risk.js';

export type GitInitErrorCode = 'bad-request' | 'conflict' | 'busy' | 'failed';

export class GitInitError extends Error {
  constructor(
    readonly code: GitInitErrorCode,
    message: string
  ) {
    super(message);
  }
}

export const GIT_INIT_COMMIT_MESSAGE = 'Untether: control de versiones';
export const GIT_INIT_FALLBACK_NAME = 'Untether';
export const GIT_INIT_FALLBACK_EMAIL = 'untether@localhost';
export const GIT_INIT_REVIEW_TIMEOUT_MS = 60_000;

const GIT_TIMEOUT_MS = 60_000;
const GIT_ADD_TIMEOUT_MS = 180_000;
const MAX_GIT_OUTPUT = 128 * 1024 * 1024;
/** Text files read for secret-looking content: size, count and total bytes caps. */
const SCAN_MAX_FILE_BYTES = 256 * 1024;
const SCAN_READ_BYTES = 64 * 1024;
const SCAN_MAX_FILES = 4000;
const SCAN_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
/** Start of a file shown to the AI review. */
const SNIPPET_BYTES = 2048;
const PREVIEW_TTL_MS = 10 * 60_000;
const MAX_EXCLUDES = 2000;

// ---------------------------------------------------------------------------------------------
// The .gitignore proposal
// ---------------------------------------------------------------------------------------------

/** Folders that are always tool output or caches, by name. */
const DIR_ALWAYS: readonly string[] = [
  'node_modules',
  '.cache',
  '__pycache__',
  '.venv',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.tox',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.parcel-cache',
  '.sass-cache',
  '.vercel',
  '.netlify',
  '.terraform',
  '.gradle',
  '.expo',
  '.angular',
  '.docusaurus',
  'DerivedData',
  'logs',
];
/** A sibling that makes dist/ build/ out/ coverage/ a project's output. */
const BUILD_MANIFEST =
  /^(package\.json|tsconfig[^/]*\.json|pyproject\.toml|setup\.py|setup\.cfg|Cargo\.toml|build\.gradle(\.kts)?|pom\.xml|CMakeLists\.txt|(GNU)?[Mm]akefile|(vite|webpack|rollup|next|nuxt|astro|svelte)\.config\.[cm]?[jt]s)$/;
const BUILD_DIRS = new Set(['dist', 'build', 'out']);
/** Source code: a folder named cache/ holding it is code, not a cache. */
const CODE_FILE =
  /\.([cm]?[jt]sx?|py|rb|go|rs|swift|kt|java|c|cc|cpp|h|hpp|m|mm|cs|php|vue|svelte)$/i;

/** File patterns, in .gitignore order, each with the names it covers. */
const FILE_RULES: ReadonlyArray<{ pattern: string; test: (name: string) => boolean }> = [
  { pattern: '.DS_Store', test: (name) => name === '.DS_Store' },
  { pattern: 'Thumbs.db', test: (name) => name === 'Thumbs.db' },
  { pattern: '*.log', test: (name) => /\.log$/i.test(name) },
  { pattern: '.env', test: (name) => name === '.env' },
  { pattern: '.env.*', test: (name) => /^\.env\../.test(name) && !SECRET_FILE_EXEMPT.test(name) },
  { pattern: '*.pem', test: (name) => /\.pem$/i.test(name) },
  { pattern: '*.key', test: (name) => /\.key$/i.test(name) },
  { pattern: '*.p12', test: (name) => /\.p12$/i.test(name) },
  { pattern: '*.pfx', test: (name) => /\.pfx$/i.test(name) },
  { pattern: '*.pyc', test: (name) => /\.pyc$/i.test(name) },
  { pattern: '*.tsbuildinfo', test: (name) => /\.tsbuildinfo$/i.test(name) },
  { pattern: '.eslintcache', test: (name) => name === '.eslintcache' },
  { pattern: '*.swp', test: (name) => /\.sw[po]$/i.test(name) },
];
/** Proposed even when nothing matches yet. */
const ALWAYS_PATTERNS = new Set(['.DS_Store', '.env', '.env.*']);

/**
 * The .gitignore line of a folder to leave out, or null. Folders that are always tool output
 * go by name ("node_modules/"); the ones judged by their surroundings (dist/ next to a
 * package.json, a cache/ without code) get a line of their own ("/web/dist/"), so another
 * folder with the same name elsewhere stays in.
 */
async function dirPattern(
  name: string,
  rel: string,
  abs: string,
  siblings: Set<string>
): Promise<string | null> {
  if (DIR_ALWAYS.includes(name)) return `${name}/`;
  const own = `${gitignorePathLine(rel)}/`;
  const hasManifest = [...siblings].some((sibling) => BUILD_MANIFEST.test(sibling));
  if (BUILD_DIRS.has(name)) return hasManifest ? own : null;
  if (name === 'target') return siblings.has('Cargo.toml') || siblings.has('pom.xml') ? own : null;
  const inside = async () => {
    try {
      return (await fs.promises.readdir(abs)).slice(0, 500);
    } catch {
      return [];
    }
  };
  if (name === 'venv') return (await inside()).includes('pyvenv.cfg') ? own : null;
  if (name === 'coverage') {
    if (hasManifest) return own;
    const names = await inside();
    return names.some((entry) => /^(lcov|coverage-final|clover)/.test(entry)) ? own : null;
  }
  if (name === 'cache') return (await inside()).some((entry) => CODE_FILE.test(entry)) ? null : own;
  return null;
}

/** Escapes a path for an anchored .gitignore line ("/a/b*.txt" → "/a/b\*.txt"). */
export function gitignorePathLine(rel: string): string {
  const escaped = rel
    .replace(/[\\*?[]/g, '\\$&')
    .replace(/ +$/, (spaces) => spaces.replace(/ /g, '\\ '));
  return `/${escaped}`;
}

interface WalkResult {
  /** Pattern → files and folders it covers. */
  matches: Map<string, number>;
  /** Repositories inside the folder ("/sub/repo/"): left out, git would add them as links. */
  nested: string[];
  capped: boolean;
}

/** The folder's tree, without descending into what the proposal leaves out. */
async function walk(root: string, maxFiles: number): Promise<WalkResult> {
  const matches = new Map<string, number>();
  const nested: string[] = [];
  const bump = (pattern: string) => matches.set(pattern, (matches.get(pattern) ?? 0) + 1);
  const stack = [''];
  let files = 0;
  while (stack.length) {
    const rel = stack.pop() as string;
    const abs = rel ? path.join(root, rel) : root;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    const names = new Set(entries.map((entry) => entry.name));
    for (const entry of entries) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name === '.git') continue;
        const dir = path.join(abs, entry.name);
        if (fs.existsSync(path.join(dir, '.git'))) {
          nested.push(`${gitignorePathLine(relPath)}/`);
          continue;
        }
        const pattern = await dirPattern(entry.name, relPath, dir, names);
        if (pattern) bump(pattern);
        else stack.push(relPath);
        continue;
      }
      files++;
      if (files > maxFiles) return { matches, nested, capped: true };
      const rule = FILE_RULES.find((candidate) => candidate.test(entry.name));
      if (rule) bump(rule.pattern);
      else if (/^\.env\../.test(entry.name)) bump(`!${entry.name}`); // .env.example stays in.
    }
  }
  return { matches, nested, capped: false };
}

/** The proposed lines: nested repos, folders (by name), files (FILE_RULES order), then `!` lines. */
function proposal(result: WalkResult): GitInitIgnorePattern[] {
  const out: GitInitIgnorePattern[] = result.nested.map((pattern) => ({ pattern, matches: 1 }));
  // By name first ("node_modules/"), then the anchored ones ("/web/dist/").
  const dirs = [...result.matches.keys()]
    .filter((pattern) => pattern.endsWith('/'))
    .sort((a, b) => Number(a.startsWith('/')) - Number(b.startsWith('/')) || a.localeCompare(b));
  for (const pattern of dirs) out.push({ pattern, matches: result.matches.get(pattern) ?? 0 });
  for (const { pattern } of FILE_RULES) {
    const matches = result.matches.get(pattern) ?? 0;
    if (matches || ALWAYS_PATTERNS.has(pattern)) out.push({ pattern, matches });
  }
  const keep = [...result.matches.keys()].filter((pattern) => pattern.startsWith('!')).sort();
  if (out.some((entry) => entry.pattern === '.env.*')) {
    for (const pattern of keep) out.push({ pattern, matches: result.matches.get(pattern) ?? 0 });
  }
  return out;
}

/**
 * The .gitignore after merging: every existing line kept as it is, then the missing proposed
 * lines and one anchored line per file the user left out. Null when nothing needs writing.
 */
export function mergeGitignore(
  existing: string | null,
  patterns: readonly string[],
  excludePaths: readonly string[]
): string | null {
  const have = new Set((existing ?? '').split(/\r?\n/).map((line) => line.trim()));
  const add: string[] = [];
  for (const line of [...patterns, ...excludePaths.map(gitignorePathLine)]) {
    if (!have.has(line)) {
      have.add(line);
      add.push(line);
    }
  }
  if (!add.length) return null;
  let out = existing ?? '';
  if (out && !out.endsWith('\n')) out += '\n';
  if (out.trim()) out += '\n';
  return `${out}# ${GIT_INIT_COMMIT_MESSAGE}\n${add.join('\n')}\n`;
}

// ---------------------------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------------------------

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

function git(cwd: string, args: string[], timeout = GIT_TIMEOUT_MS): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      {
        cwd,
        timeout,
        maxBuffer: MAX_GIT_OUTPUT,
        encoding: 'utf8',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1' },
      },
      (error, stdout, stderr) => {
        if (!error) return resolve({ code: 0, stdout, stderr });
        const err = error as NodeJS.ErrnoException & { code?: string | number; killed?: boolean };
        resolve({
          code: typeof err.code === 'number' ? err.code : 1,
          stdout: stdout ?? '',
          stderr: `${stderr || err.message}${err.killed ? ' (timed out)' : ''}`,
        });
      }
    );
  });
}

function must(result: GitResult, what: string): string {
  if (result.code !== 0) throw new GitInitError('failed', `${what}: ${result.stderr.trim()}`);
  return result.stdout;
}

/**
 * The files `git add -A` would take with these extra exclude lines: `ls-files --others` in a
 * throwaway git dir whose work tree is the folder (its .gitignore files and the user's global
 * excludes apply as they will for real).
 */
async function filesGitWouldAdd(
  folder: string,
  excludeLines: readonly string[]
): Promise<string[]> {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ut-git-init-'));
  try {
    const gitDir = path.join(tmp, 'probe.git');
    must(await git(tmp, ['init', '-q', '--bare', gitDir]), 'git init (probe)');
    const excludeFile = path.join(tmp, 'exclude');
    await fs.promises.writeFile(excludeFile, `${excludeLines.join('\n')}\n`);
    const out = must(
      await git(folder, [
        `--git-dir=${gitDir}`,
        `--work-tree=${folder}`,
        '-c',
        'core.bare=false',
        'ls-files',
        '-z',
        '--others',
        '--exclude-standard',
        `--exclude-from=${excludeFile}`,
      ]),
      'git ls-files'
    );
    return out.split('\0').filter((entry) => entry && !entry.endsWith('/'));
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------------------------

/** Names that say "secret" beyond task-risk's key and credentials files. */
const SECRET_NAME_EXTRA = /(^|\/)[^/]*secret[^/]*$/i;
/** Files the AI review sees the start of even without a flag (configs that may hold keys). */
const DOUBTFUL_FILE =
  /(^|\/)[^/]*(config|settings|secrets?|auth|keys?|token|passwords?)[^/]*\.(json|ya?ml|toml|ini|cfg|conf|txt|properties|plist|xml)$/i;

function secretName(rel: string): boolean {
  if (SECRET_FILE_EXEMPT.test(rel)) return false;
  return SECRET_FILE.test(rel) || SECRET_NAME_EXTRA.test(rel);
}

/** Token-looking values cut to their first 4 characters, for what leaves the Mac. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const { re } of SECRET_CONTENT) {
    out = out.replace(
      new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`),
      (m) => (m.length > 8 ? `${m.slice(0, 4)}…[redacted]` : m)
    );
  }
  return out;
}

async function readStart(file: string, bytes: number): Promise<Buffer | null> {
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export interface GitInitScan {
  preview: GitInitPreview;
  /** Every file that would go in, with its size (at most GIT_INIT_MAX_FILES). */
  entries: Array<{ path: string; size: number }>;
  /** Start of flagged and doubtful text files (redacted), for the AI review. */
  snippets: Map<string, string>;
}

async function scanFolder(folder: string, maxFiles: number): Promise<GitInitScan> {
  const walked = await walk(folder, maxFiles);
  const ignore = proposal(walked);
  const listed = await filesGitWouldAdd(
    folder,
    ignore.map((entry) => entry.pattern)
  );
  const capped = walked.capped || listed.length > maxFiles;
  const entries: Array<{ path: string; size: number }> = [];
  const flagged: GitInitFlaggedFile[] = [];
  const snippets = new Map<string, string>();
  let size = 0;
  let reads = 0;
  let readBytes = 0;
  for (const rel of listed.slice(0, maxFiles)) {
    const abs = path.join(folder, rel);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.lstat(abs);
    } catch {
      continue;
    }
    entries.push({ path: rel, size: stat.size });
    size += stat.size;
    const reasons: GitInitFlagReason[] = [];
    if (stat.size > GIT_INIT_BIG_FILE_BYTES) reasons.push({ kind: 'big' });
    if (secretName(rel)) reasons.push({ kind: 'secret-name' });
    const doubtful = DOUBTFUL_FILE.test(rel);
    let text: string | null = null;
    if (
      stat.isFile() &&
      stat.size <= SCAN_MAX_FILE_BYTES &&
      reads < SCAN_MAX_FILES &&
      readBytes < SCAN_MAX_TOTAL_BYTES
    ) {
      const start = await readStart(abs, SCAN_READ_BYTES);
      reads++;
      if (start && !start.includes(0)) {
        readBytes += start.length;
        text = start.toString('utf8');
        const secret = SECRET_CONTENT.find(({ re }) => re.test(text as string));
        if (secret) reasons.push({ kind: 'secret-content', detail: secret.name });
      }
    }
    if (text !== null && (reasons.length || doubtful)) {
      snippets.set(rel, redactSecrets(text.slice(0, SNIPPET_BYTES)));
    }
    if (reasons.length) {
      flagged.push({
        path: rel,
        size: stat.size,
        reasons,
        defaultExcluded: reasons.some((reason) => reason.kind !== 'big'),
      });
    }
  }
  const rank = (file: GitInitFlaggedFile) => (file.defaultExcluded ? 0 : 1);
  flagged.sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path));
  return {
    preview: {
      folder,
      files: entries.length,
      size,
      capped,
      ignore,
      flagged,
      hasGitignore: fs.existsSync(path.join(folder, '.gitignore')),
    },
    entries,
    snippets,
  };
}

// ---------------------------------------------------------------------------------------------
// The AI review
// ---------------------------------------------------------------------------------------------

export const REVIEW_SYSTEM_PROMPT = [
  "You check what goes into the first git commit of a user's project folder, before version",
  'control is turned on. You get the files that would be committed (path and size), the files',
  'the rules flagged and why, and the start of some text files (token-looking values are',
  'redacted). Point out files that should stay out of version control: secrets, credentials,',
  'private keys, personal data dumps, local databases, caches, build output, large generated',
  'or binary files, editor and OS junk. Give a verdict for every flagged file too ("include"',
  'when it is fine to commit). Do not list other files that are fine. Use the exact paths from',
  'the list. Answer with JSON only:',
  '{"summary": "<one short line>", "verdicts": [{"path": "<path>", "action": "exclude" | "include", "reason": "<short reason>"}]}',
].join(' ');

const LANGUAGES: Record<string, string> = {
  es: 'Spanish',
  en: 'English',
  fr: 'French',
  'pt-BR': 'Brazilian Portuguese',
  'zh-CN': 'Simplified Chinese',
  hi: 'Hindi',
  ar: 'Arabic',
  bn: 'Bengali',
};

const REVIEW_LIST_CHARS = 30_000;
const REVIEW_SNIPPET_CHARS = 24_000;

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function reasonText(reason: GitInitFlagReason): string {
  if (reason.kind === 'big') return 'bigger than 5 MB';
  if (reason.kind === 'secret-name') return 'named like a key or credentials file';
  return `content looks like a ${reason.detail}`;
}

/** The user message: flagged files, then doubtful ones, then the rest by size; then snippets. */
export function reviewQuestion(scan: GitInitScan, locale: string): string {
  const { preview, entries, snippets } = scan;
  const flagged = new Map(preview.flagged.map((file) => [file.path, file]));
  const lines = [
    `Folder: ${path.basename(preview.folder)}`,
    `Files that would be committed: ${preview.files} (${formatSize(preview.size)})${preview.capped ? ', the folder is bigger: partial list' : ''}`,
    `Left out by the proposed .gitignore: ${preview.ignore.map((entry) => entry.pattern).join(' ') || '(nothing)'}`,
    '',
    'Flagged by the rules:',
  ];
  if (!preview.flagged.length) lines.push('(none)');
  for (const file of preview.flagged) {
    lines.push(
      `- ${file.path} (${formatSize(file.size)}): ${file.reasons.map(reasonText).join('; ')}`
    );
  }
  lines.push('', 'Files:');
  const order = [...entries].sort((a, b) => {
    const rank = (entry: { path: string }) =>
      flagged.has(entry.path) ? 0 : snippets.has(entry.path) ? 1 : 2;
    return rank(a) - rank(b) || b.size - a.size;
  });
  let used = 0;
  let shown = 0;
  for (const entry of order) {
    const line = `- ${entry.path} (${formatSize(entry.size)})`;
    if (used + line.length > REVIEW_LIST_CHARS) break;
    lines.push(line);
    used += line.length + 1;
    shown++;
  }
  if (shown < order.length) lines.push(`… and ${order.length - shown} more files`);
  if (snippets.size) {
    lines.push('', 'Start of some text files:');
    let budget = REVIEW_SNIPPET_CHARS;
    for (const [file, text] of snippets) {
      if (budget <= 0) break;
      const body = text.slice(0, Math.min(SNIPPET_BYTES, budget));
      budget -= body.length;
      lines.push(`--- ${file}`, body, '---');
    }
  }
  lines.push('', `Write the summary and the reasons in ${LANGUAGES[locale] ?? 'Spanish'}.`);
  return lines.join('\n');
}

/** The verdicts in a reply (only paths that would go in), or null when it is not usable. */
export function parseReview(
  reply: string,
  knownPaths: ReadonlySet<string>
): { summary?: string; verdicts: GitInitVerdict[] } | null {
  const read = extractJsonObject(reply, (value) => acceptReview(value, knownPaths));
  return read.ok ? read.value : null;
}

function acceptReview(
  value: unknown,
  knownPaths: ReadonlySet<string>
): { summary?: string; verdicts: GitInitVerdict[] } | null {
  if (!value || typeof value !== 'object') return null;
  const { summary, verdicts } = value as { summary?: unknown; verdicts?: unknown };
  if (!Array.isArray(verdicts)) return null;
  const seen = new Set<string>();
  const out: GitInitVerdict[] = [];
  for (const item of verdicts.slice(0, 500)) {
    if (!item || typeof item !== 'object') continue;
    const { path: file, action, reason } = item as Record<string, unknown>;
    if (typeof file !== 'string' || !knownPaths.has(file) || seen.has(file)) continue;
    if (action !== 'exclude' && action !== 'include') continue;
    seen.add(file);
    out.push({
      path: file,
      action,
      reason: typeof reason === 'string' ? reason.trim().slice(0, 240) : '',
    });
    if (out.length >= 200) break;
  }
  const line = typeof summary === 'string' ? summary.trim().slice(0, 300) : '';
  return line ? { summary: line, verdicts: out } : { verdicts: out };
}

export type GitInitReviewer = (scan: GitInitScan, locale: string) => Promise<GitInitReview>;

export function createGitInitReviewer(
  options: Partial<ClaudeOnceOptions> & { replyDir?: string } = {}
): GitInitReviewer {
  const { replyDir, ...claude } = options;
  return async (scan, locale) => {
    if (!scan.entries.length) return { status: 'done', verdicts: [] };
    const knownPaths = new Set(scan.entries.map((entry) => entry.path));
    const read = await askForJson({
      ask: (question) =>
        askClaudeOnce(
          { timeoutMs: GIT_INIT_REVIEW_TIMEOUT_MS, purpose: 'git-init review', ...claude },
          REVIEW_SYSTEM_PROMPT,
          question
        ),
      question: reviewQuestion(scan, locale),
      accept: (value) => acceptReview(value, knownPaths),
      label: 'git-init-review',
      shorterHint: 'give a verdict only for the flagged files, with reasons of a few words.',
      replyDir,
    });
    return read.ok ? { status: 'done', ...read.value } : { status: 'unavailable', verdicts: [] };
  };
}

// ---------------------------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------------------------

export interface GitInitServiceOptions {
  /** The home folder (default os.homedir()). */
  home?: string;
  reviewer?: GitInitReviewer;
  /** Files the scan checks before refusing (default GIT_INIT_MAX_FILES; tests use fewer). */
  maxFiles?: number;
}

/** A folder that may become a repository: its real path, or why not. */
export async function checkGitInitFolder(folder: unknown, home: string): Promise<string> {
  if (typeof folder !== 'string' || !folder || folder.includes('\0') || !path.isAbsolute(folder)) {
    throw new GitInitError('bad-request', 'An absolute folder path is required');
  }
  let real: string;
  let realHome: string;
  try {
    real = await fs.promises.realpath(folder);
    realHome = await fs.promises.realpath(home);
  } catch {
    throw new GitInitError('bad-request', 'The folder does not exist');
  }
  const stat = await fs.promises.stat(real).catch(() => null);
  if (!stat?.isDirectory()) throw new GitInitError('bad-request', 'Not a folder');
  const rel = path.relative(realHome, real);
  if (!rel) throw new GitInitError('bad-request', 'The home folder itself cannot be a repository');
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new GitInitError('bad-request', 'Only folders under the home folder');
  }
  for (let dir = real; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) {
      throw new GitInitError('conflict', `Already inside a git repository (${dir})`);
    }
    if (path.dirname(dir) === dir) break;
  }
  const inside = await git(real, ['rev-parse', '--is-inside-work-tree'], 15_000);
  if (inside.code === 0 && inside.stdout.trim() === 'true') {
    throw new GitInitError('conflict', 'Already inside a git repository');
  }
  return real;
}

/** Relative paths the user left out: inside the folder, no `..`, no .git. */
function checkExcludes(real: string, exclude: unknown): string[] {
  if (exclude === undefined) return [];
  if (!Array.isArray(exclude) || exclude.length > MAX_EXCLUDES) {
    throw new GitInitError('bad-request', 'exclude must be a list of paths');
  }
  const out = new Set<string>();
  for (const item of exclude) {
    if (typeof item !== 'string' || !item || item.includes('\0') || item.length > 4096) {
      throw new GitInitError('bad-request', 'Invalid path in exclude');
    }
    const parts = item.split('/');
    if (
      item.startsWith('/') ||
      item.includes('\\') ||
      parts.some((part) => !part || part === '.' || part === '..' || part === '.git')
    ) {
      throw new GitInitError('bad-request', `Invalid path in exclude: ${item}`);
    }
    const abs = path.resolve(real, item);
    if (!abs.startsWith(`${real}${path.sep}`)) {
      throw new GitInitError('bad-request', `Invalid path in exclude: ${item}`);
    }
    out.add(item);
  }
  return [...out];
}

export function createGitInit(options: GitInitServiceOptions = {}) {
  const home = options.home ?? os.homedir();
  const reviewer = options.reviewer ?? createGitInitReviewer();
  const maxFiles = options.maxFiles ?? GIT_INIT_MAX_FILES;
  const scans = new Map<string, { at: number; scan: GitInitScan }>();
  const busy = new Set<string>();

  const scan = async (real: string): Promise<GitInitScan> => {
    const result = await scanFolder(real, maxFiles);
    scans.set(real, { at: Date.now(), scan: result });
    for (const [key, entry] of scans) {
      if (Date.now() - entry.at > PREVIEW_TTL_MS) scans.delete(key);
    }
    return result;
  };

  return {
    async preview(folder: unknown): Promise<GitInitPreview> {
      const real = await checkGitInitFolder(folder, home);
      return (await scan(real)).preview;
    },

    /** The AI's verdicts on the last preview of the folder (scanned again when stale). */
    async review(folder: unknown, locale = 'es'): Promise<GitInitReview> {
      const real = await checkGitInitFolder(folder, home);
      const cached = scans.get(real);
      const current =
        cached && Date.now() - cached.at < PREVIEW_TTL_MS ? cached.scan : await scan(real);
      try {
        return await reviewer(current, locale);
      } catch {
        return { status: 'unavailable', verdicts: [] };
      }
    },

    async init(folder: unknown, exclude?: unknown): Promise<GitInitResult> {
      const real = await checkGitInitFolder(folder, home);
      const excludes = checkExcludes(real, exclude);
      if (busy.has(real)) throw new GitInitError('busy', 'Already being turned into a repository');
      busy.add(real);
      try {
        const result = await initFolder(real, excludes, maxFiles);
        // Sessions name the folder as they were started (maybe not its real path).
        if (typeof folder === 'string') clearGitInfoCacheUnder(path.resolve(folder));
        return result;
      } finally {
        busy.delete(real);
        scans.delete(real);
      }
    },
  };
}

export type GitInit = ReturnType<typeof createGitInit>;

/** The folder is bigger than what the preview can check: never committed unseen. */
function tooManyFiles(maxFiles: number): GitInitError {
  return new GitInitError(
    'bad-request',
    `The folder has more than ${maxFiles} files to check: add a .gitignore for its big folders (or turn on git by hand) first`
  );
}

async function initFolder(
  real: string,
  excludes: string[],
  maxFiles: number
): Promise<GitInitResult> {
  const gitignore = path.join(real, '.gitignore');
  const gitDir = path.join(real, '.git');
  const stat = await fs.promises.lstat(gitignore).catch(() => null);
  if (stat && !stat.isFile()) {
    throw new GitInitError('bad-request', '.gitignore is not a regular file');
  }
  const original = stat ? await fs.promises.readFile(gitignore, 'utf8') : null;
  const walked = await walk(real, maxFiles);
  // 2026-10-20: a scan stopped at the file limit went ahead, so folders it never looked at
  // (their caches, keys, build output) went into the first commit unproposed and unflagged.
  if (walked.capped) throw tooManyFiles(maxFiles);
  const merged = mergeGitignore(
    original,
    proposal(walked).map((entry) => entry.pattern),
    excludes
  );

  const restore = async () => {
    await fs.promises.rm(gitDir, { recursive: true, force: true }).catch(() => {});
    if (merged === null) return;
    if (original === null) await fs.promises.rm(gitignore, { force: true }).catch(() => {});
    else await fs.promises.writeFile(gitignore, original).catch(() => {});
  };

  try {
    if (merged !== null) await fs.promises.writeFile(gitignore, merged);
    const init = await git(real, ['init', '-q', '-b', 'main']);
    if (init.code !== 0) {
      // git < 2.28 has no -b.
      must(await git(real, ['init', '-q']), 'git init');
      must(await git(real, ['symbolic-ref', 'HEAD', 'refs/heads/main']), 'git symbolic-ref');
    }
    const name = await git(real, ['config', 'user.name']);
    const email = await git(real, ['config', 'user.email']);
    if (name.code !== 0 || !name.stdout.trim() || email.code !== 0 || !email.stdout.trim()) {
      must(await git(real, ['config', 'user.name', GIT_INIT_FALLBACK_NAME]), 'git config');
      must(await git(real, ['config', 'user.email', GIT_INIT_FALLBACK_EMAIL]), 'git config');
    }
    must(await git(real, ['add', '-A'], GIT_ADD_TIMEOUT_MS), 'git add');
    // What git takes can be more than the walk counted (files of skipped folders the
    // .gitignore lets in): past the limit, nothing is committed either.
    const staged = must(await git(real, ['ls-files', '-z']), 'git ls-files')
      .split('\0')
      .filter(Boolean).length;
    if (staged > maxFiles) throw tooManyFiles(maxFiles);
    // A negation in an existing .gitignore could bring a left-out file back: never commit it.
    for (let i = 0; i < excludes.length; i += 200) {
      const chunk = excludes.slice(i, i + 200).map((file) => `:(literal)${file}`);
      must(
        await git(real, ['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', ...chunk]),
        'git rm --cached'
      );
    }
    must(
      await git(
        real,
        ['commit', '-q', '--allow-empty', '-m', GIT_INIT_COMMIT_MESSAGE],
        GIT_ADD_TIMEOUT_MS
      ),
      'git commit'
    );
    const commit = must(await git(real, ['rev-parse', 'HEAD']), 'git rev-parse').trim();
    const files = must(await git(real, ['ls-files', '-z']), 'git ls-files')
      .split('\0')
      .filter(Boolean).length;
    clearGitInfoCacheUnder(real);
    return { repoPath: real, commit, files };
  } catch (error) {
    await restore();
    if (error instanceof GitInitError) throw error;
    throw new GitInitError('failed', error instanceof Error ? error.message : String(error));
  }
}
