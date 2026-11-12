/**
 * The task engine's commands, for a terminal, an agent's shell or the app (`ut task …`,
 * `ut project …`, the HTTP API): who the caller is and what it may do, the user's OK for what
 * an agent may not do on its own, and the op each family registered (task-commands.ts lists
 * them). No op lives here.
 */

import type { z } from 'zod';
import { autoMergePaused } from '../../shared/projects.js';
import type { ConfirmationKind, TaskConfirmation } from '../../shared/task-confirmations.js';
import type { TaskRecord } from '../../shared/tasks.js';
import { resolveAbsolutePath } from '../utils/path-utils.js';
import { MessageLedger } from './agent-messages.js';
import { normalizeRepoPath } from './project-settings.js';
import type { SessionReplacementFollower } from './session-replacements.js';
import {
  fail,
  isFinal,
  type RouteOutcome,
  type RouteSchema,
  resolveProjectRepo,
} from './task-commands-shared.js';
import type {
  ConfirmAction,
  Context,
  PlainOp,
  SchedulerOp,
  TaskCaller,
  TaskCommandResult,
  TaskCommandsDeps,
  TaskOpFamily,
  TaskRole,
} from './task-commands-types.js';
import { TaskConfirmations } from './task-confirmations.js';
import { OPEN_TASK_STATES, type RouteDecision, route, toRoutable } from './task-router.js';
import type { TaskScheduler } from './task-scheduler.js';

const MIN_ID_PREFIX = 4;

export class TaskCommandsCore {
  readonly confirmations: TaskConfirmations<ConfirmAction, TaskCommandResult>;
  /** Orchestrator sessions per repository, registered by the orchestrator (P7). */
  orchestrators = new Map<string, Set<string>>();
  /** When each orchestrator session told other projects something (ut project tell). */
  told = new Map<string, number[]>();
  readonly resolveRepo: (dir: string) => Promise<string | null>;
  /** The messages between agents: ids, threads and how far each got. */
  readonly messages: MessageLedger;

  /** What each op runs, as its family registered it (task-commands.ts lists the families). */
  readonly ops: Record<string, PlainOp> = Object.create(null);
  /** The ops that need the task scheduler. */
  readonly taskOps: Record<string, SchedulerOp> = Object.create(null);

  constructor(
    readonly deps: TaskCommandsDeps,
    families: readonly TaskOpFamily[]
  ) {
    for (const family of families) {
      for (const [table, ops] of [
        [this.ops, family.ops],
        [this.taskOps, family.taskOps],
      ] as const) {
        for (const [op, handler] of Object.entries(ops ?? {})) {
          if (op in this.ops || op in this.taskOps) {
            throw new Error(`Task command "${op}" is registered twice`);
          }
          (table as Record<string, unknown>)[op] = handler;
        }
      }
    }
    this.messages = deps.messages ?? new MessageLedger({ sessionOf: () => undefined });
    const resolve = deps.resolveRepo ?? resolveProjectRepo;
    // A folder a project moved away from resolves to where it is now (2026-10-25: `--repo`
    // with toolshed's old path failed once it was renamed to bakery).
    this.resolveRepo = async (dir) => {
      const repo = await resolve(dir);
      if (repo) return repo;
      const moved = deps.settings.currentPath?.(resolveAbsolutePath(dir));
      return moved ? resolve(moved) : null;
    };
    this.confirmations = new TaskConfirmations<ConfirmAction, TaskCommandResult>({
      run: (action) =>
        this.execute(action.op, action.args, {
          caller: { kind: 'ui' },
          confirmed: true,
          ...(action.requestedBy ? { onBehalfOf: action.requestedBy } : {}),
        }),
      notify: deps.notify,
      ...(deps.withdrawPush ? { withdrawPush: deps.withdrawPush } : {}),
      onExpired: (confirmation) => this.tellRequester(confirmation, 'expired'),
      autoApprove: () => deps.autoApprove?.get() === true,
      failedOf: (result) => (result.ok ? undefined : result.message),
      ...(deps.log ? { log: deps.log } : {}),
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.confirmationsPath ? { storePath: deps.confirmationsPath } : {}),
    });
  }

  /** `sessionId` orchestrates `repoPath`: it gets the orchestrator's rights there. */
  registerOrchestrator(sessionId: string, repoPath: string): void {
    const key = normalizeRepoPath(repoPath);
    let sessions = this.orchestrators.get(key);
    if (!sessions) {
      sessions = new Set();
      this.orchestrators.set(key, sessions);
    }
    sessions.add(sessionId);
  }

  unregisterOrchestrator(sessionId: string, repoPath?: string): void {
    for (const [repo, sessions] of this.orchestrators) {
      if (repoPath && repo !== normalizeRepoPath(repoPath)) continue;
      sessions.delete(sessionId);
      if (!sessions.size) this.orchestrators.delete(repo);
    }
  }

  /** The projects `sessionId` orchestrates. */
  orchestratedRepos(sessionId: string): string[] {
    return [...this.orchestrators.entries()]
      .filter(([, sessions]) => sessions.has(sessionId))
      .map(([repo]) => repo);
  }

  isOrchestrator(sessionId: string, repoPath: string): boolean {
    const key = normalizeRepoPath(repoPath);
    if (this.orchestrators.get(key)?.has(sessionId)) return true;
    return this.deps.settings.get(key).orchestratorSessionId === sessionId;
  }

  /** The caller's role for a project (or for no project in particular). */
  roleFor(caller: TaskCaller, repoPath?: string): TaskRole {
    if (caller.kind === 'ui') return 'user';
    const sessionId = caller.sessionId;
    if (!sessionId) return 'session';
    if (this.ownTask(sessionId)) return 'task';
    if (repoPath && this.isOrchestrator(sessionId, repoPath)) return 'orchestrator';
    return 'session';
  }

  /** Run `op` for `caller`; `args` come from the CLI or an HTTP body (validated here). */
  async run(op: string, args: unknown, caller: TaskCaller): Promise<TaskCommandResult> {
    if (!(op in this.ops) && !(op in this.taskOps)) {
      return fail('bad-request', `Unknown task command: ${op}`);
    }
    const input = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
    try {
      return await this.execute(op, input, { caller, confirmed: false });
    } catch (error) {
      return fail('error', error instanceof Error ? error.message : String(error));
    }
  }

  /** The user's answer to a pending confirmation; only the signed-in app may answer. */
  async answerConfirmation(
    id: string,
    approve: boolean,
    caller: TaskCaller
  ): Promise<
    | { status: 'approved'; result: TaskCommandResult }
    | { status: 'declined' }
    | { status: 'gone' }
    | { status: 'forbidden' }
  > {
    if (caller.kind !== 'ui') return { status: 'forbidden' };
    const asked = this.confirmations.get(id);
    try {
      const answer = await this.confirmations.answer(id, approve);
      if (asked && answer.status !== 'gone') {
        this.tellRequester(asked, answer.status === 'approved' ? 'approved' : 'declined');
      }
      return answer;
    } catch (error) {
      return {
        status: 'approved',
        result: fail('error', error instanceof Error ? error.message : String(error)),
      };
    }
  }

  /**
   * A session that asked for confirmations was reopened as `newSessionId` (SessionReplacements):
   * the user's answer, and what it starts once approved, belong to the new one.
   */
  sessionReplaced(oldSessionId: string, newSessionId: string): number {
    return this.confirmations.sessionReplaced(oldSessionId, newSessionId, (action) =>
      action.requestedBy === oldSessionId ? { ...action, requestedBy: newSessionId } : action
    );
  }

  /** The confirmations a session asked for answer it where it was reopened (server.ts). */
  replacementFollower(): SessionReplacementFollower {
    return {
      replaced: (oldSessionId, newSessionId) =>
        newSessionId ? this.sessionReplaced(oldSessionId, newSessionId) : 0,
      references: () => this.confirmations.requesters(),
    };
  }

  /**
   * The orchestrator that asked for a confirmation hears the user's decision (2026-10-20: it
   * was never told, so it asked again or waited forever): a task's as a task event, a
   * settings change as a notice. 2026-10-23: one about another project (starting its
   * orchestrator) reached nobody; the asking orchestrator hears it in its own project.
   */
  tellRequester(
    confirmation: TaskConfirmation,
    outcome: 'approved' | 'declined' | 'expired'
  ): void {
    const sessionId = confirmation.requestedBy.sessionId;
    const events = this.deps.orchestrator?.();
    if (!sessionId || !events) return;
    const repo = confirmation.repoPath;
    const ownProject = !!repo && this.isOrchestrator(sessionId, repo);
    const home = ownProject ? repo : this.orchestratedRepos(sessionId)[0];
    if (!home) return;
    const said =
      outcome === 'expired'
        ? 'expired unanswered (the user did not decide)'
        : `${outcome} by the user`;
    if (confirmation.taskId && ownProject) {
      events.taskEvent(confirmation.taskId, 'confirmation', `${said}: ${confirmation.summary}`);
    } else {
      events.notice(home, `Your request "${confirmation.summary}" was ${said}.`);
    }
  }

  async execute(
    op: string,
    args: Record<string, unknown>,
    ctx: Context
  ): Promise<TaskCommandResult> {
    const plain: PlainOp | undefined = this.ops[op];
    if (plain) return plain(this, args, ctx);
    const scheduler = this.deps.scheduler();
    if (!scheduler) return fail('unavailable', 'Tasks are not available on this server');
    return this.taskOps[op](this, scheduler, args, ctx);
  }

  /**
   * The user did something to an orchestrator's task (fix, retry, a message from the phone): its
   * orchestrator hears its agent works again (2026-10-20: it heard nothing and fixed it twice).
   */
  tellWorkingAgain(ctx: Context, task: TaskRecord, what: string): void {
    if (this.roleOn(ctx, task) !== 'user' || task.origin !== 'orchestrator') return;
    this.deps.orchestrator?.()?.taskEvent(task.id, 'working-again', what);
  }

  // --- routing (P6) --------------------------------------------------------------------------

  /** The repository's open worktree tasks and where `text` goes among them. */
  async decide(
    scheduler: TaskScheduler,
    repoPath: string,
    text: string
  ): Promise<{ decision: RouteOutcome; open: TaskRecord[] }> {
    const open = scheduler
      .list()
      .filter(
        (task) =>
          task.isolation === 'worktree' &&
          OPEN_TASK_STATES.has(task.state) &&
          this.taskRepo(task) === repoPath
      );
    const ruled = route(text, open.map(toRoutable));
    if (ruled.kind !== 'ask' || !this.deps.llmRoute) {
      return { decision: fromRules(ruled), open };
    }
    const candidates = open
      .filter((task) => ruled.candidates.includes(task.id))
      .map((task) => toRoutable(task));
    const opinion = await this.deps.llmRoute(text, candidates).catch(() => null);
    if (opinion?.confident) {
      return {
        decision: opinion.taskId
          ? { kind: 'match', taskId: opinion.taskId, reason: 'similar', by: 'llm' }
          : { kind: 'new', reason: 'no-match', by: 'llm' },
        open,
      };
    }
    return { decision: fromRules(ruled), open };
  }

  async routeRepo(input: z.infer<typeof RouteSchema>): Promise<string | null> {
    const dir = input.repoPath ?? input.repo ?? input.cwd;
    return dir ? this.resolveRepo(dir) : null;
  }

  // --- helpers -------------------------------------------------------------------------------

  /**
   * The open task a session runs (the newest when it ran several). 2026-10-20: settled ones
   * counted too, so the session of a plain task that was done stayed a "task" for good.
   */
  ownTask(sessionId: string): TaskRecord | undefined {
    const tasks = this.deps.scheduler()?.list() ?? [];
    return tasks
      .reverse()
      .find(
        (task) =>
          task.sessionId === sessionId &&
          !isFinal(task) &&
          !(task.isolation === 'none' && (task.state === 'ready' || task.state === 'failed'))
      );
  }

  /** The orchestrator calling started `task` and its policy merges on its own. */
  orchestratorMerges(ctx: Context, task: TaskRecord): boolean {
    const sessionId = ctx.caller.kind === 'cli' ? ctx.caller.sessionId : undefined;
    if (!sessionId || task.origin !== 'orchestrator' || task.orchestratorSessionId !== sessionId) {
      return false;
    }
    if (task.groupId) return false;
    const repo = this.taskRepo(task);
    const settings = repo ? this.deps.settings.get(repo) : undefined;
    // The circuit breaker paused the project's auto-merge: merges wait for the user.
    if (settings && autoMergePaused(settings)) return false;
    const policy = task.mergePolicy ?? settings?.mergePolicy ?? 'ask';
    return policy === 'auto';
  }

  taskRepo(task: TaskRecord): string | undefined {
    const repo = task.repoPath ?? (task.isolation === 'worktree' ? undefined : task.workingDir);
    return repo ? normalizeRepoPath(repo) : undefined;
  }

  /** The caller's role on `task`; an approved confirmation runs as the user. */
  roleOn(ctx: Context, task: TaskRecord): TaskRole {
    if (ctx.confirmed) return 'user';
    return this.roleFor(ctx.caller, this.taskRepo(task));
  }

  /**
   * A task by id, id prefix (≥ 4 characters) or branch (ut/<slug> or <slug>). No ref inside a
   * task's session = its own task.
   */
  find(
    scheduler: TaskScheduler,
    ref: string | undefined,
    ctx: Context
  ): { task: TaskRecord } | { error: TaskCommandResult } {
    if (!ref) {
      const own =
        ctx.caller.kind === 'cli' && ctx.caller.sessionId
          ? this.ownTask(ctx.caller.sessionId)
          : undefined;
      return own
        ? { task: own }
        : { error: fail('bad-request', 'Which task? Give its id or branch') };
    }
    const exact = scheduler.get(ref);
    if (exact) return { task: exact };
    const tasks = scheduler.list();
    const branch = ref.startsWith('ut/') ? ref : `ut/${ref}`;
    const byBranch = tasks.filter((task) => task.branch === branch);
    const open = byBranch.filter((task) => !isFinal(task));
    if (open.length === 1 || (open.length === 0 && byBranch.length === 1)) {
      return { task: open[0] ?? byBranch[0] };
    }
    if (ref.length >= MIN_ID_PREFIX) {
      const byPrefix = tasks.filter((task) => task.id.startsWith(ref));
      if (byPrefix.length === 1) return { task: byPrefix[0] };
      if (byPrefix.length > 1) {
        return { error: fail('bad-request', `"${ref}" matches ${byPrefix.length} tasks`) };
      }
    }
    return { error: fail('not-found', `No task "${ref}"`) };
  }

  confirm(
    kind: ConfirmationKind,
    task: TaskRecord,
    ctx: Context,
    args: Record<string, unknown>,
    detail: string[]
  ): Promise<TaskCommandResult> {
    const op: string = kind === 'merge-risk' || kind === 'merge-review' ? 'merge' : kind;
    return this.request(
      kind,
      {
        where: task.name,
        taskId: task.id,
        ...(task.repoPath ? { repoPath: task.repoPath } : {}),
        summary: `${CONFIRM_SUMMARY[kind]}: ${task.name}`,
        detail,
      },
      ctx,
      { op, args }
    );
  }

  async request(
    kind: ConfirmationKind,
    about: {
      where: string;
      summary: string;
      detail: string[];
      taskId?: string;
      repoPath?: string;
    },
    ctx: Context,
    action: ConfirmAction
  ): Promise<TaskCommandResult> {
    const sessionId = ctx.caller.kind === 'cli' ? ctx.caller.sessionId : undefined;
    const name = sessionId ? this.deps.sessionName?.(sessionId) : undefined;
    const outcome = await this.confirmations.submit({
      kind,
      ...about,
      requestedBy: { ...(sessionId ? { sessionId } : {}), ...(name ? { name } : {}) },
      action: { ...action, ...(sessionId ? { requestedBy: sessionId } : {}) },
      key: JSON.stringify([kind, sessionId ?? '', action.op, action.args]),
    });
    switch (outcome.status) {
      case 'pending':
        return { ok: true, status: 'pending-confirmation', confirmation: outcome.confirmation };
      case 'failed':
        return fail('error', outcome.message);
      case 'approved': {
        // autoApprove: done as if the user had approved it; the caller hears it was not asked.
        const { result, confirmation } = outcome;
        if (!result.ok || result.status !== 'done') return result;
        return {
          ...result,
          data: {
            ...result.data,
            autoApproved: { id: confirmation.id, summary: confirmation.summary },
          },
        };
      }
    }
  }
}

const CONFIRM_SUMMARY: Record<ConfirmationKind, string> = {
  merge: 'Merge',
  'merge-risk': 'Merge with its risky changes',
  'merge-review': 'Merge despite the AI review',
  discard: 'Discard',
  keep: 'Keep this one and discard the others',
  send: 'Send a message to',
  fix: 'Ask the agent to fix',
  retry: 'Try again',
  revert: 'Undo',
  'project-set': 'Change the task settings',
  start: 'Start a session without a worktree',
  'project-orchestrate': "Start the project's orchestrator",
  'project-forget': 'Forget the project',
  'project-new': 'Create a new project',
  'auto-approve': 'Turn on autoApprove',
  'connector-add': 'Let an external app talk to the orchestrator',
};

function fromRules(decision: RouteDecision): RouteOutcome {
  switch (decision.kind) {
    case 'match':
      return { kind: 'match', taskId: decision.taskId, reason: decision.reason, by: 'rules' };
    case 'new':
      return { kind: 'new', reason: decision.reason, by: 'rules' };
    case 'ask':
      return { kind: 'ask', candidates: decision.candidates, reason: 'unsure', by: 'rules' };
  }
}
