import { html, LitElement, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { LocaleController, t } from '../i18n/index.js';
import { serverEventService } from '../services/server-event-service.js';
import { createLogger } from '../utils/logger.js';
import { formatShortcut } from '../utils/shortcut-label.js';
import { icon } from './icons.js';

const logger = createLogger('notification-status');

@customElement('notification-status')
export class NotificationStatus extends LitElement {
  protected readonly i18n = new LocaleController(this);

  // Disable shadow DOM to use Tailwind
  createRenderRoot(): HTMLElement {
    return this;
  }

  @state() private isWsConnected = false;

  private connectionStateUnsubscribe?: () => void;

  connectedCallback() {
    super.connectedCallback();
    this.initializeComponent();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.connectionStateUnsubscribe) {
      this.connectionStateUnsubscribe();
    }
  }

  private initializeComponent(): void {
    // Get initial connection state
    serverEventService.initialize();
    this.isWsConnected = serverEventService.getConnectionStatus();
    logger.debug('Initial WS connection status:', this.isWsConnected);

    // Listen for connection state changes
    this.connectionStateUnsubscribe = serverEventService.onConnectionStateChange((connected) => {
      logger.log(`WS connection state changed: ${connected ? 'connected' : 'disconnected'}`);
      this.isWsConnected = connected;
    });
  }

  private handleClick(): void {
    this.dispatchEvent(new CustomEvent('open-settings'));
  }

  render() {
    // Neutral at rest: a settings button. Disconnected adds a pulsing warning dot; it is
    // never green (2026-10-12, design spec 3.5).
    const label = t('common.settings');
    const shortcut = `${label} (${formatShortcut('mod+,')})`;
    const title = this.isWsConnected
      ? shortcut
      : `${shortcut}\n${t('header.notifications.disconnected')}`;
    return html`
      <button
        @click=${this.handleClick}
        class="ut-icon-btn"
        aria-label=${label}
        title=${title}
        data-connected=${this.isWsConnected ? 'true' : 'false'}
      >
        ${icon('settings')}
        ${
          this.isWsConnected
            ? nothing
            : html`<span
                class="ut-badge-dot ut-badge-dot--pulse"
                data-testid="settings-disconnected-dot"
              ></span>`
        }
      </button>
    `;
  }
}
