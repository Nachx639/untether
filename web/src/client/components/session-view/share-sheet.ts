/**
 * "Compartir en solo lectura": a link that shows this session's screen, live, to whoever has
 * it, without the Untether login and without any way to type into it, until it expires or
 * is revoked (server: routes/share.ts). On a tailnet-only setup the server is only reachable from the
 * tailnet, so are the links. The sheet lists the session's live links (copy, share, revoke)
 * and creates new ones for 15 min, 1 h or 8 h.
 *
 * Rendered into <body> like the other phone sheets: position:fixed inside the transformed
 * session view would be fixed to the view instead of the screen.
 */
import { html, nothing, render } from 'lit';
import { t } from '../../i18n/index.js';
import { authClient } from '../../services/auth-client.js';
import { swallowNextClick } from '../../utils/ghost-click.js';
import { endsADrag } from '../../utils/pointer-drag.js';
import { holdSheetFocus } from '../../utils/sheet-a11y.js';

/** The click that finishes the gesture that opened the sheet must not hit its buttons. */
const OPEN_GUARD_MS = 500;
export const SHARE_DURATIONS_MIN = [15, 60, 480] as const;

export interface ShareItem {
  token: string;
  path: string;
  createdAt: number;
  expiresAt: number;
}

let openHost: HTMLElement | null = null;
let releaseFocus: (() => void) | null = null;
let ticker: ReturnType<typeof setInterval> | null = null;

export function isShareSheetOpen(): boolean {
  return openHost !== null;
}

export function closeShareSheet(): void {
  if (ticker) clearInterval(ticker);
  ticker = null;
  releaseFocus?.();
  releaseFocus = null;
  if (!openHost) return;
  render(nothing, openHost);
  openHost.remove();
  openHost = null;
}

/** "58 min", "8 h": time left of a link. */
export function formatTimeLeft(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return minutes >= 90
    ? t('share.hours', { n: Math.round(minutes / 60) })
    : t('share.minutes', { n: minutes });
}

/** The full link the other person opens (this origin, e.g. the tailnet name). */
export function shareUrl(item: Pick<ShareItem, 'path'>): string {
  return `${window.location.origin}${item.path}`;
}

export function openShareSheet(sessionId: string, sessionName: string): void {
  closeShareSheet();
  const active = document.activeElement;
  if (active instanceof HTMLElement && active.matches('input, textarea, [contenteditable]')) {
    active.blur();
  }
  const host = document.createElement('div');
  host.dataset.testid = 'share-sheet';
  document.body.appendChild(host);
  openHost = host;
  const openedAt = Date.now();

  let shares: ShareItem[] | null = null;
  let busy = false;
  let error = '';
  let copied: string | null = null;
  const revoking = new Set<string>();
  const canNativeShare = typeof navigator.share === 'function';

  const api = (path: string, init: RequestInit = {}) =>
    fetch(path, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...authClient.getAuthHeader() },
    });

  // Touch acts on pointerup (iOS takes the first tap on fresh buttons as a hover); the click
  // that follows is swallowed. Nothing acts in the first moments after opening.
  let touchActedAt = 0;
  const act = (fn: () => void) => ({
    handleEvent: (e: Event) => {
      if (Date.now() - openedAt < OPEN_GUARD_MS) return;
      if (e.type === 'pointerup') {
        if ((e as PointerEvent).pointerType === 'mouse') return;
        // A scroll of the sheet that started on a button ends here too: not a tap.
        if (endsADrag(e as PointerEvent)) return;
        touchActedAt = Date.now();
        swallowNextClick();
      } else if (e.type === 'click' && Date.now() - touchActedAt < 700) {
        return;
      }
      fn();
    },
  });

  const load = async () => {
    try {
      const response = await api(`/api/sessions/${encodeURIComponent(sessionId)}/shares`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      shares = Array.isArray(body.shares) ? body.shares : [];
    } catch {
      // An empty list would read "no live links" while some may still be out there.
      shares = [];
      error = t('share.loadError');
    }
    draw();
  };

  const create = async (minutes: number) => {
    if (busy) return;
    busy = true;
    error = '';
    draw();
    try {
      const response = await api(`/api/sessions/${encodeURIComponent(sessionId)}/shares`, {
        method: 'POST',
        body: JSON.stringify({ minutes }),
      });
      const body = await response.json();
      if (!response.ok || !body.share) throw new Error(body.error || response.statusText);
      shares = [body.share as ShareItem, ...(shares ?? [])];
    } catch {
      error = t('share.error');
    } finally {
      busy = false;
      draw();
    }
  };

  // The link leaves the list only once the server revoked it: dropping it first and ignoring
  // a failed DELETE left a link working that the sheet said was gone. 404 = already gone.
  const revoke = async (item: ShareItem) => {
    if (revoking.has(item.token)) return;
    revoking.add(item.token);
    error = '';
    draw();
    try {
      const response = await api(`/api/shares/${encodeURIComponent(item.token)}`, {
        method: 'DELETE',
      });
      if (!response.ok && response.status !== 404) throw new Error(`HTTP ${response.status}`);
      shares = (shares ?? []).filter((share) => share.token !== item.token);
    } catch {
      error = t('share.revokeError');
    } finally {
      revoking.delete(item.token);
      draw();
    }
  };

  const copy = async (item: ShareItem) => {
    try {
      await navigator.clipboard.writeText(shareUrl(item));
      copied = item.token;
      draw();
      setTimeout(() => {
        if (copied === item.token) {
          copied = null;
          draw();
        }
      }, 1800);
    } catch {
      // No clipboard (insecure origin): the link stays selectable on screen.
    }
  };

  const nativeShare = (item: ShareItem) => {
    void navigator.share({ title: sessionName, url: shareUrl(item) }).catch(() => {});
  };

  const close = act(() => closeShareSheet());

  const draw = () => {
    if (openHost !== host) return;
    const now = Date.now();
    render(
      html`
        <div class="psr-sheet-backdrop" @pointerup=${close} @click=${close}></div>
        <div class="psr-sheet open" role="dialog" aria-modal="true" aria-label=${t('share.title')}>
          <div class="psr-sheet-group ut-surface--floating ut-surface--material">
            <div class="psr-sheet-title question">${t('share.explain')}</div>
            ${
              shares === null
                ? html`<div class="ut-share-row ut-share-muted">${t('share.loading')}</div>`
                : shares.map(
                    (item) => html`
                      <div class="ut-share-row" data-testid="share-link">
                        <div class="ut-share-url">${shareUrl(item)}</div>
                        <div class="ut-share-muted">
                          ${t('share.expiresIn', { time: formatTimeLeft(item.expiresAt - now) })}
                        </div>
                        <div class="ut-share-actions">
                          <button class="ut-surface--control" data-testid="share-copy" @pointerup=${act(() => void copy(item))} @click=${act(() => void copy(item))}>
                            ${copied === item.token ? t('share.copied') : t('share.copy')}
                          </button>
                          ${
                            canNativeShare
                              ? html`<button class="ut-surface--control" data-testid="share-native" @pointerup=${act(() => nativeShare(item))} @click=${act(() => nativeShare(item))}>
                                  ${t('share.share')}
                                </button>`
                              : nothing
                          }
                          <button class="ut-share-danger ut-surface--control" data-testid="share-revoke" ?disabled=${revoking.has(item.token)} @pointerup=${act(() => void revoke(item))} @click=${act(() => void revoke(item))}>
                            ${t('share.revoke')}
                          </button>
                        </div>
                      </div>
                    `
                  )
            }
            <div class="ut-share-row">
              <div class="ut-share-muted">${t('share.newLink')}</div>
              <div class="ut-share-actions">
                ${SHARE_DURATIONS_MIN.map(
                  (minutes) => html`
                    <button class="ut-surface--control" data-testid="share-create-${minutes}" ?disabled=${busy} @pointerup=${act(() => void create(minutes))} @click=${act(() => void create(minutes))}>
                      ${t(minutes === 15 ? 'share.d15' : minutes === 60 ? 'share.d60' : 'share.d480')}
                    </button>
                  `
                )}
              </div>
              ${error ? html`<div class="ut-share-error" role="alert">${error}</div>` : nothing}
            </div>
          </div>
          <button class="psr-sheet-cancel ut-surface--floating ut-surface--material" @pointerup=${close} @click=${close}>${t('common.close')}</button>
        </div>
      `,
      host
    );
  };

  draw();
  releaseFocus = holdSheetFocus(host.querySelector<HTMLElement>('.psr-sheet'), () =>
    closeShareSheet()
  );
  // "Caduca en …" stays current while the sheet is open.
  ticker = setInterval(draw, 30_000);
  void load();
}
