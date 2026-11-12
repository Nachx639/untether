/**
 * What the task commands are given, who calls them and what they answer.
 */

import type { ConversationTurn } from '../../shared/agent-messages.js';
import type { ProjectSettings } from '../../shared/projects.js';
import type { SecuritySweepStatus } from '../../shared/security.js';
import type { TaskConfirmation } from '../../shared/task-confirmations.js';
import type { TaskAgent } from '../../shared/tasks.js';
import type { ModelProvider } from '../../types/config.js';
import type { MessageLedger } from './agent-messages.js';
import type { ConnectorChannelInfo } from './connector/connector-tokens.js';
import type { OrchestratorStartResult } from './orchestrator.js';
import type { ProjectCreator } from './project-create.js';
import type { ProjectSettingsPatch, StoredProjectSettings } from './project-settings.js';
import type { NotificationPayload } from './push-notification-service.js';
import type { TaskCommandsCore } from './task-commands-core.js';
import type { toRoutable } from './task-router.js';
import type { LlmRouteOpinion } from './task-router-llm.js';
import type { TaskScheduler } from './task-scheduler.js';
import type { DetectedCheck } from './task-verify.js';
import type { ToolPruner } from './tool-pruning.js';

/** What the project's orchestrator hears of what the user did (orchestrator.ts). */
export interface OrchestratorEvents {
  taskEvent(
    taskId: string,
    kind: 'working-again' | 'discarded' | 'confirmation' | 'long-running',
    detail?: string
  ): boolean;
  notice(repoPath: string, text: string): boolean;
  /**
   * Another project's orchestrator's message for this one, already marked as that agent's
   * (orchestratorRelayMessage), with its id in the ledger; false when none runs there.
   */
  relay(toRepo: string, text: string, messageId?: string): boolean;
  /** Starts the project's orchestrator with `goal`, or gives the running one the goal. */
  start(dir: string, goal: string): Promise<OrchestratorStartResult>;
  /** The project's running orchestrator session, if any. */
  sessionFor?(repoPath: string): string | undefined;
  /** Forgets the project's orchestrator and ends its session (`ut project forget`). */
  stop?(repoPath: string): Promise<{ ok: boolean; message?: string }>;
}

export interface TaskCaller {
  /** 'ui': the app, signed in. 'cli': `ut` over the API socket, or HTTP without a login. */
  kind: 'ui' | 'cli';
  /** The Untether session the command runs in (UNTETHER_SESSION_ID). */
  sessionId?: string;
}

export type TaskRole = 'user' | 'orchestrator' | 'session' | 'task';

export type TaskCommandErrorCode =
  | 'bad-request'
  | 'forbidden'
  | 'not-found'
  | 'not-open'
  | 'session-gone'
  | 'needs-confirmation'
  | 'busy'
  | 'not-fixable'
  /** `ut task retry` with no slot of its project free (maxActiveTasks); --force goes past it. */
  | 'limit'
  /** `ut task answer`: no prompt on the task's screen, or not that option. */
  | 'no-prompt'
  /** `ut task answer`: an answer only the user gives (the prompt deletes, or could not be read). */
  | 'needs-user'
  | 'bad-budget'
  | 'over-budget'
  | 'unavailable'
  /** `ut task done` with the task's changes left uncommitted on a branch that merges on its own. */
  | 'uncommitted'
  /** `ut task done --result` incomplete or malformed: the agent completes it and runs it again. */
  | 'bad-result'
  | 'error';

export type TaskCommandResult =
  | { ok: true; status: 'done'; data: Record<string, unknown> }
  | {
      ok: true;
      status: 'pending-confirmation';
      confirmation: TaskConfirmation;
      /** What the caller gets at once while it waits (a connector token, inactive until then). */
      data?: Record<string, unknown>;
    }
  | {
      ok: false;
      code: TaskCommandErrorCode;
      message: string;
      /** needs-confirmation: commits the branch has that exist nowhere else. */
      commits?: number;
      data?: Record<string, unknown>;
    };

/** A stored action waiting for the user's OK; runs as the user once approved. */
export interface ConfirmAction {
  op: string;
  args: Record<string, unknown>;
  /** The session that asked: what it starts once approved is still its own. */
  requestedBy?: string;
}

export interface Context {
  caller: TaskCaller;
  /** Approved by the user: runs as the user and skips "are you sure". */
  confirmed: boolean;
  /** Approved for this session (it asked): a task it starts still reports to it. */
  onBehalfOf?: string;
}

export interface TaskCommandsDeps {
  scheduler: () => TaskScheduler | null;
  /** The admission regulator's line for `ut task list` (resource-monitor.ts room()). */
  room?: () => string | undefined;
  /** The tool pruning of task sessions (tool-pruning.ts): `ut project tools`, task status. */
  tools?: Pick<ToolPruner, 'show' | 'want' | 'restore' | 'taskTools'>;
  settings: {
    get(repoPath: string): ProjectSettings;
    getStored(repoPath: string): StoredProjectSettings;
    update(repoPath: string, patch: ProjectSettingsPatch): ProjectSettings;
    /** Every known project (ut project tell finds another one by its folder name). */
    list(): Array<{ repoPath: string; settings: ProjectSettings }>;
    /** Forget a project's record (`ut project forget`); false when it had none. */
    remove(repoPath: string): boolean;
    /** Where a folder a project moved away from is now (null: not one). */
    currentPath?(dir: string): string | null;
  };
  notify: (payload: NotificationPayload) => void;
  /** Drops pushes still held for being seen that `matches` picks. */
  withdrawPush?: (matches: (payload: NotificationPayload) => boolean) => void;
  /** The project's security sweep (security-sweep.ts), shown with its settings. */
  securityStatus?: (repoPath: string) => SecuritySweepStatus;
  /** The agent's command line (the user's quick start) for a task made without one. */
  commandFor?: (agent: TaskAgent) => string[];
  /** The configured external model providers (UntetherConfig.modelProviders); none = off. */
  providers?: () => ModelProvider[] | undefined;
  /** A session's name, shown on a confirmation ("asked by …"). */
  sessionName?: (sessionId: string) => string | undefined;
  /** The main checkout of the repository `dir` is in (normalized), null outside one. */
  resolveRepo?: (dir: string) => Promise<string | null>;
  /** The orchestrators, told of the user's decisions and actions on their tasks. */
  orchestrator?: () => OrchestratorEvents | null;
  /** The ledger of messages between agents (agent-messages.ts); none: one in memory. */
  messages?: MessageLedger;
  /**
   * The turns of the conversation a session's agent runs, as its transcript holds them: where
   * `ut project tell --user-decision` finds the user's own words.
   */
  conversation?: (sessionId: string) => Promise<ConversationTurn[]>;
  /** The checks a repository's packages get (`ut project show`); default: git ls-files. */
  projectChecks?: (repoPath: string) => Promise<DetectedCheck[]>;
  /** A second opinion when routing is unsure (task-router-llm.ts); null = none. */
  llmRoute?: (
    text: string,
    candidates: ReturnType<typeof toRoutable>[]
  ) => Promise<LlmRouteOpinion | null>;
  now?: () => number;
  /** Where actions waiting for the user's OK survive a restart (none: memory only). */
  confirmationsPath?: string;
  /** The user's autoApprove setting (config.json); none = always off. */
  autoApprove?: { get(): boolean; set(on: boolean): void };
  /** The server's log (what was approved without asking). */
  log?: (message: string) => void;
  /** Makes a new project's folder, git and first commit (`project-new`; project-create.ts). */
  createProject?: ProjectCreator;
  /** The project connectors' tokens (connector/connector-tokens.ts); none = not available. */
  connector?: ConnectorAdmin;
}

/** What `ut project connector …` changes (server.ts wires the tokens and their listener). */
export interface ConnectorAdmin {
  add(input: { repoPath: string; name: string; createdBy: string; active: boolean }): {
    token: string;
    channel: ConnectorChannelInfo;
  };
  activate(id: string): ConnectorChannelInfo;
  setConfirmation(id: string, confirmationId: string): void;
  list(repoPath?: string): ConnectorChannelInfo[];
  revoke(ref: string, repoPath?: string): ConnectorChannelInfo;
  /** Where apps reach it (the listener's URL once it listens), e.g. http://127.0.0.1:4023. */
  url(): Promise<string | null>;
}

/** An op that needs no task scheduler (projects, connectors, the user's settings). */
export type PlainOp = (
  self: TaskCommandsCore,
  args: Record<string, unknown>,
  ctx: Context
) => TaskCommandResult | Promise<TaskCommandResult>;

/** An op on tasks: refused as unavailable on a server without the task scheduler. */
export type SchedulerOp = (
  self: TaskCommandsCore,
  scheduler: TaskScheduler,
  args: Record<string, unknown>,
  ctx: Context
) => TaskCommandResult | Promise<TaskCommandResult>;

/**
 * A family of ops (one file each, listed in task-commands.ts): a new op is its schema, its
 * function and its line in its family's table, nothing anywhere else.
 */
export interface TaskOpFamily {
  ops?: Record<string, PlainOp>;
  taskOps?: Record<string, SchedulerOp>;
}
