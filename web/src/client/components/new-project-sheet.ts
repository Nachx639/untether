/**
 * «Nuevo proyecto» (2026-10-24): a project in one step, instead of a folder made by hand on the
 * Mac, a session in it, «Control de versiones» and «Orquestar». A name (required), «Dónde»
 * (required: the parent folder, picked with the directory browser, which starts at the last
 * parent picked for a new project, or at home the first time; nothing is filled in for the
 * user) and an optional goal. The sheet shows the folder the name gives before anything is made.
 *
 * POST /api/projects/new { name, dir, goal? }: the server makes the folder, git and a first
 * commit, pins the project on the home, and with a goal starts its orchestrator; without one the
 * empty project shows with its «Orquestar» button. Errors come back as a code
 * (shared/new-project.ts) and are worded here. Lazy (deferred-views.ts), in <body> with the
 * compose sheet's look (ans-*, tks-*); what was typed is kept if it fails.
 */
import { html, LitElement, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import {
  NEW_PROJECT_ERROR_CODES,
  NEW_PROJECT_NAME_MAX,
  type NewProjectErrorCode,
  projectFolderName,
} from '../../shared/new-project.js';
import type { Session } from '../../shared/types.js';
import { LocaleController, type MessageKey, t } from '../i18n/index.js';
import { type TaskStore, taskStore } from '../services/task-store.js';
import { toast } from '../utils/action-toast.js';
import { followKeyboard } from '../utils/follow-keyboard.js';
import { swallowNextClick } from '../utils/ghost-click.js';
import { attachSheetDrag } from '../utils/mobile-utils.js';
import { formatPathForDisplay } from '../utils/path-utils.js';
import { endsADrag } from '../utils/pointer-drag.js';
import { holdSheetFocus } from '../utils/sheet-a11y.js';
import './file-browser.js';
import { icon } from './icons.js';

export interface NewProjectSheetOptions {
  store?: TaskStore;
  /** Made: its main checkout and name (the board shows it pinned). */
  onCreated?: (project: { repoPath: string; name: string }) => void;
}

const OPEN_GUARD_MS = 500;

/** The user's words for a refusal; the server's own (English) text goes under «Detalles». */
export function newProjectErrorText(code: unknown, folder: string): string {
  const known = NEW_PROJECT_ERROR_CODES.includes(code as NewProjectErrorCode)
    ? (code as NewProjectErrorCode)
    : 'failed';
  return t(`newProject.error.${known}` as MessageKey, { folder });
}

@customElement('new-project-sheet')
export class NewProjectSheet extends LitElement {
  createRenderRoot() {
    return this;
  }

  protected readonly i18n = new LocaleController(this);

  @property({ attribute: false }) options: NewProjectSheetOptions = {};

  @state() private name = '';
  /** The parent folder the user picked; empty until they pick one. */
  @state() private parent = '';
  @state() private goal = '';
  @state() private browsing = false;
  /** Where the browser starts: the last parent picked, else home (GET /api/projects/new). */
  @state() private browseStart = '~';
  @state() private busy = false;
  @state() private error = '';
  @state() private errorDetail = '';

  private openedAt = 0;
  private touchedAt = 0;
  private releaseFocus: (() => void) | null = null;
  private detachDrag: (() => void) | null = null;

  private get store(): TaskStore {
    return this.options.store ?? taskStore;
  }

  connectedCallback() {
    super.connectedCallback();
    this.openedAt = Date.now();
    void this.store.newProjectStart().then((result) => {
      const parent = result.ok ? result.data?.parent : undefined;
      if (typeof parent === 'string' && parent) this.browseStart = parent;
    });
  }

  firstUpdated() {
    const sheet = this.querySelector<HTMLElement>('.ans-sheet');
    this.releaseFocus = holdSheetFocus(sheet, this.escape, document.activeElement);
    requestAnimationFrame(() => sheet?.classList.add('open'));
    if (sheet) {
      const stopDrag = attachSheetDrag(sheet, {
        scroller: sheet.querySelector<HTMLElement>('.ans-body'),
        onDismiss: this.close,
      });
      const stopKeyboard = followKeyboard(sheet);
      this.detachDrag = () => {
        stopDrag();
        stopKeyboard();
      };
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.releaseFocus?.();
    this.releaseFocus = null;
    this.detachDrag?.();
    this.detachDrag = null;
  }

  close = () => {
    this.remove();
  };

  /** Escape closes the browser first, then the sheet. */
  private escape = () => {
    if (this.browsing) this.browsing = false;
    else this.close();
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

  private browse() {
    // A field being typed in keeps its keyboard over the browser's Select bar.
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && focused.matches('input, textarea')) focused.blur();
    this.browsing = true;
  }

  private get folder(): string | null {
    return projectFolderName(this.name);
  }

  private async create() {
    const folder = this.folder;
    if (this.busy || !folder || !this.parent) return;
    this.busy = true;
    this.error = '';
    this.errorDetail = '';
    try {
      const result = await this.store.createProject({
        name: this.name.trim(),
        dir: this.parent,
        goal: this.goal,
      });
      if (!result.ok) {
        this.error = newProjectErrorText(result.error, folder);
        this.errorDetail = result.message ?? '';
        return;
      }
      const repoPath = String(result.data?.repoPath ?? '');
      const name = this.name.trim();
      // An agent's request without a login would be 202; the app makes it at once.
      const orchestrator = result.data?.orchestrator as
        | { ok: boolean; pending?: boolean; message?: string }
        | undefined;
      if (orchestrator && !orchestrator.ok) {
        toast({
          kind: 'error',
          text: t('newProject.orchestratorFailed', {
            name,
            error: orchestrator.message ?? '',
          }),
        });
      } else {
        toast({
          kind: 'success',
          text: orchestrator
            ? t('newProject.createdOrchestrating', { name })
            : t('newProject.created', { name }),
        });
      }
      this.options.onCreated?.({ repoPath, name });
      this.close();
    } finally {
      this.busy = false;
    }
  }

  private renderBrowser() {
    if (!this.browsing) return nothing;
    return html`<file-browser
      .visible=${true}
      .mode=${'select'}
      .session=${{ workingDir: this.parent || this.browseStart } as Session}
      @directory-selected=${(e: CustomEvent<string>) => {
        this.parent = e.detail;
        this.browsing = false;
        this.error = '';
      }}
      @browser-cancel=${() => {
        this.browsing = false;
      }}
    ></file-browser>`;
  }

  render() {
    const close = this.tap(this.close);
    const browse = this.tap(() => this.browse());
    const create = this.tap(() => void this.create());
    const folder = this.folder;
    const named = !!this.name.trim();
    const hidden = this.browsing ? 'display: none' : '';
    return html`
      <div class="ans-backdrop" style=${hidden} @click=${close}></div>
      <div
        class="ans-sheet tks-sheet ut-surface--floating ut-surface--material ut-surface--fixed"
        style=${hidden}
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-project-sheet-title"
        data-testid="new-project-sheet"
      >
        <div class="ut-grabber" data-sheet-handle aria-hidden="true"></div>
        <div class="ans-head" data-sheet-handle>
          <div class="ans-head-text">
            <h2 id="new-project-sheet-title" class="ans-title">${t('newProject.title')}</h2>
            <p class="ans-subtitle">${t('newProject.subtitle')}</p>
          </div>
          <button class="ans-x ut-icon-btn" aria-label=${t('common.close')} @pointerup=${close} @click=${close}>
            ${icon('x', 20)}
          </button>
        </div>
        <div class="ans-body">
          <label class="tks-field">
            <span class="tks-label">${t('newProject.name')}</span>
            <input
              class="tks-input ut-surface--inset"
              id="new-project-name"
              data-testid="new-project-name"
              dir="auto"
              autocomplete="off"
              maxlength=${NEW_PROJECT_NAME_MAX}
              placeholder=${t('newProject.namePlaceholder')}
              .value=${this.name}
              @input=${(e: Event) => {
                this.name = (e.target as HTMLInputElement).value;
                this.error = '';
              }}
            />
            ${
              named && !folder
                ? html`<span class="tks-hint" role="alert" data-testid="new-project-name-bad"
                    >${t('newProject.error.bad-name', { folder: '' })}</span
                  >`
                : nothing
            }
          </label>
          <div class="tks-field">
            <span class="tks-label" id="new-project-dir-label">${t('newProject.where')}</span>
            <button
              type="button"
              class="tks-input mono ut-surface--inset"
              id="new-project-dir"
              data-testid="new-project-dir"
              aria-labelledby="new-project-dir-label"
              style="text-align: start; cursor: pointer"
              @pointerup=${browse}
              @click=${browse}
            >
              ${this.parent ? formatPathForDisplay(this.parent) : t('newProject.wherePick')}
            </button>
            ${
              this.parent && folder
                ? html`<span class="tks-hint" data-testid="new-project-path" dir="ltr"
                    >${t('newProject.willCreate', {
                      path: `${formatPathForDisplay(this.parent).replace(/\/$/, '')}/${folder}`,
                    })}</span
                  >`
                : nothing
            }
          </div>
          <label class="tks-field">
            <span class="tks-label">${t('newProject.goal')}</span>
            <textarea
              class="tks-input ut-surface--inset"
              rows="4"
              dir="auto"
              data-testid="new-project-goal"
              placeholder=${t('newProject.goalPlaceholder')}
              .value=${this.goal}
              @input=${(e: Event) => {
                this.goal = (e.target as HTMLTextAreaElement).value;
              }}
            ></textarea>
            <span class="tks-hint">${t('newProject.goalHint')}</span>
          </label>
          ${this.error ? html`<p class="ans-error" role="alert" data-testid="new-project-error">${this.error}</p>` : nothing}
          ${
            this.error && this.errorDetail
              ? html`<details class="ans-error-details" data-testid="new-project-error-details">
                  <summary>${t('common.errorDetails')}</summary>
                  <code dir="ltr">${this.errorDetail}</code>
                </details>`
              : nothing
          }
          <div class="tks-foot">
            <button
              type="button"
              class="tks-primary ut-surface--control ut-surface--primary"
              data-testid="new-project-create"
              aria-busy=${this.busy ? 'true' : 'false'}
              ?disabled=${this.busy || !folder || !this.parent}
              @pointerup=${create}
              @click=${create}
            >
              ${this.busy ? html`<span class="tsk-spinner" aria-hidden="true"></span>` : nothing}${
                this.goal.trim() ? t('newProject.createAndOrchestrate') : t('newProject.create')
              }
            </button>
          </div>
        </div>
      </div>
      ${this.renderBrowser()}
    `;
  }
}

/** Open the sheet in <body> (one at a time). */
export function openNewProjectSheet(options: NewProjectSheetOptions = {}): NewProjectSheet {
  document.querySelector('new-project-sheet')?.remove();
  const sheet = document.createElement('new-project-sheet') as NewProjectSheet;
  sheet.options = options;
  document.body.appendChild(sheet);
  return sheet;
}

declare global {
  interface HTMLElementTagNameMap {
    'new-project-sheet': NewProjectSheet;
  }
}
