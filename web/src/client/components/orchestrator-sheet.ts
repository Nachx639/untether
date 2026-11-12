/**
 * "Orquestar" (P7, 2026-10-18): the goal for a project's orchestrator, typed or dictated. The
 * orchestrator (a Claude session in the project) splits it into tasks, follows them and merges
 * them, and only pings the user when something is off. With one running, the same sheet gives
 * it a new goal.
 *
 * Without one running, the project's open Claude sessions are listed too: "Hacer orquestador"
 * makes that session the orchestrator, keeping its conversation (the goal is optional then).
 *
 * POST /api/projects/orchestrator { repoPath, goal } (or …/adopt { repoPath, sessionId, goal }). Lazy (deferred-views.ts), in <body> with
 * the compose sheet's look (ans-*, tks-*); the goal is kept if starting fails.
 */
import { html, LitElement, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { LocaleController, type MessageKey, t } from '../i18n/index.js';
import { authClient } from '../services/auth-client.js';
import { serverConfigService } from '../services/server-config-service.js';
import { type TaskStore, taskStore } from '../services/task-store.js';
import { toast } from '../utils/action-toast.js';
import { DictationController, type DictationState, dictationErrorKey } from '../utils/dictation.js';
import { followKeyboard } from '../utils/follow-keyboard.js';
import { swallowNextClick } from '../utils/ghost-click.js';
import { attachSheetDrag } from '../utils/mobile-utils.js';
import { endsADrag } from '../utils/pointer-drag.js';
import { holdSheetFocus } from '../utils/sheet-a11y.js';
import { orchestratorErrorText } from '../utils/task-status.js';
import { icon } from './icons.js';

export interface OrchestratorSheetOptions {
  /** The project's main checkout. */
  repoPath: string;
  /** Its name in the header. */
  name: string;
  /** An orchestrator runs already: the goal goes to it. */
  running?: boolean;
  /** Open Claude sessions of the project that could become its orchestrator. */
  sessions?: Array<{ id: string; title: string }>;
  store?: TaskStore;
}

const OPEN_GUARD_MS = 500;

@customElement('orchestrator-sheet')
export class OrchestratorSheet extends LitElement {
  createRenderRoot() {
    return this;
  }

  protected readonly i18n = new LocaleController(this);

  @property({ attribute: false }) options: OrchestratorSheetOptions = { repoPath: '', name: '' };

  @state() private goal = '';
  @state() private busy = false;
  @state() private error = '';
  /** The server's own (English) answer behind `error`, under «Detalles». */
  @state() private errorDetail = '';
  @state() private dictation: DictationState = 'idle';
  @state() private dictationNote = '';
  /** The user's autoApprove: then nothing waits for their OK and point 3 says what does happen. */
  @state() private autoApprove = false;

  private openedAt = 0;
  private touchedAt = 0;
  private releaseFocus: (() => void) | null = null;
  private detachDrag: (() => void) | null = null;

  private dictationController = new DictationController({
    getText: () => this.goal,
    setText: (value) => {
      this.goal = value;
    },
    onState: (value) => {
      this.dictation = value;
      if (value !== 'idle') this.dictationNote = '';
    },
    onError: (error) => {
      this.dictationNote = t(dictationErrorKey(error) as MessageKey);
    },
    authHeaders: () => authClient.getAuthHeader(),
  });

  connectedCallback() {
    super.connectedCallback();
    this.openedAt = Date.now();
    // Fresh: the switch may have just been turned in Settings (2026-10-24).
    void serverConfigService
      .loadConfig(true)
      .then((config) => {
        this.autoApprove = config.autoApprove === true;
      })
      .catch(() => {});
  }

  firstUpdated() {
    const sheet = this.querySelector<HTMLElement>('.ans-sheet');
    this.releaseFocus = holdSheetFocus(sheet, this.close, document.activeElement);
    requestAnimationFrame(() => sheet?.classList.add('open'));
    if (sheet) {
      const stopDrag = attachSheetDrag(sheet, {
        scroller: sheet.querySelector<HTMLElement>('.ans-body'),
        onDismiss: this.close,
      });
      // Empezar sits at the bottom: above the keyboard while the goal is typed.
      const stopKeyboard = followKeyboard(sheet);
      this.detachDrag = () => {
        stopDrag();
        stopKeyboard();
      };
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.dictationController.cancel();
    this.releaseFocus?.();
    this.releaseFocus = null;
    this.detachDrag?.();
    this.detachDrag = null;
  }

  close = () => {
    this.remove();
  };

  private tap(fn: () => void) {
    return {
      handleEvent: (e: Event) => {
        if (Date.now() - this.openedAt < OPEN_GUARD_MS) return;
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

  private async start() {
    const goal = this.goal.trim();
    // Still turning the dictation into text: starting now would throw that text away.
    if (this.busy || !goal || this.dictation === 'transcribing') return;
    this.dictationController.cancel();
    this.busy = true;
    this.error = '';
    this.errorDetail = '';
    const store = this.options.store ?? taskStore;
    try {
      const result = await store.startOrchestrator(this.options.repoPath, goal);
      if (!result.ok) {
        const worded = orchestratorErrorText(result);
        this.error = t('orch.failed', { error: worded.text });
        this.errorDetail = worded.raw !== worded.text ? worded.raw : '';
        return;
      }
      // pending: its brief is queued (Claude starting or busy) and goes in by itself.
      toast({
        kind: 'success',
        text: result.data?.pending
          ? t('orch.pending', { name: this.options.name })
          : result.data?.reused
            ? t('orch.goalSent', { name: this.options.name })
            : t('orch.started', { name: this.options.name }),
      });
      this.close();
    } finally {
      this.busy = false;
    }
  }

  private async adopt(session: { id: string; title: string }) {
    if (this.busy || this.dictation === 'transcribing') return;
    this.dictationController.cancel();
    this.busy = true;
    this.error = '';
    this.errorDetail = '';
    const store = this.options.store ?? taskStore;
    try {
      const result = await store.adoptOrchestrator(this.options.repoPath, session.id, this.goal);
      if (!result.ok) {
        const worded = orchestratorErrorText(result);
        this.error = t('orch.failed', { error: worded.text });
        this.errorDetail = worded.raw !== worded.text ? worded.raw : '';
        return;
      }
      toast({
        kind: 'success',
        text: result.data?.pending
          ? t('orch.adoptedPending', { title: session.title, name: this.options.name })
          : t('orch.adopted', { title: session.title, name: this.options.name }),
      });
      this.close();
    } finally {
      this.busy = false;
    }
  }

  /** "O usa una sesión abierta": one row per session with "Hacer orquestador". */
  private renderAdopt() {
    const sessions = this.options.running ? [] : (this.options.sessions ?? []);
    if (!sessions.length) return nothing;
    return html`<div class="orch-adopt" data-testid="orchestrator-adopt">
      <h3 class="orch-adopt-title">${t('orch.adoptHeading')}</h3>
      <p class="orch-adopt-hint">${t('orch.adoptHint')}</p>
      ${sessions.map((session) => {
        const adopt = this.tap(() => void this.adopt(session));
        return html`<div class="orch-adopt-row">
          <bdi class="orch-adopt-name">${session.title}</bdi>
          <button
            type="button"
            class="ut-btn ut-btn--ghost ut-btn--sm"
            data-testid="orchestrator-adopt-session"
            data-session=${session.id}
            aria-label=${t('orch.adoptOf', { title: session.title })}
            ?disabled=${this.busy || this.dictation === 'transcribing'}
            @pointerup=${adopt}
            @click=${adopt}
          >
            ${icon('sparkles', 14)}${t('orch.adopt')}
          </button>
        </div>`;
      })}
    </div>`;
  }

  render() {
    const close = this.tap(this.close);
    const mic = this.tap(() => void this.dictationController.toggle());
    const live = this.dictation !== 'idle' && this.dictation !== 'transcribing';
    const start = this.tap(() => void this.start());
    const running = !!this.options.running;
    return html`
      <div class="ans-backdrop" @click=${close}></div>
      <div
        class="ans-sheet tks-sheet ut-surface--floating ut-surface--material ut-surface--fixed"
        role="dialog"
        aria-modal="true"
        aria-labelledby="orchestrator-sheet-title"
        data-testid="orchestrator-sheet"
      >
        <div class="ut-grabber" data-sheet-handle aria-hidden="true"></div>
        <div class="ans-head" data-sheet-handle>
          <div class="ans-head-text">
            <h2 id="orchestrator-sheet-title" class="ans-title">
              ${running ? t('orch.newGoalTitle') : t('orch.title', { name: this.options.name })}
            </h2>
            <p class="ans-subtitle">${t('orch.subtitle')}</p>
          </div>
          <button class="ans-x ut-icon-btn" aria-label=${t('common.close')} @pointerup=${close} @click=${close}>
            ${icon('x', 20)}
          </button>
        </div>
        <div class="ans-body">
          <div class="tks-field">
            <div class="tks-prompt">
              <textarea
                class="tks-input ut-surface--inset"
                rows="5"
                dir="auto"
                data-testid="orchestrator-goal"
                aria-label=${t('orch.goal')}
                placeholder=${t('orch.goal')}
                .value=${this.goal}
                @input=${(e: Event) => {
                  this.goal = (e.target as HTMLTextAreaElement).value;
                }}
              ></textarea>
              <button
                type="button"
                class="tks-mic ${live ? 'listening' : ''} ut-surface--control"
                data-testid="orchestrator-mic"
                aria-label=${t(this.dictation === 'idle' ? 'chat.dictate' : 'chat.stopDictation')}
                aria-pressed=${this.dictation === 'idle' ? 'false' : 'true'}
                ?disabled=${this.dictation === 'transcribing'}
                @pointerup=${mic}
                @click=${mic}
              >
                ${
                  this.dictation === 'idle'
                    ? icon('mic', 18)
                    : this.dictation === 'transcribing'
                      ? html`<span class="tsk-spinner" aria-hidden="true"></span>`
                      : icon('stop', 16)
                }
              </button>
            </div>
            ${
              this.dictation !== 'idle' || this.dictationNote
                ? html`<span class="tks-hint" role="status"
                    >${
                      this.dictation === 'transcribing'
                        ? t('dictation.transcribing')
                        : this.dictation !== 'idle'
                          ? t('dictation.recording')
                          : this.dictationNote
                    }</span
                  >`
                : nothing
            }
          </div>
          <ul class="orch-points" data-testid="orchestrator-points">
            <li>${t('orch.point1')}</li>
            <li>${t('orch.point2')}</li>
            <li data-testid="orchestrator-point-ok">
              ${t(this.autoApprove ? 'orch.point3AutoApprove' : 'orch.point3')}
            </li>
          </ul>
          ${this.renderAdopt()}
          ${this.error ? html`<p class="ans-error" role="alert" data-testid="orchestrator-error">${this.error}</p>` : nothing}
          ${
            this.error && this.errorDetail
              ? html`<details class="ans-error-details" data-testid="orchestrator-error-details">
                  <summary>${t('common.errorDetails')}</summary>
                  <code dir="ltr">${this.errorDetail}</code>
                </details>`
              : nothing
          }
          <div class="tks-foot">
            <button
              type="button"
              class="tks-primary ut-surface--control ut-surface--primary"
              data-testid="orchestrator-start"
              aria-busy=${this.busy ? 'true' : 'false'}
              ?disabled=${this.busy || !this.goal.trim() || this.dictation === 'transcribing'}
              @pointerup=${start}
              @click=${start}
            >
              ${this.busy ? html`<span class="tsk-spinner" aria-hidden="true"></span>` : nothing}${
                running ? t('orch.sendGoal') : t('orch.start')
              }
            </button>
          </div>
        </div>
      </div>
    `;
  }
}

/** Open the sheet in <body> (one at a time). */
export function openOrchestratorSheet(options: OrchestratorSheetOptions): OrchestratorSheet {
  document.querySelector('orchestrator-sheet')?.remove();
  const sheet = document.createElement('orchestrator-sheet') as OrchestratorSheet;
  sheet.options = options;
  document.body.appendChild(sheet);
  return sheet;
}

declare global {
  interface HTMLElementTagNameMap {
    'orchestrator-sheet': OrchestratorSheet;
  }
}
