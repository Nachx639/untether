/**
 * Session switcher sheet (phones)
 *
 * Opened from the session header's title: lists the other running sessions like the phone
 * list rows (avatar, title, what Claude is doing, unread dot), sessions that need you first,
 * so you can jump between conversations without going back to the list. Also holds Rename
 * for the current session, which the title tap used to do.
 *
 * Rendered into <body>: position:fixed inside a transformed ancestor (the phone sidebar,
 * the session view) would be fixed to that ancestor instead of the screen.
 */

import { html, nothing, render } from 'lit';
import { sessionProviderMarker } from '../../../shared/model-providers.js';
import { sessionTitle } from '../../../shared/session-title.js';
import type { Session } from '../../../shared/types.js';
import { t } from '../../i18n/index.js';
import { isBackgroundWait } from '../../utils/claude-activity.js';
import { swallowNextClick } from '../../utils/ghost-click.js';
import { attachSheetDrag as attachSharedSheetDrag } from '../../utils/mobile-utils.js';
import { formatPathForDisplay } from '../../utils/path-utils.js';
import { deriveSessionStatus, statusLabel } from '../../utils/session-status.js';
import { resetTitleLabel } from '../../utils/session-title.js';
import { holdSheetFocus } from '../../utils/sheet-a11y.js';
import { isUnread } from '../../utils/unread-tracker.js';
import { agentLogo } from '../agent-avatar.js';
import { agentKind, icon } from '../icons.js';
import { rowState } from '../phone-session-row.js';
import '../rename-field.js';
import type { SaveName } from '../rename-field.js';

/** Finger travel that makes a touch a scroll of the list, not a tap on an item. */
const TAP_SLOP_PX = 10;

/**
 * Swipe down to dismiss a phone bottom sheet (phone spec 3.2): the shared touch-event drag
 * (utils/mobile-utils.ts). A drag from the grabber (`data-sheet-handle`) always moves the
 * sheet; from the content only while `scroller` is at the top.
 *
 * 2026-10-12 (QA): this used pointer events, which iOS cancels (pointercancel) as soon as a
 * vertical pan starts scrolling the sheet, so the sheet snapped back on a real iPhone. Touch
 * events with a non-passive touchmove keep the gesture. Returns the detach function.
 */
export function attachSheetDrag(
  sheet: HTMLElement,
  onDismiss: () => void,
  scroller: HTMLElement | null = null
): () => void {
  return attachSharedSheetDrag(sheet, { onDismiss, scroller });
}

/** The 36x5 grabber at the top of a phone sheet (styled in styles/session.css). */
export const SHEET_GRABBER = html`<div class="ut-sheet-grabber" data-sheet-handle aria-hidden="true"></div>`;

/** A session's row status as the shared pill: dot + label (deriveSessionStatus). */
function statusPill(session: Session) {
  const status = deriveSessionStatus(session);
  const label = isBackgroundWait(session.claudeStatus)
    ? t('activity.backgroundWait')
    : statusLabel(status, session);
  return html`<span class="ut-status" data-status=${status}
    ><span class="ut-dot"></span><span class="ut-switch-status-label">${label}</span></span
  >`;
}

export function sessionDisplayTitle(session: Session): string {
  const command = Array.isArray(session.command) ? session.command.join(' ') : '';
  return sessionTitle(session) || session.name || command;
}

/** Other running sessions, the ones that need you first, then unread, then most recent. */
export function switcherSessions(sessions: Session[], currentId: string): Session[] {
  const rank = (session: Session) =>
    rowState(session) === 'waiting' ? 0 : isUnread(session) ? 1 : 2;
  const time = (session: Session) => Date.parse(session.lastModified || session.startedAt) || 0;
  return sessions
    .filter((session) => session.id !== currentId && session.status === 'running')
    .sort((a, b) => rank(a) - rank(b) || time(b) - time(a));
}

export interface SessionSwitcherOptions {
  current: Session;
  sessions: Session[];
  onSelect: (session: Session) => void;
  /** Rename the current session in place: the row becomes a field (rename-field.ts). */
  rename?: { value: string; save: SaveName };
  /** The session has a title the user gave it: go back to the agent's ("Use Claude's title"). */
  onResetTitle?: () => void;
  /** AI sessions: ask the assistant to retitle the terminal (the desktop header's wand). */
  onUpdateTitle?: () => void;
}

let openHost: HTMLElement | null = null;
let releaseFocus: (() => void) | null = null;
let releaseDrag: (() => void) | null = null;

export function closeSessionSwitcher(): void {
  if (!openHost) return;
  render(nothing, openHost);
  openHost.remove();
  openHost = null;
  releaseFocus?.();
  releaseFocus = null;
  releaseDrag?.();
  releaseDrag = null;
}

export function openSessionSwitcher(options: SessionSwitcherOptions): void {
  closeSessionSwitcher();
  const host = document.createElement('div');
  host.dataset.testid = 'session-switcher';
  document.body.appendChild(host);
  openHost = host;
  const openedAt = Date.now();

  // Touch acts on pointerup: on iOS the first tap on freshly shown buttons is often taken
  // as a hover and produces no click. The click that may still follow is ignored; mouse and
  // keyboard use the click. A touch that moved (scrolling the list) is not a tap.
  let touchActedAt = 0;
  let down: { x: number; y: number } | null = null;
  const act = (fn: () => void) => ({
    handleEvent: (e: Event) => {
      if (e.type === 'pointerdown') {
        const p = e as PointerEvent;
        down = { x: p.clientX, y: p.clientY };
        return;
      }
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
      closeSessionSwitcher();
      fn();
    },
  });

  // Same touch handling for a step inside the sheet (Rename becomes a field): it stays open.
  const step = (fn: () => void) => ({
    handleEvent: (e: Event) => {
      if (e.type === 'pointerdown') return;
      if (e.type === 'pointerup') {
        if ((e as PointerEvent).pointerType === 'mouse') return;
        touchActedAt = Date.now();
        swallowNextClick();
      } else if (Date.now() - touchActedAt < 700) {
        return;
      }
      fn();
    },
  });
  let renaming = false;
  const setRenaming = (on: boolean) => {
    renaming = on;
    draw();
    if (!on) host.querySelector<HTMLElement>('[data-testid="switcher-rename"]')?.focus();
  };

  const sheetAction = (testId: string, label: string, fn: () => void) => {
    const handler = act(fn);
    return html`<button
      data-testid=${testId}
      @pointerdown=${handler}
      @pointerup=${handler}
      @click=${handler}
    >
      ${label}
    </button>`;
  };

  const others = switcherSessions(options.sessions, options.current.id);
  const avatar = (session: Session) =>
    html`<span class="ut-switch-avatar" aria-hidden=${sessionProviderMarker(session) ? nothing : 'true'}>${agentLogo(agentKind(session), sessionProviderMarker(session), 20)}</span>`;
  const item = (session: Session) => {
    const claude = session.claudeStatus;
    const unread = isUnread(session);
    const preview =
      rowState(session) === 'idle' && claude?.preview && !isBackgroundWait(claude)
        ? claude.preview.text
        : formatPathForDisplay(session.workingDir);
    const handler = act(() => options.onSelect(session));
    return html`
      <button
        class="ut-switch-item"
        data-testid="switcher-item"
        data-session-id=${session.id}
        data-status=${deriveSessionStatus(session)}
        @pointerdown=${handler}
        @pointerup=${handler}
        @click=${handler}
      >
        ${avatar(session)}
        <span class="ut-switch-body">
          <span class="ut-switch-title"><bdi>${sessionDisplayTitle(session)}</bdi></span>
          <span class="ut-switch-detail">${statusPill(session)}<bdi class="ut-switch-preview">${preview}</bdi></span>
        </span>
        ${unread ? html`<span class="ut-switch-unread" aria-hidden="true"></span><span class="sr-only">${t('sessions.row.unread')}</span>` : nothing}
      </button>
    `;
  };
  // The session on screen first, checked: tapping it just closes the sheet.
  const currentRow = () => {
    const session = options.current;
    const handler = act(() => {});
    return html`<button
      class="ut-switch-item ut-switch-current"
      data-testid="switcher-current"
      data-session-id=${session.id}
      aria-current="true"
      @pointerdown=${handler}
      @pointerup=${handler}
      @click=${handler}
    >
      ${avatar(session)}
      <span class="ut-switch-body">
        <span class="ut-switch-title"><bdi>${sessionDisplayTitle(session)}</bdi></span>
        <span class="ut-switch-detail">${statusPill(session)}</span>
      </span>
      <span class="ut-switch-check">${icon('check', 20)}</span>
    </button>`;
  };

  const renameRow = (rename: NonNullable<SessionSwitcherOptions['rename']>) => {
    if (renaming) {
      return html`<ut-rename-field
        data-testid="switcher-rename-field"
        .value=${rename.value}
        .save=${rename.save}
        @rename-done=${() => closeSessionSwitcher()}
        @rename-cancel=${() => setRenaming(false)}
      ></ut-rename-field>`;
    }
    const handler = step(() => setRenaming(true));
    return html`<button
      data-testid="switcher-rename"
      @pointerdown=${handler}
      @pointerup=${handler}
      @click=${handler}
    >
      ${t('switcher.renameCurrent')}
    </button>`;
  };

  const draw = () =>
    render(
      html`
      <div
        class="psr-sheet-backdrop"
        @click=${() => {
          // The click finishing the tap that opened the sheet can land on the new backdrop.
          if (Date.now() - openedAt > 400) closeSessionSwitcher();
        }}
      ></div>
      <div
        class="psr-sheet ut-session-sheet ut-switch-sheet"
        role="dialog"
        aria-modal="true"
        aria-label=${t('switcher.title')}
      >
        <div class="psr-sheet-group ut-surface--floating ut-surface--material">
          ${SHEET_GRABBER}
          <div class="psr-sheet-title">${t('switcher.title')}</div>
          <div class="ut-switch-list">
            ${currentRow()}
            ${others.map(item)}
          </div>
          ${others.length ? nothing : html`<div class="ut-switch-empty">${t('switcher.empty')}</div>`}
        </div>
        ${
          options.rename || options.onResetTitle || options.onUpdateTitle
            ? html`<div class="psr-sheet-group ut-surface--floating ut-surface--material">
                ${options.rename ? renameRow(options.rename) : nothing}
                ${
                  options.onResetTitle
                    ? sheetAction(
                        'switcher-reset-title',
                        resetTitleLabel(options.current),
                        options.onResetTitle
                      )
                    : nothing
                }
                ${
                  options.onUpdateTitle
                    ? sheetAction(
                        'switcher-update-title',
                        t('switcher.updateTitle'),
                        options.onUpdateTitle
                      )
                    : nothing
                }
              </div>`
            : nothing
        }
        <button class="psr-sheet-cancel ut-surface--floating ut-surface--material" @click=${closeSessionSwitcher}>${t('common.cancel')}</button>
      </div>
    `,
      host
    );
  draw();
  const sheet = host.querySelector<HTMLElement>('.psr-sheet');
  releaseFocus = holdSheetFocus(sheet, closeSessionSwitcher);
  if (sheet) {
    releaseDrag = attachSheetDrag(
      sheet,
      closeSessionSwitcher,
      host.querySelector<HTMLElement>('.ut-switch-list')
    );
  }
  requestAnimationFrame(() => host.querySelector('.psr-sheet')?.classList.add('open'));
}
