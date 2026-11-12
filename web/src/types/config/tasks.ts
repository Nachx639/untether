/** Settings of tasks on this Mac: approval, models, fallbacks, admission and its checks' room. */

import type { TaskTemplate } from '../../shared/tasks.js';

/** Its part of config.json (UntetherConfig, config/untether-config.ts). */
export interface TasksConfig {
  /**
   * Nothing in the task engine waits for the user's OK on the phone (2026-10-24, opt-in; missing
   * = off): every confirmation is approved at once, and a task held only for a merge OK merges
   * after the usual countdown. Turning it on from an agent or a script asks one OK
   * (task-commands.ts `auto-approve`); off never asks.
   */
  autoApprove?: boolean;

  /**
   * Minutes a task may stay ready or waiting for an answer, nobody acting on it, before it
   * reminds whoever it reports to (its orchestrator or the phone), then again after twice as
   * long each time (task-scheduler.ts remindStale). 0 = never; default 30.
   */
  staleTaskRemindMinutes?: number;

  /**
   * When the Mac is too busy for a task's check to start (2026-10-24, load 94-120 on 12 cores):
   * none starts while the 1-minute load is over maxLoadPerCore × cores (default 2; 0 = no
   * limit), waiting up to maxWaitSec (default 600) before it starts anyway. At most
   * maxConcurrent heavy runs at once (0 or unset: one per 6 cores, and up to one per 3 while
   * the ones running leave the load a check's worth under the threshold and the Mac has room
   * for a task, 2026-11-11), the verification runs and
   * the ones task agents and scripts start through `ut check-slot` alike; one of those waits
   * up to maxSlotWaitSec (default 1800) for its slot before it runs without one.
   */
  checkLoad?: {
    maxLoadPerCore?: number;
    maxWaitSec?: number;
    maxConcurrent?: number;
    maxSlotWaitSec?: number;
  };

  /**
   * This installation's model per agent and level (2026-11-01): what `--model fast|capable`
   * and a project's modelRouting run. Unset: Claude's fast is `sonnet`; capable (and Codex's
   * levels) the agent's own default.
   */
  taskModels?: Partial<Record<'claude' | 'codex', { fast?: string; capable?: string }>>;

  /**
   * Who a task goes on with when its agent hits its usage limit, in order (a project's
   * agentFallback): another agent, an account of its own (its command line, e.g.
   * `env CLAUDE_CONFIG_DIR=/path claude`) or a model. Unset: the other agent.
   */
  taskFallbacks?: Array<{
    name: string;
    agent: 'claude' | 'codex';
    command?: string;
    model?: string;
  }>;

  /**
   * When the Mac has room for one more task, of any project (2026-11-01, 24 GB Mac at 7-9 GB
   * of swap and a load of 45-50): a task due while it has not waits queued («esperando
   * memoria») and starts by itself once it has, fairly among projects; the checks wait on the
   * same memory/swap word. Defaults (resource-monitor.ts DEFAULT_TASK_ADMISSION): on, held by
   * pressure critical, under 20 % memory free, swap growing over 512 MB in 10 min, swap over
   * 90 % of a total of at least 50 % of the RAM, load over 2 × cores; 20 s between starts while
   * the Mac is past half of any limit. 0 turns a single limit off; enabled false all of them.
   * Pressure warn or swap over 25 % of the RAM with none of those let one task in every
   * steadySwapMaxWaitMin (15; 0 = never), as CPU alone does after cpuOnlyMaxWaitMin (2026-11-08).
   * 2026-11-11, a regulator with a target: swap over its level paces tasks only without calm
   * (memory free under roomyFreeMemoryPercent, 40; pressure warn; trend not known; over
   * maxSwapPagesPerSec, 64, pages swapped in or out per second over pagingWindowSec, 120).
   * The load aims at targetLoadPerCore (1) × cores: past it tasks come in one at a time, slower
   * up to maxLoadPerCore, and none past maxGrantLoadPerCore (4). settleSec applies between any
   * two starts, and each start keeps room for a typical task for rampWindowSec (90).
   */
  taskAdmission?: {
    enabled?: boolean;
    minFreeMemoryPercent?: number;
    maxSwapPercentOfRam?: number;
    maxSwapGrowthMb?: number;
    swapGrowthWindowMin?: number;
    maxSwapPercentOfTotal?: number;
    minSwapTotalPercentOfRam?: number;
    swapWarmupMin?: number;
    trendUnknownMaxWaitMin?: number;
    maxLoadPerCore?: number;
    cpuOnlyMaxWaitMin?: number;
    steadySwapMaxWaitMin?: number;
    settleSec?: number;
    roomyFreeMemoryPercent?: number;
    maxSwapPagesPerSec?: number;
    pagingWindowSec?: number;
    targetLoadPerCore?: number;
    maxGrantLoadPerCore?: number;
    rampWindowSec?: number;
  };

  /**
   * When the disk is too full for a task's check to start (2026-11-01, ~1 GB free): none starts
   * while the volume of its repo or worktree has under minFreeGB (default 5) or under
   * minFreePercent of the volume (default 2) free; 0 turns either off. It waits until it recovers.
   */
  checkDisk?: { minFreeGB?: number; minFreePercent?: number };

  /** The user's own task templates (the built-in ones live in the client). */
  taskTemplates?: TaskTemplate[];
}
