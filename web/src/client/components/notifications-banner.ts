/**
 * Notifications banner (phones): one line below the phone session list (2026-10-12) that
 * makes push notifications easy to turn on. The switch in Settings was too hidden to find
 * on an iPhone (2026-10-02).
 *
 * - Push available (installed web app on iOS, or any phone browser that supports it) and not
 *   subscribed: "Turn on notifications" runs the same enable path as Settings.
 * - iPhone in a browser tab: iOS only allows web push once Untether is on the Home Screen
 *   and opened from there, so the banner explains that, with a "How" sheet of steps for
 *   Safari or Chrome.
 * - Subscribed, desktop, or no push and not iOS: nothing.
 *
 * ✕ hides it for a while (localStorage), so it is not a nag.
 */
import { html, LitElement, nothing, render } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { LocaleController, t } from '../i18n/index.js';
import { pushNotificationService } from '../services/push-notification-service.js';
import { iosBrowser, isIOSDevice, needsIOSHomeScreenInstall } from '../utils/ios-install.js';
import { holdSheetFocus } from '../utils/sheet-a11y.js';
import { icon } from './icons.js';
import { iosInstallSteps, tapHandler } from './ios-install-steps.js';
import { isPhoneScreen } from './whats-new-sheet.js';

export type NotifyBannerMode = 'enable' | 'install';

export const NOTIFY_BANNER_DISMISS_KEY = 'ut-notify-banner-dismissed';
const DAY_MS = 24 * 60 * 60 * 1000;
export const NOTIFY_BANNER_DISMISS_MS: Record<NotifyBannerMode, number> = {
  enable: 14 * DAY_MS,
  install: 30 * DAY_MS,
};
/** How long "Turned on ✓" stays before the banner goes away. */
const DONE_LINGER_MS = 2500;

function dismissKey(mode: NotifyBannerMode): string {
  return `${NOTIFY_BANNER_DISMISS_KEY}-${mode}`;
}

function isDismissed(mode: NotifyBannerMode): boolean {
  try {
    const until = Number(localStorage.getItem(dismissKey(mode)));
    return Number.isFinite(until) && until > Date.now();
  } catch {
    return false;
  }
}

function rememberDismiss(mode: NotifyBannerMode): void {
  try {
    localStorage.setItem(dismissKey(mode), String(Date.now() + NOTIFY_BANNER_DISMISS_MS[mode]));
  } catch {
    // Storage blocked: the banner may come back next visit, which is harmless.
  }
}

/** What the banner decided last time the push service knew the answer. */
export const NOTIFY_BANNER_LAST_KEY = 'ut-notify-banner-last';

function lastDecisionWasEnable(): boolean {
  try {
    return localStorage.getItem(NOTIFY_BANNER_LAST_KEY) === 'enable';
  } catch {
    return false;
  }
}

function rememberDecision(mode: NotifyBannerMode | null): void {
  try {
    localStorage.setItem(NOTIFY_BANNER_LAST_KEY, mode ?? 'none');
  } catch {
    // Storage blocked: the banner just waits for the service, as before.
  }
}

/** Which banner (if any) this device should see right now. */
export function notifyBannerMode(serviceReady = true): NotifyBannerMode | null {
  if (!isPhoneScreen()) return null;
  let mode: NotifyBannerMode | null = null;
  // Any iOS browser tab, whatever isSupported() says: push only works from the Home Screen.
  if (needsIOSHomeScreenInstall()) {
    mode = 'install';
  } else if (
    pushNotificationService.isSupported() &&
    // Until the service knows whether this device is subscribed (seconds, in the installed
    // app) go by last time's answer: appearing late, the banner pushed the list down under
    // the finger, and a tap meant for a session opened the preview above it (2026-10-03).
    (serviceReady ? !pushNotificationService.isSubscribed() : lastDecisionWasEnable())
  ) {
    mode = 'enable';
  }
  return mode && !isDismissed(mode) ? mode : null;
}

let openHost: HTMLElement | null = null;
let releaseFocus: (() => void) | null = null;

export function closeNotifyInstallSheet(): void {
  const host = openHost;
  if (!host) return;
  openHost = null;
  render(nothing, host);
  host.remove();
  releaseFocus?.();
  releaseFocus = null;
}

/** Step-by-step "add to Home Screen" sheet, in <body> like the other phone sheets. */
export function openNotifyInstallSheet(): void {
  closeNotifyInstallSheet();
  const opener = document.activeElement;
  const host = document.createElement('div');
  document.body.appendChild(host);
  openHost = host;
  const close = tapHandler(closeNotifyInstallSheet, Date.now());
  const browser = iosBrowser();
  const steps = iosInstallSteps(browser, 'banner');

  render(
    html`
      <div class="wn-backdrop" @click=${close}></div>
      <div
        class="wn-sheet nb-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="nb-title"
        data-testid="notify-install-sheet"
        data-browser=${browser}
      >
        <div class="wn-head">
          <div>
            <h2 id="nb-title" class="wn-title">${t('notifyBanner.sheet.title')}</h2>
            <p class="wn-subtitle">${t('notifyBanner.sheet.subtitle')}</p>
          </div>
          <button
            class="ut-surface--control wn-x"
            aria-label=${t('common.close')}
            data-testid="notify-install-x"
            @pointerdown=${close}
            @pointerup=${close}
            @click=${close}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              stroke-width="2.2" stroke-linecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
        <div class="wn-list">
          <ol class="nb-steps">
            ${steps.map(
              (step, index) => html`
                <li class="nb-step">
                  <span class="nb-step-num" aria-hidden="true">${index + 1}</span>
                  <svg class="nb-step-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"
                    aria-hidden="true">${step.icon}</svg>
                  <span class="nb-step-text">${step.text}</span>
                </li>
              `
            )}
          </ol>
          <app-address-copy .browser=${browser}></app-address-copy>
        </div>
        <div class="wn-foot">
          <button
            class="ut-surface--control wn-done"
            data-testid="notify-install-done"
            @pointerdown=${close}
            @pointerup=${close}
            @click=${close}
          >
            ${t('notifyBanner.sheet.done')}
          </button>
        </div>
      </div>
    `,
    host
  );
  const sheet = host.querySelector<HTMLElement>('.wn-sheet');
  releaseFocus = holdSheetFocus(sheet, closeNotifyInstallSheet, opener);
  requestAnimationFrame(() => sheet?.classList.add('open'));
}

type EnableResult = { kind: 'done' } | { kind: 'denied' } | { kind: 'failed'; error: string };

@customElement('notifications-banner')
export class NotificationsBanner extends LitElement {
  createRenderRoot() {
    return this;
  }

  protected readonly i18n = new LocaleController(this);

  /**
   * Kept as an attribute for the session list; the banner is always one line now (phone-spec
   * 4.1, 2026-10-12): it took three lines on an iPhone SE (2026-10-04), above the sessions.
   */
  @property({ type: Boolean }) compact = true;

  @state() private mode: NotifyBannerMode | null = null;
  @state() private busy = false;
  @state() private result: EnableResult | null = null;

  private serviceReady = false;
  private unsubscribe: (() => void) | null = null;
  private lingerTimer: ReturnType<typeof setTimeout> | null = null;

  connectedCallback() {
    super.connectedCallback();
    const offSubscription = pushNotificationService.onSubscriptionChange(() => this.refresh());
    const offPermission = pushNotificationService.onPermissionChange(() => this.refresh());
    this.unsubscribe = () => {
      offSubscription();
      offPermission();
    };
    // "Turn on" waits until the service knows whether this device is already subscribed, so
    // an installed app that is already on does not flash the banner.
    this.refresh();
    void pushNotificationService.whenInitialized().then(() => {
      this.serviceReady = true;
      this.refresh();
    });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.lingerTimer) clearTimeout(this.lingerTimer);
    this.lingerTimer = null;
  }

  private refresh() {
    // Keep "Turned on ✓" visible for a moment even though the device is now subscribed.
    if (this.result?.kind === 'done') return;
    this.mode = notifyBannerMode(this.serviceReady);
    if (this.serviceReady) rememberDecision(this.mode);
  }

  private dismiss = tapHandler(() => {
    if (this.mode) rememberDismiss(this.mode);
    this.mode = null;
  });

  private openHow = tapHandler(() => openNotifyInstallSheet());

  /**
   * Click, not pointerup: iOS only shows the permission prompt from a user gesture, and
   * Notification.requestPermission() is reached synchronously from this handler (the first
   * await inside requestPermission() is that call).
   */
  private handleEnable = () => {
    if (this.busy) return;
    this.busy = true;
    this.result = null;
    const permission = pushNotificationService.requestPermission();
    void this.finishEnable(permission);
  };

  private async finishEnable(permissionRequest: Promise<NotificationPermission>) {
    try {
      const permission = await permissionRequest;
      if (permission !== 'granted') {
        this.result = { kind: 'denied' };
        return;
      }
      // Same as the Settings switch: first time on gets the recommended preferences.
      const current = await pushNotificationService.loadPreferences();
      const preferences = current.enabled
        ? current
        : pushNotificationService.getRecommendedPreferences();
      const subscription = await pushNotificationService.subscribe();
      if (!subscription) throw new Error(t('settings.error.subscribe'));
      await pushNotificationService.savePreferences({ ...preferences, enabled: true });
      this.result = { kind: 'done' };
      this.lingerTimer = setTimeout(() => {
        this.lingerTimer = null;
        this.result = null;
        this.refresh();
      }, DONE_LINGER_MS);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.result = /denied/i.test(message)
        ? { kind: 'denied' }
        : { kind: 'failed', error: message };
    } finally {
      this.busy = false;
    }
  }

  private renderCloseButton() {
    return html`
      <button
        class="ut-surface--control nb-x"
        aria-label=${t('notifyBanner.dismiss')}
        data-testid="notify-banner-dismiss"
        @pointerdown=${this.dismiss}
        @pointerup=${this.dismiss}
        @click=${this.dismiss}
      >
        ${icon('x', 16)}
      </button>
    `;
  }

  /**
   * One line below the sessions: the bell, "Activa los avisos", a text button ("Activar" or
   * "Cómo") and a 44 px ✕, on the secondary background. A result (on, denied, failed) is one
   * short line under it.
   */
  private renderEnable() {
    const result = this.result;
    const denied =
      result?.kind === 'denied' ||
      (!result && pushNotificationService.getPermission() === 'denied');
    let status: unknown = nothing;
    if (result?.kind === 'done') {
      status = html`<p class="nb-status ok" role="status">${t('notifyBanner.enable.done')}</p>`;
    } else if (denied) {
      const text = isIOSDevice()
        ? t('notifyBanner.enable.denied')
        : t('notifyBanner.enable.deniedOther');
      status = html`<p class="nb-status err" role="status">${text}</p>`;
    } else if (result?.kind === 'failed') {
      status = html`<p class="nb-status err" role="status">
        ${t('notifyBanner.enable.failed', { error: result.error })}
      </p>`;
    }
    const offer = result?.kind !== 'done' && !denied;
    return html`
      <div class="ut-surface--panel nb-banner nb-one-line" data-testid="notify-banner" data-mode="enable">
        <div class="nb-row">
          <span class="nb-icon" aria-hidden="true">${icon('bell', 18)}</span>
          <p class="nb-text" title=${t('notifyBanner.enable.title')}>${t('phone.notifications.short')}</p>
          ${
            offer
              ? html`<button
                  class="ut-surface--control nb-how"
                  data-testid="notify-banner-enable"
                  ?disabled=${this.busy}
                  @click=${this.handleEnable}
                >
                  ${this.busy ? t('notifyBanner.enable.busy') : t('notifyBanner.enable.buttonShort')}
                </button>`
              : nothing
          }
          ${this.renderCloseButton()}
        </div>
        ${status}
      </div>
    `;
  }

  private renderInstall() {
    return html`
      <div class="ut-surface--panel nb-banner nb-one-line" data-testid="notify-banner" data-mode="install">
        <div class="nb-row">
          <span class="nb-icon" aria-hidden="true">${icon('bell', 18)}</span>
          <p class="nb-text" title=${t('notifyBanner.install.title')}>${t('phone.notifications.short')}</p>
          <button
            class="ut-surface--control nb-how"
            data-testid="notify-banner-how"
            @pointerdown=${this.openHow}
            @pointerup=${this.openHow}
            @click=${this.openHow}
          >
            ${t('notifyBanner.install.how')}
          </button>
          ${this.renderCloseButton()}
        </div>
      </div>
    `;
  }

  render() {
    if (this.mode === 'enable') return this.renderEnable();
    if (this.mode === 'install') return this.renderInstall();
    return nothing;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'notifications-banner': NotificationsBanner;
  }
}
