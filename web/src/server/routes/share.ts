/**
 * Read-only share links (see services/share-store.ts).
 *
 * Public, outside /api and its login: `GET /share/<token>`, a small standalone page (not the
 * app) that shows the session's screen, and `GET /share/<token>/screen`, its feed. Nothing
 * there can type into the session, list other sessions or reach the API; an unknown, revoked
 * or expired token gets 404. Under /api (logged in): create, list and revoke links.
 */
import { randomBytes } from 'node:crypto';
import { type Request, type Response, Router } from 'express';
import { SHARE_DURATIONS_MIN, type ShareRecord, type ShareStore } from '../services/share-store.js';

export interface ShareScreen {
  title: string;
  running: boolean;
  /** The screen as plain text (the viewer shows it with textContent, never as HTML). */
  text: string;
  cols: number;
}

export interface ShareRoutesConfig {
  store: ShareStore;
  sessionExists: (sessionId: string) => boolean;
  /** The session's current screen, or null when the session is gone. */
  readScreen: (sessionId: string) => Promise<ShareScreen | null>;
}

const STRINGS = {
  es: {
    title: 'Sesión compartida',
    live: 'En directo',
    ended: 'La sesión terminó',
    readOnly: 'Solo lectura',
    expiresIn: 'caduca en',
    expired: 'Este enlace ha caducado o se ha revocado.',
    offline: 'Sin conexión, reintentando…',
    minutes: 'min',
    hours: 'h',
  },
  en: {
    title: 'Shared session',
    live: 'Live',
    ended: 'The session ended',
    readOnly: 'Read only',
    expiresIn: 'expires in',
    expired: 'This link has expired or was revoked.',
    offline: 'Offline, retrying…',
    minutes: 'min',
    hours: 'h',
  },
};

function language(req: Request): keyof typeof STRINGS {
  return /^es\b/i.test(String(req.headers['accept-language'] ?? '')) ? 'es' : 'en';
}

function privateHeaders(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

/** What the app gets for a link: its page path, never a full URL (the app knows its origin). */
export function shareItem(record: ShareRecord) {
  return {
    token: record.token,
    path: `/share/${record.token}`,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
  };
}

function viewerPage(lang: keyof typeof STRINGS, nonce: string, valid: boolean): string {
  const s = STRINGS[lang];
  // JSON in a non-script type is data: CSP doesn't run it, the page script reads it.
  const strings = JSON.stringify(s).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<title>${s.title} · Untether</title>
<style>
  :root { color-scheme: light dark; --bg: #fafafa; --fg: #1a1a1a; --muted: #6b6b6b; --line: #e3e3e3; --live: #16a34a; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0a0a0a; --fg: #e6e6e6; --muted: #8a8a8a; --line: #262626; } }
  html, body { margin: 0; background: var(--bg); color: var(--fg); }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, system-ui, sans-serif; }
  header { position: sticky; top: 0; background: var(--bg); border-bottom: 1px solid var(--line);
    padding: calc(10px + env(safe-area-inset-top)) 16px 10px; }
  #name { font-weight: 600; font-size: 16px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #meta { margin-top: 2px; font-size: 13px; color: var(--muted); display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--live); display: inline-block; }
  .dot.off { background: var(--muted); }
  pre { margin: 0; padding: 12px 12px calc(16px + env(safe-area-inset-bottom)); overflow-x: auto;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; line-height: 1.3; white-space: pre; }
  #notice { padding: 24px 16px; color: var(--muted); font-size: 15px; }
</style>
</head>
<body>
<header>
  <div id="name">${valid ? '' : s.title}</div>
  ${valid ? `<div id="meta"><span class="dot" id="dot"></span><span id="state">${s.live}</span><span>· ${s.readOnly}</span><span id="expiry"></span></div>` : ''}
</header>
${valid ? '<pre id="screen" aria-live="off"></pre>' : `<div id="notice">${s.expired}</div>`}
<script type="application/json" id="ut-strings">${strings}</script>
<script nonce="${nonce}">
(() => {
  const s = JSON.parse(document.getElementById('ut-strings').textContent);
  const screen = document.getElementById('screen');
  if (!screen) return;
  const name = document.getElementById('name');
  const state = document.getElementById('state');
  const dot = document.getElementById('dot');
  const expiry = document.getElementById('expiry');
  const feed = location.pathname.replace(/\\/+$/, '') + '/screen';
  let cols = 80;
  let expiresAt = 0;
  let stopped = false;
  const fit = () => {
    const size = Math.max(7, Math.min(14, (document.documentElement.clientWidth - 24) / (cols * 0.6)));
    screen.style.fontSize = size.toFixed(2) + 'px';
  };
  const left = () => {
    const minutes = Math.max(0, Math.round((expiresAt - Date.now()) / 60000));
    expiry.textContent = expiresAt ? '· ' + s.expiresIn + ' ' + (minutes >= 90 ? Math.round(minutes / 60) + ' ' + s.hours : minutes + ' ' + s.minutes) : '';
  };
  const expired = () => {
    stopped = true;
    document.getElementById('meta').remove();
    const notice = document.createElement('div');
    notice.id = 'notice';
    notice.textContent = s.expired;
    screen.replaceWith(notice);
  };
  async function tick() {
    if (stopped) return;
    try {
      const response = await fetch(feed, { cache: 'no-store', credentials: 'omit' });
      if (response.status === 404) return expired();
      const data = await response.json();
      expiresAt = data.expiresAt || 0;
      left();
      if (data.ended) {
        dot.className = 'dot off';
        state.textContent = s.ended;
        return;
      }
      name.textContent = data.title || '';
      document.title = (data.title || s.title) + ' · Untether';
      dot.className = data.running ? 'dot' : 'dot off';
      state.textContent = data.running ? s.live : s.ended;
      if (data.cols && data.cols !== cols) { cols = data.cols; fit(); }
      const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 40;
      if (screen.textContent !== data.text) {
        screen.textContent = data.text;
        if (atBottom) window.scrollTo(0, document.documentElement.scrollHeight);
      }
    } catch {
      state.textContent = s.offline;
      dot.className = 'dot off';
    }
  }
  const loop = async () => {
    if (!document.hidden) await tick();
    if (!stopped) setTimeout(loop, 1500);
  };
  window.addEventListener('resize', fit);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
  fit();
  loop();
})();
</script>
</body>
</html>
`;
}

/** Public (no login): the viewer page and its screen feed. */
export function createShareViewRoutes(config: ShareRoutesConfig): Router {
  const router = Router();

  router.get('/share/:token', (req, res) => {
    privateHeaders(res);
    const valid = Boolean(config.store.get(req.params.token));
    const nonce = randomBytes(16).toString('base64');
    res.setHeader(
      'Content-Security-Policy',
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
    );
    res
      .status(valid ? 200 : 404)
      .type('html')
      .send(viewerPage(language(req), nonce, valid));
  });

  router.get('/share/:token/screen', async (req, res) => {
    privateHeaders(res);
    const record = config.store.get(req.params.token);
    if (!record) {
      res.status(404).json({ error: 'Link expired or revoked' });
      return;
    }
    const screen = await config.readScreen(record.sessionId).catch(() => null);
    res.json({ expiresAt: record.expiresAt, ...(screen ?? { ended: true }) });
  });

  return router;
}

/** Under /api (logged in): create, list and revoke a session's links. */
export function createShareApiRoutes(config: ShareRoutesConfig): Router {
  const router = Router();

  router.post('/sessions/:sessionId/shares', (req, res) => {
    const { sessionId } = req.params;
    if (!config.sessionExists(sessionId)) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const minutes = Number(req.body?.minutes ?? SHARE_DURATIONS_MIN[1]);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      res.status(400).json({ error: 'Invalid duration' });
      return;
    }
    res.status(201).json({ share: shareItem(config.store.create(sessionId, minutes)) });
  });

  router.get('/sessions/:sessionId/shares', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ shares: config.store.listFor(req.params.sessionId).map(shareItem) });
  });

  router.delete('/shares/:token', (req, res) => {
    const revoked = config.store.revoke(req.params.token);
    res.status(revoked ? 200 : 404).json({ revoked });
  });

  return router;
}
