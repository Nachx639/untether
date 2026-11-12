/**
 * Phone chat mode: images waiting to go out with the next message, shown as a strip of
 * thumbnails above the composer (like iMessage/WhatsApp). Uploads start right away in the
 * background, but nothing reaches the terminal until Send (2026-10-02: the path used to be
 * typed straight into Claude before the message was written, with no thumbnail at all).
 */
import { css, html, LitElement, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { LocaleController, t } from '../i18n/index.js';
import { authClient } from '../services/auth-client.js';
import { a11yBaseStyles } from '../utils/a11y-base-styles.js';
import { swallowNextClick } from '../utils/ghost-click.js';
import { prepareImageForUpload } from '../utils/image-downscale.js';
import { materialControlStyles, materialSurfaceStyles } from '../utils/material-surface-styles.js';
import { endsADrag } from '../utils/pointer-drag.js';
import { reducedMotionStyles } from '../utils/reduced-motion.js';
import { icon } from './icons.js';
import { openImageLightbox } from './image-lightbox.js';
import { type UploadResult, uploadWithProgress } from './session-view/file-operations-manager.js';

export type AttachmentStatus = 'uploading' | 'done' | 'error';

export interface PendingAttachment {
  id: string;
  name: string;
  /** Object URL of the original file, for the thumbnail. */
  previewUrl: string;
  status: AttachmentStatus;
  percent: number;
  /** Absolute path on the server, once uploaded (or picked on the Mac). */
  path?: string;
  /** Already on the Mac (picked with «Archivo del Mac»): nothing to upload or retry. */
  onMac?: boolean;
  error?: string;
}

export type AttachmentUploader = (
  file: File,
  onProgress: (percent: number) => void,
  signal: AbortSignal
) => Promise<Pick<UploadResult, 'path'>>;

/** Downscale big photos, then upload with progress. */
export const uploadAttachment: AttachmentUploader = async (file, onProgress, signal) => {
  const prepared = await prepareImageForUpload(file);
  if (signal.aborted) throw new Error('aborted');
  return uploadWithProgress(prepared, onProgress, signal);
};

let nextId = 0;

/** The attachments' state; the composer owns one and renders it with <chat-attachment-strip>. */
export class AttachmentQueue {
  items: PendingAttachment[] = [];
  private files = new Map<string, File>();
  private controllers = new Map<string, AbortController>();

  constructor(
    private readonly onChange: () => void,
    private readonly upload: AttachmentUploader = uploadAttachment
  ) {}

  add(files: File[]): void {
    for (const file of files) {
      const id = `att-${++nextId}`;
      this.files.set(id, file);
      this.items = [
        ...this.items,
        {
          id,
          name: file.name || t('attach.image'),
          previewUrl: createObjectUrl(file),
          status: 'uploading',
          percent: 0,
        },
      ];
      void this.start(id);
    }
    this.onChange();
  }

  /**
   * Files picked on the Mac itself (user report: a PDF in ~/Downloads could not be found from
   * the phone's own picker). They are already where the agent runs, so they go out as their
   * absolute paths with no upload; images get a thumbnail fetched from /api/fs/raw.
   */
  addPaths(files: Array<{ path: string; name?: string; size?: number }>): void {
    for (const file of files) {
      if (this.items.some((i) => i.onMac && i.path === file.path)) continue;
      const id = `att-${++nextId}`;
      const name = file.name || file.path.split('/').pop() || file.path;
      this.items = [
        ...this.items,
        { id, name, previewUrl: '', status: 'done', percent: 100, path: file.path, onMac: true },
      ];
      if (isPreviewableImage(name) && (file.size ?? 0) <= MAX_PREVIEW_BYTES) {
        void this.loadMacPreview(id, file.path);
      }
    }
    this.onChange();
  }

  private async loadMacPreview(id: string, path: string): Promise<void> {
    try {
      const response = await authClient.fetch(`/api/fs/raw?${new URLSearchParams({ path })}`);
      if (!response.ok) return;
      const url = createObjectUrl(await response.blob());
      // Removed while it loaded: free it instead.
      if (!this.items.some((i) => i.id === id)) {
        revokeObjectUrl(url);
        return;
      }
      if (url) this.patch(id, { previewUrl: url });
    } catch {
      // No thumbnail: the tile shows the file icon and name.
    }
  }

  remove(id: string): void {
    const item = this.items.find((i) => i.id === id);
    if (!item) return;
    this.controllers.get(id)?.abort();
    this.controllers.delete(id);
    this.files.delete(id);
    revokeObjectUrl(item.previewUrl);
    this.items = this.items.filter((i) => i.id !== id);
    this.onChange();
  }

  retry(id: string): void {
    if (!this.items.some((i) => i.id === id && i.status === 'error')) return;
    void this.start(id);
  }

  /** Some upload still running: the message cannot go yet. */
  get busy(): boolean {
    return this.items.some((i) => i.status === 'uploading');
  }

  get hasErrors(): boolean {
    return this.items.some((i) => i.status === 'error');
  }

  /** Server paths of the uploaded attachments, in the order they were added. */
  get paths(): string[] {
    return this.items.flatMap((i) => (i.status === 'done' && i.path ? [i.path] : []));
  }

  /** After sending: forget the attachments (the sent bubble loads its own copy). */
  clear(): void {
    for (const id of this.items.map((i) => i.id)) this.remove(id);
  }

  private patch(id: string, change: Partial<PendingAttachment>) {
    this.items = this.items.map((i) => (i.id === id ? { ...i, ...change } : i));
    this.onChange();
  }

  private async start(id: string): Promise<void> {
    const file = this.files.get(id);
    if (!file) return;
    const controller = new AbortController();
    this.controllers.set(id, controller);
    this.patch(id, { status: 'uploading', percent: 0, error: undefined });
    try {
      const result = await this.upload(
        file,
        (percent) => {
          if (!controller.signal.aborted) this.patch(id, { percent });
        },
        controller.signal
      );
      if (controller.signal.aborted) return;
      this.patch(id, { status: 'done', percent: 100, path: result.path });
    } catch (error) {
      if (controller.signal.aborted) return;
      this.patch(id, {
        status: 'error',
        error: error instanceof Error ? error.message : t('toast.uploadFailed'),
      });
    } finally {
      if (this.controllers.get(id) === controller) this.controllers.delete(id);
    }
  }
}

/** Mac images worth a thumbnail; bigger ones would cost the phone a long download. */
const MAX_PREVIEW_BYTES = 15 * 1024 * 1024;

function isPreviewableImage(name: string): boolean {
  return /\.(png|jpe?g|gif|webp|heic|heif|avif|bmp)$/i.test(name);
}

function createObjectUrl(file: Blob): string {
  try {
    return URL.createObjectURL(file);
  } catch {
    return '';
  }
}

function revokeObjectUrl(url: string) {
  if (!url) return;
  try {
    URL.revokeObjectURL(url);
  } catch {
    // Nothing to free.
  }
}

/** Act on pointerup (first taps on iOS can be eaten as hover) and eat the ghost click. */
function tap(action: () => void) {
  return (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'pointerup') {
      // A scroll of the strip that started on it ends here too: not a tap.
      if (endsADrag(e as PointerEvent)) return;
      swallowNextClick();
    }
    action();
  };
}

/** The progress ring's circumference (r = 13). */
const RING = 2 * Math.PI * 13;

@customElement('chat-attachment-strip')
export class ChatAttachmentStrip extends LitElement {
  static styles = [
    materialSurfaceStyles,
    reducedMotionStyles,
    a11yBaseStyles,
    css`
    /* Phone composer tiles (phone-spec §3.5, 2026-10-12): 64 pt inside the capsule, sans text,
       progress as a ring, Retry as a 44 px round icon, the remove x 22 px with a 44 px hit area
       that the tile does not clip. */
    :host {
      display: block;
      font-family: var(--font-ui, -apple-system, BlinkMacSystemFont, system-ui, sans-serif);
    }
    .strip {
      display: flex;
      gap: 12px;
      overflow-x: auto;
      padding: 10px 10px 4px;
      scrollbar-width: none;
    }
    .item {
      position: relative;
      flex: 0 0 auto;
      width: 64px;
      height: 64px;
    }
    .tile {
      position: absolute;
      inset: 0;
      border-radius: var(--ut-r-12);
      overflow: hidden;
      background: var(--color-bg-tertiary);
      border: 1px solid var(--color-border);
    }
    .item.error .tile {
      border-color: var(--color-status-error);
    }
    .thumb {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
      cursor: pointer;
    }
    .file {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 2px;
      width: 100%;
      height: 100%;
      padding: 4px;
      box-sizing: border-box;
      font-size: 11px;
      line-height: 13px;
      color: var(--color-text-muted);
      text-align: center;
      overflow: hidden;
      overflow-wrap: anywhere;
    }
    .file svg {
      flex: 0 0 auto;
    }
    .overlay {
      position: absolute;
      inset: 0;
      display: grid;
      place-items: center;
      background: color-mix(in srgb, var(--color-bg) 45%, transparent);
      color: var(--color-text);
      pointer-events: none;
    }
    .ring {
      width: 30px;
      height: 30px;
      transform: rotate(-90deg);
    }
    .ring circle {
      fill: none;
      stroke-width: 3;
    }
    .ring .track {
      stroke: color-mix(in srgb, var(--color-text) 25%, transparent);
    }
    .ring .fill {
      stroke: var(--color-text-bright, var(--color-text));
      stroke-linecap: round;
      transition: stroke-dashoffset 0.2s;
    }
    .retry {
      position: absolute;
      top: 10px;
      left: 10px;
      width: 44px;
      height: 44px;
      padding: 0;
      display: grid;
      place-items: center;
      border: none;
      border-radius: var(--ut-r-circle);
      background: color-mix(in srgb, var(--color-bg) 78%, transparent);
      color: var(--color-status-error-text);
      cursor: pointer;
      touch-action: manipulation;
    }
    .remove {
      position: absolute;
      top: -6px;
      right: -6px;
      z-index: 1;
      width: 22px;
      height: 22px;
      padding: 0;
      border-radius: var(--ut-r-circle);
      border: 1px solid var(--color-border);
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--color-bg-elevated);
      color: var(--color-text);
      cursor: pointer;
      touch-action: manipulation;
    }
    .remove::after {
      content: '';
      position: absolute;
      inset: -11px;
    }
  `,
    materialControlStyles,
  ];

  private locale = new LocaleController(this);

  @property({ attribute: false }) items: PendingAttachment[] = [];
  /** Thumbnails the browser could not decode (e.g. HEIC outside Safari): show a file icon. */
  private broken = new Set<string>();

  private emit(name: 'attachment-remove' | 'attachment-retry', id: string) {
    this.dispatchEvent(new CustomEvent(name, { detail: { id }, bubbles: true, composed: true }));
  }

  private renderPreview(item: PendingAttachment) {
    if (item.previewUrl && !this.broken.has(item.id)) {
      return html`<img
        class="thumb"
        src=${item.previewUrl}
        alt=${item.name}
        @error=${() => {
          this.broken.add(item.id);
          this.requestUpdate();
        }}
        @pointerup=${tap(() => openImageLightbox(item.previewUrl, item.name))}
        @click=${tap(() => openImageLightbox(item.previewUrl, item.name))}
      />`;
    }
    return html`<div class="ut-surface--panel file" data-testid="attachment-file">
      ${icon('fileText', 20)}
      <span>${item.name}</span>
    </div>`;
  }

  render() {
    void this.locale;
    if (this.items.length === 0) return nothing;
    return html`<div class="strip" role="list" aria-label=${t('attach.pending')}>
      ${this.items.map(
        (item) => html`<div
          class="item ${item.status}"
          role="listitem"
          data-testid="attachment"
          data-status=${item.status}
        >
          <div class="tile">
          ${this.renderPreview(item)}
          ${
            item.status === 'uploading'
              ? html`<div class="overlay" role="progressbar" aria-valuenow=${item.percent}
                    aria-valuemin="0" aria-valuemax="100" aria-label=${t('attach.uploading', { percent: item.percent })}>
                    <svg class="ring" viewBox="0 0 32 32" aria-hidden="true">
                      <circle class="track" cx="16" cy="16" r="13" />
                      <circle
                        class="fill"
                        cx="16"
                        cy="16"
                        r="13"
                        stroke-dasharray=${RING}
                        stroke-dashoffset=${RING * (1 - Math.min(100, Math.max(0, item.percent)) / 100)}
                      />
                    </svg>
                  </div>`
              : nothing
          }
          </div>
          ${
            item.status === 'error'
              ? html`<button
                  class="ut-surface--control retry"
                  data-action="retry"
                  title=${item.error ?? t('phone.retry')}
                  aria-label=${t('phone.retry')}
                  @pointerup=${tap(() => this.emit('attachment-retry', item.id))}
                  @click=${tap(() => this.emit('attachment-retry', item.id))}
                >
                  ${icon('restart', 20)}
                </button>`
              : nothing
          }
          <button
            class="ut-surface--control remove"
            data-action="remove"
            aria-label=${t('attach.remove')}
            title=${t('attach.remove')}
            @pointerup=${tap(() => this.emit('attachment-remove', item.id))}
            @click=${tap(() => this.emit('attachment-remove', item.id))}
          >
            ${icon('x', 14)}
          </button>
        </div>`
      )}
    </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'chat-attachment-strip': ChatAttachmentStrip;
  }
}
