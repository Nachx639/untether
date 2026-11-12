/**
 * @vitest-environment happy-dom
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOOKS } from '../../shared/looks.js';
import {
  applyLook,
  followServerLook,
  getActiveLook,
  getDeviceLook,
  LOOK_BOOT_KEY,
  LOOK_STORAGE_KEY,
  lockedThemeMode,
  lookHref,
  setServerDefaultLook,
} from './look.js';
import {
  applyThemeMode,
  effectiveThemeMode,
  getThemeMode,
  THEME_STORAGE_KEY,
} from './theme-mode.js';

/** The app's link loads never fire in happy-dom: settle them as a browser would. */
function settleLinks(): void {
  for (const link of document.head.querySelectorAll('link[id^="ut-look-"]')) {
    link.dispatchEvent(new Event('load'));
  }
}

async function pick(id: string): Promise<void> {
  const done = applyLook(id);
  settleLinks();
  await done;
}

const CYBER = 'cyber-hacker';
const MINIMAL = 'minimal-light';

/** The test setup replaces localStorage with an inert mock: a real one, per test. */
function realStorage(): void {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, String(value)),
    removeItem: (key: string) => data.delete(key),
    clear: () => data.clear(),
  });
}

beforeEach(() => {
  realStorage();
  // No file behind the links here: settleLinks stands in for the browser's load event.
  Object.assign((window as unknown as { happyDOM: { settings: object } }).happyDOM.settings, {
    disableCSSFileLoading: true,
    handleDisabledFileLoadingAsSuccess: true,
  });
  document.head.innerHTML = '<meta name="theme-color" content="#000000">';
  const root = document.documentElement;
  root.removeAttribute('data-look');
  root.removeAttribute('data-theme');
  root.removeAttribute('style');
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockReturnValue({ matches: false, addEventListener() {}, removeEventListener() {} })
  );
});

// localStorage and matchMedia go back to the setup's own after each test.
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the mode a style forces', () => {
  it('a dark-only style forces dark and keeps the saved choice', async () => {
    applyThemeMode('light');
    await pick(CYBER);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(lockedThemeMode()).toBe('dark');
    expect(getThemeMode()).toBe('light');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
  });

  it('a light-only style forces light and leaves when another style comes', async () => {
    applyThemeMode('dark');
    await pick(MINIMAL);
    expect(effectiveThemeMode()).toBe('light');
    expect(lockedThemeMode()).toBe('light');
    await pick('original');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(lockedThemeMode()).toBeUndefined();
  });

  it('choosing a mode under a forcing style is remembered but does not change what shows', async () => {
    await pick(CYBER);
    applyThemeMode('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(getThemeMode()).toBe('light');
  });
});

describe('persistence', () => {
  it('survives per device and writes what the first paint needs', async () => {
    await pick(CYBER);
    expect(localStorage.getItem(LOOK_STORAGE_KEY)).toBe(CYBER);
    expect(JSON.parse(localStorage.getItem(LOOK_BOOT_KEY) as string)).toEqual({
      id: CYBER,
      force: 'dark',
      bg: { dark: '#020704' },
    });
    expect(getActiveLook().id).toBe(CYBER);
  });

  it('Original leaves no attribute and no boot entry, but is a choice of its own', async () => {
    await pick(CYBER);
    await pick('original');
    expect(document.documentElement.hasAttribute('data-look')).toBe(false);
    expect(localStorage.getItem(LOOK_BOOT_KEY)).toBeNull();
    expect(getDeviceLook()).toBe('original');
  });

  it('a stale saved id is not a choice', () => {
    localStorage.setItem(LOOK_STORAGE_KEY, 'gone');
    expect(getDeviceLook()).toBeNull();
  });
});

describe('the server default', () => {
  it('applies only without a device choice, and following it drops the choice', async () => {
    const first = setServerDefaultLook(CYBER);
    settleLinks();
    await first;
    expect(getActiveLook().id).toBe(CYBER);
    expect(getDeviceLook()).toBeNull();
    await pick(MINIMAL);
    const again = setServerDefaultLook(CYBER);
    settleLinks();
    await again;
    expect(getActiveLook().id).toBe(MINIMAL);
    const follow = followServerLook();
    settleLinks();
    await follow;
    expect(getActiveLook().id).toBe(CYBER);
  });

  it('a default removed from the server drops back to Original', async () => {
    const first = setServerDefaultLook(CYBER);
    settleLinks();
    await first;
    const none = setServerDefaultLook(undefined);
    settleLinks();
    await none;
    expect(getActiveLook().id).toBe('original');
    expect(localStorage.getItem(LOOK_BOOT_KEY)).toBeNull();
  });
});

describe('a sheet that cannot be loaded', () => {
  /** With this off, happy-dom answers a stylesheet link with its error event. */
  const sheetsFail = (fail: boolean) =>
    Object.assign((window as unknown as { happyDOM: { settings: object } }).happyDOM.settings, {
      handleDisabledFileLoadingAsSuccess: !fail,
    });

  it('does not switch style, mode or storage, and says so', async () => {
    sheetsFail(true);
    applyThemeMode('light');
    expect(await applyLook(CYBER)).toBe('failed');
    expect(document.documentElement.hasAttribute('data-look')).toBe(false);
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(getDeviceLook()).toBeNull();
    expect(localStorage.getItem(LOOK_BOOT_KEY)).toBeNull();
  });

  it('is fetched again on the next try', async () => {
    sheetsFail(true);
    expect(await applyLook(CYBER)).toBe('failed');
    expect(document.getElementById('ut-look-cyber-hacker')).toBeNull();
    sheetsFail(false);
    const second = applyLook(CYBER);
    expect(document.getElementById('ut-look-cyber-hacker')).not.toBeNull();
    settleLinks();
    expect(await second).toBe('shown');
    expect(getActiveLook().id).toBe(CYBER);
  });

  it('takes back a mode forced before the first paint, and keeps the choice for the next load', async () => {
    sheetsFail(true);
    localStorage.setItem(LOOK_STORAGE_KEY, CYBER);
    applyThemeMode('light');
    document.documentElement.setAttribute('data-look', CYBER);
    document.documentElement.setAttribute('data-theme', 'dark');
    expect(await setServerDefaultLook(undefined)).toBe('failed');
    expect(document.documentElement.hasAttribute('data-look')).toBe(false);
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(getDeviceLook()).toBe(CYBER);
  });

  it('retries a sheet index.html gave up on', async () => {
    const stale = document.createElement('link');
    stale.id = 'ut-look-cyber-hacker';
    stale.dataset.settled = '1';
    document.head.appendChild(stale);
    const done = applyLook(CYBER);
    expect(document.getElementById('ut-look-cyber-hacker')).not.toBe(stale);
    settleLinks();
    expect(await done).toBe('shown');
  });

  it('a pick overtaken by another one is not reported as a failure', async () => {
    const first = applyLook(CYBER);
    const second = applyLook(MINIMAL);
    settleLinks();
    expect(await first).toBe('superseded');
    expect(await second).toBe('shown');
    expect(getActiveLook().id).toBe(MINIMAL);
  });
});

describe('before the first paint (theme-init.js)', () => {
  const script = readFileSync(join(__dirname, '../assets/theme-init.js'), 'utf8');
  // Happy-dom has no CSS: what is checked is what the script does to <html>.
  const run = () => new Function(script)();

  it.each(LOOKS.filter((look) => look.id !== 'original').map((look) => [look.id, look] as const))(
    '%s: applied from the stored entry, mode forced, background painted',
    async (id, look) => {
      await pick(id);
      const boot = localStorage.getItem(LOOK_BOOT_KEY) as string;
      localStorage.clear();
      localStorage.setItem(LOOK_BOOT_KEY, boot);
      localStorage.setItem(THEME_STORAGE_KEY, look.modes === 'dark' ? 'light' : 'dark');
      const root = document.documentElement;
      root.removeAttribute('data-look');
      root.removeAttribute('data-theme');
      root.removeAttribute('style');
      run();
      expect(root.getAttribute('data-look')).toBe(id);
      const mode = look.modes === 'both' ? root.getAttribute('data-theme') : look.modes;
      expect(root.getAttribute('data-theme')).toBe(mode);
      expect(root.style.backgroundColor.toLowerCase()).toContain(
        (look.backgrounds[mode as 'light' | 'dark'] as string).toLowerCase().slice(1, 3)
      );
    }
  );

  describe('the server default written into the page', () => {
    const SERVER = JSON.stringify({ id: CYBER, force: 'dark', bg: { dark: '#020704' } });
    beforeEach(() => {
      const meta = document.createElement('meta');
      meta.setAttribute('name', 'ut-server-look');
      meta.setAttribute('content', SERVER);
      document.head.appendChild(meta);
      localStorage.setItem(THEME_STORAGE_KEY, 'light');
    });

    it('is on a new device from the first frame', () => {
      run();
      expect(document.documentElement.getAttribute('data-look')).toBe(CYBER);
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    });

    it('never beats a choice of this device, Original included', () => {
      localStorage.setItem(LOOK_STORAGE_KEY, 'original');
      run();
      expect(document.documentElement.hasAttribute('data-look')).toBe(false);
      expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    });

    it('a default the server dropped does not linger from an old stored entry', () => {
      document.head.querySelector('meta[name="ut-server-look"]')?.setAttribute('content', '');
      localStorage.setItem(LOOK_BOOT_KEY, SERVER);
      run();
      expect(document.documentElement.hasAttribute('data-look')).toBe(false);
    });
  });

  it('ignores an entry whose id could break out of the attribute', () => {
    localStorage.setItem(LOOK_BOOT_KEY, JSON.stringify({ id: 'x"><script>' }));
    run();
    expect(document.documentElement.hasAttribute('data-look')).toBe(false);
  });
});

describe("a style's sheet is named by its content", () => {
  const V1 = '0123456789abcdef';
  const V2 = 'fedcba9876543210';
  const serve = (versions: unknown) => {
    document.head.querySelector('meta[name="ut-look-versions"]')?.remove();
    const meta = document.createElement('meta');
    meta.setAttribute('name', 'ut-look-versions');
    meta.setAttribute(
      'content',
      typeof versions === 'string' ? versions : JSON.stringify(versions)
    );
    document.head.appendChild(meta);
  };
  /** index.html's second inline script: the one that adds the chosen style's first <link>. */
  const runIndexStylesScript = () => {
    const html = readFileSync(join(__dirname, '../assets/index.html'), 'utf8').replace(
      /<!--[\s\S]*?-->/g,
      ''
    );
    const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][1][1];
    expect(script).toContain('ut-look-');
    const styles = document.createElement('link');
    styles.id = 'ut-styles';
    document.head.appendChild(styles);
    new Function(script)();
  };

  it('asks for the version the page was served with, another URL once the sheet changes', () => {
    serve({ [CYBER]: V1 });
    expect(lookHref(CYBER)).toBe(`/looks/${CYBER}.css?v=${V1}`);
    // The next page load after a merge: index.html names the new sheet.
    serve({ [CYBER]: V2 });
    expect(lookHref(CYBER)).toBe(`/looks/${CYBER}.css?v=${V2}`);
  });

  it('falls back to the plain URL without a usable version', () => {
    expect(lookHref(CYBER)).toBe(`/looks/${CYBER}.css`);
    for (const versions of ['', 'not json', { other: V1 }, { [CYBER]: '../x' }, { [CYBER]: 7 }]) {
      serve(versions);
      expect(lookHref(CYBER)).toBe(`/looks/${CYBER}.css`);
    }
  });

  it('the picked sheet is loaded from the versioned URL', async () => {
    serve({ [CYBER]: V1 });
    await pick(CYBER);
    const link = document.getElementById(`ut-look-${CYBER}`) as HTMLLinkElement;
    expect(link.getAttribute('href')).toBe(`/looks/${CYBER}.css?v=${V1}`);
  });

  it("index.html's first <link> names the same URL, so the app reuses it", async () => {
    serve({ [CYBER]: V1 });
    document.documentElement.setAttribute('data-look', CYBER);
    runIndexStylesScript();
    const links = () => document.head.querySelectorAll(`link[id="ut-look-${CYBER}"]`);
    expect(links()).toHaveLength(1);
    expect(links()[0].getAttribute('href')).toBe(lookHref(CYBER));
    await pick(CYBER);
    expect(links()).toHaveLength(1);
  });

  it("index.html's first <link> is the plain URL when the page names no version", () => {
    serve('{broken');
    document.documentElement.setAttribute('data-look', CYBER);
    runIndexStylesScript();
    expect(document.getElementById(`ut-look-${CYBER}`)?.getAttribute('href')).toBe(
      `/looks/${CYBER}.css`
    );
  });
});
