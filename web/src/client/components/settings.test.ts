// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { restoreLocalStorage, setupLocalStorageMock } from '../../test/utils/component-helpers.js';

const push = vi.hoisted(() => ({
  supported: true,
  started: Promise.resolve(),
  enabled: false,
  permission: false,
  subscription: null as { endpoint: string } | null,
  forceRefresh: vi.fn(async () => {}),
  save: vi.fn(async (_prefs: unknown) => {}),
}));
const updateConfig = vi.hoisted(() => vi.fn(async (_updates: unknown) => {}));
const serverConfig = vi.hoisted(() => ({
  current: { repositoryBasePath: '~/' } as Record<string, unknown>,
}));

vi.mock('../services/push-notification-service.js', () => ({
  pushNotificationService: {
    waitForInitialization: vi.fn(async () => {}),
    whenInitialized: vi.fn(() => push.started),
    forceRefreshSubscription: push.forceRefresh,
    getPermission: vi.fn(() => (push.permission ? 'granted' : 'default')),
    getSubscription: vi.fn(() => push.subscription),
    loadPreferences: vi.fn(async () => ({ enabled: push.enabled })),
    getSubscriptionStatus: vi.fn(() => ({ hasPermission: push.permission })),
    onPermissionChange: vi.fn(() => () => {}),
    onSubscriptionChange: vi.fn(() => () => {}),
    isSupported: vi.fn(() => push.supported),
    isSubscribed: vi.fn(() => false),
    savePreferences: push.save,
  },
}));

vi.mock('../services/server-config-service.js', () => ({
  ServerConfigService: class {
    loadConfig = vi.fn(async () => serverConfig.current);
    updateConfig = updateConfig;
    setAuthClient = vi.fn();
  },
}));

import { MAC_SESSIONS_CHANGED_EVENT } from '../../shared/mac-sessions.js';
import { setLocale } from '../i18n/index.js';
import { applyAccent } from '../utils/accent-themes.js';
import { rememberMacSessionsPlatform } from '../utils/mac-sessions.js';
import { applyThemeMode } from '../utils/theme-mode.js';
import { Settings } from './settings.js';

describe('Settings', () => {
  let component: Settings;

  beforeEach(async () => {
    setupLocalStorageMock();
    push.supported = true;
    push.started = Promise.resolve();
    push.enabled = false;
    push.permission = false;
    push.subscription = null;
    push.forceRefresh.mockClear();
    push.save.mockReset();
    serverConfig.current = { repositoryBasePath: '~/' };
    component = new Settings();
    component.visible = true;
    document.body.append(component);
    await component.updateComplete;
  });

  afterEach(() => {
    component.remove();
    restoreLocalStorage();
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-accent');
  });

  const button = (testId: string) =>
    component.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement | null;

  describe('notifications before the push service has started', () => {
    it('waits for it instead of forcing a resubscribe of a subscription not read yet', async () => {
      let start = () => {};
      push.started = new Promise<void>((resolve) => {
        start = resolve;
      });
      push.enabled = true;
      push.permission = true;
      const early = new Settings();
      early.visible = true;
      document.body.append(early);
      await early.updateComplete;
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(push.forceRefresh).not.toHaveBeenCalled();

      // Started: the subscription was there all along.
      push.subscription = { endpoint: 'https://web.push.apple.com/abc' };
      start();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(push.forceRefresh).not.toHaveBeenCalled();
      early.remove();
    });

    // 2026-11-10: a dialog removed while the push service was still starting registered its
    // listeners afterwards, when nothing could remove them any more.
    it('registers no listener once the dialog has left the page', async () => {
      const { pushNotificationService } = await import('../services/push-notification-service.js');
      let start = () => {};
      push.started = new Promise<void>((resolve) => {
        start = resolve;
      });
      vi.mocked(pushNotificationService.onPermissionChange).mockClear();
      vi.mocked(pushNotificationService.onSubscriptionChange).mockClear();
      vi.mocked(pushNotificationService.loadPreferences).mockClear();
      const early = new Settings();
      document.body.append(early);
      await early.updateComplete;
      early.remove();
      start();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(pushNotificationService.loadPreferences).not.toHaveBeenCalled();
      expect(pushNotificationService.onPermissionChange).not.toHaveBeenCalled();
      expect(pushNotificationService.onSubscriptionChange).not.toHaveBeenCalled();
    });
  });

  describe('appearance', () => {
    it('applies light/dark/system and color themes instantly', async () => {
      const themeChanged = vi.fn();
      component.addEventListener('theme-changed', themeChanged);

      button('settings-theme-dark')?.click();
      await component.updateComplete;
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
      expect(localStorage.getItem('untether-theme')).toBe('dark');
      expect(themeChanged).toHaveBeenCalledOnce();
      expect(button('settings-theme-dark')?.getAttribute('aria-pressed')).toBe('true');

      button('settings-accent-violet')?.click();
      await component.updateComplete;
      expect(document.documentElement.getAttribute('data-accent')).toBe('violet');
      expect(button('settings-accent-violet')?.getAttribute('aria-pressed')).toBe('true');
    });

    it('follows theme and color changes made elsewhere', async () => {
      applyThemeMode('light');
      window.dispatchEvent(new CustomEvent('theme-changed', { detail: { theme: 'light' } }));
      applyAccent('gold');
      await component.updateComplete;

      expect(button('settings-theme-light')?.getAttribute('aria-pressed')).toBe('true');
      expect(button('settings-accent-gold')?.getAttribute('aria-pressed')).toBe('true');
    });
  });

  describe('system text size', () => {
    async function mountWith(touchWebKit: boolean) {
      vi.stubGlobal('CSS', {
        supports: (property: string) => touchWebKit && property === '-webkit-touch-callout',
      });
      const settings = new Settings();
      settings.visible = true;
      document.body.append(settings);
      await settings.updateComplete;
      return settings;
    }

    afterEach(() => {
      vi.unstubAllGlobals();
      document.documentElement.removeAttribute('data-text-size');
    });

    it('is an Appearance switch, off by default, that sets the root font from Dynamic Type', async () => {
      const settings = await mountWith(true);
      const toggle = settings.querySelector<HTMLButtonElement>(
        '[data-testid="settings-appearance"] [data-testid="settings-system-text-size-toggle"]'
      );
      expect(toggle?.getAttribute('aria-checked')).toBe('false');
      const label = settings.querySelector(`#${toggle?.getAttribute('aria-labelledby')}`);
      expect(label?.textContent?.trim()).toBe('Use the system text size');

      toggle?.click();
      await settings.updateComplete;
      expect(toggle?.getAttribute('aria-checked')).toBe('true');
      expect(document.documentElement.getAttribute('data-text-size')).toBe('system');
      expect(localStorage.getItem('ut-system-text-size')).toBe('on');

      toggle?.click();
      await settings.updateComplete;
      expect(document.documentElement.hasAttribute('data-text-size')).toBe(false);
      settings.remove();
    });

    it('is not offered where it would do nothing (a Mac, other browsers)', async () => {
      const settings = await mountWith(false);
      expect(settings.querySelector('[data-testid="settings-system-text-size"]')).toBeNull();
      settings.remove();
    });
  });

  // 2026-11-11: the desktop chat's column follows the window; how far is a per-device choice.
  describe('chat width', () => {
    afterEach(() => {
      document.documentElement.removeAttribute('data-chat-width');
      localStorage.removeItem('ut-chat-width');
    });

    it('is an Appearance choice of two, full by default, saved on this device', async () => {
      const settings = new Settings();
      settings.visible = true;
      document.body.append(settings);
      await settings.updateComplete;
      const option = (width: string) =>
        settings.querySelector<HTMLButtonElement>(
          `[data-testid="settings-appearance"] [data-testid="settings-chat-width-${width}"]`
        );
      expect(option('full')?.getAttribute('aria-pressed')).toBe('true');
      expect(option('full')?.textContent?.trim()).toBe('Full');
      expect(option('wide')).toBeNull();
      expect(document.documentElement.hasAttribute('data-chat-width')).toBe(false);

      option('comfortable')?.click();
      await settings.updateComplete;
      expect(option('comfortable')?.getAttribute('aria-pressed')).toBe('true');
      expect(option('full')?.getAttribute('aria-pressed')).toBe('false');
      expect(document.documentElement.getAttribute('data-chat-width')).toBe('comfortable');
      expect(localStorage.getItem('ut-chat-width')).toBe('comfortable');

      option('full')?.click();
      await settings.updateComplete;
      expect(document.documentElement.hasAttribute('data-chat-width')).toBe(false);
      expect(localStorage.getItem('ut-chat-width')).toBeNull();
      settings.remove();
    });
  });

  describe('phone layout', () => {
    it('opens as a full-height labelled sheet with a scrollable body and 44px close', () => {
      const sheet = component.querySelector('[data-testid="settings-sheet"]') as HTMLElement;
      expect(sheet.getAttribute('role')).toBe('dialog');
      expect(
        document.getElementById(sheet.getAttribute('aria-labelledby') ?? '')?.textContent
      ).toBe('Settings');
      expect(sheet.classList).toContain('h-full');
      expect(sheet.classList).toContain('sm:h-auto');

      const body = component.querySelector('[data-testid="settings-body"]') as HTMLElement;
      expect(body.classList).toContain('overflow-y-auto');
      expect(body.classList).toContain('overflow-x-hidden');

      const close = button('settings-close') as HTMLButtonElement;
      expect(close.classList).toContain('w-11');
      expect(close.classList).toContain('h-11');
      const onClose = vi.fn();
      component.addEventListener('close', onClose);
      close.click();
      expect(onClose).toHaveBeenCalledOnce();
    });
  });

  // Desktop (≥1024 px): two panes, design spec 5.3 (2026-10-12).
  describe('desktop layout', () => {
    const realMatchMedia = window.matchMedia;
    async function mountWide() {
      component.remove();
      window.matchMedia = vi.fn(
        (query: string) =>
          ({
            media: query,
            matches: query === '(min-width: 1024px)' || query === '(pointer: fine)',
            addEventListener: () => {},
            removeEventListener: () => {},
          }) as unknown as MediaQueryList
      );
      component = new Settings();
      component.visible = true;
      document.body.append(component);
      await component.updateComplete;
    }
    afterEach(() => {
      window.matchMedia = realMatchMedia;
    });

    it('shows a section nav and one section, and remembers the last one', async () => {
      await mountWide();
      const sheet = component.querySelector('[data-testid="settings-sheet"]') as HTMLElement;
      expect(sheet.classList).toContain('ut-dialog--lg');
      expect(component.querySelector('[data-testid="settings-section-general"]')).toBeTruthy();
      expect(component.querySelector('[data-testid="settings-section-appearance"]')).toBeNull();
      // No Mac sessions on this server: no "This Mac" section.
      expect(button('settings-nav-thisMac')).toBeNull();

      button('settings-nav-notifications')?.click();
      await component.updateComplete;
      expect(button('settings-nav-notifications')?.getAttribute('aria-current')).toBe('page');
      expect(
        component.querySelector('[data-testid="settings-section-notifications"]')
      ).toBeTruthy();
      expect(localStorage.getItem('ut-settings-section')).toBe('notifications');

      await mountWide();
      expect(
        component.querySelector('[data-testid="settings-section-notifications"]')
      ).toBeTruthy();
    });

    it('notifications: a neutral status pill and one primary action', async () => {
      localStorage.setItem('ut-settings-section', 'notifications');
      await mountWide();
      const status = component.querySelector('[data-testid="settings-notifications-status"]');
      expect(status?.getAttribute('data-on')).toBe('false');
      expect(status?.textContent?.trim()).toBe('Off');
      expect(
        component.querySelectorAll('[data-testid="settings-notifications-hero"] .ut-btn--primary')
      ).toHaveLength(1);
      expect(button('settings-notifications-action')?.textContent?.trim()).toBe('Turn on');
    });

    it('hides phone-only settings with a mouse and puts the logs in Advanced', async () => {
      localStorage.setItem('ut-settings-section', 'advanced');
      await mountWide();
      expect(component.querySelector('[data-testid="settings-logs"]')?.getAttribute('href')).toBe(
        '/logs'
      );
      expect(component.textContent).not.toContain('Debug Information');
      button('settings-nav-terminal')?.click();
      await component.updateComplete;
      expect(component.textContent).not.toContain('Mobile Quick Keys');
    });

    // 2026-11-11: input diagnostics (utils/input-diagnostics.ts) are turned on here.
    it('Advanced turns input diagnostics on and off, and keeps them on when asked', async () => {
      const { inputDiagnostics, DIAG_KEEP_STORAGE_KEY } = await import(
        '../utils/input-diagnostics.js'
      );
      onTestFinished(() => {
        inputDiagnostics.setLive(false);
        inputDiagnostics.setKept(false);
      });
      localStorage.setItem('ut-settings-section', 'advanced');
      await mountWide();
      const live = button('settings-input-diag-switch');
      const keep = button('settings-input-diag-keep-switch');
      expect(live?.getAttribute('aria-checked')).toBe('false');
      expect(keep?.getAttribute('aria-checked')).toBe('false');

      live?.click();
      await component.updateComplete;
      expect(inputDiagnostics.mode).toBe('live');
      expect(button('settings-input-diag-switch')?.getAttribute('aria-checked')).toBe('true');
      // Only in memory: a reload ends it.
      expect(localStorage.getItem(DIAG_KEEP_STORAGE_KEY)).toBeNull();

      keep?.click();
      await component.updateComplete;
      expect(localStorage.getItem(DIAG_KEEP_STORAGE_KEY)).toBe('1');
      button('settings-input-diag-switch')?.click();
      await component.updateComplete;
      expect(inputDiagnostics.mode).toBe('kept');
      button('settings-input-diag-keep-switch')?.click();
      await component.updateComplete;
      expect(inputDiagnostics.mode).toBe('off');
      expect(localStorage.getItem(DIAG_KEEP_STORAGE_KEY)).toBeNull();
    });
  });

  // The phone list's "Compact list" (utils/phone-list-layout.ts), 2026-10-04.
  describe('compact list', () => {
    const IPHONE =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1';
    async function mountOnPhone(width: number, height: number) {
      component.remove();
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(IPHONE);
      Object.defineProperty(window.screen, 'width', { configurable: true, get: () => width });
      Object.defineProperty(window.screen, 'height', { configurable: true, get: () => height });
      component = new Settings();
      component.visible = true;
      document.body.append(component);
      await component.updateComplete;
      return button('settings-compact-list-toggle');
    }
    afterEach(() => vi.restoreAllMocks());

    // On by default on every phone since the phone redesign (utils/phone-list-layout.ts,
    // 2026-10-12); before, only on screens up to 700 pt tall.
    it('is on by default on every phone', async () => {
      expect((await mountOnPhone(375, 667))?.getAttribute('aria-checked')).toBe('true');
      expect((await mountOnPhone(393, 852))?.getAttribute('aria-checked')).toBe('true');
    });

    it('a tap stores an explicit choice the list follows', async () => {
      const toggle = await mountOnPhone(375, 667);
      const changed = vi.fn();
      window.addEventListener('ut-compact-phone-list-changed', changed);
      toggle?.click();
      await component.updateComplete;
      window.removeEventListener('ut-compact-phone-list-changed', changed);
      expect(toggle?.getAttribute('aria-checked')).toBe('false');
      expect(localStorage.getItem('ut-compact-phone-list')).toBe('off');
      expect(changed).toHaveBeenCalledOnce();
    });

    it('is not offered on a desktop', () => {
      expect(button('settings-compact-list-toggle')).toBeNull();
    });
  });

  describe('notifications on iPhone', () => {
    it('walks through Share, Add to Home Screen and reopening when not installed', async () => {
      component.remove();
      push.supported = false;
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1'
      );
      component = new Settings();
      component.visible = true;
      document.body.append(component);
      await component.updateComplete;

      const steps = [
        ...component.querySelectorAll('[data-testid="settings-ios-install"] li > span:last-child'),
      ].map((li) => li.textContent?.trim());
      expect(steps).toEqual([
        "Tap Share (the square with an up arrow) in Safari's toolbar",
        'Choose "Add to Home Screen", then tap Add',
        'Open Untether from your Home Screen and turn notifications on here',
      ]);
      expect(
        component.querySelector('[data-testid="settings-ios-install"] svg path')?.namespaceURI
      ).toBe('http://www.w3.org/2000/svg');
      vi.restoreAllMocks();
    });
  });

  describe('notifications in Chrome on iPhone', () => {
    it('shows the install steps, not "unsupported", with the address to open in Safari', async () => {
      component.remove();
      push.supported = false;
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.90 Mobile/15E148 Safari/604.1'
      );
      component = new Settings();
      component.visible = true;
      document.body.append(component);
      await component.updateComplete;

      const install = component.querySelector('[data-testid="settings-ios-install"]');
      expect(install).not.toBeNull();
      expect(component.textContent).not.toContain('not supported');
      const steps = [...(install?.querySelectorAll('li > span:last-child') ?? [])].map((li) =>
        li.textContent?.trim()
      );
      expect(steps[0]).toBe('Tap Share (the icon in the address bar)');
      expect(steps[1]).toContain('iOS 16.4');
      const address = install?.querySelector('app-address-copy') as HTMLElement & {
        updateComplete: Promise<unknown>;
      };
      await address.updateComplete;
      expect(address.querySelector('[data-testid="app-address-value"]')?.textContent).toBe(
        window.location.origin
      );
      expect(address.textContent).toContain('open it in Safari');
      vi.restoreAllMocks();
    });
  });

  describe('repository base path', () => {
    it('saves the typed path once when the field is committed, not per keystroke', async () => {
      updateConfig.mockClear();
      const input = component.querySelector(
        '[data-testid="settings-repo-path"]'
      ) as HTMLInputElement;
      expect(input.getAttribute('autocapitalize')).toBe('off');

      for (const value of ['~/P', '~/Pr', '~/Projects']) {
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      expect(updateConfig).not.toHaveBeenCalled();

      input.dispatchEvent(new Event('change', { bubbles: true }));
      await vi.waitFor(() => expect(updateConfig).toHaveBeenCalledOnce());
      expect(updateConfig).toHaveBeenCalledWith({ repositoryBasePath: '~/Projects' });
    });

    it('keeps a path still being typed when settings is closed', async () => {
      updateConfig.mockClear();
      const input = component.querySelector(
        '[data-testid="settings-repo-path"]'
      ) as HTMLInputElement;
      input.value = '~/Code';
      input.dispatchEvent(new Event('input', { bubbles: true }));

      (component.querySelector('[data-testid="settings-close"]') as HTMLButtonElement).click();

      await vi.waitFor(() =>
        expect(updateConfig).toHaveBeenCalledWith({ repositoryBasePath: '~/Code' })
      );
    });
  });

  describe('shield new sessions', () => {
    const toggle = () =>
      component.querySelector('[data-testid="settings-shield-new-toggle"]') as HTMLButtonElement;

    async function reopen() {
      component.visible = false;
      await component.updateComplete;
      component.visible = true;
    }

    it('is hidden when tmux is not on the Mac', async () => {
      serverConfig.current = { repositoryBasePath: '~/', shieldAvailable: false };
      await reopen();
      await new Promise((r) => setTimeout(r, 20));
      await component.updateComplete;
      expect(toggle()).toBeNull();
    });

    it('is on by default and saves turning it off', async () => {
      updateConfig.mockClear();
      serverConfig.current = { repositoryBasePath: '~/', shieldAvailable: true };
      await reopen();
      await vi.waitFor(async () => {
        await component.updateComplete;
        expect(toggle()).not.toBeNull();
      });
      expect(toggle().getAttribute('aria-checked')).toBe('true');
      toggle().click();
      await vi.waitFor(() =>
        expect(updateConfig).toHaveBeenCalledWith({ shieldNewSessions: false })
      );
      await component.updateComplete;
      expect(toggle().getAttribute('aria-checked')).toBe('false');
    });

    it('shows the choice saved on the server', async () => {
      serverConfig.current = {
        repositoryBasePath: '~/',
        shieldAvailable: true,
        shieldNewSessions: false,
      };
      await reopen();
      await vi.waitFor(async () => {
        await component.updateComplete;
        expect(toggle()?.getAttribute('aria-checked')).toBe('false');
      });
    });
  });

  // 2026-10-31: off by default (Untether is public); the owner turns it on.
  describe('restart Claude after updates', () => {
    const toggle = () =>
      component.querySelector(
        '[data-testid="settings-restart-updated-claude-toggle"]'
      ) as HTMLButtonElement;

    it('is off by default and saves turning it on', async () => {
      updateConfig.mockClear();
      serverConfig.current = { repositoryBasePath: '~/' };
      component.visible = false;
      await component.updateComplete;
      component.visible = true;
      await vi.waitFor(async () => {
        await component.updateComplete;
        expect(toggle()).not.toBeNull();
      });
      expect(toggle().getAttribute('aria-checked')).toBe('false');
      toggle().click();
      await vi.waitFor(() =>
        expect(updateConfig).toHaveBeenCalledWith({ restartUpdatedClaude: true })
      );
      await component.updateComplete;
      expect(toggle().getAttribute('aria-checked')).toBe('true');
    });
  });

  describe('sessions from this Mac', () => {
    const section = () => component.querySelector('[data-testid="settings-mac-sessions"]');
    const toggle = () =>
      component.querySelector('[data-testid="settings-mac-sessions-toggle"]') as HTMLButtonElement;
    const select = () =>
      component.querySelector('[data-testid="settings-mac-open-mode"]') as HTMLSelectElement | null;
    const changed = vi.fn();

    beforeEach(() => {
      updateConfig.mockReset();
      updateConfig.mockResolvedValue(undefined);
      changed.mockClear();
      window.addEventListener(MAC_SESSIONS_CHANGED_EVENT, changed);
    });

    afterEach(() => {
      window.removeEventListener(MAC_SESSIONS_CHANGED_EVENT, changed);
    });

    async function showWith(config: Record<string, unknown>) {
      serverConfig.current = { repositoryBasePath: '~/', macSessionsSupported: true, ...config };
      component.visible = false;
      await component.updateComplete;
      component.visible = true;
      await vi.waitFor(async () => {
        await component.updateComplete;
        expect(section()).not.toBeNull();
      });
    }

    it('is not offered where the server lists nothing (older server, other systems, HQ)', async () => {
      serverConfig.current = { repositoryBasePath: '~/', macSessionsSupported: false };
      component.visible = false;
      await component.updateComplete;
      component.visible = true;
      await new Promise((r) => setTimeout(r, 20));
      await component.updateComplete;
      expect(section()).toBeNull();
    });

    it('is on by default; turning it off saves it, tells the list and hides how tmux opens', async () => {
      await showWith({});
      expect(toggle().getAttribute('aria-checked')).toBe('true');
      expect(select()?.value).toBe('control');

      toggle().click();
      await vi.waitFor(() => expect(updateConfig).toHaveBeenCalledWith({ macSessions: false }));
      await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
      await component.updateComplete;
      expect(toggle().getAttribute('aria-checked')).toBe('false');
      expect(select()).toBeNull();
    });

    it('puts the switch back and says so when saving fails', async () => {
      const errors = vi.fn();
      component.addEventListener('error', (e: Event) => errors((e as CustomEvent<string>).detail));
      updateConfig.mockRejectedValueOnce(new Error('HTTP 500'));
      await showWith({});
      toggle().click();
      await vi.waitFor(() => expect(errors).toHaveBeenCalledWith('Couldn’t save the setting.'));
      await component.updateComplete;
      expect(toggle().getAttribute('aria-checked')).toBe('true');
      expect(changed).not.toHaveBeenCalled();
    });

    it('shows a switch forced when the server started as locked, and says how', async () => {
      await showWith({
        macSessions: false,
        macSessionsLocked: true,
        macSessionsLockedBy: 'UNTETHER_MAC_SESSIONS=0',
      });
      expect(toggle().getAttribute('aria-checked')).toBe('false');
      expect(toggle().disabled).toBe(true);
      expect(
        component.querySelector('[data-testid="settings-mac-sessions-locked"]')?.textContent
      ).toContain('Set when the server was started (UNTETHER_MAC_SESSIONS=0).');
      toggle().click();
      await new Promise((r) => setTimeout(r, 20));
      expect(updateConfig).not.toHaveBeenCalled();
    });

    it('lays out the flag that locked it left to right, also in Arabic', async () => {
      await setLocale('ar');
      try {
        await showWith({
          macSessions: false,
          macSessionsLocked: true,
          macSessionsLockedBy: '--no-mac-sessions',
        });
        const note = component.querySelector('[data-testid="settings-mac-sessions-locked"]');
        expect(note?.textContent).toBe('حُدِّد عند تشغيل الخادم (--no-mac-sessions).');
        // In the right-to-left note its dashes would otherwise move to its end.
        expect(note?.querySelector('span[dir="ltr"]')?.textContent).toBe('--no-mac-sessions');
      } finally {
        await setLocale('en');
      }
    });

    describe('share with phone', () => {
      const share = () => component.querySelector('[data-testid="settings-mac-share"]');
      const shareToggle = () =>
        component.querySelector('[data-testid="settings-mac-share-toggle"]') as HTMLButtonElement;
      const launcher = () =>
        component.querySelector(
          '[data-testid="settings-mac-share-launcher"]'
        ) as HTMLSelectElement | null;

      it('is offered on macOS under "On this Mac", off by default, and saves when turned on', async () => {
        await showWith({ macShareSupported: true });
        expect(shareToggle().getAttribute('aria-checked')).toBe('false');
        expect(share()?.textContent).toContain('Share Mac terminals with the phone');
        expect(launcher()).toBeNull();
        shareToggle().click();
        await vi.waitFor(() => expect(updateConfig).toHaveBeenCalledWith({ macShare: true }));
        await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
        await component.updateComplete;
        expect(shareToggle().getAttribute('aria-checked')).toBe('true');
        expect(launcher()?.value).toBe('ut');
      });

      it('chooses how it reopens, with the shell hint', async () => {
        await showWith({ macShareSupported: true, macShare: true, macShareLauncher: 'shell' });
        expect(launcher()?.value).toBe('shell');
        expect(
          [...(launcher()?.options ?? [])].map((option) => option.textContent?.trim())
        ).toEqual(['ut', 'My shell’s own command']);
        expect(
          component.querySelector('[data-testid="settings-mac-share-launcher-hint"]')?.textContent
        ).toContain('startup file is reloaded');
        const field = launcher() as HTMLSelectElement;
        field.value = 'ut';
        field.dispatchEvent(new Event('change', { bubbles: true }));
        await vi.waitFor(() =>
          expect(updateConfig).toHaveBeenCalledWith({ macShareLauncher: 'ut' })
        );
      });

      it('locked when forced at start, and says how', async () => {
        await showWith({
          macShareSupported: true,
          macShare: true,
          macShareLocked: true,
          macShareLockedBy: 'UNTETHER_MAC_SHARE=1',
        });
        expect(shareToggle().disabled).toBe(true);
        expect(
          component.querySelector('[data-testid="settings-mac-share-locked"]')?.textContent
        ).toContain('Set when the server was started (UNTETHER_MAC_SHARE=1).');
        shareToggle().click();
        await new Promise((r) => setTimeout(r, 20));
        expect(updateConfig).not.toHaveBeenCalled();
      });

      it('hidden off macOS, and while "On this Mac" is off', async () => {
        await showWith({ macShareSupported: false });
        expect(share()).toBeNull();
        await showWith({ macShareSupported: true, macSessions: false });
        expect(share()).toBeNull();
      });
    });

    it('opens tmux sessions to watch when chosen, and saves the choice', async () => {
      await showWith({ macSessionsOpenMode: 'watch' });
      expect(select()?.value).toBe('watch');
      expect([...(select()?.options ?? [])].map((option) => option.textContent?.trim())).toEqual([
        'Ready to type',
        'Watch only',
      ]);

      const field = select() as HTMLSelectElement;
      field.value = 'control';
      field.dispatchEvent(new Event('change', { bubbles: true }));
      await vi.waitFor(() =>
        expect(updateConfig).toHaveBeenCalledWith({ macSessionsOpenMode: 'control' })
      );
      await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    });

    it('says Mac on macOS and computer elsewhere', async () => {
      await showWith({});
      expect(section()?.textContent).toContain('Show sessions from this computer');
      component.serverPlatform = 'darwin';
      await component.updateComplete;
      expect(section()?.textContent).toContain('Show sessions from this Mac');
      expect(toggle().getAttribute('aria-label')).toBe('Show sessions from this Mac');
    });

    it("says Mac from the server's config, though the list never answered on this device", async () => {
      rememberMacSessionsPlatform('linux');
      await showWith({ platform: 'darwin' });
      expect(section()?.textContent).toContain('Show sessions from this Mac');
      expect(toggle().getAttribute('aria-label')).toBe('Show sessions from this Mac');
    });

    it('says Mac when the list reported macOS, though the app gives no platform', async () => {
      rememberMacSessionsPlatform('darwin');
      try {
        await showWith({});
        expect(section()?.textContent).toContain('Show sessions from this Mac');
      } finally {
        rememberMacSessionsPlatform('linux');
      }
    });
  });

  describe('finished-session cleanup', () => {
    const select = () =>
      component.querySelector('[data-testid="settings-auto-cleanup-select"]') as HTMLSelectElement;

    it('is off unless the user chose an age, and offers 1/3/7/30 days', async () => {
      await vi.waitFor(() => expect(select()).not.toBeNull());
      expect(select().value).toBe('0');
      expect([...select().options].map((option) => option.value)).toEqual([
        '0',
        '1',
        '3',
        '7',
        '30',
      ]);
      expect(component.textContent).toContain('Claude conversations stay in History.');
    });

    it('saves the chosen age and turning it back off', async () => {
      updateConfig.mockClear();
      await vi.waitFor(() => expect(select()).not.toBeNull());

      select().value = '7';
      select().dispatchEvent(new Event('change', { bubbles: true }));
      await vi.waitFor(() =>
        expect(updateConfig).toHaveBeenCalledWith({ autoCleanupExitedAfterDays: 7 })
      );

      select().value = '0';
      select().dispatchEvent(new Event('change', { bubbles: true }));
      await vi.waitFor(() =>
        expect(updateConfig).toHaveBeenLastCalledWith({ autoCleanupExitedAfterDays: 0 })
      );
    });

    it('shows the age saved on the server', async () => {
      serverConfig.current = { repositoryBasePath: '~/', autoCleanupExitedAfterDays: 3 };
      component.visible = false;
      await component.updateComplete;
      component.visible = true;
      await vi.waitFor(async () => {
        await component.updateComplete;
        expect(select().value).toBe('3');
      });
    });
  });

  // Phone addendum (phone-spec §4.4, 2026-10-12): iOS navigation in a bottom sheet.
  describe('on a phone', () => {
    const realMatchMedia = window.matchMedia;
    const realWidth = window.innerWidth;
    async function mountPhone() {
      component.remove();
      window.matchMedia = ((query: string) => ({
        matches: query.includes('coarse'),
        media: query,
        addEventListener() {},
        removeEventListener() {},
      })) as unknown as typeof window.matchMedia;
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 393 });
      component = new Settings();
      component.visible = true;
      document.body.append(component);
      await component.updateComplete;
    }
    afterEach(() => {
      window.matchMedia = realMatchMedia;
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: realWidth });
    });

    it('opens on the root list: large title, one row per section with its value', async () => {
      localStorage.removeItem('ut-settings-phone-section');
      await mountPhone();
      const sheet = button('settings-sheet') as HTMLElement | null;
      expect(sheet?.classList.contains('p-sheet')).toBe(true);
      expect(sheet?.querySelector('.ut-grabber')).not.toBeNull();
      expect(component.querySelector('.st-large-title')?.textContent).toBe('Settings');
      const rows = [...component.querySelectorAll<HTMLElement>('.st-root-row')];
      expect(rows.map((row) => row.dataset.settingsRoot)).toEqual(
        expect.arrayContaining(['general', 'appearance', 'terminal', 'advanced'])
      );
      expect(rows[0].querySelector('.st-root-value')?.textContent).toBe('English');
      expect(button('settings-close')?.textContent?.trim()).toBe('Done');
      // No fixed footer: version and logs live at the end of Advanced.
      expect(component.querySelector('[data-testid="settings-logs"]')).toBeNull();
    });

    it('pushes a section with a back button, remembers it, and goes back', async () => {
      localStorage.removeItem('ut-settings-phone-section');
      await mountPhone();
      button('settings-nav-advanced')?.click();
      await component.updateComplete;
      expect(button('settings-back')?.textContent).toContain('Settings');
      expect(component.querySelector('[data-testid="settings-section-advanced"]')).not.toBeNull();
      expect(component.querySelector('[data-testid="settings-logs"]')).not.toBeNull();
      expect(component.querySelector('[data-testid="settings-version"]')).not.toBeNull();
      expect(localStorage.getItem('ut-settings-phone-section')).toBe('advanced');

      // Reopening comes back to the same page, like iOS Settings.
      await mountPhone();
      expect(component.querySelector('[data-testid="settings-section-advanced"]')).not.toBeNull();
      button('settings-back')?.click();
      await component.updateComplete;
      expect(component.querySelector('.st-root')).not.toBeNull();
      expect(localStorage.getItem('ut-settings-phone-section') ?? '').toBe('');
    });

    it('shows selects as value rows and short descriptions with a footer', async () => {
      localStorage.setItem('ut-settings-phone-section', 'sessions');
      await mountPhone();
      const cleanup = button('settings-auto-cleanup') as HTMLElement | null;
      expect(cleanup?.classList.contains('st-row--select')).toBe(true);
      expect(cleanup?.querySelector('.st-value')?.textContent).toContain('Off');
      expect(cleanup?.querySelector('select')).not.toBeNull();
      expect(component.querySelector('.st-group-footer')?.textContent).toContain(
        'Finished sessions older than this'
      );
    });

    it('Done closes', async () => {
      await mountPhone();
      const close = vi.fn();
      component.addEventListener('close', close);
      button('settings-close')?.click();
      expect(close).toHaveBeenCalledOnce();
    });
  });
  // Audit 2026-10-20.
  describe('audit fixes', () => {
    const realMatchMedia = window.matchMedia;
    async function mountWideAt(section: string) {
      component.remove();
      localStorage.setItem('ut-settings-section', section);
      window.matchMedia = vi.fn(
        (query: string) =>
          ({
            media: query,
            matches: query === '(min-width: 1024px)' || query === '(pointer: fine)',
            addEventListener: () => {},
            removeEventListener: () => {},
          }) as unknown as MediaQueryList
      );
      component = new Settings();
      component.visible = true;
      document.body.append(component);
      await component.updateComplete;
      await new Promise((resolve) => setTimeout(resolve, 0));
      await component.updateComplete;
    }
    afterEach(() => {
      window.matchMedia = realMatchMedia;
      vi.restoreAllMocks();
    });

    it('shows notifications as off on a device without permission, even when on elsewhere', async () => {
      push.enabled = true;
      push.permission = false;
      await mountWideAt('notifications');
      const status = component.querySelector('[data-testid="settings-notifications-status"]');
      expect(status?.getAttribute('data-on')).toBe('false');
      expect(button('settings-notifications-action')?.textContent?.trim()).toBe('Turn on');
      expect(button('settings-notifications-disable')).toBeNull();
    });

    it('reverts a notification type switch and says so when saving fails', async () => {
      push.enabled = true;
      push.permission = true;
      push.save.mockRejectedValueOnce(new Error('PUT /api/config 500'));
      await mountWideAt('notifications');
      const toggle = button('settings-notify-sessionExit');
      expect(toggle?.getAttribute('aria-checked')).toBe('false');
      toggle?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await component.updateComplete;
      expect(push.save).toHaveBeenCalledOnce();
      expect(button('settings-notify-sessionExit')?.getAttribute('aria-checked')).toBe('false');
      expect(document.body.textContent).toContain("Couldn't save this notification setting");
    });

    it('offers the quick actions switch on an iPad, where the strip is shown', async () => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
        'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148'
      );
      await mountWideAt('terminal');
      expect(button('settings-quick-actions')).toBeTruthy();
    });

    it('hides the quick actions switch on a desktop without touch', async () => {
      await mountWideAt('terminal');
      expect(button('settings-quick-actions')).toBeNull();
    });
  });
});
