/**
 * "Share with phone" (shared/mac-share.ts): the sheet that explains, confirms and follows the
 * share of an agent running in a Terminal or iTerm2 tab. Its job runs on the server: hiding
 * the sheet, or the phone sleeping, doesn't stop it, and the row reopens its progress.
 *
 * explain (once per app on this device) → planning → confirm → progress → done (the session
 * opens), or an error: before the close "Nothing was changed."; after it, the command to run
 * in that tab, never dismissed on its own.
 *
 * Rendered into <body> like the conversation sheet, with its own styles. While confirming it
 * is an alertdialog; taps act on pointerup, and a tap within 500 ms of a new step is ignored,
 * so the tap that opened a step can't answer it.
 */
import { html, LitElement, nothing, render } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import {
  type MacShareJob,
  type MacSharePlan,
  type MacShareSheetDetail,
  macShareDisplayCommand,
} from '../../shared/mac-share.js';
import { LocaleController, t } from '../i18n/index.js';
import { Z_INDEX } from '../utils/constants.js';
import { swallowNextClick } from '../utils/ghost-click.js';
import {
  fetchMacShareJob,
  isMacShareJobFinal,
  MacShareApiError,
  macShareErrorText,
  macShareExplained,
  macShareNames,
  macShareReasonText,
  macShareStepText,
  planMacShare,
  rememberMacShareExplained,
  startMacShare,
} from '../utils/mac-share.js';
import { endsADrag } from '../utils/pointer-drag.js';
import { focusSheet, holdSheetFocus } from '../utils/sheet-a11y.js';

/** Taps this soon after a step appears belong to the gesture that led to it. */
export const MAC_SHARE_STEP_GUARD_MS = 500;
export const MAC_SHARE_POLL_MS = 1000;
/** "Shared" stays on screen this long before the session opens. */
const DONE_PAUSE_MS = 600;
/** Longer after a new window: it says where it reopened and what happened to the old tab. */
const DONE_NEW_WINDOW_PAUSE_MS = 2500;

type Phase = 'explain' | 'planning' | 'confirm' | 'starting' | 'progress' | 'done' | 'error';

export interface MacShareSheetOptions {
  authHeader: () => Record<string, string>;
  /** The job reopened it here: open that session (with a dialog to answer when `needs`). */
  onShared: (sessionId: string, needs?: MacShareJob['needs']) => void;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

@customElement('mac-share-sheet')
export class MacShareSheet extends LitElement {
  createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) detail!: MacShareSheetDetail;
  @property({ attribute: false }) options!: MacShareSheetOptions;
  @state() private phase: Phase = 'planning';
  @state() private plan: MacSharePlan | null = null;
  @state() private job: MacShareJob | null = null;
  @state() private errorText = '';
  @state() private copyState: 'idle' | 'copied' | 'failed' = 'idle';
  protected readonly i18n = new LocaleController(this);

  private stepAt = Date.now();
  private touchActedAt = 0;
  private polling = false;
  private closed = false;

  firstUpdated() {
    if (this.detail.jobId) {
      this.follow(this.detail.jobId);
    } else if (macShareExplained(this.detail.app)) {
      void this.runPlan();
    } else {
      this.to('explain');
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.closed = true;
  }

  private get names() {
    return macShareNames(this.detail, this.job?.windowApp ?? this.plan?.windowApp);
  }

  /** The job started: from here the sheet hides instead of cancelling. */
  get started(): boolean {
    return this.job !== null || this.phase === 'starting';
  }

  private to(phase: Phase) {
    this.phase = phase;
    this.stepAt = Date.now();
    this.copyState = 'idle';
    void this.updateComplete.then(() =>
      focusSheet(this.querySelector<HTMLElement>('.ut-macshare-sheet'))
    );
  }

  close = () => {
    this.dispatchEvent(new CustomEvent('close'));
  };

  /** Touch acts on pointerup (its click swallowed), mouse and keyboard on click. */
  private tap(fn: () => void) {
    return {
      handleEvent: (e: Event) => {
        if (e.type === 'pointerdown') return;
        if (Date.now() - this.stepAt < MAC_SHARE_STEP_GUARD_MS) return;
        if (e.type === 'pointerup') {
          const pointer = e as PointerEvent;
          if (pointer.pointerType === 'mouse' || endsADrag(pointer)) return;
          this.touchActedAt = Date.now();
          swallowNextClick();
        } else if (Date.now() - this.touchActedAt < 700) {
          return;
        }
        fn();
      },
    };
  }

  // ---- flow ---------------------------------------------------------------------------------

  private explained = () => {
    rememberMacShareExplained(this.detail.app);
    void this.runPlan();
  };

  private async runPlan() {
    this.to('planning');
    try {
      const plan = await planMacShare(
        this.detail.id,
        { allowPrompt: macShareExplained(this.detail.app) },
        this.options.authHeader()
      );
      if (this.closed) return;
      this.plan = plan;
      this.to('confirm');
    } catch (error) {
      if (this.closed) return;
      if (error instanceof MacShareApiError && error.code === 'automation-ask') {
        this.to('explain');
        return;
      }
      this.fail(error);
    }
  }

  private share = async () => {
    const plan = this.plan;
    if (!plan || this.phase !== 'confirm') return;
    this.to('starting');
    try {
      const jobId = await startMacShare(this.detail.id, plan.token, this.options.authHeader());
      if (this.closed) return;
      this.follow(jobId);
    } catch (error) {
      if (!this.closed) this.fail(error);
    }
  };

  private fail(error: unknown) {
    const code = error instanceof MacShareApiError ? error.code : 'failed';
    const shell = error instanceof MacShareApiError ? error.shell : undefined;
    this.errorText = macShareErrorText(code, this.names, shell);
    this.job = null;
    this.to('error');
  }

  /** Polls the job every second while the sheet is open, until it ends. */
  private follow(jobId: string) {
    if (this.phase !== 'progress') this.to('progress');
    if (this.polling) return;
    this.polling = true;
    void (async () => {
      try {
        while (!this.closed) {
          let job: MacShareJob;
          try {
            job = await fetchMacShareJob(jobId, this.options.authHeader());
          } catch (error) {
            if (error instanceof MacShareApiError && error.status === 404) {
              this.fail(new MacShareApiError('gone', 404));
              return;
            }
            await sleep(MAC_SHARE_POLL_MS);
            continue;
          }
          if (this.closed) return;
          this.job = job;
          if (job.state === 'shared' && job.sessionId) {
            this.to('done');
            const { sessionId, needs } = job;
            await sleep(job.mode === 'new-window' ? DONE_NEW_WINDOW_PAUSE_MS : DONE_PAUSE_MS);
            if (!this.closed) {
              this.options.onShared(sessionId, needs);
              this.close();
            }
            return;
          }
          if (job.state === 'aborted' || job.state === 'still-running') {
            this.errorText =
              job.state === 'still-running'
                ? t('macShare.error.stillRunning', this.names)
                : macShareErrorText(job.error ?? 'failed', this.names);
            this.to('error');
            return;
          }
          if (isMacShareJobFinal(job)) {
            this.requestUpdate();
            return;
          }
          await sleep(MAC_SHARE_POLL_MS);
        }
      } finally {
        this.polling = false;
      }
    })();
  }

  private retry = () => {
    this.plan = null;
    this.job = null;
    void this.runPlan();
  };

  private copy = async () => {
    const command = this.job?.resumeCommand ?? '';
    try {
      await navigator.clipboard.writeText(command);
      this.copyState = 'copied';
    } catch {
      // No clipboard (an insecure origin): select the text for the system's own copy.
      const code = this.querySelector<HTMLElement>('[data-testid="mac-share-resume"]');
      const selection = window.getSelection();
      if (code && selection) {
        const range = document.createRange();
        range.selectNodeContents(code);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      this.copyState = 'failed';
    }
  };

  // ---- render -------------------------------------------------------------------------------

  private button(label: string, testId: string, fn: () => void, primary = false) {
    const handler = this.tap(fn);
    return html`<button
      class=${primary ? 'ut-macshare-primary' : 'ut-macshare-secondary'}
      data-testid=${testId}
      @pointerdown=${handler}
      @pointerup=${handler}
      @click=${handler}
    >
      ${label}
    </button>`;
  }

  private renderCommand(command: string, testId: string) {
    return html`<code class="ut-macshare-command" dir="ltr" data-testid=${testId}>${macShareDisplayCommand(command)}</code>`;
  }

  private renderExplain() {
    const { app } = this.names;
    return html`
      <h2 class="ut-macshare-title" id="ut-macshare-title">${t('macShare.explain.title', { app })}</h2>
      <p class="ut-macshare-text" id="ut-macshare-desc">${t('macShare.explain.body', { app })}</p>
      <div class="ut-macshare-actions">
        ${this.button(t('macShare.explain.continue'), 'mac-share-explain-continue', this.explained, true)}
        ${this.button(t('common.cancel'), 'mac-share-cancel', this.close)}
      </div>
    `;
  }

  private renderConfirm(plan: MacSharePlan) {
    const dropped = [
      ...plan.dropped,
      ...(plan.droppedPrompt ? [t('macShare.confirm.launchPrompt')] : []),
    ];
    return html`
      <h2 class="ut-macshare-title" id="ut-macshare-title">${t('macShare.confirm.title')}</h2>
      <div id="ut-macshare-desc">
        <p class="ut-macshare-text">${t('macShare.confirm.body', this.names)}</p>
        ${
          plan.mode === 'new-window'
            ? html`<p class="ut-macshare-text" data-testid="mac-share-new-window">${t('macShare.confirm.newWindow', this.names)}</p>
                <p class="ut-macshare-warn" data-testid="mac-share-draft-unchecked">${t('macShare.confirm.draftUnchecked')}</p>`
            : html`<p class="ut-macshare-note">${t('macShare.confirm.note')}</p>`
        }
        <p class="ut-macshare-note" data-testid="mac-share-background">${t('macShare.confirm.background')}</p>
      </div>
      <details class="ut-macshare-details" data-testid="mac-share-command-details">
        <summary>${t('macShare.confirm.command')}</summary>
        ${this.renderCommand(plan.command, 'mac-share-command')}
        ${
          dropped.length
            ? html`<p class="ut-macshare-note" data-testid="mac-share-dropped">${t('macShare.confirm.dropped', { flags: dropped.join(', ') })}</p>`
            : nothing
        }
        ${
          plan.warnings.includes('argv-inexact')
            ? html`<p class="ut-macshare-note">${t('macShare.confirm.inexact')}</p>`
            : nothing
        }
      </details>
      <div class="ut-macshare-actions">
        ${this.button(t('macShare.confirm.share'), 'mac-share-confirm', () => void this.share(), true)}
        ${this.button(t('common.cancel'), 'mac-share-cancel', this.close)}
      </div>
    `;
  }

  /** Waiting on the server: planning, starting, or a running job. */
  private renderProgress() {
    const job = this.job;
    const text =
      this.phase === 'planning' || this.phase === 'starting' || !job
        ? t('macShare.step.checking')
        : macShareStepText(job, this.names);
    return html`
      <h2 class="ut-macshare-title" id="ut-macshare-title"><bdi>${this.detail.title ?? this.names.agent}</bdi></h2>
      <p class="ut-macshare-step" role="status" aria-live="polite" data-testid="mac-share-step">
        <span class="ut-macshare-spinner" aria-hidden="true"></span>${text}
      </p>
      ${
        job?.closed && job.step !== 'waiting-unlock'
          ? html`<p class="ut-macshare-note">${t('macShare.step.saved')}</p>`
          : nothing
      }
      <div class="ut-macshare-actions">
        ${
          this.started
            ? this.button(t('macShare.hide'), 'mac-share-hide', this.close)
            : this.button(t('common.cancel'), 'mac-share-cancel', this.close)
        }
      </div>
    `;
  }

  /** Closed on the Mac and saved, but not reopened (or not confirmed): the command to run. */
  private renderClosed(job: MacShareJob) {
    const unknown = job.state === 'relaunch-unknown' || job.reason === 'unconfirmed';
    const reason = macShareReasonText(job.reason, this.names, job.seconds);
    const copied =
      this.copyState === 'copied'
        ? t('files.copied')
        : this.copyState === 'failed'
          ? t('files.copyFailed')
          : '';
    return html`
      <h2 class="ut-macshare-title" id="ut-macshare-title">${t('macShare.failed.title', { ...this.names, reason })}</h2>
      <div id="ut-macshare-desc">
        ${unknown ? html`<p class="ut-macshare-warn" data-testid="mac-share-check-first">${t('macShare.failed.checkFirst', this.names)}</p>` : nothing}
        <p class="ut-macshare-text">${t('macShare.failed.howTo')}</p>
      </div>
      ${this.renderCommand(job.resumeCommand ?? '', 'mac-share-resume')}
      <p class="ut-macshare-note" role="status" data-testid="mac-share-copied">${copied}</p>
      <div class="ut-macshare-actions">
        ${this.button(t('ssh.copyCommand'), 'mac-share-copy', () => void this.copy(), true)}
        ${this.button(t('common.close'), 'mac-share-close', this.close)}
      </div>
    `;
  }

  private renderError() {
    const stillRunning = this.job?.state === 'still-running';
    return html`
      <h2 class="ut-macshare-title" id="ut-macshare-title">${this.errorText}</h2>
      ${stillRunning ? nothing : html`<p class="ut-macshare-text" id="ut-macshare-desc">${t('macShare.unchanged')}</p>`}
      <div class="ut-macshare-actions">
        ${this.button(t('macShare.retry'), 'mac-share-retry', this.retry, true)}
        ${this.button(t('common.close'), 'mac-share-close', this.close)}
      </div>
    `;
  }

  private renderContent() {
    const job = this.job;
    if (this.phase === 'explain') return this.renderExplain();
    if (this.phase === 'confirm' && this.plan) return this.renderConfirm(this.plan);
    if (this.phase === 'error') return this.renderError();
    if (this.phase === 'done') {
      if (job?.mode === 'new-window') {
        return html`<div role="status" data-testid="mac-share-done-new-window">
          <h2 class="ut-macshare-title" id="ut-macshare-title">${t('macShare.done.newWindow', this.names)}</h2>
          <p class="ut-macshare-note">${t('macShare.done.oldTab')}</p>
        </div>`;
      }
      return html`<h2 class="ut-macshare-title" id="ut-macshare-title" role="status">${t('macShare.done')}</h2>`;
    }
    if (
      job?.resumeCommand &&
      (job.state === 'failed-after-close' || job.state === 'relaunch-unknown')
    ) {
      return this.renderClosed(job);
    }
    return this.renderProgress();
  }

  render() {
    if (!this.detail) return nothing;
    const confirming = this.phase === 'confirm' || this.phase === 'explain';
    return html`
      <style>
        .ut-macshare-backdrop {
          position: fixed;
          inset: 0;
          background: var(--ut-overlay);
        }
        .ut-macshare-sheet {
          position: fixed;
          inset-inline: 0;
          bottom: 0;
          max-height: 90vh;
          overflow-y: auto;
          display: flex;
          flex-direction: column;
          gap: 10px;
          padding-block: 18px calc(16px + env(safe-area-inset-bottom));
          padding-inline: max(16px, env(safe-area-inset-left)) max(16px, env(safe-area-inset-right));
          background: var(--color-bg-secondary);
          color: var(--color-text);
          border-start-start-radius: var(--ut-r-16);
          border-start-end-radius: var(--ut-r-16);
          border-top: 1px solid var(--color-border);
        }
        .ut-macshare-title {
          margin: 0;
          font-size: 17px;
          font-weight: var(--ut-fw-semibold);
          line-height: 1.35;
        }
        .ut-macshare-text,
        .ut-macshare-note,
        .ut-macshare-warn,
        .ut-macshare-step {
          margin: 0;
          font-size: 14px;
          line-height: 1.4;
        }
        .ut-macshare-note {
          color: var(--color-text-muted);
          font-size: 13px;
        }
        .ut-macshare-warn {
          color: var(--color-status-warning);
        }
        .ut-macshare-step {
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .ut-macshare-spinner {
          flex-shrink: 0;
          width: 16px;
          height: 16px;
          border-radius: var(--ut-r-circle);
          border: 2px solid var(--color-border);
          border-top-color: var(--color-primary);
          animation: ut-macshare-spin 0.9s linear infinite;
        }
        @keyframes ut-macshare-spin {
          to {
            transform: rotate(360deg);
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .ut-macshare-spinner {
            animation: none;
          }
        }
        .ut-macshare-details summary {
          min-height: 44px;
          display: flex;
          align-items: center;
          color: var(--color-primary);
          cursor: pointer;
          font-size: 14px;
        }
        .ut-macshare-command {
          display: block;
          padding: 10px 12px;
          border-radius: var(--ut-r-8);
          background: var(--color-bg);
          border: 1px solid var(--color-border);
          font-family: var(--font-mono, ui-monospace, monospace);
          font-size: 12px;
          line-height: 1.45;
          white-space: pre-wrap;
          overflow-wrap: anywhere;
          text-align: left;
          user-select: text;
          -webkit-user-select: text;
        }
        .ut-macshare-actions {
          display: flex;
          flex-direction: column;
          gap: 8px;
          margin-top: 4px;
        }
        .ut-macshare-primary,
        .ut-macshare-secondary {
          min-height: 44px;
          padding-inline: 18px;
          border-radius: var(--ut-r-lg);
          font-size: 15px;
          font-weight: var(--ut-fw-semibold);
          touch-action: manipulation;
        }
        .ut-macshare-primary {
          background: var(--color-primary);
          color: var(--color-bg);
        }
        .ut-macshare-secondary {
          background: var(--color-bg-tertiary, transparent);
          color: var(--color-text);
          border: 1px solid var(--color-border);
        }
      </style>
      <div style="position: fixed; inset: 0; z-index: ${Z_INDEX.MODAL};">
        <div class="ut-macshare-backdrop" @click=${this.started ? this.close : nothing}></div>
        <div
          class="ut-macshare-sheet"
          role=${confirming ? 'alertdialog' : 'dialog'}
          aria-modal="true"
          aria-labelledby="ut-macshare-title"
          aria-describedby="ut-macshare-desc"
          data-testid="mac-share-sheet"
          data-phase=${this.phase}
        >
          ${this.renderContent()}
        </div>
      </div>
    `;
  }
}

let openSheet: { host: HTMLElement; release: () => void } | null = null;

export function closeMacShareSheet(): void {
  if (!openSheet) return;
  const { host, release } = openSheet;
  openSheet = null;
  render(nothing, host);
  host.remove();
  release();
}

/** Open the share sheet for an agent row, or the progress of its running job. */
export function openMacShareSheet(
  detail: MacShareSheetDetail,
  options: MacShareSheetOptions
): void {
  closeMacShareSheet();
  const opener = document.activeElement;
  const host = document.createElement('div');
  document.body.appendChild(host);
  const sheet: { host: HTMLElement; release: () => void } = { host, release: () => {} };
  openSheet = sheet;
  render(
    html`<mac-share-sheet
      .detail=${detail}
      .options=${options}
      @close=${closeMacShareSheet}
    ></mac-share-sheet>`,
    host
  );
  void host.querySelector<MacShareSheet>('mac-share-sheet')?.updateComplete.then(() => {
    if (openSheet !== sheet) return;
    // Escape cancels before Share is pressed, and hides the sheet after (the job goes on).
    sheet.release = holdSheetFocus(
      host.querySelector<HTMLElement>('.ut-macshare-sheet'),
      closeMacShareSheet,
      opener
    );
  });
}

declare global {
  interface HTMLElementTagNameMap {
    'mac-share-sheet': MacShareSheet;
  }
}
