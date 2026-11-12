/**
 * Last line of defence against a page running one build's JS with another build's CSS
 * (2026-10-04, shared/shell-version.ts): the bundle knows its build id, the stylesheet declares
 * its own in `--ut-build`; when both are known and differ, the page logs it and reloads, at most
 * once a minute. A reload asks index.html again, which names the current shell version, and the
 * service worker serves that version whole.
 *
 * Import this module from app-entry.ts only: the build writes the id into the entry file and
 * refuses a chunk that holds it (scripts/client-build-id.js).
 */
import {
  buildIdInBundle,
  buildIdInCss,
  buildsDiffer,
  CSS_BUILD_PROPERTY,
} from '../../shared/shell-version.js';
import { createLogger } from './logger.js';

/** Replaced by the build with `ut-build-id:<id>`: keep it one literal, same length. */
const BUILD_MARK = 'ut-build-id:__UT_BUILD_ID__0';

/** This bundle's build id, or null in a build that didn't stamp it (tests, build-ci.js). */
export function bundleBuildId(mark: string = BUILD_MARK): string | null {
  return buildIdInBundle(mark);
}

const RELOAD_KEY = 'ut-build-mismatch-reload-at';
const RELOAD_MIN_INTERVAL_MS = 60_000;

export type ShellBuildCheck = 'match' | 'unknown' | 'reloading' | 'mismatch';

export interface ShellBuildCheckOptions {
  js: string | null;
  /** The computed value of `--ut-build` ('' when the stylesheet has none or didn't load). */
  cssValue: string;
  reload: () => void;
  log: { warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void };
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
  now?: () => number;
}

/** Compares the two ids; on a mismatch reloads unless the page did so less than a minute ago. */
export function checkShellBuild(options: ShellBuildCheckOptions): ShellBuildCheck {
  const css = buildIdInCss(options.cssValue);
  if (!options.js || !css) return 'unknown';
  if (!buildsDiffer(options.js, css)) return 'match';
  const now = options.now?.() ?? Date.now();
  let allowed = true;
  try {
    const last = Number(options.storage?.getItem(RELOAD_KEY)) || 0;
    allowed = now - last >= RELOAD_MIN_INTERVAL_MS;
    if (allowed) options.storage?.setItem(RELOAD_KEY, String(now));
  } catch {
    // Storage blocked: the interval can't be kept, so don't reload (no loop).
    allowed = false;
  }
  if (!allowed) {
    options.log.error(
      `bundle build ${options.js} runs with stylesheet build ${css}; already reloaded within a minute, not again`
    );
    return 'mismatch';
  }
  options.log.warn(`bundle build ${options.js} runs with stylesheet build ${css}: reloading`);
  options.reload();
  return 'reloading';
}

/** Runs the check once the stylesheet applies (index.html sets `data-ut-styles` then). */
export function startShellBuildCheck(): void {
  const root = document.documentElement;
  const run = () => {
    try {
      checkShellBuild({
        js: bundleBuildId(),
        cssValue: getComputedStyle(root).getPropertyValue(CSS_BUILD_PROPERTY),
        reload: () => window.location.reload(),
        log: createLogger('shell-build'),
        storage: window.sessionStorage,
      });
    } catch {
      // Never let the check itself break the start.
    }
  };
  // logs.html links the stylesheet the blocking way: applied before this script runs.
  if (root.hasAttribute('data-ut-styles') || !document.getElementById('ut-styles')) {
    run();
    return;
  }
  const observer = new MutationObserver(() => {
    if (!root.hasAttribute('data-ut-styles')) return;
    observer.disconnect();
    run();
  });
  observer.observe(root, { attributes: true, attributeFilter: ['data-ut-styles'] });
}
