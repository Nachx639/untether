// @vitest-environment happy-dom

import { fixture, html } from '@open-wc/testing';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

const push = vi.hoisted(() => ({
  supported: true,
  subscribed: false,
  permission: 'default' as NotificationPermission,
}));

vi.mock('../services/push-notification-service.js', () => ({
  pushNotificationService: {
    whenInitialized: vi.fn(async () => {}),
    isSupported: vi.fn(() => push.supported),
    isSubscribed: vi.fn(() => push.subscribed),
    getPermission: vi.fn(() => push.permission),
    requestPermission: vi.fn(async () => push.permission),
    loadPreferences: vi.fn(async () => ({ enabled: false })),
    getRecommendedPreferences: vi.fn(() => ({ enabled: true, sessionExit: true })),
    subscribe: vi.fn(async () => ({ endpoint: 'https://push.example', keys: {} })),
    savePreferences: vi.fn(async () => {}),
    sendTestNotification: vi.fn(async () => {}),
    onPermissionChange: vi.fn(() => () => {}),
    onSubscriptionChange: vi.fn(() => () => {}),
  },
}));
vi.mock('./notification-status.js', () => ({}));

import { pushNotificationService } from '../services/push-notification-service.js';
import type { FullHeader } from './full-header.js';
import './full-header.js';
import {
  closeNotifyInstallSheet,
  NOTIFY_BANNER_DISMISS_KEY,
  NOTIFY_BANNER_LAST_KEY,
  type NotificationsBanner,
} from './notifications-banner.js';

const SAFARI_IOS =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const CHROME_IOS =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.90 Mobile/15E148 Safari/604.1';
const ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';

function setDevice({
  phone = true,
  standalone = false,
  ua = SAFARI_IOS,
}: {
  phone?: boolean;
  standalone?: boolean;
  ua?: string;
}) {
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: query.includes('coarse')
          ? phone
          : query.includes('standalone')
            ? standalone
            : false,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList
  );
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: phone ? 390 : 1440 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: phone ? 844 : 900 });
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ua);
}

async function mountBanner(compact = false) {
  const banner = await fixture<NotificationsBanner>(
    html`<notifications-banner ?compact=${compact}></notifications-banner>`
  );
  // Let whenInitialized() resolve and the banner decide.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await banner.updateComplete;
  return banner;
}

const bannerEl = (root: ParentNode) =>
  root.querySelector<HTMLElement>('[data-testid="notify-banner"]');

describe('notifications-banner', () => {
  beforeEach(() => {
    // The shared test setup mocks localStorage with no-op spies; this needs a working one.
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, String(value)),
      removeItem: (key: string) => store.delete(key),
      clear: () => store.clear(),
    });
    push.supported = true;
    push.subscribed = false;
    push.permission = 'default';
    vi.mocked(pushNotificationService.requestPermission).mockClear();
    vi.mocked(pushNotificationService.subscribe).mockClear();
    vi.mocked(pushNotificationService.savePreferences).mockClear();
    vi.mocked(pushNotificationService.sendTestNotification).mockClear();
  });

  afterEach(() => {
    closeNotifyInstallSheet();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('offers to turn notifications on in the installed app', async () => {
    setDevice({ standalone: true });
    const banner = await mountBanner();
    expect(bannerEl(banner)?.dataset.mode).toBe('enable');
    expect(banner.querySelector('[data-testid="notify-banner-enable"]')?.textContent?.trim()).toBe(
      'Turn on'
    );
  });

  it('shows at once, before the service is ready, when it showed last time', async () => {
    setDevice({ standalone: true });
    localStorage.setItem(NOTIFY_BANNER_LAST_KEY, 'enable');
    vi.mocked(pushNotificationService.whenInitialized).mockReturnValueOnce(new Promise(() => {}));
    const banner = await mountBanner();
    expect(bannerEl(banner)?.dataset.mode).toBe('enable');
  });

  it('does not flash before the service is ready on a device that had it off', async () => {
    setDevice({ standalone: true });
    localStorage.setItem(NOTIFY_BANNER_LAST_KEY, 'none');
    vi.mocked(pushNotificationService.whenInitialized).mockReturnValueOnce(new Promise(() => {}));
    const banner = await mountBanner();
    expect(bannerEl(banner)).toBeNull();
  });

  it("remembers the service's answer for the next start", async () => {
    setDevice({ standalone: true });
    await mountBanner();
    expect(localStorage.getItem(NOTIFY_BANNER_LAST_KEY)).toBe('enable');
    push.subscribed = true;
    await mountBanner();
    expect(localStorage.getItem(NOTIFY_BANNER_LAST_KEY)).toBe('none');
  });

  it('turns them on from the button, asking permission inside the tap', async () => {
    setDevice({ standalone: true });
    push.permission = 'granted';
    const banner = await mountBanner();
    banner.querySelector<HTMLButtonElement>('[data-testid="notify-banner-enable"]')?.click();
    // Asked synchronously, while the tap is still a user gesture.
    expect(pushNotificationService.requestPermission).toHaveBeenCalledOnce();

    await vi.waitFor(() => expect(pushNotificationService.savePreferences).toHaveBeenCalled());
    expect(pushNotificationService.subscribe).toHaveBeenCalledOnce();
    expect(vi.mocked(pushNotificationService.savePreferences).mock.calls[0][0]).toMatchObject({
      enabled: true,
    });
    await banner.updateComplete;
    expect(banner.textContent).toContain('Turned on ✓');
  });

  it('explains where to allow them when permission is denied', async () => {
    setDevice({ standalone: true });
    push.permission = 'denied';
    const banner = await mountBanner();
    expect(banner.querySelector('[data-testid="notify-banner-enable"]')).toBeNull();
    expect(banner.textContent).toContain('iPhone Settings > Notifications > Untether');
  });

  it('in a Safari tab, explains the Home Screen and shows Safari steps', async () => {
    setDevice({ ua: SAFARI_IOS });
    push.supported = false;
    const banner = await mountBanner();
    expect(bannerEl(banner)?.dataset.mode).toBe('install');

    banner.querySelector<HTMLButtonElement>('[data-testid="notify-banner-how"]')?.click();
    const sheet = document.querySelector<HTMLElement>('[data-testid="notify-install-sheet"]');
    expect(sheet?.dataset.browser).toBe('safari');
    const steps = [...(sheet?.querySelectorAll('.nb-step-text') ?? [])].map((s) =>
      s.textContent?.trim()
    );
    expect(steps[0]).toContain("Safari's toolbar");
    expect(steps).toHaveLength(4);
    await (
      sheet?.querySelector('app-address-copy') as HTMLElement & { updateComplete: Promise<unknown> }
    )?.updateComplete;
    expect(sheet?.querySelector('[data-testid="app-address-value"]')?.textContent).toBe(
      window.location.origin
    );
  });

  it('in a Chrome tab on iOS, shows Chrome steps and the Safari fallback', async () => {
    setDevice({ ua: CHROME_IOS });
    push.supported = false;
    const banner = await mountBanner();
    expect(bannerEl(banner)?.dataset.mode).toBe('install');

    banner.querySelector<HTMLButtonElement>('[data-testid="notify-banner-how"]')?.click();
    const sheet = document.querySelector<HTMLElement>('[data-testid="notify-install-sheet"]');
    expect(sheet?.dataset.browser).toBe('chrome');
    expect(sheet?.querySelector('.nb-step-text')?.textContent).toContain('address bar');
    await (
      sheet?.querySelector('app-address-copy') as HTMLElement & { updateComplete: Promise<unknown> }
    )?.updateComplete;
    expect(sheet?.textContent).toContain('open it in Safari');
  });

  it('hides once notifications are on', async () => {
    setDevice({ standalone: true });
    push.subscribed = true;
    const banner = await mountBanner();
    expect(bannerEl(banner)).toBeNull();
  });

  it('stays hidden after ✕ until the dismissal expires', async () => {
    setDevice({ standalone: true });
    const banner = await mountBanner();
    banner.querySelector<HTMLButtonElement>('[data-testid="notify-banner-dismiss"]')?.click();
    await banner.updateComplete;
    expect(bannerEl(banner)).toBeNull();
    const until = Number(localStorage.getItem(`${NOTIFY_BANNER_DISMISS_KEY}-enable`));
    expect(until - Date.now()).toBeGreaterThan(13 * 24 * 3600 * 1000);

    const again = await mountBanner();
    expect(bannerEl(again)).toBeNull();

    localStorage.setItem(`${NOTIFY_BANNER_DISMISS_KEY}-enable`, String(Date.now() - 1));
    const expired = await mountBanner();
    expect(bannerEl(expired)).not.toBeNull();
  });

  it('never shows on desktop, nor where push is unsupported outside iOS', async () => {
    setDevice({ phone: false, ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' });
    expect(bannerEl(await mountBanner())).toBeNull();

    vi.restoreAllMocks();
    setDevice({ ua: ANDROID });
    push.supported = false;
    expect(bannerEl(await mountBanner())).toBeNull();
  });

  it('adds "Test notifications" to the phone More menu once subscribed', async () => {
    setDevice({ standalone: true });
    vi.useFakeTimers({ toFake: ['Date'] });
    // Also when an assertion in between fails: the next test gets the real clock.
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const menuItems = async () => {
      const header = await fixture<FullHeader>(html`<full-header></full-header>`);
      header.querySelector<HTMLButtonElement>('[data-testid="phone-header-more"]')?.click();
      await header.updateComplete;
      const item = [...document.body.querySelectorAll<HTMLButtonElement>('.psr-sheet-item')].find(
        (b) => b.textContent?.includes('Test notifications')
      );
      return { header, item };
    };

    expect((await menuItems()).item).toBeUndefined();
    document.body.querySelector<HTMLButtonElement>('.psr-sheet-cancel')?.click();

    push.subscribed = true;
    const { item } = await menuItems();
    expect(item).toBeTruthy();
    vi.setSystemTime(Date.now() + 1000); // past the guard of the tap that opened the sheet
    item?.click();
    vi.useRealTimers();
    expect(pushNotificationService.sendTestNotification).toHaveBeenCalledOnce();
    // The result goes to the app's one toast stack (utils/action-toast.ts), 2026-10-12.
    await vi.waitFor(() => {
      expect(document.querySelector('.ut-toast-stack .ut-toast')?.textContent).toContain(
        'Test notification sent'
      );
    });
    document.querySelector('.ut-toast-stack')?.remove();
  });

  // 2026-10-04: three lines on an iPhone SE, above the sessions. One line everywhere since
  // 2026-10-12, below the sessions: bell icon, "Get notifications", a text button, ✕.
  describe('one line', () => {
    it('turning on: short text, a text button and ✕ in the same row', async () => {
      setDevice({ standalone: true });
      const banner = await mountBanner(true);
      const root = bannerEl(banner);
      expect(root?.classList.contains('nb-one-line')).toBe(true);
      const row = root?.querySelector('.nb-row');
      expect(row?.querySelector('.nb-icon svg')).not.toBeNull();
      expect(row?.querySelector('.nb-text')?.textContent?.trim()).toBe('Turn on notifications');
      const enable = row?.querySelector<HTMLButtonElement>('[data-testid="notify-banner-enable"]');
      expect(enable?.textContent?.trim()).toBe('Turn on');
      expect(row?.querySelector('[data-testid="notify-banner-dismiss"]')).not.toBeNull();
      expect(root?.children.length).toBe(1);
      enable?.click();
      expect(pushNotificationService.requestPermission).toHaveBeenCalledOnce();
    });

    it('the iPhone install hint has "How" beside it', async () => {
      setDevice({ standalone: false });
      const root = bannerEl(await mountBanner(true));
      expect(root?.dataset.mode).toBe('install');
      expect(root?.classList.contains('nb-one-line')).toBe(true);
      expect(root?.querySelector('.nb-row [data-testid="notify-banner-how"]')).not.toBeNull();
    });

    it('never draws an emoji', async () => {
      setDevice({ standalone: true });
      const root = bannerEl(await mountBanner());
      expect(root?.textContent).not.toMatch(/\p{Extended_Pictographic}/u);
    });
  });
});
