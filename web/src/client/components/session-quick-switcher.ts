/**
 * Session Quick Switcher: the ⌘K command palette (design spec 5.4, 2026-10-12).
 *
 * One top-anchored dialog to jump anywhere: Sessions (fuzzy over name, folder, branch and
 * command), Actions (new session, settings, files, theme, history, close all) and Quick start.
 * ↑↓ move across every section, ↵ opens, ⎋ closes (modal-wrapper).
 *
 * @fires select-session - detail: { sessionId } when a session is chosen
 * @fires palette-action - detail: { action: PaletteAction } for an action row
 * @fires palette-quick-start - detail: { command } for a quick start row
 * @fires close - when dismissed
 */
import { html, LitElement, nothing, type PropertyValues } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';
import type { Session } from '../../shared/types.js';
import type { QuickStartCommand } from '../../types/config.js';
import { LocaleController, type MessageKey, t } from '../i18n/index.js';
import { serverConfigService } from '../services/server-config-service.js';
import { createLogger } from '../utils/logger.js';
import { formatPathForDisplay } from '../utils/path-utils.js';
import {
  deriveSessionStatus,
  lastActivityAt,
  relativeTime,
  type SessionStatus,
} from '../utils/session-status.js';
import { formatShortcut } from '../utils/shortcut-label.js';
import { type IconName, icon } from './icons.js';
import './modal-wrapper.js';

const logger = createLogger('session-quick-switcher');

export type PaletteAction = 'new-session' | 'settings' | 'files' | 'theme' | 'history' | 'kill-all';

const ACTIONS: Array<{ action: PaletteAction; label: MessageKey; icon: IconName; key?: string }> = [
  { action: 'new-session', label: 'header.newSession', icon: 'plus', key: 'mod+shift+n' },
  { action: 'settings', label: 'palette.action.settings', icon: 'settings', key: 'mod+,' },
  { action: 'files', label: 'palette.action.files', icon: 'files', key: 'mod+o' },
  { action: 'theme', label: 'palette.action.theme', icon: 'sun' },
  { action: 'history', label: 'palette.action.history', icon: 'history' },
  { action: 'kill-all', label: 'sessions.killAll', icon: 'x' },
];

const FALLBACK_QUICK_STARTS: QuickStartCommand[] = [{ command: 'claude' }, { command: 'zsh' }];

const STATUS_ORDER: Record<SessionStatus, number> = {
  'needs-input': 0,
  working: 1,
  idle: 2,
  paused: 3,
  'exited-error': 4,
  'exited-ok': 5,
};

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes are control characters
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

/** Terminal escapes out, whitespace folded: names and commands come from the PTY. */
export function cleanText(text: string | undefined | null): string {
  return (text ?? '').replace(ANSI, '').replace(/\s+/g, ' ').trim();
}

/** Repo path as git and macOS may report it (/private/var = /var, no trailing /). */
function normalizeRepo(path: string | undefined | null): string {
  return typeof path === 'string' && path
    ? path.replace(/^\/private(?=\/)/, '').replace(/\/+$/, '')
    : '';
}

/**
 * Session id -> the repo family the sidebar files it under (session-list groupSessionsByRepo):
 * a worktree folds into its main repo and nested paths into the outer one. QA 2026-10-12: the
 * palette said "untether" and "untether-design" for two rows the sidebar shows under one repo.
 */
export function repoFamilies(sessions: Session[]): Map<string, string> {
  const parent = new Map<string, string>();
  const find = (key: string): string => {
    let root = key;
    while (parent.has(root) && parent.get(root) !== root) root = parent.get(root) as string;
    return root;
  };
  const union = (main: string, other: string) => {
    const a = find(main);
    const b = find(other);
    if (a !== b) parent.set(b, a);
  };
  const keys = new Set<string>();
  for (const s of sessions) {
    const main = normalizeRepo(s.gitMainRepoPath);
    const repo = normalizeRepo(s.gitRepoPath);
    if (main) keys.add(main);
    if (repo) keys.add(repo);
  }
  for (const s of sessions) {
    const main = normalizeRepo(s.gitMainRepoPath);
    const repo = normalizeRepo(s.gitRepoPath);
    if (main && repo && main !== repo) union(main, repo);
  }
  const sorted = [...keys].sort((a, b) => a.length - b.length);
  for (const key of sorted) {
    for (const other of sorted) {
      if (other !== key && other.startsWith(`${key}/`)) union(key, other);
    }
  }
  const out = new Map<string, string>();
  for (const s of sessions) {
    const key = normalizeRepo(s.gitMainRepoPath) || normalizeRepo(s.gitRepoPath);
    if (key) out.set(s.id, find(key));
  }
  return out;
}

function basename(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() || path
  );
}

/** "claude", not "/opt/homebrew/bin/claude --resume …". */
function commandName(session: Pick<Session, 'command'>): string {
  const first = Array.isArray(session.command) ? session.command[0] : '';
  return first ? basename(cleanText(first)) : '';
}

export function sessionTitle(session: Session): string {
  return (
    cleanText(session.userTitle) || cleanText(session.name) || commandName(session) || session.id
  );
}

/** Ordered-subsequence fuzzy match (plain substring first). */
export function fuzzyMatch(haystack: string, needle: string): boolean {
  if (!needle) return true;
  if (haystack.includes(needle)) return true;
  let i = 0;
  for (const ch of haystack) {
    if (ch === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return false;
}

type Row =
  | { kind: 'session'; session: Session; status: SessionStatus }
  | { kind: 'action'; action: PaletteAction; label: string; icon: IconName; key?: string }
  | { kind: 'quick'; entry: QuickStartCommand; label: string };

@customElement('session-quick-switcher')
export class SessionQuickSwitcher extends LitElement {
  // Light DOM so Tailwind classes apply (matches the rest of the app)
  createRenderRoot() {
    return this;
  }

  protected readonly i18n = new LocaleController(this);

  @property({ type: Boolean }) visible = false;
  @property({ type: Array }) sessions: Session[] = [];
  /** The session on screen, if any: listed but not first. */
  @property({ type: String }) activeSessionId: string | null = null;

  @state() private filterText = '';
  @state() private selectedIndex = 0;
  @state() private quickStarts: QuickStartCommand[] = FALLBACK_QUICK_STARTS;
  private quickStartsLoaded = false;
  private shownIndex = -1;

  @query('#quick-switcher-input') private inputEl?: HTMLInputElement;

  updated(changed: PropertyValues) {
    if (changed.has('visible') && this.visible) {
      // Reset and focus the input each time it opens
      this.filterText = '';
      this.selectedIndex = 0;
      this.loadQuickStarts();
      requestAnimationFrame(() => this.inputEl?.focus());
    }
    if (changed.has('selectedIndex') || changed.has('filterText')) {
      this.querySelector(`#quick-switcher-item-${this.selectedIndex}`)?.scrollIntoView?.({
        block: 'nearest',
      });
    }
  }

  private loadQuickStarts() {
    if (this.quickStartsLoaded) return;
    this.quickStartsLoaded = true;
    serverConfigService
      .getQuickStartCommands()
      .then((commands) => {
        const list = commands.filter((entry) => entry.command?.trim());
        if (list.length) this.quickStarts = list;
      })
      .catch(() => {});
  }

  private haystack(s: Session): string {
    const cmd = Array.isArray(s.command) ? s.command.join(' ') : '';
    return cleanText(
      `${s.userTitle ?? ''} ${s.name ?? ''} ${cmd} ${s.workingDir ?? ''} ${s.gitBranch ?? ''}`
    ).toLowerCase();
  }

  private familiesFor: Session[] | null = null;
  private familiesCache = new Map<string, string>();
  private get families(): Map<string, string> {
    if (this.familiesFor !== this.sessions) {
      this.familiesFor = this.sessions;
      this.familiesCache = repoFamilies(this.sessions);
    }
    return this.familiesCache;
  }

  private get sessionRows(): Row[] {
    const now = Date.now();
    const q = this.filterText.trim().toLowerCase();
    return this.sessions
      .filter((s) => fuzzyMatch(this.haystack(s), q))
      .map((session) => ({ session, status: deriveSessionStatus(session, now) }))
      .sort((a, b) => {
        // The session already on screen goes after the others: you came here to leave it.
        const aa = a.session.id === this.activeSessionId ? 1 : 0;
        const ba = b.session.id === this.activeSessionId ? 1 : 0;
        if (aa !== ba) return aa - ba;
        const order = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
        if (order) return order;
        return (lastActivityAt(b.session) ?? 0) - (lastActivityAt(a.session) ?? 0);
      })
      .map(({ session, status }) => ({ kind: 'session' as const, session, status }));
  }

  private get actionRows(): Row[] {
    const q = this.filterText.trim().toLowerCase();
    const running = this.sessions.some((s) => s.status === 'running');
    return ACTIONS.filter((a) => a.action !== 'kill-all' || running)
      .map((a) => ({ kind: 'action' as const, ...a, label: t(a.label) }))
      .filter((a) => fuzzyMatch(a.label.toLowerCase(), q));
  }

  private get quickRows(): Row[] {
    const q = this.filterText.trim().toLowerCase();
    return this.quickStarts
      .map((entry) => ({
        kind: 'quick' as const,
        entry,
        label: cleanText((entry.name || entry.command).replace(/^[^\p{L}\p{N}]+/u, '')),
      }))
      .filter((r) => fuzzyMatch(`${r.label} ${r.entry.command}`.toLowerCase(), q));
  }

  private get rows(): Row[] {
    return [...this.sessionRows, ...this.actionRows, ...this.quickRows];
  }

  private handleInput(e: Event) {
    this.filterText = (e.target as HTMLInputElement).value;
    this.selectedIndex = 0;
  }

  private handleKeydown(e: KeyboardEvent) {
    if (e.isComposing) return;
    const list = this.rows;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.selectedIndex = list.length ? (this.selectedIndex + 1) % list.length : 0;
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.selectedIndex = list.length ? (this.selectedIndex - 1 + list.length) % list.length : 0;
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const row = list[Math.min(this.selectedIndex, list.length - 1)];
      if (row) this.activate(row);
    }
    // Escape is handled by <modal-wrapper>.
  }

  private activate(row: Row) {
    if (row.kind === 'session') {
      this.selectSession(row.session.id);
      return;
    }
    if (row.kind === 'action') {
      this.emit('palette-action', { action: row.action });
    } else {
      this.emit('palette-quick-start', { command: row.entry.command });
    }
    this.handleClose();
  }

  private emit(type: string, detail: unknown) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  private selectSession(sessionId: string) {
    logger.log(`Quick switch to session ${sessionId}`);
    this.emit('select-session', { sessionId });
    this.handleClose();
  }

  private handleClose = () => {
    this.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }));
  };

  render() {
    if (!this.visible) return html``;
    const sessions = this.sessionRows;
    const actions = this.actionRows;
    const quick = this.quickRows;
    const total = sessions.length + actions.length + quick.length;
    // The list can shrink under the selection (a session ended): clamp without a re-render.
    this.shownIndex = total > 0 ? Math.min(this.selectedIndex, total - 1) : -1;
    const active = this.shownIndex >= 0 ? `quick-switcher-item-${this.shownIndex}` : '';

    return html`
      <modal-wrapper
        .visible=${this.visible}
        .ariaLabel=${t('switcher.quickLabel')}
        placement="top"
        contentClass="ut-dialog ut-dialog--palette"
        initialFocus="#quick-switcher-input"
        @close=${this.handleClose}
      >
        <div class="ut-palette" data-testid="command-palette">
          <div class="ut-palette-input-row">
            ${icon('search')}
            <input
              id="quick-switcher-input"
              class="ut-palette-input"
              type="text"
              role="combobox"
              aria-expanded="true"
              aria-controls="quick-switcher-list"
              aria-activedescendant=${active || nothing}
              aria-label=${t('header.search')}
              placeholder=${t('header.search')}
              .value=${this.filterText}
              @input=${this.handleInput}
              @keydown=${this.handleKeydown}
              autocomplete="off"
              autocorrect="off"
              autocapitalize="off"
              spellcheck="false"
            />
            <kbd class="ut-kbd" title=${t('common.close')}>${formatShortcut('esc')}</kbd>
          </div>
          <div class="ut-palette-list" id="quick-switcher-list" role="listbox">
            ${
              total === 0
                ? html`<div class="ut-palette-empty">${t('switcher.noMatches')}</div>`
                : nothing
            }
            ${this.renderSection('palette.sessions', sessions, 0)}
            ${this.renderSection('palette.actions', actions, sessions.length)}
            ${this.renderSection('palette.quickStart', quick, sessions.length + actions.length)}
          </div>
          <div class="ut-palette-footer">
            <span><kbd class="ut-kbd">↑</kbd><kbd class="ut-kbd">↓</kbd>${t('palette.hint.navigate')}</span>
            <span><kbd class="ut-kbd">${formatShortcut('enter')}</kbd>${t('palette.hint.open')}</span>
            <span
              ><kbd class="ut-kbd">${formatShortcut('mod+shift+n')}</kbd>${t('palette.hint.new')}</span
            >
          </div>
        </div>
      </modal-wrapper>
    `;
  }

  private renderSection(label: MessageKey, rows: Row[], offset: number) {
    if (!rows.length) return nothing;
    return html`
      <div class="ut-palette-section" role="presentation">${t(label)}</div>
      ${rows.map((row, i) => this.renderRow(row, offset + i))}
    `;
  }

  private renderRow(row: Row, index: number) {
    const selected = index === this.shownIndex;
    return html`
      <button
        id="quick-switcher-item-${index}"
        class="ut-pal-row ut-surface--control"
        role="option"
        tabindex="-1"
        aria-selected=${selected ? 'true' : 'false'}
        data-kind=${row.kind}
        @click=${() => this.activate(row)}
        @mousemove=${() => {
          if (this.selectedIndex !== index) this.selectedIndex = index;
        }}
      >
        ${this.renderRowBody(row)}
      </button>
    `;
  }

  private renderRowBody(row: Row) {
    if (row.kind === 'action') {
      return html`${icon(row.icon)}
        <span class="ut-pal-main"><span class="ut-pal-title">${row.label}</span></span>
        ${row.key ? html`<kbd class="ut-kbd">${formatShortcut(row.key)}</kbd>` : nothing}`;
    }
    if (row.kind === 'quick') {
      return html`${icon('terminal')}
        <span class="ut-pal-main"><span class="ut-pal-title">${row.label}</span></span>
        ${
          row.label === row.entry.command.trim()
            ? nothing
            : html`<span class="ut-pal-meta"><span class="ut-pal-where ut-pal-where--cmd">${row.entry.command}</span></span>`
        }`;
    }
    const s = row.session;
    const repoPath = this.families.get(s.id);
    const where = repoPath
      ? basename(repoPath)
      : s.workingDir
        ? formatPathForDisplay(s.workingDir)
        : '';
    const branch = cleanText(s.gitBranch);
    const last = lastActivityAt(s);
    return html`
      <span class="ut-dot" data-status=${row.status} aria-hidden="true"></span>
      <span class="ut-pal-main"><span class="ut-pal-title">${sessionTitle(s)}</span></span>
      <span class="ut-pal-meta">
        ${
          where
            ? html`<span class="ut-pal-where">${where}${branch ? ` · ${branch}` : ''}</span>`
            : nothing
        }
        ${
          last !== undefined
            ? html`<span class="ut-pal-time">${relativeTime(Date.now() - last)}</span>`
            : nothing
        }
      </span>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'session-quick-switcher': SessionQuickSwitcher;
  }
}
