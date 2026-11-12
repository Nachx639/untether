import { html, LitElement, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { LocaleController, t } from '../i18n/index.js';
import type { AuthClient } from '../services/auth-client.js';
import { createLogger } from '../utils/logger.js';
import './language-picker.js';
import { detectMobile, isPhoneScreen } from '../utils/mobile-utils.js';
import './terminal-icon.js';
import { icon } from './icons.js';

const logger = createLogger('auth-login');

@customElement('auth-login')
export class AuthLogin extends LitElement {
  // Disable shadow DOM to use Tailwind
  createRenderRoot() {
    return this;
  }

  @property({ type: Object }) authClient!: AuthClient;
  // Phones default to staying signed in (typing the Mac password there is the pain point);
  // shared desktops default to a 24 h session.
  @state() private rememberDevice = detectMobile();
  @state() private loading = false;
  @state() private error = '';
  @state() private currentUserId = '';
  @state() private loginPassword = '';
  @state() private userAvatar = '';
  @state() private authConfig = {
    enableSSHKeys: false,
    disallowUserPassword: false,
    noAuth: false,
    passwordAuthMode: 'system' as 'system' | 'configured',
  };
  /** The SSH key block, behind "Use SSH key" while a password works too. */
  @state() private showSSH = false;
  protected readonly i18n = new LocaleController(this);

  async connectedCallback() {
    super.connectedCallback();
    await this.loadUserInfo();
  }

  private async loadUserInfo() {
    try {
      // Load auth configuration first
      try {
        const configResponse = await fetch('/api/auth/config');
        if (configResponse.ok) {
          this.authConfig = await configResponse.json();
          logger.debug('⚙️ Auth config loaded:', this.authConfig);
        } else {
          logger.warn('⚠️ Failed to load auth config, using defaults:', configResponse.status);
        }
      } catch (error) {
        logger.error('❌ Error loading auth config:', error);
      }

      // Null before entering (the endpoint requires a session now): the sign-in screen stays
      // neutral, no system account name or photo, and sign-in still works (the server derives
      // the account). An authenticated caller (Tailscale, no-auth) still gets the name.
      this.currentUserId = (await this.authClient.getCurrentSystemUser()) ?? '';
      logger.debug('👤 Current user:', this.currentUserId || '(not signed in)');

      // Load user avatar only if auth is enabled and we know who the user is.
      if (!this.authConfig.noAuth && this.currentUserId) {
        const avatar = await this.authClient.getUserAvatar(this.currentUserId);
        // The client's generated SVG silhouette is not a photo (it drew an empty circle,
        // its colours unresolved): the initial stands in for it (2026-10-12).
        this.userAvatar = avatar.startsWith('data:image/svg+xml') ? '' : avatar;
        logger.debug('🖼️ User avatar loaded');
      }

      // If no auth required, auto-login
      if (this.authConfig.noAuth) {
        logger.debug('🔓 No auth required, auto-logging in');
        this.dispatchEvent(
          new CustomEvent('auth-success', {
            detail: {
              success: true,
              userId: this.currentUserId,
              authMethod: 'no-auth',
            },
          })
        );
      }
    } catch (_error) {
      this.error = t('login.error.loadUser');
    }
  }

  private async handlePasswordLogin(e: Event) {
    e.preventDefault();
    if (this.loading) return;

    logger.debug('🔐 Attempting password authentication...');
    this.loading = true;
    this.error = '';

    try {
      const result = await this.authClient.authenticateWithPassword(
        this.currentUserId,
        this.loginPassword,
        this.rememberDevice
      );
      logger.debug('Password auth finished:', result.success);

      if (result.success) {
        this.loginPassword = '';
        this.dispatchEvent(new CustomEvent('auth-success', { detail: result }));
      } else {
        this.error = result.error || t('login.error.password');
      }
    } catch (_error) {
      this.error = t('login.error.password');
    } finally {
      this.loading = false;
    }
  }

  private async handleSSHKeyAuth() {
    if (this.loading) return;

    logger.debug('🔐 Attempting SSH key authentication...');
    this.loading = true;
    this.error = '';

    try {
      const authResult = await this.authClient.authenticate(this.currentUserId);
      logger.debug('SSH auth finished:', authResult.success);

      if (authResult.success) {
        this.dispatchEvent(new CustomEvent('auth-success', { detail: authResult }));
      } else {
        this.error = authResult.error || t('login.error.sshTryPassword');
      }
    } catch (error) {
      logger.error('SSH key authentication error:', error);
      this.error = t('login.error.ssh');
    } finally {
      this.loading = false;
    }
  }

  private handleShowSSHKeyManager() {
    this.dispatchEvent(new CustomEvent('show-ssh-key-manager'));
  }

  private handleOpenSettings = () => {
    // Don't bubble - let parent handle via direct event listener
    this.dispatchEvent(new CustomEvent('open-settings'));
  };

  private get usesConfiguredPassword(): boolean {
    return this.authConfig.passwordAuthMode === 'configured';
  }

  private renderAvatar(size: number) {
    return html`<div
      class="al-avatar"
      style="width:${size}px;height:${size}px"
    >
      ${
        this.userAvatar
          ? html`<img
              src="${this.userAvatar}"
              alt=${t('login.avatarAlt')}
              class="w-full h-full object-cover"
              width=${size}
              height=${size}
              @error=${() => {
                // A broken avatar URL drew an empty circle: fall back to the initial.
                this.userAvatar = '';
              }}
            />`
          : html`<span
              class="al-initial"
              style="font-size:${Math.round(size * 0.42)}px"
              aria-hidden="true"
              data-testid="login-initial"
              >${this.initial()}</span
            >`
      }
    </div>`;
  }

  /** No avatar: the user's initial, neutral (phone-spec §4.4, 2026-10-12). */
  private initial(): string {
    const name = this.currentUserId.trim();
    return name ? Array.from(name)[0].toLocaleUpperCase() : '';
  }

  /**
   * The keyboard takes half a phone screen: once it is up (visualViewport shrank), bring the
   * password and "Log in" back into view. Falls back to a timer where visualViewport is
   * missing or does not resize (a hardware keyboard).
   */
  private handlePasswordFocus = () => {
    if (!isPhoneScreen()) return;
    // The field itself (centred): "Log in" stops being sticky while typing (dialogs.css) so it
    // never sits on top of the field, and the keyboard's Go key submits.
    const reveal = () => {
      this.querySelector<HTMLElement>('[data-testid="password-input"]')?.scrollIntoView({
        block: 'center',
      });
    };
    const vv = window.visualViewport;
    let done = false;
    const once = () => {
      if (done) return;
      done = true;
      vv?.removeEventListener('resize', once);
      reveal();
    };
    vv?.addEventListener('resize', once);
    setTimeout(once, 400);
  };

  private renderUserRow() {
    return html`
      <div class="flex items-center gap-3 mb-5">
        ${this.renderAvatar(48)}
        <div class="min-w-0">
          <div class="text-title font-semibold text-text-bright truncate" data-testid="login-user">
            ${this.currentUserId || '…'}
          </div>
          <p class="m-0 text-caption text-text-muted">
            ${this.authConfig.disallowUserPassword ? t('login.sshRequired') : t('login.subtitle')}
          </p>
        </div>
      </div>
    `;
  }

  private renderError(text: string, clear: () => void) {
    return html`<div
      class="al-message al-message--error ut-surface--panel"
      role="alert"
      data-testid="error-message"
    >
      ${icon('alert')}
      <span class="flex-1 min-w-0">${text}</span>
      <button
        type="button"
        class="ut-icon-btn ut-icon-btn--sm"
        @click=${clear}
        aria-label=${t('common.close')}
        data-testid="error-close"
      >
        ${icon('x', 14)}
      </button>
    </div>`;
  }

  private renderPasswordForm() {
    return html`
      <form @submit=${this.handlePasswordLogin} class="space-y-3">
        <div>
          <label for="system-password" class="ut-label">
            ${this.usesConfiguredPassword ? t('login.untetherPassword') : t('login.macPassword')}
          </label>
          <!-- Lets iOS/macOS Keychain save the account (not just a password) and
          fill it with Face ID next time. Not display:none, or Safari ignores it. -->
          <input
            type="text"
            name="username"
            autocomplete="username"
            class="sr-only"
            tabindex="-1"
            aria-hidden="true"
            readonly
            .value=${this.currentUserId}
          />
          <input
            id="system-password"
            name="password"
            type="password"
            class="ut-field h-10"
            data-testid="password-input"
            placeholder=${this.usesConfiguredPassword ? t('login.password') : t('login.macPassword')}
            autocomplete="current-password"
            aria-describedby="password-help"
            enterkeyhint="go"
            ?autofocus=${!isPhoneScreen()}
            @focus=${this.handlePasswordFocus}
            .value=${this.loginPassword}
            @input=${(e: Event) => {
              this.loginPassword = (e.target as HTMLInputElement).value;
            }}
            ?disabled=${this.loading}
            required
          />
          <p id="password-help" class="mt-1.5 mb-0 text-caption text-text-muted">
            ${
              this.usesConfiguredPassword
                ? t('login.passwordHelp.configured')
                : t('login.passwordHelp.mac')
            }
            ${t('login.passwordHelp.notStored')}
          </p>
        </div>
        <label class="flex items-center gap-2 text-ui text-text select-none cursor-pointer">
          <input
            type="checkbox"
            data-testid="remember-device"
            class="w-4 h-4 accent-primary flex-none"
            .checked=${this.rememberDevice}
            @change=${(e: Event) => {
              this.rememberDevice = (e.target as HTMLInputElement).checked;
            }}
          />
          <span class="truncate" title=${t('login.rememberDevice')}>${t('auth.remember30')}</span>
        </label>
        <button
          type="submit"
          class="ut-btn ut-btn--primary w-full h-10 justify-center al-submit"
          data-testid="password-submit"
          ?disabled=${this.loading || !this.loginPassword}
        >
          ${this.loading ? t('login.authenticating') : t('login.logIn')}
        </button>
      </form>
    `;
  }

  private renderSSH() {
    return html`
      <div class="space-y-3" data-testid="ssh-block">
        <button
          type="button"
          class="ut-btn ut-btn--secondary w-full h-10 justify-center"
          data-testid="ssh-login"
          @click=${this.handleSSHKeyAuth}
          ?disabled=${this.loading}
        >
          ${icon('lock')}
          ${this.loading ? t('login.authenticating') : t('login.sshLogin')}
        </button>
        <p class="m-0 text-caption text-text-muted">
          ${t('login.sshGenerateHint')}. ${t('login.sshBothHint')}.
          <button
            type="button"
            class="al-link"
            data-testid="manage-keys"
            @click=${this.handleShowSSHKeyManager}
          >
            ${t('auth.manage')}
          </button>
        </p>
      </div>
    `;
  }

  render() {
    const passwordAllowed = !this.authConfig.disallowUserPassword;
    const sshEnabled = this.authConfig.enableSSHKeys === true;
    return html`
      <div class="al-page">
        <!-- Language picker in top left corner (first screen users see) -->
        <div class="al-corner al-corner--start">
          <language-picker compact></language-picker>
        </div>

        <button
          type="button"
          class="ut-icon-btn al-corner al-corner--end"
          @click=${this.handleOpenSettings}
          title=${t('common.settings')}
          aria-label=${t('common.settings')}
        >
          ${icon('settings')}
        </button>

        <div class="al-card ut-surface--floating ut-surface--material">
          <div class="flex flex-col items-center gap-3 mb-6">
            <terminal-icon size=${isPhoneScreen() ? '44' : '56'}></terminal-icon>
            <h2 class="al-wordmark">Untether</h2>
          </div>

          ${this.error ? this.renderError(this.error, () => (this.error = '')) : nothing}

          ${this.renderUserRow()}

          ${passwordAllowed ? this.renderPasswordForm() : nothing}

          ${
            sshEnabled
              ? passwordAllowed
                ? html`
                  <div class="al-divider"><span>${t('login.or')}</span></div>
                  ${
                    this.showSSH
                      ? this.renderSSH()
                      : html`<button
                          type="button"
                          class="ut-btn ut-btn--ghost w-full justify-center"
                          data-testid="use-ssh-key"
                          @click=${() => {
                            this.showSSH = true;
                          }}
                        >
                          ${icon('lock')} ${t('auth.useSshKey')}
                        </button>`
                  }
                `
                : this.renderSSH()
              : nothing
          }
        </div>
      </div>
    `;
  }
}
