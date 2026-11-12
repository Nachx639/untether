/**
 * «Nuevo proyecto» (2026-10-24): a project in one step from the phone or `ut project new`. A
 * folder named after the project is made in the parent folder the user picked, with git and a
 * first commit (services/project-create.ts). Shared by the server and the sheet, which shows
 * the folder the name gives before anything is made.
 */

export const NEW_PROJECT_NAME_MAX = 100;

/** Why a project could not be made; the app words each one in the user's language. */
export type NewProjectErrorCode =
  | 'bad-name'
  | 'bad-parent'
  | 'parent-missing'
  | 'inside-repo'
  | 'exists'
  | 'no-permission'
  | 'git-missing'
  | 'failed';

export const NEW_PROJECT_ERROR_CODES: readonly NewProjectErrorCode[] = [
  'bad-name',
  'bad-parent',
  'parent-missing',
  'inside-repo',
  'exists',
  'no-permission',
  'git-missing',
  'failed',
];

/** What POST /api/projects/new answers when it made one. */
export interface NewProjectResult {
  repoPath: string;
  name: string;
  /** The branch of the first commit: the one the user's git starts with (init.defaultBranch). */
  branch: string;
  commit: string;
  /** A goal was given: its orchestrator's start (or why it did not start). */
  orchestrator?:
    | { ok: true; sessionId: string; pending?: boolean }
    | { ok: false; message: string };
}

/**
 * The folder a project name gives: letters and digits of any script kept, everything else a
 * dash, lower case. Null when nothing usable is left, or when the name tries to be a path
 * ("../x", "a/b", "." …): a name is never a path.
 */
export function projectFolderName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > NEW_PROJECT_NAME_MAX) return null;
  if (/[/\\\0]/.test(trimmed) || /^\.+$/.test(trimmed) || trimmed.includes('..')) return null;
  const slug = trimmed
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}._-]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return slug && slug.length <= 80 ? slug : null;
}
