/**
 * One task on the home board (2026-10-18): the session row's anatomy (agent avatar with its
 * state dot, title, time) plus a coloured pill (trabajando / te necesita / lista / fusionada /
 * falló), the reason it stopped, what changed, and the buttons its state calls for: Abrir,
 * Que lo arregle, Fusionar, Descartar (secondary) and Ver cambios (the session view's changes
 * sheet on its worktree, counted from its base branch).
 *
 * A tap on the row opens its session exactly like a session row (`session-select`). The
 * buttons talk to the server through services/task-store.ts; asking first where work could be
 * lost (Descartar, a risky Fusionar).
 *
 * `variant`: 'row' (phone list), 'card' (desktop grid), 'done' ("Hechas": no buttons), 'side'
 * (split-view sidebar, 2026-11-08: the session sidebar's 44px row, title over its state in a
 * few words; no buttons, a tap does what the other rows' tap does).
 *
 * @fires session-select - The row was tapped and its session exists (detail: Session)
 */
import { html, LitElement, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { measurementLine } from '../../shared/task-result.js';
import { guardLetThrough, type TaskRecord } from '../../shared/tasks.js';
import type { Session } from '../../shared/types.js';
import { LocaleController, type MessageKey, t } from '../i18n/index.js';
import { type TaskActionResult, type TaskStore, taskStore } from '../services/task-store.js';
import { toast } from '../utils/action-toast.js';
import { clipLine, explainLine, fitTitleLines, midCutTitle } from '../utils/card-line.js';
import { confirmDialog } from '../utils/confirm-dialog.js';
import { SHOW_TASK_EVENT } from '../utils/constants.js';
import { swallowNextClick } from '../utils/ghost-click.js';
import { lazyViews } from '../utils/lazy-views.js';
import { PhoneActionSheet } from '../utils/phone-action-sheet.js';
import { endsADrag } from '../utils/pointer-drag.js';
import { prefersReducedMotion } from '../utils/reduced-motion.js';
import {
  activeAutoFix,
  type BoardTask,
  blockerKindOf,
  canRevertTask,
  isDoneTask,
  riskRuleLabel,
  runnerName,
  type TaskAction,
  taskActionLabel,
  taskActions,
  taskAgentLine,
  taskBucket,
  taskBudgetLine,
  taskDetail,
  taskDisplayTitle,
  taskErrorText,
  taskGlanceLine,
  taskReason,
  taskRowState,
  taskStateWord,
  taskStatsLine,
  taskStatusLabel,
  taskTimingRounds,
  taskTimingsLine,
  waitsForBase,
} from '../utils/task-status.js';
import { icon } from './icons.js';
import './provider-badge.js';
import { agentAvatar } from './agent-avatar.js';
import type { ProviderRef } from './provider-badge.js';

export type TaskRowVariant = 'row' | 'card' | 'done' | 'side';

/** The sidebar tile's status (a session's vocabulary) for a task's avatar state. */
const SIDE_STATUS = {
  working: 'working',
  waiting: 'needs-input',
  idle: 'idle',
  exited: 'exited-ok',
} as const;

/** What a finished request says to the user (one toast). */
export function announceTaskResult(
  result: TaskActionResult,
  okText: string,
  /** The button it answers: its own words for an error («not-fixable» on Reintentar …). */
  action?: TaskAction
): void {
  if (result.ok && result.status === 202) {
    toast({ kind: 'info', text: t('board.toast.pending') });
  } else if (result.ok) {
    toast({ kind: 'success', text: okText });
  } else {
    toast({
      kind: 'error',
      text: t('board.toast.failed', { error: taskErrorText(result, action) }),
    });
  }
}

/** How long a row waits for the store's poll after a request before its buttons come back. */
const REFRESH_WAIT_MS = 4000;

@customElement('task-row')
export class TaskRow extends LitElement {
  createRenderRoot() {
    return this;
  }

  protected readonly i18n = new LocaleController(this);

  @property({ attribute: false }) task!: BoardTask;
  /** Its session, when the list has it (a tap opens it). */
  @property({ attribute: false }) session?: Session;
  @property({ type: String }) variant: TaskRowVariant = 'row';
  /** Other open attempts of its parallel group: "Quedarme con este" instead of "Fusionar". */
  @property({ type: Number }) attempts = 0;
  @property({ type: Boolean }) selected = false;
  /** A short label in front of the title (a parallel group's «A», «B» …). */
  @property({ type: String }) prefix = '';
  @property({ attribute: false }) store: TaskStore = taskStore;

  /** The action whose request is on its way (its button shows busy, all are disabled). */
  @state() private busy: TaskAction | null = null;
  /** Briefly outlined after the needs-you strip pointed here. */
  @state() private flash = false;
  /**
   * «Más» opened: everything past the card's one line (the whole summary, its agent and model,
   * the review, the guard, the result, timings, budget, branch and counts). 2026-11-08, user
   * report: the home cards said too much.
   */
  @state() private expanded = false;
  /** Its undo task was asked for: "Deshacer" stays gone until the board lists it. */
  @state() private revertSent = false;

  /** «Deshacer» is asking or sending: a second tap does nothing. */
  private confirming = false;

  private touchedAt = 0;

  /**
   * «Fusionar» from the «Te necesita» section (2026-11-08): the row's own merge, so a parallel
   * attempt keeps («Quedarme con este», which asks) and a merge shows the same toasts and busy
   * state as its button. Nothing when the row offers no merge any more.
   */
  async mergeFromNeedsYou(): Promise<void> {
    const primary = taskActions(this.task, {
      hasSession: Boolean(this.session),
      attempts: this.attempts,
      tasks: this.storeTasks(),
    }).primary;
    if (primary === 'merge' || primary === 'keep') await this.run(primary);
  }

  /** Scroll into view and glow for a moment (the strip's pill for a task). */
  reveal() {
    this.scrollIntoView?.({
      block: 'center',
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    });
    this.flash = true;
    setTimeout(() => {
      this.flash = false;
    }, 1600);
  }

  /** pointerup for touch (the click that follows is swallowed), click for mouse and keys. */
  private tap(fn: () => void) {
    return {
      handleEvent: (e: Event) => {
        e.stopPropagation();
        if (e.type === 'pointerup') {
          const p = e as PointerEvent;
          if (p.pointerType === 'mouse' || endsADrag(p)) return;
          this.touchedAt = Date.now();
          swallowNextClick();
        } else if (Date.now() - this.touchedAt < 700) {
          return;
        }
        fn();
      },
    };
  }

  protected willUpdate(changed: Map<PropertyKey, unknown>) {
    // The server recorded its undo task: from now on the store says whether it is undone.
    if (changed.has('task') && this.revertSent && this.task?.revertedBy) this.revertSent = false;
  }

  /** The two-line title on screen (rows, cards, done): watched for being cut. */
  private titleLines: Element | null = null;

  protected updated() {
    const title = this.querySelector('.ut-title-lines');
    fitTitleLines(title, this.titleLines);
    this.titleLines = title;
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    fitTitleLines(null, this.titleLines);
    this.titleLines = null;
  }

  /** Every task the store lists (a merged task's undo task is looked up there). */
  private storeTasks(): readonly TaskRecord[] {
    return this.store?.tasks ?? [];
  }

  private open() {
    if (!this.session) {
      // Not started yet (scheduled, getting ready): nothing to open. Done or stopped with its
      // session gone (2026-10-20 verify: «aún no ha empezado» on a finished task): what it
      // did and why it stopped.
      const state = this.task.state;
      if (state === 'scheduled' || state === 'queued' || state === 'preparing') {
        toast({ kind: 'info', text: t('board.notStarted') });
        return;
      }
      this.showDetail();
      return;
    }
    this.dispatchEvent(
      new CustomEvent('session-select', { detail: this.session, bubbles: true, composed: true })
    );
  }

  private displayTitle(): string {
    return taskDisplayTitle(this.task, this.session);
  }

  private async run(action: TaskAction) {
    if (this.busy) return;
    if (action !== 'revert') {
      await this.runAction(action);
      return;
    }
    // A second tap on «Deshacer» while it asks would make a second undo task.
    if (this.confirming) return;
    this.confirming = true;
    try {
      await this.runAction(action);
    } finally {
      this.confirming = false;
    }
  }

  private async runAction(action: TaskAction) {
    const task = this.task;
    const name = this.displayTitle();
    switch (action) {
      case 'open':
        this.open();
        return;
      case 'changes': {
        const dir = task.worktreePath;
        if (!dir) return;
        lazyViews.changesSheet.use(({ openChangesSheet }) =>
          openChangesSheet(dir, { since: task.baseBranch || undefined })
        );
        return;
      }
      case 'discard': {
        const ok = await confirmDialog({
          title: t('board.discardTitle', { name }),
          body: t('board.discardBody'),
          confirmLabel: t('board.action.discard'),
          tone: 'danger',
          details: task.files.slice(0, 6),
        });
        if (!ok) return;
        await this.request(action, () => this.store.act(task.id, 'discard', { confirm: true }), {
          text: t('board.toast.discarded', { name }),
        });
        return;
      }
      case 'cancel': {
        // Two "Cancelar" buttons read as one (2026-10-20 audit): say what each does.
        const ok = await confirmDialog({
          title: t('board.cancelTitle', { name }),
          confirmLabel: t('tasks.cancelTask'),
          cancelLabel: t('board.action.keepScheduled'),
          tone: 'danger',
        });
        if (!ok) return;
        await this.request(action, () => this.store.cancel(task.id), {
          text: t('board.toast.cancelled', { name }),
        });
        return;
      }
      case 'mergeRisk': {
        const ok = await confirmDialog({
          title: t('board.mergeRiskTitle', { name }),
          body: taskReason(task),
          confirmLabel: t('board.action.merge'),
          tone: 'danger',
          details: (task.risk ?? []).map((risk) =>
            risk.file ? `${risk.file} · ${riskRuleLabel(risk.rule)}` : riskRuleLabel(risk.rule)
          ),
        });
        if (!ok) return;
        await this.request(action, () => this.store.act(task.id, 'merge', { acceptRisk: true }), {
          text: t('board.toast.merging', { name }),
        });
        return;
      }
      case 'mergeReview': {
        // Past the AI review's concerns: the user reads them first. Risk findings it had were
        // accepted already (the review runs after the risk scan), so they stay accepted.
        // The review could not run (Untether retries it): merging now goes in unreviewed.
        const unreviewed = blockerKindOf(task) === 'review-unavailable';
        const why = unreviewed
          ? t('board.mergeUnreviewedBody')
          : task.review?.summary || taskReason(task);
        const ok = await confirmDialog({
          title: t(unreviewed ? 'board.mergeUnreviewedTitle' : 'board.mergeReviewTitle', { name }),
          body: this.attempts ? `${why}\n\n${t('board.keepBody')}` : why,
          confirmLabel: t('board.action.mergeAnyway'),
          tone: 'danger',
          details: (unreviewed ? [] : (task.review?.issues ?? [])).map(
            (issue) => `${issue.file}${issue.line ? `:${issue.line}` : ''} · ${issue.what}`
          ),
        });
        if (!ok) return;
        const acceptRisk = Boolean(task.risk?.length);
        const past = { acceptReview: true, ...(acceptRisk ? { acceptRisk } : {}) };
        // One of a parallel group: merging it means keeping it, so the other attempts go once
        // it is in, as with "Quedarme con este" (the server's keep, past the review).
        if (this.attempts) {
          await this.request(
            action,
            () => this.store.act(task.id, 'keep', { confirm: true, ...past }),
            {
              text: t('board.toast.merging', { name }),
              okText: (result) =>
                result.data?.discardOnMerge
                  ? t('board.toast.keptDiscardLater', { name })
                  : t('board.toast.merging', { name }),
            }
          );
          return;
        }
        await this.request(action, () => this.store.act(task.id, 'merge', past), {
          text: t('board.toast.merging', { name }),
        });
        return;
      }
      case 'urgent':
      case 'notUrgent':
        await this.request(
          action,
          () =>
            this.store.act(task.id, 'priority', {
              level: action === 'urgent' ? 'urgent' : 'normal',
            }),
          {
            text: t(action === 'urgent' ? 'board.toast.urgent' : 'board.toast.notUrgent', { name }),
          }
        );
        return;
      case 'moreBudget':
        await this.request(action, () => this.store.act(task.id, 'budget', { change: '' }), {
          text: t('board.toast.moreBudget', { name }),
        });
        return;
      case 'hold':
        await this.request(action, () => this.store.act(task.id, 'hold'), {
          text: t('board.toast.held', { name }),
        });
        return;
      case 'merge':
        await this.request(action, () => this.store.act(task.id, 'merge'), {
          text: t('board.toast.merging', { name }),
        });
        return;
      case 'keep': {
        // Keeping one throws the other attempts away: the user says so first.
        const ok = await confirmDialog({
          title: t('board.keepTitle', { letter: this.prefix || name }),
          body: t('board.keepBody'),
          confirmLabel: t('board.action.keep'),
        });
        if (!ok) return;
        await this.request(action, () => this.store.act(task.id, 'keep', { confirm: true }), {
          text: t('board.toast.merging', { name }),
          // The others go only once this one is merged: the toast says so.
          okText: (result) =>
            result.data?.discardOnMerge
              ? t('board.toast.keptDiscardLater', { name })
              : t('board.toast.merging', { name }),
        });
        return;
      }
      case 'revert': {
        if (this.revertSent || !canRevertTask(task, this.storeTasks())) return;
        const ok = await confirmDialog({
          title: t('board.revertTitle', { name }),
          body: t('board.revertBody'),
          confirmLabel: t('board.action.revert'),
        });
        if (!ok) return;
        await this.request(action, () => this.store.act(task.id, 'revert'), {
          text: t('board.toast.reverting', { name }),
          onDone: (result) => {
            this.revertSent = true;
            const created = result.data?.task as { id?: unknown } | undefined;
            const id = typeof created?.id === 'string' ? created.id : '';
            // Its new task: brought into view once the board lists it.
            if (id) {
              window.dispatchEvent(new CustomEvent(SHOW_TASK_EVENT, { detail: { taskId: id } }));
            }
          },
        });
        return;
      }
      case 'fix':
        await this.request(action, () => this.store.act(task.id, 'fix'), {
          text: t('board.toast.fixing'),
        });
        return;
      case 'retry':
        await this.request(action, () => this.store.act(task.id, 'retry'), {
          text: t('board.toast.retrying'),
        });
        return;
      case 'switchAgent': {
        // Its pause's offer: the other agent carries it on in the same worktree.
        const offer = task.halt?.offer;
        if (!offer) return;
        await this.request(
          action,
          () => this.store.act(task.id, 'retry', { agent: offer.runner }),
          { text: t('board.toast.switchingAgent', { agent: runnerName(offer) }) }
        );
        return;
      }
      case 'startNow':
        // Past its project's limit, this one only (the server's retry of a queued task).
        await this.request(action, () => this.store.act(task.id, 'retry'), {
          text: t('board.toast.startedNow', { name }),
        });
        return;
      case 'moveUp':
      case 'moveDown': {
        const position = (task.queued?.position ?? 1) + (action === 'moveUp' ? -1 : 1);
        await this.request(
          action,
          () => this.store.act(task.id, 'move', { position: Math.max(1, position) }),
          { text: t('board.toast.moved', { position: Math.max(1, position) }) }
        );
        return;
      }
      case 'log':
        await this.showLog(name);
        return;
    }
  }

  /** "Ver registro": the tail of the log its blocker came from (setup, check or merge). */
  private async showLog(name: string) {
    const fixing = activeAutoFix(this.task)?.reason;
    const blocker = fixing ?? this.task.blocker?.kind;
    // Still getting ready (or being checked): the log being written now.
    const kind =
      this.task.state === 'preparing' || blocker === 'setup'
        ? 'setup'
        : this.task.state === 'verifying'
          ? 'verify'
          : blocker === 'merge-error'
            ? 'merge'
            : 'verify';
    this.busy = 'log';
    let result: TaskActionResult;
    try {
      result = await this.store.log(this.task.id, kind);
    } finally {
      this.busy = null;
    }
    if (!result.ok) {
      announceTaskResult(result, '', 'log');
      return;
    }
    const text = typeof result.data?.text === 'string' ? result.data.text.trim() : '';
    const sheet = new PhoneActionSheet({
      label: t('board.logTitle', { name }),
      opener: document.activeElement,
    });
    sheet.open(
      () => html`<div class="psr-sheet-group ut-surface--floating ut-surface--material" data-testid="task-log-sheet">
        <div class="psr-sheet-title tsk-sheet-title"><bdi>${t('board.logTitle', { name })}</bdi></div>
        <pre class="tsk-log ut-surface--material ut-surface--well ut-surface--record" dir="ltr">${text || t('board.logEmpty')}</pre>
      </div>`
    );
  }

  /** The log a task's stop came from, if it has one (setup, check or merge). */
  private logKind(): boolean {
    const blocker = this.task.blocker?.kind;
    return blocker === 'setup' || blocker === 'verify' || blocker === 'merge-error';
  }

  /**
   * A task whose session is gone (finished, failed, discarded): what it did or why it stopped,
   * in a sheet, with its log when it has one. Tapping it said «aún no ha empezado» before.
   */
  private showDetail() {
    const task = this.task;
    const name = this.displayTitle();
    const status = taskStatusLabel(task, { tasks: this.storeTasks() });
    const reason = taskReason(task);
    const detail = taskDetail(task) || task.summary?.trim() || '';
    const done = isDoneTask(task);
    const note = done ? t('board.detailDone') : t('board.detailNoSession');
    const rounds = taskTimingRounds(task);
    const sheet = new PhoneActionSheet({
      label: name,
      opener: document.activeElement,
    });
    const showLog = () => {
      sheet.close();
      void this.showLog(name);
    };
    sheet.open(
      () => html`<div class="psr-sheet-group ut-surface--material ut-surface--detail ut-surface--${taskBucket(task)}" data-testid="task-detail-sheet">
        <div class="psr-sheet-title tsk-sheet-title">
          <bdi>${name}</bdi>${this.renderProviderBadge('task-detail-provider-badge')}
        </div>
        <p class="tsk-sheet-status ${taskBucket(task) === 'failed' ? 'ut-surface--danger' : ''}" data-testid="task-detail-status">
          ${status}${reason ? ` · ${reason}` : ''}
        </p>
        ${detail ? html`<p class="tsk-sheet-detail" dir="auto">${detail}</p>` : nothing}
        ${
          rounds.length
            ? html`<div class="tsk-sheet-timings" data-testid="task-detail-timings">
                <div class="tsk-sheet-timings-title">${t('board.timings.label')}</div>
                ${rounds.map((round) => html`<div>${round}</div>`)}
              </div>`
            : nothing
        }
        <p class="tsk-sheet-note" data-testid="task-detail-note">${note}</p>
        ${
          this.logKind()
            ? html`<button
                type="button"
                class="ut-surface--material ut-surface--action tsk-btn"
                data-testid="task-detail-log"
                @click=${showLog}
              >
                ${taskActionLabel('log')}
              </button>`
            : nothing
        }
      </div>`
    );
  }

  private async request(
    action: TaskAction,
    send: () => Promise<TaskActionResult>,
    done: {
      text: string;
      /** The success text from the answer (e.g. what "Quedarme con este" will discard). */
      okText?: (result: TaskActionResult) => string;
      /** After a successful answer. */
      onDone?: (result: TaskActionResult) => void;
    }
  ) {
    this.busy = action;
    try {
      const result = await send();
      announceTaskResult(
        result,
        result.ok && done.okText ? done.okText(result) : done.text,
        action
      );
      if (result.ok && result.status !== 202) done.onDone?.(result);
      // The store polls after every request: the buttons stay disabled until the new state is
      // in (2026-10-20 audit: Fusionar came back for up to 3 s and could be sent twice).
      await Promise.race([
        this.store.refresh?.(),
        new Promise((resolve) => setTimeout(resolve, REFRESH_WAIT_MS)),
      ]);
    } finally {
      this.busy = null;
    }
  }

  private renderButton(action: TaskAction, primary: boolean) {
    const busy = this.busy === action;
    const danger = action === 'discard' || action === 'cancel';
    const handler = this.tap(() => void this.run(action));
    return html`<button
      type="button"
      class="ut-surface--material ut-surface--action ${primary ? 'ut-surface--primary' : ''} tsk-btn ${primary ? 'tsk-btn--primary' : ''} ${danger && !primary ? 'tsk-btn--danger ut-surface--danger' : ''}"
      data-action=${action}
      data-testid="task-action-${action}"
      aria-busy=${busy ? 'true' : 'false'}
      ?disabled=${this.busy !== null}
      @pointerdown=${(e: Event) => e.stopPropagation()}
      @pointerup=${handler}
      @click=${handler}
    >
      ${busy ? html`<span class="tsk-spinner" aria-hidden="true"></span>` : nothing}${taskActionLabel(action)}
    </button>`;
  }

  /** Its budget, spent / limit (2026-11-01); highlighted past its warning level. */
  private renderBudget() {
    const line = taskBudgetLine(this.task);
    if (!line) return nothing;
    return html`<div
      class="tsk-budget ${line.near ? 'tsk-budget--near' : ''}"
      data-testid="task-budget"
    >
      ${line.text}
    </div>`;
  }

  /** Where its time went (2026-10-31): each phase's total and its rounds. */
  private renderTimings() {
    const line = taskTimingsLine(this.task);
    if (!line || this.task.state === 'discarded') return nothing;
    return html`<div class="tsk-timings" data-testid="task-timings">
      ${icon('clock', 12)}<span class="tsk-timings-phases">${line.phases}</span
      ><span class="tsk-timings-rounds">${line.rounds}</span>
    </div>`;
  }

  /**
   * The agent's structured result (`ut task done --result`, 2026-11-01), in order: its
   * outcome and where it does not match its changes; what is left and the known risks; its
   * tests, files and measurements folded. "Hechas" shows only the outcome line.
   */
  private renderResult(done: boolean) {
    const result = this.task.result;
    const mismatch = this.task.resultMismatch;
    if ((!result && !mismatch) || this.task.state === 'discarded') return nothing;
    const failed = result?.tests.filter((test) => test.result === 'failed').length ?? 0;
    // Its groups fold and unfold where they are: a tap on them does not open the task.
    const stop = (e: Event) => e.stopPropagation();
    const list = (key: MessageKey, items: readonly string[], testId: string, open = true) =>
      items.length
        ? html`<details class="tsk-result-group" data-testid=${testId} ?open=${open}>
            <summary
              @pointerdown=${stop}
              @pointerup=${stop}
              @click=${stop}
            >${t(key)} (${items.length})</summary>
            <ul class="tsk-result-list">
              ${items.map((item) => html`<li dir="auto">${item}</li>`)}
            </ul>
          </details>`
        : nothing;
    return html`<div
      class="tsk-result ${mismatch ? 'tsk-result--mismatch' : ''}"
      data-testid="task-result"
      data-outcome=${result?.outcome ?? ''}
    >
      <div class="tsk-result-line">
        <span class="tsk-result-label">${t('board.result.label')}</span>${
          result
            ? html`<span class="tsk-result-outcome tsk-result-outcome--${result.outcome}"
                data-testid="task-result-outcome"
                >${t(`board.result.outcome.${result.outcome}` as MessageKey)}</span
              >`
            : nothing
        }${
          failed
            ? html`<span class="tsk-result-failed">${failed} ${t('board.result.test.failed')}</span>`
            : nothing
        }
      </div>
      ${
        mismatch
          ? html`<div class="tsk-result-mismatch" data-testid="task-result-mismatch" title=${mismatch}>
              ${t('board.result.mismatch')}<span class="tsk-result-mismatch-detail" dir="auto"
                >${mismatch}</span
              >
            </div>`
          : nothing
      }
      ${
        result && !done
          ? html`${list('board.result.followUps', result.followUps, 'task-result-followups')}
            ${list('board.result.risks', result.risks, 'task-result-risks')}
            ${list(
              'board.result.tests',
              result.tests.map(
                (test) =>
                  `${t(`board.result.test.${test.result}` as MessageKey)} · ${test.command}${test.detail ? ` — ${test.detail}` : ''}`
              ),
              'task-result-tests',
              failed > 0
            )}
            ${list(
              'board.result.files',
              result.files.map((file) => `${file.path} — ${file.why}`),
              'task-result-files',
              false
            )}
            ${list(
              'board.result.measurements',
              (result.measurements ?? []).map(measurementLine),
              'task-result-measurements'
            )}`
          : nothing
      }
    </div>`;
  }

  /**
   * The AI review: one line (verdict and its summary) and, when it found something, its
   * issues. "Hechas" shows only the line.
   */
  private renderReview(done: boolean) {
    const review = this.task.review;
    if (!review || this.task.state === 'discarded') return nothing;
    // A review waiting to be retried says so in its pill and detail already.
    if (blockerKindOf(this.task) === 'review-unavailable' && review.verdict === 'unavailable') {
      return nothing;
    }
    const label =
      review.verdict === 'unavailable'
        ? t('board.review.unavailable')
        : review.verdict === 'ok'
          ? t('board.review.ok')
          : t('board.review.concerns');
    // A review blocker already shows its summary as the detail line.
    const summary =
      review.verdict !== 'unavailable' && this.task.blocker?.kind !== 'review'
        ? review.summary
        : '';
    const issues = done ? [] : review.issues.slice(0, 8);
    return html`<div
      class="tsk-review tsk-review--${review.verdict}"
      data-testid="task-review"
      data-verdict=${review.verdict}
    >
      <div class="tsk-review-line">
        ${icon('search', 12)}<span class="tsk-review-label">${label}</span>${
          summary ? html`<span class="tsk-review-summary" dir="auto">${summary}</span>` : nothing
        }
      </div>
      ${
        issues.length
          ? html`<ul class="tsk-review-issues" data-testid="task-review-issues">
              ${issues.map(
                (issue) => html`<li class="tsk-review-issue" data-severity=${issue.severity}>
                  <span class="tsk-review-sev tsk-review-sev--${issue.severity}"
                    >${t(`board.review.severity.${issue.severity}` as MessageKey)}</span
                  >${
                    issue.file
                      ? html`<code dir="ltr">${issue.file}${issue.line ? `:${issue.line}` : ''}</code>`
                      : nothing
                  }<span dir="auto">${issue.what}</span>
                </li>`
              )}
            </ul>`
          : nothing
      }
    </div>`;
  }

  /**
   * What Untether's command guard blocked (2026-11-02): how many tool calls, and the latest
   * ones with their rule; a guard that could not run says so. "Hechas" shows only the line.
   */
  private renderGuard(done: boolean) {
    const blocks = this.task.guardBlocks;
    if (!blocks || (!blocks.count && !blocks.noted) || this.task.state === 'discarded') {
      return nothing;
    }
    const blocked = blocks.recent.filter((entry) => !guardLetThrough(entry.rule));
    const notes = blocks.recent.filter((entry) => guardLetThrough(entry.rule));
    const count = blocks.count;
    const failed = notes.some((entry) => entry.rule === 'guard-error');
    const items = done ? [] : [...blocked.slice(-5).reverse(), ...notes.slice(-2).reverse()];
    const label =
      count > 0
        ? t('board.guard.blocked', { count })
        : failed
          ? t('board.guard.unguarded')
          : t('board.guard.noted', { count: blocks.noted ?? notes.length });
    return html`<div class="tsk-guard" data-testid="task-guard">
      <div class="tsk-review-line">
        ${icon('shield', 12)}<span class="tsk-review-label"
          >${label}</span
        >
      </div>
      ${
        items.length
          ? html`<ul class="tsk-review-issues" data-testid="task-guard-items">
              ${items.map(
                (entry) => html`<li class="tsk-review-issue" title=${entry.reason}>
                  <span class="tsk-review-sev tsk-review-sev--${guardLetThrough(entry.rule) ? 'low' : 'medium'}"
                    >${entry.rule}</span
                  >${
                    entry.what
                      ? html`<code dir="ltr">${entry.what}</code>`
                      : html`<span dir="auto">${entry.reason}</span>`
                  }
                </li>`
              )}
            </ul>`
          : nothing
      }
    </div>`;
  }

  private get provider(): ProviderRef | undefined {
    const { modelProvider, model } = this.task;
    return modelProvider ? { id: modelProvider, model } : undefined;
  }

  /** The mark of a task that runs on an external model provider (`--model PROVIDER:MODEL`). */
  private renderProviderBadge(testId: string, besideLogo = false) {
    if (!this.task.modelProvider) return nothing;
    return html`<ut-provider-badge
      data-testid=${testId}
      .besideLogo=${besideLogo}
      .providerId=${this.task.modelProvider}
      .model=${this.task.model}
    ></ut-provider-badge>`;
  }

  /**
   * The whole detail behind «Más»: the agent's summary keeps its line breaks (what it did,
   * how it checked it, how to undo it), a blocker's message reads in full.
   */
  private renderDetail(detail: string) {
    if (!detail) return nothing;
    const isSummary = !this.task.blocker && detail === (this.task.summary?.trim() ?? '');
    return html`<div
      class="tsk-detail tsk-detail--open ${isSummary ? 'tsk-detail--summary' : ''}"
      dir="auto"
      data-testid="task-detail"
    >${detail}</div>`;
  }

  /** «Más» / «Menos»: the details stay out of the card until asked for (2026-11-08). */
  private renderMoreToggle() {
    const toggle = this.tap(() => {
      this.expanded = !this.expanded;
    });
    return html`<button
      type="button"
      class="ut-text-action tsk-more"
      data-testid="task-more-toggle"
      aria-expanded=${this.expanded ? 'true' : 'false'}
      @pointerdown=${(e: Event) => e.stopPropagation()}
      @pointerup=${toggle}
      @click=${toggle}
    >
      ${this.expanded ? t('card.less') : t('card.more')}
    </button>`;
  }

  /** The sidebar's row: the compact session card's anatomy, with the state as its second line. */
  private renderSide() {
    const task = this.task;
    const title = this.displayTitle();
    const tasks = this.storeTasks();
    const status = taskStatusLabel(task, { tasks });
    const reason = taskReason(task);
    const side = SIDE_STATUS[taskRowState(task)];
    const open = this.tap(() => this.open());
    return html`<div
      class="ut-side-row ut-surface--material ut-surface--${taskBucket(task)} ${this.selected ? 'is-selected ut-surface--selected-row' : ''}"
      role="button"
      tabindex="0"
      aria-current=${this.selected ? 'page' : nothing}
      aria-label=${`${this.prefix ? `${this.prefix} · ` : ''}${title}, ${status}${reason ? `, ${reason}` : ''}`}
      title=${reason ? `${status} · ${reason}` : status}
      data-testid="compact-task-row"
      data-task-id=${task.id}
      data-state=${task.state}
      data-session-id=${this.session?.id ?? nothing}
      @pointerup=${open}
      @click=${open}
      @keydown=${(e: KeyboardEvent) => {
        if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
        e.preventDefault();
        // The list's own Enter would click this row again: a second sheet or toast.
        e.stopPropagation();
        this.open();
      }}
    >
      ${agentAvatar({
        variant: 'side',
        kind: task.agent === 'codex' ? 'codex' : 'claude',
        status: side,
        provider: this.provider,
      })}
      <span class="ut-side-text">
        <span class="ut-side-name ut-mid" dir="auto"
          >${this.prefix ? html`<span class="tsk-prefix" dir="ltr">${this.prefix}</span>` : nothing}${midCutTitle(title)}</span
        >
        <span class="ut-side-task-state" data-testid="compact-task-state" data-bucket=${taskBucket(task)}
          >${this.renderProviderBadge('compact-task-provider-badge', true)}${taskStateWord(task, { tasks })}</span
        >
      </span>
      <span class="ut-side-right">
        <span class="ut-side-task-time"
          ><ut-row-time at=${task.stateSince || task.createdAt}></ut-row-time
        ></span>
      </span>
    </div>`;
  }

  render() {
    const task = this.task;
    if (!task) return nothing;
    if (this.variant === 'side') return this.renderSide();
    const bucket = taskBucket(task);
    const tasks = this.storeTasks();
    const title = this.displayTitle();
    const reason = taskReason(task);
    const detail = taskDetail(task);
    const stats = taskStatsLine(task);
    const agentLine = taskAgentLine(task);
    const caption = [task.branch, stats].filter(Boolean).join(' · ');
    const kind = task.agent === 'codex' ? 'codex' : 'claude';
    const done = this.variant === 'done';
    // "Hechas" shows no buttons but "Deshacer" on a task merged lately.
    const allActions = done
      ? {
          primary: null,
          secondary: taskActions(task, { hasSession: false, tasks }).secondary.filter(
            (action) => action === 'revert'
          ),
        }
      : taskActions(task, { hasSession: Boolean(this.session), attempts: this.attempts, tasks });
    // Its undo task was just asked for: no second "Deshacer" while the board catches up.
    const actions = this.revertSent
      ? {
          primary: allActions.primary === 'revert' ? null : allActions.primary,
          secondary: allActions.secondary.filter((action) => action !== 'revert'),
        }
      : allActions;
    const buttons = [
      ...(actions.primary ? [this.renderButton(actions.primary, true)] : []),
      ...actions.secondary.map((action) => this.renderButton(action, false)),
    ];
    const status = taskStatusLabel(task, { tasks });
    // Waiting for its review to be retried, or for its base to be clean, is not work going on:
    // no pulsing dot.
    const pulse =
      bucket === 'working' && blockerKindOf(task) !== 'review-unavailable' && !waitsForBase(task);
    // The one line (card-line.ts): what its agent does now while it works (the model's line),
    // else why it stopped, else its summary's first line.
    const explain = task.state === 'working' ? explainLine(this.session) : '';
    const line = taskGlanceLine(task, explain);
    const lineIsExplain = Boolean(explain) && line === explain;
    const lineTitle = lineIsExplain ? line : reason || detail.split('\n')[0] || '';
    const hasMore = Boolean(
      (reason && reason !== line) ||
        (detail && clipLine(detail) !== line) ||
        agentLine ||
        caption ||
        (task.review && task.state !== 'discarded') ||
        task.guardBlocks?.count ||
        task.guardBlocks?.noted ||
        task.result ||
        task.resultMismatch ||
        taskTimingsLine(task) ||
        taskBudgetLine(task)
    );
    const open = this.tap(() => this.open());
    const time = task.finishedAt && done ? task.finishedAt : task.stateSince || task.createdAt;
    return html`
      <div
        class="tsk ut-surface--material tsk--${this.variant} ${this.selected ? 'psr-selected' : ''} ${this.flash ? 'tsk-flash' : ''}"
        data-testid="task-row"
        data-task-id=${task.id}
        data-state=${task.state}
        data-bucket=${bucket}
      >
        <div
          class="tsk-main"
          role="button"
          tabindex="0"
          aria-label=${`${this.prefix ? `${this.prefix} · ` : ''}${title}, ${status}${reason ? `, ${reason}` : ''}`}
          @pointerup=${open}
          @click=${open}
          @keydown=${(e: KeyboardEvent) => {
            if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
            e.preventDefault();
            this.open();
          }}
        >
          ${agentAvatar({ variant: 'row', kind, state: taskRowState(task), provider: this.provider })}
          <div class="psr-body">
            <div class="psr-top">
              <span class="psr-title ut-title-lines" dir="auto"
                >${this.prefix ? html`<span class="tsk-prefix" dir="ltr">${this.prefix}</span>` : nothing}${midCutTitle(title)}</span
              >
              ${this.renderProviderBadge('task-provider-badge', true)}
              <span class="psr-time"><ut-row-time at=${time}></ut-row-time></span>
            </div>
            <div class="tsk-status">
              <span class="tsk-pill tsk-pill--${bucket}" data-testid="task-pill">${
                pulse ? html`<span class="tsk-pulse" aria-hidden="true"></span>` : nothing
              }${status}</span>
              ${
                line
                  ? html`<span
                      class="tsk-reason ${lineIsExplain ? 'tsk-reason--explain' : ''}"
                      data-testid="task-line"
                      title=${lineTitle}
                      dir="auto"
                      >${line}</span
                    >`
                  : nothing
              }
              ${hasMore ? this.renderMoreToggle() : nothing}
            </div>
            ${
              this.expanded
                ? html`<div class="tsk-more-body" data-testid="task-more">
                    ${
                      reason && reason !== line
                        ? html`<div class="tsk-detail" data-testid="task-reason">${reason}</div>`
                        : nothing
                    }
                    ${this.renderDetail(detail)}
                    ${
                      agentLine
                        ? html`<div class="tsk-agent" data-testid="task-agent" dir="auto">${agentLine}</div>`
                        : nothing
                    }
                    ${this.renderReview(done)}${this.renderGuard(done)}
                    ${this.renderResult(done)}
                    ${this.renderTimings()}${this.renderBudget()}
                    ${
                      caption
                        ? html`<div class="tsk-caption" data-testid="task-caption">
                            ${task.branch ? icon('gitBranch', 12) : nothing}<span dir="ltr">${caption}</span>
                          </div>`
                        : nothing
                    }
                  </div>`
                : nothing
            }
          </div>
        </div>
        ${buttons.length ? html`<div class="tsk-actions" data-testid="task-actions">${buttons}</div>` : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'task-row': TaskRow;
  }
}
