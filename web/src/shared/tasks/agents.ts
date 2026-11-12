/** A task's agent: which one, its model, what cut it short and who took over. */

export type TaskAgent = 'claude' | 'codex';

export type TaskHaltKind = 'usage-limit' | 'api-error' | 'auth' | 'model';

/** Why and until when a paused task's agent stopped (server/services/agent-halt.ts). */
export interface TaskHalt {
  kind: TaskHaltKind;
  /** The agent's error as its screen showed it, one line. */
  message: string;
  /** When this streak of halts began. */
  since: string;
  /** When the agent said it can go on (its limit resets), when it said. */
  resumeAt?: string;
  /** When Untether sends it on by itself; unset once its tries ran out. */
  nextTryAt?: string;
  /** Times Untether sent it on by itself in this streak. */
  attempts: number;
  /**
   * Since when it could go on but waits for one of its project's slots (maxActiveTasks,
   * 2026-11-10): tasks paused at a usage limit free their slots, others start, and at the
   * reset all of them went back to work at once, past the limit. It holds its place meanwhile.
   */
  slotWait?: string;
  /**
   * When it was last sent on: a halt within HALT_STREAK_MS of it is the same streak (its tries
   * add up, nobody is told again); a later one is a new cut after real work.
   */
  resumedAt?: string;
  /**
   * Another runner that could carry it on now in the same worktree (ProjectSettings
   * agentFallback 'offer'): `ut task retry <id> --agent <runner>`.
   */
  offer?: TaskRunnerRef;
}

/** A task's model level (ProjectSettings.modelRouting): the agent's fast or capable model. */
export type TaskModelTier = 'fast' | 'capable';

/** How a task's model was picked, for the orchestrator and the card. */
export interface TaskModelChoice {
  /** The level, unless the user named a model of their own. */
  tier?: TaskModelTier;
  /** user: `--model`; router: the classification of its prompt; default: unsure or no answer. */
  by: 'user' | 'router' | 'default';
  /** Why, in a few words (English, for logs and the orchestrator). */
  reason: string;
}

/** Who runs a task: an agent, its command line (an account of its own) and model. */
export interface TaskRunnerRef {
  agent: TaskAgent;
  /** The installation's name for it (config taskFallbacks), else the agent. */
  runner: string;
  model?: string;
}

/** The task went on with another agent, account or model (TaskRecord.agentChanges). */
export interface TaskAgentChange {
  at: string;
  from: TaskRunnerRef;
  to: TaskRunnerRef;
  /** The halt that made it change, one line. */
  reason: string;
  by: 'auto' | 'user';
  /** Until when `from` is at its limit (as it said; else a guess): it is not taken back sooner. */
  fromUntil?: string;
}

/** At most this many changes of agent per task (no ping-pong between two cut-off agents). */
export const TASK_AGENT_CHANGES_MAX = 3;

/** What a task's record keeps of this (TaskRecord, tasks/record.ts). */
export interface TaskAgentsFields {
  agent: TaskAgent;
  /**
   * Its runner's name (config taskFallbacks) once it went on with one; unset = the agent with
   * the user's quick start.
   */
  runner?: string;
  /** The model its agent runs with (`--model` / `-m`); unset = the agent's own default. */
  model?: string;
  /**
   * An external model provider the task runs against (`--model <id>:<model>`,
   * UntetherConfig.modelProviders): the provider id; `model` is its model. Its Claude Code runs
   * with the provider's base URL and key, never the user's own Anthropic login. The key is
   * never stored on the task. Shown on the card, `ut task status` and the orchestrator notes.
   */
  modelProvider?: string;
  /** How `model` was picked (unset: routing off and no `--model`). */
  modelChoice?: TaskModelChoice;
  /** Each time it went on with another agent, account or model, oldest first. */
  agentChanges?: TaskAgentChange[];
  /**
   * Its agent was cut short by something outside the task (paused); kept through the turns it
   * is sent on until one ends otherwise, so the tries add up.
   */
  halt?: TaskHalt;
  /**
   * Not started yet because its agent is at its usage limit (another task of the same agent
   * hit it): it waits as scheduled until `until` (runAt). `told`: the notice went out.
   */
  heldFor?: { agent: TaskAgent; until: string; reason: string; told?: boolean };
}
