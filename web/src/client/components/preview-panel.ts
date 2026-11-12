/**
 * Dev-server preview (phones first): the app a session is building, in an iframe on the
 * preview origin (same host, preview port: server/services/preview-server.ts), with an
 * address bar, back/forward, reload, "Open in Safari" and a split mode that leaves the
 * session visible underneath.
 *
 * The preview origin is separate so the previewed app can't read Untether's token. Every
 * load trades the bearer token for a 60 s single-use ticket (POST /api/preview/ticket) and
 * opens `<preview origin>/__ut_preview_login?ticket=…`, which sets that origin's own cookie.
 * The previewed page reports its path by postMessage; back/forward go to it the same way.
 *
 * Rendered into <body> like the other phone sheets.
 */

import { html, nothing, render } from 'lit';
import { estimateKeyboardHeight } from '../../shared/input-diagnostics.js';
import { t } from '../i18n/index.js';
import { swallowNextClick } from '../utils/ghost-click.js';
import { endsADrag } from '../utils/pointer-drag.js';

export interface PreviewPanelOptions {
  sessionId: string;
  /** Dev-server ports known for the session, newest first. */
  ports: number[];
  /** Port to show; defaults to the first known one. */
  port?: number;
  /** Path inside the app, "/" by default. */
  path?: string;
  /** Force a mode (the preview view's "show beside the session" asks for split). */
  mode?: 'split' | 'full';
  authHeader?: () => Record<string, string>;
}

type Mode = 'split' | 'full';

/** Clicks finishing the gesture that opened the panel must not hit its buttons. */
export const PREVIEW_OPEN_GUARD_MS = 500;
const SPLIT_KEY = 'ut-preview-split';
const MIN_SPLIT = 160;
/** Room the session keeps below the divider: its header, a few lines/messages and the composer. */
export const MIN_SESSION_SPACE = 300;

let openHost: HTMLElement | null = null;
let cleanup: (() => void) | null = null;
let current: { sessionId: string; show: (port: number, path: string) => void } | null = null;

/** Visible height: the visual viewport (what the keyboard leaves), else the window. */
function viewportHeight(): number {
  return Math.round(window.visualViewport?.height ?? window.innerHeight);
}

/**
 * The on-screen keyboard is up. With `interactive-widget=resizes-content` iOS shrinks the
 * layout viewport together with the visual one, so "innerHeight − visual height" stayed ~0 and
 * the split preview never gave way to the keyboard (2026-10-03, iPhone SE): compare with the
 * tallest visual viewport seen at this width as well, like the session view does.
 */
let tallestViewport = 0;
let tallestAtWidth = 0;
export function isKeyboardOpen(): boolean {
  const vv = window.visualViewport;
  if (!vv) return false;
  if (window.innerWidth !== tallestAtWidth) {
    tallestAtWidth = window.innerWidth;
    tallestViewport = 0;
  }
  tallestViewport = Math.max(tallestViewport, vv.height);
  return estimateKeyboardHeight(window.innerHeight, vv.height, tallestViewport) > 120;
}

/** Tests: forget the tallest viewport seen. */
export function resetKeyboardTrackingForTests(): void {
  tallestViewport = 0;
  tallestAtWidth = 0;
}

export function isPreviewPanelOpen(): boolean {
  return openHost !== null;
}

/**
 * In split mode the session is pushed below the panel instead of hidden under it: the
 * panel covered the top of the terminal, where the dev server's output was (2026-10-03).
 * The terminal then fits the space left and shows its latest lines.
 */
let lastOffset = 0;
function syncSessionOffset(px: number): void {
  const body = document.body;
  const changed = px !== lastOffset;
  lastOffset = px;
  if (px > 0) {
    body.style.setProperty('--ut-preview-offset', `${px}px`);
    body.classList.add('preview-split-open');
  } else {
    body.style.removeProperty('--ut-preview-offset');
    body.classList.remove('preview-split-open');
  }
  if (!changed) return;
  window.dispatchEvent(new Event('resize'));
  // Chat mode: the conversation keeps showing its latest message in the space it has now.
  requestAnimationFrame(() => {
    (
      document.querySelector('claude-chat-view') as
        | (HTMLElement & { followLatest?: () => void })
        | null
    )?.followLatest?.();
  });
}

export function closePreviewPanel(): void {
  syncSessionOffset(0);
  cleanup?.();
  cleanup = null;
  openHost?.remove();
  openHost = null;
  current = null;
}

/** `/preview/<port><path>` with a path that always starts with "/". */
export function previewUrl(port: number, path = '/'): string {
  return `/preview/${port}${path.startsWith('/') ? path : `/${path}`}`;
}

export interface PreviewConfig {
  enabled: boolean;
  port: number | null;
  /** Explicit public origin (UNTETHER_PREVIEW_ORIGIN), else same host + preview port. */
  origin?: string | null;
}

/** `https://host:4020` + preview port 4021 → `https://host:4021` (same scheme and host). */
export function previewOriginFor(pageUrl: string, config: PreviewConfig): string | null {
  if (!config.enabled) return null;
  if (config.origin) return config.origin;
  if (!config.port) return null;
  const url = new URL(pageUrl);
  url.port = String(config.port);
  return url.origin;
}

/** Iframe sandbox: everything an app needs, but it can't navigate Untether's page. */
export const PREVIEW_SANDBOX =
  'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads';

function readSetting(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSetting(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode: the panel just forgets its size.
  }
}

export function openPreviewPanel(options: PreviewPanelOptions): void {
  // Already open for this session (a second `ut open`): just show the new port/path.
  if (current && current.sessionId === options.sessionId) {
    const port = options.port ?? options.ports[0];
    if (port) current.show(port, options.path ?? '/');
    return;
  }
  closePreviewPanel();
  const host = document.createElement('div');
  host.className = 'pv-host';
  document.body.appendChild(host);
  openHost = host;
  const openedAt = Date.now();
  const isOpen = () => openHost === host;

  let ports = [...options.ports];
  let port: number | null = options.port ?? ports[0] ?? null;
  let path = options.path ?? '/';
  let src = '';
  let draft = path;
  let portDraft = '';
  let authed: 'pending' | 'ok' | 'failed' = 'pending';
  let previewOrigin: string | null = null;
  let loadSeq = 0;
  const authHeaders = () => ({ ...options.authHeader?.() });

  const getPreviewOrigin = async (): Promise<string> => {
    if (previewOrigin) return previewOrigin;
    const response = await fetch('/api/preview/config', { headers: authHeaders() });
    if (!response.ok) throw new Error(`config ${response.status}`);
    const origin = previewOriginFor(window.location.href, (await response.json()) as PreviewConfig);
    if (!origin) throw new Error('previews disabled');
    previewOrigin = origin;
    return origin;
  };

  /** A fresh login URL on the preview origin for one load of `port` + `path`. */
  const ticketUrl = async (forPort: number, forPath: string): Promise<string> => {
    await getPreviewOrigin();
    const response = await fetch('/api/preview/ticket', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ port: forPort, path: forPath }),
    });
    if (!response.ok) throw new Error(`ticket ${response.status}`);
    const { loginOrigin, loginPath } = (await response.json()) as {
      loginOrigin: string;
      loginPath: string;
    };
    return loginOrigin + loginPath;
  };

  const load = (forPort: number, forPath: string) => {
    const seq = ++loadSeq;
    ticketUrl(forPort, forPath)
      .then((url) => {
        if (seq !== loadSeq) return;
        previewOrigin = new URL(url).origin;
        src = url;
        authed = 'ok';
      })
      .catch(() => {
        if (seq !== loadSeq) return;
        authed = 'failed';
      })
      .finally(() => {
        if (seq === loadSeq) paint();
      });
  };
  // Always full screen (2026-10-03): from the list, a push or `ut open`, a remembered split
  // opened half a screen the user didn't ask for. Split only when picked inside the session
  // (the view's "show beside the session" passes mode 'split', or the toggle here).
  let mode: Mode = options.mode ?? 'full';
  // 45 % for the preview by default (55 % left an SE's chat with no room for messages).
  let split = Number(readSetting(SPLIT_KEY)) || Math.round(viewportHeight() * 0.45);
  let dragging = false;
  // Split + keyboard (typing in the session): the session gets the whole screen while it's up,
  // the preview comes back when it closes (2026-10-03). Not when typing in the panel itself.
  let keyboardHidesPanel = false;
  const onViewportResize = () => {
    const hide = isKeyboardOpen() && !host.contains(document.activeElement);
    if (hide === keyboardHidesPanel) return;
    keyboardHidesPanel = hide;
    paint();
  };
  window.visualViewport?.addEventListener('resize', onViewportResize);
  // Record the full height now, while no keyboard is up, so its arrival is measurable.
  isKeyboardOpen();
  /** Session space below the panel is kept; a divider dragged past it would cover the input. */
  const clampSplit = (value: number) =>
    Math.round(
      Math.max(
        Math.min(MIN_SPLIT, viewportHeight() / 2),
        Math.min(viewportHeight() - MIN_SESSION_SPACE, value)
      )
    );

  const frame = () => host.querySelector<HTMLIFrameElement>('.pv-frame');

  const show = (nextPort: number, nextPath: string) => {
    if (!ports.includes(nextPort)) ports = [nextPort, ...ports];
    port = nextPort;
    path = nextPath.startsWith('/') ? nextPath : `/${nextPath}`;
    draft = path;
    paint();
    load(nextPort, path); // every load gets its own ticket, so the iframe URL always changes
  };
  current = { sessionId: options.sessionId, show };

  // Touch acts on pointerup (iOS may take the first tap on a fresh button as a hover); the
  // click that follows is swallowed. Mouse and keyboard use the click. Nothing acts at first.
  let touchActedAt = 0;
  const act = (fn: () => void) => ({
    handleEvent: (e: Event) => {
      if (Date.now() - openedAt < PREVIEW_OPEN_GUARD_MS) return;
      if (e.type === 'pointerup') {
        if ((e as PointerEvent).pointerType === 'mouse') return;
        // A drag that started on a button (swiping the bar down, say) ends here too: not a tap.
        if (endsADrag(e as PointerEvent)) return;
        touchActedAt = Date.now();
        swallowNextClick();
      } else if (Date.now() - touchActedAt < 700) {
        return;
      }
      fn();
    },
  });

  const reload = () => {
    if (port) show(port, path);
  };
  // The frame is another origin: its history is reachable only through its client script.
  const goHistory = (direction: 'back' | 'forward') => {
    if (!previewOrigin) return;
    frame()?.contentWindow?.postMessage({ type: 'ut-preview-history', direction }, previewOrigin);
  };
  const openInSafari = () => {
    if (!port) return;
    // Opened now (inside the tap, or it's blocked), pointed at a fresh ticket once it arrives.
    const tab = window.open('about:blank', '_blank');
    if (!tab) return;
    tab.opener = null;
    ticketUrl(port, path)
      .then((url) => {
        tab.location.href = url;
      })
      .catch(() => tab.close());
  };
  const toggleMode = () => {
    mode = mode === 'split' ? 'full' : 'split';
    paint();
  };
  const submitAddress = (e: Event) => {
    e.preventDefault();
    if (port) show(port, draft.trim() || '/');
  };
  const submitPort = (e: Event) => {
    e.preventDefault();
    const value = Number(portDraft.trim().replace(/^:/, ''));
    if (Number.isInteger(value) && value >= 1024 && value <= 65535) show(value, '/');
  };

  // The previewed page reports where it is (preview-proxy.ts client script).
  const onMessage = (e: MessageEvent) => {
    if (!previewOrigin || e.origin !== previewOrigin || e.source !== frame()?.contentWindow) return;
    const data = e.data as { type?: string; path?: unknown; port?: unknown };
    if (data?.type !== 'ut-preview-location' || typeof data.path !== 'string') return;
    path = data.path;
    const input = host.querySelector<HTMLInputElement>('.pv-address');
    if (document.activeElement !== input) draft = path;
    paint();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') closePreviewPanel();
  };
  window.addEventListener('message', onMessage);
  document.addEventListener('keydown', onKey);

  // Divider: drag to resize the split (the iframe must not swallow the pointer meanwhile).
  // The divider owns its gesture (touch-action: none + pointer capture): it must not also
  // scroll the terminal under it.
  const onDividerDown = (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragging = true;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    paint();
  };
  const onDividerMove = (e: PointerEvent) => {
    if (!dragging) return;
    e.preventDefault();
    e.stopPropagation();
    split = clampSplit(e.clientY);
    paint();
  };
  const onDividerUp = () => {
    if (!dragging) return;
    dragging = false;
    writeSetting(SPLIT_KEY, String(split));
    paint();
  };

  cleanup = () => {
    window.visualViewport?.removeEventListener('resize', onViewportResize);
    window.removeEventListener('message', onMessage);
    document.removeEventListener('keydown', onKey);
  };

  const icon = (d: string) =>
    html`<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d=${d} />
    </svg>`;

  const button = (label: string, d: string, fn: () => void, testId: string, disabled = false) =>
    html`<button
      class="pv-btn ut-surface--control"
      type="button"
      aria-label=${label}
      title=${label}
      data-testid=${testId}
      ?disabled=${disabled}
      @pointerup=${act(fn)}
      @click=${act(fn)}
    >
      ${icon(d)}
    </button>`;

  // Swiping the bar down closes the preview (the way back the user expects on a phone).
  let swipeY: number | null = null;
  const barSwipeStart = (e: TouchEvent) => {
    swipeY = e.touches[0]?.clientY ?? null;
  };
  const barSwipeEnd = (e: TouchEvent) => {
    const endY = e.changedTouches[0]?.clientY;
    if (swipeY !== null && endY !== undefined && endY - swipeY > 60) closePreviewPanel();
    swipeY = null;
  };

  function paint() {
    if (!isOpen()) return;
    // `split` is the size the user chose; what fits right now is derived from it, never
    // written back: clamping it while the keyboard was up left a tiny preview once the keyboard
    // closed (2026-10-03, iPhone SE).
    const shown = mode === 'split' ? clampSplit(split) : split;
    host.style.setProperty('--pv-split', `${shown}px`);
    const hidden = mode === 'split' && keyboardHidesPanel;
    syncSessionOffset(mode === 'split' && !hidden ? shown : 0);
    render(
      html`
        <div
          class="pv-panel ${mode === 'full' ? 'pv-full' : 'pv-split'} ${dragging ? 'pv-dragging' : ''} ${hidden ? 'pv-kbd-hidden' : ''}"
          role="dialog"
          aria-label=${t('preview.title')}
          data-testid="preview-panel"
        >
          <div
            class="pv-bar ut-surface--bar"
            @touchstart=${barSwipeStart}
            @touchend=${barSwipeEnd}
          >
            <button
              class="pv-btn pv-back ut-surface--control"
              type="button"
              aria-label=${t('preview.close')}
              data-testid="preview-close"
              @pointerup=${act(closePreviewPanel)}
              @click=${act(closePreviewPanel)}
            >
              ${icon('M15 18l-6-6 6-6')}<span>${t('preview.backToSession')}</span>
            </button>
            ${button(t('preview.back'), 'M15 18l-6-6 6-6', () => goHistory('back'), 'preview-back', !port)}
            ${button(t('preview.forward'), 'M9 18l6-6-6-6', () => goHistory('forward'), 'preview-forward', !port)}
            ${
              port
                ? html`<form class="pv-address-form" @submit=${submitAddress}>
                    ${
                      ports.length > 1
                        ? html`<select
                            class="ut-surface--inset pv-port-select"
                            aria-label=${t('preview.port')}
                            @change=${(e: Event) => show(Number((e.target as HTMLSelectElement).value), '/')}
                          >
                            ${ports.map((p) => html`<option value=${p} ?selected=${p === port}>:${p}</option>`)}
                          </select>`
                        : html`<span class="pv-port" dir="ltr">:${port}</span>`
                    }
                    <input
                      class="ut-surface--inset pv-address"
                      dir="ltr"
                      type="text"
                      inputmode="url"
                      autocapitalize="off"
                      autocomplete="off"
                      spellcheck="false"
                      enterkeyhint="go"
                      aria-label=${t('preview.address')}
                      data-testid="preview-address"
                      .value=${draft}
                      @input=${(e: Event) => {
                        draft = (e.target as HTMLInputElement).value;
                      }}
                    />
                  </form>`
                : html`<span class="pv-title">${t('preview.title')}</span>`
            }
            ${button(t('preview.reload'), 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7', reload, 'preview-reload', !port)}
            ${button(
              mode === 'split' ? t('preview.fullScreen') : t('preview.split'),
              mode === 'split' ? 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5' : 'M4 4h16v16H4zM4 12h16',
              toggleMode,
              'preview-mode'
            )}
            ${
              // Previews have their own origin now, so in the installed app iOS opens them in
              // a browser sheet over it (✕ comes back, the compass goes on to Safari) instead of
              // trapping the app in the preview as it did on the shared origin (verified in the
              // iOS 27 simulator, 2026-10-03).
              button(
                t('preview.openInSafari'),
                'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
                openInSafari,
                'preview-open-safari',
                !port
              )
            }
          </div>
          <div class="pv-body">
            ${
              authed === 'failed'
                ? html`<p class="pv-note ut-surface--panel ut-surface--material" role="alert">${t('preview.authFailed')}</p>`
                : !port
                  ? html`<form class="pv-port-form" @submit=${submitPort}>
                      <p class="pv-note ut-surface--panel ut-surface--material">${t('preview.noPort')}</p>
                      <div class="pv-port-row">
                        <input
                          class="ut-surface--inset pv-port-input"
                          type="text"
                          inputmode="numeric"
                          placeholder="5173"
                          aria-label=${t('preview.port')}
                          data-testid="preview-port-input"
                          @input=${(e: Event) => {
                            portDraft = (e.target as HTMLInputElement).value;
                          }}
                        />
                        <button class="ut-surface--control pv-go" type="submit">${t('preview.open')}</button>
                      </div>
                    </form>`
                  : authed === 'ok' && src
                    ? html`<iframe
                        class="pv-frame"
                        title=${t('preview.title')}
                        sandbox=${PREVIEW_SANDBOX}
                        allow="microphone; autoplay"
                        src=${src}
                        data-testid="preview-frame"
                      ></iframe>`
                    : nothing
            }
          </div>
          ${
            mode === 'split'
              ? html`<div
                  class="pv-divider"
                  role="separator"
                  aria-orientation="horizontal"
                  aria-label=${t('preview.resize')}
                  @pointerdown=${onDividerDown}
                  @pointermove=${onDividerMove}
                  @pointerup=${onDividerUp}
                  @pointercancel=${onDividerUp}
                ><span></span></div>`
              : nothing
          }
        </div>
      `,
      host
    );
  }

  paint();
  if (port) load(port, path);
  else {
    authed = 'ok';
    paint();
  }
}
