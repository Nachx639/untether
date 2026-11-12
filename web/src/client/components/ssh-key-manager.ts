import { html, LitElement } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { LocaleController, t } from '../i18n/index.js';
import type { BrowserSSHAgent } from '../services/ssh-agent.js';
import './modal-wrapper.js';
import { confirmDialog } from '../utils/confirm-dialog.js';
import { icon } from './icons.js';

interface SSHKey {
  id: string;
  name: string;
  publicKey: string;
  algorithm: 'Ed25519';
  encrypted: boolean;
  fingerprint: string;
  createdAt: string;
}

@customElement('ssh-key-manager')
export class SSHKeyManager extends LitElement {
  protected readonly i18n = new LocaleController(this);

  // Disable shadow DOM to use Tailwind
  createRenderRoot() {
    return this;
  }

  @property({ type: Object }) sshAgent!: BrowserSSHAgent;
  @property({ type: Boolean }) visible = false;
  @state() private keys: SSHKey[] = [];
  @state() private loading = false;
  @state() private error = '';
  @state() private success = '';
  @state() private showAddForm = false;
  @state() private newKeyName = '';
  @state() private newKeyPassword = '';
  @state() private importKeyName = '';
  @state() private importKeyContent = '';
  @state() private showInstructions = false;
  @state() private instructionsKeyId = '';
  private documentKeyHandler = (e: KeyboardEvent) => this.handleDocumentKeyDown(e);

  connectedCallback() {
    super.connectedCallback();
    this.refreshKeys();
  }

  updated(changedProperties: Map<string | number | symbol, unknown>) {
    super.updated(changedProperties);

    // Handle document keydown events when modal visibility changes
    if (changedProperties.has('visible')) {
      if (this.visible) {
        document.addEventListener('keydown', this.documentKeyHandler);
      } else {
        document.removeEventListener('keydown', this.documentKeyHandler);
      }
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener('keydown', this.documentKeyHandler);
  }

  private refreshKeys() {
    this.keys = this.sshAgent.listKeys() as SSHKey[];
  }

  private async handleGenerateKey() {
    if (!this.newKeyName.trim()) {
      this.error = t('ssh.error.nameRequired');
      return;
    }

    this.loading = true;
    this.error = '';

    try {
      const result = await this.sshAgent.generateKeyPair(
        this.newKeyName,
        this.newKeyPassword || undefined
      );

      // Automatically download the private key
      this.downloadPrivateKey(result.privateKeyPEM, this.newKeyName);

      this.success = t('ssh.generated', { name: this.newKeyName });
      this.newKeyName = '';
      this.newKeyPassword = '';
      this.showAddForm = false;
      this.showInstructions = true;
      this.instructionsKeyId = result.keyId;
      this.refreshKeys();
      console.log('Generated key ID:', result.keyId);
    } catch (error) {
      this.error = t('ssh.error.generate', { error: String(error) });
    } finally {
      this.loading = false;
    }
  }

  private downloadPrivateKey(privateKeyPEM: string, keyName: string) {
    const blob = new Blob([privateKeyPEM], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${keyName.replace(/\s+/g, '_')}_private.pem`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  private async handleImportKey() {
    if (!this.importKeyName.trim() || !this.importKeyContent.trim()) {
      this.error = t('ssh.error.importRequired');
      return;
    }

    this.loading = true;
    this.error = '';

    try {
      const keyId = await this.sshAgent.addKey(this.importKeyName, this.importKeyContent);
      this.success = t('ssh.imported', { name: this.importKeyName });
      this.importKeyName = '';
      this.importKeyContent = '';
      this.showAddForm = false;
      this.refreshKeys();
      console.log('Imported key ID:', keyId);
    } catch (error) {
      this.error = t('ssh.error.import', { error: String(error) });
    } finally {
      this.loading = false;
    }
  }

  /** Import hint with the two PEM headers rendered as code. */
  private renderImportHint() {
    const parts = t('ssh.importHint', { openssh: '\uE000', pkcs8: '\uE001' }).split(
      /(\uE000|\uE001)/
    );
    return parts.map((part) =>
      part === '\uE000'
        ? html`<code>BEGIN OPENSSH PRIVATE KEY</code>`
        : part === '\uE001'
          ? html`<code>BEGIN PRIVATE KEY</code>`
          : part
    );
  }

  private handleClose() {
    this.dispatchEvent(new CustomEvent('close'));
  }

  private async handleRemoveKey(keyId: string, keyName: string) {
    if (
      await confirmDialog({
        title: t('confirm.defaultTitle'),
        body: t('ssh.removeConfirm', { name: keyName }),
        confirmLabel: t('ssh.removeKey'),
        tone: 'danger',
      })
    ) {
      this.sshAgent.removeKey(keyId);
      this.success = t('ssh.removed', { name: keyName });
      this.refreshKeys();
    }
  }

  private handleDownloadPublicKey(keyId: string, keyName: string) {
    const publicKey = this.sshAgent.getPublicKey(keyId);
    if (publicKey) {
      const blob = new Blob([publicKey], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${keyName.replace(/\s+/g, '_')}_public.pub`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
  }

  private handleDocumentKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape' && this.visible) {
      e.preventDefault();
      this.handleClose();
    }
  }

  render() {
    if (!this.visible) return html``;

    return html`
      <modal-wrapper
        .visible=${true}
        .ariaLabel=${t('ssh.title')}
        .closeOnEscape=${false}
        contentClass="ut-dialog ut-dialog--lg ssh-dialog"
        @close=${this.handleClose}
      >
        <div>
          <div class="ut-dialog-header">
            <h2 class="m-0 text-title font-semibold text-text-bright flex items-center gap-2">
              <span class="text-text-muted inline-flex">${icon('lock')}</span>${t('ssh.title')}
            </h2>
            <button
              type="button"
              @click=${this.handleClose}
              class="ut-icon-btn"
              data-modal-close
              aria-label=${t('common.close')}
              title=${`${t('common.close')} (⎋)`}
            >
              ${icon('x')}
            </button>
          </div>
          <div class="ut-dialog-body ssh-body">

          ${
            this.error
              ? html`
                <div class="cf-callout cf-callout--error mb-4 ut-surface--panel ut-surface--material" role="alert">
                  ${this.error}
                  <button
                    @click=${() => {
                      this.error = '';
                    }}
                    type="button"
                    class="ut-icon-btn ut-icon-btn--sm ml-auto"
                    aria-label=${t('common.close')}
                  >
                    ${icon('x', 14)}
                  </button>
                </div>
              `
              : ''
          }
          ${
            this.success
              ? html`
                <div class="cf-callout mb-4 bg-status-success/10 text-status-success ut-surface--panel ut-surface--material" role="status">
                  ${this.success}
                  <button
                    @click=${() => {
                      this.success = '';
                    }}
                    type="button"
                    class="ut-icon-btn ut-icon-btn--sm ml-auto"
                    aria-label=${t('common.close')}
                  >
                    ${icon('x', 14)}
                  </button>
                </div>
              `
              : ''
          }

          <div class="mb-6">
            <div class="flex items-center justify-between mb-4">
              <h3 class="m-0 ut-section-label">${t('ssh.keys')}</h3>
              <button
                @click=${() => {
                  this.showAddForm = !this.showAddForm;
                }}
                type="button"
                class="ut-btn ${this.showAddForm ? 'ut-btn--ghost' : 'ut-btn--secondary'}"
                ?disabled=${this.loading}
              >
                ${this.showAddForm ? t('common.cancel') : html`${icon('plus')} ${t('ssh.addKey')}`}
              </button>
            </div>

            ${
              this.showAddForm
                ? html`
                  <div class="space-y-4 mb-6">
                    <!-- Generate New Key Section -->
                    <div class="ut-group p-5">
                      <h4 class="m-0 mb-4 text-ui font-semibold text-text flex items-center gap-2">
                        <span class="text-text-muted inline-flex">${icon('sparkles')}</span>${t('ssh.generateTitle')}
                      </h4>

                      <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                        <div>
                          <label class="ut-label"
                            >${t('ssh.keyName')} <span class="text-status-error">*</span></label
                          >
                          <input
                            type="text"
                            class="ut-field"
                            placeholder=${t('ssh.keyNamePlaceholder')}
                            .value=${this.newKeyName}
                            @input=${(e: Event) => {
                              this.newKeyName = (e.target as HTMLInputElement).value;
                            }}
                            ?disabled=${this.loading}
                          />
                        </div>
                        <div>
                          <label class="ut-label">${t('ssh.algorithm')}</label>
                          <div
                            class="ut-field flex items-center bg-bg-tertiary text-text-muted cursor-not-allowed"
                          >
                            Ed25519 (${t('ssh.recommended')})
                          </div>
                        </div>
                      </div>

                      <div class="mb-4">
                        <label class="ut-label">${t('ssh.passwordOptional')}</label>
                        <input
                          type="password"
                          class="ut-field"
                          placeholder=${t('ssh.passwordPlaceholder')}
                          .value=${this.newKeyPassword}
                          @input=${(e: Event) => {
                            this.newKeyPassword = (e.target as HTMLInputElement).value;
                          }}
                          ?disabled=${this.loading}
                        />
                        <p class="text-text-muted text-caption mt-1.5">
                          ${t('ssh.passwordHint')}
                        </p>
                      </div>
                      <button
                        @click=${this.handleGenerateKey}
                        type="button"
                        class="ut-btn ut-btn--primary"
                        ?disabled=${this.loading || !this.newKeyName.trim()}
                      >
                        ${this.loading ? t('ssh.generating') : t('ssh.generate')}
                      </button>
                    </div>

                    <!-- Import Existing Key Section -->
                    <div class="ut-group p-5">
                      <h4 class="m-0 mb-4 text-ui font-semibold text-text flex items-center gap-2">
                        <span class="text-text-muted inline-flex">${icon('folderOpen')}</span>${t('ssh.importTitle')}
                      </h4>

                      <div class="mb-4">
                        <label class="ut-label"
                          >${t('ssh.keyName')} <span class="text-status-error">*</span></label
                        >
                        <input
                          type="text"
                          class="ut-field"
                          placeholder=${t('ssh.importNamePlaceholder')}
                          .value=${this.importKeyName}
                          @input=${(e: Event) => {
                            this.importKeyName = (e.target as HTMLInputElement).value;
                          }}
                          ?disabled=${this.loading}
                        />
                      </div>

                      <div class="mb-4">
                        <label class="ut-label"
                          >${t('ssh.privateKey')} <span class="text-status-error">*</span></label
                        >
                        <textarea
                          class="ut-field ut-field--mono"
                          rows="6"
                          placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;...&#10;-----END OPENSSH PRIVATE KEY-----&#10;&#10;or&#10;&#10;-----BEGIN PRIVATE KEY-----&#10;...&#10;-----END PRIVATE KEY-----"
                          .value=${this.importKeyContent}
                          @input=${(e: Event) => {
                            this.importKeyContent = (e.target as HTMLTextAreaElement).value;
                          }}
                          ?disabled=${this.loading}
                        ></textarea>
                        <p class="text-text-muted text-caption mt-1.5">
                          ${this.renderImportHint()}
                        </p>
                      </div>

                      <button
                        @click=${this.handleImportKey}
                        type="button"
                        class="ut-btn ut-btn--secondary"
                        ?disabled=${
                          this.loading ||
                          !this.importKeyName.trim() ||
                          !this.importKeyContent.trim()
                        }
                      >
                        ${this.loading ? t('ssh.importing') : t('ssh.import')}
                      </button>
                    </div>
                  </div>
                `
                : ''
            }
          </div>

          <!-- Instructions for new key -->
          ${
            this.showInstructions && this.instructionsKeyId
              ? html`
                <div class="ut-group p-5 mb-6">
                  <div class="flex items-center justify-between mb-4">
                    <h4 class="m-0 text-ui font-semibold text-text">${t('ssh.setupTitle')}</h4>
                    <button
                      @click=${() => {
                        this.showInstructions = false;
                      }}
                      type="button"
                      class="ut-icon-btn"
                      title=${t('ssh.closeInstructions')}
                      aria-label=${t('ssh.closeInstructions')}
                    >
                      ${icon('x')}
                    </button>
                  </div>
                  <div class="space-y-4">
                    <div>
                      <p class="text-text-muted text-caption mb-2 font-medium">
                        ${t('ssh.step1')}
                      </p>
                      <div class="relative">
                        <pre
                          class="bg-bg-tertiary p-3 rounded-ctl text-[12px] overflow-x-auto text-text pr-20 font-mono"
                        >
echo "${this.sshAgent.getPublicKey(this.instructionsKeyId)}" >> ~/.ssh/authorized_keys</pre
                        >
                        <button
                          @click=${async () => {
                            const publicKey = this.sshAgent.getPublicKey(this.instructionsKeyId);
                            const command = `echo "${publicKey}" >> ~/.ssh/authorized_keys`;
                            await navigator.clipboard.writeText(command);
                            this.success = t('ssh.commandCopied');
                          }}
                          type="button"
                          class="absolute top-2 right-2 ut-icon-btn"
                          title=${t('ssh.copyCommand')}
                          aria-label=${t('ssh.copyCommand')}
                        >
                          ${icon('copy')}
                        </button>
                      </div>
                    </div>
                    <div>
                      <p class="text-text-muted text-caption mb-2 font-medium">${t('ssh.step2')}</p>
                      <div class="relative">
                        <pre
                          class="bg-bg-tertiary p-3 rounded-ctl text-[12px] overflow-x-auto text-text pr-20 font-mono"
                        >
${this.sshAgent.getPublicKey(this.instructionsKeyId)}</pre
                        >
                        <button
                          @click=${async () => {
                            const publicKey = this.sshAgent.getPublicKey(this.instructionsKeyId);
                            if (publicKey) {
                              await navigator.clipboard.writeText(publicKey);
                              this.success = t('ssh.publicKeyCopied');
                            }
                          }}
                          type="button"
                          class="absolute top-2 right-2 ut-btn ut-btn--ghost ut-btn--sm"
                          title=${t('ssh.copyToClipboard')}
                        >
                          ${icon('copy', 14)} ${t('ssh.copy')}
                        </button>
                      </div>
                    </div>
                    <div class="st-callout ut-surface--panel ut-surface--material">
                      <span class="st-callout-icon">${icon('info')}</span>
                      <p class="m-0 text-caption text-text">
                        <strong>${t('ssh.tip')}</strong> ${t('ssh.tipText')}
                      </p>
                    </div>
                  </div>
                </div>
              `
              : ''
          }

          <!-- Keys List -->
          <div class="space-y-4">
            ${
              this.keys.length === 0
                ? html`
                  <div class="flex flex-col items-center text-center gap-2 py-10 text-text-muted">
                    <span class="text-text-dim">${icon('lock', 32)}</span>
                    <p class="m-0 text-title font-semibold text-text">${t('ssh.empty')}</p>
                    <p class="m-0 text-ui">${t('ssh.emptyHint')}</p>
                  </div>
                `
                : this.keys.map(
                    (key) => html`
                    <div class="ut-group p-4">
                      <div class="flex items-start justify-between">
                        <div class="flex-1">
                          <div class="flex items-center gap-2 mb-2">
                            <h4 class="m-0 text-ui font-semibold text-text">${key.name}</h4>
                            <span class="ut-chip ut-chip--mono">${key.algorithm}</span>
                            ${
                              key.encrypted
                                ? html`<span class="ut-chip">${icon('lock', 12)} ${t('ssh.encrypted')}</span>`
                                : ''
                            }
                          </div>
                          <div class="text-[12px] text-text-muted font-mono space-y-0.5">
                            <div>ID: ${key.id}</div>
                            <div>${t('ssh.fingerprint', { value: key.fingerprint })}</div>
                            <div>${t('ssh.created', { date: new Date(key.createdAt).toLocaleString() })}</div>
                          </div>
                        </div>
                        <div class="flex gap-2">
                          <button
                            @click=${() => this.handleDownloadPublicKey(key.id, key.name)}
                            type="button"
                            class="ut-btn ut-btn--ghost ut-btn--sm"
                            title=${t('ssh.downloadPublic')}
                          >
                            ${icon('external', 14)} ${t('ssh.public')}
                          </button>
                          <button
                            @click=${() => this.handleRemoveKey(key.id, key.name)}
                            type="button"
                            class="ut-icon-btn hover:text-status-error"
                            title=${t('ssh.removeKey')}
                            aria-label=${t('ssh.removeKey')}
                          >
                            ${icon('trash')}
                          </button>
                        </div>
                      </div>
                    </div>
                  `
                  )
            }
          </div>
          </div>
        </div>
      </modal-wrapper>
    `;
  }
}
