/**
 * Offline fallback for the installed web app. When the Mac (or the tailnet) can't be
 * reached, a page load would otherwise end on Safari's bare "can't connect" screen with no
 * way back except killing the app. The service worker answers failed page loads with a
 * small page that keeps retrying and reloads itself once the server answers again.
 *
 * Only that page is ever cached: it holds static, localized text and no session data. API
 * calls, assets and successful page loads always go straight to the network.
 */

export const OFFLINE_CACHE = 'untether-offline-v1';
/** Cache key of the localized page the client stores (see utils/offline-page.ts). */
export const OFFLINE_PAGE_URL = '/__untether-offline';
/** Static and unauthenticated: answers only when the server itself is up. */
export const OFFLINE_PROBE_URL = '/manifest.json';

export interface OfflineStrings {
  lang: string;
  dir: 'ltr' | 'rtl';
  title: string;
  body: string;
  retrying: string;
  retryNow: string;
}

export const DEFAULT_OFFLINE_STRINGS: OfflineStrings = {
  lang: 'en',
  dir: 'ltr',
  title: "Can't reach your Mac",
  body: 'Untether will reconnect as soon as your Mac is awake and on the network.',
  retrying: 'Retrying…',
  retryNow: 'Retry now',
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderOfflinePage(strings: OfflineStrings = DEFAULT_OFFLINE_STRINGS): string {
  const s = {
    lang: escapeHtml(strings.lang),
    dir: strings.dir === 'rtl' ? 'rtl' : 'ltr',
    title: escapeHtml(strings.title),
    body: escapeHtml(strings.body),
    retrying: escapeHtml(strings.retrying),
    retryNow: escapeHtml(strings.retryNow),
  };
  return `<!doctype html>
<html lang="${s.lang}" dir="${s.dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark light">
<meta name="theme-color" content="#0a0a0a">
<title>Untether</title>
<style>
:root { --color-bg: #0a0a0a; --color-text: #e5e5e5; --color-muted: #a3a3a3; --color-accent: #ff6a00; --color-button-text: #0a0a0a; }
@media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) { --color-bg: #fafafa; --color-text: #171717; --color-muted: #525252; --color-accent: #b03a00; --color-button-text: #ffffff; } }
:root[data-theme="light"] { --color-bg: #fafafa; --color-text: #171717; --color-muted: #525252; --color-accent: #b03a00; --color-button-text: #ffffff; }
html, body { margin: 0; height: 100%; background: var(--color-bg); color: var(--color-text); }
body { display: flex; align-items: center; justify-content: center; font: 16px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  padding: env(safe-area-inset-top) 24px env(safe-area-inset-bottom); box-sizing: border-box; text-align: center; }
main { max-width: 22rem; }
img { width: 72px; height: 72px; border-radius: 16px; margin-bottom: 20px; }
h1 { font-size: 1.25rem; margin: 0 0 8px; }
p { margin: 0 0 20px; color: var(--color-muted); }
#status { font-size: 0.875rem; }
button { font: inherit; font-weight: 600; border: 0; border-radius: 999px; padding: 12px 28px; min-height: 44px;
  background: var(--color-accent); color: var(--color-button-text); }
</style>
</head>
<body>
<main>
<img src="/apple-touch-icon.png" alt="" onerror="this.remove()">
<h1>${s.title}</h1>
<p>${s.body}</p>
<p id="status" aria-live="polite">${s.retrying}</p>
<button id="retry" type="button">${s.retryNow}</button>
</main>
<script>
(function () {
  try {
    var theme = localStorage.getItem('untether-theme');
    if (theme === 'dark' || theme === 'light') document.documentElement.setAttribute('data-theme', theme);
  } catch (_) {}
  var delay = 2000, timer = null, busy = false;
  function schedule() { clearTimeout(timer); timer = setTimeout(probe, delay); delay = Math.min(delay * 2, 30000); }
  function probe() {
    if (busy) return;
    busy = true;
    fetch(${JSON.stringify(OFFLINE_PROBE_URL)}, { cache: 'no-store' })
      .then(function (r) { if (r.ok) location.reload(); else schedule(); })
      .catch(schedule)
      .then(function () { busy = false; });
  }
  document.getElementById('retry').addEventListener('click', function () { delay = 2000; probe(); });
  window.addEventListener('online', function () { delay = 2000; probe(); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) { delay = 2000; probe(); } });
  schedule();
})();
</script>
</body>
</html>`;
}

/** Page loads the worker should guard: same-origin navigations outside the API. */
export function isGuardedNavigation(request: Request, origin: string): boolean {
  if (request.mode !== 'navigate' || request.method !== 'GET') return false;
  const url = new URL(request.url);
  return url.origin === origin && !url.pathname.startsWith('/api/');
}

/**
 * Network first, always. Only a failed load (network error, not an HTTP error status)
 * gets the offline page; nothing from the network is ever stored.
 */
export async function respondToNavigation(
  network: () => Promise<Response>,
  cachedOfflinePage: () => Promise<Response | undefined>
): Promise<Response> {
  try {
    return await network();
  } catch {
    const cached = await cachedOfflinePage().catch(() => undefined);
    if (cached) return cached;
    return new Response(renderOfflinePage(), {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }
}
