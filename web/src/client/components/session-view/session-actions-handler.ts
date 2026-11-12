/**
 * SessionActionsHandler
 *
 * Handles all session-related actions including:
 * - Session renaming
 * - Session termination
 * - Session clearing
 * - View mode toggling (terminal vs worktree)
 */
import { HttpMethod, type Session } from '../../../shared/types.js';
import { t } from '../../i18n/index.js';
import { authClient } from '../../services/auth-client.js';
import { sessionActionService } from '../../services/session-action-service.js';
import { resumableAgent, resumeSession } from '../../utils/claude-resume.js';
import { confirmDialog } from '../../utils/confirm-dialog.js';
import { createLogger } from '../../utils/logger.js';
import { isAttachedTmuxSession, macWindowKillNote } from '../../utils/mac-sessions.js';
import { setSessionUserTitle } from '../../utils/session-actions.js';
import {
  canMoveToUntether,
  canShield,
  moveToUntether,
  shieldConfirmText,
  shieldSession,
} from '../../utils/shield.js';

const logger = createLogger('session-actions-handler');

export interface SessionActionsCallbacks {
  getSession: () => Session | null;
  setSession: (session: Session) => void;
  getViewMode: () => 'terminal' | 'worktree';
  setViewMode: (mode: 'terminal' | 'worktree') => void;
  dispatchEvent: (event: Event) => boolean;
  requestUpdate: () => void;
  handleBack: () => void;
  ensureTerminalInitialized: () => void;
}

export class SessionActionsHandler {
  private callbacks: SessionActionsCallbacks | null = null;

  setCallbacks(callbacks: SessionActionsCallbacks): void {
    this.callbacks = callbacks;
  }

  async handleTerminateSession(): Promise<void> {
    if (!this.callbacks) return;

    const session = this.callbacks.getSession();
    if (!session) return;
    // Ending a session is destructive, so it is always confirmed in the app's dialog (design
    // spec 4, 2026-10-12; it was window.confirm, and only for shielded and ut sessions). The body
    // says what else ends: a shielded session's program, kept alive across restarts, or a
    // session opened with ut, which ends in its Mac window too. Disconnecting from a tmux
    // session outside Untether ends nothing, so it is not asked.
    if (!isAttachedTmuxSession(session)) {
      const name = session.name || session.command.join(' ');
      const windowNote = macWindowKillNote(session);
      const body = session.shielded
        ? t('shield.killConfirm', { name })
        : windowNote
          ? `${t('sessions.row.killConfirm', { name })} ${windowNote}`
          : t('sessions.kill.confirmBody');
      const confirmed = await confirmDialog({
        title: t('session.terminate.confirmTitle'),
        body: session.shielded && windowNote ? `${body} ${windowNote}` : body,
        confirmLabel: t('menu.terminateSession'),
        tone: 'danger',
      });
      if (!confirmed) return;
    }

    await sessionActionService.terminateSession(session, {
      authClient: authClient,
      callbacks: {
        onError: (message: string) => {
          if (this.callbacks) {
            this.callbacks.dispatchEvent(
              new CustomEvent('error', {
                detail: message,
                bubbles: true,
                composed: true,
              })
            );
          }
        },
        onSuccess: () => {
          // Its status follows by v3 `EVENT`/polling. The app still hears it was ended here:
          // a disconnected tmux session leaves the list at once, which is no "not found".
          this.callbacks?.dispatchEvent(
            new CustomEvent('session-killed', {
              detail: { sessionId: session.id, session },
              bubbles: true,
              composed: true,
            })
          );
        },
      },
    });
  }

  /** Save the title the user gave the session, or null to go back to the agent's. */
  /** `showError: false` when the caller shows a failure itself (the inline rename field). */
  async handleSetUserTitle(
    sessionId: string,
    userTitle: string | null,
    { showError = true }: { showError?: boolean } = {}
  ): Promise<{ success: boolean; error?: string }> {
    // No longer the session on screen: nothing saved, nothing to say (as before).
    if (!this.callbacks) return { success: false };
    const session = this.callbacks.getSession();
    if (!session || sessionId !== session.id) return { success: false };

    const result = await setSessionUserTitle(sessionId, userTitle, authClient);
    if (result.success) {
      this.callbacks.setSession({ ...session, userTitle: userTitle ?? undefined });
      this.callbacks.dispatchEvent(
        new CustomEvent('session-renamed', {
          detail: { sessionId, userTitle },
          bubbles: true,
          composed: true,
        })
      );
    } else if (showError) {
      this.callbacks.dispatchEvent(
        new CustomEvent('error', {
          detail: t('toast.renameFailed', { error: String(result.error) }),
          bubbles: true,
          composed: true,
        })
      );
    }
    return result;
  }

  /** "Blindar": open the shielded version of this session and switch to it. */
  async handleShieldSession(): Promise<void> {
    if (!this.callbacks) return;
    const session = this.callbacks.getSession();
    // A `ut` session in a Mac window moves to Untether instead (2026-10-25).
    const moving = !!session && canMoveToUntether(session);
    if (!session || (!moving && !canShield(session))) return;
    const name =
      session.userTitle ||
      session.claudeTitle ||
      session.claudeStatus?.title ||
      session.name ||
      session.command.join(' ');
    const action = moving ? t('moveToUntether.action') : t('shield.shield');
    const confirmed = await confirmDialog({
      title: action,
      body: moving ? t('moveToUntether.confirm', { name }) : shieldConfirmText(session, name),
      confirmLabel: action,
    });
    if (!confirmed) return;
    try {
      const result = moving
        ? await moveToUntether(session.id, name, authClient.getAuthHeader())
        : await shieldSession(session.id, authClient.getAuthHeader());
      if (!result) return;
      this.callbacks.dispatchEvent(
        new CustomEvent('session-created', { detail: result, bubbles: true, composed: true })
      );
    } catch (error) {
      this.callbacks.dispatchEvent(
        new CustomEvent('error', {
          detail: t(moving ? 'moveToUntether.failed' : 'shield.failed', {
            error: error instanceof Error ? error.message : String(error),
          }),
          bubbles: true,
          composed: true,
        })
      );
    }
  }

  /**
   * Run a finished session again (the session header's exited chip, 2026-10-12): a Claude
   * conversation continues with `claude --resume`, a Codex thread with `codex resume`
   * (2026-11-10: it started a new, empty Codex), anything else runs its command again in the
   * same folder, as the list card's Reopen does. The app opens the new session.
   */
  async handleRestartSession(): Promise<void> {
    if (!this.callbacks) return;
    const session = this.callbacks.getSession();
    if (session?.status !== 'exited') return;
    // A second tap while the first is on its way made a second session (2026-10-20 audit).
    if (this.restarting) return;
    this.restarting = true;
    const { command, workingDir, name } = session;
    try {
      let sessionId: string | undefined;
      if (resumableAgent(session)) {
        const result = await resumeSession(session, authClient.getAuthHeader());
        sessionId = result.sessionId;
      } else {
        const response = await fetch('/api/sessions', {
          method: HttpMethod.POST,
          headers: { 'Content-Type': 'application/json', ...authClient.getAuthHeader() },
          body: JSON.stringify({ command, workingDir, name }),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        sessionId = (await response.json()).sessionId;
      }
      this.callbacks.dispatchEvent(
        new CustomEvent('session-created', { detail: { sessionId }, bubbles: true, composed: true })
      );
    } catch (error) {
      this.callbacks.dispatchEvent(
        new CustomEvent('error', {
          detail: `${t('newChat.failed')}: ${error}`,
          bubbles: true,
          composed: true,
        })
      );
    } finally {
      this.restarting = false;
    }
  }

  /** "Reopen" is on its way (handleRestartSession). */
  private restarting = false;

  async handleClearSession(): Promise<void> {
    if (!this.callbacks) return;

    const session = this.callbacks.getSession();
    if (!session) return;

    await sessionActionService.clearSession(session, {
      authClient: authClient,
      callbacks: {
        onError: (message: string) => {
          if (this.callbacks) {
            this.callbacks.dispatchEvent(
              new CustomEvent('error', {
                detail: message,
                bubbles: true,
                composed: true,
              })
            );
          }
        },
        onSuccess: () => {
          // The app drops it from the list now (2026-10-20 audit: the window 'session-action'
          // event had no listener, so the cleared session stayed listed until a poll).
          this.callbacks?.dispatchEvent(
            new CustomEvent('session-killed', {
              detail: { sessionId: session.id, session },
              bubbles: true,
              composed: true,
            })
          );
          this.callbacks?.handleBack();
        },
      },
    });
  }

  handleToggleViewMode(): void {
    if (!this.callbacks) return;

    const session = this.callbacks.getSession();
    if (!session?.gitRepoPath) return;

    const currentMode = this.callbacks.getViewMode();
    const newMode = currentMode === 'terminal' ? 'worktree' : 'terminal';
    this.callbacks.setViewMode(newMode);

    // Update managers for view mode change
    if (newMode === 'terminal') {
      // Re-initialize terminal when switching back
      requestAnimationFrame(() => {
        this.callbacks?.ensureTerminalInitialized();
      });
    }
  }

  handleSessionExit(sessionId: string, exitCode?: number): void {
    if (!this.callbacks) return;

    const session = this.callbacks.getSession();
    if (!session || sessionId !== session.id) return;

    logger.log('Session exit event received', { sessionId, exitCode });

    // Update session status to exited
    this.callbacks.setSession({ ...session, status: 'exited' });
    this.callbacks.requestUpdate();

    // Notify parent app that session status changed so it can refresh the session list
    this.callbacks.dispatchEvent(
      new CustomEvent('session-status-changed', {
        detail: {
          sessionId: session.id,
          newStatus: 'exited',
          exitCode: exitCode,
        },
        bubbles: true,
      })
    );

    // Check if this window should auto-close
    // Only attempt to close if we're on a session-specific URL
    const urlParams = new URLSearchParams(window.location.search);
    const sessionParam = urlParams.get('session');

    if (sessionParam === sessionId) {
      // This window was opened specifically for this session
      logger.log(`Session ${sessionId} exited, attempting to close window`);

      // Try to close the window
      // This will work for:
      // 1. Windows opened via window.open() from JavaScript
      // 2. Windows where the user has granted permission
      // It won't work for regular browser tabs, which is fine
      setTimeout(() => {
        try {
          window.close();

          // If window.close() didn't work (we're still here after 100ms),
          // show a message to the user
          setTimeout(() => {
            logger.log('Window close failed - likely opened as a regular tab');
          }, 100);
        } catch (e) {
          logger.warn('Failed to close window:', e);
        }
      }, 500); // Give user time to see the "exited" status
    }
  }
}
