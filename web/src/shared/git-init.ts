/**
 * Turning a project folder without git into a repository from the phone (2026-10-18): what
 * the first commit would hold (POST /api/projects/git-init/preview, rules only, instant), a
 * second opinion from Claude Haiku (POST …/git-init/review, may be unavailable) and the init
 * itself (POST /api/projects/git-init). Shared by the server and the sheet.
 */

/** Files above this size are flagged (they still go in by default). */
export const GIT_INIT_BIG_FILE_BYTES = 5 * 1024 * 1024;
/** The walk stops after this many files; the preview then says it is partial. */
export const GIT_INIT_MAX_FILES = 20_000;

/** Why a file that would go in looks suspicious. */
export type GitInitFlagReason =
  | { kind: 'big' }
  | { kind: 'secret-name' }
  /** `detail`: what it looks like (e.g. "AWS access key"). */
  | { kind: 'secret-content'; detail: string };

export interface GitInitFlaggedFile {
  /** Relative to the folder, with `/`. */
  path: string;
  size: number;
  reasons: GitInitFlagReason[];
  /** Left out unless the user ticks it (a secret by the rules). */
  defaultExcluded: boolean;
}

export interface GitInitIgnorePattern {
  /** The .gitignore line. */
  pattern: string;
  /** Files and folders in the folder it leaves out (0: added just in case, e.g. .env). */
  matches: number;
}

export interface GitInitPreview {
  /** The folder (real path). */
  folder: string;
  /** Files the first commit would hold, and their total size in bytes. */
  files: number;
  size: number;
  /** The folder has more than GIT_INIT_MAX_FILES files: counts and flags are partial. */
  capped: boolean;
  /** Lines the .gitignore gets (only what matches something, plus .DS_Store/.env). */
  ignore: GitInitIgnorePattern[];
  flagged: GitInitFlaggedFile[];
  /** The folder already has a .gitignore (merged, never replaced). */
  hasGitignore: boolean;
}

export interface GitInitVerdict {
  path: string;
  action: 'exclude' | 'include';
  reason: string;
}

export interface GitInitReview {
  /** 'unavailable': no claude, no login, no answer in time or no usable answer. */
  status: 'done' | 'unavailable';
  summary?: string;
  verdicts: GitInitVerdict[];
}

export interface GitInitResult {
  repoPath: string;
  commit: string;
  files: number;
}
