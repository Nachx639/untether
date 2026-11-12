/**
 * Views the session list doesn't show load as a separate chunk (esbuild `splitting`, see
 * scripts/esbuild-config.js and deferred-views.ts): the session view with its terminal and
 * chats, previews, the file browser, settings, the sheets. They were ~2/3 of the bundle every
 * phone downloaded and parsed before the list could show (2026-10-04, docs/cold-start.md).
 *
 * Once the list is up, `preloadLazyViews()` fetches them in idle time, so opening one is
 * normally instant. A view the user opens before then waits for the chunk.
 *
 * Chunk files carry a content hash. A page still running an older build asks for that build's
 * chunks, which a later build removes (scripts/esbuild-config.js cleanClientChunks): when a
 * chunk the user is waiting for can't be fetched, even on a second try, the page reloads once
 * to pick up the current build (`require()`).
 */
import { createLogger } from './logger.js';

const logger = createLogger('lazy-views');

/** sessionStorage: when a missing chunk last reloaded the page (one reload per minute at most). */
const CHUNK_RELOAD_KEY = 'ut-chunk-reload-at';
const CHUNK_RELOAD_MIN_INTERVAL_MS = 60_000;
const CHUNK_RETRY_DELAY_MS = 1000;

export interface LazyModule<T> {
  /** Fetches it once; a failed fetch is tried again by the next call. */
  load(): Promise<T>;
  /**
   * For a user waiting on it: a failed fetch is retried once after a second, and if that fails
   * too the page reloads (at most once a minute) since the build it belongs to is likely gone.
   */
  require(): Promise<T>;
  /** The module once loaded. */
  readonly module: T | undefined;
  /**
   * Runs `fn` with the module: right away when it is loaded (as before it was lazy), else once
   * `require()` has it.
   */
  use(fn: (module: T) => void): void;
}

function useWith<T>(lazy: Pick<LazyModule<T>, 'module' | 'require'>, fn: (module: T) => void) {
  const loaded = lazy.module;
  if (loaded !== undefined) {
    fn(loaded);
    return;
  }
  lazy.require().then(fn, () => {});
}

export function lazyModule<T>(importer: () => Promise<T>): LazyModule<T> {
  let pending: Promise<T> | null = null;
  let loaded: T | undefined;

  const load = (): Promise<T> => {
    pending ??= importer().then(
      (module) => {
        loaded = module;
        return module;
      },
      (error: unknown) => {
        pending = null;
        throw error;
      }
    );
    return pending;
  };

  const require = async (): Promise<T> => {
    try {
      return await load();
    } catch (first) {
      logger.warn('chunk failed to load, retrying', first);
      await new Promise((resolve) => setTimeout(resolve, CHUNK_RETRY_DELAY_MS));
      try {
        return await load();
      } catch (second) {
        reloadForNewBuild(second);
        throw second;
      }
    }
  };

  const lazy: LazyModule<T> = {
    load,
    require,
    get module() {
      return loaded;
    },
    use: (fn) => useWith(lazy, fn),
  };
  return lazy;
}

function reloadForNewBuild(error: unknown) {
  try {
    const last = Number(window.sessionStorage.getItem(CHUNK_RELOAD_KEY)) || 0;
    if (Date.now() - last < CHUNK_RELOAD_MIN_INTERVAL_MS) {
      logger.error('chunk failed to load again after a reload', error);
      return;
    }
    window.sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now()));
  } catch {
    // Storage blocked: reload anyway, the interval just isn't enforced.
  }
  logger.warn('chunk is gone (new build?): reloading', error);
  window.location.reload();
}

type DeferredViews = typeof import('../deferred-views.js');

/** The views chunk (deferred-views.ts). */
const deferredViews = lazyModule(() => import('../deferred-views.js'));

/** One view of the views chunk: loading it loads them all. */
function deferredView<K extends keyof DeferredViews>(name: K): LazyModule<DeferredViews[K]> {
  const view: LazyModule<DeferredViews[K]> = {
    load: () => deferredViews.load().then((views) => views[name]),
    require: () => deferredViews.require().then((views) => views[name]),
    get module() {
      return deferredViews.module?.[name];
    },
    use: (fn) => useWith(view, fn),
  };
  return view;
}

/** The views loaded on demand. */
export const lazyViews = {
  sessionView: deferredView('sessionView'),
  previewView: deferredView('previewView'),
  previewPanel: deferredView('previewPanel'),
  fileBrowser: deferredView('fileBrowser'),
  settings: deferredView('settings'),
  sessionCreateForm: deferredView('sessionCreateForm'),
  multiplexerModal: deferredView('multiplexerModal'),
  sshKeyManager: deferredView('sshKeyManager'),
  macSessionView: deferredView('macSessionView'),
  macShareSheet: deferredView('macShareSheet'),
  claudeHistory: deferredView('claudeHistory'),
  answerSheet: deferredView('answerSheet'),
  taskSheet: deferredView('taskSheet'),
  taskConfirmSheet: deferredView('taskConfirmSheet'),
  /** A task row's "Ver cambios" (the session view's changes sheet). */
  changesSheet: deferredView('changesSheet'),
  projectSettingsSheet: deferredView('projectSettingsSheet'),
  taskComposeSheet: deferredView('taskComposeSheet'),
  /** A project's "Orquestar" (P7). */
  orchestratorSheet: deferredView('orchestratorSheet'),
  /** "+ Tarea" / "Orquestar" on a folder without git: turn version control on first. */
  gitInitSheet: deferredView('gitInitSheet'),
  /** «Nuevo proyecto»: a folder with git, pinned on the board (and orchestrated with a goal). */
  newProjectSheet: deferredView('newProjectSheet'),
  copilotSheet: deferredView('copilotSheet'),
  /** logs.html only: not part of the app's views. */
  logViewer: lazyModule(() => import('../components/log-viewer.js')),
};

let preloadStarted = false;

/**
 * Fetches the views chunk in idle time once the list is on screen, then `onLoaded` (the app
 * renders its hidden modals then). A failure is silent (the server may be restarting): opening
 * a view tries again.
 */
export function preloadLazyViews(onLoaded: () => void = () => {}) {
  if (preloadStarted) return;
  preloadStarted = true;
  const requestIdle = (
    window as Window & { requestIdleCallback?: (cb: () => void, o?: object) => number }
  ).requestIdleCallback;
  const start = () => {
    deferredViews.load().then(
      (views) => {
        views.preloadGhosttyModule();
        onLoaded();
      },
      () => {}
    );
  };
  if (requestIdle) requestIdle(start, { timeout: 2000 });
  else setTimeout(start, 200);
}

/**
 * A session's page loaded directly (or the app reopened on one): fetch the views chunk and the
 * terminal's WASM right away, not after the session list. User report 2026-10-14: on a cold
 * start the terminal waited for /api/sessions, then the chunk, then the WASM, one after the
 * other, before its history was even asked for. Failures are silent: opening the view retries.
 */
export function preloadSessionViewNow(pathname: string = window.location.pathname): boolean {
  if (!pathname.startsWith('/session/')) return false;
  deferredViews.load().then(
    (views) => views.preloadGhosttyModule(),
    () => {}
  );
  return true;
}
