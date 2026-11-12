/**
 * "Add Untether to the Home Screen" steps, shared by Settings and the notifications
 * banner's sheet, worded for the browser in use. Also the app address with a Copy button, so
 * someone in Chrome without "Add to Home Screen" can paste it into Safari.
 */
import { html, LitElement, type SVGTemplateResult, svg } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { LocaleController, t } from '../i18n/index.js';
import { swallowNextClick } from '../utils/ghost-click.js';
import type { IOSBrowser } from '../utils/ios-install.js';
import { copyToClipboard } from '../utils/path-utils.js';

const TAP_SLOP_PX = 10;
const OPEN_GUARD_MS = 500;

/**
 * Touch acts on pointerup (iOS can take the first tap on a fresh button as a hover and send
 * no click); the click that follows is swallowed. Mouse and keyboard use the click. With
 * `openedAt`, nothing acts in the first moments after a sheet opened.
 */
export function tapHandler(fn: () => void, openedAt = 0) {
  let touchActedAt = 0;
  let down: { x: number; y: number } | null = null;
  return {
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
  };
}

export const INSTALL_STEP_ICONS = {
  // Share glyph: square with an arrow pointing up.
  share: svg`<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 3v12m0-12L8 7m4-4l4 4M8 11H6a1 1 0 00-1 1v8a1 1 0 001 1h12a1 1 0 001-1v-8a1 1 0 00-1-1h-2" />`,
  // "Add to Home Screen" glyph: plus in a rounded square.
  add: svg`<rect x="4" y="4" width="16" height="16" rx="3" stroke-width="2" /><path stroke-linecap="round" stroke-width="2" d="M12 8v8m-4-4h8" />`,
  // App icon on a Home Screen.
  open: svg`<rect x="5" y="2" width="14" height="20" rx="3" stroke-width="2" /><rect x="9" y="7" width="6" height="6" rx="1.5" stroke-width="2" />`,
  bell: svg`<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 17h5l-1.4-1.4A2 2 0 0118 14.2V11a6 6 0 00-4-5.7V5a2 2 0 10-4 0v.3A6 6 0 006 11v3.2a2 2 0 01-.6 1.4L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />`,
};

export interface InstallStep {
  icon: SVGTemplateResult;
  text: string;
}

/**
 * The steps for this browser. `settings` ends with "turn notifications on here"; `banner`
 * ends with opening the app and tapping the banner's button.
 */
export function iosInstallSteps(browser: IOSBrowser, ending: 'settings' | 'banner'): InstallStep[] {
  const share =
    browser === 'chrome'
      ? t('notifyBanner.step.shareChrome')
      : browser === 'other'
        ? t('notifyBanner.step.shareOther')
        : t('notifyBanner.step.shareSafari');
  const add = browser === 'safari' ? t('settings.ios.step.add') : t('notifyBanner.step.addChrome');
  const steps: InstallStep[] = [
    { icon: INSTALL_STEP_ICONS.share, text: share },
    { icon: INSTALL_STEP_ICONS.add, text: add },
  ];
  if (ending === 'settings') {
    steps.push({ icon: INSTALL_STEP_ICONS.bell, text: t('settings.ios.step.open') });
  } else {
    steps.push(
      { icon: INSTALL_STEP_ICONS.open, text: t('notifyBanner.step.open') },
      { icon: INSTALL_STEP_ICONS.bell, text: t('notifyBanner.step.enable') }
    );
  }
  return steps;
}

/** The address to open in Safari: where this page is served from. */
export function appAddress(): string {
  return window.location.origin;
}

/**
 * The app address and a Copy button. Outside Safari it is introduced as the way out when the
 * browser has no "Add to Home Screen".
 */
@customElement('app-address-copy')
export class AppAddressCopy extends LitElement {
  createRenderRoot() {
    return this;
  }

  protected readonly i18n = new LocaleController(this);

  /** Browser in use; anything but Safari gets the "open it in Safari" hint. */
  @property({ attribute: false }) browser: IOSBrowser = 'safari';
  @state() private copied: 'ok' | 'failed' | null = null;

  private copy = tapHandler(() => {
    void copyToClipboard(appAddress()).then((ok) => {
      this.copied = ok ? 'ok' : 'failed';
    });
  });

  render() {
    return html`
      <div class="nb-address" data-testid="app-address">
        <p class="nb-address-label">
          ${this.browser === 'safari' ? t('notifyBanner.address.label') : t('notifyBanner.safariHint')}
        </p>
        <div class="nb-address-row">
          <code class="nb-address-value" data-testid="app-address-value">${appAddress()}</code>
          <button
            class="ut-surface--control nb-address-copy"
            data-testid="app-address-copy"
            @pointerdown=${this.copy}
            @pointerup=${this.copy}
            @click=${this.copy}
          >
            ${this.copied === 'ok' ? t('notifyBanner.address.copied') : t('notifyBanner.address.copy')}
          </button>
        </div>
        ${
          this.copied === 'failed'
            ? html`<p class="nb-status err" role="status">${t('notifyBanner.address.copyFailed')}</p>`
            : ''
        }
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'app-address-copy': AppAddressCopy;
  }
}
