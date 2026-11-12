/**
 * Session list: project board, orchestrators and project actions (new task, pin, forget,
 * resume merges), plus task confirmations.
 */
import { html } from 'lit';
import { state } from 'lit/decorators.js';
import type { TaskRecord } from '../../../shared/tasks.js';
import type { Session } from '../../../shared/types.js';
import { t } from '../../i18n/index.js';
import type { ProjectNotice } from '../../services/task-store.js';
import { toast } from '../../utils/action-toast.js';
import { confirmDialog } from '../../utils/confirm-dialog.js';
import {
  type FoldSummary,
  foldKey,
  foldSummary,
  isFolded,
  withFolded,
} from '../../utils/group-fold.js';
import { lazyViews } from '../../utils/lazy-views.js';
import { isOnScreen } from '../../utils/on-screen.js';
import { formatPathForDisplay } from '../../utils/path-utils.js';
import { actionItems, PhoneActionSheet } from '../../utils/phone-action-sheet.js';
import {
  buildProjectBoard,
  moveGroupInOrder,
  type ProjectBoard,
  type ProjectGroup,
} from '../../utils/project-groups.js';
import { normalizeRepoPath } from '../../utils/repo-key.js';
import { isFinishedSession } from '../../utils/session-suspend.js';
import { visibleSessionTitle } from '../../utils/session-title.js';
import {
  isDoneTask,
  isOpenBoardTask,
  taskDisplayTitle,
  taskErrorText,
  taskReason,
} from '../../utils/task-status.js';
import type { TaskRow } from '../task-row.js';
import { SessionListBase } from './list-base.js';

export abstract class SessionListProjects extends SessionListBase {
  /** Implemented by the launch layer (list-launch.ts). */
  protected abstract openNewTask(repoPath?: string): void;
  /** Implemented by the launch layer (list-launch.ts). */
  protected abstract askRepos: Map<string, { repo: string | null; at: number }>;

  /** Projects whose «Reactivar» request is on its way (its button is disabled meanwhile). */
  @state() protected resumingProjects = new Set<string>();
  /** The phone board's group order, kept across polls (utils/project-groups.ts). */
  protected boardOrder: string[] = [];

  /**
   * The groups the layout on screen shows, in order ("Otras" left out), and the pinned ones
   * among them (always on top: they move among themselves). Empty when that layout's order is
   * not the user's to change (sorted by name, not grouped): no «Subir» / «Bajar» then.
   */
  protected shownGroups: { keys: string[]; pinned: Set<string> } = {
    keys: [],
    pinned: new Set(),
  };

  /** A layout says which groups it shows (see shownGroups). */
  protected noteShownGroups(groups: ReadonlyArray<{ key: string | null; pinned?: boolean }>) {
    const shown = groups.filter((group): group is { key: string; pinned?: boolean } => !!group.key);
    this.shownGroups = {
      keys: shown.map((group) => group.key),
      pinned: new Set(shown.filter((group) => group.pinned).map((group) => group.key)),
    };
  }

  /** The group next to `key` it can swap with (-1 above, 1 below), null at an end. */
  protected groupNeighbor(key: string, direction: -1 | 1): string | null {
    const { keys, pinned } = this.shownGroups;
    const at = keys.indexOf(key);
    const other = at < 0 ? undefined : keys[at + direction];
    return other !== undefined && pinned.has(other) === pinned.has(key) ? other : null;
  }

  /**
   * Move group `key` before or after `target` (null: last, above "Otras"), saved on the server
   * so every device shows the same order (TaskStore.saveGroupOrder, 2026-11-07).
   */
  protected async moveGroup(
    key: string,
    target: string | null,
    place: 'before' | 'after'
  ): Promise<boolean> {
    const next = moveGroupInOrder(
      this.taskBoard.groupOrder,
      this.shownGroups.keys,
      key,
      target,
      place
    );
    return this.saveGroupOrder(next);
  }

  /** Save a group order; says so when it fails (the one before it is back on screen). */
  protected async saveGroupOrder(order: readonly string[]): Promise<boolean> {
    const result = await this.taskBoard.store.saveGroupOrder(order);
    if (!result.ok) toast({ kind: 'error', text: t('groupPin.orderFailed') });
    return result.ok;
  }

  /** «Subir» / «Bajar» of a group's menu: what it shows for `key`, and what each does. */
  protected groupMoveActions(key: string): Array<{
    direction: -1 | 1;
    label: string;
    icon: 'arrowUp' | 'arrowDown';
    testId: string;
    run: () => void;
  }> {
    const actions = [];
    for (const direction of [-1, 1] as const) {
      const other = this.groupNeighbor(key, direction);
      if (!other) continue;
      actions.push({
        direction,
        label: t(direction < 0 ? 'groupPin.moveUp' : 'groupPin.moveDown'),
        icon: direction < 0 ? ('arrowUp' as const) : ('arrowDown' as const),
        testId: direction < 0 ? 'group-move-up' : 'group-move-down',
        run: () => void this.moveGroup(key, other, direction < 0 ? 'before' : 'after'),
      });
    }
    return actions;
  }

  /**
   * The tasks whose row is inside a folded group on screen now, with their group: «Abrir» on
   * one of them in «Te necesita» opens its project first (revealTask).
   */
  protected foldedTasks = new Map<string, string | null>();

  /** The sidebar group the user opened last: its rows come in with a short motion. */
  protected unfoldedGroup: string | null = null;

  /** The user folded this group (TaskStore.collapsedGroups: the same on every device). */
  protected isGroupFolded(key: string | null): boolean {
    return isFolded(this.taskBoard.collapsedGroups, key);
  }

  /** A layout shows this group folded: its tasks' rows are not on screen. */
  protected noteFoldedGroup(key: string | null, tasks: readonly TaskRecord[]) {
    for (const task of tasks) this.foldedTasks.set(task.id, key);
  }

  /**
   * Fold a group or open it again, saved on the server so it is remembered across reloads,
   * restarts and devices (2026-11-10). Shown at once; a failed save puts it back and says so.
   */
  protected async setGroupFolded(key: string | null, folded: boolean): Promise<boolean> {
    this.unfoldedGroup = folded ? null : foldKey(key);
    const result = await this.taskBoard.store.saveCollapsedGroups(
      withFolded(this.taskBoard.collapsedGroups, key, folded)
    );
    if (!result.ok) toast({ kind: 'error', text: t('fold.saveFailed') });
    return result.ok;
  }

  /** The chevron of a project's header (project-group, repository-header). */
  protected handleProjectFold = (
    e: CustomEvent<{ repoPath: string | null; collapsed: boolean }>
  ) => {
    e.stopPropagation();
    void this.setGroupFolded(e.detail.repoPath || null, e.detail.collapsed);
  };

  /** What a folded group holds, for its one line (utils/group-fold.ts). */
  protected groupFoldSummary(
    sessions: readonly Session[],
    tasks: readonly TaskRecord[]
  ): FoldSummary {
    return foldSummary({
      sessions,
      tasks,
      sessionsById: this.sessionsById(),
      closed: this.taskBoard.tasks.filter(isDoneTask),
    });
  }

  /** Search over what a task row shows: its title, prompt, branch, reason and files. */
  protected matchesTask(task: TaskRecord, rawQuery: string): boolean {
    const query = rawQuery.trim().toLowerCase();
    if (!query) return true;
    const session = task.sessionId
      ? this.sessions.find((entry) => entry.id === task.sessionId)
      : undefined;
    return [
      taskDisplayTitle(task, session),
      task.prompt,
      task.branch,
      taskReason(task),
      task.repoPath,
      ...task.files,
    ].some((field) => field?.toLowerCase().includes(query));
  }

  /** Tasks the search lets through (every task when not searching). */
  protected boardTasks(query = ''): TaskRecord[] {
    return this.taskBoard.tasks.filter((task) => this.matchesTask(task, query));
  }

  /** Open worktree tasks (on the board, not in "Hechas"). */
  protected liveTasks(query = ''): TaskRecord[] {
    return this.boardTasks(query).filter(isOpenBoardTask);
  }

  /** The board for `sessions` (rows to show, in order) and the tasks matching `query`. */
  protected projectBoard(sessions: Session[], query = '', remember = true): ProjectBoard {
    const board = buildProjectBoard({
      sessions,
      tasks: this.boardTasks(query),
      allSessions: this.sessions,
      worktrees: this.repoWorktrees,
      previousOrder: this.boardOrder,
      name: (key) => this.getRepoName(key),
      orchestrators: this.taskBoard.orchestrators,
      pinned: this.taskBoard.pinnedProjects,
      manualOrder: this.taskBoard.groupOrder,
      // Rows dragged into an order (2026-11-07): by activity only, as the groups.
      manualSessionOrder: this.listSort === 'activity' ? this.taskBoard.sessionOrder : [],
    });
    if (remember) this.boardOrder = board.order;
    return board;
  }

  protected groupName(group: ProjectGroup): string {
    return group.key ? this.getRepoName(group.key) : t('board.others');
  }

  /**
   * The branch a project's tasks merge into: theirs, else what its main checkout has out (a
   * session there), else what any of its sessions has.
   */
  protected groupBranch(group: ProjectGroup): string {
    // Not a task that merges into another task's branch (ut/…): 2026-10-18 the header read
    // "ut/etiqueta-…" and squeezed the project's name to "A…".
    const fromTask = group.tasks.find(
      (task) => task.baseBranch && !group.tasks.some((other) => other.branch === task.baseBranch)
    )?.baseBranch;
    if (fromTask) return fromTask;
    const main = group.key;
    const inMain = group.sessions.find(
      (session) =>
        session.gitBranch &&
        (!session.gitIsWorktree || normalizeRepoPath(session.gitRepoPath ?? '') === main)
    );
    return (
      inMain?.gitBranch ?? group.sessions.find((session) => session.gitBranch)?.gitBranch ?? ''
    );
  }

  /** "+ Tarea" in a project's header (a folder without git: version control first). */
  protected handleProjectNewTask = (
    e: CustomEvent<{ repoPath: string | null; name: string; folder?: boolean }>
  ) => {
    e.stopPropagation();
    const { repoPath, name, folder } = e.detail;
    if (folder && repoPath) {
      this.openGitInit(repoPath, name, 'task');
      return;
    }
    this.openNewTask(repoPath ?? undefined);
  };

  /**
   * A project folder without git (2026-10-18): the sheet that turns version control on, then
   * what the user tapped ("+ Tarea" → compose sheet, "Orquestar" → goal sheet) in the new repo.
   */
  protected openGitInit(folder: string, name: string, then: 'task' | 'orchestrate') {
    lazyViews.gitInitSheet.use(({ openGitInitSheet }) =>
      openGitInitSheet({
        folder,
        name,
        onActivated: (repoPath) => {
          this.adoptNewRepo(folder, repoPath);
          if (then === 'task') {
            this.openNewTask(repoPath);
          } else {
            lazyViews.orchestratorSheet.use(({ openOrchestratorSheet }) =>
              openOrchestratorSheet({
                repoPath,
                name,
                running: false,
                sessions: this.orchestratorCandidates(repoPath),
              })
            );
          }
        },
      })
    );
  }

  /**
   * A folder just became a repository: its sessions belong to it now. The server learns it on
   * the next list (its git cache is cleared); until then they are marked here, so the home
   * shows a project, not the stale folder group.
   */
  protected adoptNewRepo(folder: string, repoPath: string) {
    const root = normalizeRepoPath(folder);
    for (const session of this.sessions) {
      if (session.gitRepoPath || typeof session.workingDir !== 'string') continue;
      const dir = normalizeRepoPath(session.workingDir);
      if (dir !== root && !dir.startsWith(`${root}/`)) continue;
      session.gitRepoPath = repoPath;
      session.gitBranch = 'main';
    }
    this.askRepos.delete(formatPathForDisplay(folder));
    this.requestUpdate();
    this.dispatchEvent(new CustomEvent('refresh'));
  }

  /** The gear in a project's header: its task settings. */
  protected handleProjectSettings = (e: CustomEvent<{ repoPath: string | null; name: string }>) => {
    e.stopPropagation();
    const { repoPath, name } = e.detail;
    if (!repoPath) return;
    lazyViews.projectSettingsSheet.use(({ openProjectSettingsSheet }) =>
      openProjectSettingsSheet({ repoPath, name })
    );
  };

  /** The session of the project's running orchestrator (P7), if any. */
  protected orchestratorFor(repoKey: string | null): string | null {
    if (!repoKey) return null;
    const entry = this.taskBoard.orchestrators.find(
      (item) => normalizeRepoPath(item.repoPath) === repoKey
    );
    return entry?.sessionId ?? null;
  }

  /**
   * The project's open Claude sessions that could become its orchestrator (the goal sheet's
   * "O usa una sesión abierta"): running, Claude, grouped under the project, not a task's.
   */
  protected orchestratorCandidates(repoPath: string): Array<{ id: string; title: string }> {
    const key = normalizeRepoPath(repoPath);
    const running = this.sessions.filter((session) => !isFinishedSession(session));
    const group = this.projectBoard(running, '', false).groups.find((entry) => entry.key === key);
    return (group?.sessions ?? [])
      .filter((session) => !!session.claudeSessionId || !!session.claudeStatus)
      .map((session) => ({ id: session.id, title: visibleSessionTitle(session) }));
  }

  /** Its orchestrator's brief is still queued (GET /api/tasks `pending`). */
  protected orchestratorPendingFor(repoKey: string | null): boolean {
    if (!repoKey) return false;
    return this.taskBoard.orchestrators.some(
      (item) => item.pending === true && normalizeRepoPath(item.repoPath) === repoKey
    );
  }

  /** What GET /api/projects says about a project (folder gone or moved, merges paused). */
  protected projectNotice(repoPath: string | null): ProjectNotice | undefined {
    if (!repoPath) return undefined;
    const key = normalizeRepoPath(repoPath);
    return this.taskBoard.projects.find((entry) => normalizeRepoPath(entry.repoPath) === key);
  }

  /** The project's app icon (TaskStore.iconFor), null without one or until it has loaded. */
  protected projectIconFor(repoPath: string | null): string | null {
    return this.taskBoard.iconFor(this.projectNotice(repoPath)?.repoPath ?? null);
  }

  /** An orchestrator session's project app icon; null for any other session. */
  protected orchestratorIconFor(sessionId: string): string | null {
    const entry = this.taskBoard.orchestrators.find((item) => item.sessionId === sessionId);
    return entry ? this.projectIconFor(entry.repoPath) : null;
  }

  /**
   * "Olvidar" on a project whose folder is gone: DELETE /api/projects?repo= drops its settings,
   * pin and orchestrator, then the board is read again. Refused (409 `open-tasks`) while it
   * still has open tasks: those are finished or discarded first.
   */
  protected async forgetProject(repoPath: string, name: string) {
    const ok = await confirmDialog({
      title: t('board.forgetTitle', { name }),
      body: t('board.forgetBody'),
      confirmLabel: t('board.forgetProject'),
    });
    if (!ok) return;
    const result = await this.taskBoard.store.forgetProject(repoPath);
    if (result.ok) {
      toast({ kind: 'success', text: t('board.forgotToast', { name }) });
      void this.taskBoard.store.refresh();
      return;
    }
    toast({
      kind: 'error',
      text:
        result.error === 'open-tasks'
          ? t('board.forgetOpenTasks')
          : t('board.toast.failed', { error: taskErrorText(result) }),
    });
  }

  /** "Reactivar": automatic merges back on (the pause cleared); one request at a time. */
  protected async resumeMerges(repoPath: string, name: string) {
    const key = normalizeRepoPath(repoPath);
    if (this.resumingProjects.has(key)) return;
    this.resumingProjects = new Set([...this.resumingProjects, key]);
    try {
      const result = await this.taskBoard.store.setProjectSettings(repoPath, {
        autoMergePausedUntil: null,
      });
      toast(
        result.ok && result.status === 202
          ? { kind: 'info', text: t('board.toast.pending') }
          : result.ok
            ? { kind: 'success', text: t('board.mergesResumed', { name }) }
            : {
                kind: 'error',
                text: t('board.toast.failed', { error: taskErrorText(result) }),
              }
      );
    } finally {
      const next = new Set(this.resumingProjects);
      next.delete(key);
      this.resumingProjects = next;
    }
  }

  protected isResuming(repoPath: string | null): boolean {
    return !!repoPath && this.resumingProjects.has(normalizeRepoPath(repoPath));
  }

  protected handleProjectForget = (e: CustomEvent<{ repoPath: string | null; name: string }>) => {
    e.stopPropagation();
    if (e.detail.repoPath) void this.forgetProject(e.detail.repoPath, e.detail.name);
  };

  protected handleProjectResumeMerges = (
    e: CustomEvent<{ repoPath: string | null; name: string }>
  ) => {
    e.stopPropagation();
    if (e.detail.repoPath) void this.resumeMerges(e.detail.repoPath, e.detail.name);
  };

  /** Whether the project is pinned on top of the home. */
  protected isPinnedProject(repoPath: string): boolean {
    const key = normalizeRepoPath(repoPath);
    return this.taskBoard.pinnedProjects.some((entry) => normalizeRepoPath(entry.repoPath) === key);
  }

  /** Pin a project on top of the home, or unpin it (kept on the server: every device). */
  protected async setProjectPinned(repoPath: string, name: string, pinned: boolean) {
    const result = await this.taskBoard.store.pinProject(repoPath, pinned);
    toast(
      result.ok
        ? {
            kind: 'success',
            text: t(pinned ? 'board.pinnedToast' : 'board.unpinnedToast', { name }),
          }
        : {
            kind: 'error',
            text: t('board.pinFailed', { error: result.message || result.error || '' }),
          }
    );
  }

  /** The phone's project name: its menu, "Fijar arriba" / "Quitar de arriba". */
  protected handleProjectMenu = (
    e: CustomEvent<{ repoPath: string | null; name: string; pinned?: boolean }>
  ) => {
    e.stopPropagation();
    const { repoPath, name, pinned } = e.detail;
    if (!repoPath) return;
    const key = normalizeRepoPath(repoPath);
    this.closeSheet();
    const sheet = new PhoneActionSheet({
      label: t('board.projectMenu', { name }),
      opener: document.activeElement,
    });
    this.sheet = sheet;
    sheet.open(
      (
        s
      ) => html`<div class="psr-sheet-group ut-surface--floating ut-surface--material" data-testid="project-menu-sheet">
        <div class="psr-sheet-title">${name}</div>
        ${actionItems(s, [
          {
            label: t(pinned ? 'board.unpinTop' : 'board.pinTop'),
            icon: pinned ? 'pinOff' : 'pin',
            testId: 'project-pin',
            run: () => void this.setProjectPinned(repoPath, name, !pinned),
          },
          ...this.groupMoveActions(key).map(({ label, icon, testId, run }) => ({
            label,
            icon,
            testId,
            run,
          })),
        ])}
      </div>`
    );
  };

  /** The running orchestrators' sessions. */
  protected orchestratorSessionIds(): Set<string> {
    return new Set(this.taskBoard.orchestrators.map((entry) => entry.sessionId));
  }

  /** The running orchestrator's session for the desktop header ("Orquestador"), if any. */
  protected runningOrchestratorFor(repoPath: string | null): string | null {
    const id = this.orchestratorFor(repoPath ? normalizeRepoPath(repoPath) : null);
    const session = id ? this.sessions.find((entry) => entry.id === id) : undefined;
    return session && !isFinishedSession(session) ? session.id : null;
  }

  /**
   * "Orquestar": the goal sheet. With an orchestrator running: open it, give it a new goal,
   * or stop it (its tasks go on).
   */
  protected handleProjectOrchestrate = (
    e: CustomEvent<{
      repoPath: string | null;
      name: string;
      sessionId?: string | null;
      folder?: boolean;
    }>
  ) => {
    e.stopPropagation();
    const { repoPath, name, sessionId, folder } = e.detail;
    if (!repoPath) return;
    if (folder) {
      this.openGitInit(repoPath, name, 'orchestrate');
      return;
    }
    const goalSheet = (running: boolean) =>
      lazyViews.orchestratorSheet.use(({ openOrchestratorSheet }) =>
        openOrchestratorSheet({
          repoPath,
          name,
          running,
          sessions: running ? [] : this.orchestratorCandidates(repoPath),
        })
      );
    if (!sessionId) {
      goalSheet(false);
      return;
    }
    // A session the user made the orchestrator stays open when it stops orchestrating.
    const adopted = this.taskBoard.orchestrators.some(
      (entry) => entry.sessionId === sessionId && entry.adopted
    );
    const stop = async () => {
      const result = await this.taskBoard.store.stopOrchestrator(repoPath);
      toast(
        result.ok
          ? { kind: 'success', text: t(adopted ? 'orch.stoppedAdopted' : 'orch.stopped', { name }) }
          : {
              kind: 'error',
              text: t('orch.stopFailed', { error: result.message || result.error || '' }),
            }
      );
    };
    this.closeSheet();
    const sheet = new PhoneActionSheet({
      label: t('orch.menuTitle', { name }),
      opener: document.activeElement,
    });
    this.sheet = sheet;
    sheet.open(
      (
        s
      ) => html`<div class="psr-sheet-group ut-surface--floating ut-surface--material" data-testid="orchestrator-menu">
        <div class="psr-sheet-title">${t('orch.menuTitle', { name })}</div>
        ${actionItems(s, [
          {
            label: t('orch.open'),
            icon: 'chat',
            testId: 'orchestrator-open',
            run: () =>
              this.dispatchEvent(
                new CustomEvent('navigate-to-session', {
                  detail: { sessionId },
                  bubbles: true,
                  composed: true,
                })
              ),
          },
          {
            label: t('orch.newGoal'),
            icon: 'sparkles',
            testId: 'orchestrator-new-goal',
            run: () => goalSheet(true),
          },
          {
            label: t(adopted ? 'orch.stopAdopted' : 'orch.stop'),
            icon: 'stop',
            destructive: true,
            keepOpen: true,
            testId: 'orchestrator-stop',
            run: () =>
              s.step(
                (confirm) => html`<div
                  class="psr-sheet-group ut-surface--floating ut-surface--material"
                  data-testid="orchestrator-stop-confirm"
                >
                  <div class="psr-sheet-title">
                    ${t(adopted ? 'orch.stopAdoptedQuestion' : 'orch.stopQuestion')}
                  </div>
                  ${actionItems(confirm, [
                    {
                      label: t('orch.stopConfirm'),
                      destructive: true,
                      testId: 'orchestrator-stop-yes',
                      run: () => void stop(),
                    },
                  ])}
                </div>`
              ),
          },
        ])}
      </div>`
    );
  };

  /** An action waiting for the user's OK: the confirm sheet its push opens (app.ts). */
  protected openConfirmation(id: string) {
    window.dispatchEvent(new CustomEvent('ut-open-task-confirm', { detail: { id } }));
  }

  /**
   * The confirmations and tasks the needs-you strip shows on screen now (SEEN frames): an
   * important push about one of them is not sent while the user is looking at it
   * (server/services/agent-attention-policy.ts). A list hidden behind a session, or a pill
   * scrolled out of the strip or the page, does not count (utils/on-screen.ts).
   */
  protected visibleSeenKeys = (): string[] =>
    [...this.querySelectorAll<HTMLElement>('[data-seen-key]')]
      .filter((el) => isOnScreen(el))
      .map((el) => el.dataset.seenKey ?? '');

  /**
   * The needs-you strip pointed at a task: bring its row into view and make it glow. Inside a
   * folded project there is no row: the project opens first (and stays open: the user asked to
   * see what is in it).
   */
  protected async revealTask(taskId: string) {
    const find = () => this.querySelector<TaskRow>(`task-row[data-task="${CSS.escape(taskId)}"]`);
    if (!find() && this.foldedTasks.has(taskId)) {
      void this.setGroupFolded(this.foldedTasks.get(taskId) ?? null, false);
      await this.rowsRendered();
    }
    find()?.reveal();
  }

  /** The list and its phone projects (which render on their own update) are on screen. */
  protected async rowsRendered() {
    await this.updateComplete;
    await Promise.all(
      [...this.querySelectorAll('project-group')].map(
        (group) => (group as unknown as { updateComplete?: Promise<unknown> }).updateComplete
      )
    );
  }
}
