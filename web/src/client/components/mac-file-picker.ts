/**
 * «Archivo del Mac»: pick files that live on the Mac to attach to a chat message (user report:
 * the phone's own picker only offers the phone's files, so a PDF in the Mac's Downloads could
 * not be attached). A bottom sheet on the phone, a centred panel on a desktop: shortcuts to the
 * usual places, the folder's contents newest first, tap to tick files (several allowed), then
 * Attach. It hands back absolute Mac paths; nothing is uploaded.
 *
 * It reads /api/fs/browse like the file browser, but stays a small picker of its own: the file
 * browser is a full viewer (previews, diffs, git) built for browsing, not for choosing.
 */
import { css, html, LitElement, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import type { MessageKey } from '../i18n/index.js';
import { LocaleController, t } from '../i18n/index.js';
import { authClient } from '../services/auth-client.js';
import { a11yBaseStyles } from '../utils/a11y-base-styles.js';
import { materialControlStyles, materialSurfaceStyles } from '../utils/material-surface-styles.js';
import { attachSheetDrag } from '../utils/mobile-utils.js';
import { formatPathForDisplay } from '../utils/path-utils.js';
import { reducedMotionStyles } from '../utils/reduced-motion.js';
import { icon } from './icons.js';

export interface MacPickedFile {
  path: string;
  name: string;
  size: number;
}

interface Entry {
  name: string;
  type: 'file' | 'directory';
  size: number;
  modified: string;
}

interface Place {
  id: string;
  label: MessageKey;
  path: string;
}

/** Where people keep what they want to send; Downloads first (where a received PDF lands). */
export const MAC_PICKER_PLACES: Place[] = [
  { id: 'downloads', label: 'macPicker.downloads', path: '~/Downloads' },
  { id: 'documents', label: 'macPicker.documents', path: '~/Documents' },
  { id: 'desktop', label: 'macPicker.desktop', path: '~/Desktop' },
  {
    id: 'icloud',
    label: 'macPicker.icloud',
    path: '~/Library/Mobile Documents/com~apple~CloudDocs',
  },
  { id: 'home', label: 'macPicker.home', path: '~' },
];

const LAST_FOLDER_KEY = 'untether.macPicker.lastFolder';

function readLastFolder(): string {
  try {
    return localStorage.getItem(LAST_FOLDER_KEY) || '';
  } catch {
    return '';
  }
}

function storeLastFolder(path: string) {
  try {
    localStorage.setItem(LAST_FOLDER_KEY, path);
  } catch {
    // Private mode / blocked storage: it opens in Downloads next time.
  }
}

function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? dir + name : `${dir}/${name}`;
}

function parentOf(path: string): string {
  const parts = path.split('/').filter(Boolean);
  parts.pop();
  return parts.length === 0 ? '/' : `/${parts.join('/')}`;
}

/** `fullPath` with the Mac's home folder as `~` (home learnt from a `~` listing, else guessed). */
function homeRelative(fullPath: string, home: string): string {
  if (home && fullPath === home) return '~';
  if (home && fullPath.startsWith(`${home}/`)) return `~${fullPath.slice(home.length)}`;
  return formatPathForDisplay(fullPath);
}

/** A place's own name (Descargas, iCloud Drive…), not its folder's (Downloads, com~apple~CloudDocs). */
function folderLabel(fullPath: string, home: string): string {
  const relative = homeRelative(fullPath, home);
  const place = MAC_PICKER_PLACES.find((p) => p.path === relative);
  if (place) return t(place.label);
  return fullPath.split('/').filter(Boolean).pop() || '/';
}

/**
 * For the name filter: no case, no accents. The Mac stores names decomposed (NFD) and the
 * phone's keyboard types them composed, so «informe» must find «Informe café.pdf» and «cafe»
 * too (verifier, 2026-10-14).
 */
export function foldName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function formatModified(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  try {
    return sameDay
      ? date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
      : date.toLocaleDateString(undefined, {
          day: 'numeric',
          month: 'short',
          year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric',
        });
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

@customElement('mac-file-picker')
export class MacFilePicker extends LitElement {
  static styles = [
    materialSurfaceStyles,
    reducedMotionStyles,
    a11yBaseStyles,
    css`
      :host {
        display: contents;
        font-family: var(--font-ui, -apple-system, BlinkMacSystemFont, system-ui, sans-serif);
      }
      dialog {
        position: fixed;
        inset: auto 0 0 0;
        width: auto;
        max-width: none;
        height: calc(100dvh - env(safe-area-inset-top, 0px) - 24px);
        max-height: none;
        margin: 0;
        padding: 0;
        border: 0;
        border-radius: var(--ut-r-xl) var(--ut-r-xl) 0 0;
        background: var(--color-bg-elevated);
        color: var(--color-text);
        box-shadow: var(--shadow-e3);
        overflow: hidden;
      }
      dialog[open] {
        display: flex;
        flex-direction: column;
      }
      dialog:focus,
      dialog:focus-visible {
        outline: none;
      }
      dialog::backdrop {
        background: var(--ut-overlay);
      }
      /* Desktop: a centred panel instead of a sheet. */
      @media (min-width: 768px) and (hover: hover) {
        dialog {
          inset: 0;
          margin: auto;
          width: min(560px, calc(100vw - 32px));
          height: min(640px, calc(100dvh - 64px));
          border-radius: var(--ut-r-xl);
        }
        .grabber {
          display: none;
        }
      }
      .grabber {
        flex: none;
        display: grid;
        place-items: center;
        height: 16px;
        touch-action: none;
      }
      .grabber::before {
        content: '';
        width: 36px;
        height: 5px;
        border-radius: var(--ut-r-3);
        background: var(--color-border-strong, var(--color-border-light));
      }
      header {
        flex: none;
        display: grid;
        grid-template-columns: 1fr auto 1fr;
        align-items: center;
        gap: 8px;
        padding: 4px 8px 8px;
      }
      header h2 {
        margin: 0;
        font-size: 1.0625rem;
        font-weight: var(--ut-fw-semibold);
        text-align: center;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .text-button {
        min-height: 44px;
        padding: 0 8px;
        border: 0;
        background: none;
        color: var(--color-primary-text, var(--color-primary));
        font: inherit;
        font-size: 1.0625rem;
        cursor: pointer;
        touch-action: manipulation;
      }
      .text-button.cancel {
        justify-self: start;
      }
      .text-button.attach {
        justify-self: end;
        font-weight: var(--ut-fw-semibold);
      }
      .text-button:disabled {
        color: var(--color-text-dim);
        cursor: default;
      }
      .places {
        flex: none;
        display: flex;
        gap: 8px;
        overflow-x: auto;
        padding: 0 16px 10px;
        scrollbar-width: none;
      }
      .places::-webkit-scrollbar {
        display: none;
      }
      .place {
        flex: none;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        min-height: 36px;
        padding: 0 14px;
        border: 1px solid var(--color-border);
        border-radius: var(--ut-r-18);
        background: var(--color-bg-tertiary);
        color: var(--color-text);
        font: inherit;
        font-size: 0.9375rem;
        white-space: nowrap;
        cursor: pointer;
        touch-action: manipulation;
      }
      .place[aria-pressed='true'] {
        border-color: var(--color-primary);
        background: var(--color-primary-muted, var(--color-bg-tertiary));
        color: var(--color-primary-text, var(--color-text));
      }
      .place .ut-icon {
        color: var(--color-text-muted);
      }
      .filter {
        flex: none;
        padding: 0 16px 8px;
      }
      .filter input {
        width: 100%;
        box-sizing: border-box;
        min-height: 36px;
        padding: 0 12px;
        border: 0;
        border-radius: var(--ut-r-lg);
        background: var(--color-bg-tertiary);
        color: var(--color-text);
        /* 16 px: iOS zooms the page into smaller fields. */
        font: inherit;
        font-size: 16px;
      }
      .filter input::placeholder {
        color: var(--color-placeholder, var(--color-text-dim));
      }
      .list {
        flex: 1 1 auto;
        min-height: 0;
        overflow-y: auto;
        overscroll-behavior: contain;
        margin: 0;
        padding: 0 0 env(safe-area-inset-bottom, 0px);
        list-style: none;
        border-top: 1px solid var(--color-border);
      }
      .row {
        display: flex;
        align-items: center;
        gap: 12px;
        width: 100%;
        min-height: 56px;
        padding: 6px 16px;
        box-sizing: border-box;
        border: 0;
        border-bottom: 1px solid var(--color-border);
        background: var(--ut-piece-control-fill, none);
        color: var(--color-text);
        font: inherit;
        text-align: start;
        cursor: pointer;
        touch-action: manipulation;
      }
      .row:active {
        background: var(--color-surface-hover);
      }
      @media (hover: hover) {
        .row:hover {
          background: var(--color-surface-hover);
        }
      }
      .row .kind {
        flex: none;
        color: var(--color-text-muted);
      }
      .row .kind.dir {
        color: var(--color-primary-text, var(--color-primary));
      }
      .row .text {
        flex: 1 1 auto;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .row .name {
        font-size: 1rem;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .row .meta {
        font-size: 0.8125rem;
        color: var(--color-text-muted);
      }
      .row .end {
        flex: none;
        color: var(--color-text-dim);
      }
      .check {
        flex: none;
        width: 24px;
        height: 24px;
        box-sizing: border-box;
        display: grid;
        place-items: center;
        border: 1.5px solid var(--color-border-strong, var(--color-border-light));
        border-radius: var(--ut-r-circle);
        color: var(--color-on-fill);
      }
      .row[aria-checked='true'] .check {
        border-color: var(--color-primary);
        background: var(--color-primary);
      }
      .row.up .name {
        color: var(--color-primary-text, var(--color-primary));
      }
      .state {
        flex: 1 1 auto;
        padding: 32px 24px;
        text-align: center;
        color: var(--color-text-muted);
        font-size: 0.9375rem;
      }
    `,
    materialControlStyles,
  ];

  private locale = new LocaleController(this);

  @state() private isOpen = false;
  @state() private loading = false;
  @state() private fullPath = '';
  @state() private entries: Entry[] = [];
  @state() private error = '';
  @state() private query = '';
  /** Ticked files across folders, by absolute path, in the order they were picked. */
  @state() private picked = new Map<string, MacPickedFile>();
  private loadSeq = 0;
  /** The Mac's home folder, learnt from the first `~/…` listing. */
  private home = '';
  private detachDrag?: () => void;

  private get dialog(): HTMLDialogElement | null {
    return this.shadowRoot?.querySelector('dialog') ?? null;
  }

  /** Opens in the last folder used, or Downloads. */
  async show(): Promise<void> {
    this.picked = new Map();
    this.query = '';
    this.isOpen = true;
    await this.updateComplete;
    const dialog = this.dialog;
    if (dialog && !dialog.open) {
      try {
        dialog.showModal();
      } catch {
        dialog.setAttribute('open', '');
      }
      // No field focused on open: the keyboard would cover the list.
      dialog.focus({ preventScroll: true });
      this.detachDrag?.();
      this.detachDrag = attachSheetDrag(dialog, {
        onDismiss: () => this.cancel(),
        scroller: dialog.querySelector<HTMLElement>('.list'),
      });
    }
    await this.load(readLastFolder() || MAC_PICKER_PLACES[0].path, true);
  }

  private close() {
    this.isOpen = false;
    this.detachDrag?.();
    this.detachDrag = undefined;
    const dialog = this.dialog;
    if (dialog?.open) {
      if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
    }
  }

  /**
   * Only a click on the backdrop (outside the sheet) cancels. A click on the sheet's own empty
   * area also targets the dialog: QA 2026-10-14, the tap that opened it (its ghost click) landed
   * on the sheet while the folder loaded and closed it at once.
   */
  private handleDialogClick = (e: MouseEvent) => {
    const dialog = e.currentTarget as HTMLDialogElement;
    if (e.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    const inside =
      e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside) this.cancel();
  };

  private cancel = () => {
    this.close();
    this.dispatchEvent(new CustomEvent('mac-picker-cancel', { bubbles: true, composed: true }));
  };

  private confirm = () => {
    const files = [...this.picked.values()];
    if (files.length === 0) return;
    if (this.fullPath) storeLastFolder(this.fullPath);
    this.close();
    this.dispatchEvent(
      new CustomEvent<{ files: MacPickedFile[] }>('mac-files-picked', {
        detail: { files },
        bubbles: true,
        composed: true,
      })
    );
  };

  private async load(path: string, fallback = false): Promise<void> {
    const seq = ++this.loadSeq;
    this.loading = true;
    this.error = '';
    try {
      const params = new URLSearchParams({ path, showHidden: 'false', gitFilter: 'none' });
      const response = await authClient.fetch(`/api/fs/browse?${params}`);
      if (seq !== this.loadSeq) return;
      if (!response.ok) {
        if (fallback && path !== MAC_PICKER_PLACES[0].path) {
          await this.load(MAC_PICKER_PLACES[0].path, true);
          return;
        }
        if (fallback && path !== '~') {
          await this.load('~');
          return;
        }
        this.fullPath = path.startsWith('~') ? '' : path;
        this.entries = [];
        this.error = t('macPicker.unavailable');
        return;
      }
      const data = (await response.json()) as { fullPath?: string; path?: string; files?: Entry[] };
      if (seq !== this.loadSeq) return;
      this.fullPath = data.fullPath || data.path || path;
      if (path.startsWith('~') && data.fullPath?.endsWith(path.slice(1))) {
        this.home = data.fullPath.slice(0, data.fullPath.length - (path.length - 1)) || '/';
      }
      this.query = '';
      this.entries = (data.files ?? []).slice().sort((a, b) => {
        // Newest first, folders mixed in: what was just downloaded is at the top.
        const diff = Date.parse(b.modified) - Date.parse(a.modified);
        return Number.isNaN(diff) || diff === 0 ? a.name.localeCompare(b.name) : diff;
      });
      this.shadowRoot?.querySelector('.list')?.scrollTo?.({ top: 0 });
    } catch {
      if (seq !== this.loadSeq) return;
      this.entries = [];
      this.error = t('files.error.network');
    } finally {
      if (seq === this.loadSeq) this.loading = false;
    }
  }

  private openEntry(entry: Entry) {
    const path = joinPath(this.fullPath, entry.name);
    if (entry.type === 'directory') {
      void this.load(path);
      return;
    }
    const picked = new Map(this.picked);
    if (picked.has(path)) picked.delete(path);
    else picked.set(path, { path, name: entry.name, size: entry.size });
    this.picked = picked;
  }

  /** The place whose folder is open, for the pressed chip. */
  private activePlace(): string {
    const relative = homeRelative(this.fullPath, this.home);
    return MAC_PICKER_PLACES.find((place) => place.path === relative)?.id ?? '';
  }

  private renderList() {
    const canGoUp = this.fullPath && this.fullPath !== '/';
    const needle = foldName(this.query.trim());
    const shown = needle
      ? this.entries.filter((entry) => foldName(entry.name).includes(needle))
      : this.entries;
    const up = canGoUp
      ? html`<li>
          <button
            class="ut-surface--control row up"
            id="mac-picker-up"
            @click=${() => void this.load(parentOf(this.fullPath))}
          >
            <span class="kind">${icon('chevronLeft', 22)}</span>
            <span class="text"><span class="name">${folderLabel(parentOf(this.fullPath), this.home)}</span></span>
          </button>
        </li>`
      : nothing;
    let empty: unknown = nothing;
    // Loading shows inside the same list: swapping the list for another element would leave
    // the sheet's drag holding a detached scroller, so a pull down on a scrolled list dismissed
    // the sheet instead of scrolling back up (verifier, 2026-10-14).
    if (this.loading && this.entries.length === 0) {
      empty = html`<li class="state" role="status">${t('macPicker.loading')}</li>`;
    } else if (this.error) empty = html`<li class="state" role="status">${this.error}</li>`;
    else if (shown.length === 0) {
      empty = html`<li class="state">
        ${needle ? t('macPicker.noMatch', { query: this.query.trim() }) : t('macPicker.empty')}
      </li>`;
    }
    return html`<ul class="list" id="mac-picker-list" aria-busy=${this.loading ? 'true' : 'false'}>
      ${up}
      ${shown.map((entry) => {
        const dir = entry.type === 'directory';
        const path = joinPath(this.fullPath, entry.name);
        const checked = this.picked.has(path);
        const meta = [formatModified(entry.modified), dir ? '' : formatSize(entry.size)]
          .filter(Boolean)
          .join(' · ');
        return html`<li>
          <button
            class="ut-surface--control row ${dir ? 'dir' : 'file'}"
            data-testid="mac-picker-entry"
            data-name=${entry.name}
            role=${dir ? nothing : 'checkbox'}
            aria-checked=${dir ? nothing : checked ? 'true' : 'false'}
            @click=${() => this.openEntry(entry)}
          >
            <span class="kind ${dir ? 'dir' : ''}">${icon(dir ? 'folder' : 'fileText', 24)}</span>
            <span class="text">
              <span class="name" dir="auto">${entry.name}</span>
              ${meta ? html`<span class="meta">${meta}</span>` : nothing}
            </span>
            ${
              dir
                ? html`<span class="end">${icon('chevronRight', 18)}</span>`
                : html`<span class="check" aria-hidden="true">${checked ? icon('check', 16) : nothing}</span>`
            }
          </button>
        </li>`;
      })}
      ${empty}
    </ul>`;
  }

  render() {
    void this.locale;
    const count = this.picked.size;
    const active = this.activePlace();
    return html`<dialog
      id="mac-file-picker" class="ut-surface--panel ut-surface--material"
      aria-labelledby="mac-picker-title"
      tabindex="-1"
      @cancel=${(e: Event) => {
        e.preventDefault();
        this.cancel();
      }}
      @click=${this.handleDialogClick}
      @keydown=${(e: KeyboardEvent) => e.stopPropagation()}
    >
      ${
        this.isOpen
          ? html`
        <div class="grabber" data-sheet-handle aria-hidden="true"></div>
        <header data-sheet-handle>
          <button class="ut-text-action text-button cancel" id="mac-picker-cancel" @click=${this.cancel}>
            ${t('common.cancel')}
          </button>
          <h2 id="mac-picker-title">${this.fullPath ? folderLabel(this.fullPath, this.home) : t('attach.fromMac')}</h2>
          <button
            class="ut-text-action text-button attach"
            id="mac-picker-attach"
            ?disabled=${count === 0}
            @click=${this.confirm}
          >
            ${count > 1 ? t('macPicker.attachCount', { n: count }) : t('macPicker.attach')}
          </button>
        </header>
        <div class="places" role="group" aria-label=${t('macPicker.places')}>
          ${MAC_PICKER_PLACES.map(
            (place) => html`<button
              class="ut-surface--control place"
              id="mac-picker-place-${place.id}"
              aria-pressed=${active === place.id ? 'true' : 'false'}
              @click=${() => void this.load(place.path)}
            >
              ${icon(place.id === 'downloads' ? 'arrowDown' : 'folder', 16)}${t(place.label)}
            </button>`
          )}
        </div>
        <div class="filter">
          <input class="ut-surface--inset"
            id="mac-picker-filter"
            type="search"
            enterkeyhint="search"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            placeholder=${t('macPicker.filter')}
            aria-label=${t('macPicker.filter')}
            .value=${this.query}
            @input=${(e: Event) => {
              this.query = (e.target as HTMLInputElement).value;
            }}
          />
        </div>
        ${this.renderList()}
      `
          : nothing
      }
    </dialog>`;
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.detachDrag?.();
    this.detachDrag = undefined;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mac-file-picker': MacFilePicker;
  }
}
