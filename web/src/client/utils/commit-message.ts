/**
 * Commit messages drafted from the list of changed files, without calling a model: a
 * conventional-commit type guessed from the paths, a scope when the files share a folder,
 * and the files in the body. The user always edits it before committing.
 *
 * `CommitMessageProvider` is the hook for a smarter generator later (an LLM given the diff):
 * whatever it is must not type into the user's session, so it is a separate call.
 */

export interface CommitFile {
  path: string;
  oldPath?: string;
  status: string; // M A D R T ??
}

export type CommitMessageProvider = (files: CommitFile[]) => Promise<string> | string;

const DOC =
  /(^|\/)(docs?|documentation)\/|\.(md|mdx|rst|txt|adoc)$|(^|\/)(README|CHANGELOG|LICENSE)[^/]*$/i;
const TEST = /(^|\/)(__tests__|tests?|spec|e2e)\/|\.(test|spec)\.[a-z0-9]+$|_test\.(go|py)$/i;
const CI = /(^|\/)\.(github|gitlab|circleci)\/|(^|\/)\.gitlab-ci\.yml$|(^|\/)Jenkinsfile$/;
const BUILD =
  /(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.(toml|lock)|go\.(mod|sum)|Gemfile(\.lock)?|requirements[^/]*\.txt|pyproject\.toml|Podfile(\.lock)?|Package\.(swift|resolved)|Dockerfile|Makefile)$|(^|\/)[^/]*\.config\.[cm]?[jt]s$|(^|\/)tsconfig[^/]*\.json$/;
const STYLE = /\.(css|scss|sass|less)$/i;

function guessType(files: CommitFile[]): string {
  const paths = files.map((f) => f.path);
  const all = (re: RegExp) => paths.every((p) => re.test(p));
  if (all(DOC)) return 'docs';
  if (all(TEST)) return 'test';
  if (all(CI)) return 'ci';
  if (all(BUILD)) return 'build';
  if (all(STYLE)) return 'style';
  const added = files.some((f) => (f.status === 'A' || f.status === '??') && !TEST.test(f.path));
  if (added) return 'feat';
  if (files.every((f) => f.status === 'D')) return 'chore';
  if (files.every((f) => f.status === 'R')) return 'refactor';
  return 'fix';
}

const GENERIC_DIRS = new Set(['src', 'lib', 'app', 'apps', 'packages', 'pkg', 'internal', 'cmd']);

/** The deepest meaningful folder shared by every file, as a short scope ("server", "web"). */
function guessScope(files: CommitFile[]): string {
  const dirs = files.map((f) => f.path.split('/').slice(0, -1));
  if (dirs.some((d) => d.length === 0)) return '';
  const common: string[] = [];
  for (let i = 0; i < dirs[0].length; i++) {
    const seg = dirs[0][i];
    if (dirs.every((d) => d[i] === seg)) common.push(seg);
    else break;
  }
  const meaningful = common.filter((s) => !GENERIC_DIRS.has(s) && !s.startsWith('.'));
  const scope = meaningful[meaningful.length - 1] ?? '';
  return /^[A-Za-z0-9._-]{1,30}$/.test(scope) ? scope : '';
}

const VERB: Record<string, string> = {
  A: 'add',
  '??': 'add',
  D: 'remove',
  R: 'rename',
  M: 'update',
  T: 'update',
};

function baseName(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1);
}

function subjectFor(files: CommitFile[]): string {
  if (files.length === 1) {
    const f = files[0];
    if (f.status === 'R' && f.oldPath)
      return `rename ${baseName(f.oldPath)} to ${baseName(f.path)}`;
    return `${VERB[f.status] ?? 'update'} ${baseName(f.path)}`;
  }
  const verbs = new Set(files.map((f) => VERB[f.status] ?? 'update'));
  const verb = verbs.size === 1 ? [...verbs][0] : 'update';
  if (files.length <= 3) return `${verb} ${files.map((f) => baseName(f.path)).join(', ')}`;
  return `${verb} ${files.length} files`;
}

const STATUS_WORD: Record<string, string> = {
  A: 'added',
  '??': 'added',
  D: 'deleted',
  R: 'renamed',
  M: 'modified',
  T: 'modified',
};

/** Deterministic message: "type(scope): subject", a blank line, then one line per file. */
export function generateCommitMessage(files: CommitFile[]): string {
  if (files.length === 0) return '';
  const type = guessType(files);
  const scope = guessScope(files);
  const header = `${type}${scope ? `(${scope})` : ''}: ${subjectFor(files)}`;
  if (files.length === 1) return header;
  const body = files
    .slice(0, 30)
    .map((f) =>
      f.status === 'R' && f.oldPath
        ? `- ${f.oldPath} → ${f.path} (renamed)`
        : `- ${f.path} (${STATUS_WORD[f.status] ?? 'modified'})`
    );
  if (files.length > 30) body.push(`- … and ${files.length - 30} more`);
  return `${header}\n\n${body.join('\n')}`;
}

/** The generator the commit sheet uses; swap in an LLM-backed one here later. */
export const defaultCommitMessageProvider: CommitMessageProvider = generateCommitMessage;
