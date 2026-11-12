/**
 * "What's new" (phones): a sheet of short cards for the phone features that live behind
 * gestures and menus. It opens by itself once per WHATS_NEW_VERSION, a moment after the
 * session list first shows, and again from the list header's ⋯ menu.
 *
 * Rendered into <body> like the other phone sheets: position:fixed inside a transformed
 * ancestor would be fixed to that ancestor instead of the screen.
 */

import { html, nothing, render } from 'lit';
import { type MessageKey, t } from '../i18n/index.js';
import { swallowNextClick } from '../utils/ghost-click.js';
import { attachSheetDrag, isPhoneScreen } from '../utils/mobile-utils.js';
import { holdSheetFocus } from '../utils/sheet-a11y.js';
import { type IconName, icon } from './icons.js';

/**
 * Bump when the cards change so phones see the sheet once more. A card added with a newer
 * `since` is all a phone that saw an earlier version is shown by itself (2026-10-03b).
 */
export const WHATS_NEW_VERSION = '2026-10-03g';
export const WHATS_NEW_STORAGE_KEY = 'ut-whats-new-seen';
/** Delay between the session list first showing and the sheet opening by itself. */
export const WHATS_NEW_DELAY_MS = 1500;

/** The click that finishes the gesture that opened the sheet must not hit its buttons. */
const OPEN_GUARD_MS = 500;
const TAP_SLOP_PX = 10;
/** Cards shown before "See all updates (n)" (phone-spec §4.4, 2026-10-12). */
export const WHATS_NEW_SHOWN = 3;

/** Icons are icons.ts glyphs on neutral tiles (no emoji in chrome, phone-spec §4.4). */
const CARDS: ReadonlyArray<{ icon: IconName; key: string; since?: string }> = [
  { icon: 'monitor', key: 'macSessions', since: '2026-10-03g' },
  { icon: 'messageSquare', key: 'answerFromAgents', since: '2026-10-03f' },
  { icon: 'search', key: 'whatYouApprove', since: '2026-10-03e' },
  { icon: 'pencil', key: 'safeReplies', since: '2026-10-03e' },
  { icon: 'external', key: 'previewServers', since: '2026-10-03d' },
  { icon: 'terminalStack', key: 'tmuxNames', since: '2026-10-03d' },
  { icon: 'gitBranch', key: 'pushAfterCommit', since: '2026-10-03d' },
  { icon: 'check', key: 'quickStartAvail', since: '2026-10-03d' },
  { icon: 'circleCheck', key: 'menuButtons', since: '2026-10-03c' },
  { icon: 'folderOpen', key: 'anyFolder', since: '2026-10-03c' },
  { icon: 'fileText', key: 'readable', since: '2026-10-03b' },
  { icon: 'shield', key: 'shield' },
  { icon: 'lock', key: 'share' },
  { icon: 'sparkles', key: 'agents' },
  { icon: 'clock', key: 'tasks' },
  { icon: 'eye', key: 'previews' },
  { icon: 'mic', key: 'ask' },
  { icon: 'history', key: 'history' },
  { icon: 'list', key: 'switch' },
  { icon: 'pin', key: 'rows' },
  { icon: 'files', key: 'changes' },
  { icon: 'clipboard', key: 'select' },
  { icon: 'chat', key: 'chat' },
  { icon: 'keyboard', key: 'keys' },
  { icon: 'image', key: 'photos' },
  { icon: 'palette', key: 'appearance' },
  { icon: 'restart', key: 'offline' },
];

// Moved to utils/mobile-utils.ts (2026-10-12); kept as a re-export for existing imports.
export { isPhoneScreen };

function seenVersion(): string | null {
  try {
    return localStorage.getItem(WHATS_NEW_STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * The cards to show: on a phone that saw an earlier version, only those added since (a
 * whole tour again for one new card was a nag); otherwise, and from the menu, all of them.
 */
export function whatsNewCards(seen: string | null, onlyNew: boolean): typeof CARDS {
  if (!onlyNew || !seen) return CARDS;
  const fresh = CARDS.filter((card) => card.since !== undefined && card.since > seen);
  return fresh.length > 0 ? fresh : CARDS;
}

export function markWhatsNewSeen(): void {
  try {
    localStorage.setItem(WHATS_NEW_STORAGE_KEY, WHATS_NEW_VERSION);
  } catch {
    // Private mode or storage blocked: the sheet may show again, which is harmless.
  }
}

/** Whether the sheet should open by itself: a phone that has not seen this version. */
export function shouldAutoShowWhatsNew(): boolean {
  return isPhoneScreen() && seenVersion() !== WHATS_NEW_VERSION;
}

/**
 * Something the sheet must not cover: another dialog or sheet (settings, history, row
 * actions, a modal-wrapper dialog…), the notifications banner, or a field being typed in
 * (the Ask Claude box, search).
 */
export function whatsNewBlocked(): boolean {
  if (document.querySelector('[aria-modal="true"], .ut-modal-host')) return true;
  const banner = document.querySelector('notifications-banner');
  if (banner && banner.childElementCount > 0 && banner.getBoundingClientRect().height > 0) {
    return true;
  }
  const active = document.activeElement;
  return (
    active instanceof HTMLElement &&
    active.matches('input, textarea, select, [contenteditable=""], [contenteditable="true"]')
  );
}

let openHost: HTMLElement | null = null;
let releaseFocus: (() => void) | null = null;
let detachDrag: (() => void) | null = null;

export function isWhatsNewOpen(): boolean {
  return openHost !== null;
}

export function closeWhatsNew(): void {
  const host = openHost;
  if (!host) return;
  openHost = null;
  render(nothing, host);
  host.remove();
  releaseFocus?.();
  releaseFocus = null;
  detachDrag?.();
  detachDrag = null;
}

export function openWhatsNew(options: { onlyNew?: boolean } = {}): void {
  closeWhatsNew();
  const cards = whatsNewCards(seenVersion(), options.onlyNew ?? false);
  markWhatsNewSeen();
  const opener = document.activeElement;
  const host = document.createElement('div');
  document.body.appendChild(host);
  openHost = host;
  const openedAt = Date.now();

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
  const close = act(closeWhatsNew);

  let showAll = false;
  const expanded = new Set<string>();
  const paint = () => {
    if (openHost !== host) return;
    const visible = showAll ? CARDS : cards.slice(0, WHATS_NEW_SHOWN);
    const hidden = !showAll && CARDS.length > visible.length;
    render(
      html`
        <div class="wn-backdrop" @click=${close}></div>
        <div
          class="wn-sheet ut-surface--floating ut-surface--material ut-surface--fixed"
          role="dialog"
          aria-modal="true"
          aria-labelledby="wn-title"
          data-testid="whats-new"
        >
          <div class="ut-grabber" data-sheet-handle aria-hidden="true"></div>
          <div class="wn-head" data-sheet-handle>
            <h2 id="wn-title" class="wn-title">${t('whatsNew.title')}</h2>
            <p class="wn-subtitle">${t('whatsNew.subtitle')}</p>
          </div>
          <ul class="wn-list">
            ${visible.map(({ icon: glyph, key }) => {
              const open = expanded.has(key);
              return html`
                <li class="wn-card ut-surface--panel ut-surface--material">
                  <span class="wn-icon" aria-hidden="true">${icon(glyph, 20)}</span>
                  <button
                    type="button"
                    class="ut-text-action wn-text ${open ? 'expanded' : ''}"
                    aria-expanded=${open ? 'true' : 'false'}
                    @click=${() => {
                      if (open) expanded.delete(key);
                      else expanded.add(key);
                      paint();
                    }}
                  >
                    <span class="wn-card-title">${t(`whatsNew.${key}.title` as MessageKey)}</span>
                    <span class="wn-card-body">${t(`whatsNew.${key}.body` as MessageKey)}</span>
                  </button>
                </li>
              `;
            })}
            ${
              hidden
                ? html`<li class="wn-all-item">
                    <button
                      type="button"
                      class="ut-text-action wn-all"
                      data-testid="whats-new-all"
                      @click=${() => {
                        showAll = true;
                        paint();
                      }}
                    >
                      <span>${t('phone.whatsNew.all', { n: CARDS.length })}</span>
                      ${icon('chevronDown', 16)}
                    </button>
                  </li>`
                : nothing
            }
          </ul>
          <div class="wn-foot">
            <button
              class="wn-done ut-surface--control"
              data-testid="whats-new-done"
              @pointerdown=${close}
              @pointerup=${close}
              @click=${close}
            >
              ${t('whatsNew.done')}
            </button>
          </div>
        </div>
      `,
      host
    );
  };
  paint();
  const sheet = host.querySelector<HTMLElement>('.wn-sheet');
  releaseFocus = holdSheetFocus(sheet, closeWhatsNew, opener);
  requestAnimationFrame(() => sheet?.classList.add('open'));
  if (sheet) {
    detachDrag = attachSheetDrag(sheet, {
      scroller: sheet.querySelector<HTMLElement>('.wn-list'),
      onDismiss: closeWhatsNew,
    });
  }
}
