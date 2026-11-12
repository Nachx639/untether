/**
 * A dev-server preview as its own full-screen view (/preview/<id>, 2026-10-03): address bar,
 * back/forward, reload, Back to where the user came from ("‹ <session>" when opened inside
 * that session, "‹ Sesiones" from the list, a push or `ut open`), "Go to the session" that
 * opened it while it exists, "show beside the session" (the split panel), and "Open in
 * Safari" outside the installed app.
 * When the server's health check says the dev server stopped, a friendly notice with Retry
 * replaces the blank frame.
 *
 * Loading is the panel's (preview-panel.ts): a 60 s ticket for the preview origin per load.
 * While shown, the page tells the server it is viewing this preview, so "Preview ready" for
 * it isn't pushed to the phone that already shows it.
 *
 * @fires preview-back - detail: { sessionId } (null: back to the list)
 * @fires preview-go-to-session - detail: { sessionId }
 * @fires preview-split - detail: { sessionId, port, path }
 */
import { html, LitElement, nothing, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { PreviewItem } from '../../shared/types.js';
import { previewViewingKey } from '../../shared/ws-v3.js';
import { LocaleController, t } from '../i18n/index.js';
import type { AuthClient } from '../services/auth-client.js';
import { terminalSocketClient } from '../services/terminal-socket-client.js';
import { swallowNextClick } from '../utils/ghost-click.js';
import { isPhoneScreen } from '../utils/mobile-utils.js';
import { endsADrag } from '../utils/pointer-drag.js';
import { previewViewPath } from '../utils/preview-rows.js';
import { icon } from './icons.js';
import {
  PREVIEW_OPEN_GUARD_MS,
  PREVIEW_SANDBOX,
  type PreviewConfig,
  previewOriginFor,
} from './preview-panel.js';

@customElement('preview-view')
export class PreviewView extends LitElement {
  createRenderRoot() {
    return this;
  }

  private locale = new LocaleController(this);

  @property({ type: String }) previewId = '';
  @property({ type: String }) path = '/';
  /** The saved preview (port, live/down, its session); null until the list has loaded. */
  @property({ attribute: false }) item: PreviewItem | null = null;
  /** The session it was opened from (Back returns there); null: Back goes to the list. */
  @property({ attribute: false }) fromSessionId: string | null = null;
  @property({ type: String }) fromSessionName = '';
  @property({ attribute: false }) authClient?: AuthClient;

  @state() private src = '';
  @state() private authFailed = false;
  /** The server doesn't know this preview (deleted, or an old link). */
  @state() private missing = false;
  @state() private draft = '/';
  @state() private currentPath = '/';
  /** Retry said the dev server is down (until a check or the health poll says otherwise). */
  @state() private retryDown: boolean | null = null;
  @state() private checking = false;
  /** A phone (isPhoneScreen): page back / forward / reload move to a bottom toolbar. */
  @state() private phone = isPhoneScreen();
  private onResize = () => {
    this.phone = isPhoneScreen();
  };

  private previewOrigin: string | null = null;
  private loadSeq = 0;
  private openedAt = Date.now();
  private touchActedAt = 0;
  private viewingKey: string | null = null;

  connectedCallback() {
    super.connectedCallback();
    this.openedAt = Date.now();
    window.addEventListener('message', this.onMessage);
    window.addEventListener('resize', this.onResize);
    document.addEventListener('visibilitychange', this.syncViewing);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('message', this.onMessage);
    document.removeEventListener('visibilitychange', this.syncViewing);
    if (this.viewingKey) terminalSocketClient.clearViewingSession(this.viewingKey);
    this.viewingKey = null;
  }

  private get port(): number {
    return this.item?.port ?? 0;
  }

  private syncViewing = () => {
    if (!this.previewId) return;
    const key = previewViewingKey(this.previewId);
    if (this.viewingKey && this.viewingKey !== key) {
      terminalSocketClient.clearViewingSession(this.viewingKey);
    }
    this.viewingKey = key;
    terminalSocketClient.setViewingSession(key);
  };

  protected willUpdate(changed: PropertyValues<this>) {
    if (changed.has('previewId') || changed.has('path')) {
      const path = this.path?.startsWith('/') ? this.path : `/${this.path || ''}`;
      this.currentPath = path;
      this.draft = path;
      this.retryDown = null;
    }
    // The health poll saw it come back: show it again.
    if (changed.has('item') && this.retryDown && this.healthState() === 'live') {
      this.retryDown = null;
      this.load();
    }
  }

  protected updated(changed: PropertyValues<this>) {
    if (changed.has('previewId') || changed.has('path')) {
      this.syncViewing();
      this.load();
    } else if (changed.has('item') && !this.src && !this.authFailed && this.item) {
      // Opened from a link before the list arrived: load now that its port is known.
      this.load();
    }
  }

  private healthState(): 'live' | 'down' | undefined {
    return this.item?.state;
  }

  private isDown(): boolean {
    if (this.retryDown !== null) return this.retryDown;
    return this.healthState() === 'down';
  }

  private authHeaders(): Record<string, string> {
    return { ...(this.authClient?.getAuthHeader() ?? {}) };
  }

  private async getPreviewOrigin(): Promise<string> {
    if (this.previewOrigin) return this.previewOrigin;
    const response = await fetch('/api/preview/config', { headers: this.authHeaders() });
    if (!response.ok) throw new Error(`config ${response.status}`);
    const origin = previewOriginFor(window.location.href, (await response.json()) as PreviewConfig);
    if (!origin) throw new Error('previews disabled');
    this.previewOrigin = origin;
    return origin;
  }

  private async ticketUrl(path: string): Promise<string> {
    await this.getPreviewOrigin();
    const response = await fetch('/api/preview/ticket', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify({ id: this.previewId, path }),
    });
    if (response.status === 404) throw new Error('missing');
    if (!response.ok) throw new Error(`ticket ${response.status}`);
    const { loginOrigin, loginPath } = (await response.json()) as {
      loginOrigin: string;
      loginPath: string;
    };
    return loginOrigin + loginPath;
  }

  /** Every load gets its own ticket, so the iframe URL always changes (a real reload). */
  private load(path = this.currentPath) {
    if (!this.previewId) return;
    const seq = ++this.loadSeq;
    this.ticketUrl(path)
      .then((url) => {
        if (seq !== this.loadSeq) return;
        this.previewOrigin = new URL(url).origin;
        this.src = url;
        this.authFailed = false;
        this.missing = false;
      })
      .catch((error: unknown) => {
        if (seq !== this.loadSeq) return;
        if ((error as Error)?.message === 'missing') this.missing = true;
        else this.authFailed = true;
      });
  }

  private onMessage = (e: MessageEvent) => {
    const frame = this.querySelector<HTMLIFrameElement>('.pv-frame');
    if (
      !this.previewOrigin ||
      e.origin !== this.previewOrigin ||
      e.source !== frame?.contentWindow
    ) {
      return;
    }
    const data = e.data as { type?: string; path?: unknown };
    if (data?.type !== 'ut-preview-location' || typeof data.path !== 'string') return;
    this.currentPath = data.path;
    const input = this.querySelector<HTMLInputElement>('.pv-address');
    if (document.activeElement !== input) this.draft = data.path;
    // Keep the address in the URL so a reload or a shared link lands on the same page.
    const next = previewViewPath(this.previewId, data.path, this.fromSessionId);
    if (`${window.location.pathname}${window.location.search}` !== next) {
      window.history.replaceState(window.history.state, '', next);
    }
  };

  /** Touch acts on pointerup and swallows the click after it; nothing acts right after opening. */
  private act(fn: () => void) {
    return {
      handleEvent: (e: Event) => {
        if (Date.now() - this.openedAt < PREVIEW_OPEN_GUARD_MS) return;
        if (e.type === 'pointerup') {
          if ((e as PointerEvent).pointerType === 'mouse') return;
          // A drag that started on a button ends here too: not a tap.
          if (endsADrag(e as PointerEvent)) return;
          this.touchActedAt = Date.now();
          swallowNextClick();
        } else if (Date.now() - this.touchActedAt < 700) {
          return;
        }
        fn();
      },
    };
  }

  private goHistory(direction: 'back' | 'forward') {
    if (!this.previewOrigin) return;
    this.querySelector<HTMLIFrameElement>('.pv-frame')?.contentWindow?.postMessage(
      { type: 'ut-preview-history', direction },
      this.previewOrigin
    );
  }

  /** The session that opened it, while it still exists. */
  private liveSessionId(): string | null {
    return this.item?.sessionId && this.item.sessionAlive ? this.item.sessionId : null;
  }

  private back = () => {
    this.dispatchEvent(
      new CustomEvent('preview-back', {
        detail: { sessionId: this.fromSessionId },
        bubbles: true,
        composed: true,
      })
    );
  };

  private goToSession = () => {
    const sessionId = this.liveSessionId();
    if (!sessionId) return;
    this.dispatchEvent(
      new CustomEvent('preview-go-to-session', {
        detail: { sessionId },
        bubbles: true,
        composed: true,
      })
    );
  };

  private split = () => {
    const sessionId = this.liveSessionId();
    if (!sessionId) return;
    this.dispatchEvent(
      new CustomEvent('preview-split', {
        detail: { sessionId, port: this.port, path: this.currentPath },
        bubbles: true,
        composed: true,
      })
    );
  };

  private openInSafari = () => {
    const tab = window.open('about:blank', '_blank');
    if (!tab) return;
    tab.opener = null;
    this.ticketUrl(this.currentPath)
      .then((url) => {
        tab.location.href = url;
      })
      .catch(() => tab.close());
  };

  async retry() {
    if (this.checking) return;
    this.checking = true;
    try {
      const response = await fetch(`/api/previews/${encodeURIComponent(this.previewId)}/check`, {
        method: 'POST',
        headers: this.authHeaders(),
      });
      const body = response.ok ? ((await response.json()) as { state?: string }) : null;
      // Unknown to the server (closed, or the server restarted): just try loading it.
      const down = body?.state === 'down';
      this.retryDown = down;
      if (!down) this.load();
    } catch {
      this.retryDown = true;
    } finally {
      this.checking = false;
    }
  }

  private icon(d: string) {
    return html`<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d=${d} />
    </svg>`;
  }

  private button(label: string, d: string, fn: () => void, testId: string) {
    const handler = this.act(fn);
    return html`<button
      class="pv-btn ut-surface--control"
      type="button"
      aria-label=${label}
      title=${label}
      data-testid=${testId}
      @pointerup=${handler}
      @click=${handler}
    >
      ${this.icon(d)}
    </button>`;
  }

  render() {
    void this.locale;
    const name = this.fromSessionId
      ? this.fromSessionName || t('preview.backToSession')
      : t('previewView.backToList');
    const back = this.act(this.back);
    // "Go to the session" when Back doesn't already lead there.
    const otherSession = this.liveSessionId() && this.liveSessionId() !== this.fromSessionId;
    const down = this.isDown();
    const phone = this.phone;
    const historyButtons = html`${this.button(t('preview.back'), 'M15 18l-6-6 6-6', () => this.goHistory('back'), 'preview-back')}
      ${this.button(t('preview.forward'), 'M9 18l6-6-6-6', () => this.goHistory('forward'), 'preview-forward')}`;
    const reload = this.button(
      t('preview.reload'),
      'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
      () => this.load(),
      'preview-reload'
    );
    return html`
      <div
        class="pv-panel pv-full pv-view ${phone ? 'pv-phone' : ''}"
        data-testid="preview-view"
        aria-label=${t('preview.title')}
      >
        <div class="pv-bar ut-surface--bar">
          <button
            class="pv-btn pv-back ut-surface--control"
            type="button"
            aria-label=${t('previewView.backToLabel', { name })}
            data-testid="preview-view-back"
            @pointerup=${back}
            @click=${back}
          >
            ${this.icon('M15 18l-6-6 6-6')}<span class="pv-back-name" dir="auto">${name}</span>
          </button>
          ${phone ? nothing : historyButtons}
          <form
            class="pv-address-form"
            @submit=${(e: Event) => {
              e.preventDefault();
              const path = this.draft.trim() || '/';
              this.currentPath = path.startsWith('/') ? path : `/${path}`;
              this.load();
            }}
          >
            <span class="pv-port" dir="ltr">${this.port ? `:${this.port}` : ''}</span>
            <input
              class="pv-address ut-surface--inset"
              dir="ltr"
              type="text"
              inputmode="url"
              autocapitalize="off"
              autocomplete="off"
              spellcheck="false"
              enterkeyhint="go"
              aria-label=${t('preview.address')}
              data-testid="preview-address"
              .value=${this.draft}
              @input=${(e: Event) => {
                this.draft = (e.target as HTMLInputElement).value;
              }}
            />
          </form>
          ${phone ? nothing : reload}
          ${
            otherSession
              ? this.button(
                  t('previewRows.goToSession'),
                  'M4 17l6-6-6-6M12 19h8',
                  this.goToSession,
                  'preview-go-session'
                )
              : nothing
          }
          ${
            this.liveSessionId()
              ? this.button(
                  t('previewView.splitInSession'),
                  'M4 4h16v16H4zM4 12h16',
                  this.split,
                  'preview-split'
                )
              : nothing
          }
          ${
            // Also in the installed app: the preview's own origin opens in a browser sheet over
            // it, with ✕ to come back (verified in the iOS 27 simulator, 2026-10-03).
            this.button(
              t('preview.openInSafari'),
              'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
              this.openInSafari,
              'preview-open-safari'
            )
          }
        </div>
        <div class="pv-body">
          ${
            down
              ? html`<div class="pv-down ut-surface--panel ut-surface--material" role="alert" data-testid="preview-down">
                  <div class="pv-down-icon" aria-hidden="true">${icon('monitor', 40)}</div>
                  <p class="pv-down-title">${t('previewView.downTitle')}</p>
                  <p class="pv-down-body">${t('previewView.downBody')}</p>
                  <button
                    class="ut-surface--control pv-go"
                    type="button"
                    data-testid="preview-retry"
                    ?disabled=${this.checking}
                    @pointerup=${this.act(() => void this.retry())}
                    @click=${this.act(() => void this.retry())}
                  >
                    ${this.checking ? t('previewView.retrying') : t('previewView.retry')}
                  </button>
                </div>`
              : this.missing
                ? html`<p class="pv-note ut-surface--panel ut-surface--material" role="alert" data-testid="preview-missing">
                    ${t('previewView.missing')}
                  </p>`
                : this.authFailed
                  ? html`<p class="pv-note ut-surface--panel ut-surface--material" role="alert">${t('preview.authFailed')}</p>`
                  : this.src
                    ? html`<iframe
                      class="pv-frame"
                      title=${t('preview.title')}
                      sandbox=${PREVIEW_SANDBOX}
                      allow="microphone; autoplay"
                      src=${this.src}
                      data-testid="preview-frame"
                    ></iframe>`
                    : nothing
          }
        </div>
        ${
          phone
            ? html`<div class="pv-toolbar" role="toolbar" aria-label=${t('preview.title')}>
                ${historyButtons}${reload}
              </div>`
            : nothing
        }
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'preview-view': PreviewView;
  }
}
