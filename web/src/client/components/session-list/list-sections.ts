/**
 * Session list: rows, cards and the sections shared by phone and desktop layouts
 * (suspended, exited, finished, done).
 */
import { html, nothing } from 'lit';
import { state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import type { TaskRecord } from '../../../shared/tasks.js';
import type { Session } from '../../../shared/types.js';
import { t } from '../../i18n/index.js';
import { isClaudeWorking } from '../../utils/claude-activity.js';
import { loadPinned, pinnedFirst, setPinned } from '../../utils/pinned-sessions.js';
import { type GroupMenu, groupMenuOf, groupSessionsByRepo } from '../../utils/project-groups.js';
import { lastActivityAt } from '../../utils/session-status.js';
import { suspendedGroups } from '../../utils/session-suspend.js';
import { isUnread } from '../../utils/unread-tracker.js';
import { icon } from '../icons.js';
import { renderSectionHead } from '../section-head.js';
import { sessionDisplayName } from '../session-card.js';
import { SessionListRepos } from './list-repos.js';
import { readListPref, writeListPref } from './list-shared.js';

export abstract class SessionListSections extends SessionListRepos {
  /** The card that Tab reaches: the last one focused if still shown, else the first. */
  protected tabStopId(sessions: Session[]): string | undefined {
    return sessions.some((s) => s.id === this.focusId)
      ? (this.focusId ?? undefined)
      : sessions[0]?.id;
  }

  /** groupMenu() of the render under way (sessions change in place between polls). */
  private groupMenuMemo: GroupMenu | null = null;

  protected willUpdate(changed: Map<PropertyKey, unknown>) {
    this.groupMenuMemo = null;
    super.willUpdate(changed);
  }

  /**
   * The home's groups and where each live session is, for the rows' "Anclar a este grupo" and
   * "Mover a…" (2026-11-04): the board of every live session, once per render.
   */
  protected groupMenu(): GroupMenu {
    if (this.groupMenuMemo) return this.groupMenuMemo;
    const live = this.sessions.filter((session) => session.status !== 'exited');
    this.groupMenuMemo = groupMenuOf(this.projectBoard(live, '', false), (key) =>
      this.getRepoName(key)
    );
    return this.groupMenuMemo;
  }

  /** A session anchored to a group or let go: regroup now (the next poll confirms it). */
  protected handleGroupPinned = (
    e: CustomEvent<{ sessionId: string; groupPin: Session['groupPin'] | null }>
  ) => {
    const { sessionId, groupPin } = e.detail;
    this.sessions = this.sessions.map((session) => {
      if (session.id !== sessionId) return session;
      const next = { ...session };
      if (groupPin) next.groupPin = groupPin;
      else delete next.groupPin;
      return next;
    });
    this.requestUpdate();
  };

  /**
   * One sidebar row (compact-session-card), the only place they are mounted so every one of them
   * (live, suspended, finished) has the group menu and regroups at once (2026-11-07).
   */
  protected renderCompactCard(
    session: Session,
    options: {
      orchestrator?: boolean;
      projectIcon?: string | null;
      sessionNumber?: number;
      /** In a group of the sidebar: it can be dragged to another (list-drag.ts). */
      draggable?: boolean;
    } = {}
  ) {
    return html`<compact-session-card
      data-drag-session=${options.draggable ? session.id : nothing}
      data-drag-label=${options.draggable ? sessionDisplayName(session) : nothing}
      .session=${session}
      .groupMenu=${this.groupMenu()}
      .orchestrator=${options.orchestrator ?? false}
      .projectIcon=${options.projectIcon ?? null}
      .authClient=${this.authClient}
      .selected=${session.id === this.selectedSessionId}
      .sessionNumber=${options.sessionNumber}
      @session-select=${this.handleSessionSelect}
      @session-delete=${this.handleSessionKilled}
      @session-cleanup=${this.handleSessionKilled}
      @session-kill-error=${this.handleSessionKillError}
      @session-group-pinned=${this.handleGroupPinned}
    ></compact-session-card>`;
  }

  protected renderCard(session: Session, tabStop: string | undefined, draggable = false) {
    return html`<session-card
      data-drag-session=${draggable ? session.id : nothing}
      data-drag-label=${draggable ? sessionDisplayName(session) : nothing}
      data-drag-axis=${draggable && this.listView !== 'list' ? 'x' : nothing}
      .session=${session}
      .groupMenu=${this.groupMenu()}
      .orchestrator=${this.orchestratorSessionIds().has(session.id)}
      .projectIcon=${this.orchestratorIconFor(session.id)}
      .authClient=${this.authClient}
      .selected=${session.id === this.selectedSessionId}
      .layout=${this.listView === 'list' ? 'row' : 'card'}
      .tabStop=${session.id === tabStop}
      @session-select=${this.handleSessionSelect}
      @session-killed=${this.handleSessionKilled}
      @session-kill-error=${this.handleSessionKillError}
      @session-renamed=${this.handleSessionRenamed}
      @session-rename-error=${this.handleSessionRenameError}
      @session-group-pinned=${this.handleGroupPinned}
      @focusin=${() => {
        this.focusId = session.id;
      }}
    ></session-card>`;
  }

  /** Suspended sessions, set by render() (the live lists leave them out). */
  protected suspendedSessions: Session[] = [];
  /** The "Suspended" section open (remembered per browser); closed by default. */
  @state() protected suspendedOpen =
    readListPref('suspended', ['open', 'closed'] as const, 'closed') === 'open';

  protected toggleSuspended() {
    this.suspendedOpen = !this.suspendedOpen;
    writeListPref('suspended', this.suspendedOpen ? 'open' : 'closed');
  }

  /**
   * "Suspended (n)" (2026-10-31, user request: a section of their own for suspended sessions, apart
   * from the rest): its own section under the live sessions, in the phone list,
   * the sidebar and the desktop home, grouped by project (a paused orchestrator in its own),
   * each with its title and since when it is paused. A tap wakes it and opens it, as before.
   * Closed by default; a search opens it.
   */
  protected renderSuspendedSection(layout: 'phone' | 'sidebar' | 'card', query = '') {
    const sessions = this.suspendedSessions.filter((session) => this.matchesQuery(session, query));
    if (!sessions.length) return nothing;
    const searching = Boolean(query.trim());
    const open = this.suspendedOpen || searching;
    const groups = suspendedGroups(
      groupSessionsByRepo(sessions, this.repoWorktrees, this.taskBoard.orchestrators)
    );
    const label = t('suspend.section', { n: sessions.length });
    const groupHead = (key: string | null, count: number) =>
      html`<div class="ut-repo-head ut-repo-head--compact" data-testid="suspended-group">
        <span class="ut-section-label">${key ? this.getRepoName(key) : t('sessions.group.noRepo')}</span>
        ${count > 1 ? html`<span class="ut-repo-count">${count}</span>` : nothing}
      </div>`;
    const rows = (group: { key: string | null; sessions: Session[] }) => {
      if (layout === 'phone') {
        return html`<div class="psr-list">
          ${repeat(
            group.sessions,
            (session) => session.id,
            (session) => this.renderPhoneRow(session)
          )}
        </div>`;
      }
      if (layout === 'sidebar') {
        return repeat(
          group.sessions,
          (session) => session.id,
          (session) =>
            this.renderCompactCard(session, {
              projectIcon: this.orchestratorIconFor(session.id),
            })
        );
      }
      return html`<div class=${this.listView === 'list' ? 'ut-rows' : 'session-flex-responsive'}>
        ${repeat(
          group.sessions,
          (session) => session.id,
          (session) => this.renderCard(session, undefined)
        )}
      </div>`;
    };
    const body = open
      ? html`<div id="suspended-rows" data-testid="suspended-rows">
          ${groups.map((group) => html`${groupHead(group.key, group.sessions.length)}${rows(group)}`)}
        </div>`
      : html`<div id="suspended-rows" data-testid="suspended-rows" hidden></div>`;
    const toggle = (className: string, content: unknown) =>
      html`<button
        type="button"
        class=${className}
        id="show-suspended-toggle"
        data-testid="suspended-section-toggle"
        aria-expanded=${open ? 'true' : 'false'}
        aria-controls="suspended-rows"
        ?disabled=${searching}
        @click=${() => this.toggleSuspended()}
      >
        ${content}
      </button>`;
    if (layout === 'phone') {
      return html`<div class="ut-phone-section" data-testid="suspended-section">
          ${toggle(
            'ut-phone-disclosure',
            html`<span class="ut-phone-eyebrow">${label}</span>${icon('chevronRight', 14)}`
          )}
        </div>
        ${body}`;
    }
    if (layout === 'sidebar') {
      return html`<div class="ut-side-group" data-testid="suspended-section">
        ${toggle(
          'ut-repo-head ut-repo-head--compact ut-side-disclosure',
          html`${icon('chevronRight', 12)}<span class="ut-section-label">${label}</span>`
        )}
        ${body}
      </div>`;
    }
    return html`<section class="ut-section" data-testid="suspended-section">
      ${renderSectionHead({
        label,
        open,
        toggle: () => this.toggleSuspended(),
        testid: 'suspended-section-toggle',
        id: 'show-suspended-toggle',
        controls: 'suspended-rows',
        disabled: searching,
      })}
      ${body}
    </section>`;
  }

  protected renderExitedSection(sessions: Session[], total: number, tabStopHere = false) {
    const open = !this.hideExited;
    const sorted = [...sessions].sort(
      (a, b) => (lastActivityAt(b) ?? 0) - (lastActivityAt(a) ?? 0)
    );
    const tabStop = tabStopHere ? sorted[0]?.id : undefined;
    return html`<section class="ut-section" data-testid="exited-section">
      ${renderSectionHead({
        label: t('sessions.exitedSection', { n: String(total) }),
        open,
        toggle: () => this.dispatchEvent(new CustomEvent('hide-exited-change', { detail: open })),
        testid: 'exited-section-toggle',
        id: 'show-exited-toggle',
        actions: open
          ? html`<button
              type="button"
              class="ut-btn ut-btn--ghost ut-btn--sm"
              id="clean-exited-button"
              data-testid="clean-exited-button"
              ?disabled=${this.cleaningExited}
              @click=${this.confirmClearFinished}
            >
              ${this.cleaningExited ? t('sessions.cleaning') : t('sessions.clearExited')}
            </button>`
          : nothing,
      })}
      ${
        open
          ? html`<div class=${this.listView === 'list' ? 'ut-rows' : 'session-flex-responsive'}>
              ${repeat(
                sorted,
                (session) => session.id,
                (session) => this.renderCard(session, tabStop)
              )}
            </div>`
          : nothing
      }
    </section>`;
  }

  @state() protected phoneQuery = '';
  /** Sessions pinned on this device (utils/pinned-sessions.ts): first in the phone list. */
  @state() protected pinnedIds = loadPinned();

  protected handlePinToggle = (e: CustomEvent<{ sessionId: string; pinned: boolean }>) => {
    this.pinnedIds = setPinned(e.detail.sessionId, e.detail.pinned);
  };

  /** Sessions that need you first, then the ones working, then by start; pinned ones first. */
  protected orderRunning(sessions: Session[]): Session[] {
    const rank = (session: Session) =>
      session.claudeStatus?.status === 'waiting'
        ? 0
        : isClaudeWorking(session.claudeStatus)
          ? 1
          : 2;
    // Within a state, order by start time: lastModified changes with every output burst and
    // would shuffle rows under the user's finger on each 1 s poll.
    const started = (session: Session) => new Date(session.startedAt || 0).getTime();
    return pinnedFirst(
      [...sessions].sort((a, b) => rank(a) - rank(b) || started(b) - started(a)),
      this.pinnedIds
    );
  }

  /**
   * One Untether session as a phone row; `stampExtra` is anything else its row shows. Outside
   * a project group (`inProject`: the group pins its orchestrator under its own badge), an
   * orchestrator's row carries the sparkles (2026-10-24: mission control and "On this Mac" did
   * not say which session was one).
   */
  protected renderPhoneRow(
    session: Session,
    stampExtra = '',
    projectIcon: string | null = null,
    inProject = false
  ) {
    return html`
      <phone-session-row
        .session=${session}
        .projectIcon=${projectIcon}
        .orchestrator=${!inProject && this.orchestratorSessionIds().has(session.id)}
        .authClient=${this.authClient}
        .selected=${session.id === this.selectedSessionId}
        .unread=${session.id !== this.selectedSessionId && isUnread(session)}
        .pinned=${this.pinnedIds.has(session.id)}
        .groupMenu=${this.groupMenu()}
        .stamp=${`${session.status}|${session.muted ? 1 : 0}|${JSON.stringify(session.groupPin ?? null)}|${session.lastModified}|${JSON.stringify(session.claudeStatus ?? null)}${stampExtra}|${projectIcon ?? ''}`}
        @session-select=${this.handleSessionSelect}
        @session-killed=${this.handleSessionKilled}
        @session-kill-error=${this.handleSessionKillError}
        @session-renamed=${this.handleSessionRenamed}
        @session-pin-toggle=${this.handlePinToggle}
        @session-group-pinned=${this.handleGroupPinned}
      ></phone-session-row>
    `;
  }

  /**
   * "Terminadas (n)" at the end of the list, collapsed by default (the app's hideExited):
   * opens on a tap; "Borrar todas" asks first. While searching, matches show regardless.
   */
  protected renderFinishedSection(exited: Session[], searching: boolean) {
    if (!exited.length) return nothing;
    const recency = (session: Session) =>
      new Date(session.lastModified || session.startedAt || 0).getTime();
    const open = searching || !this.hideExited;
    return html`
      <div class="ut-phone-section" data-testid="phone-finished">
        <button
          type="button"
          class="ut-phone-disclosure"
          data-testid="show-exited-toggle"
          aria-expanded=${open ? 'true' : 'false'}
          aria-controls="phone-finished-rows"
          ?disabled=${searching}
          @click=${() =>
            this.dispatchEvent(new CustomEvent('hide-exited-change', { detail: open }))}
        >
          <span class="ut-phone-eyebrow">${t('phone.finished', { n: exited.length })}</span>
          ${icon('chevronRight', 14)}
        </button>
        <button
          class="ut-phone-text-btn"
          data-testid="phone-clear-finished"
          ?disabled=${this.cleaningExited}
          @click=${this.confirmClearFinished}
        >
          ${t('phoneList.clearFinished')}
        </button>
      </div>
      ${
        open
          ? html`<div class="psr-list" id="phone-finished-rows">
              ${repeat(
                pinnedFirst(
                  [...exited].sort((a, b) => recency(b) - recency(a)),
                  this.pinnedIds
                ),
                (session) => session.id,
                (session) => this.renderPhoneRow(session)
              )}
            </div>`
          : html`<div id="phone-finished-rows" hidden></div>`
      }
    `;
  }

  /** "Hechas (n)": merged and discarded tasks, collapsed (done-section). */
  protected renderDoneSection(done: TaskRecord[], layout: 'row' | 'card' = 'row') {
    if (!done.length) return nothing;
    return html`<done-section
      .tasks=${done}
      .sessionsById=${this.sessionsById()}
      .layout=${layout}
      @session-select=${this.handleSessionSelect}
    ></done-section>`;
  }
}
