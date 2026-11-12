/**
 * Session list: the phone layout — rows, "On this Mac", mission, needs-you strip, tab bar,
 * search, previews, project groups, loading and empty states.
 */
import { html, nothing } from 'lit';
import { state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import type { MacSessionItem } from '../../../shared/mac-sessions.js';
import type { Session } from '../../../shared/types.js';
import { t } from '../../i18n/index.js';
import {
  isAgentsRoute,
  agentKind as missionAgentKind,
  missionCards,
  missionStamp,
  showAgentsTab,
} from '../../utils/agent-mission.js';
import { Z_INDEX } from '../../utils/constants.js';
import { swallowNextClick } from '../../utils/ghost-click.js';
import {
  isMacWindowSession,
  macItemHasAgents,
  macSessionsHeading,
  macSessionsPlatform,
  macWarningTexts,
  matchesMacQuery,
  readMacSectionCollapsed,
  writeMacSectionCollapsed,
} from '../../utils/mac-sessions.js';
import { previewsFolded } from '../../utils/phone-list-layout.js';
import { endsADrag } from '../../utils/pointer-drag.js';
import { isPreviewRowHighlighted, previewLabel, sortPreviews } from '../../utils/preview-rows.js';
import type { ProjectBoard } from '../../utils/project-groups.js';
import { agentLogo } from '../agent-avatar.js';
import { agentKind, icon } from '../icons.js';
import { SessionListNeedsYou } from './list-needs-you.js';

let macSectionIds = 0;

export abstract class SessionListPhone extends SessionListNeedsYou {
  /** The folded previews section opened by a tap (compact list). */
  @state() protected previewsExpanded = false;

  /** Rows deleted here, hidden until the next poll no longer lists them. */
  @state() protected deletedPreviews = new Set<string>();

  protected handlePreviewDeleted = (e: CustomEvent<{ id: string }>) => {
    this.deletedPreviews = new Set(this.deletedPreviews).add(e.detail.id);
  };

  protected addTouchedAt = 0;

  /**
   * "Vistas previas (n)": saved previews, above the running sessions, which get their own
   * heading under them (user request, 2026-10-12; earlier the same day they sat below). Pages, not conversations:
   * the live ones as compact 56 px rows; the ones whose server is down fold into the
   * disclosure until opened, unless searching or one glows after `ut open`. Pinned first, then
   * the newest. The 44 px "+" offers the servers on the Mac, or a port or localhost URL typed.
   * In the sidebar opened from a session the section shows only when there is something in it.
   */
  protected renderPreviewSection(query = '') {
    const q = query.trim().toLowerCase();
    const all = sortPreviews(this.previews ?? []).filter(
      (item) => !this.deletedPreviews.has(item.id)
    );
    const rows = all.filter(
      (item) =>
        !q ||
        `${previewLabel(item)} ${item.title ?? ''} ${item.sessionName ?? ''} ${item.port}`
          .toLowerCase()
          .includes(q)
    );
    if (!rows.length && (this.compactMode || q)) return nothing;
    const add = (e: Event) => {
      e.stopPropagation();
      if (e.type === 'pointerup') {
        if ((e as PointerEvent).pointerType === 'mouse') return;
        // A scroll that started on the button ends here too: not a tap.
        if (endsADrag(e as PointerEvent)) return;
        this.addTouchedAt = Date.now();
        swallowNextClick();
      } else if (Date.now() - this.addTouchedAt < 700) {
        return;
      }
      void this.openAddPreviewSheet();
    };
    const live = rows.filter((item) => item.state !== 'down');
    const down = rows.filter((item) => item.state === 'down');
    const folded = previewsFolded({
      compact: this.listLayout().compact,
      count: down.length,
      searching: Boolean(q),
      expanded: this.previewsExpanded,
      highlighted: down.some((item) => isPreviewRowHighlighted(item.id)),
    });
    const shown = folded ? live : [...live, ...down];
    // Folded, the count is what opening it adds ("+1"), not every preview: a live one already
    // shows below, and "(2)" over one row read as a toggle that did nothing (QA 2026-10-12).
    const label =
      folded && live.length
        ? html`<span class="ut-phone-eyebrow">${t('previewRows.heading')}</span
            ><span class="ut-phone-eyebrow pvr-more" dir="ltr">+${down.length}</span>`
        : html`<span class="ut-phone-eyebrow"
            >${rows.length ? t('phone.previews', { n: rows.length }) : t('previewRows.heading')}</span
          >`;
    return html`
      <div class="pvr-header ut-phone-section" data-testid="preview-rows-heading">
        ${
          down.length
            ? html`<button
                type="button"
                class="ut-text-action ut-phone-disclosure pvr-toggle"
                data-testid="preview-rows-toggle"
                aria-expanded=${folded ? 'false' : 'true'}
                aria-controls="phone-preview-rows"
                @click=${() => {
                  this.previewsExpanded = folded;
                }}
              >
                ${label}${icon('chevronRight', 14)}
              </button>`
            : html`<h3 class="ut-phone-disclosure pvr-heading">${label}</h3>`
        }
        <button
          class="ut-icon-btn pvr-add"
          type="button"
          data-testid="preview-add"
          data-ut-optical-edge
          aria-label=${t('previewRows.add')}
          title=${t('previewRows.add')}
          @pointerup=${add}
          @click=${add}
        >
          ${icon('plus', 18)}
        </button>
      </div>
      ${
        shown.length
          ? html`<div
              class="psr-list pvr-list"
              id="phone-preview-rows"
              data-testid="preview-rows"
              @preview-deleted=${this.handlePreviewDeleted}
            >
              ${repeat(
                shown,
                (item) => item.id,
                (item) => html`<preview-row
                  .item=${item}
                  .authClient=${this.authClient}
                  .compact=${true}
                  .highlighted=${isPreviewRowHighlighted(item.id)}
                ></preview-row>`
              )}
            </div>`
          : html`<div class="pvr-list" id="phone-preview-rows"></div>`
      }
    `;
  }

  /** The search field, shown after a pull down at the top of the list (or while it has text). */
  @state() protected searchRevealed = false;

  // ---- "On this Mac" ---------------------------------------------------------------------

  /** Collapsed on this device (localStorage), from the section's disclosure button. */
  @state() protected macCollapsed = readMacSectionCollapsed();
  protected readonly macSectionId = `mac-section-${++macSectionIds}`;
  protected macToggleTouchedAt = 0;

  /** What the server lists: tmux sessions and agents outside Untether (none while it's off). */
  protected listedMacItems(): MacSessionItem[] {
    return this.macSessions?.enabled ? this.macSessions.items : [];
  }

  /**
   * Whether sessions opened with ut in a terminal window are listed under "On this Mac", apart
   * from the running sessions: unless the server says the section is off (the setting, or not
   * offered there). Then they are running sessions and mission cards like any other, still
   * marked 🖥, rather than in a section that is gone. Before the first answer they stay apart,
   * so it moves nothing.
   */
  protected macWindowsApart(): boolean {
    return this.macSessions?.enabled !== false;
  }

  protected toggleMacSection = (e: Event) => {
    e.stopPropagation();
    if (e.type === 'pointerup') {
      if ((e as PointerEvent).pointerType === 'mouse') return;
      // A scroll that started on the button ends here too: not a tap.
      if (endsADrag(e as PointerEvent)) return;
      this.macToggleTouchedAt = Date.now();
      swallowNextClick();
    } else if (Date.now() - this.macToggleTouchedAt < 700) {
      return;
    }
    this.macCollapsed = !this.macCollapsed;
    writeMacSectionCollapsed(this.macCollapsed);
  };

  /**
   * "On this Mac" ("On this computer" off macOS), below the running sessions. First the sessions
   * opened with ut in a terminal window: Untether sessions, with their normal row and full
   * control, but their program lives in that window, so they are listed here and not among the
   * running sessions. Then what the server found outside Untether: tmux sessions and agents.
   * Hidden while there is nothing to show.
   */
  protected renderMacSection(
    inMacWindows: Session[],
    items: MacSessionItem[],
    options: { warnings: boolean }
  ) {
    const response = this.macSessions;
    const count = inMacWindows.length + items.length;
    // No tmux is how this computer is, not a failure: it only explains a list of agents, and
    // alone it would keep an empty section on screen for good.
    const warnings =
      options.warnings && response?.enabled
        ? macWarningTexts(
            response.warnings.filter(
              (warning) => warning.code !== 'tmux-unavailable' || items.length > 0
            )
          )
        : [];
    if (!count && !warnings.length) return nothing;
    const platform = response?.platform || macSessionsPlatform();
    const collapsed = this.macCollapsed;
    const headingId = `${this.macSectionId}-heading`;
    const rowsId = `${this.macSectionId}-rows`;
    const toggleLabel = t(
      collapsed ? 'macSessions.section.expand' : 'macSessions.section.collapse'
    );
    return html`
      <div data-testid="mac-section" role="group" aria-labelledby=${headingId}>
        <div class="flex items-center justify-between mt-4 mb-1">
          <h3
            id=${headingId}
            class="text-xs font-semibold text-text-muted uppercase tracking-wider"
            data-testid="mac-section-heading"
          >
            ${macSessionsHeading(platform)} <span class="text-text-dim">(${count})</span>
          </h3>
          <button
            type="button"
            aria-expanded=${collapsed ? 'false' : 'true'}
            aria-controls=${rowsId}
            aria-label=${toggleLabel}
            title=${toggleLabel}
            data-testid="mac-section-toggle"
            style="display: inline-flex; align-items: center; justify-content: center; min-width: 44px;
              min-height: 44px; margin-inline-end: -12px; color: var(--color-text-muted);
              touch-action: manipulation"
            @pointerup=${this.toggleMacSection}
            @click=${this.toggleMacSection}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
              stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
              style="transform: rotate(${collapsed ? 0 : 180}deg)"><path d="M6 9l6 6 6-6" /></svg>
          </button>
        </div>
        <div id=${rowsId} ?hidden=${collapsed}>
          ${
            collapsed
              ? nothing
              : html`${warnings.map(
                  (text) =>
                    html`<p class="text-xs text-text-dim mb-2" data-testid="mac-section-warning">${text}</p>`
                )}${
                  count
                    ? html`<div class="psr-list" data-testid="mac-session-list">
                        ${repeat(
                          inMacWindows,
                          (session) => session.id,
                          // Their label says "Mac" once the server's platform is known.
                          (session) => this.renderPhoneRow(session, `|${platform}`)
                        )}
                        ${repeat(
                          items,
                          (item) => item.id,
                          (item) => html`<mac-session-row
                            .item=${item}
                            .authClient=${this.authClient}
                            .openMode=${response?.openMode ?? 'control'}
                            @session-killed=${this.handleSessionKilled}
                          ></mac-session-row>`
                        )}
                      </div>`
                    : nothing
                }`
          }
        </div>
      </div>
    `;
  }

  protected renderPhoneRows(allRunning: Session[], allExited: Session[]) {
    if (!this.compactMode) {
      // Previews are pages, not agents: only in the Sessions tab. Above the cards they pushed
      // the agents down a screen (2026-10-04, iPhone QA).
      if (isAgentsRoute()) return this.renderPhoneColumns(nothing, this.renderMission());
      const { controls, rows } = this.phoneSessionParts(allRunning, allExited);
      return this.renderPhoneColumns(controls, rows);
    }
    const { controls, rows } = this.phoneSessionParts(allRunning, allExited);
    return html`${controls}${rows}`;
  }

  /**
   * The phone home's bottom tab bar (phone-spec 3.3, 2026-10-12): Sesiones | Agentes (with the
   * count of agents waiting for you) and the one primary, "+" (or "+ Nueva" with room). 49 px
   * plus the safe area, side safe areas in landscape, where it lives under the left column
   * (list.css). Hidden while the keyboard is up (`kbd-open`). It replaced the counts, "Mostrar"
   * and "Cerrar todas" (now in the header's ⋯) and the floating "+" that had to dodge rows.
   */
  protected renderTabBar(heroShown = false) {
    const agents = isAgentsRoute();
    // Every agent waiting, those in a terminal window on the Mac included (they need you too).
    const waiting = missionCards(this.sessions).filter((card) => card.state === 'waiting').length;
    let touchedAt = 0;
    const tap = (fn: () => void) => ({
      handleEvent: (e: Event) => {
        if (e.type === 'pointerup') {
          const p = e as PointerEvent;
          if (p.pointerType === 'mouse' || endsADrag(p)) return;
          touchedAt = Date.now();
          swallowNextClick();
        } else if (Date.now() - touchedAt < 700) {
          return;
        }
        fn();
      },
    });
    const pick = (toAgents: boolean) =>
      tap(() => {
        if (toAgents !== agents) showAgentsTab(toAgents);
      });
    const openNew = tap(() => this.openNewChooser());
    const talk = tap(() => this.openGlobalCopilot());
    return html`<nav
      class="ut-chrome sticky bottom-0 ut-tabbar" data-testid="session-list-footer"
      aria-label=${t('phone.tab.sessions')}
      style="z-index: ${Z_INDEX.SESSION_LIST_BOTTOM_BAR}"
    >
      <div class="ut-tabbar-tabs" role="tablist" data-testid="agents-tabs">
        <button
          class="ut-tab ut-surface--control"
          role="tab"
          aria-selected=${agents ? 'false' : 'true'}
          data-testid="tab-sessions"
          @pointerup=${pick(false)}
          @click=${pick(false)}
        >
          ${icon('list', 22)}<span class="ut-tab-label">${t('phone.tab.sessions')}</span>
        </button>
        <button
          class="ut-tab ut-surface--control"
          role="tab"
          aria-selected=${agents ? 'true' : 'false'}
          data-testid="tab-agents"
          @pointerup=${pick(true)}
          @click=${pick(true)}
        >
          <span class="ut-tab-icon">${icon('sparkles', 22)}${
            waiting
              ? html`<span class="vtm-tab-badge ut-tab-badge" aria-label=${t('mission.waitingCount', { n: waiting })}>${waiting}</span>`
              : nothing
          }</span><span class="ut-tab-label">${t('phone.tab.agents')}</span>
        </button>
      </div>
      <button
        class="ut-tab-talk ut-surface--control"
        id="voice-copilot-global-button"
        aria-label=${t('copilot.openAll')}
        title=${t('copilot.openAll')}
        @pointerup=${talk}
        @click=${talk}
      >
        ${icon('mic', 20)}<span class="ut-tab-talk-label">${t('copilot.open')}</span>
      </button>
      <button
        class="ut-tab-new ${heroShown ? 'ut-tab-new--quiet' : ''} ut-surface--control ut-surface--primary"
        data-testid="phone-new-session"
        aria-label=${t('newChat.title')}
        @pointerup=${openNew}
        @click=${openNew}
      >
        ${icon('plus', 22)}<span class="ut-tab-new-label">${t('phone.new')}</span>
      </button>
    </nav>`;
  }

  /**
   * The phone list's two parts: what you act with (tabs, Ask box, Tareas, banners, search)
   * and what you look at (previews, sessions). One column, as if the wrappers weren't there
   * (`display: contents`), until the phone is on its side (`phone-landscape`, styles.css):
   * then they are two columns, each scrolling on its own (2026-10-04: a Pro Max in landscape
   * showed no session at all). Always the same elements, so a rotation keeps the Ask box's
   * text and focus.
   */
  protected renderPhoneColumns(controls: unknown, rows: unknown) {
    return html`<div class="pl-side" data-testid="phone-list-controls">${controls}</div
      ><div class="pl-main" data-testid="phone-list-rows">${rows}</div>`;
  }

  protected missionFrom: Session[] | null = null;
  protected missionApart = true;
  protected missionList: Session[] = [];

  /** Mission control's sessions: all but those in a terminal window on the Mac. */
  protected missionSessions(): Session[] {
    const apart = this.macWindowsApart();
    // Kept while the list is the same, so mission control doesn't re-render for nothing.
    if (this.missionFrom !== this.sessions || this.missionApart !== apart) {
      this.missionFrom = this.sessions;
      this.missionApart = apart;
      this.missionList = apart
        ? this.sessions.filter((session) => !isMacWindowSession(session))
        : this.sessions;
    }
    return this.missionList;
  }

  /**
   * Mission control (/agents): every agent session as its Sessions row, with broadcast. Below it, "On this
   * Mac" with only what runs an agent: the sessions in a terminal window on the Mac, then the
   * tmux sessions and agents outside Untether. Rows, as in the Sessions tab, not cards:
   * broadcast never types into them.
   */
  protected renderMission() {
    const sessions = this.missionSessions();
    const inMacWindows = this.macWindowsApart()
      ? this.sessions.filter(
          (session) => isMacWindowSession(session) && missionAgentKind(session) !== null
        )
      : [];
    const onMac = this.renderMacSection(
      this.orderRunning(inMacWindows),
      this.listedMacItems().filter(macItemHasAgents),
      { warnings: false }
    );
    // Its "No agents running" would be wrong above the Mac's agents. It stays in the page: the
    // tabs' styles live in it.
    const hidden = onMac !== nothing && !missionCards(sessions).length;
    return html`<agent-mission
        ?hidden=${hidden}
        .sessions=${sessions}
        .authClient=${this.authClient}
        .stamp=${missionStamp(sessions)}
        .renderRow=${(session: Session) => this.renderPhoneRow(session)}
        @session-select=${this.handleSessionSelect}
      ></agent-mission
      >${onMac}`;
  }

  /** The search field: first in the rows' column, shown after a pull down at the top. */
  protected renderPhoneSearch() {
    const shown = this.searchRevealed || Boolean(this.phoneQuery);
    return html`<div
      class="phone-search ${shown ? '' : 'phone-search-hidden'} ut-surface--inset"
      data-testid="phone-search"
      @focusin=${() => {
        this.searchRevealed = true;
      }}
    >
      ${icon('search', 16)}
      <input
        type="search"
        enterkeyhint="search"
        autocapitalize="off"
        autocorrect="off"
        autocomplete="off"
        placeholder=${t('sessions.search')}
        aria-label=${t('sessions.search')}
        .value=${this.phoneQuery}
        @input=${(e: Event) => {
          this.phoneQuery = (e.target as HTMLInputElement).value;
        }}
        @blur=${(e: Event) => {
          if (!(e.target as HTMLInputElement).value) this.searchRevealed = false;
        }}
      />
    </div>`;
  }

  /**
   * The phone's projects (project-group): one per repository with its open tasks and
   * sessions, "Otras" last. With only "Otras" and no task, its rows show as before, without a
   * header (under "Sesiones de Untether (n)" when previews sit above them).
   */
  protected renderProjectGroups(
    board: ProjectBoard,
    previewsShown: boolean,
    row: (session: Session, extras?: { projectIcon?: string | null }) => unknown,
    /** A search is on: folded projects show open, so what it found is on screen. */
    searching = false
  ) {
    this.noteShownGroups(board.groups);
    this.foldedTasks.clear();
    if (!board.groups.length) return nothing;
    const [first] = board.groups;
    const headless = board.groups.length === 1 && first.key === null && !first.tasks.length;
    const byId = this.sessionsById();
    const folded = (group: ProjectBoard['groups'][number]) => {
      const on = !headless && !searching && this.isGroupFolded(group.key);
      if (on) this.noteFoldedGroup(group.key, group.tasks);
      return on;
    };
    const onSelect = (e: CustomEvent) => {
      // Session rows answer their own tap; only a task row's needs passing on.
      if ((e.target as Element | null)?.localName === 'task-row') this.handleSessionSelect(e);
    };
    return html`${
      headless && previewsShown
        ? html`<div class="ut-phone-section" data-testid="phone-session-heading">
            <span class="ut-phone-eyebrow"
              >${t('phone.untetherSessions', { n: first.sessions.length })}</span
            >
          </div>`
        : nothing
    }<div
      class="prj-list"
      data-testid="phone-projects"
      @session-select=${onSelect}
      @project-new-task=${this.handleProjectNewTask}
      @project-settings=${this.handleProjectSettings}
      @project-orchestrate=${this.handleProjectOrchestrate}
      @project-menu=${this.handleProjectMenu}
      @project-forget=${this.handleProjectForget}
      @project-resume-merges=${this.handleProjectResumeMerges}
      @project-fold=${this.handleProjectFold}
    >
      ${repeat(
        board.groups,
        (group) => group.key ?? '',
        (group) => {
          const collapsed = folded(group);
          return html`<project-group
          .group=${group}
          .name=${this.groupName(group)}
          .branch=${this.groupBranch(group)}
          .sessionsById=${byId}
          .renderSession=${row}
          .selectedSessionId=${this.selectedSessionId}
          .headless=${headless}
          .orchestratorSessionId=${this.orchestratorFor(group.key)}
          .orchestratorPending=${this.orchestratorPendingFor(group.key)}
          .notice=${this.projectNotice(group.key)}
          .projectIcon=${this.projectIconFor(group.key)}
          .resuming=${this.isResuming(group.key)}
          .collapsed=${collapsed}
          .summary=${collapsed ? this.groupFoldSummary(group.sessions, group.tasks) : undefined}
          .foldLocked=${searching}
        ></project-group>`;
        }
      )}
      <button
        type="button"
        class="ut-btn ut-btn--ghost ut-btn--sm prj-new-project"
        data-testid="board-new-project"
        @click=${this.openNewProject}
      >
        ${icon('plus', 14)}${t('board.newProject')}
      </button>
    </div>`;
  }

  protected phoneSessionParts(allRunning: Session[], allExited: Session[]) {
    const macItems = this.listedMacItems();
    // Count every session, hidden finished ones included (2 running + 30 finished needs search),
    // and what "On this Mac" lists.
    const searchable = this.sessions.length + macItems.length > 6;
    // A query only filters while its box is there; otherwise it could hide sessions with no
    // way to clear it.
    const query = searchable ? this.phoneQuery : '';
    const searching = Boolean(query.trim());
    const matching = allRunning.filter((session) => this.matchesQuery(session, query));
    // Sessions in a terminal window on the Mac are listed under "On this Mac", not here.
    const apart = this.macWindowsApart();
    const running = apart ? matching.filter((session) => !isMacWindowSession(session)) : matching;
    const inMacWindows = apart ? matching.filter(isMacWindowSession) : [];
    const macMatches = macItems.filter((item) => matchesMacQuery(item, query));
    const ordered = this.orderRunning(running);
    const row = (session: Session, extras?: { projectIcon?: string | null }) =>
      this.renderPhoneRow(session, '', extras?.projectIcon ?? null, true);
    const previews = this.renderPreviewSection(query);
    // Projects: open tasks first in each, then its sessions; a task's session only in its row.
    const board = this.projectBoard(ordered, query);
    const exited = allExited.filter(
      (session) => this.matchesQuery(session, query) && !board.taskSessionIds.has(session.id)
    );
    const nothingFound =
      !board.groups.length &&
      !board.done.length &&
      !exited.length &&
      !inMacWindows.length &&
      !macMatches.length;
    // What you act with: the strip of sessions waiting for you, then the Ask box (Tareas in
    // its row). The notifications banner went below the sessions (one line, 2026-10-12).
    // «Te necesita» (2026-11-08): what waits for you, most urgent first; «Solo esto» shows only
    // it, the rest of the list hidden (search included: the section is the list).
    const needs = this.compactMode ? [] : this.needsYou(allRunning, this.liveTasks());
    const needsOnly = this.needsOnlyOn('phone', needs);
    const controls = this.compactMode
      ? nothing
      : html`
          ${this.renderNeedsYouSection(needs, 'phone')}
          ${this.renderAskBox()}
          <shield-banner
            .sessions=${this.sessions}
            .authClient=${this.authClient}
            @refresh=${() => this.dispatchEvent(new CustomEvent('refresh'))}
          ></shield-banner>
        `;
    if (needsOnly) return { controls, rows: nothing };
    const rows = html`
      ${searchable ? this.renderPhoneSearch() : nothing}
      ${
        searching && nothingFound
          ? html`<div class="phone-search-empty ut-surface--panel ut-surface--material">${t('sessions.searchEmpty')}</div>`
          : nothing
      }
      ${
        // Pages first, then the conversations under their own heading, then "On this Mac":
        // three separate groups, previews on top (user request, 2026-10-12, iPhone). Also in the
        // sidebar opened from inside a session (compact), where he looks while working.
        previews
      }
      ${this.renderProjectGroups(board, previews !== nothing, row, searching)}
      ${
        // Below them too: arriving after them, it moves nothing under the finger. Warnings are
        // about the listing, not search results.
        this.renderMacSection(this.orderRunning(inMacWindows), macMatches, {
          warnings: !searching,
        })
      }
      ${this.renderSuspendedSection('phone', query)}
      ${this.renderDoneSection(board.done)}
      ${this.renderFinishedSection(exited, searching)}
      ${
        this.compactMode
          ? nothing
          : html`<notifications-banner compact data-testid="phone-notify-banner"></notifications-banner>`
      }
    `;
    return { controls, rows };
  }

  /**
   * The phone list while the first sessions load (phone-spec 4.1): the Ask box at once (the
   * tab bar is drawn by render()), then four skeleton rows in the rows' geometry after 150 ms.
   * Reduce Motion: no shimmer (styles.css .ut-skeleton).
   */
  protected renderPhoneLoading(twoColumns: boolean) {
    const skeleton = this.showSkeleton
      ? html`<div class="psr-list" data-testid="list-skeleton" aria-busy="true" aria-label=${t('sessions.loading')}>
          ${Array.from(
            { length: 4 },
            () => html`<div class="psr psr-skeleton" aria-hidden="true">
              <span class="psr-avatar ut-skeleton"></span>
              <span class="psr-body">
                <span class="ut-skeleton block h-4 w-1/2"></span>
                <span class="ut-skeleton block h-3 w-1/3 mt-2"></span>
                <span class="ut-skeleton block h-3 w-3/4 mt-2"></span>
              </span>
            </div>`
          )}
        </div>`
      : nothing;
    return twoColumns
      ? this.renderPhoneColumns(this.renderAskBox(), skeleton)
      : html`${this.renderAskBox()}${skeleton}`;
  }

  /**
   * Phone home with nothing running (phone-spec 4.1): the hero first (glyph tile, title, one
   * primary "Nueva sesión"), your quick starts as 52 px tiles (no emoji, no glow), the Ask
   * box, then previews (collapsed), what runs on the Mac and the finished sessions.
   */
  protected renderPhoneEmpty(exited: Session[]) {
    this.loadQuickStarts();
    const board = this.projectBoard([], '', false);
    const tools = this.quickStartList().slice(0, 6);
    return html`
      <div class="phone-empty ut-phone-hero ut-surface--panel ut-surface--material" data-testid="phone-empty">
        <div class="ut-empty-glyph" aria-hidden="true">${icon('terminal', 26)}</div>
        <h2 class="ut-phone-hero-title">${t('empty.title')}</h2>
        <p class="ut-phone-hero-text">${t('empty.subtitle')}</p>
        <button
          class="ut-btn ut-btn--primary ut-phone-hero-cta"
          data-testid="phone-empty-new"
          @click=${this.openToolSheet}
        >
          ${icon('plus', 18)}${t('sessions.newSession')}
        </button>
        <div class="phone-empty-tools">
          ${tools.map((entry) => {
            const available = this.quickStartAvailable(entry);
            return html`<button
              class="ut-text-action phone-tool ${available ? '' : 'unavailable'}"
              aria-disabled=${available ? nothing : 'true'}
              @click=${() => this.chooseQuickStart(entry)}
            >
              ${agentLogo(agentKind({ command: entry.command.trim().split(/\s+/) }), undefined, 16)}
              <span class="phone-tool-text"
                ><span class="phone-tool-name">${this.quickStartDisplay(entry)}</span>${
                  available
                    ? nothing
                    : html`<span class="phone-tool-note">${t('quickStart.notInstalled')}</span>`
                }</span
              >
            </button>`;
          })}
          <button class="ut-text-action phone-tool" @click=${() => this.openCreateDialog()}>
            ${icon('settings', 16)}<span class="phone-tool-name">${t('empty.custom')}</span>
          </button>
        </div>
      </div>
      ${
        // Tasks waiting for a yes stay reachable with nothing running (2026-10-20 audit).
        this.renderNeedsYouSection(this.needsYou([], []), 'phone')
      }
      ${this.renderAskBox()}
      ${
        // Pinned projects stay with their "+ Tarea" / "Orquestar" (2026-10-20 audit).
        this.renderProjectGroups(
          { ...board, groups: board.groups.filter((group) => group.pinned) },
          false,
          (session, extras) => this.renderPhoneRow(session, '', extras?.projectIcon ?? null, true)
        )
      }
      ${this.previews?.length ? this.renderPreviewSection() : nothing}
      ${this.renderMacSection([], this.listedMacItems(), { warnings: true })}
      ${this.renderDoneSection(board.done)}
      ${this.renderFinishedSection(
        exited.filter((session) => !board.taskSessionIds.has(session.id)),
        false
      )}
      <notifications-banner compact data-testid="phone-notify-banner"></notifications-banner>
    `;
  }
}
