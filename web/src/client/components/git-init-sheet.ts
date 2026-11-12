/**
 * "+ Tarea" or "Orquestar" on a project folder without git (2026-10-18): turn version control
 * on first, never on its own. The sheet shows what the first commit would hold before anything
 * is created: the files and size going in, the .gitignore lines that leave things out, and the
 * suspicious files with a checkbox each (ticked: goes in). Secrets start unticked, big files
 * ticked; the AI's second opinion arrives a moment later and moves the files the user has not
 * touched yet, always with its reason.
 *
 * POST /api/projects/git-init/preview (rules, instant), …/review (AI, may be unavailable) and
 * /api/projects/git-init on "Activar"; then `onActivated(repoPath)` carries on with what the
 * user tapped. Lazy (deferred-views.ts), in <body> with the task sheets' look (ans-*, tks-*).
 */
import { html, LitElement, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type {
  GitInitFlaggedFile,
  GitInitFlagReason,
  GitInitPreview,
  GitInitResult,
  GitInitReview,
  GitInitVerdict,
} from '../../shared/git-init.js';
import { getLocale, LocaleController, t } from '../i18n/index.js';
import { authClient } from '../services/auth-client.js';
import { toast } from '../utils/action-toast.js';
import { followKeyboard } from '../utils/follow-keyboard.js';
import { swallowNextClick } from '../utils/ghost-click.js';
import { attachSheetDrag } from '../utils/mobile-utils.js';
import { endsADrag } from '../utils/pointer-drag.js';
import { holdSheetFocus } from '../utils/sheet-a11y.js';
import { icon } from './icons.js';

export interface GitInitSheetOptions {
  /** The folder (the home's folder group key). */
  folder: string;
  name: string;
  /** Called with the new repository once it exists (the sheet is closed by then). */
  onActivated?: (repoPath: string) => void;
}

/** One row of the "check these" list: a rule's flag, an AI suggestion, or both. */
export interface GitInitRow {
  path: string;
  size?: number;
  reasons: GitInitFlagReason[];
  verdict?: GitInitVerdict;
}

/** "1.2 MB", "340 KB", "12 B". */
export function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/**
 * Whether a row starts left out: a secret by the rules always; otherwise what the AI says
 * (a big file goes in unless the AI says to leave it out).
 */
export function defaultExcluded(row: GitInitRow): boolean {
  if (row.reasons.some((reason) => reason.kind !== 'big')) return true;
  return row.verdict?.action === 'exclude';
}

/** The rule flags and the AI verdicts as one list: flagged files first, then the AI's own. */
export function mergeRows(
  flagged: readonly GitInitFlaggedFile[],
  verdicts: readonly GitInitVerdict[]
): GitInitRow[] {
  const byPath = new Map(verdicts.map((verdict) => [verdict.path, verdict]));
  const rows: GitInitRow[] = flagged.map((file) => ({
    path: file.path,
    size: file.size,
    reasons: file.reasons,
    verdict: byPath.get(file.path),
  }));
  const listed = new Set(rows.map((row) => row.path));
  for (const verdict of verdicts) {
    if (verdict.action === 'exclude' && !listed.has(verdict.path)) {
      rows.push({ path: verdict.path, reasons: [], verdict });
    }
  }
  return rows;
}

const OPEN_GUARD_MS = 500;

@customElement('git-init-sheet')
export class GitInitSheet extends LitElement {
  createRenderRoot() {
    return this;
  }

  protected readonly i18n = new LocaleController(this);

  @property({ attribute: false }) options: GitInitSheetOptions = { folder: '', name: '' };

  @state() private phase: 'loading' | 'ready' | 'activating' | 'error' = 'loading';
  @state() private preview: GitInitPreview | null = null;
  @state() private review: GitInitReview | null = null;
  @state() private reviewing = false;
  /** Paths the user ticked or unticked by hand: the AI no longer moves them. */
  @state() private choices = new Map<string, boolean>();
  @state() private error = '';

  private openedAt = 0;
  private touchedAt = 0;
  private releaseFocus: (() => void) | null = null;
  private detachDrag: (() => void) | null = null;
  private closed = false;

  connectedCallback() {
    super.connectedCallback();
    this.openedAt = Date.now();
    this.closed = false;
    void this.load();
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
      // Activar sits at the bottom: kept above the keyboard if one is up.
      const stopKeyboard = followKeyboard(sheet);
      this.detachDrag = () => {
        stopDrag();
        stopKeyboard();
      };
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.closed = true;
    this.releaseFocus?.();
    this.releaseFocus = null;
    this.detachDrag?.();
    this.detachDrag = null;
  }

  close = () => {
    if (this.phase === 'activating') return;
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

  private async post<T>(url: string, body: Record<string, unknown>): Promise<T> {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authClient.getAuthHeader() },
      body: JSON.stringify({ folder: this.options.folder, ...body }),
    });
    const data = (await response.json().catch(() => ({}))) as T & { error?: string };
    if (!response.ok) throw new Error(data.error || response.statusText || String(response.status));
    return data;
  }

  private async load() {
    this.phase = 'loading';
    this.error = '';
    try {
      this.preview = await this.post<GitInitPreview>('/api/projects/git-init/preview', {});
      this.phase = 'ready';
    } catch (error) {
      this.error = gitInitErrorText('gitInit.scanFailed', error);
      this.phase = 'error';
      return;
    }
    this.reviewing = true;
    try {
      const review = await this.post<GitInitReview>('/api/projects/git-init/review', {
        locale: getLocale(),
      });
      this.review =
        review && Array.isArray(review.verdicts) ? review : { status: 'unavailable', verdicts: [] };
    } catch {
      this.review = { status: 'unavailable', verdicts: [] };
    } finally {
      this.reviewing = false;
    }
  }

  private rows(): GitInitRow[] {
    return mergeRows(this.preview?.flagged ?? [], this.review?.verdicts ?? []);
  }

  private included(row: GitInitRow): boolean {
    return this.choices.get(row.path) ?? !defaultExcluded(row);
  }

  private toggle(row: GitInitRow) {
    const next = new Map(this.choices);
    next.set(row.path, !this.included(row));
    this.choices = next;
  }

  private async activate() {
    if (this.phase !== 'ready') return;
    this.phase = 'activating';
    this.error = '';
    const exclude = this.rows()
      .filter((row) => !this.included(row))
      .map((row) => row.path);
    try {
      const result = await this.post<GitInitResult>('/api/projects/git-init', { exclude });
      toast({ kind: 'success', text: t('gitInit.done', { name: this.options.name }) });
      this.phase = 'ready';
      this.remove();
      this.options.onActivated?.(result.repoPath);
    } catch (error) {
      if (this.closed) return;
      this.error = gitInitErrorText('gitInit.failed', error);
      this.phase = 'ready';
    }
  }

  private reasonText(reason: GitInitFlagReason, size?: number): string {
    if (reason.kind === 'big') return t('gitInit.reasonBig', { size: formatSize(size ?? 0) });
    if (reason.kind === 'secret-name') return t('gitInit.reasonSecretName');
    return t('gitInit.reasonSecretContent', { detail: reason.detail });
  }

  private renderRow(row: GitInitRow) {
    const on = this.included(row);
    const toggle = this.tap(() => this.toggle(row));
    const verdict = row.verdict;
    return html`<li class="gis-row" data-testid="git-init-flagged" data-path=${row.path}>
      <button
        type="button"
        role="checkbox"
        class="ut-surface--control gis-check ${on ? 'on' : ''}"
        aria-checked=${on ? 'true' : 'false'}
        aria-label=${t('gitInit.fileLabel', { path: row.path })}
        data-testid="git-init-check"
        ?disabled=${this.phase === 'activating'}
        @pointerup=${toggle}
        @click=${toggle}
      >
        ${on ? icon('check', 14) : nothing}
      </button>
      <div class="gis-row-text">
        <span class="gis-path" dir="ltr"
          >${row.path}${
            row.size !== undefined
              ? html`<span class="gis-size"> · ${formatSize(row.size)}</span>`
              : nothing
          }</span
        >
        ${row.reasons.map(
          (reason) => html`<span class="gis-reason">${this.reasonText(reason, row.size)}</span>`
        )}
        ${
          verdict
            ? html`<span class="gis-reason gis-ai" data-testid="git-init-ai-reason"
                >${
                  verdict.action === 'exclude'
                    ? t('gitInit.aiExclude', { reason: verdict.reason })
                    : t('gitInit.aiInclude', { reason: verdict.reason })
                }</span
              >`
            : nothing
        }
      </div>
    </li>`;
  }

  private renderReviewNote() {
    if (this.reviewing) {
      return html`<p class="tks-hint gis-review" data-testid="git-init-review">
        ${t('gitInit.reviewing')}
      </p>`;
    }
    const review = this.review;
    if (!review) return nothing;
    const text =
      review.status === 'unavailable'
        ? t('gitInit.reviewUnavailable')
        : review.summary
          ? t('gitInit.reviewDone', { summary: review.summary })
          : t('gitInit.reviewNothing');
    return html`<p class="tks-hint gis-review" data-testid="git-init-review">${text}</p>`;
  }

  private renderPreview(preview: GitInitPreview) {
    const busy = this.phase === 'activating';
    const rows = this.rows();
    const cancel = this.tap(this.close);
    const activate = this.tap(() => void this.activate());
    return html`
      <p class="gis-summary" data-testid="git-init-summary">
        ${t('gitInit.summary', { files: preview.files, size: formatSize(preview.size) })}
      </p>
      ${
        preview.capped
          ? html`<p class="tks-hint" data-testid="git-init-capped">
              ${t('gitInit.capped', { n: preview.files })}
            </p>`
          : nothing
      }
      ${
        preview.ignore.length
          ? html`<div class="tks-field">
              <span class="tks-label">${t('gitInit.ignoreLabel')}</span>
              <div class="gis-patterns" data-testid="git-init-ignore">
                ${preview.ignore.map(
                  (entry) => html`<code class="gis-pattern" dir="ltr">${entry.pattern}</code>`
                )}
              </div>
              <span class="tks-hint">${t('gitInit.ignoreHint')}</span>
            </div>`
          : nothing
      }
      <div class="tks-field">
        <span class="tks-label">${t('gitInit.flaggedLabel')}</span>
        ${
          rows.length
            ? html`<span class="tks-hint">${t('gitInit.flaggedHint')}</span>
                <ul class="gis-list">
                  ${rows.map((row) => this.renderRow(row))}
                </ul>`
            : html`<span class="tks-hint" data-testid="git-init-none">${t('gitInit.noFlagged')}</span>`
        }
      </div>
      ${this.renderReviewNote()}
      ${this.error ? html`<p class="ans-error" role="alert">${this.error}</p>` : nothing}
      <div class="tks-foot gis-foot">
        <button
          type="button"
          class="ut-surface--control tsk-btn gis-cancel"
          data-testid="git-init-cancel"
          ?disabled=${busy}
          @pointerup=${cancel}
          @click=${cancel}
        >
          ${t('common.cancel')}
        </button>
        <button
          type="button"
          class="tks-primary ut-surface--control ut-surface--primary"
          data-testid="git-init-activate"
          ?disabled=${busy}
          @pointerup=${activate}
          @click=${activate}
        >
          ${busy ? t('gitInit.activating') : t('gitInit.activate')}
        </button>
      </div>
    `;
  }

  /** The folder could not be read: why, and the way on (try again, or close). */
  private renderLoadError() {
    const retry = this.tap(() => void this.load());
    const cancel = this.tap(this.close);
    return html`<p class="ans-error" role="alert" data-testid="git-init-error">${this.error}</p>
      <div class="tks-foot gis-foot">
        <button
          type="button"
          class="ut-surface--control tsk-btn gis-cancel"
          data-testid="git-init-cancel"
          @pointerup=${cancel}
          @click=${cancel}
        >
          ${t('common.close')}
        </button>
        <button
          type="button"
          class="tks-primary ut-surface--control ut-surface--primary"
          data-testid="git-init-retry"
          @pointerup=${retry}
          @click=${retry}
        >
          ${t('confirm.retry')}
        </button>
      </div>`;
  }

  render() {
    const close = this.tap(this.close);
    return html`
      <div class="ans-backdrop" @click=${close}></div>
      <div
        class="ans-sheet tks-sheet ut-surface--floating ut-surface--material ut-surface--fixed"
        role="dialog"
        aria-modal="true"
        aria-labelledby="git-init-title"
        data-testid="git-init-sheet"
        data-phase=${this.phase}
      >
        <div class="ut-grabber" data-sheet-handle aria-hidden="true"></div>
        <div class="ans-head" data-sheet-handle>
          <div class="ans-head-text">
            <h2 id="git-init-title" class="ans-title">
              ${t('gitInit.title', { name: this.options.name })}
            </h2>
          </div>
          <button
            class="ans-x ut-icon-btn"
            aria-label=${t('common.close')}
            @pointerup=${close}
            @click=${close}
          >
            ${icon('x', 20)}
          </button>
        </div>
        <div class="ans-body">
          <p class="gis-intro" data-testid="git-init-intro">${t('gitInit.intro')}</p>
          ${
            this.phase === 'loading'
              ? html`<p class="ans-note">${t('gitInit.scanning')}</p>`
              : this.phase === 'error' || !this.preview
                ? this.renderLoadError()
                : this.renderPreview(this.preview)
          }
        </div>
      </div>
    `;
  }
}

/**
 * A git-init failure in the user's words: a folder too big to be a project (the server's
 * "more than 20000 files") says what to do about it rather than the English message.
 */
export function gitInitErrorText(
  key: 'gitInit.scanFailed' | 'gitInit.failed',
  error: unknown
): string {
  const message = error instanceof Error ? error.message : String(error);
  const tooMany = message.match(/more than ([\d.,]+) files/i);
  if (tooMany) return t('gitInit.tooManyFiles', { n: tooMany[1] });
  return t(key, { error: message });
}

/** Open the sheet in <body> (one at a time). */
export function openGitInitSheet(options: GitInitSheetOptions): GitInitSheet {
  document.querySelector('git-init-sheet')?.remove();
  const sheet = document.createElement('git-init-sheet') as GitInitSheet;
  sheet.options = options;
  document.body.appendChild(sheet);
  return sheet;
}

declare global {
  interface HTMLElementTagNameMap {
    'git-init-sheet': GitInitSheet;
  }
}
