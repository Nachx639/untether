/**
 * The interface style chosen on this device, or the server's default (`look` in config.json).
 * Applied as `data-look` on <html>, and its stylesheet (public/looks/<id>.css, built by
 * scripts/copy-assets.js) is loaded only when it is needed: the chosen one, and all of them while
 * the picker shows their miniatures.
 *
 * Before the first paint (assets/theme-init.js, index.html) the page needs the registry for
 * nothing: a device with its own choice reads LOOK_BOOT_KEY (id, forced mode, backgrounds), kept
 * current here; one without reads the same from the server's `look`, written into index.html
 * (server/utils/shell-version.ts), so even its very first frame is right.
 *
 * What wins: this device's choice, then the server's default, then Original. Picking Original is a
 * choice too: it keeps a device on Original even with a server default.
 */
import {
  findLook,
  forcedLookMode,
  type Look,
  lookBoot,
  ORIGINAL_LOOK_ID,
} from '../../shared/looks.js';
import { isBuildId, LOOK_VERSIONS_META } from '../../shared/shell-version.js';
import { syncThemeColorMeta } from './accent-themes.js';
import { syncThemeMode } from './theme-mode.js';

export const LOOK_STORAGE_KEY = 'untether-look';
export const LOOK_BOOT_KEY = 'untether-look-boot';
export const LOOK_CHANGED_EVENT = 'untether-look-changed';
/** The id of the <link> of a style's sheet (index.html adds the first one the same way). */
export const lookLinkId = (id: string) => `ut-look-${id}`;

/**
 * A style's sheet, named by its content (2026-11-10): index.html, always from the network, says
 * each sheet's version (shared/shell-version.ts LOOK_VERSIONS_META), so a sheet that changed on
 * the server is another URL and the service worker's copy of the old one is never shown.
 * index.html builds its first <link> the same way.
 */
export function lookHref(id: string): string {
  let version: unknown;
  try {
    const meta = document.querySelector(`meta[name="${LOOK_VERSIONS_META}"]`);
    version = (JSON.parse(meta?.getAttribute('content') || '{}') as Record<string, unknown>)[id];
  } catch {
    // No versions in this page: the plain URL, from the network.
  }
  return isBuildId(version) ? `/looks/${id}.css?v=${version}` : `/looks/${id}.css`;
}

function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not persisted; still applied for this page.
  }
}

function storageRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Nothing to remove.
  }
}

/** This device's own choice, if it has made one. */
export function getDeviceLook(): string | null {
  const saved = storageGet(LOOK_STORAGE_KEY);
  return findLook(saved) ? saved : null;
}

/** The style showing now. */
export function getActiveLook(): Look {
  return (
    findLook(document.documentElement.getAttribute('data-look')) ??
    (findLook(ORIGINAL_LOOK_ID) as Look)
  );
}

function writeBoot(look: Look): void {
  if (look.id === ORIGINAL_LOOK_ID) storageRemove(LOOK_BOOT_KEY);
  else storageSet(LOOK_BOOT_KEY, JSON.stringify(lookBoot(look)));
}

/** Resolves when `link` loaded (true) or failed (false: gone, so the next try fetches it again). */
function linkSettled(link: HTMLLinkElement): Promise<boolean> {
  return new Promise((resolve) => {
    link.addEventListener(
      'load',
      () => {
        link.dataset.loaded = '1';
        resolve(true);
      },
      { once: true }
    );
    link.addEventListener(
      'error',
      () => {
        link.remove();
        resolve(false);
      },
      { once: true }
    );
  });
}

/** Loads a style's sheet once; false when it could not be had (offline with nothing cached). */
export function loadLookStylesheet(id: string): Promise<boolean> {
  if (id === ORIGINAL_LOOK_ID) return Promise.resolve(true);
  const existing = document.getElementById(lookLinkId(id)) as HTMLLinkElement | null;
  if (existing) {
    if (existing.sheet || existing.dataset.loaded) return Promise.resolve(true);
    if (!existing.dataset.settled) return linkSettled(existing);
    // index.html gave up on it (failed, or 3 s without an answer): a fresh try.
    existing.remove();
  }
  const link = document.createElement('link');
  link.id = lookLinkId(id);
  link.rel = 'stylesheet';
  link.href = lookHref(id);
  const settled = linkSettled(link);
  document.head.appendChild(link);
  return settled;
}

/** How showing a style ended; superseded: a later pick took over while its sheet loaded. */
export type LookResult = 'shown' | 'failed' | 'superseded';

let applyGeneration = 0;

/**
 * Shows a style once its sheet is in, and only then remembers it for the first paint. Without the
 * sheet its mode must not apply either: back to the app's own tokens for this page.
 * The saved choice stays, so the next load tries again.
 */
async function show(look: Look): Promise<LookResult> {
  const generation = ++applyGeneration;
  const loaded = await loadLookStylesheet(look.id);
  // A later pick arrived while this sheet loaded: that one decides.
  if (generation !== applyGeneration) return 'superseded';
  const root = document.documentElement;
  if (loaded) writeBoot(look);
  if (!loaded && root.getAttribute('data-look') !== look.id) return 'failed';
  if (look.id === ORIGINAL_LOOK_ID || !loaded) root.removeAttribute('data-look');
  else root.setAttribute('data-look', look.id);
  syncThemeMode();
  syncThemeColorMeta();
  window.dispatchEvent(
    new CustomEvent(LOOK_CHANGED_EVENT, { detail: { look: root.getAttribute('data-look') } })
  );
  return loaded ? 'shown' : 'failed';
}

/** This device's choice: applied at once and remembered, once its sheet is in. */
export async function applyLook(id: string): Promise<LookResult> {
  const look = findLook(id) ?? (findLook(ORIGINAL_LOOK_ID) as Look);
  const result = await show(look);
  if (result === 'shown') storageSet(LOOK_STORAGE_KEY, look.id);
  return result;
}

let serverDefault: string | undefined;

/** The server's default as last heard; undefined when none or unknown. */
export function getServerLook(): Look | undefined {
  return findLook(serverDefault);
}

/**
 * Sets the style for this device at start, once the server's `look` is known: its own choice if
 * it has one, otherwise the server's. It also repairs a boot entry lost by clearing site data.
 */
export function setServerDefaultLook(id: string | undefined): Promise<LookResult> {
  serverDefault = findLook(id) ? id : undefined;
  return show(findLook(getDeviceLook() ?? serverDefault) ?? (findLook(ORIGINAL_LOOK_ID) as Look));
}

/** Drops this device's choice and follows the server's default again. */
export async function followServerLook(): Promise<LookResult> {
  const result = await show(findLook(serverDefault) ?? (findLook(ORIGINAL_LOOK_ID) as Look));
  if (result === 'shown') storageRemove(LOOK_STORAGE_KEY);
  return result;
}

/** Whether the active style forces a mode, so the mode control must show disabled. */
export function lockedThemeMode(): 'light' | 'dark' | undefined {
  return forcedLookMode(getActiveLook());
}

/** Whether the active style keeps its own accent. */
export function accentFixedByLook(): boolean {
  return getActiveLook().fixedAccent;
}
