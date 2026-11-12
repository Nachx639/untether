/**
 * Confirm sheet: a task-engine action an agent asked for (merge with risky changes, discard,
 * change a project's check …) waits for the user's OK (shared/task-confirmations.ts). Opened
 * from the "task-confirm" push (/?confirm=<id>); it reads the pending action from the server
 * (GET /api/confirmations) and answers it (POST /api/confirmations/:id { approve }). Nothing
 * runs without a tap; an expired or already answered request just says so and closes.
 *
 * Rendered into <body> like the answer sheet, with its look (ans-* classes in styles.css).
 */

import { html, nothing, render } from 'lit';
import type { TaskConfirmation } from '../../shared/task-confirmations.js';
import { t } from '../i18n/index.js';
import { toast } from '../utils/action-toast.js';
import { followKeyboard } from '../utils/follow-keyboard.js';
import { swallowNextClick } from '../utils/ghost-click.js';
import { attachSheetDrag } from '../utils/mobile-utils.js';
import { holdSheetFocus } from '../utils/sheet-a11y.js';
import { confirmKindText } from '../utils/task-status.js';
import { icon } from './icons.js';

export interface TaskConfirmSheetOptions {
  id: string;
  authHeader?: () => Record<string, string>;
  /**
   * Called after the request was answered (or failed), with the toast text and its kind:
   * `success` approved, `info` declined, `error` the action ran and failed.
   */
  onDone?: (message: string, kind: TaskConfirmDoneKind) => void;
}

export type TaskConfirmDoneKind = 'success' | 'info' | 'error';

/** The click that finishes the gesture that opened the sheet must not hit its buttons. */
export const CONFIRM_OPEN_GUARD_MS = 500;
/** How long "expired or answered" shows before the sheet closes itself. */
export const CONFIRM_GONE_CLOSE_MS = 1500;
const TAP_SLOP_PX = 10;

/**
 * `unreachable`: the pending action could not be read (offline, 401/403, server error) —
 * not the same as expired, so the sheet offers Retry instead of closing itself.
 */
type Phase = 'loading' | 'ready' | 'sending' | 'gone' | 'unreachable';

/** The heading for a confirmation kind; an unknown kind (newer server) gets the generic title. */
function kindHeading(kind: string): string {
  return confirmKindText(kind, 'confirm.title');
}

let openHost: HTMLElement | null = null;
let releaseFocus: (() => void) | null = null;
let detachSheet: (() => void) | null = null;

export function isTaskConfirmSheetOpen(): boolean {
  return openHost !== null;
}

export function closeTaskConfirmSheet(): void {
  const host = openHost;
  if (!host) return;
  openHost = null;
  render(nothing, host);
  host.remove();
  releaseFocus?.();
  releaseFocus = null;
  detachSheet?.();
  detachSheet = null;
}

export function openTaskConfirmSheet(options: TaskConfirmSheetOptions): void {
  closeTaskConfirmSheet();
  const opener = document.activeElement;
  const host = document.createElement('div');
  document.body.appendChild(host);
  openHost = host;
  const openedAt = Date.now();
  const isOpen = () => openHost === host;

  let phase: Phase = 'loading';
  let confirmation: TaskConfirmation | null = null;
  let failed = false;

  const headers = () => ({ 'Content-Type': 'application/json', ...options.authHeader?.() });

  const load = async (): Promise<TaskConfirmation | null> => {
    const response = await fetch('/api/confirmations', { headers: headers() });
    if (!response.ok) throw new Error(`confirmations ${response.status}`);
    const body = (await response.json()) as { confirmations?: TaskConfirmation[] };
    return body.confirmations?.find((entry) => entry.id === options.id) ?? null;
  };

  const finish = (message: string, kind: TaskConfirmDoneKind) => {
    closeTaskConfirmSheet();
    if (options.onDone) options.onDone(message, kind);
    else toast({ kind, text: message });
  };

  const answer = async (approve: boolean) => {
    if (phase !== 'ready') return;
    phase = 'sending';
    failed = false;
    paint();
    try {
      const response = await fetch(`/api/confirmations/${encodeURIComponent(options.id)}`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ approve }),
      });
      if (response.ok) {
        return approve
          ? finish(t('confirm.approved'), 'success')
          : finish(t('confirm.declined'), 'info');
      }
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
      };
      if (response.status === 404) {
        phase = 'gone';
        return;
      }
      // Consumed either way: the action ran and failed.
      return finish(
        t('confirm.failed', {
          error:
            body.message ||
            body.error ||
            t('sessionAction.error.server', { status: response.status }),
        }),
        'error'
      );
    } catch {
      failed = true;
    } finally {
      if (isOpen()) {
        if (phase === 'sending') phase = 'ready';
        paint();
      }
    }
  };

  // Touch acts on pointerup (iOS takes the first tap on new buttons as a hover); the click
  // that may follow is swallowed. Nothing acts in the first moments after opening.
  let touchActedAt = 0;
  let down: { x: number; y: number } | null = null;
  const act = (fn: () => void) => ({
    handleEvent: (e: Event) => {
      if (e.type === 'pointerdown') {
        const p = e as PointerEvent;
        down = { x: p.clientX, y: p.clientY };
        return;
      }
      if (Date.now() - openedAt < CONFIRM_OPEN_GUARD_MS) return;
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
  const close = act(closeTaskConfirmSheet);
  const retry = act(() => {
    if (phase !== 'unreachable') return;
    phase = 'loading';
    paint();
    void startLoading();
  });
  const approve = act(() => void answer(true));
  const decline = act(() => void answer(false));

  function paint() {
    if (!isOpen()) return;
    const gone = phase === 'gone';
    const unreachable = phase === 'unreachable';
    const busy = phase !== 'ready';
    const entry = confirmation;
    const heading = gone || !entry ? t('confirm.title') : kindHeading(entry.kind);
    const minutes = entry
      ? Math.max(1, Math.ceil((Date.parse(entry.expiresAt) - Date.now()) / 60_000))
      : 0;
    const who = entry?.requestedBy.name || entry?.requestedBy.sessionId;
    render(
      html`
        <div class="ans-backdrop" @click=${close}></div>
        <div
          class="ans-sheet ut-surface--floating ut-surface--material ut-surface--fixed"
          role="dialog"
          aria-modal="true"
          aria-labelledby="task-confirm-title"
          data-testid="task-confirm-sheet"
          data-phase=${phase}
        >
          <div class="ut-grabber" data-sheet-handle aria-hidden="true"></div>
          <div class="ans-head" data-sheet-handle>
            <div class="ans-head-text">
              ${gone ? nothing : html`<p class="ans-eyebrow">${t('confirm.title')}</p>`}
              <h2 id="task-confirm-title" class="ans-title"><bdi>${heading}</bdi></h2>
              ${entry && !gone ? html`<p class="ans-subtitle"><bdi>${entry.where}</bdi></p>` : nothing}
            </div>
            <button
              class="ans-x ut-icon-btn"
              aria-label=${t('common.close')}
              @pointerdown=${close}
              @pointerup=${close}
              @click=${close}
            >
              ${icon('x', 20)}
            </button>
          </div>
          <div class="ans-body">
            ${
              gone
                ? html`<p class="ans-gone" data-testid="task-confirm-gone">${t('confirm.gone')}</p>`
                : unreachable
                  ? html`<div data-testid="task-confirm-unreachable">
                      <p class="ans-error" role="alert">${t('confirm.loadFailed')}</p>
                      <div class="ans-choices">
                        <button
                          class="ans-choice ut-surface--control"
                          data-testid="task-confirm-retry"
                          @pointerdown=${retry}
                          @pointerup=${retry}
                          @click=${retry}
                        >
                          <bdi class="ans-choice-label">${t('confirm.retry')}</bdi>
                        </button>
                      </div>
                    </div>`
                  : !entry
                    ? html`<p class="ans-note">${t('confirm.loading')}</p>`
                    : html`
                      ${
                        entry.detail.length
                          ? html`<div class="ans-detail-block" data-testid="task-confirm-detail">
                              <div
                                class="ans-detail ut-surface--inset"
                                dir="ltr"
                                style="white-space: pre-wrap; max-height: 40vh; overflow-y: auto;"
                              >
                                ${entry.detail.map((line) => html`<div><bdi>${line}</bdi></div>`)}
                              </div>
                            </div>`
                          : nothing
                      }
                      <p class="ans-note" data-testid="task-confirm-who">
                        ${who ? t('confirm.requestedBy', { who }) : t('confirm.requestedByUnknown')}
                        · ${t('confirm.expiresIn', { minutes })}
                      </p>
                      ${
                        failed
                          ? html`<p class="ans-error" role="alert" data-testid="task-confirm-send-failed">
                              ${t('confirm.sendFailed')}
                            </p>`
                          : nothing
                      }
                      <div class="ans-choices">
                        <button
                          id="task-confirm-approve"
                          class="ans-choice ans-choice--primary ut-surface--control"
                          ?disabled=${busy}
                          @pointerdown=${approve}
                          @pointerup=${approve}
                          @click=${approve}
                        >
                          <bdi class="ans-choice-label">${t('confirm.approve')}</bdi>
                        </button>
                        <button
                          id="task-confirm-decline"
                          class="ans-choice ut-surface--control"
                          ?disabled=${busy}
                          @pointerdown=${decline}
                          @pointerup=${decline}
                          @click=${decline}
                        >
                          <bdi class="ans-choice-label">${t('confirm.decline')}</bdi>
                        </button>
                      </div>
                    `
            }
          </div>
        </div>
      `,
      host
    );
    if (gone) closeWhenGone();
  }

  let goneTimer: number | undefined;
  function closeWhenGone() {
    if (goneTimer !== undefined) return;
    goneTimer = window.setTimeout(() => {
      if (!isOpen()) return;
      closeTaskConfirmSheet();
      toast({ kind: 'info', text: t('confirm.gone') });
    }, CONFIRM_GONE_CLOSE_MS);
  }

  paint();
  const sheet = host.querySelector<HTMLElement>('.ans-sheet');
  releaseFocus = holdSheetFocus(sheet, closeTaskConfirmSheet, opener);
  requestAnimationFrame(() => sheet?.classList.add('open'));
  if (sheet) {
    const stopDrag = attachSheetDrag(sheet, {
      scroller: sheet.querySelector<HTMLElement>('.ans-body'),
      onDismiss: closeTaskConfirmSheet,
    });
    // Opened over a keyboard still up (a push tapped while typing): its buttons stay above it.
    const stopKeyboard = followKeyboard(sheet);
    detachSheet = () => {
      stopDrag();
      stopKeyboard();
    };
  }

  // Opened from a push the phone may still be waking up: a failed read is tried again.
  // `undefined` = sheet closed meanwhile, `'unreachable'` = every read failed (offline, 403…),
  // `null` = the server answered and the request is not pending (expired or answered).
  const loadRetrying = async (): Promise<TaskConfirmation | null | undefined | 'unreachable'> => {
    for (const pause of [0, 800, 2000]) {
      if (pause) await new Promise((resolve) => setTimeout(resolve, pause));
      if (!isOpen()) return undefined;
      try {
        return await load();
      } catch {
        // try again
      }
    }
    return 'unreachable';
  };
  function startLoading() {
    return loadRetrying().then((found) => {
      if (!isOpen() || found === undefined) return;
      if (found === 'unreachable') {
        phase = 'unreachable';
      } else if (found) {
        confirmation = found;
        phase = 'ready';
      } else {
        phase = 'gone';
      }
      paint();
    });
  }
  void startLoading();
}
