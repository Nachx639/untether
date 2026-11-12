/**
 * Talking to a running agent: typing follow-ups (and retrying them), and telling when it is busy,
 * waiting or idle long enough to finish.
 * One layer of TaskScheduler (task-scheduler.ts).
 */

import {
  agentMayNotAnswer,
  approveOption,
  denyOption,
  PROMPT_ESCALATE_MS,
  type PromptAnswer,
  promptDeletes,
  promptSummary,
  promptWhole,
  type TaskPrompt,
  untetherWrapper,
} from '../../shared/agent-prompt.js';
import { endEffect, pendingEffect } from '../../shared/task-effects.js';
import type { TaskFollowUp, TaskRecord } from '../../shared/tasks.js';
import { TaskSchedulerAgents } from './task-scheduler-agents.js';
import { typedMessage } from './task-scheduler-prompts.js';
import {
  CODEX_IDLE_MS,
  CODEX_TYPED_SKEW_MS,
  EVENTS_BUSY_TRUST_MS,
  IDLE_HOLD_MS,
  INPUT_BUSY_NOTICE_MS,
  INPUT_GIVE_UP_MS,
  INPUT_RETRY_MAX_MS,
  INPUT_RETRY_MS,
  isFinal,
  RESTART_IDLE_AFTER_MS,
  SESSION_STATES,
  sleep,
} from './task-scheduler-rules.js';
import type { LaunchedSession, TaskActionResult } from './task-scheduler-types.js';

/** A push that carries a command whole: as much as fits a push service's 4 KB payload. */
const WRAPPED_PUSH_MAX = 1500;

export abstract class TaskSchedulerInput extends TaskSchedulerAgents {
  protected typePendingNow(task: TaskRecord): void {
    const timer = this.inputTimers.get(task.id);
    if (timer) clearTimeout(timer);
    this.inputTimers.delete(task.id);
    this.track(this.pumpInput(task));
  }

  /**
   * A settled task's agent went busy for a real reason: Claude's own prompt was answered on
   * its screen, something was typed into it since it settled (a follow-up, a fix, a retry, a
   * message that waited), or its conversation moved on (the user typed in its session). A
   * redraw of the terminal is none of these.
   */
  /** Stopped at a prompt of Claude's own (not `ut task ask`), whatever a restart forgot. */
  protected onClaudePrompt(task: TaskRecord): boolean {
    if (task.state !== 'needs_you') return false;
    return this.waitingOnPrompt.has(task.id) || !!task.blocker?.fromPrompt;
  }

  protected realFollowUp(task: TaskRecord, preview: string): boolean {
    if (this.onClaudePrompt(task)) return true;
    const settledAt = Date.parse(task.stateSince);
    // What was sent is also on the task (2026-10-20: lastSent lives in memory, so after a
    // restart an agent working on its orchestrator's message stayed "needs you · Fusionar").
    const lastFollowUp = task.followUps?.length
      ? Date.parse(task.followUps[task.followUps.length - 1].at)
      : Number.NaN;
    const sent = Math.max(
      this.lastSent.get(task.id) ?? Number.NEGATIVE_INFINITY,
      lastFollowUp || Number.NEGATIVE_INFINITY
    );
    if (Number.isFinite(sent) && Number.isFinite(settledAt) && sent >= settledAt) return true;
    if (!this.settledPreview.has(task.id)) {
      // Nothing recorded (a restart since): this is the conversation as it stands.
      this.settledPreview.set(task.id, preview || undefined);
      return this.answersItsQuestion(task, preview);
    }
    const before = this.settledPreview.get(task.id);
    if (before === undefined) {
      this.settledPreview.set(task.id, preview || undefined);
      return this.answersItsQuestion(task, preview);
    }
    return !!preview && preview !== before;
  }

  /**
   * With nothing to compare to, the user's own words on a task stopped on `ut task ask` are its
   * answer: it stayed «te necesita» through the whole turn after a restart (2026-11-09).
   */
  private answersItsQuestion(task: TaskRecord, preview: string): boolean {
    if (task.state !== 'needs_you' || task.blocker?.kind !== 'question') return false;
    return preview.startsWith('user:') && !task.prompt.startsWith(preview.slice(5, 45));
  }

  /** A settled task seen busy and idle again: its agent committed meanwhile, so it is done again. */
  protected async probeNewWork(task: TaskRecord): Promise<void> {
    if (task.isolation !== 'worktree' || !task.worktreePath) return;
    if (this.piping.has(task.id) || this.finishing.has(task.id)) return;
    const before = task.stats?.commits ?? 0;
    const changes = await this.worktrees.changes(task).catch(() => undefined);
    if (!changes || changes.stats.commits <= before) return;
    if (!SESSION_STATES.includes(task.state) || task.state === 'working') return;
    this.deps.onError?.(`Task ${task.id}: new commits in its session, checking it again`);
    this.waitingOnPrompt.delete(task.id);
    this.setState(task, 'working');
    this.seenBusy.add(task.id);
    this.save();
    if (task.sessionId && this.lastStatus.get(task.sessionId) === 'idle') this.armHold(task);
  }

  /**
   * Type `text` into the task's agent. 2026-10-20: the answer was "sent" at once, while the
   * typing itself could give up (the agent busy for over a minute) and the message was lost
   * with nobody told. Now it waits in TaskRecord.pendingInput until it was really typed, tried
   * again every INPUT_RETRY_MS while the session runs, and a session that ended meanwhile gets
   * its conversation reopened with it. Answers after the first try (or a moment of it).
   */
  protected async deliverText(
    task: TaskRecord,
    text: string,
    via: TaskFollowUp['via'],
    backToWork: boolean,
    message?: { id: string; header: string }
  ): Promise<TaskActionResult> {
    const sessionId = task.sessionId;
    if (!sessionId || this.deps.sessionStatus(sessionId) !== 'running') {
      // 2026-10-18: a task cut off mid-work (its session died) could not be told anything.
      // A Claude worktree task gets its conversation reopened with the text instead.
      // No conversation to reopen (a revert done by git, a Codex task): a new agent in its
      // worktree takes it (2026-10-20: fix and retry answered "session ended" for good).
      const typed = message ? `${message.header}\n${text}` : text;
      if (this.reopenWith(task, typed) || this.startInWorktree(task, typed)) {
        // Its new agent starts with it: delivered (agent-messages.ts).
        if (message) this.deps.messageTyped?.(message.id);
        task.followUps.push({ at: new Date(this.now()).toISOString(), text, via });
        this.lastSent.set(task.id, this.now());
        this.save();
        return { ok: true, task: this.copy(task) };
      }
      return { ok: false, code: 'session-gone', message: "The task's session has ended" };
    }
    if (!this.deps.deliver) {
      return { ok: false, code: 'session-gone', message: 'The session cannot take input now' };
    }
    const at = new Date(this.now()).toISOString();
    task.followUps.push({ at, text, via });
    task.pendingInput = [
      ...(task.pendingInput ?? []),
      { text, at, ...(message ? { messageId: message.id, header: message.header } : {}) },
    ];
    this.lastSent.set(task.id, this.now());
    // Codex reports no status: it is at work from the moment the text goes in. A fix request
    // is work too, whatever the agent's status says next.
    if (backToWork && task.state !== 'working') {
      this.setState(task, 'working');
      this.seenBusy.delete(task.id);
    }
    this.save();
    const attempt = this.pumpInput(task);
    this.track(attempt);
    await Promise.race([attempt, sleep(this.deps.inputWaitMs ?? 3000)]);
    return { ok: true, task: this.copy(task) };
  }

  /** Its pending messages will never be typed: the ledger of messages forgets them. */
  private dropMessages(task: TaskRecord, why: string): void {
    for (const message of task.pendingInput ?? []) {
      if (message.messageId) this.deps.messageDropped?.(message.messageId, why);
    }
  }

  /** Type the task's next pending message; on to the one after once it went in. */
  protected pumpInput(task: TaskRecord): Promise<void> {
    const busy = this.typing.get(task.id);
    if (busy) return busy;
    const next = task.pendingInput?.[0];
    if (!next || isFinal(task)) {
      this.inputStalls.delete(task.id);
      delete task.pendingNoticed;
      delete task.pendingSince;
      return Promise.resolve();
    }
    const sessionId = task.sessionId;
    if (!sessionId || this.deps.sessionStatus(sessionId) !== 'running') {
      // Its session ended before the messages went in: its conversation is reopened with them.
      const pending = task.pendingInput ?? [];
      const texts = pending.map((message) => typedMessage(message, this.now())).join('\n\n');
      // 2026-10-23: a Codex task's session ended before its brief went in (an Enter on its
      // update menu updated and quit it): started again with the task, the brief never typed.
      const reopened =
        this.reopenWith(task, texts) ||
        (pending.every((message) => message.brief) && this.startAgain(task));
      if (reopened) {
        for (const message of pending) {
          if (message.messageId) this.deps.messageTyped?.(message.messageId);
        }
        delete task.pendingInput;
        delete task.pendingWhy;
        delete task.pendingNoticed;
        delete task.pendingSince;
        this.inputStalls.delete(task.id);
        this.save();
      } else {
        // Nothing to reopen (yet: the user may resume it): tried again, given up after an hour.
        this.inputNotTyped(task, 'gone');
      }
      return Promise.resolve();
    }
    const deliver = this.deps.deliver;
    if (!deliver) return Promise.resolve();
    const attempt = Promise.resolve()
      .then(() => {
        const text = typedMessage(next, this.now());
        return task.isolation === 'worktree'
          ? deliver(sessionId, text, task.agent, { trustFolder: true })
          : deliver(sessionId, text, task.agent);
      })
      .catch(() => false)
      .then((typed) => {
        this.typing.delete(task.id);
        if (isFinal(task)) {
          this.dropMessages(task, `the task is ${task.state}`);
          delete task.pendingInput;
          delete task.pendingWhy;
          delete task.pendingNoticed;
          delete task.pendingSince;
          this.inputStalls.delete(task.id);
          this.save();
          return;
        }
        if (typed) {
          this.userHolds.delete(sessionId);
          if (next.messageId) this.deps.messageTyped?.(next.messageId);
          const left = (task.pendingInput ?? []).filter((message) => message !== next);
          if (left.length) task.pendingInput = left;
          else delete task.pendingInput;
          delete task.pendingWhy;
          delete task.pendingNoticed;
          delete task.pendingSince;
          this.lastSent.set(task.id, this.now());
          this.inputStalls.delete(task.id);
          if (task.blocker?.onScreen) {
            task.blocker = { ...task.blocker };
            delete task.blocker.onScreen;
          }
          this.save();
          if (left.length) this.track(this.pumpInput(task));
          return;
        }
        // Claude shows a menu of its own (a question, a permission): typing waits for a choice
        // made on that screen.
        const onMenu = this.lastStatus.get(sessionId) === 'waiting';
        this.inputNotTyped(task, onMenu ? 'menu' : 'busy');
      });
    this.typing.set(task.id, attempt);
    return attempt;
  }

  /**
   * A message that could not be typed (2026-10-20: retried every 15 s forever, a log line
   * each time, and behind a menu of Claude's own nobody was told why): tried again with a
   * doubling delay up to INPUT_RETRY_MAX_MS, logged once per reason. Behind a menu the user
   * (or the orchestrator) is told once that a choice on the task's screen is needed. With its
   * session gone and nothing to reopen it is dropped after INPUT_GIVE_UP_MS, with one notice.
   */
  protected inputNotTyped(task: TaskRecord, reason: 'busy' | 'menu' | 'gone'): void {
    const now = this.now();
    // A restart keeps its clock (pendingSince) and whether it was told
    // (pendingNoticed): 2026-11-02, both started over with each restart, so the notice after
    // INPUT_BUSY_NOTICE_MS and the give-up after INPUT_GIVE_UP_MS could never come, or came twice.
    let stall = this.inputStalls.get(task.id);
    if (!stall) {
      const since = Date.parse(task.pendingSince ?? '');
      stall = {
        attempts: 0,
        since: Number.isFinite(since) ? since : now,
        reason: '',
        ...(task.pendingNoticed ? { noticed: true } : {}),
      };
      if (!task.pendingSince && task.pendingInput?.length) {
        task.pendingSince = new Date(stall.since).toISOString();
        this.save();
      }
    }
    if (task.pendingWhy !== reason && task.pendingInput?.length) {
      task.pendingWhy = reason;
      this.save();
    }
    // Each message's own record says why it waits (`ut project messages`, its sender).
    const waitsOn = this.pendingReason(task, reason);
    for (const message of task.pendingInput ?? []) {
      if (message.messageId) this.deps.messageWaiting?.(message.messageId, waitsOn);
    }
    if (stall.reason !== reason) {
      const why = {
        busy:
          task.agent === 'codex'
            ? 'Codex is not back at its prompt'
            : 'Claude is not ready to take it (starting, or a screen Untether does not know)',
        menu: "Claude shows a choice of its own on the task's screen",
        gone: 'its session has ended',
      }[reason];
      this.deps.onError?.(`task ${task.id}: a message was not typed yet (${why}); trying again`);
      stall.reason = reason;
    }
    stall.attempts++;
    this.inputStalls.set(task.id, stall);
    if (reason === 'gone' && now - stall.since >= INPUT_GIVE_UP_MS) {
      const dropped = task.pendingInput?.length ?? 0;
      this.dropMessages(task, 'its session ended and could not be reopened');
      delete task.pendingInput;
      delete task.pendingWhy;
      delete task.pendingNoticed;
      delete task.pendingSince;
      this.inputStalls.delete(task.id);
      this.save();
      this.deps.onError?.(`task ${task.id}: ${dropped} message(s) given up: its session is gone`);
      // Whatever state it is in (a working task says nothing of its own): told once.
      const toOrchestrator = task.origin === 'orchestrator' && !!task.orchestratorSessionId;
      if (task.notify || toOrchestrator) {
        this.post(
          this.taskPayload(
            task,
            'task-needs-you',
            `${dropped === 1 ? 'A message' : `${dropped} messages`} for its agent could not be typed: its session ended and cannot be reopened. Open the task to start it again.`
          )
        );
      }
      return;
    }
    // An agent that never gets back to its prompt (a screen Untether doesn't know): told once
    // after a while instead of retrying in silence forever (2026-10-20 review).
    if (reason === 'busy' && !stall.noticed && now - stall.since >= INPUT_BUSY_NOTICE_MS) {
      stall.noticed = true;
      task.pendingNoticed = reason;
      this.save();
      // Whatever state it is in (a working task says nothing of its own), as for "gone".
      const toOrchestrator = task.origin === 'orchestrator' && !!task.orchestratorSessionId;
      if (task.notify || toOrchestrator) {
        this.post(
          this.taskPayload(
            task,
            'task-needs-you',
            `A message for its agent has waited ${Math.round((now - stall.since) / 60_000)} min: ${task.agent === 'codex' ? 'Codex has not been back at its prompt' : 'Claude has not been ready to take it'}. It goes in with the time it was sent once it is. Open the task to see its screen.`
          )
        );
      }
    }
    if (reason === 'menu' && !stall.noticed) {
      stall.noticed = true;
      task.pendingNoticed = reason;
      if (task.state === 'needs_you' && task.blocker && !task.blocker.onScreen) {
        task.blocker = { ...task.blocker, onScreen: true };
        this.save();
      }
      this.notifyState(task, '', {
        notice: 'menu',
        body: `Claude is waiting for a choice on the task's screen (${task.blocker?.message ?? 'a question'}): pick an option there; the message sent to it is not typed until then (later than 2 min, with the time it was sent).`,
      });
    }
    const base = this.deps.inputRetryMs ?? INPUT_RETRY_MS;
    const delay = Math.min(base * 2 ** Math.min(stall.attempts - 1, 20), INPUT_RETRY_MAX_MS);
    this.retryInputLater(task, delay);
  }

  /** Why the task's pending messages are not typed yet, in words for whoever sent them. */
  protected pendingReason(task: TaskRecord, reason: 'busy' | 'menu' | 'gone'): string {
    const ref = task.id.slice(0, 8);
    if (reason === 'menu') {
      const prompt = task.blocker?.prompt;
      const asks = prompt ? promptSummary(prompt) : '';
      return `its agent shows a prompt of its own on the task's screen${asks ? ` (${asks})` : ''}; \`ut task status ${ref}\` shows it and \`ut task answer ${ref} …\` answers it`;
    }
    if (reason === 'gone') return 'its session ended; Untether reopens it with the message';
    const events = this.events(task);
    if (events?.state === 'halted' && events.halt) {
      return `its agent is stopped (${events.halt.message.slice(0, 160)})`;
    }
    const held = task.sessionId ? this.userHolds.get(task.sessionId) : undefined;
    if (held) return `${held} (Untether never types over the user's own input)`;
    return task.agent === 'codex'
      ? 'Codex is at work and only takes text at its prompt'
      : 'Claude is not ready to take it (starting, or a screen Untether does not know)';
  }

  /** The typing into a task's session waits on the user's own input there, and why. */
  inputHeldByUser(sessionId: string, why: string): void {
    this.userHolds.set(sessionId, why);
  }

  /**
   * What the prompt on the task's screen says, into its blocker: its menu read off the screen,
   * and what the agent's own event says it asks for (the whole command). Kept on the task, so
   * `ut task status` shows it from anywhere and a restart does not forget it.
   */
  protected async readPromptOf(task: TaskRecord): Promise<TaskPrompt | undefined> {
    const sessionId = task.sessionId;
    if (!sessionId || !this.onClaudePrompt(task)) return undefined;
    const menu =
      (await Promise.resolve(this.deps.readPrompt?.(sessionId)).catch(() => null)) ?? null;
    if (task.sessionId !== sessionId || !this.onClaudePrompt(task) || !task.blocker) {
      return undefined;
    }
    const events = this.events(task);
    const before = task.blocker.prompt;
    const detail = menu?.detail?.filter((line) => line.trim()) ?? [];
    const sameScreen =
      !!before &&
      before.question === (menu?.question ?? '') &&
      (before.detail ?? []).join('\n') === detail.join('\n');
    // Its event may have moved on (a subagent's prompt while the main agent works): what it
    // said of this same prompt stays.
    const asks =
      (events?.state === 'permission' || events?.state === 'question'
        ? events.asking
        : undefined) ?? (sameScreen || !menu ? before?.asks : undefined);
    const prompt: TaskPrompt = {
      question: menu?.question ?? before?.question ?? '',
      options: menu?.options ?? before?.options ?? [],
      ...(detail.length ? { detail } : !menu && before?.detail ? { detail: before.detail } : {}),
      ...(asks ? { asks } : {}),
      since: new Date(this.now()).toISOString(),
    };
    if (promptDeletes(prompt)) prompt.deletes = true;
    const wrapped = untetherWrapper(prompt.asks ?? detail.join('\n'));
    if (wrapped) prompt.wrapped = wrapped;
    // The same prompt read again keeps its clock and whether the user was told.
    const same =
      !!before &&
      (!menu || sameScreen || (!!before.asks && before.asks === prompt.asks)) &&
      (!before.asks || !prompt.asks || before.asks === prompt.asks);
    if (before && same) {
      prompt.since = before.since;
      if (before.toldUserAt) prompt.toldUserAt = before.toldUserAt;
    }
    if (JSON.stringify(before) === JSON.stringify(prompt)) return before;
    task.blocker = { ...task.blocker, prompt };
    this.save();
    // Its orchestrator reads what it asks and how to answer, once per prompt (the phone has
    // the session's own "waiting" push).
    if (task.origin === 'orchestrator' && task.orchestratorSessionId && !(before && same)) {
      // What it asks and how to answer go with its event (orchestrator.ts taskDetail reads
      // the blocker's prompt): a push's own text is cut at 200 characters.
      this.notifyState(task, '', {
        notice: `prompt-${prompt.since}`,
        body: `Its agent asks: ${promptSummary(prompt) || task.blocker.message}`,
      });
    }
    // On a command Untether itself rewrote (2026-11-11): its wrapper may be all the prompt is
    // about, so nobody waits PROMPT_ESCALATE_MS: the user's phone hears now, with the whole
    // command, whoever the task reports to (its orchestrator's event above carries it too).
    if (prompt.wrapped && !(before && same && before.wrapped)) {
      this.deps.onError?.(
        `Task ${task.id}: its agent asks permission for a command Untether rewrote (${prompt.wrapped}): ${promptWhole(prompt)}`
      );
      this.tellUserOfPrompt(
        task,
        `Its agent asks permission for a command Untether itself rewrote (${prompt.wrapped})`,
        task.blocker.prompt,
        promptWhole(prompt)
      );
    }
    return task.blocker.prompt;
  }

  /**
   * Tasks stopped on a prompt of their agent's (each tick): one not read yet is read, and one
   * nobody answered in PROMPT_ESCALATE_MS is told to the user's phone, whoever the task
   * reports to (2026-11-10: 3dc243e4 sat there for hours, known only to an orchestrator that
   * could do nothing about it).
   */
  protected watchPrompts(): void {
    const after = this.deps.promptEscalateMs ?? PROMPT_ESCALATE_MS;
    const now = this.now();
    for (const task of this.tasks) {
      if (!this.onClaudePrompt(task) || !task.blocker || this.promptReads.has(task.id)) continue;
      const prompt = task.blocker.prompt;
      if (!prompt || !prompt.options.length) {
        this.promptReads.add(task.id);
        this.track(
          this.readPromptOf(task)
            .catch(() => undefined)
            .then(() => {
              this.promptReads.delete(task.id);
            })
        );
      }
      if (!prompt || prompt.toldUserAt) continue;
      const waited = now - Date.parse(prompt.since);
      if (!(waited >= after)) continue;
      // A task of the user's own with pushes on told their phone when the prompt came up.
      const toOrchestrator = task.origin === 'orchestrator' && !!task.orchestratorSessionId;
      if (task.notify && !toOrchestrator) continue;
      this.tellUserOfPrompt(
        task,
        `Nobody answered its agent's prompt in ${Math.max(1, Math.round(waited / 60_000))} min`
      );
    }
  }

  /** The user's phone, directly (never routed to the task's orchestrator). Once per prompt. */
  protected tellUserOfPrompt(
    task: TaskRecord,
    why: string,
    prompt: TaskPrompt | undefined = task.blocker?.prompt,
    /** What it asks, when the push carries it whole (to WRAPPED_PUSH_MAX), not its summary. */
    whole?: string
  ): void {
    if (!prompt) return;
    const recorded = task.blocker?.prompt;
    if (task.blocker && recorded) {
      if (recorded.toldUserAt) return;
      task.blocker = {
        ...task.blocker,
        prompt: { ...recorded, toldUserAt: new Date(this.now()).toISOString() },
      };
    } else {
      // On no blocker (the task is not «needs you»): remembered here, told once per prompt.
      const key = JSON.stringify([prompt.asks ?? '', prompt.detail ?? [], prompt.question]);
      if (this.promptTold.get(task.id) === key) return;
      this.promptTold.set(task.id, key);
    }
    // post() saves: the mark above is written with the push it goes with.
    const payload = this.taskPayload(
      task,
      'task-needs-you',
      `${why}: ${promptSummary(prompt) || task.blocker?.message || 'a prompt'}. Open the task to answer it on its screen.`
    );
    payload.data = { ...payload.data, toUser: true };
    if (whole) {
      // Past a push's usual 200 characters, within what a push service takes (4 KB in all).
      const said = `${why}: ${whole}`;
      payload.body =
        said.length > WRAPPED_PUSH_MAX ? `${said.slice(0, WRAPPED_PUSH_MAX - 1)}…` : said;
      payload.data = { ...payload.data, detail: payload.body };
    }
    this.post(payload);
  }

  /**
   * `ut task answer`: answers the prompt on the task's screen. `byAgent`: asked by an agent (its
   * orchestrator), which never approves a deletion, a prompt Untether could not read, or an
   * option that allows more than this call: refused, and the user's phone is told at once.
   * The menu is read again first and only answered while it is still the one waiting.
   */
  async answerPrompt(
    id: string,
    answer: PromptAnswer,
    options: { byAgent?: boolean } = {}
  ): Promise<TaskActionResult> {
    const task = this.tasks.find((entry) => entry.id === id);
    if (!task) return { ok: false, code: 'not-found', message: 'Task not found' };
    const sessionId = task.sessionId;
    if (isFinal(task) || !sessionId || this.deps.sessionStatus(sessionId) !== 'running') {
      return { ok: false, code: 'session-gone', message: "The task's session is not running" };
    }
    const read = this.deps.readPrompt;
    const pick = this.deps.answerPrompt;
    if (!read || !pick) {
      return { ok: false, code: 'no-prompt', message: 'This server cannot answer prompts' };
    }
    const menu = await read(sessionId).catch(() => null);
    if (!menu?.options.length) {
      return {
        ok: false,
        code: 'no-prompt',
        message: "No prompt on the task's screen now (it was answered, or it is not a menu)",
      };
    }
    // What it asks, as it stands now (a newer prompt than the one last recorded).
    const known = (await this.readPromptOf(task)) ?? task.blocker?.prompt;
    const prompt: TaskPrompt = {
      question: menu.question,
      options: menu.options,
      ...(menu.detail?.length ? { detail: menu.detail } : {}),
      ...(known?.asks ? { asks: known.asks } : {}),
      since: known?.since ?? new Date(this.now()).toISOString(),
    };
    if (promptDeletes(prompt)) prompt.deletes = true;
    const option =
      answer.kind === 'approve'
        ? approveOption(menu.options)
        : answer.kind === 'option'
          ? answer.option
          : denyOption(menu.options);
    if (!Number.isInteger(option) || option < 1 || option > menu.options.length) {
      return {
        ok: false,
        code: 'no-prompt',
        message: `The prompt has no such option. Its options: ${menu.options.map((label, index) => `${index + 1}. ${label}`).join(' / ')}`,
      };
    }
    const label = menu.options[option - 1];
    if (options.byAgent) {
      const why = agentMayNotAnswer(prompt, label);
      if (why) {
        this.deps.onError?.(
          `Task ${task.id}: an agent's answer to its prompt was refused (${why})`
        );
        this.tellUserOfPrompt(task, 'Its agent asks for something only you approve', prompt);
        return {
          ok: false,
          code: 'needs-user',
          message: `Not answered: ${why}. The user was told on the phone; you may still deny it (\`ut task answer ${task.id.slice(0, 8)} deny\`) or say what to do instead (--text).`,
        };
      }
    }
    const result = await pick(sessionId, menu, option).catch(() => 'not-delivered' as const);
    if (result !== 'ok') {
      const message = {
        changed: 'The prompt changed while answering: look at it again (`ut task status`)',
        'not-delivered': "The answer did not land: the prompt is still on the task's screen",
        unavailable: 'This server cannot answer prompts',
      }[result];
      return { ok: false, code: result === 'changed' ? 'no-prompt' : 'busy', message };
    }
    this.deps.onError?.(
      `Task ${task.id}: its prompt was answered "${label}"${options.byAgent ? ' by its orchestrator' : ''}`
    );
    if (answer.kind === 'text') {
      // Refused with what to do instead: typed once the menu is gone (deliverText waits).
      return await this.deliverText(task, answer.text, options.byAgent ? 'cli' : 'ui', false);
    }
    // What waited behind the menu goes in now, not at its next retry.
    if (task.pendingInput?.length) this.typePendingNow(task);
    return { ok: true, task: this.copy(task) };
  }

  protected retryInputLater(
    task: TaskRecord,
    delay = this.deps.inputRetryMs ?? INPUT_RETRY_MS
  ): void {
    if (this.inputTimers.has(task.id)) return;
    const timer = setTimeout(() => {
      this.inputTimers.delete(task.id);
      if (this.tasks.includes(task) && !isFinal(task)) this.track(this.pumpInput(task));
    }, delay);
    timer.unref?.();
    this.inputTimers.set(task.id, timer);
  }

  /**
   * A task's agent waits on a choice on its screen that Untether does not make for the user
   * (Codex's update menu, a prompt it does not know), its first message or a follow-up held
   * until it is answered: told once per session instead of waiting in silence (2026-10-23:
   * two Codex tasks sat 30 min on a menu nobody saw).
   */
  agentChoiceOnScreen(sessionId: string): void {
    const task = this.tasks.find(
      (entry) => entry.sessionId === sessionId && SESSION_STATES.includes(entry.state)
    );
    // Told once per session, across restarts too (choiceToldSession; 2026-11-02: told again
    // after each restart, as the retried message met the same choice).
    if (!task || isFinal(task) || task.choiceToldSession === sessionId) return;
    // Claude's own menus are told by its status ("waiting"), with their question.
    if (task.agent === 'claude' && this.lastStatus.get(sessionId) === 'waiting') return;
    task.choiceToldSession = sessionId;
    this.save();
    const toOrchestrator = task.origin === 'orchestrator' && !!task.orchestratorSessionId;
    if (!task.notify && !toOrchestrator) return;
    const agent = task.agent === 'codex' ? 'Codex' : 'Claude';
    this.post(
      this.taskPayload(
        task,
        'task-needs-you',
        `${agent} is waiting for a choice on its screen: pick an option there. What was sent to it is typed once it is back at its prompt.`
      )
    );
  }

  /**
   * A Claude task whose agent sits idle with no hold armed (2026-10-20 review: a task started
   * under two minutes before a restart, whose agent finished meanwhile, was seen idle first,
   * never armed a hold, and stayed working forever). Once it has a conversation and ran a
   * while, idle is done, as after any restart.
   */
  protected checkClaudeIdle(task: TaskRecord): void {
    const sessionId = task.sessionId;
    if (!sessionId || this.holds.has(task.id)) return;
    if (this.finishing.has(task.id) || this.piping.has(task.id) || this.discarding.has(task.id)) {
      return;
    }
    if (this.lastStatus.get(sessionId) !== 'idle' || !this.previews.has(sessionId)) return;
    if (this.inputOutstanding(task)) return;
    if (!task.startedAt || this.now() - Date.parse(task.startedAt) < RESTART_IDLE_AFTER_MS) return;
    this.armHold(task);
  }

  /**
   * Its first message or a follow-up not typed yet: the agent's quiet is a wait, not its end.
   * Only the session ending (or `ut task done`) settles such a task.
   */
  protected inputOutstanding(task: TaskRecord): boolean {
    return this.briefPending.get(task.id) === task.sessionId || !!task.pendingInput?.length;
  }

  /** When something was last typed into the task's agent (its start, a follow-up). */
  protected lastTypedAt(task: TaskRecord): number {
    // The task's own follow-ups too: lastSent is gone after a restart (2026-10-20 review).
    const lastFollowUp = task.followUps?.length
      ? Date.parse(task.followUps[task.followUps.length - 1].at)
      : 0;
    return Math.max(
      task.startedAt ? Date.parse(task.startedAt) : 0,
      this.lastSent.get(task.id) ?? 0,
      Number.isFinite(lastFollowUp) ? lastFollowUp : 0
    );
  }

  /**
   * A working Codex task whose turn is over is done: its rollout says so (task_complete, or
   * the error that ended it); a long command or a pause in its output is no end. Without a
   * rollout, a quiet spell of CODEX_IDLE_MS on its screen is (the old way, logged).
   */
  protected checkCodexIdle(task: TaskRecord): void {
    if (this.inputOutstanding(task)) return;
    const events = this.events(task);
    if (events) {
      const ended = events.state === 'turn-ended' || events.state === 'halted';
      const typed = this.lastTypedAt(task);
      // The end of a turn that ended after the last thing typed into it, not an older one.
      if (!ended || (events.turnEndedAt ?? 0) < typed) return;
      // And of the turn that took that text: one that started after it, or one already going
      // on that took it in (2026-11-09, f3719fe5: the automatic fix was typed 10 s after
      // `ut task done`, into the turn still open; no turn started for it, so its end, a usage
      // limit, was taken for an older turn's and the task sat "working" for 54 min). A turn
      // over before a text that waits in Codex's queue is neither: its own turn starts next.
      // A turn cut short is over whichever it was: a queued text would only be cut again.
      const since = typed - CODEX_TYPED_SKEW_MS;
      const tookIt = (events.turnStartedAt ?? 0) >= since || (events.lastUserInputAt ?? 0) >= since;
      if (!tookIt && events.state !== 'halted') return;
      this.decided('turn-ended', 'events', task);
      this.track(this.finish(task));
      return;
    }
    const lastOutput = task.sessionId ? this.deps.lastOutputAt?.(task.sessionId) : undefined;
    if (lastOutput === undefined) return;
    const since = Math.max(lastOutput, this.lastTypedAt(task));
    if (this.now() - since >= CODEX_IDLE_MS) {
      this.decided('turn-ended', 'output', task, 'no rollout of its Codex');
      this.track(this.finish(task));
    }
  }

  /**
   * A settled Codex task whose agent works again: followed as working, so the pipeline runs
   * when it is done. Codex reports no status, so its output tells: output after something was
   * typed into it since it settled (a brief that waited, a follow-up) is a new turn; any other
   * output (a phone redrawing its screen) only counts once it left new commits, checked when
   * the screen is quiet again. 2026-10-23: a brief typed 30 min late was worked on while its
   * task stayed "ready · The agent changed nothing" and never went through the pipeline.
   */
  protected checkCodexBack(task: TaskRecord): void {
    if (this.piping.has(task.id) || this.finishing.has(task.id) || this.discarding.has(task.id)) {
      return;
    }
    const settledAt = Date.parse(task.stateSince);
    if (!Number.isFinite(settledAt)) return;
    const events = this.events(task);
    if (events) {
      // A turn started after it settled is real work (a redraw starts none): followed again;
      // checkCodexIdle finishes it when that turn is over.
      if ((events.turnStartedAt ?? 0) <= settledAt) return;
      this.decided('works-again', 'events', task);
      this.deps.onError?.(`Task ${task.id}: its agent works again, following it`);
      this.waitingOnPrompt.delete(task.id);
      this.setState(task, 'working');
      this.seenBusy.add(task.id);
      this.save();
      return;
    }
    const lastOutput = task.sessionId ? this.deps.lastOutputAt?.(task.sessionId) : undefined;
    if (lastOutput === undefined || lastOutput <= settledAt) return;
    this.decided('works-again', 'output', task, 'no rollout of its Codex');
    const lastFollowUp = task.followUps?.length
      ? Date.parse(task.followUps[task.followUps.length - 1].at)
      : Number.NaN;
    const sent = Math.max(
      this.lastSent.get(task.id) ?? Number.NEGATIVE_INFINITY,
      Number.isFinite(lastFollowUp) ? lastFollowUp : Number.NEGATIVE_INFINITY
    );
    if (sent >= settledAt && lastOutput >= sent) {
      this.deps.onError?.(`Task ${task.id}: its agent works again, following it`);
      this.waitingOnPrompt.delete(task.id);
      this.setState(task, 'working');
      this.seenBusy.add(task.id);
      this.save();
      return;
    }
    if (this.now() - lastOutput < CODEX_IDLE_MS) return;
    if (this.codexProbedAt.get(task.id) === lastOutput) return;
    this.codexProbedAt.set(task.id, lastOutput);
    this.track(this.probeNewWork(task));
  }

  /**
   * The first message (or the resume text) of a session it just started: when the agent was
   * never ready to take it, it waits in pendingInput with its retries and notices instead of
   * being dropped (2026-10-20 review: a prompt given up after 60 s left the task working
   * forever, never pushed).
   */
  protected watchTyped(task: TaskRecord, launched: LaunchedSession): void {
    const { typed, text } = launched;
    if (!typed || !text) {
      endEffect(task, 'session', launched.sessionId);
      return;
    }
    // Its time is when the session started, not when the typing gave up.
    const at = new Date(this.now()).toISOString();
    this.briefPending.set(task.id, launched.sessionId);
    // Typed or given up (then it waits in pendingInput, saved below): the session's step is
    // over, saved at once (a restart no longer types it again).
    const settle = () => {
      if (this.briefPending.get(task.id) === launched.sessionId) this.briefPending.delete(task.id);
      if (pendingEffect(task, 'session', launched.sessionId)) {
        endEffect(task, 'session', launched.sessionId);
        this.save();
      }
    };
    this.track(
      typed.then(
        (ok) => {
          settle();
          if (ok && task.sessionId === launched.sessionId) this.lastSent.set(task.id, this.now());
          if (ok || isFinal(task) || task.sessionId !== launched.sessionId) return;
          // A session being replaced meanwhile: the new one gets the task again.
          if (this.replacing.has(launched.sessionId)) return;
          task.pendingInput = [...(task.pendingInput ?? []), { text, at, brief: launched.brief }];
          this.save();
          this.track(this.pumpInput(task));
        },
        () => settle()
      )
    );
  }

  /** The brief of a task's first session (or one started again with it). */
  protected briefOf(task: TaskRecord): { text: string; brief: true } {
    return { text: this.launchPrompt(task), brief: true };
  }

  protected armHold(task: TaskRecord): void {
    this.cancelHold(task.id);
    const sessionId = task.sessionId;
    const hold = setTimeout(() => {
      this.holds.delete(task.id);
      // Still idle and still open: anything newer (busy, waiting, done) cancelled this.
      if (!sessionId || this.lastStatus.get(sessionId) !== 'idle') return;
      if (task.state !== 'working' && task.state !== 'needs_you') return;
      // A fix or follow-up still waiting to be typed is the agent's next turn, not its end
      // (2026-10-20 review: the task finished on the same commit and used up a fix round).
      if (task.pendingInput?.length) {
        this.typePendingNow(task);
        return;
      }
      if (this.briefPending.get(task.id) === task.sessionId) return;
      // Its own events say it is still at work (a turn going on, a compaction, a question)
      // since it went idle: not finished (a task closed while its agent was alive).
      const events = this.events(task);
      if (
        events &&
        (events.state === 'working' ||
          events.state === 'compacting' ||
          events.state === 'question' ||
          events.state === 'permission') &&
        this.now() - events.lastEventAt < EVENTS_BUSY_TRUST_MS
      ) {
        this.deps.onError?.(
          `Task ${task.id}: idle on its status, at work by its events (${events.state}): not finished`
        );
        this.armHold(task);
        return;
      }
      this.track(this.finish(task));
    }, IDLE_HOLD_MS);
    hold.unref?.();
    this.holds.set(task.id, hold);
  }

  protected cancelHold(taskId: string): void {
    const hold = this.holds.get(taskId);
    if (hold) clearTimeout(hold);
    this.holds.delete(taskId);
  }

  /**
   * Its turn ended on a question for the user it did not report with `ut task done`: the
   * agent's own last message (its Stop or task_complete event, whole) ends with one; else the
   * last reply seen in its transcript (a 160-character preview, cut with "…" when longer).
   */
  protected endedOnQuestion(task: TaskRecord, reply: string): boolean {
    const events = this.events(task);
    if (events?.state === 'question' || events?.state === 'permission') {
      this.decided('question', 'events', task);
      return true;
    }
    if (events?.state === 'turn-ended' && events.finalMessage !== undefined) {
      this.decided('question', 'events', task);
      return events.finalMessage.trim().endsWith('?');
    }
    this.decided('question', 'text', task);
    return reply.trim().endsWith('?');
  }
}
