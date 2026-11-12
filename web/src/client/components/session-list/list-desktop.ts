/**
 * Session list: the desktop and sidebar layouts — toolbar, filters, grid, attention strip,
 * empty hero, skeletons and keyboard navigation.
 */
import { html, nothing } from 'lit';
import { state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import type { TaskRecord } from '../../../shared/tasks.js';
import type { Session } from '../../../shared/types.js';
import { t } from '../../i18n/index.js';
import { toast } from '../../utils/action-toast.js';
import { foldKey } from '../../utils/group-fold.js';
import { copyToClipboard } from '../../utils/path-utils.js';
import type { ProjectBoard } from '../../utils/project-groups.js';
import { prefersReducedMotion } from '../../utils/reduced-motion.js';
import { isFinishedSession } from '../../utils/session-suspend.js';
import { formatShortcut } from '../../utils/shortcut-label.js';
import { agentLogo } from '../agent-avatar.js';
import { agentKind, icon } from '../icons.js';
import { renderFoldSummary, renderTaskUnits } from '../project-group.js';
import type { SessionCard } from '../session-card.js';
import { SessionListDrag } from './list-drag.js';
import {
  GRID_MIN_COLUMN,
  LIST_FILTERS,
  LIST_SORTS,
  type ListFilter,
  type ListSort,
  ownColumnCount,
} from './list-shared.js';

export abstract class SessionListDesktop extends SessionListDrag {
  protected getGridColumns(): number {
    const gridContainer = this.querySelector('.session-flex-responsive');
    if (!gridContainer || this.compactMode) return 1; // Compact mode is single column

    const templateColumns = window
      .getComputedStyle(gridContainer)
      .getPropertyValue('grid-template-columns');
    const columns = templateColumns.split(' ').filter((col) => col && col !== '0px').length;

    // Fallback: from the container width and the minimum column (list.css: 336px, gap 16px)
    if (columns === 0 || columns === 1) {
      const containerWidth = gridContainer.clientWidth;
      return Math.max(1, Math.floor((containerWidth + 16) / (GRID_MIN_COLUMN + 16)));
    }
    return columns;
  }

  /** The focusable session items of the list, in visual (DOM) order. */
  protected navItems(): HTMLElement[] {
    const selector = this.compactMode
      ? 'compact-session-card [data-testid="compact-session-card"], task-row [data-testid="compact-task-row"]'
      : 'session-card [data-testid="session-card"]';
    const items = [...this.querySelectorAll<HTMLElement>(selector)];
    // Packed repo blocks (dense grid) put later DOM items in earlier rows: go by position.
    const rects = new Map(items.map((el) => [el, el.getBoundingClientRect()]));
    if (items.every((el) => !rects.get(el)?.height)) return items;
    return items.sort((a, b) => {
      const ra = rects.get(a) as DOMRect;
      const rb = rects.get(b) as DOMRect;
      return Math.abs(ra.top - rb.top) > 4 ? ra.top - rb.top : ra.left - rb.left;
    });
  }

  /** The item in the next row up or down whose center is closest to the current one. */
  protected verticalNeighbor(items: HTMLElement[], index: number, down: boolean): number {
    const rects = items.map((el) => el.getBoundingClientRect());
    const cur = rects[index];
    if (!cur || rects.every((r) => r.width === 0 && r.height === 0)) {
      // No layout (tests): by columns.
      const columns = this.listView === 'list' ? 1 : this.getGridColumns();
      const next = index + (down ? columns : -columns);
      return Math.max(0, Math.min(items.length - 1, next));
    }
    const candidates = rects
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => (down ? r.top >= cur.bottom - 1 : r.bottom <= cur.top + 1));
    if (!candidates.length) return index;
    const rowTop = down
      ? Math.min(...candidates.map(({ r }) => r.top))
      : Math.max(...candidates.map(({ r }) => r.top));
    const row = candidates.filter(({ r }) => Math.abs(r.top - rowTop) < 4);
    const center = cur.left + cur.width / 2;
    row.sort(
      (a, b) =>
        Math.abs(a.r.left + a.r.width / 2 - center) - Math.abs(b.r.left + b.r.width / 2 - center)
    );
    return row[0].i;
  }

  protected focusItem(items: HTMLElement[], index: number) {
    const el = items[index];
    if (!el) return;
    const id = el.dataset.sessionId ?? null;
    this.focusId = id;
    el.focus();
    // An explicit 'smooth' ignores the page's Reduce Motion rule (scroll-behavior).
    el.scrollIntoView?.({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'nearest' });
  }

  /**
   * Keyboard on the desktop list (design spec 5.1): ← → ↑ ↓ and j / k move between cards,
   * Enter opens, F2 renames, ⌘⌫ closes (after asking). Phones have no keyboard list.
   */
  protected handleKeyDown = (e: KeyboardEvent) => {
    if (this.usePhoneRows()) return;
    const target = e.target as HTMLElement;
    if (target.closest('input, textarea, select') || target.isContentEditable) return;

    const items = this.navItems();
    if (!items.length) return;
    const active = document.activeElement;
    const index = items.indexOf(active as HTMLElement);
    const onList = index >= 0 || (target as unknown) === this;
    const mod = e.metaKey || e.ctrlKey;
    const card = index >= 0 ? (items[index].closest('session-card') as SessionCard | null) : null;

    let handled = true;
    switch (e.key) {
      case 'Enter':
        if (index < 0) return;
        items[index].click();
        break;
      case 'F2':
        if (!card) return;
        card.startRename();
        break;
      case 'Backspace':
      case 'Delete':
        if (!card || !(mod || e.key === 'Delete')) return;
        void card.confirmKill();
        break;
      case 'ArrowLeft':
      case 'ArrowRight':
      case 'ArrowUp':
      case 'ArrowDown':
      case 'j':
      case 'k': {
        if (!onList || (mod && !e.key.startsWith('Arrow'))) return;
        if (index < 0) {
          const start = Math.max(
            0,
            items.findIndex((el) => el.dataset.sessionId === this.focusId)
          );
          this.focusItem(items, start);
          break;
        }
        let next = index;
        if (e.key === 'ArrowLeft') next = Math.max(0, index - 1);
        else if (e.key === 'ArrowRight') next = Math.min(items.length - 1, index + 1);
        else if (this.compactMode) {
          const down = e.key === 'ArrowDown' || e.key === 'j';
          next = Math.max(0, Math.min(items.length - 1, index + (down ? 1 : -1)));
        } else next = this.verticalNeighbor(items, index, e.key === 'ArrowDown' || e.key === 'j');
        this.focusItem(items, next);
        break;
      }
      default:
        handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  /** "/" anywhere on the desktop home focuses the list search. */
  protected handleGlobalKeyDown = (e: KeyboardEvent) => {
    if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
    if (this.compactMode || this.usePhoneRows()) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
    if (document.querySelector('[aria-modal="true"]')) return;
    const input = this.querySelector<HTMLInputElement>('#session-search-input');
    if (!input?.offsetParent) return;
    e.preventDefault();
    input.focus();
    input.select();
  };

  // ---- Desktop home (design spec 5.1, 2026-10-12) ------------------------------------------

  protected renderDesktop(running: Session[], exited: Session[]) {
    // renderSessions says which groups it shows; nothing to reorder until then.
    this.noteShownGroups([]);
    const query = this.desktopQuery;
    const matching = running.filter((s) => this.matchesQuery(s, query));
    const tasks = this.liveTasks(query);
    // «Te necesita» (2026-11-08): sessions, tasks and OKs that wait, most urgent first; the
    // «Te necesitan» filter shows only that section.
    const needs = this.needsYou(matching, tasks);
    const counts: Record<ListFilter, number> = {
      all: matching.length,
      agents: matching.filter((s) => this.passesFilter(s, 'agents')).length,
      terminals: matching.filter((s) => this.passesFilter(s, 'terminals')).length,
      attention: needs.length,
    };
    const shown = matching.filter((s) => this.passesFilter(s));
    const board = this.projectBoard(shown, query);
    const exitedShown = exited.filter(
      (s) => this.matchesQuery(s, query) && this.passesFilter(s) && !board.taskSessionIds.has(s.id)
    );
    const noSessions = this.sessions.length === 0 && !tasks.length;
    // Nothing running still shows what waits for a yes (a task to confirm) and the pinned
    // projects with their "+ Tarea" / "Orquestar" (2026-10-20 audit: both vanished).
    const emptyExtras = () =>
      html`${this.renderNeedsYouSection(needs, 'desktop')}${this.renderPinnedProjects(board)}`;

    let body: unknown;
    if (noSessions) {
      body = this.loading
        ? this.showSkeleton
          ? this.renderSkeletons()
          : nothing
        : // Done tasks still show under the hero (2026-10-20 verify: «Hechas» vanished).
          html`${emptyExtras()}${this.renderEmptyHero()}${this.renderDoneSection(board.done, 'card')}`;
    } else if (!running.length && !tasks.length) {
      body = html`${emptyExtras()}${this.renderEmptyHero(true)}
        ${this.renderSuspendedSection('card', query)}
        ${this.renderDoneSection(board.done, 'card')}
        ${exited.length ? this.renderExitedSection(exitedShown, exited.length, true) : nothing}`;
    } else if (this.needsOnlyOn('desktop', needs)) {
      body = this.renderNeedsYouSection(needs, 'desktop');
    } else {
      body = html`
        ${this.renderNeedsYouSection(needs, 'desktop')}
        ${
          shown.length || tasks.length
            ? this.renderSessions(shown, board)
            : html`<div class="py-16 text-center text-ui text-text-muted" data-testid="list-no-match">
                ${t('sessions.searchEmpty')}
              </div>`
        }
        ${this.renderSuspendedSection('card', query)}
        ${this.renderDoneSection(board.done, 'card')}
        ${exited.length ? this.renderExitedSection(exitedShown, exited.length) : nothing}
      `;
    }

    return html`
      <div class="ut-list font-ui text-ui text-text" data-testid="session-list-container">
        ${
          // While the first list loads, the toolbar is already there (inert), so the skeleton
          // grid starts where the real one will and nothing jumps (2026-10-12).
          !noSessions
            ? this.renderToolbar(counts)
            : this.loading && this.showSkeleton
              ? html`<div inert aria-hidden="true" style="display: contents">
                  ${this.renderToolbar(counts)}
                </div>`
              : nothing
        }
        <div class="ut-list-content">${body}</div>
      </div>
    `;
  }

  protected renderToolbar(counts: Record<ListFilter, number>) {
    const filterLabel: Record<ListFilter, string> = {
      all: t('sessions.filter.all'),
      agents: t('sessions.filter.agents'),
      terminals: t('sessions.filter.terminals'),
      attention: t('sessions.filter.attention'),
    };
    const sortLabel: Record<ListSort, string> = {
      activity: t('sessions.sort.activity'),
      name: t('sessions.sort.name'),
      repo: t('sessions.sort.repo'),
    };
    return html`
      <div class="ut-list-toolbar ut-surface--bar" data-testid="list-toolbar">
        <div class="ut-list-toolbar-inner">
          <label class="ut-list-search">
            ${icon('search')}
            <input
              id="session-search-input"
              class="ut-field"
              type="search"
              autocomplete="off"
              spellcheck="false"
              placeholder=${t('sessions.search.placeholder')}
              aria-label=${t('sessions.search')}
              .value=${this.desktopQuery}
              @input=${(e: Event) => {
                this.desktopQuery = (e.target as HTMLInputElement).value;
              }}
              @keydown=${(e: KeyboardEvent) => {
                const input = e.target as HTMLInputElement;
                if (e.key === 'Escape') {
                  e.stopPropagation();
                  this.desktopQuery = '';
                  input.value = '';
                  input.blur();
                } else if (e.key === 'ArrowDown' || e.key === 'Enter') {
                  const items = this.navItems();
                  if (!items.length) return;
                  e.preventDefault();
                  if (e.key === 'Enter' && items.length === 1) items[0].click();
                  else this.focusItem(items, 0);
                }
              }}
            />
            <span class="ut-kbd" aria-hidden="true">/</span>
          </label>
          <div class="ut-segmented" role="group" aria-label=${t('sessions.search')}>
            ${LIST_FILTERS.map(
              (filter) => html`<button
                type="button"
                aria-pressed=${this.listFilter === filter ? 'true' : 'false'}
                data-testid="filter-${filter}"
                @click=${() => this.setFilter(filter)}
              >
                ${filterLabel[filter]}
                ${
                  filter === 'attention' && !counts.attention
                    ? nothing
                    : html`<span
                        class="ut-filter-count ${filter === 'attention' ? 'ut-filter-count--attention' : ''}"
                        data-testid="filter-count-${filter}"
                        >${counts[filter]}</span
                      >`
                }
              </button>`
            )}
          </div>
          <span class="ut-toolbar-spacer"></span>
          <button
            type="button"
            class="ut-toolbar-toggle"
            aria-pressed=${this.groupByRepo ? 'true' : 'false'}
            data-testid="group-by-repo-toggle"
            title=${t('sessions.groupByRepo')}
            @click=${() => this.toggleGroupByRepo()}
          >
            <span class="ut-toolbar-toggle-label">${t('sessions.groupByRepo')}</span>
            <span class="ut-switch" aria-checked=${this.groupByRepo ? 'true' : 'false'}></span>
          </button>
          <div class="ut-segmented" role="group">
            ${(['grid', 'list'] as const).map(
              (view) => html`<button
                type="button"
                aria-pressed=${this.listView === view ? 'true' : 'false'}
                aria-label=${t(view === 'grid' ? 'sessions.view.grid' : 'sessions.view.list')}
                title=${t(view === 'grid' ? 'sessions.view.grid' : 'sessions.view.list')}
                data-testid="view-toggle-${view}"
                style="padding: 0 7px"
                @click=${() => this.setView(view)}
              >
                ${icon(view)}
              </button>`
            )}
          </div>
          ${
            this.compactMode
              ? nothing
              : html`<button
                  type="button"
                  class="ut-toolbar-menu-btn ut-toolbar-talk ut-surface--control"
                  id="voice-copilot-global-button"
                  aria-label=${t('copilot.openAll')}
                  title=${t('copilot.openAll')}
                  @click=${() => this.openGlobalCopilot()}
                >
                  ${icon('mic')}<span>${t('copilot.open')}</span>
                </button>`
          }
          <button
            type="button"
            class="ut-toolbar-menu-btn ut-surface--control"
            data-testid="list-sort-button"
            aria-haspopup="menu"
            aria-expanded=${this.openPopoverKey === 'sort' ? 'true' : 'false'}
            title=${t('sessions.sort.label')}
            @click=${(e: Event) =>
              this.openPopover(
                'sort',
                e.currentTarget as HTMLElement,
                () => this.renderSortMenu(sortLabel),
                'bottom-end'
              )}
          >
            <span class="ut-sort-label">${sortLabel[this.listSort]}</span>${icon('chevronDown')}
          </button>
          <button
            type="button"
            class="ut-icon-btn"
            data-testid="list-more-button"
            aria-haspopup="menu"
            aria-expanded=${this.openPopoverKey === 'more' ? 'true' : 'false'}
            aria-label=${t('sessions.more')}
            title=${t('sessions.more')}
            @click=${(e: Event) =>
              this.openPopover(
                'more',
                e.currentTarget as HTMLElement,
                () => this.renderMoreMenu(),
                'bottom-end'
              )}
          >
            ${icon('more')}
          </button>
        </div>
      </div>
    `;
  }

  protected renderSortMenu(labels: Record<ListSort, string>) {
    return html`<div class="ut-menu" role="menu" data-testid="list-sort-menu">
      <div class="ut-menu-label">${t('sessions.sort.label')}</div>
      ${LIST_SORTS.map(
        (sort) => html`<button
          class="ut-menu-item"
          role="menuitemradio"
          aria-checked=${this.listSort === sort ? 'true' : 'false'}
          @click=${() => this.setSort(sort)}
        >
          <span class="ut-check">${this.listSort === sort ? icon('check') : nothing}</span
          >${labels[sort]}
        </button>`
      )}
    </div>`;
  }

  protected renderMoreMenu() {
    const running = this.sessions.filter((s) => s.status === 'running').length;
    const exited = this.sessions.filter((s) => isFinishedSession(s)).length;
    return html`<div class="ut-menu" role="menu" data-testid="list-more-menu">
      <button
        class="ut-menu-item"
        role="menuitem"
        data-testid="clear-exited-menu-item"
        ?disabled=${!exited || this.cleaningExited}
        @click=${() => {
          this.closePopover();
          this.confirmClearFinished();
        }}
      >
        ${icon('trash')}${t('sessions.clearExited')}
      </button>
      <div class="ut-menu-sep"></div>
      <button
        class="ut-menu-item ut-menu-item--danger"
        role="menuitem"
        id="kill-all-button"
        data-testid="kill-all-button"
        ?disabled=${!running}
        @click=${() => {
          this.closePopover();
          // The app asks (with the count) and closes them.
          this.dispatchEvent(new CustomEvent('kill-all-sessions'));
        }}
      >
        ${icon('x')}${t('sessions.killAll')}
      </button>
    </div>`;
  }

  /**
   * The running sessions: one grid (or list). Grouped, each repo is a block of the grid (a
   * subgrid) spanning as many columns as it has cards, up to a full row, with its header on
   * top; small repos pack side by side in group order (no `dense`: a later group never jumps
   * ahead of an earlier one), and "No repository" always takes its own last row (2026-10-12).
   * Its open tasks (task-row cards) come first in the block, on the block's own columns; a
   * task's session has no card of its own (2026-10-18). The block is as wide as its longest
   * row of cards and no wider (2026-11-11: any project with a task took two columns, so one
   * with a single task and a single session had a header twice as wide as its cards and an
   * empty column beside them). Ungrouped, the tasks are one strip on top.
   */
  protected renderSessions(sessions: Session[], board: ProjectBoard = this.projectBoard(sessions)) {
    const loose = sessions.filter((session) => !board.taskSessionIds.has(session.id));
    const byId = this.sessionsById();
    const taskCards = (tasks: TaskRecord[]) =>
      tasks.length
        ? html`<div
            class="tsk-grid ut-grid-header"
            data-testid="desktop-task-list"
            @session-select=${this.handleSessionSelect}
          >
            ${renderTaskUnits(tasks, {
              sessionsById: byId,
              selectedSessionId: this.selectedSessionId,
              variant: 'card',
            })}
          </div>`
        : nothing;
    const ordered: Array<[string | null, Session[], TaskRecord[], boolean?]> = this.groupByRepo
      ? this.orderedBoardGroups(board)
      : [[null, this.sortSessions(loose), board.groups.flatMap((group) => group.tasks)]];
    // Grouped by activity, the group order is the user's: headers drag, «Subir» / «Bajar».
    this.noteShownGroups(this.groupByRepo && this.listSort === 'activity' ? board.groups : []);
    const flat = ordered.flatMap(([, group]) => group);
    const tabStop = this.tabStopId(flat);
    const cards = (group: Session[]) =>
      repeat(
        group,
        (session) => session.id,
        (session) => this.renderCard(session, tabStop, this.groupByRepo)
      );
    const othersShown = ordered.some(([repoPath]) => repoPath === null);
    if (this.listView === 'list') {
      return html`<section class="ut-section" data-testid="running-section">
        <div class="ut-rows" data-testid="session-grid">
          ${
            this.groupByRepo
              ? html`${ordered.map(
                  ([repoPath, group, tasks, folder]) => html`<div
                    class="ut-rows-group"
                    data-testid="repo-group"
                    data-group-key=${repoPath ?? ''}
                  >
                    ${this.renderRepoHeader(repoPath, group, false, folder)}
                    ${taskCards(tasks)} ${cards(group)}
                  </div>`
                )}${this.renderOthersDropZone(othersShown, false)}`
              : ordered.map(([, group, tasks]) => html`${taskCards(tasks)} ${cards(group)}`)
          }
        </div>
      </section>`;
    }
    if (!this.groupByRepo) {
      const [[, , tasks]] = ordered;
      return html`<section class="ut-section" data-testid="running-section">
        ${tasks.length ? html`<div class="session-flex-responsive mb-4">${taskCards(tasks)}</div>` : nothing}
        <div class="session-flex-responsive" data-testid="session-grid">${cards(flat)}</div>
      </section>`;
    }
    return html`<section class="ut-section" data-testid="running-section">
      <div class="session-flex-responsive ut-grid-packed" data-testid="session-grid">
        ${repeat(
          ordered,
          ([repoPath]) => repoPath ?? '',
          ([repoPath, group, tasks, folder]) => html`<div
            class="ut-group-block"
            data-testid="repo-group"
            data-group-key=${repoPath ?? ''}
            data-group-axis="x"
            style=${
              repoPath === null
                ? 'grid-column: 1 / -1'
                : `grid-column: span ${Math.min(Math.max(group.length, tasks.length, 1), this.gridCols)}`
            }
          >
            ${this.renderRepoHeader(repoPath, group, false, folder)} ${taskCards(tasks)} ${cards(group)}
          </div>`
        )}${this.renderOthersDropZone(othersShown, false)}
      </div>
    </section>`;
  }

  /** Columns of the session grid (the same formula as list.css auto-fill), for group spans. */
  @state() protected gridCols = 4;
  protected gridObserver: ResizeObserver | null = null;
  protected observedGrid: Element | null = null;

  protected watchGrid() {
    const grid = this.querySelector('.ut-grid-packed');
    if (grid === this.observedGrid) return;
    this.gridObserver?.disconnect();
    this.observedGrid = grid;
    if (!grid || typeof ResizeObserver === 'undefined') return;
    this.gridObserver ??= new ResizeObserver(() => this.measureGridCols());
    this.gridObserver.observe(grid);
    this.measureGridCols();
  }

  protected measureGridCols() {
    const grid = this.observedGrid as HTMLElement | null;
    if (!grid?.clientWidth) return;
    const narrow = window.innerWidth <= 540;
    const min = window.innerWidth >= 1024 ? GRID_MIN_COLUMN : 280;
    // A style may set the columns itself (--ut-list-columns: Cosmos and others keep one wide
    // column); a span counted for the auto-fill formula would then add columns the grid lacks.
    const own = getComputedStyle(grid).getPropertyValue('--ut-list-columns').trim();
    const cols =
      (own ? ownColumnCount(own) : null) ??
      (narrow ? 1 : Math.max(1, Math.floor((grid.clientWidth + 16) / (min + 16))));
    if (cols !== this.gridCols) this.gridCols = cols;
  }

  protected renderSkeletons() {
    return html`<div class="session-flex-responsive" data-testid="list-skeleton" aria-busy="true">
      ${Array.from(
        { length: 6 },
        () => html`<div class="ut-card-skeleton">
          <div class="flex items-center gap-2">
            <span class="ut-skeleton block h-4 w-4"></span>
            <span class="ut-skeleton block h-3 w-1/2"></span>
          </div>
          <span class="ut-skeleton block h-3 w-2/3"></span>
        </div>`
      )}
    </div>`;
  }

  /**
   * Nothing running: the branded hero (first run), or, with only finished sessions, the same
   * column quieter (no gradient) above the "Finished" section.
   */
  protected renderEmptyHero(allExited = false) {
    this.loadQuickStarts();
    // Installed first; at most six tiles.
    const tools = [...this.quickStartList()]
      .sort((a, b) => Number(this.quickStartAvailable(b)) - Number(this.quickStartAvailable(a)))
      .slice(0, 6);
    const host = window.location.host;
    const commands = ['ut claude', 'ut pnpm dev'];
    const copy = async (text: string) => {
      if (await copyToClipboard(text)) toast({ kind: 'success', text: t('copyMode.copied') });
    };
    return html`<div class="ut-empty ut-surface--panel ut-surface--material" data-testid="desktop-empty">
      <div class="ut-empty-glyph ${allExited ? 'ut-empty-glyph--muted' : ''}">${icon('terminal', 26)}</div>
      <h2 class="text-display font-[650] text-text-bright m-0">
        ${allExited ? t('sessions.empty.noRunning') : t('sessions.empty.title')}
      </h2>
      <p class="text-ui text-text-muted mt-2 mb-0">
        ${allExited ? t('sessions.empty.allExited') : t('sessions.empty.subtitle')}
      </p>
      <button
        class="ut-btn ${allExited ? '' : 'ut-btn--primary'} ut-btn--lg mt-6"
        data-testid="create-session-btn"
        @click=${() => this.openCreateDialog()}
      >
        ${icon('plus')}${t('sessions.newSession')}<span class="ut-kbd ut-empty-kbd" aria-hidden="true"
          >${formatShortcut('mod+shift+n')}</span
        >
      </button>
      ${
        allExited
          ? nothing
          : html`
            <div class="ut-empty-tiles" data-testid="empty-quick-starts">
              ${tools.map((entry) => {
                const available = this.quickStartAvailable(entry);
                const label = this.quickStartLabel(entry).replace(
                  /^\p{Extended_Pictographic}\s*/u,
                  ''
                );
                return html`<button
                  class="ut-empty-tile"
                  aria-disabled=${available ? nothing : 'true'}
                  title=${available ? entry.command : t('sessions.empty.notInstalled')}
                  @click=${() => this.chooseQuickStart(entry)}
                >
                  ${agentLogo(agentKind({ command: entry.command.trim().split(/\s+/) }), undefined, 16)}
                  <span class="truncate">${label}</span>
                  ${
                    available
                      ? nothing
                      : html`<span class="ut-empty-tile-note">${t('sessions.empty.notInstalled')}</span>`
                  }
                </button>`;
              })}
            </div>
            <details class="ut-empty-cli" data-testid="empty-from-terminal">
              <summary>${icon('chevronRight')}${t('sessions.empty.fromTerminal')}</summary>
              ${commands.map(
                (command) => html`<div class="ut-empty-cmd">
                  <code>${command}</code>
                  <button
                    class="ut-icon-btn ut-icon-btn--sm"
                    aria-label=${t('sessions.empty.copy')}
                    title=${t('sessions.empty.copy')}
                    @click=${() => void copy(command)}
                  >
                    ${icon('copy')}
                  </button>
                </div>`
              )}
              <p class="text-caption text-text-dim mt-3 mb-0">
                ${t('sessions.empty.openAt', { host })}
              </p>
            </details>
          `
      }
    </div>`;
  }

  // ---- Split-view sidebar (design spec 5.2) ------------------------------------------------

  /**
   * Open tasks are rows of their project, above its sessions (2026-11-08: one still waiting to
   * start showed nowhere here). As on the board, a task's session has no card of its own while
   * the task is open. Only open ones: this list has no «Hechas» where a finished task's session
   * would show instead.
   */
  protected renderSidebar(running: Session[], allExited: Session[]) {
    const tasks = this.liveTasks();
    const taskSessionIds = new Set(tasks.map((task) => task.sessionId));
    const exited = allExited.filter((session) => !taskSessionIds.has(session.id));
    const groups = this.sidebarGroups(
      running.filter((session) => !taskSessionIds.has(session.id)),
      tasks
    );
    const byId = this.sessionsById();
    // By activity, the group order is the user's: headers drag, «Subir» / «Bajar».
    this.noteShownGroups(this.listSort === 'activity' ? groups.map(({ key }) => ({ key })) : []);
    const orchestrators = this.orchestratorSessionIds();
    let index = 0;
    const showExited = !this.hideExited && exited.length > 0;
    this.foldedTasks.clear();
    // A group without a header (the only one, outside any project) has nothing to open it with.
    const headed = (key: string | null) => groups.length > 1 || !!key;
    return html`
      <div class="ut-side-list ut-scroll-stable" data-testid="session-list-container">
        ${
          !groups.length && !showExited && !this.suspendedSessions.length
            ? html`<div class="px-4 py-6 text-caption text-text-dim">
                ${this.loading ? t('sessions.loading') : t('sessions.empty.noRunning')}
              </div>`
            : nothing
        }
        ${groups.map(({ key: repoPath, sessions: group, tasks: groupTasks }, at) => {
          const bodyId = `side-fold-${at}`;
          const collapsed = headed(repoPath) && this.isGroupFolded(repoPath);
          const head = headed(repoPath)
            ? this.renderRepoHeader(repoPath, group, true, false, groupTasks.length, {
                collapsed,
                bodyId,
              })
            : nothing;
          if (collapsed) {
            this.noteFoldedGroup(repoPath, groupTasks);
            return html`<div
              class="ut-side-group"
              data-testid="sidebar-group"
              data-group-key=${repoPath ?? ''}
              data-folded="true"
            >
              ${head}
              <div
                class="ut-fold-summary ut-side-fold-summary"
                id=${bodyId}
                data-testid="project-fold-summary"
                @click=${() => void this.setGroupFolded(repoPath, false)}
              >
                ${renderFoldSummary(this.groupFoldSummary(group, groupTasks))}
              </div>
            </div>`;
          }
          return html`<div
            class="ut-side-group"
            data-testid="sidebar-group"
            data-group-key=${repoPath ?? ''}
            data-folded="false"
          >
            ${head}
            <div
              class="ut-side-rows ${this.unfoldedGroup === foldKey(repoPath) ? 'ut-fold-in' : ''}"
              id=${bodyId}
            >
            ${
              groupTasks.length
                ? html`<div data-testid="sidebar-task-list" @session-select=${this.handleSessionSelect}>
                    ${renderTaskUnits(groupTasks, {
                      sessionsById: byId,
                      selectedSessionId: this.selectedSessionId,
                      variant: 'side',
                    })}
                  </div>`
                : nothing
            }
            ${repeat(
              group,
              (session) => session.id,
              (session) => {
                const number = ++index;
                return this.renderCompactCard(session, {
                  orchestrator: orchestrators.has(session.id),
                  projectIcon: this.orchestratorIconFor(session.id),
                  sessionNumber: number,
                  draggable: true,
                });
              }
            )}
            </div>
          </div>`;
        })}${this.renderOthersDropZone(
          groups.some(({ key }) => key === null),
          true
        )}
        ${this.renderSuspendedSection('sidebar')}
        ${
          showExited
            ? html`<div class="ut-side-group" data-testid="sidebar-exited">
                <div class="ut-repo-head ut-repo-head--compact">
                  <span class="ut-section-label">${t('sessions.exited')}</span>
                  <span class="ut-repo-count">${exited.length}</span>
                </div>
                ${repeat(
                  exited,
                  (session) => session.id,
                  (session) => this.renderCompactCard(session)
                )}
              </div>`
            : nothing
        }
      </div>
    `;
  }

  /**
   * The list's padding, and on a phone the small-screen fit and the two columns of a phone on
   * its side (styles.css `phone-landscape`).
   */
  protected contentClasses(twoColumns = false): string {
    if (!this.usePhoneRows() || this.compactMode) return 'p-4 pt-5';
    const layout = this.listLayout();
    return [
      'p-4',
      layout.tight ? 'pt-3' : 'pt-4',
      'phone-list',
      layout.tight ? 'phone-list-tight' : '',
      layout.compact ? 'phone-list-compact' : '',
      twoColumns ? 'phone-landscape' : '',
    ]
      .filter(Boolean)
      .join(' ');
  }
}
