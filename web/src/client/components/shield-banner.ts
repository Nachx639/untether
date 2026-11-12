/**
 * "N conversaciones sin blindar · Blindar": the phone list offers to shield the Claude sessions
 * that were started unshielded (before shielding became the default, 2026-10-03). Those die
 * when Untether restarts or updates; shielded, they continue the same conversation in tmux
 * and survive. Only Claude sessions whose conversation is known are offered: they move without
 * losing anything (`claude --resume`), and one in the middle of a turn is left alone. Other
 * programs can't be moved into tmux, so they're not part of this one-tap action.
 * ✕ hides it for 7 days.
 */
import { html, LitElement, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { Session } from '../../shared/types.js';
import { LocaleController, t } from '../i18n/index.js';
import type { AuthClient } from '../services/auth-client.js';
import { serverConfigService } from '../services/server-config-service.js';
import { swallowNextClick } from '../utils/ghost-click.js';
import { endsADrag } from '../utils/pointer-drag.js';
import { canShield, shieldContinuesClaude, shieldSession } from '../utils/shield.js';

export const SHIELD_BANNER_DISMISS_KEY = 'ut-shield-banner-dismissed';
const DISMISS_MS = 7 * 24 * 60 * 60 * 1000;
const SHEET_GUARD_MS = 500;

/** Claude sessions that could be shielded now, and the ones busy in a turn (left alone). */
export function shieldCandidates(sessions: readonly Session[]): {
  ready: Session[];
  busy: Session[];
} {
  const ready: Session[] = [];
  const busy: Session[] = [];
  for (const session of sessions) {
    // Only what its own menu could shield: never one in a terminal window (shielding would close
    // it there) or attached to a tmux session (it would nest a tmux client in the shield).
    if (!canShield(session) || session.attachedViaUT || !shieldContinuesClaude(session)) continue;
    if ((session.claudeStatus?.status ?? 'idle') === 'idle') ready.push(session);
    else busy.push(session);
  }
  return { ready, busy };
}

/** What the list shows for the session: its user or Claude title, else its name. */
function displayName(session: Session): string {
  return session.userTitle || session.claudeStatus?.title || session.name || session.id;
}

function dismissedNow(): boolean {
  try {
    return Date.now() < Number(localStorage.getItem(SHIELD_BANNER_DISMISS_KEY) ?? 0);
  } catch {
    return false;
  }
}

/** Touch acts on pointerup (the click that follows is swallowed); mouse/keyboard on click. */
function tap(fn: () => void) {
  let at = 0;
  return (e: Event) => {
    if (e.type === 'pointerup') {
      if ((e as PointerEvent).pointerType === 'mouse') return;
      // A scroll of the list that started on a button ends here too: not a tap.
      if (endsADrag(e as PointerEvent)) return;
      at = Date.now();
      swallowNextClick();
    } else if (e.type === 'click' && Date.now() - at < 700) {
      return;
    }
    fn();
  };
}

@customElement('shield-banner')
export class ShieldBanner extends LitElement {
  createRenderRoot() {
    return this;
  }

  protected readonly i18n = new LocaleController(this);

  @property({ attribute: false }) sessions: Session[] = [];
  @property({ attribute: false }) authClient?: AuthClient;

  @state() private available = false;
  @state() private dismissed = dismissedNow();
  @state() private sheetOpen = false;
  @state() private working = false;
  @state() private results: Array<{ name: string; ok: boolean; error?: string }> | null = null;
  private sheetOpenedAt = 0;

  connectedCallback() {
    super.connectedCallback();
    void serverConfigService
      .loadConfig()
      .then((config) => {
        this.available = config.shieldAvailable === true;
      })
      .catch(() => {});
  }

  private dismiss = tap(() => {
    try {
      localStorage.setItem(SHIELD_BANNER_DISMISS_KEY, String(Date.now() + DISMISS_MS));
    } catch {
      // Blocked storage: hidden until the page reloads.
    }
    this.dismissed = true;
  });

  private openSheet = tap(() => {
    this.results = null;
    this.sheetOpen = true;
    this.sheetOpenedAt = Date.now();
  });

  private closeSheet = tap(() => {
    if (Date.now() - this.sheetOpenedAt < SHEET_GUARD_MS || this.working) return;
    this.sheetOpen = false;
  });

  private shieldAll = tap(() => {
    if (Date.now() - this.sheetOpenedAt < SHEET_GUARD_MS || this.working) return;
    void this.runShield();
  });

  private async runShield() {
    const { ready } = shieldCandidates(this.sessions);
    this.working = true;
    const results: Array<{ name: string; ok: boolean; error?: string }> = [];
    for (const session of ready) {
      const name = displayName(session);
      try {
        await shieldSession(session.id, this.authClient?.getAuthHeader());
        results.push({ name, ok: true });
      } catch (error) {
        results.push({
          name,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.working = false;
    this.results = results;
    this.dispatchEvent(new CustomEvent('refresh', { bubbles: true, composed: true }));
  }

  render() {
    if (!this.available || this.dismissed) return nothing;
    const { ready, busy } = shieldCandidates(this.sessions);
    const count = ready.length + busy.length;
    if (!count && !this.sheetOpen) return nothing;
    // Once everything is shielded the bar goes; the sheet stays open with the results.
    return html`
      ${count ? this.renderBar(count) : nothing}
      ${this.sheetOpen ? this.renderSheet(ready, busy) : nothing}
    `;
  }

  private renderBar(count: number) {
    return html`
      <div class="ut-shield-banner ut-surface--material ut-surface--detail ut-surface--notice" data-testid="shield-banner" role="status">
        <span class="ut-shield-banner-text">🛡 ${t(count === 1 ? 'shieldBanner.one' : 'shieldBanner.many', { n: count })}</span>
        <button class="ut-shield-banner-action ut-surface--request-action ut-surface--material ut-surface--action ut-surface--primary" data-testid="shield-banner-open" @pointerup=${this.openSheet} @click=${this.openSheet}>
          ${t('shield.shield')}
        </button>
        <button class="ut-shield-banner-close" aria-label=${t('common.close')} data-testid="shield-banner-dismiss" @pointerup=${this.dismiss} @click=${this.dismiss}>×</button>
      </div>
    `;
  }

  private renderSheet(ready: Session[], busy: Session[]) {
    return html`
      <div class="psr-sheet-backdrop" @click=${this.closeSheet}></div>
      <div class="psr-sheet open" role="dialog" aria-modal="true" aria-label=${t('shieldBanner.title')} data-testid="shield-banner-sheet">
        <div class="psr-sheet-group ut-surface--floating ut-surface--material">
          <div class="psr-sheet-title question">${t('shieldBanner.explain')}</div>
          ${
            this.results
              ? this.results.map(
                  (r) =>
                    html`<div class="ut-shield-row">${r.ok ? '✓' : '✗'} ${r.name}${r.error ? html` <span class="ut-shield-error">— ${r.error}</span>` : nothing}</div>`
                )
              : html`
                  ${ready.map((s) => html`<div class="ut-shield-row">🛡 ${displayName(s)}</div>`)}
                  ${busy.map((s) => html`<div class="ut-shield-row ut-shield-busy">⏳ ${displayName(s)} · ${t('shieldBanner.busy')}</div>`)}
                  ${
                    ready.length
                      ? html`<button data-testid="shield-banner-confirm" ?disabled=${this.working} @pointerup=${this.shieldAll} @click=${this.shieldAll}>
                          ${this.working ? t('shieldBanner.working') : t(ready.length === 1 ? 'shieldBanner.confirmOne' : 'shieldBanner.confirmMany', { n: ready.length })}
                        </button>`
                      : nothing
                  }
                `
          }
        </div>
        <button class="psr-sheet-cancel ut-surface--floating ut-surface--material" @pointerup=${this.closeSheet} @click=${this.closeSheet}>
          ${this.results ? t('common.close') : t('common.cancel')}
        </button>
      </div>
    `;
  }
}
