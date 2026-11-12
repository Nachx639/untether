/**
 * Changes (phones): what changed in the session's git repository since the last commit, so
 * the user can review an agent's edits without leaving the session. A list of changed files
 * (status, path, +/- lines); tapping one shows its unified diff, wrapped to the screen.
 *
 * Rendered into <body>: position:fixed inside a transformed ancestor (the session view) would
 * be fixed to that ancestor instead of the screen. All file content goes through Lit text
 * bindings, never innerHTML.
 */

import { html, nothing, render } from 'lit';
import { t } from '../../i18n/index.js';
import { authClient } from '../../services/auth-client.js';
import { Z_INDEX } from '../../utils/constants.js';
import { swallowNextClick } from '../../utils/ghost-click.js';
import { holdSheetFocus } from '../../utils/sheet-a11y.js';
import { closeShipSheet, isShipSheetOpen, openShipSheet, type ShipMode } from './ship-sheet.js';

/** The click that finishes the gesture that opened the sheet must not hit its buttons. */
const OPEN_GUARD_MS = 500;
const TAP_SLOP_PX = 10;

export type ChangeStatus = 'M' | 'A' | 'D' | 'R' | 'T' | '??';

export interface ChangedFile {
  path: string;
  oldPath?: string;
  status: ChangeStatus;
  additions: number;
  deletions: number;
  binary: boolean;
}

interface ChangesResponse {
  isGitRepo: boolean;
  repoPath?: string;
  files: ChangedFile[];
  totals: { files: number; additions: number; deletions: number };
  untrackedTruncated?: boolean;
}

interface FileDiffResponse {
  file: string;
  diff: string;
  binary: boolean;
  truncated: boolean;
  untracked: boolean;
}

export type DiffLine =
  | { kind: 'hunk'; text: string }
  | { kind: 'add' | 'del' | 'ctx'; text: string; oldNo?: number; newNo?: number }
  | { kind: 'meta'; text: string };

/** Unified diff → display lines. File headers are dropped; hunks carry line numbers. */
export function parseUnifiedDiff(diff: string): DiffLine[] {
  const out: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  const lines = diff.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  for (const line of lines) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      inHunk = true;
      out.push({ kind: 'hunk', text: line });
    } else if (!inHunk || line.startsWith('diff --git ')) {
      inHunk = false;
    } else if (line.startsWith('+')) {
      out.push({ kind: 'add', text: line.slice(1), newNo: newNo++ });
    } else if (line.startsWith('-')) {
      out.push({ kind: 'del', text: line.slice(1), oldNo: oldNo++ });
    } else if (line.startsWith('\\')) {
      out.push({ kind: 'meta', text: line });
    } else {
      out.push({ kind: 'ctx', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
    }
  }
  return out;
}

/** "src/a/b.ts" → ["src/a/", "b.ts"] */
export function splitPath(p: string): [string, string] {
  const i = p.lastIndexOf('/');
  return i < 0 ? ['', p] : [p.slice(0, i + 1), p.slice(i + 1)];
}

const STATUS_LABEL: Record<ChangeStatus, string> = {
  M: 'M',
  A: 'A',
  D: 'D',
  R: 'R',
  T: 'T',
  '??': 'U',
};

function statusClass(status: ChangeStatus): string {
  if (status === 'A' || status === '??') return 'ut-chg-s-add';
  if (status === 'D') return 'ut-chg-s-del';
  if (status === 'R') return 'ut-chg-s-ren';
  return 'ut-chg-s-mod';
}

async function getJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const res = await fetch(url, { headers: authClient.getAuthHeader(), signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

let openHost: HTMLElement | null = null;
let releaseFocus: (() => void) | null = null;
let abort: AbortController | null = null;

export function closeChangesSheet(): void {
  closeShipSheet();
  if (!openHost) return;
  abort?.abort();
  abort = null;
  render(nothing, openHost);
  openHost.remove();
  openHost = null;
  releaseFocus?.();
  releaseFocus = null;
}

export function isChangesSheetOpen(): boolean {
  return openHost !== null;
}

/** A changed file named by an absolute path (or a repo-relative one) in a changes list. */
export function findChangedFile(
  files: ChangedFile[],
  file: string,
  repoPath?: string
): ChangedFile | undefined {
  const root = repoPath?.replace(/\/+$/, '');
  return (
    files.find((f) => f.path === file || (root !== undefined && `${root}/${f.path}` === file)) ??
    files.find((f) => file.endsWith(`/${f.path}`))
  );
}

/**
 * Opens the Changes sheet for the git repository containing `dir`; with `options.file`, opens
 * straight on that file's diff when it is among the changes. A task row passes its worktree
 * and `since` (its base branch), so its commits show too.
 */
export function openChangesSheet(
  dir: string,
  options: {
    file?: string;
    sessionId?: string;
    /** A task's base branch: its changes are counted from where it left that branch. */
    since?: string;
  } = {}
): void {
  closeChangesSheet();
  const active = document.activeElement;
  if (active instanceof HTMLElement && active.matches('input, textarea, [contenteditable]')) {
    active.blur();
  }

  const host = document.createElement('div');
  host.dataset.testid = 'changes-sheet';
  document.body.appendChild(host);
  openHost = host;
  const controller = new AbortController();
  abort = controller;
  const openedAt = Date.now();

  let list: ChangesResponse | null = null;
  let listState: 'loading' | 'ready' | 'error' = 'loading';
  let selected: ChangedFile | null = null;
  let diff: FileDiffResponse | null = null;
  let diffState: 'loading' | 'ready' | 'error' = 'loading';
  let listScroll = 0;
  let listSeq = 0;
  let diffSeq = 0;
  let pendingFile = options.file;

  // Touch acts on pointerup: on iOS the first tap on freshly shown buttons is often taken
  // as a hover and produces no click. The click that may still follow is ignored; mouse and
  // keyboard use the click. Nothing acts in the first moments after opening.
  let touchActedAt = 0;
  let down: { x: number; y: number } | null = null;
  const act = (fn: () => void) => ({
    handleEvent: (e: Event) => {
      if (e.type === 'pointerdown') {
        const p = e as PointerEvent;
        down = { x: p.clientX, y: p.clientY };
        return;
      }
      if (Date.now() - openedAt < OPEN_GUARD_MS) return;
      if (e.type === 'pointerup') {
        const p = e as PointerEvent;
        if (p.pointerType === 'mouse') return;
        const moved = down && Math.hypot(p.clientX - down.x, p.clientY - down.y) > TAP_SLOP_PX;
        down = null;
        if (moved) return;
        touchActedAt = Date.now();
        swallowNextClick();
      } else if (Date.now() - touchActedAt < 700) {
        return;
      }
      fn();
    },
  });

  const since = options.since ? `&since=${encodeURIComponent(options.since)}` : '';
  const loadList = async () => {
    const seq = ++listSeq;
    listState = 'loading';
    draw();
    try {
      const data = await getJson<ChangesResponse>(
        `/api/git/changes?path=${encodeURIComponent(dir)}${since}`,
        controller.signal
      );
      if (seq !== listSeq) return;
      list = data;
      listState = 'ready';
      const wanted = pendingFile && findChangedFile(data.files, pendingFile, data.repoPath);
      pendingFile = undefined;
      if (wanted) {
        selected = wanted;
        void loadDiff(wanted);
      }
    } catch {
      if (controller.signal.aborted || seq !== listSeq) return;
      listState = 'error';
    }
    draw();
  };

  const loadDiff = async (file: ChangedFile) => {
    const seq = ++diffSeq;
    diffState = 'loading';
    diff = null;
    draw();
    const params = new URLSearchParams({ path: dir, file: file.path });
    if (file.oldPath) params.set('oldFile', file.oldPath);
    if (options.since) params.set('since', options.since);
    try {
      const data = await getJson<FileDiffResponse>(
        `/api/git/changes/diff?${params}`,
        controller.signal
      );
      if (seq !== diffSeq || selected !== file) return;
      diff = data;
      diffState = 'ready';
    } catch {
      if (controller.signal.aborted || seq !== diffSeq) return;
      diffState = 'error';
    }
    draw();
  };

  const scroller = () => host.querySelector<HTMLElement>('.ut-chg-body');

  const openFile = (file: ChangedFile) =>
    act(() => {
      listScroll = scroller()?.scrollTop ?? 0;
      selected = file;
      void loadDiff(file);
      const body = scroller();
      if (body) body.scrollTop = 0;
    });

  const goBack = () => {
    selected = null;
    diff = null;
    diffSeq++;
    draw();
    const body = scroller();
    if (body) body.scrollTop = listScroll;
  };
  const back = act(goBack);
  const refresh = act(() => {
    if (selected) void loadDiff(selected);
    else void loadList();
  });
  const close = act(closeChangesSheet);
  const ship = (mode: ShipMode) =>
    act(() => {
      if (options.sessionId)
        openShipSheet(options.sessionId, mode, { onDone: () => void loadList() });
    });
  const shipCommit = ship('commit');
  const shipPush = ship('push');
  const shipPr = ship('pr');

  /** Commit / Push / PR, for a session's repository (needs the session to run git there). */
  const renderShipBar = () => {
    if (!options.sessionId || selected || !list?.isGitRepo) return nothing;
    return html`<div class="ut-chg-ship ut-surface--panel" data-testid="changes-ship">
      <button
        data-testid="changes-commit"
        ?disabled=${list.files.length === 0}
        @pointerdown=${shipCommit}
        @pointerup=${shipCommit}
        @click=${shipCommit}
      >
        ${t('ship.commit')}
      </button>
      <button data-testid="changes-push" @pointerdown=${shipPush} @pointerup=${shipPush} @click=${shipPush}>
        ${t('ship.push')}
      </button>
      <button data-testid="changes-pr" @pointerdown=${shipPr} @pointerup=${shipPr} @click=${shipPr}>
        ${t('ship.pr')}
      </button>
    </div>`;
  };

  const renderPath = (p: string) => {
    const [dirPart, base] = splitPath(p);
    return html`<span class="ut-chg-dir">${dirPart}</span><span class="ut-chg-base">${base}</span>`;
  };

  const renderCounts = (f: { additions: number; deletions: number; binary?: boolean }) =>
    f.binary
      ? html`<span class="ut-chg-bin">bin</span>`
      : html`<span class="ut-chg-plus">+${f.additions}</span>
          <span class="ut-chg-minus">−${f.deletions}</span>`;

  const renderList = () => {
    if (listState === 'loading' && !list) {
      return html`<div class="ut-chg-note">${t('changes.loading')}</div>`;
    }
    if (listState === 'error') {
      return html`<div class="ut-chg-note">${t('changes.error')}</div>`;
    }
    if (!list) return nothing;
    if (!list.isGitRepo) {
      return html`<div class="ut-chg-note" data-testid="changes-not-repo">
        ${t('changes.notRepo')}
      </div>`;
    }
    if (list.files.length === 0) {
      return html`<div class="ut-chg-note" data-testid="changes-empty">${t('changes.empty')}</div>`;
    }
    const { totals } = list;
    return html`
      <div class="ut-chg-summary" data-testid="changes-summary">
        <span>
          ${
            totals.files === 1
              ? t('changes.summaryOne')
              : t('changes.summaryMany', { count: totals.files })
          }
        </span>
        ${renderCounts(totals)}
      </div>
      <ul class="ut-chg-list" role="list">
        ${list.files.map(
          (f) => html`
            <li>
              <button
                class="ut-chg-row ut-surface--panel ut-surface--material"
                data-testid="changes-file"
                @pointerdown=${openFile(f)}
                @pointerup=${openFile(f)}
                @click=${openFile(f)}
              >
                <span class="ut-chg-status ${statusClass(f.status)}">${STATUS_LABEL[f.status]}</span>
                <span class="ut-chg-path" dir="ltr">${renderPath(f.path)}</span>
                <span class="ut-chg-counts">${renderCounts(f)}</span>
              </button>
            </li>
          `
        )}
      </ul>
      ${
        list.untrackedTruncated
          ? html`<div class="ut-chg-note">${t('changes.untrackedMore')}</div>`
          : nothing
      }
    `;
  };

  const renderDiff = (file: ChangedFile) => {
    const header = html`
      <div class="ut-chg-summary">
        <span class="ut-chg-status ${statusClass(file.status)}">${STATUS_LABEL[file.status]}</span>
        <span class="ut-chg-path" dir="ltr">${renderPath(file.path)}</span>
        <span class="ut-chg-counts">${renderCounts(file)}</span>
      </div>
      ${
        file.oldPath
          ? html`<div class="ut-chg-note ut-chg-left" dir="ltr">
              ${t('changes.renamedFrom', { path: file.oldPath })}
            </div>`
          : nothing
      }
    `;
    if (diffState === 'loading') {
      return html`${header}<div class="ut-chg-note">${t('changes.loading')}</div>`;
    }
    if (diffState === 'error' || !diff) {
      return html`${header}<div class="ut-chg-note">${t('changes.error')}</div>`;
    }
    if (diff.binary) {
      return html`${header}<div class="ut-chg-note">${t('changes.binary')}</div>`;
    }
    const lines = parseUnifiedDiff(diff.diff);
    if (lines.length === 0) {
      return html`${header}<div class="ut-chg-note">${t('changes.noDiff')}</div>`;
    }
    return html`
      ${header}
      <div class="ut-chg-diff" dir="ltr" data-testid="changes-diff">
        ${lines.map((l) => {
          if (l.kind === 'hunk') return html`<div class="ut-dl ut-dl-hunk">${l.text}</div>`;
          if (l.kind === 'meta') return html`<div class="ut-dl ut-dl-meta">${l.text}</div>`;
          const no = l.kind === 'del' ? l.oldNo : l.newNo;
          const sign = l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' ';
          return html`<div class="ut-dl ut-dl-${l.kind}"><span class="ut-dl-no">${no}</span><span class="ut-dl-sign">${sign}</span><span class="ut-dl-text">${l.text}</span></div>`;
        })}
      </div>
      ${diff.truncated ? html`<div class="ut-chg-note">${t('changes.truncated')}</div>` : nothing}
    `;
  };

  const draw = () => {
    if (openHost !== host) return;
    const loading = selected ? diffState === 'loading' : listState === 'loading';
    render(
      html`
        <style>
          .ut-chg {
            position: fixed;
            inset: 0;
            display: flex;
            flex-direction: column;
            background: var(--color-bg);
            color: var(--color-text);
            padding: env(safe-area-inset-top) env(safe-area-inset-right) 0 env(safe-area-inset-left);
            --ut-chg-add: var(--color-status-success);
            --ut-chg-del: var(--color-status-error);
            --ut-chg-add-text: color-mix(in srgb, var(--color-status-success) 65%, var(--color-text));
            --ut-chg-del-text: color-mix(in srgb, var(--color-status-error) 70%, var(--color-text));
          }
          .ut-chg-bar {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 8px 12px;
            border-bottom: 1px solid var(--color-border);
            background: var(--color-bg-secondary);
          }
          .ut-chg-title {
            flex: 1;
            min-width: 0;
            font-weight: var(--ut-fw-semibold);
            font-size: 15px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
          }
          .ut-chg-bar button {
            min-height: 40px;
            min-width: 40px;
            padding: 0 12px;
            border-radius: var(--ut-r-8);
            font-size: 14px;
            border: 1px solid var(--color-border);
            color: var(--color-text);
            background: var(--color-bg-tertiary);
            touch-action: manipulation;
          }
          .ut-chg-bar button:disabled {
            opacity: 0.5;
          }
          .ut-chg-body {
            flex: 1;
            overflow: auto;
            overscroll-behavior: contain;
            -webkit-overflow-scrolling: touch;
            padding-bottom: calc(16px + env(safe-area-inset-bottom));
          }
          .ut-chg-summary {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 10px 12px;
            font-size: 13px;
            color: var(--color-text-muted);
            border-bottom: 1px solid var(--color-border);
          }
          .ut-chg-summary > span:first-child {
            flex: 0 0 auto;
          }
          .ut-chg-list {
            list-style: none;
            margin: 0;
            padding: 0;
          }
          .ut-chg-row {
            display: flex;
            align-items: center;
            gap: 10px;
            width: 100%;
            min-height: 48px;
            padding: 8px 12px;
            text-align: left;
            border-bottom: 1px solid var(--color-border);
            color: var(--color-text);
            background: transparent;
            touch-action: manipulation;
          }
          .ut-chg-row:active {
            background: var(--color-surface-hover);
          }
          .ut-chg-status {
            flex: 0 0 auto;
            width: 22px;
            text-align: center;
            font-family: var(--ut-font-mono-system);
            font-weight: var(--ut-fw-bold);
            font-size: 13px;
          }
          .ut-chg-s-add { color: var(--ut-chg-add-text); }
          .ut-chg-s-del { color: var(--ut-chg-del-text); }
          .ut-chg-s-mod { color: var(--color-status-warning-text, var(--color-status-warning)); }
          .ut-chg-s-ren { color: var(--color-status-info-text, var(--color-status-info)); }
          .ut-chg-path {
            flex: 1;
            min-width: 0;
            font-family: var(--ut-font-mono-system);
            font-size: 13px;
            overflow-wrap: anywhere;
            text-align: left;
          }
          .ut-chg-dir { color: var(--color-text-dim); }
          .ut-chg-base { color: var(--color-text); }
          .ut-chg-counts {
            flex: 0 0 auto;
            display: flex;
            gap: 6px;
            font-family: var(--ut-font-mono-system);
            font-size: 12px;
          }
          .ut-chg-plus { color: var(--ut-chg-add-text); }
          .ut-chg-minus { color: var(--ut-chg-del-text); }
          .ut-chg-bin { color: var(--color-text-dim); }
          .ut-chg-note {
            padding: 20px 16px;
            text-align: center;
            font-size: 14px;
            color: var(--color-text-dim);
          }
          .ut-chg-note.ut-chg-left {
            padding: 6px 12px;
            text-align: left;
            font-size: 12px;
            overflow-wrap: anywhere;
          }
          .ut-chg-diff {
            font-family: var(--ut-font-mono-system);
            font-size: 12px;
            line-height: 1.45;
            user-select: text;
            -webkit-user-select: text;
          }
          .ut-dl {
            display: flex;
            white-space: pre-wrap;
            overflow-wrap: anywhere;
            word-break: break-word;
            padding-right: 8px;
          }
          .ut-dl-add { background: color-mix(in srgb, var(--ut-chg-add) 20%, var(--color-bg)); }
          .ut-dl-del { background: color-mix(in srgb, var(--ut-chg-del) 20%, var(--color-bg)); }
          .ut-dl-hunk, .ut-dl-meta {
            padding: 4px 8px;
            color: var(--color-text-muted);
            background: var(--color-bg-secondary);
          }
          .ut-dl-hunk {
            margin-top: 6px;
            border-top: 1px solid var(--color-border);
            border-bottom: 1px solid var(--color-border);
          }
          .ut-dl-no {
            flex: 0 0 auto;
            min-width: 3.2em;
            padding: 0 6px 0 4px;
            text-align: right;
            color: var(--color-text-dim);
            user-select: none;
            -webkit-user-select: none;
          }
          .ut-dl-sign {
            flex: 0 0 auto;
            width: 1.2em;
            user-select: none;
            -webkit-user-select: none;
          }
          .ut-dl-add .ut-dl-sign { color: var(--ut-chg-add-text); }
          .ut-dl-del .ut-dl-sign { color: var(--ut-chg-del-text); }
          .ut-chg-ship {
            display: flex;
            gap: 8px;
            padding: 8px 12px calc(8px + env(safe-area-inset-bottom));
            border-top: 1px solid var(--color-border);
            background: var(--color-bg-secondary);
          }
          .ut-chg-ship button {
            flex: 1;
            min-height: 44px;
            border-radius: var(--ut-r-8);
            font-size: 15px;
            border: 1px solid var(--color-border);
            color: var(--color-text);
            background: var(--color-bg-tertiary);
            touch-action: manipulation;
          }
          .ut-chg-ship button:disabled {
            opacity: 0.45;
          }
          .ut-dl-text {
            flex: 1;
            min-width: 0;
          }
        </style>
        <div
          class="ut-chg"
          role="dialog"
          aria-modal="true"
          aria-label=${t('changes.title')}
          style="z-index: ${Z_INDEX.MODAL};"
        >
          <div class="ut-chg-bar ut-surface--bar">
            ${
              selected
                ? html`<button
                    data-testid="changes-back"
                    aria-label=${t('changes.back')}
                    @pointerdown=${back}
                    @pointerup=${back}
                    @click=${back}
                  >
                    ‹ ${t('changes.back')}
                  </button>`
                : nothing
            }
            <div class="ut-chg-title" dir="auto">
              ${selected ? splitPath(selected.path)[1] : t('changes.title')}
            </div>
            <button
              data-testid="changes-refresh"
              aria-label=${t('changes.refresh')}
              title=${t('changes.refresh')}
              ?disabled=${loading}
              @pointerdown=${refresh}
              @pointerup=${refresh}
              @click=${refresh}
            >
              ↻
            </button>
            <button
              data-testid="changes-close"
              @pointerdown=${close}
              @pointerup=${close}
              @click=${close}
            >
              ${t('changes.close')}
            </button>
          </div>
          <div class="ut-chg-body">${selected ? renderDiff(selected) : renderList()}</div>
          ${renderShipBar()}
        </div>
      `,
      host
    );
  };

  draw();
  // Escape steps back from a diff to the list, then closes.
  releaseFocus = holdSheetFocus(host.querySelector<HTMLElement>('.ut-chg'), () => {
    if (isShipSheetOpen()) return; // Escape belongs to the ship sheet on top
    if (selected) goBack();
    else closeChangesSheet();
  });
  void loadList();
}
