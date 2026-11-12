/**
 * File Picker Component
 *
 * Allows users to pick files from various sources,
 * upload them to the server, and send the path to the terminal.
 *
 * @fires file-selected - When a file is uploaded and ready (detail: { path: string })
 * @fires file-error - When an error occurs (detail: string)
 */

import { html, LitElement } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { LocaleController, t } from '../i18n/index.js';
import { authClient } from '../services/auth-client.js';
import { Z_INDEX } from '../utils/constants.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('file-picker');

interface UploadResponse {
  success: boolean;
  filename: string;
  originalName: string;
  size: number;
  mimetype: string;
  path: string;
  relativePath: string;
  error?: string;
}

@customElement('file-picker')
export class FilePicker extends LitElement {
  protected readonly i18n = new LocaleController(this);

  // Disable shadow DOM for Tailwind compatibility
  createRenderRoot() {
    return this;
  }

  @property({ type: Boolean }) visible = false;
  @state() private uploading = false;
  @state() private uploadProgress = 0;

  private fileInput: HTMLInputElement | null = null;

  connectedCallback() {
    super.connectedCallback();
    this.createFileInput();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.fileInput) {
      this.fileInput.remove();
      this.fileInput = null;
    }
  }

  private createFileInput() {
    // Create a hidden file input element
    this.fileInput = document.createElement('input');
    this.fileInput.type = 'file';
    this.fileInput.accept = '*/*';
    this.fileInput.capture = 'environment'; // Use rear camera by default on mobile
    this.fileInput.style.display = 'none';
    this.fileInput.addEventListener('change', this.handleFileSelect.bind(this));
    document.body.appendChild(this.fileInput);
  }

  private async handleFileSelect(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];

    if (!file) {
      return;
    }

    try {
      await this.uploadFileToServer(file);
    } catch (error) {
      logger.error('Failed to upload file:', error);
      this.dispatchEvent(
        new CustomEvent('file-error', {
          detail: error instanceof Error ? error.message : 'Failed to upload file',
        })
      );
    }

    // Reset the input value so the same file can be selected again
    input.value = '';
  }

  /**
   * Public method to directly open the file picker without showing dialog
   */
  openFilePicker(): void {
    this.handleFileClick();
  }

  private async uploadFileToServer(file: File): Promise<void> {
    this.uploading = true;
    this.uploadProgress = 0;

    try {
      const formData = new FormData();
      formData.append('file', file);

      // Create XMLHttpRequest for upload progress
      const xhr = new XMLHttpRequest();

      return new Promise((resolve, reject) => {
        xhr.upload.addEventListener('progress', (e) => {
          if (e.lengthComputable) {
            this.uploadProgress = (e.loaded / e.total) * 100;
          }
        });

        xhr.addEventListener('load', () => {
          this.uploading = false;

          if (xhr.status === 200) {
            try {
              const response: UploadResponse = JSON.parse(xhr.responseText);
              if (response.success) {
                logger.log(`File uploaded successfully: ${response.filename}`);
                this.dispatchEvent(
                  new CustomEvent('file-selected', {
                    detail: {
                      path: response.path,
                      relativePath: response.relativePath,
                      filename: response.filename,
                      originalName: response.originalName,
                      size: response.size,
                      mimetype: response.mimetype,
                    },
                  })
                );
                resolve();
              } else {
                reject(new Error(response.error || 'Upload failed'));
              }
            } catch (_error) {
              reject(new Error('Invalid response from server'));
            }
          } else {
            reject(new Error(`Upload failed with status ${xhr.status}`));
          }
        });

        xhr.addEventListener('error', () => {
          this.uploading = false;
          reject(new Error('Upload failed'));
        });

        xhr.addEventListener('abort', () => {
          this.uploading = false;
          reject(new Error('Upload aborted'));
        });

        xhr.open('POST', '/api/files/upload');

        // Add auth headers
        const authHeaders = authClient.getAuthHeader();
        for (const [key, value] of Object.entries(authHeaders)) {
          xhr.setRequestHeader(key, value);
        }

        xhr.send(formData);
      });
    } catch (error) {
      this.uploading = false;
      throw error;
    }
  }

  private handleFileClick() {
    if (!this.fileInput) {
      this.createFileInput();
    }

    if (this.fileInput) {
      // Reset to allow all files and remove capture attribute for general file selection
      this.fileInput.accept = '*/*';
      this.fileInput.removeAttribute('capture');
      this.fileInput.click();
    }
  }

  private handleCancel() {
    this.dispatchEvent(new CustomEvent('file-cancel'));
  }

  render() {
    // Always render a container so the file input is available
    if (!this.visible) {
      return html`<div style="display: none;"></div>`;
    }

    return html`
      <div class="fixed inset-0 bg-bg/80 backdrop-blur-sm flex items-center justify-center animate-fade-in" style="z-index: ${Z_INDEX.FILE_PICKER};" @click=${this.handleCancel}>
        <div class="bg-elevated border border-border/50 rounded-xl shadow-drop-2xl p-8 m-4 max-w-sm w-full animate-scale-in" @click=${(e: Event) => e.stopPropagation()}>
          <h3 class="text-xl font-bold text-primary mb-6">
            ${t('filePicker.title')}
          </h3>
          
          ${
            this.uploading
              ? html`
            <div class="mb-6">
              <div class="flex items-center justify-between mb-3">
                <span class="text-sm text-text-muted font-mono">${t('filePicker.uploading')}</span>
                <span class="text-sm text-primary font-mono font-medium">${Math.round(this.uploadProgress)}%</span>
              </div>
              <div class="w-full bg-bg-secondary rounded-pill h-2 overflow-hidden">
                <div 
                  class="bg-gradient-to-r from-primary to-primary-light h-2 rounded-pill transition-all duration-300 shadow-glow-sm" 
                  style="width: ${this.uploadProgress}%"
                ></div>
              </div>
            </div>
          `
              : html`
            <div class="space-y-4">
              <button
                id="file-picker-choose-button"
                @click=${this.handleFileClick}
                class="w-full bg-primary text-on-fill font-medium py-4 px-6 rounded-lg flex items-center justify-center gap-3 transition-all duration-200 hover:bg-primary-light hover:shadow-glow active:scale-95"
              >
                <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                  <path fill-rule="evenodd" d="M4 4a2 2 0 00-2 2v8a2 2 0 002 2h12a2 2 0 002-2V6a2 2 0 00-2-2h-5L9 2H4z" clip-rule="evenodd"/>
                </svg>
                <span class="font-mono">${t('filePicker.choose')}</span>
              </button>
            </div>
          `
          }
          
          <div class="mt-6 pt-6 border-t border-border/50">
            <button
              id="file-picker-cancel-button"
              @click=${this.handleCancel}
              class="w-full bg-bg-secondary border border-border/50 text-primary font-mono py-3 px-6 rounded-lg transition-all duration-200 hover:bg-surface hover:border-primary active:scale-95"
              ?disabled=${this.uploading}
            >
              ${t('common.cancel')}
            </button>
          </div>
        </div>
      </div>
    `;
  }
}
