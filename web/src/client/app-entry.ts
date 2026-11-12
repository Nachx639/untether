// Entry point for the app
// When the bundle started running, for the startup line below (taken before the imports run).
import { appCodeStart } from './utils/app-code-start.js';
import './services/push-notification-service.js';
import './app.js';
import { lazyViews, preloadSessionViewNow } from './utils/lazy-views.js';
import { createLogger } from './utils/logger.js';
import { startShellBuildCheck } from './utils/shell-build-check.js';
import { describeStartupTiming, readStartupTimes } from './utils/startup-timing.js';

// This bundle and the stylesheet must come from one build; reloads once if not
// (utils/shell-build-check.ts).
startShellBuildCheck();

// Opened on a session: its view and the terminal's WASM load alongside the app's first
// requests instead of after them (utils/lazy-views.ts).
preloadSessionViewNow();

// logs.html runs this bundle for its <log-viewer>, which is a chunk of its own.
if (document.querySelector('log-viewer')) void lazyViews.logViewer.require();

// Where the time before the app went on this load, one line in the FE log
// (utils/startup-timing.ts): after `load`, so the paint entries exist.
const logStartup = () =>
  setTimeout(() => {
    try {
      createLogger('startup').log(describeStartupTiming(readStartupTimes(appCodeStart)));
    } catch {
      // No Performance Timing: nothing to log.
    }
  }, 0);
if (document.readyState === 'complete') logStartup();
else window.addEventListener('load', logStartup, { once: true });

// QA aid: `?layoutcheck` logs elements sticking out of the screen (utils/layout-check.ts).
// Its code is a separate chunk, fetched only when asked.
try {
  if (location.search.includes('layoutcheck') || sessionStorage.getItem('ut-layoutcheck') === '1') {
    void import('./utils/layout-check.js').then((module) => module.startLayoutCheckIfAsked());
  }
} catch {
  // Storage blocked: no layout check.
}

// Monaco (~4.3 MB of JS) is loaded on demand by <monaco-editor> the first time a file is opened;
// loading it at startup made every phone download and parse it before the session list.

// Initialize push notification service
// This will register the service worker and set up push notifications
// The services are initialized automatically when imported

// Handle notification actions from service worker
window.addEventListener('notification-action', ((event: CustomEvent) => {
  const { action, data } = event.detail;

  // Dispatch the action to the main app component
  const app = document.querySelector('untether-app');
  if (app) {
    app.dispatchEvent(
      new CustomEvent('notification-action', {
        detail: { action, data },
      })
    );
  }
}) as EventListener);
