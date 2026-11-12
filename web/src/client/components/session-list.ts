/**
 * Session List Component
 *
 * Displays a grid of session cards and manages the session creation modal.
 * Handles session filtering (hide/show exited) and cleanup operations.
 *
 * @fires navigate-to-session - When a session is selected (detail: { sessionId: string })
 * @fires refresh - When session list needs refreshing
 * @fires error - When an error occurs (detail: string)
 * @fires session-created - When a new session is created (detail: { sessionId: string })
 * @fires create-modal-close - When create modal should close
 * @fires hide-exited-change - When hide exited state changes (detail: boolean)
 * @fires kill-all-sessions - When all sessions should be killed
 *
 * @listens session-killed - From session-card when a session is killed
 * @listens session-kill-error - From session-card when kill fails
 * @listens clean-exited-sessions - To trigger cleanup of exited sessions
 */
import { html, nothing } from 'lit';
import { customElement } from 'lit/decorators.js';
import { t } from '../i18n/index.js';
import { isFinishedSession, splitSuspended } from '../utils/session-suspend.js';
import { SessionListLifecycle } from './session-list/list-lifecycle.js';
import './ask-claude-box.js';
import './mac-session-row.js';
import './phone-session-row.js';
import './preview-row.js';
import './agent-mission.js';
import './notifications-banner.js';
import './session-list/compact-session-card.js';
import './session-list/repository-header.js';
import './done-section.js';
import './task-row.js';
import './shield-banner.js';

export { isPhoneListLayout } from './session-list/list-shared.js';

@customElement('session-list')
export class SessionList extends SessionListLifecycle {
  render() {
    // 2026-10-31: suspended sessions are paused, not finished, and have their own "Suspended
    // (n)" section: the live lists do not show them (they were mixed with the live ones).
    const { live: runningSessions, suspended } = splitSuspended(this.sessions);
    this.suspendedSessions = suspended;
    const exitedSessions = this.sessions.filter((session) => isFinishedSession(session));

    if (!this.usePhoneRows()) {
      return this.compactMode
        ? this.renderSidebar(runningSessions, exitedSessions)
        : this.renderDesktop(runningSessions, exitedSessions);
    }

    // An open task keeps the list up even before its session exists (preparing, scheduled).
    // Suspended sessions too: their section is under the live ones.
    const hasRunningSessions =
      runningSessions.length > 0 || suspended.length > 0 || this.liveTasks().length > 0;
    const hasExitedSessions = exitedSessions.length > 0;
    // The first list is on its way: tabs and Ask box now, skeleton rows after 150 ms.
    const firstLoad = this.loading && this.sessions.length === 0;
    // Nothing running: the hero (finished sessions stay below it, in their section). In the
    // sidebar opened from a session, a line.
    const phoneEmpty = !hasRunningSessions && !firstLoad && !this.compactMode;
    // A phone on its side: two columns, each scrolling on its own (renderPhoneRows). With
    // nothing running the page is short anyway and keeps one column.
    const twoColumns = this.shortLandscape.value && !this.compactMode && !phoneEmpty;

    let body: unknown;
    if (firstLoad) body = this.renderPhoneLoading(twoColumns);
    else if (phoneEmpty) body = this.renderPhoneEmpty(exitedSessions);
    else if (!hasRunningSessions && !(hasExitedSessions && !this.hideExited)) {
      body = html`<div class="text-text-muted text-center py-8">
        ${this.loading ? t('sessions.loading') : t('empty.title')}
      </div>`;
    } else body = this.renderPhoneRows(runningSessions, exitedSessions);

    return html`
      <div class="ut-phone-list font-ui text-text focus:outline-none" data-testid="session-list-container">
        <div class="${this.contentClasses(twoColumns)}">${body}</div>
        ${this.compactMode ? nothing : this.renderTabBar(phoneEmpty)}
      </div>
    `;
  }
}
