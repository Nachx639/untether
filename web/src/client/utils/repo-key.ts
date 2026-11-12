/** Which repo a session belongs to, compared the way git and macOS report repo paths. */
import type { Session } from '../../shared/types.js';

/** A repo path compared as git and macOS may report it (/private/var = /var, no trailing /). */
export function normalizeRepoPath(path: string): string {
  return path.replace(/^\/private(?=\/)/, '').replace(/\/+$/, '');
}

/**
 * The repo family a session belongs to: its main worktree, else its repo; for a session
 * started outside git, that of the folder its agent works in now; else null.
 *
 * 2026-10-25: juego-de-cartas's orchestrator ran `cd ~/Projects/tele-ambiente` to read a file
 * and showed under tele-ambiente, without its own group. Where its agent goes only places a
 * session that has no repository of its own.
 */
export function sessionRepoKey(
  session: Pick<Session, 'gitMainRepoPath' | 'gitRepoPath'> &
    Partial<Pick<Session, 'workDir' | 'workRepoPath'>>
): string | null {
  const own =
    (typeof session.gitMainRepoPath === 'string' && session.gitMainRepoPath) ||
    (typeof session.gitRepoPath === 'string' && session.gitRepoPath) ||
    '';
  if (own) return normalizeRepoPath(own);
  if (session.workDir && typeof session.workRepoPath === 'string' && session.workRepoPath) {
    return normalizeRepoPath(session.workRepoPath);
  }
  return null;
}
