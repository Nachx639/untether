/**
 * The tasks the home board shows (GET /api/tasks), polled every 3 s while a list is on screen
 * and the page is visible (utils/visibility-poller.ts). Kept apart from the sessions poll on
 * purpose: app.ts compares sessions field by field, and tasks change on their own clock.
 *
 * The same answer lists the projects' running orchestrators (P7): the board pins their sessions.
 *
 * Listeners hear only real changes (the JSON differs). Actions post to /api/tasks/:id/<op>
 * and poll at once, so a tapped "Fusionar" shows «fusionando» without waiting for the timer.
 */
import type { ReactiveController, ReactiveControllerHost } from 'lit';
import type { TaskConfirmation } from '../../shared/task-confirmations.js';
import type { TaskRecord } from '../../shared/tasks.js';
import { VisibilityPoller } from '../utils/visibility-poller.js';
import { authClient } from './auth-client.js';

export const TASK_POLL_MS = 3000;
/**
 * A poll that has not answered by then failed (2026-10-20 review: after a Wi-Fi ↔ cellular
 * switch a request on the old connection hung forever, and the polls behind it with it).
 */
export const TASK_FETCH_TIMEOUT_MS = 8000;

export type TaskOp =
  | 'hold'
  /** Fast lane: { level: 'urgent' | 'normal' }. */
  | 'priority'
  /** More budget ({ change: '+1h' …; '' = +50% of the limits it reached}), 2026-11-01. */
  | 'budget'
  | 'merge'
  | 'verify'
  | 'fix'
  | 'retry'
  /** A queued task's place in its project's line ({ position }, 1 = next). */
  | 'move'
  | 'discard'
  | 'keep'
  | 'send'
  /** A merged task: a new task that reverts it (answers { task }). */
  | 'revert';

export interface TaskActionResult {
  ok: boolean;
  /** HTTP status (202: waiting for the user's OK; 409: e.g. needs-confirmation). */
  status: number;
  /** The server's error code or message when not ok. */
  error?: string;
  message?: string;
  data?: Record<string, unknown>;
}

/** A project pinned on top of the home (GET /api/tasks `pinnedProjects`). */
export interface PinnedProject {
  repoPath: string;
  /** False for a project folder without git yet. */
  git: boolean;
}

/** A project's running orchestrator (GET /api/tasks `orchestrators`). */
export interface OrchestratorEntry {
  repoPath: string;
  sessionId: string;
  /** A session the user made the orchestrator: stopping leaves it open. */
  adopted?: boolean;
  /** Its brief is queued, not typed in yet («Preparando…»). */
  pending?: boolean;
}

/**
 * What the board shows about a project from GET /api/projects (2026-10-20): its folder gone,
 * moved, or its automatic merges paused. Read leniently: every field may be missing.
 */
export interface ProjectNotice {
  repoPath: string;
  /** Its folder is gone and was not found elsewhere, since when. */
  missingSince?: string;
  /** Where it was before the server followed it here. */
  movedFrom?: string;
  movedAt?: string;
  /** Automatic merges paused until then, and why (recent merges reverted or failing). */
  autoMergePausedUntil?: string;
  /** The server's own English reason: logged, never shown (see autoMergePausedCode). */
  autoMergePausedReason?: string;
  /** Why it paused, as a code the board words itself: 'reverts' | 'failures'. */
  autoMergePausedCode?: string;
  /** How many tasks were undone or still failed (the number in that sentence). */
  autoMergePausedCount?: number;
  /** The project's icon (a path in it), picked by its orchestrator: GET /api/projects/icon. */
  icon?: string;
}

/** Where the app reads a project's icon; the path makes a changed icon a new URL. */
export function projectIconPath(project: Pick<ProjectNotice, 'repoPath' | 'icon'>): string | null {
  if (!project.icon) return null;
  return `/api/projects/icon?repo=${encodeURIComponent(project.repoPath)}&v=${encodeURIComponent(project.icon)}`;
}

/** Projects are read every this many task polls (GET /api/projects also follows moves). */
const PROJECTS_EVERY = 10;

function projectNotice(entry: unknown): ProjectNotice | null {
  if (!entry || typeof entry !== 'object') return null;
  const { repoPath, settings } = entry as { repoPath?: unknown; settings?: unknown };
  if (typeof repoPath !== 'string') return null;
  const values = (settings && typeof settings === 'object' ? settings : {}) as Record<
    string,
    unknown
  >;
  const text = (key: string) =>
    typeof values[key] === 'string' ? (values[key] as string) : undefined;
  const notice: ProjectNotice = { repoPath };
  for (const key of [
    'missingSince',
    'movedFrom',
    'movedAt',
    'autoMergePausedUntil',
    'autoMergePausedReason',
    'icon',
  ] as const) {
    const value = text(key);
    if (value) notice[key] = value;
  }
  const code = text('autoMergePausedCode');
  if (code) notice.autoMergePausedCode = code;
  const count = values.autoMergePausedCount;
  if (typeof count === 'number' && Number.isFinite(count)) notice.autoMergePausedCount = count;
  return notice;
}

export class TaskStore {
  private records: TaskRecord[] = [];
  private orchestratorList: OrchestratorEntry[] = [];
  private pinnedList: PinnedProject[] = [];
  private confirmationList: TaskConfirmation[] = [];
  private projectList: ProjectNotice[] = [];
  private projectsJson = '';
  private groupOrderList: string[] = [];
  private sessionOrderList: string[] = [];
  private collapsedList: string[] = [];
  /** Order saves on their way: a poll meanwhile does not bring the old order back. */
  private orderSaving = 0;
  private pollCount = 0;
  private json = '';
  private hasLoaded = false;
  private readonly listeners = new Set<() => void>();
  private readonly poller = new VisibilityPoller({
    task: () => this.poll(),
    nextDelay: () => TASK_POLL_MS,
  });

  constructor(
    private readonly headers: () => Record<string, string> = () => authClient.getAuthHeader()
  ) {}

  /** Every task the server lists (scheduled, open and recent). */
  get tasks(): readonly TaskRecord[] {
    return this.records;
  }

  /** Projects' running orchestrators. */
  get orchestrators(): readonly OrchestratorEntry[] {
    return this.orchestratorList;
  }

  /** Projects pinned on top of the home, the first pinned first. */
  get pinnedProjects(): readonly PinnedProject[] {
    return this.pinnedList;
  }

  /**
   * The home's group order the user chose (GET /api/tasks `groupOrder`, 2026-11-07): the same
   * on every device. Empty: the automatic order.
   */
  get groupOrder(): readonly string[] {
    return this.groupOrderList;
  }

  /** Put a group order in (the poll, a save, tests); listeners hear a change. */
  setGroupOrder(order: readonly string[]): void {
    if (JSON.stringify(order) === JSON.stringify(this.groupOrderList)) return;
    this.groupOrderList = [...order];
    for (const listener of this.listeners) listener();
  }

  /** PUT /api/projects/group-order: shown at once; a failed save puts the one before it back. */
  saveGroupOrder(order: readonly string[]): Promise<TaskActionResult> {
    return this.saveOrder('/api/projects/group-order', order, this.groupOrderList, (next) =>
      this.setGroupOrder(next)
    );
  }

  /**
   * The order of the sessions inside their groups the user chose (GET /api/tasks
   * `sessionOrder`, 2026-11-07: dragging a row up or down): session ids, the same on every
   * device. Empty: the automatic order.
   */
  get sessionOrder(): readonly string[] {
    return this.sessionOrderList;
  }

  /** Put a session order in (the poll, a save, tests); listeners hear a change. */
  setSessionOrder(order: readonly string[]): void {
    if (JSON.stringify(order) === JSON.stringify(this.sessionOrderList)) return;
    this.sessionOrderList = [...order];
    for (const listener of this.listeners) listener();
  }

  /** PUT /api/projects/session-order, as saveGroupOrder. */
  saveSessionOrder(order: readonly string[]): Promise<TaskActionResult> {
    return this.saveOrder('/api/projects/session-order', order, this.sessionOrderList, (next) =>
      this.setSessionOrder(next)
    );
  }

  /**
   * The groups the user folded in the phone list and the sidebar (GET /api/tasks
   * `collapsedGroups`, 2026-11-10): group keys, FOLDED_OTHERS for "Otras"; the same on every
   * device. Empty: every group open.
   */
  get collapsedGroups(): readonly string[] {
    return this.collapsedList;
  }

  /** Put the folded groups in (the poll, a save, tests); listeners hear a change. */
  setCollapsedGroups(collapsed: readonly string[]): void {
    if (JSON.stringify(collapsed) === JSON.stringify(this.collapsedList)) return;
    this.collapsedList = [...collapsed];
    for (const listener of this.listeners) listener();
  }

  /** PUT /api/projects/collapsed-groups, as saveGroupOrder. */
  saveCollapsedGroups(collapsed: readonly string[]): Promise<TaskActionResult> {
    return this.saveOrder(
      '/api/projects/collapsed-groups',
      collapsed,
      this.collapsedList,
      (next) => this.setCollapsedGroups(next),
      'collapsed'
    );
  }

  private async saveOrder(
    url: string,
    order: readonly string[],
    before: readonly string[],
    set: (order: readonly string[]) => void,
    /** The list's name in the request and in its answer. */
    field: 'order' | 'collapsed' = 'order'
  ): Promise<TaskActionResult> {
    set(order);
    this.orderSaving++;
    let result: TaskActionResult;
    try {
      result = await this.request(url, 'PUT', { [field]: [...order] });
    } finally {
      this.orderSaving--;
    }
    const saved = result.data?.[field];
    if (!result.ok) set(before);
    else if (Array.isArray(saved)) {
      set(saved.filter((key): key is string => typeof key === 'string'));
    }
    return result;
  }

  /** Actions an agent asked for that wait for the user's OK. */
  get confirmations(): readonly TaskConfirmation[] {
    return this.confirmationList;
  }

  /** What GET /api/projects says about each project (missing, moved, merges paused). */
  get projects(): readonly ProjectNotice[] {
    return this.projectList;
  }

  /** Put project notices in directly (tests, or after a change). */
  setProjects(projects: readonly ProjectNotice[]): void {
    const json = JSON.stringify(projects);
    if (json === this.projectsJson) return;
    this.projectsJson = json;
    this.projectList = [...projects];
    for (const listener of this.listeners) listener();
  }

  /** The first answer came (tasks or not). */
  get loaded(): boolean {
    return this.hasLoaded;
  }

  /** Listen for changes; the first listener starts polling, the last one stops it. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    if (this.listeners.size === 1) {
      this.poller.start();
      void this.poller.pollNow();
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.poller.stop();
    };
  }

  /** Poll now (after an action, or a push about a task). */
  refresh(): Promise<void> {
    return this.poller.pollNow();
  }

  /** Put tasks in directly (tests, or a task the server just answered with). */
  set(
    tasks: readonly TaskRecord[],
    orchestrators: readonly OrchestratorEntry[] = [],
    pinnedProjects: readonly PinnedProject[] = [],
    confirmations: readonly TaskConfirmation[] = []
  ): void {
    const json = JSON.stringify([tasks, orchestrators, pinnedProjects, confirmations]);
    this.hasLoaded = true;
    if (json === this.json) return;
    this.json = json;
    this.records = [...tasks];
    this.orchestratorList = [...orchestrators];
    this.pinnedList = [...pinnedProjects];
    this.confirmationList = [...confirmations];
    for (const listener of this.listeners) listener();
  }

  /** Back to empty, nobody listening (tests). */
  reset(): void {
    this.poller.stop();
    this.listeners.clear();
    for (const entry of this.icons.values()) URL.revokeObjectURL(entry.url);
    this.icons.clear();
    this.iconsMissing.clear();
    this.records = [];
    this.orchestratorList = [];
    this.pinnedList = [];
    this.confirmationList = [];
    this.projectList = [];
    this.projectsJson = '';
    this.groupOrderList = [];
    this.sessionOrderList = [];
    this.collapsedList = [];
    this.orderSaving = 0;
    this.pollCount = 0;
    this.json = '';
    this.hasLoaded = false;
  }

  /**
   * Project icons as blob URLs: an `<img>` can't carry the login header, so each icon is
   * fetched with it once (per project and path) and shown from memory.
   */
  private icons = new Map<string, { path: string; url: string }>();
  private iconsLoading = new Set<string>();
  /**
   * Icons the server answered 404 for, by project: not asked again until the project's icon
   * changes (2026-11-10: a missing icon was fetched again on every projects poll).
   */
  private iconsMissing = new Map<string, string>();

  /** The icon of the project at `repoPath`, once loaded; null without one. */
  iconFor(repoPath: string | null): string | null {
    if (!repoPath) return null;
    const project = this.projectList.find((entry) => entry.repoPath === repoPath);
    const cached = this.icons.get(repoPath);
    return project?.icon && cached?.path === project.icon ? cached.url : null;
  }

  private async loadIcons(): Promise<void> {
    // Blob URLs of projects that are gone were never revoked (2026-11-10).
    const present = new Set(this.projectList.map((project) => project.repoPath));
    for (const [repoPath, entry] of this.icons) {
      if (present.has(repoPath)) continue;
      URL.revokeObjectURL(entry.url);
      this.icons.delete(repoPath);
      this.iconsMissing.delete(repoPath);
    }
    for (const project of this.projectList) {
      const path = projectIconPath(project);
      const cached = this.icons.get(project.repoPath);
      if (!path || !project.icon || cached?.path === project.icon) continue;
      if (this.iconsMissing.get(project.repoPath) === project.icon) continue;
      if (this.iconsLoading.has(path)) continue;
      this.iconsLoading.add(path);
      try {
        const response = await fetch(path, { headers: this.headers() });
        if (!response.ok) {
          if (response.status === 404) this.iconsMissing.set(project.repoPath, project.icon);
          continue;
        }
        const url = URL.createObjectURL(await response.blob());
        if (cached) URL.revokeObjectURL(cached.url);
        this.icons.set(project.repoPath, { path: project.icon, url });
        for (const listener of this.listeners) listener();
      } catch {
        // Offline or gone: the plain avatar stays.
      } finally {
        this.iconsLoading.delete(path);
      }
    }
  }

  /** GET /api/projects: the notices of every project (kept as they are on a failure). */
  async loadProjects(): Promise<void> {
    try {
      const response = await fetch('/api/projects', {
        headers: this.headers(),
        signal: AbortSignal.timeout(TASK_FETCH_TIMEOUT_MS),
      });
      if (!response.ok) return;
      const body = (await response.json().catch(() => null)) as { projects?: unknown } | null;
      if (!body || !Array.isArray(body.projects)) return;
      this.setProjects(
        body.projects.map(projectNotice).filter((entry): entry is ProjectNotice => !!entry)
      );
      void this.loadIcons();
    } catch {
      // Offline: what is shown stays.
    }
  }

  private async poll(): Promise<boolean> {
    // Projects change rarely (a folder moved or gone, merges paused): every few polls.
    if (this.pollCount++ % PROJECTS_EVERY === 0) void this.loadProjects();
    let response: Response;
    try {
      response = await fetch('/api/tasks', {
        headers: this.headers(),
        signal: AbortSignal.timeout(TASK_FETCH_TIMEOUT_MS),
      });
    } catch {
      return false;
    }
    // 503 while the scheduler starts, 404/401 from a server without tasks or a lost login:
    // keep what is shown.
    if (!response.ok) return false;
    const body = (await response.json().catch(() => null)) as {
      tasks?: unknown;
      orchestrators?: unknown;
      pinnedProjects?: unknown;
      confirmations?: unknown;
      groupOrder?: unknown;
      sessionOrder?: unknown;
      collapsedGroups?: unknown;
    } | null;
    if (!body || !Array.isArray(body.tasks)) return false;
    if (!this.orderSaving) {
      if (Array.isArray(body.groupOrder)) {
        this.setGroupOrder(body.groupOrder.filter((key): key is string => typeof key === 'string'));
      }
      if (Array.isArray(body.sessionOrder)) {
        this.setSessionOrder(
          body.sessionOrder.filter((key): key is string => typeof key === 'string')
        );
      }
      if (Array.isArray(body.collapsedGroups)) {
        this.setCollapsedGroups(
          body.collapsedGroups.filter((key): key is string => typeof key === 'string')
        );
      }
    }
    const before = this.json;
    this.set(
      body.tasks as TaskRecord[],
      Array.isArray(body.orchestrators) ? (body.orchestrators as OrchestratorEntry[]) : [],
      Array.isArray(body.pinnedProjects)
        ? body.pinnedProjects.filter(
            (entry): entry is PinnedProject =>
              typeof entry?.repoPath === 'string' && typeof entry?.git === 'boolean'
          )
        : [],
      Array.isArray(body.confirmations)
        ? body.confirmations.filter(
            (entry): entry is TaskConfirmation =>
              typeof entry?.id === 'string' && typeof entry?.where === 'string'
          )
        : []
    );
    return this.json !== before;
  }

  private async request(
    url: string,
    method: string,
    body?: Record<string, unknown>
  ): Promise<TaskActionResult> {
    try {
      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', ...this.headers() },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (response.ok) return { ok: true, status: response.status, data };
      return {
        ok: false,
        status: response.status,
        error: typeof data.error === 'string' ? data.error : response.statusText,
        message: typeof data.message === 'string' ? data.message : undefined,
        data,
      };
    } catch (error) {
      return {
        ok: false,
        status: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      void this.refresh();
    }
  }

  /** POST /api/tasks/:id/<op>. */
  act(id: string, op: TaskOp, body: Record<string, unknown> = {}): Promise<TaskActionResult> {
    return this.request(`/api/tasks/${encodeURIComponent(id)}/${op}`, 'POST', body);
  }

  /** GET /api/tasks/:id/log: the tail of its setup, check or merge log. */
  log(id: string, kind: 'setup' | 'verify' | 'merge'): Promise<TaskActionResult> {
    return this.request(`/api/tasks/${encodeURIComponent(id)}/log?kind=${kind}&lines=120`, 'GET');
  }

  /** Cancel a scheduled task (DELETE /api/tasks/:id). */
  cancel(id: string): Promise<TaskActionResult> {
    return this.request(`/api/tasks/${encodeURIComponent(id)}`, 'DELETE');
  }

  /** POST /api/projects/orchestrator: start the project's orchestrator with a goal. */
  startOrchestrator(repoPath: string, goal: string): Promise<TaskActionResult> {
    return this.request('/api/projects/orchestrator', 'POST', { repoPath, goal });
  }

  /** POST /api/projects/orchestrator/adopt: an open session becomes the orchestrator. */
  adoptOrchestrator(repoPath: string, sessionId: string, goal = ''): Promise<TaskActionResult> {
    return this.request('/api/projects/orchestrator/adopt', 'POST', {
      repoPath,
      sessionId,
      ...(goal.trim() ? { goal: goal.trim() } : {}),
    });
  }

  /** GET /api/projects/new: where «Dónde» starts (the last parent picked, else home). */
  newProjectStart(): Promise<TaskActionResult> {
    return this.request('/api/projects/new', 'GET');
  }

  /**
   * POST /api/projects/new: a project in one step (folder, git, first commit, pinned; with a
   * goal its orchestrator starts). The board is read again after it.
   */
  async createProject(input: {
    name: string;
    dir: string;
    goal?: string;
  }): Promise<TaskActionResult> {
    const result = await this.request('/api/projects/new', 'POST', {
      name: input.name,
      dir: input.dir,
      ...(input.goal?.trim() ? { goal: input.goal.trim() } : {}),
    });
    await this.loadProjects();
    return result;
  }

  /** POST /api/projects/pin: pin a project on top of the home, or unpin it. */
  async pinProject(repoPath: string, pinned: boolean): Promise<TaskActionResult> {
    const result = await this.request('/api/projects/pin', 'POST', { repoPath, pinned });
    void this.loadProjects();
    return result;
  }

  /**
   * DELETE /api/projects?repo=: forget a project (its settings, pin and orchestrator). 409
   * `open-tasks` while it still has open tasks. The board is read again after it.
   */
  async forgetProject(repoPath: string): Promise<TaskActionResult> {
    const result = await this.request(
      `/api/projects?repo=${encodeURIComponent(repoPath)}`,
      'DELETE'
    );
    await this.loadProjects();
    return result;
  }

  /** PUT /api/projects/settings: change some of a project's settings (null clears one). */
  async setProjectSettings(
    repoPath: string,
    settings: Record<string, unknown>
  ): Promise<TaskActionResult> {
    const result = await this.request('/api/projects/settings', 'PUT', { repoPath, settings });
    void this.loadProjects();
    return result;
  }

  /** DELETE /api/projects/orchestrator: stop it (its tasks go on). */
  stopOrchestrator(repoPath: string): Promise<TaskActionResult> {
    return this.request(
      `/api/projects/orchestrator?repo=${encodeURIComponent(repoPath)}`,
      'DELETE'
    );
  }

  /** POST /api/tasks: start (or schedule) one task or a parallel group. */
  create(body: Record<string, unknown>): Promise<TaskActionResult> {
    return this.request('/api/tasks', 'POST', body);
  }
}

export const taskStore = new TaskStore();

/** Re-renders its host whenever the tasks change, polling while the host is connected. */
export class TaskStoreController implements ReactiveController {
  private off: (() => void) | null = null;

  constructor(
    private readonly host: ReactiveControllerHost,
    readonly store: TaskStore = taskStore
  ) {
    host.addController(this);
  }

  get tasks(): readonly TaskRecord[] {
    return this.store.tasks;
  }

  get orchestrators(): readonly OrchestratorEntry[] {
    return this.store.orchestrators;
  }

  get pinnedProjects(): readonly PinnedProject[] {
    return this.store.pinnedProjects;
  }

  get confirmations(): readonly TaskConfirmation[] {
    return this.store.confirmations;
  }

  get groupOrder(): readonly string[] {
    return this.store.groupOrder;
  }

  get sessionOrder(): readonly string[] {
    return this.store.sessionOrder;
  }

  get collapsedGroups(): readonly string[] {
    return this.store.collapsedGroups;
  }

  get projects(): readonly ProjectNotice[] {
    return this.store.projects;
  }

  iconFor(repoPath: string | null): string | null {
    return this.store.iconFor(repoPath);
  }

  hostConnected(): void {
    this.off ??= this.store.subscribe(() => this.host.requestUpdate());
  }

  hostDisconnected(): void {
    this.off?.();
    this.off = null;
  }
}
