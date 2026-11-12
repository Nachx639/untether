/**
 * Session list: grouping by repository, repository headers and menus, worktrees and
 * follow mode.
 */
import { html, nothing } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import type { TaskRecord } from '../../../shared/tasks.js';
import type { Session } from '../../../shared/types.js';
import { HttpMethod } from '../../../shared/types.js';
import { t } from '../../i18n/index.js';
import { toast } from '../../utils/action-toast.js';
import { formatPathForDisplay } from '../../utils/path-utils.js';
import {
  groupSessionsAndTasksByRepo,
  groupSessionsByRepo,
  type ProjectBoard,
  stickyGroupOrder,
  withManualOrder,
  withManualSessionOrder,
} from '../../utils/project-groups.js';
import { normalizeRepoPath, sessionRepoKey } from '../../utils/repo-key.js';
import { deriveSessionStatus, lastActivityAt } from '../../utils/session-status.js';
import { sortBoardTasks, taskWantsUser } from '../../utils/task-status.js';
import { icon } from '../icons.js';
import { renderProjectNoticeBanner } from '../project-group.js';
import { sessionDisplayName } from '../session-card.js';
import { SessionListLaunch } from './list-launch.js';
import { logger, WORKTREE_RETRY_MS } from './list-shared.js';
import { renderSideFoldToggle } from './repository-header.js';

export abstract class SessionListRepos extends SessionListLaunch {
  protected async loadFollowModeForAllRepos() {
    // The plain grouping: this.groupSessionsByRepo also sorts, and overwrote repoOrder
    // without the projects that have only tasks (2026-11-10).
    const repoGroups = groupSessionsByRepo(
      this.sessions,
      this.repoWorktrees,
      this.taskBoard.orchestrators
    );
    for (const [repoPath] of repoGroups) {
      if (repoPath && !this.repoWorktrees.has(repoPath)) {
        // loadWorktreesForRepo now also loads follow mode
        this.loadWorktreesForRepo(repoPath);
      }
    }
  }

  /**
   * Sessions by repository, one group per worktree family (2026-10-12): the key is the main
   * repo path (`gitMainRepoPath`, else `gitRepoPath`), normalized (no /private, no trailing
   * slash); a repo inside another group's path, or listed among another group's worktrees,
   * joins that group, so the same repo is never split. Groups are ordered by their most recent
   * activity (to the minute, then by name, so they don't swap on every poll); sessions without
   * a repo come last under the null key. A running orchestrator is in its project's group.
   * By activity, the order the user chose wins (withManualOrder, 2026-11-07).
   */
  protected groupSessionsByRepo(sessions: Session[]): Map<string | null, Session[]> {
    const groups = groupSessionsByRepo(sessions, this.repoWorktrees, this.taskBoard.orchestrators);
    const ordered = new Map<string | null, Session[]>();
    for (const key of this.orderedRepoKeys([...groups.keys()], groups)) {
      ordered.set(key, this.withSessionOrder(this.sortSessions(groups.get(key) ?? [])));
    }
    return ordered;
  }

  /**
   * The split-view sidebar's groups (2026-11-08): the same order as the sessions', with each
   * project's open tasks (te necesita first); a project with only tasks has its group too.
   */
  protected sidebarGroups(
    sessions: Session[],
    tasks: readonly TaskRecord[]
  ): Array<{ key: string | null; sessions: Session[]; tasks: TaskRecord[] }> {
    const grouped = groupSessionsAndTasksByRepo(
      sessions,
      tasks,
      this.repoWorktrees,
      this.taskBoard.orchestrators
    );
    const keys = [...new Set([...grouped.sessions.keys(), ...grouped.tasks.keys()])];
    return this.orderedRepoKeys(keys, grouped.sessions, grouped.tasks).map((key) => ({
      key,
      sessions: this.withSessionOrder(this.sortSessions(grouped.sessions.get(key) ?? [])),
      tasks: sortBoardTasks(grouped.tasks.get(key) ?? []),
    }));
  }

  /** Group keys as shown: by activity (the user's order wins) or by name, no repository last. */
  private orderedRepoKeys(
    keys: Array<string | null>,
    groups: Map<string | null, Session[]>,
    tasks: Map<string | null, TaskRecord[]> = new Map()
  ): Array<string | null> {
    const repoKeys = keys.filter((key): key is string => key !== null);
    const byName = (a: string, b: string) => this.getRepoName(a).localeCompare(this.getRepoName(b));
    if (this.listSort === 'activity') {
      this.repoOrder = withManualOrder(
        this.stickyRepoOrder(repoKeys, groups, tasks),
        this.taskBoard.groupOrder
      );
      repoKeys.splice(0, repoKeys.length, ...this.repoOrder);
    } else {
      repoKeys.sort(byName);
    }
    return keys.includes(null) ? [...repoKeys, null] : repoKeys;
  }

  /**
   * By activity, the rows the user dragged into an order keep it, the others their place
   * (2026-11-07, withManualSessionOrder); sorted by name or project the sort menu wins.
   */
  protected withSessionOrder(sessions: Session[]): Session[] {
    return this.listSort === 'activity'
      ? withManualSessionOrder(sessions, this.taskBoard.sessionOrder)
      : sessions;
  }

  /** The last activity order of the repo groups, so live polling does not reshuffle them. */
  protected repoOrder: string[] = [];

  /**
   * Repo groups by activity, sticky (utils/project-groups.ts stickyGroupOrder): a group with a
   * session that needs you climbs; otherwise only a lead of more than two minutes moves it.
   */
  protected stickyRepoOrder(
    keys: string[],
    groups: Map<string | null, Session[]>,
    tasks: Map<string | null, TaskRecord[]> = new Map()
  ): string[] {
    const activity = new Map<string, number>();
    const needsYou = new Map<string, boolean>();
    for (const key of keys) {
      const group = groups.get(key) ?? [];
      const open = tasks.get(key) ?? [];
      activity.set(
        key,
        Math.max(
          0,
          ...group.map((s) => lastActivityAt(s) ?? 0),
          ...open.map((task) => Date.parse(task.stateSince || task.createdAt) || 0)
        )
      );
      needsYou.set(
        key,
        group.some((s) => deriveSessionStatus(s) === 'needs-input') || open.some(taskWantsUser)
      );
    }
    return stickyGroupOrder(keys, {
      activity,
      needsYou,
      previous: this.repoOrder,
      name: (key) => this.getRepoName(key),
    });
  }

  /** Within a group: needs you > working > idle, then the most recent activity (sort menu). */
  protected sortSessions(sessions: Session[]): Session[] {
    const rank: Record<string, number> = {
      'needs-input': 0,
      working: 1,
      idle: 2,
      'exited-error': 3,
      'exited-ok': 3,
    };
    const minute = (s: Session) => Math.floor((lastActivityAt(s) ?? 0) / 60_000);
    const started = (s: Session) => Date.parse(s.startedAt || '') || 0;
    const byActivity = (a: Session, b: Session) =>
      rank[deriveSessionStatus(a)] - rank[deriveSessionStatus(b)] ||
      minute(b) - minute(a) ||
      started(b) - started(a);
    const byName = (a: Session, b: Session) =>
      sessionDisplayName(a).localeCompare(sessionDisplayName(b));
    return [...sessions].sort((a, b) => {
      if (this.listSort === 'name') return byName(a, b);
      if (this.listSort === 'repo') {
        const ka = sessionRepoKey(a);
        const kb = sessionRepoKey(b);
        const byRepo =
          (ka ? 0 : 1) - (kb ? 0 : 1) ||
          (ka && kb ? this.getRepoName(ka).localeCompare(this.getRepoName(kb)) : 0);
        return byRepo || byActivity(a, b);
      }
      return byActivity(a, b);
    });
  }

  protected async handleFollowModeChange(repoPath: string, followBranch: string | undefined) {
    const previous = this.repoFollowMode.get(repoPath);
    // Stored without refs/heads/, as the server answers it (2026-11-10: the popover compared
    // that with the worktrees' full ref names and no branch was ever marked after a reload).
    this.repoFollowMode.set(repoPath, followBranch?.replace(/^refs\/heads\//, ''));
    this.closePopover();
    this.requestUpdate();

    try {
      const response = await fetch('/api/worktrees/follow', {
        method: HttpMethod.POST,
        headers: {
          'Content-Type': 'application/json',
          ...this.authClient.getAuthHeader(),
        },
        body: JSON.stringify({
          repoPath,
          branch: followBranch,
          enable: !!followBranch,
        }),
      });
      if (!response.ok) throw new Error('Failed to update follow mode');
      toast({
        kind: 'success',
        text: followBranch
          ? t('repoHeader.following', { branch: followBranch.replace(/^refs\/heads\//, '') })
          : t('repoHeader.follow.disabled'),
      });
    } catch (error) {
      logger.error('Error updating follow mode:', error);
      // The change was shown before the server confirmed it: put the old value back.
      this.repoFollowMode.set(repoPath, previous);
      this.requestUpdate();
      toast({ kind: 'error', text: t('repoHeader.follow.failed') });
    }
  }

  /** The repo chip (or the sidebar's "⋯"): one popover with follow branch and worktrees. */
  protected handleRepoMenu = (
    e: CustomEvent<{ repoPath: string; anchor: HTMLElement; folder?: boolean }>
  ) => {
    const { repoPath, anchor, folder } = e.detail;
    // The user asked: load (or retry) its worktrees now (a folder without git has none).
    if (!folder) void this.loadWorktreesForRepo(repoPath, true);
    this.openPopover(`repo:${repoPath}`, anchor, () => this.renderRepoPopover(repoPath, folder));
  };

  protected renderRepoPopover(repoPath: string, folder = false) {
    const pinned = this.isPinnedProject(repoPath);
    const pinItem = html`<button
      class="ut-menu-item"
      role="menuitem"
      data-testid="repo-pin"
      @click=${() => {
        this.closePopover();
        void this.setProjectPinned(repoPath, this.getRepoName(repoPath), !pinned);
      }}
    >
      ${icon(pinned ? 'pinOff' : 'pin')}${t(pinned ? 'board.unpinTop' : 'board.pinTop')}
    </button>${this.groupMoveActions(normalizeRepoPath(repoPath)).map(
      (action) => html`<button
        class="ut-menu-item"
        role="menuitem"
        data-testid=${action.testId}
        @click=${() => {
          this.closePopover();
          action.run();
        }}
      >
        ${icon(action.icon)}${action.label}
      </button>`
    )}`;
    // The project's actions here too: the compact sidebar's header has only this "⋯"
    // (2026-10-18 review: no way to orchestrate or open the settings there).
    const name = this.getRepoName(repoPath);
    const detail = { repoPath, name, ...(folder ? { folder: true } : {}) };
    const run = (fn: () => void) => () => {
      this.closePopover();
      fn();
    };
    const orchestratorId = this.runningOrchestratorFor(repoPath);
    const projectItems = html`<button
        class="ut-menu-item"
        role="menuitem"
        data-testid="repo-orchestrate"
        @click=${run(() =>
          this.handleProjectOrchestrate(
            new CustomEvent('project-orchestrate', {
              detail: { ...detail, sessionId: orchestratorId },
            })
          )
        )}
      >
        ${icon('sparkles')}${t(orchestratorId ? 'board.orchestrator' : 'board.orchestrate')}
      </button>
      <button
        class="ut-menu-item"
        role="menuitem"
        data-testid="repo-new-task"
        @click=${run(() =>
          this.handleProjectNewTask(new CustomEvent('project-new-task', { detail }))
        )}
      >
        ${icon('plus')}${t('board.newTaskIn', { name })}
      </button>
      ${
        folder
          ? nothing
          : html`<button
              class="ut-menu-item"
              role="menuitem"
              data-testid="repo-settings"
              @click=${run(() =>
                this.handleProjectSettings(new CustomEvent('project-settings', { detail }))
              )}
            >
              ${icon('settings')}${t('board.settings')}
            </button>`
      }`;
    if (folder) {
      return html`<div class="ut-menu ut-repo-pop" role="menu" data-testid="repo-popover">
        ${projectItems}${pinItem}
      </div>`;
    }
    const worktrees = this.repoWorktrees.get(repoPath) ?? [];
    const loading = this.loadingWorktrees.has(repoPath) && !worktrees.length;
    const followMode = this.repoFollowMode.get(repoPath);
    const clean = (branch: string) => branch.replace(/^refs\/heads\//, '');
    const main = normalizeRepoPath(repoPath);
    // Linked worktrees (not the main one): the branches the main checkout can follow.
    const linked = worktrees.filter(
      (wt) => normalizeRepoPath(wt.path) !== main && !wt.detached && wt.branch
    );
    const check = (on: boolean) =>
      on
        ? html`<span class="ut-check">${icon('check')}</span>`
        : html`<span class="ut-check"></span>`;
    return html`
      <div class="ut-menu ut-repo-pop" role="menu" data-testid="repo-popover">
        ${projectItems}${pinItem}
        <div class="ut-menu-sep"></div>
        ${
          linked.length
            ? html`
              <div class="ut-menu-label">${t('repoHeader.follow.title')}</div>
              <button
                class="ut-menu-item"
                role="menuitemradio"
                aria-checked=${followMode ? 'false' : 'true'}
                data-testid="follow-none"
                @click=${() => void this.handleFollowModeChange(repoPath, undefined)}
              >
                ${check(!followMode)}${t('repoHeader.follow.none')}
              </button>
              <div class="ut-repo-pop-help">${t('repoHeader.follow.help')}</div>
              ${linked.map(
                (wt) => html`<button
                  class="ut-menu-item"
                  role="menuitemradio"
                  aria-checked=${followMode === clean(wt.branch) ? 'true' : 'false'}
                  @click=${() => void this.handleFollowModeChange(repoPath, wt.branch)}
                >
                  ${check(followMode === clean(wt.branch))}<span class="ut-data truncate"
                    >${clean(wt.branch)}</span
                  >
                </button>`
              )}
              <div class="ut-menu-sep"></div>
            `
            : nothing
        }
        <div class="ut-menu-label">
          ${t('repoHeader.worktrees.title', { n: String(worktrees.length) })}
        </div>
        ${
          loading
            ? html`<div class="ut-repo-pop-help" style="padding-left:8px">
                <span class="ut-skeleton block h-3 w-40"></span>
              </div>`
            : worktrees.length === 0
              ? html`<div class="ut-repo-pop-help" style="padding-left:8px">
                  ${t('repoHeader.worktrees.empty')}
                </div>`
              : worktrees.map(
                  (wt) => html`<button
                    class="ut-menu-item ut-menu-item--two"
                    role="menuitem"
                    title=${`${t('repoHeader.worktrees.newHere')}: ${formatPathForDisplay(wt.path)}`}
                    @click=${() => this.createSessionInWorktree(wt.path)}
                  >
                    ${icon('gitBranch')}
                    <span class="ut-menu-item-text">
                      <span class="flex items-center gap-1.5 min-w-0">
                        ${
                          wt.detached
                            ? html`<span class="ut-chip" title=${t('git.detached')}
                                >${t('git.detached')}</span
                              >`
                            : html`<span class="ut-data truncate"
                                >${clean(wt.branch || 'HEAD')}</span
                              >`
                        }
                      </span>
                      <span class="ut-menu-item-sub">${formatPathForDisplay(wt.path)}</span>
                    </span>
                    <span class="ut-menu-trail">${icon('plus', 14)}</span>
                  </button>`
                )
        }
        <div class="ut-menu-sep"></div>
        <button
          class="ut-menu-item"
          role="menuitem"
          data-testid="repo-new-session"
          @click=${() => this.createSessionInWorktree(repoPath)}
        >
          ${icon('plus')}${t('repoHeader.worktrees.newHere')}
        </button>
      </div>
    `;
  }

  protected async loadWorktreesForRepo(repoPath: string, userRequested = false) {
    // Loaded ones are read again only when the user asks (opening the repo menu): worktrees
    // and follow mode changed outside the page stayed stale for the whole page life (2026-11-10).
    if (
      this.loadingWorktrees.has(repoPath) ||
      (this.repoWorktrees.has(repoPath) && !userRequested)
    ) {
      return;
    }
    // A repo whose worktrees failed to load was re-fetched on every session-list change
    // (7 repos x each 1 s poll = 7 requests/s); retry at most once a minute.
    const failedAt = this.worktreeFailures.get(repoPath);
    if (!userRequested && failedAt !== undefined && Date.now() - failedAt < WORKTREE_RETRY_MS) {
      return;
    }

    this.loadingWorktrees.add(repoPath);
    this.requestUpdate();

    try {
      const response = await fetch(`/api/worktrees?${new URLSearchParams({ repoPath })}`, {
        headers: this.authClient.getAuthHeader(),
      });

      if (response.ok) {
        const data = await response.json();
        this.repoWorktrees.set(repoPath, data.worktrees || []);
        // Also set follow mode from the worktrees API response
        this.repoFollowMode.set(repoPath, data.followBranch);
        this.worktreeFailures.delete(repoPath);
      } else {
        this.worktreeFailures.set(repoPath, Date.now());
        logger.error(`Failed to load worktrees for ${repoPath}`);
      }
    } catch (error) {
      this.worktreeFailures.set(repoPath, Date.now());
      logger.error('Error loading worktrees:', error);
    } finally {
      this.loadingWorktrees.delete(repoPath);
      this.requestUpdate();
    }
  }

  protected createSessionInWorktree(worktreePath: string) {
    this.closePopover(false);
    this.dispatchEvent(
      new CustomEvent('open-create-dialog', {
        detail: { workingDir: worktreePath },
        bubbles: true,
        composed: true,
      })
    );
  }

  /** Pinned projects with nothing in them (the empty home): their headers, actions included. */
  protected renderPinnedProjects(board: ProjectBoard) {
    const pinned = board.groups.filter((group) => group.pinned && group.key);
    if (!pinned.length) return nothing;
    return html`<section class="ut-section" data-testid="pinned-projects">
      <div class="session-flex-responsive">
        ${repeat(
          pinned,
          (group) => group.key ?? '',
          (group) => this.renderRepoHeader(group.key, [], false, !!group.folder)
        )}
      </div>
    </section>`;
  }

  protected renderRepoHeader(
    repoPath: string | null,
    sessions: Session[],
    compact = false,
    folder = false,
    /** Rows the group shows besides `sessions` (the sidebar's tasks), for its count. */
    taskCount = 0,
    /** The sidebar's header folds its group: whether it is folded, and what it folds. */
    fold?: { collapsed: boolean; bodyId: string }
  ) {
    const count = sessions.length + taskCount;
    // Its header drags the group to another place when the order is the user's (list-drag.ts).
    const dragKey =
      repoPath && this.shownGroups.keys.includes(normalizeRepoPath(repoPath))
        ? normalizeRepoPath(repoPath)
        : undefined;
    if (!repoPath) {
      return compact
        ? html`<div class="ut-repo-head ut-repo-head--compact" data-testid="repo-header-none">
            ${
              fold
                ? renderSideFoldToggle({
                    label: t('sessions.group.noRepo'),
                    collapsed: fold.collapsed,
                    bodyId: fold.bodyId,
                    toggle: () => void this.setGroupFolded(null, !fold.collapsed),
                  })
                : html`<span class="ut-section-label">${t('sessions.group.noRepo')}</span>`
            }
            ${count > 1 ? html`<span class="ut-repo-count">${count}</span>` : nothing}
          </div>`
        : html`<div class="ut-repo-head ut-grid-header" data-testid="repo-header-none">
            ${icon('folder', 14)}
            <span class="ut-repo-name">${t('sessions.group.noRepo')}</span>
            ${count > 1 ? html`<span class="ut-repo-count">${count}</span>` : nothing}
            <span class="ut-repo-rule"></span>
          </div>`;
    }
    const main = normalizeRepoPath(repoPath);
    const branches = sessions
      .filter((s) => !s.gitIsWorktree || normalizeRepoPath(s.gitRepoPath ?? '') === main)
      .map((s) => s.gitBranch)
      .filter(Boolean);
    const branch = branches[0] ?? sessions.find((s) => s.gitBranch)?.gitBranch ?? '';
    return html`<repository-header
      class=${compact ? '' : 'ut-grid-header'}
      data-drag-group=${dragKey ?? nothing}
      data-drag-label=${dragKey ? this.getRepoName(repoPath) : nothing}
      .repoPath=${repoPath}
      .label=${this.getRepoName(repoPath)}
      .count=${count}
      .branch=${branch}
      .followMode=${this.repoFollowMode.get(repoPath)}
      .open=${this.openPopoverKey === `repo:${repoPath}`}
      .compact=${compact}
      .taskActions=${!compact}
      .folder=${folder}
      .pinned=${this.isPinnedProject(repoPath)}
      .orchestratorSessionId=${this.runningOrchestratorFor(repoPath)}
      .notice=${this.projectNotice(repoPath)}
      .projectIcon=${this.projectIconFor(repoPath)}
      .foldable=${!!fold}
      .collapsed=${!!fold?.collapsed}
      .foldBodyId=${fold?.bodyId ?? ''}
      @project-fold=${this.handleProjectFold}
      @repo-menu=${this.handleRepoMenu}
      @project-orchestrate=${this.handleProjectOrchestrate}
      @project-new-task=${this.handleProjectNewTask}
      @project-settings=${this.handleProjectSettings}
    ></repository-header>${
      compact
        ? nothing
        : renderProjectNoticeBanner(this.projectNotice(repoPath), this.getRepoName(repoPath), {
            forget: () => this.forgetProject(repoPath, this.getRepoName(repoPath)),
            resume: () => void this.resumeMerges(repoPath, this.getRepoName(repoPath)),
            resuming: this.isResuming(repoPath),
          })
    }`;
  }

  /**
   * The board's groups for the desktop grid: by activity (sticky, needs-you first) or by name,
   * as the sort menu says; sessions sorted inside each, "No repository" last.
   */
  protected orderedBoardGroups(
    board: ProjectBoard
  ): Array<[string | null, Session[], TaskRecord[], boolean?]> {
    const groups = [...board.groups];
    if (this.listSort !== 'activity') {
      groups.sort((a, b) =>
        a.key === null
          ? 1
          : b.key === null
            ? -1
            : this.getRepoName(a.key).localeCompare(this.getRepoName(b.key))
      );
    }
    const orchestrators = this.orchestratorSessionIds();
    // A project's orchestrator first, as the phone pins it (2026-10-18 review).
    const orchestratorFirst = (sessions: Session[]) => [
      ...sessions.filter((session) => orchestrators.has(session.id)),
      ...sessions.filter((session) => !orchestrators.has(session.id)),
    ];
    return groups.map((group) => [
      group.key,
      this.withSessionOrder(orchestratorFirst(this.sortSessions(group.sessions))),
      group.tasks,
      !!group.folder,
    ]);
  }
}
