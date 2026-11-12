/**
 * Agents: which runner and model a task gets, an agent halted by a limit or an error (pause,
 * resume), and the hand-off to another agent.
 * One layer of TaskScheduler (task-scheduler.ts).
 */
import {
  TASK_AGENT_CHANGES_MAX,
  type TaskAgent,
  type TaskAgentChange,
  type TaskHalt,
  type TaskRecord,
  type TaskRunnerRef,
} from '../../shared/tasks.js';
import { claudeErrorKind } from './agent-events.js';
import {
  type AgentHalt,
  type AgentHaltKind,
  detectAgentHalt,
  haltContinuePrompt,
  haltHeadline,
  parseResumeAt,
} from './agent-halt.js';
import { buildHandoffPrompt } from './task-handoff.js';
import { decideTier } from './task-router-llm.js';
import { TaskSchedulerQueue } from './task-scheduler-queue.js';
import {
  clockText,
  HALT_LIMIT_GUESS_MS,
  HALT_MAX_TRIES,
  HALT_RESUME_MARGIN_MS,
  HALT_RETRY_DELAYS_MS,
  HALT_SLOT_RETRY_MS,
  HALT_STREAK_MS,
  isFinal,
  limitKeyOf,
  runnerLabel,
  runnerOf,
} from './task-scheduler-rules.js';
import {
  type AgentLimit,
  defaultProgress,
  type LaunchedSession,
  type NewTask,
  type TaskActionResult,
  type TaskRunner,
} from './task-scheduler-types.js';

const HALT_CONTINUE: readonly AgentHaltKind[] = ['usage-limit', 'api-error', 'auth', 'model'];

export abstract class TaskSchedulerAgents extends TaskSchedulerQueue {
  /** The model the user asked for (`--model`), if any: never classified then. */
  protected chosenModel(
    input: NewTask
  ): Pick<TaskRecord, 'model' | 'modelChoice' | 'modelProvider'> {
    // An external provider (`--model <id>:<model>`): the provider and its model, never routed.
    if (input.modelProvider) {
      return {
        modelProvider: input.modelProvider,
        ...(input.model ? { model: input.model } : {}),
        modelChoice: {
          by: 'user',
          reason: `asked for ${input.modelProvider}${input.model ? `:${input.model}` : ''}`,
        },
      };
    }
    if (input.modelTier) {
      const model = this.deps.modelFor?.(input.agent, input.modelTier);
      return {
        ...(model ? { model } : {}),
        modelChoice: { tier: input.modelTier, by: 'user', reason: `asked for ${input.modelTier}` },
      };
    }
    if (input.model) {
      return {
        model: input.model,
        modelChoice: { by: 'user', reason: `asked for ${input.model}` },
      };
    }
    return {};
  }

  /**
   * Model by difficulty (2026-11-01, opt-in per project): before its agent starts, a task
   * whose model nobody chose gets the level its prompt calls for; capable whenever the
   * classification is unsure or does not answer. Security sweeps and reverts keep the default.
   */
  protected chooseModel(task: TaskRecord): Promise<void> | undefined {
    // Nothing to choose: decided at once, so its start is not held back by a turn.
    if (task.modelChoice || task.security || task.revertOf || !this.deps.settings) return;
    return this.classify(task);
  }

  protected async classify(task: TaskRecord): Promise<void> {
    const settings = await this.settingsOf(task);
    if (!settings?.modelRouting) return;
    const opinion = this.deps.classifyTier
      ? await this.deps.classifyTier(task.prompt).catch(() => null)
      : null;
    if (task.modelChoice) return;
    const decision = decideTier(opinion);
    const model = this.deps.modelFor?.(task.agent, decision.tier);
    if (model) task.model = model;
    else delete task.model;
    task.modelChoice = decision;
    this.deps.onError?.(
      `Task ${task.id}: ${decision.tier} model (${model ?? `${task.agent}'s default`}), ${decision.by}: ${decision.reason}`
    );
    this.save();
  }

  protected screenReadable(task: TaskRecord): boolean {
    return (
      !!task.sessionId &&
      !!this.deps.screenText &&
      this.deps.sessionStatus(task.sessionId) === 'running'
    );
  }

  /**
   * What cut the task's agent's last turn short, if something did: its events first (Claude's
   * StopFailure, Codex's task_complete error), then Claude's transcript (its API error entry),
   * and the screen only when neither can tell (a53a6a15: a usage limit taken as "finished").
   */
  protected haltFromEvents(task: TaskRecord): AgentHalt | null | undefined {
    const events = this.events(task);
    if (events?.state === 'halted' && events.halt) {
      this.decided('halt', 'events', task);
      return events.halt;
    }
    if (events?.state === 'turn-ended') {
      this.decided('halt', 'events', task);
      return null;
    }
    return undefined;
  }

  /** Something besides the events can tell (Claude's transcript, the screen). */
  protected haltNeedsALook(task: TaskRecord): boolean {
    return (task.agent === 'claude' && !!this.deps.claudeTurnError) || this.screenReadable(task);
  }

  /** After its events: Claude's transcript, then the screen. */
  protected async haltOf(task: TaskRecord): Promise<AgentHalt | null> {
    const sessionId = task.sessionId;
    if (!sessionId) return null;
    const events = this.events(task);
    if (task.agent === 'claude' && this.deps.claudeTurnError) {
      const error = await this.deps.claudeTurnError(sessionId).catch(() => undefined);
      if (error !== undefined) {
        this.decided('halt', 'transcript', task);
        const kind = error ? claudeErrorKind(error.error) : null;
        if (!error || !kind) return null;
        const message = error.text || `API error: ${error.error}`;
        const resumeAt =
          kind === 'usage-limit' ? parseResumeAt(message, error.at ?? this.now()) : undefined;
        return {
          kind,
          message: message.replace(/\s+/g, ' ').trim().slice(0, 300),
          ...(resumeAt !== undefined ? { resumeAt } : {}),
        };
      }
    }
    if (!this.screenReadable(task)) return null;
    this.decided(
      'halt',
      'screen',
      task,
      events ? `its events say ${events.state}` : 'no events of its agent'
    );
    const screen = await this.deps.screenText?.(sessionId).catch(() => undefined);
    return screen ? detectAgentHalt(screen, this.now()) : null;
  }

  /**
   * Its agent was cut short (usage limit, API error, lost login): paused, never finished, and
   * sent on by itself at the time the agent gave (or after a delay that grows with each try).
   * Whoever it reports to hears it once per streak, and again when the tries ran out.
   */
  protected pause(task: TaskRecord, halt: AgentHalt, offer?: TaskRunner): void {
    const now = this.now();
    // The same streak only when it comes back soon after the task was sent on.
    const lastSentOn = task.halt ? Date.parse(task.halt.resumedAt ?? task.halt.since) : Number.NaN;
    const previous =
      task.halt && Number.isFinite(lastSentOn) && now - lastSentOn < HALT_STREAK_MS
        ? task.halt
        : undefined;
    const attempts = previous?.attempts ?? 0;
    const resumeAt = halt.resumeAt !== undefined && halt.resumeAt > now ? halt.resumeAt : undefined;
    const delays = HALT_RETRY_DELAYS_MS;
    // A model error is a config problem (the model name is unknown for this provider): sending
    // the agent on would fail the same way, so it waits for the user (`ut task retry`), never an
    // automatic try that spends a round and tokens for nothing.
    const nextTry =
      halt.kind === 'model' || attempts >= HALT_MAX_TRIES
        ? undefined
        : resumeAt !== undefined
          ? resumeAt + HALT_RESUME_MARGIN_MS
          : now + delays[Math.min(attempts, delays.length - 1)];
    const record: TaskHalt = {
      kind: halt.kind,
      message: halt.message,
      since: previous?.since ?? new Date(now).toISOString(),
      attempts,
      ...(resumeAt !== undefined ? { resumeAt: new Date(resumeAt).toISOString() } : {}),
      ...(nextTry !== undefined ? { nextTryAt: new Date(nextTry).toISOString() } : {}),
      ...(offer ? { offer: this.runnerRef(offer, task) } : {}),
    };
    this.cancelHold(task.id);
    this.waitingOnPrompt.delete(task.id);
    this.setState(task, 'paused', { kind: 'halted', message: this.haltNote(task, record) });
    task.halt = record;
    this.save();
    this.deps.onError?.(
      `Task ${task.id}: ${haltHeadline(halt.kind, task.agent)}, paused (${halt.message})`
    );
    if (!previous || nextTry === undefined) {
      this.notifyState(task, halt.message, { notice: nextTry === undefined ? 'halt-out' : 'halt' });
    }
    this.arm();
  }

  /**
   * "Codex hit its usage limit: paused, Untether sends it on by itself at 04:27 · «…»" (the
   * when first: a push shows 200 characters).
   */
  protected haltNote(task: TaskRecord, halt: TaskHalt): string {
    const headline = haltHeadline(halt.kind, task.agent);
    const said = `«${halt.message.slice(0, 200)}»`;
    // Another agent, account or model could carry it on now, in the same worktree.
    const offer = halt.offer
      ? ` · \`ut task retry ${task.id.slice(0, 8)} --agent ${halt.offer.runner}\` goes on now with ${runnerLabel(halt.offer)} in the same worktree`
      : '';
    if (!halt.nextTryAt) {
      return `${headline}: paused, its automatic tries ran out; \`ut task retry ${task.id.slice(0, 8)}\` sends it on, or discard it${offer} · ${said}`;
    }
    return `${headline}: paused, Untether sends it on by itself at ${clockText(Date.parse(halt.nextTryAt), this.now())}${offer} · ${said}`;
  }

  /**
   * `ut task retry <id> --agent <runner>` on a paused task: it goes on with that runner in the
   * same worktree (the offer of a pause, or the user's own pick), the old session stopped.
   */
  protected async switchPaused(task: TaskRecord, name: string): Promise<TaskActionResult> {
    if ((task.agentChanges?.length ?? 0) >= TASK_AGENT_CHANGES_MAX) {
      return {
        ok: false,
        code: 'not-fixable',
        message: `It changed agent ${TASK_AGENT_CHANGES_MAX} times already: send it on or discard it`,
      };
    }
    if (this.budgetSpent(task)) {
      return {
        ok: false,
        code: 'not-fixable',
        message: 'It reached its budget: give it more (`ut task budget`) or discard it',
      };
    }
    // Marked before the first await (2026-11-11): a second `retry --agent` while the runner
    // was looked up passed retry()'s busy check too, and both handed the task off (two
    // sessions in one worktree).
    this.finishing.add(task.id);
    try {
      const runner = await this.findRunner(name);
      if (!runner) return { ok: false, code: 'not-fixable', message: `${name} cannot run here` };
      if (task.state !== 'paused') {
        return { ok: false, code: 'not-open', message: `The task is ${task.state}` };
      }
      const halt = task.halt;
      const resumeAt = halt?.resumeAt ? Date.parse(halt.resumeAt) : undefined;
      const done = await this.handOff(
        task,
        runner,
        {
          message: halt?.message ?? 'the user changed its agent',
          ...(resumeAt !== undefined && Number.isFinite(resumeAt) ? { resumeAt } : {}),
        },
        'user'
      );
      if (!done) {
        return {
          ok: false,
          code: 'not-fixable',
          message: `Could not start ${runner.name} in its worktree`,
        };
      }
    } finally {
      this.finishing.delete(task.id);
    }
    this.arm();
    return { ok: true, task: this.copy(task) };
  }

  /**
   * Send a paused task's agent on: told in its session to continue where it stopped (a session
   * gone meanwhile is reopened). The user's resume starts the count of tries again.
   */
  protected async resumeHalted(task: TaskRecord, by: 'auto' | 'user'): Promise<TaskActionResult> {
    const halt = task.halt;
    if (halt) {
      delete halt.slotWait;
      halt.attempts = by === 'auto' ? halt.attempts + 1 : 0;
      halt.resumedAt = new Date(this.now()).toISOString();
      delete halt.nextTryAt;
    }
    this.deps.onError?.(
      `Task ${task.id}: sending its agent on after ${halt ? haltHeadline(halt.kind, task.agent) : 'a pause'} (${by})`
    );
    const result = await this.deliverText(
      task,
      haltContinuePrompt(halt?.kind ?? 'api-error'),
      by === 'auto' ? 'auto' : 'ui',
      true
    );
    if (!result.ok && task.state === 'paused') {
      // Its session is gone and cannot be reopened: the user decides (retry or discard).
      if (task.blocker && halt) task.blocker.message = this.haltNote(task, halt);
      this.save();
      if (by === 'auto') this.notifyState(task, result.message, { notice: 'halt-out' });
    }
    this.arm();
    return result;
  }

  /**
   * A paused task whose time to go on came: sent on when its project has a slot for it
   * (maxActiveTasks), else it waits for one, its place kept, and is looked at again every
   * HALT_SLOT_RETRY_MS. 2026-11-10: paused tasks hold no slot, so others started in their
   * place, and at the limit's reset all went back to work at once: 5 at work in a project
   * limited to 3.
   */
  protected async resumeWhenRoom(task: TaskRecord): Promise<void> {
    const halt = task.halt;
    if (!halt) return;
    const now = this.now();
    // Before anything awaits: the timer does not take it again, and the others see its claim.
    halt.nextTryAt = new Date(now + HALT_SLOT_RETRY_MS).toISOString();
    const waited = !!halt.slotWait;
    halt.slotWait ??= new Date(now).toISOString();
    const room = await this.projectRoom(task);
    if (task.state !== 'paused' || task.halt !== halt) return;
    if (room.ok) {
      await this.resumeHalted(task, 'auto');
      return;
    }
    if (!waited) {
      const note = `${haltHeadline(halt.kind, task.agent)}: it can go on, and does by itself when one of its project's ${room.max} tasks at work ends (maxActiveTasks)`;
      if (task.blocker) task.blocker.message = note;
      this.deps.onError?.(
        `Task ${task.id}: ${note}; \`ut task retry ${task.id.slice(0, 8)} --force\` sends it on now`
      );
    }
    this.save();
    this.arm();
  }

  /**
   * The usage limit (or lost login) of a runner (an agent with the user's quick start, or a
   * configured one) while it lasts: a paused task of it, or one that went on with another
   * (TaskAgentChange.fromUntil). API errors are the service's, not the account's: they hold
   * nothing back.
   */
  protected agentLimit(runner: string): AgentLimit | undefined {
    const now = this.now();
    let found: AgentLimit | undefined;
    const consider = (limit: AgentLimit) => {
      if (!Number.isFinite(limit.until) || limit.until <= now) return;
      if (!found || limit.until > found.until) found = limit;
    };
    for (const task of this.tasks) {
      for (const change of task.agentChanges ?? []) {
        if (change.from.runner === runner && change.fromUntil) {
          const until = Date.parse(change.fromUntil);
          consider({ until, task, kind: 'usage-limit', message: change.reason });
        }
      }
      // Keyed by limitKeyOf: a provider task's halt is its provider's, never its runner's.
      if (limitKeyOf(task) !== runner || task.state !== 'paused' || !task.halt) continue;
      // An API error is the service's and a model error is this task's own config: neither is a
      // limit on the runner's account, so they never hold its other tasks back.
      if (task.halt.kind === 'api-error' || task.halt.kind === 'model') continue;
      const until = Date.parse(task.halt.nextTryAt ?? task.halt.resumeAt ?? '');
      consider({ until, task, kind: task.halt.kind, message: task.halt.message });
    }
    return found;
  }

  /** What a task's card and events say about a runner. */
  protected runnerRef(runner: TaskRunner, task: TaskRecord): TaskRunnerRef {
    const model = this.modelOn(runner, task);
    return { agent: runner.agent, runner: runner.name, ...(model ? { model } : {}) };
  }

  /**
   * The model a task runs with on `runner`: the runner's own, else the installation's for the
   * task's level; a model the user named stays only on the same agent.
   */
  protected modelOn(runner: TaskRunner, task: TaskRecord): string | undefined {
    if (runner.model) return runner.model;
    const tier = task.modelChoice?.tier;
    if (tier) return this.deps.modelFor?.(runner.agent, tier);
    return runner.agent === task.agent && task.modelChoice?.by === 'user' ? task.model : undefined;
  }

  /**
   * Who could carry on a task its agent left at its usage limit, and whether the project
   * wants it done at once ('auto') or offered ('offer', the default). None: the project said
   * 'off', the halt is not a limit, the task changed agents TASK_AGENT_CHANGES_MAX times, or
   * every other runner is at a limit too.
   */
  protected async fallbackFor(
    task: TaskRecord,
    halt: Pick<AgentHalt, 'kind'>
  ): Promise<{ runner?: TaskRunner; auto: boolean }> {
    // A provider task never falls back onto the user's own Anthropic account: its limit/balance
    // pauses it with the reason (model-providers.ts), it is not carried on elsewhere.
    if (task.modelProvider) return { auto: false };
    if (halt.kind !== 'usage-limit' || task.security || task.revertOf) return { auto: false };
    if ((task.agentChanges?.length ?? 0) >= TASK_AGENT_CHANGES_MAX) return { auto: false };
    if (!this.deps.runners) return { auto: false };
    // Its budget is spent (wall, agent time, rounds, tokens): another agent would only spend
    // more; the pause and the budget decide (task budgets, 2026-11-01).
    if (this.budgetSpent(task)) return { auto: false };
    const settings = await this.settingsOf(task);
    const mode = settings?.agentFallback ?? 'offer';
    if (mode === 'off') return { auto: false };
    const runners = await Promise.resolve(this.deps.runners()).catch(() => [] as TaskRunner[]);
    const current = runnerOf(task);
    const runner = runners.find(
      (entry) => entry.name !== current && entry.command.length > 0 && !this.agentLimit(entry.name)
    );
    return { runner, auto: mode === 'auto' };
  }

  /**
   * The task goes on with `runner` (another agent, account or model) in the same worktree and
   * branch: a new session with a bounded handoff (the task, what was done, the diff, the old
   * agent's last rows), never starting over; the old session is stopped once the new one
   * runs. False when the new session could not start: the task is as it was.
   */
  protected async handOff(
    task: TaskRecord,
    runner: TaskRunner,
    halt: Pick<AgentHalt, 'message' | 'resumeAt'>,
    by: 'auto' | 'user'
  ): Promise<boolean> {
    const now = this.now();
    const from: TaskRunnerRef = {
      agent: task.agent,
      runner: runnerOf(task),
      ...(task.model ? { model: task.model } : {}),
    };
    const to = this.runnerRef(runner, task);
    const oldSessionId = task.sessionId;
    const screen = oldSessionId
      ? await this.deps.screenText?.(oldSessionId).catch(() => undefined)
      : undefined;
    const progress =
      task.isolation === 'worktree' && task.worktreePath
        ? await (this.deps.progressOf ?? defaultProgress)(task).catch(() => undefined)
        : undefined;
    if (isFinal(task) || this.discarding.has(task.id)) return false;
    // What it was told last is what it was at (Untether's own "go on" after a pause says
    // nothing of the work): whole in the handoff, the ones before it in short.
    const told = task.followUps
      .map((entry) => entry.text)
      .filter((text) => !HALT_CONTINUE.some((kind) => text === haltContinuePrompt(kind)));
    const pending = told.pop();
    const prompt = buildHandoffPrompt({
      brief: this.launchPrompt(task),
      from,
      reason: halt.message,
      ...(progress ? { progress } : {}),
      ...(screen ? { screen } : {}),
      followUps: told,
      ...(pending ? { pending } : {}),
      lastReply: this.lastReply.get(task.id),
    });
    const before = {
      agent: task.agent,
      command: task.command,
      runner: task.runner,
      model: task.model,
    };
    task.agent = runner.agent;
    task.command = runner.command;
    task.runner = runner.name;
    if (to.model) task.model = to.model;
    else delete task.model;
    let launched: LaunchedSession;
    if (oldSessionId) this.replacing.add(oldSessionId);
    try {
      launched = await this.openSession(task, { text: prompt, brief: true }, (sessionId) =>
        this.deps.launch({ ...task }, prompt, sessionId)
      );
    } catch (error) {
      Object.assign(task, before);
      if (before.runner === undefined) delete task.runner;
      if (before.model === undefined) delete task.model;
      if (oldSessionId) this.replacing.delete(oldSessionId);
      this.deps.onError?.(`Task ${task.id}: could not go on with ${runner.name}`, error);
      return false;
    }
    const { sessionId } = launched;
    if (isFinal(task)) {
      await this.dropSession(task, sessionId);
      if (oldSessionId) this.replacing.delete(oldSessionId);
      return true;
    }
    const resumeAt = halt.resumeAt !== undefined && halt.resumeAt > now ? halt.resumeAt : undefined;
    const change: TaskAgentChange = {
      at: new Date(now).toISOString(),
      from,
      to,
      reason: halt.message.slice(0, 300),
      by,
      // Not taken back before its limit resets (a guess when it did not say).
      fromUntil: new Date(resumeAt ?? now + HALT_LIMIT_GUESS_MS).toISOString(),
    };
    task.agentChanges = [...(task.agentChanges ?? []), change];
    delete task.halt;
    this.cancelHold(task.id);
    this.waitingOnPrompt.delete(task.id);
    this.seenBusy.delete(task.id);
    this.lastReply.delete(task.id);
    this.setState(task, 'working');
    task.sessionId = sessionId;
    this.watchTyped(task, { ...launched, brief: true });
    this.launchedHere.add(sessionId);
    this.save();
    this.deps.onError?.(
      `Task ${task.id}: ${from.runner} hit its usage limit, going on with ${to.runner}${to.model ? ` (${to.model})` : ''} in ${sessionId} (${by})`
    );
    if (oldSessionId) {
      await this.deps.stopSession?.(oldSessionId).catch(() => undefined);
      this.replacing.delete(oldSessionId);
    }
    this.notifyAgentChange(task, change);
    return true;
  }

  /** "Claude hit its usage limit: goes on with Codex (gpt-5) in the same worktree." */
  protected notifyAgentChange(task: TaskRecord, change: TaskAgentChange): void {
    const toOrchestrator = task.origin === 'orchestrator' && !!task.orchestratorSessionId;
    if (!task.notify && !toOrchestrator) return;
    const detail = `${haltHeadline('usage-limit', change.from.agent)}: it goes on with ${runnerLabel(change.to)} in the same worktree and branch, with what was done so far · «${change.reason.slice(0, 120)}»`;
    const payload = this.taskPayload(task, 'task-agent-changed', detail);
    payload.data = {
      ...payload.data,
      fromAgent: change.from.agent,
      toAgent: change.to.agent,
      ...(change.to.model ? { toModel: change.to.model } : {}),
      ...(task.notify ? {} : { quiet: true }),
    };
    this.post(payload);
  }

  /**
   * A task about to start while its agent is at its usage limit: it stays scheduled until
   * then, and whoever it reports to hears it once, with the other agent offered when it can
   * run here and is not at a limit too.
   */
  protected holdForAgent(task: TaskRecord, limit: AgentLimit): void {
    const until = new Date(limit.until).toISOString();
    const told = task.heldFor?.told;
    const halt = limit;
    task.runAt = until;
    if (task.state !== 'scheduled') this.setState(task, 'scheduled');
    task.heldFor = { agent: task.agent, until, reason: halt.message, told: true };
    this.save();
    this.arm();
    this.deps.onError?.(`Task ${task.id}: held until ${until}, its agent is at its limit`);
    if (told) return;
    const other: TaskAgent = task.agent === 'claude' ? 'codex' : 'claude';
    const otherFree = !!this.deps.agentCommand?.(other)?.length && !this.agentLimit(other);
    const otherName = other === 'claude' ? 'Claude' : 'Codex';
    const id = task.id.slice(0, 8);
    const detail = [
      `Not started yet: ${haltHeadline(halt.kind, task.agent)} (task ${limit.task.id.slice(0, 8)}), so it starts by itself at ${clockText(limit.until, this.now())}.`,
      otherFree
        ? `\`ut task retry ${id} --agent ${other}\` starts it now with ${otherName}.`
        : `\`ut task retry ${id}\` starts it now anyway (when its project has a slot).`,
    ].join(' ');
    this.notifyState(task, detail, { notice: `held-${until}` });
  }

  /**
   * The runner named `name` (config taskFallbacks, or a plain agent with the user's quick
   * start), when it can run here.
   */
  protected async findRunner(name: string): Promise<TaskRunner | undefined> {
    const runners = this.deps.runners
      ? await Promise.resolve(this.deps.runners()).catch(() => [] as TaskRunner[])
      : [];
    const found = runners.find((entry) => entry.name === name);
    if (found) return found.command.length ? found : undefined;
    if (name !== 'claude' && name !== 'codex') return undefined;
    // No runners list (tests, an older wiring): the agent with the user's quick start.
    if (this.deps.runners) return undefined;
    const command = this.deps.agentCommand?.(name);
    return command?.length ? { name, agent: name, command } : undefined;
  }

  /**
   * `ut task retry` on a task held for its agent's limit: started now (on `agent`, if given),
   * through its project's line unless `force` (then past its project's limit too).
   */
  protected async startHeld(
    task: TaskRecord,
    agent?: string,
    force = false
  ): Promise<TaskActionResult> {
    if (agent && agent !== runnerOf(task)) {
      const runner = await this.findRunner(agent);
      if (!runner) {
        return { ok: false, code: 'not-fixable', message: `${agent} cannot run here` };
      }
      // Worked out before the agent changes: a model the user named for the other agent
      // (`--model opus` on Claude) does not go with it to this one (review 2026-11-01).
      const model = this.modelOn(runner, task);
      task.agent = runner.agent;
      task.command = runner.command;
      if (runner.name === runner.agent) delete task.runner;
      else task.runner = runner.name;
      if (model) task.model = model;
      else delete task.model;
    }
    delete task.heldFor;
    task.runAt = new Date(this.now()).toISOString();
    this.save();
    this.track(this.run(task, force ? { anyway: true } : { pastAgentLimit: true }));
    return { ok: true, task: this.copy(task) };
  }
}
