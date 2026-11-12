/**
 * FileOperationsManager
 *
 * Handles all file-related operations for the session view including:
 * - Drag and drop file handling
 * - File upload functionality
 * - Clipboard paste handling for files/images
 * - Path insertion into terminal
 */

import type { Session } from '../../../shared/types.js';
import { t } from '../../i18n/index.js';
import { authClient } from '../../services/auth-client.js';
import { Z_INDEX } from '../../utils/constants.js';
import { prepareImageForUpload } from '../../utils/image-downscale.js';
import { createLogger } from '../../utils/logger.js';
import { shellQuotePath } from '../../utils/shell-quote.js';
import type { FilePicker } from '../file-picker.js';
import type { InputManager } from './input-manager.js';

const logger = createLogger('file-operations-manager');

export interface UploadResult {
  path: string;
  filename: string;
  size: number;
  mimetype: string;
}

/**
 * Upload one file to the authenticated `/api/files/upload` route, reporting progress (0–100).
 * XMLHttpRequest because fetch still has no upload progress in Safari.
 */
export function uploadWithProgress(
  file: File,
  onProgress: (percent: number) => void,
  signal?: AbortSignal
): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    signal?.addEventListener('abort', () => xhr.abort());
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable && e.total > 0) {
        onProgress(Math.min(100, Math.round((e.loaded / e.total) * 100)));
      }
    });
    xhr.addEventListener('load', () => {
      let body: { success?: boolean; error?: string } & Partial<UploadResult> = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // Fall through to the status-based message below.
      }
      if (xhr.status >= 200 && xhr.status < 300 && body.success && body.path) {
        resolve({
          path: body.path,
          filename: body.filename ?? file.name,
          size: body.size ?? file.size,
          mimetype: body.mimetype ?? file.type,
        });
        return;
      }
      reject(new Error(body.error || `HTTP ${xhr.status}`));
    });
    xhr.addEventListener('error', () => reject(new Error(t('toast.uploadFailed'))));
    xhr.addEventListener('abort', () => reject(new Error(t('toast.uploadFailed'))));

    xhr.open('POST', '/api/files/upload');
    for (const [key, value] of Object.entries(authClient.getAuthHeader())) {
      xhr.setRequestHeader(key, value);
    }
    const form = new FormData();
    form.append('file', file);
    onProgress(0);
    xhr.send(form);
  });
}

export interface FileOperationsCallbacks {
  getSession: () => Session | null;
  getInputManager: () => InputManager | null;
  querySelector: (selector: string) => Element | null;
  setIsDragOver: (value: boolean) => void;
  setShowFileBrowser: (value: boolean) => void;
  setShowImagePicker: (value: boolean) => void;
  getIsMobile: () => boolean;
  getShowFileBrowser: () => boolean;
  getShowImagePicker: () => boolean;
  dispatchEvent: (event: Event) => boolean;
  requestUpdate: () => void;
  /** Phone chat mode: put the text in the composer instead of the terminal. True if handled. */
  insertIntoComposer?: (text: string) => boolean;
  /**
   * Phone chat mode: hand picked/pasted/dropped files to the composer's attachment strip, so
   * they go out with the next message instead of being typed into the terminal now. True if
   * handled.
   */
  attachToComposer?: (files: File[]) => boolean;
}

export class FileOperationsManager {
  private callbacks: FileOperationsCallbacks | null = null;
  private dragCounter = 0;
  private dragLeaveTimer: ReturnType<typeof setTimeout> | null = null;
  private globalDragOverTimer: ReturnType<typeof setTimeout> | null = null;
  private imageInput: HTMLInputElement | null = null;
  private anyFileInput: HTMLInputElement | null = null;
  private uploadStatusEl: HTMLElement | null = null;

  // Bound event handlers for cleanup
  private boundHandleDragOver: (e: DragEvent) => void;
  private boundHandleDragEnter: (e: DragEvent) => void;
  private boundHandleDragLeave: (e: DragEvent) => void;
  private boundHandleDrop: (e: DragEvent) => void;
  private boundHandlePaste: (e: ClipboardEvent) => void;
  private boundHandleDragEnd: (e: DragEvent) => void;
  private boundGlobalDragOver: (e: DragEvent) => void;

  constructor() {
    // Bind event handlers
    this.boundHandleDragOver = this.handleDragOver.bind(this);
    this.boundHandleDragEnter = this.handleDragEnter.bind(this);
    this.boundHandleDragLeave = this.handleDragLeave.bind(this);
    this.boundHandleDrop = this.handleDrop.bind(this);
    this.boundHandlePaste = this.handlePaste.bind(this);
    this.boundHandleDragEnd = this.handleDragEnd.bind(this);
    this.boundGlobalDragOver = this.handleGlobalDragOver.bind(this);
  }

  setCallbacks(callbacks: FileOperationsCallbacks): void {
    this.callbacks = callbacks;
  }

  setupEventListeners(element: HTMLElement): void {
    element.addEventListener('dragover', this.boundHandleDragOver);
    element.addEventListener('dragenter', this.boundHandleDragEnter);
    element.addEventListener('dragleave', this.boundHandleDragLeave);
    element.addEventListener('drop', this.boundHandleDrop);
    document.addEventListener('paste', this.boundHandlePaste);
    // Add dragend to handle cancelled drag operations
    document.addEventListener('dragend', this.boundHandleDragEnd);
    // Add global dragover to detect when dragging outside our element
    document.addEventListener('dragover', this.boundGlobalDragOver, true);
  }

  removeEventListeners(element: HTMLElement): void {
    element.removeEventListener('dragover', this.boundHandleDragOver);
    element.removeEventListener('dragenter', this.boundHandleDragEnter);
    element.removeEventListener('dragleave', this.boundHandleDragLeave);
    element.removeEventListener('drop', this.boundHandleDrop);
    document.removeEventListener('paste', this.boundHandlePaste);
    document.removeEventListener('dragend', this.boundHandleDragEnd);
    document.removeEventListener('dragover', this.boundGlobalDragOver, true);
    for (const controller of this.uploadControllers) controller.abort();
    this.uploadControllers.clear();

    // Clear any pending timers
    if (this.dragLeaveTimer) {
      clearTimeout(this.dragLeaveTimer);
      this.dragLeaveTimer = null;
    }
    if (this.globalDragOverTimer) {
      clearTimeout(this.globalDragOverTimer);
      this.globalDragOverTimer = null;
    }

    // Reset drag state
    this.dragCounter = 0;
    if (this.callbacks) {
      this.callbacks.setIsDragOver(false);
    }

    this.imageInput?.remove();
    this.imageInput = null;
    this.anyFileInput?.remove();
    this.anyFileInput = null;
    this.hideUploadStatus();
  }

  // File browser methods
  openFileBrowser(): void {
    if (this.callbacks) {
      this.callbacks.setShowFileBrowser(true);
    }
  }

  closeFileBrowser(): void {
    if (this.callbacks) {
      this.callbacks.setShowFileBrowser(false);
    }
  }

  // File picker methods
  openFilePicker(): void {
    if (!this.callbacks) return;

    if (!this.callbacks.getIsMobile()) {
      // On desktop, directly open the file picker without showing the dialog
      const filePicker = this.callbacks.querySelector('file-picker') as FilePicker | null;
      if (filePicker && typeof filePicker.openFilePicker === 'function') {
        filePicker.openFilePicker();
      }
    } else {
      // On mobile, show the file picker dialog
      this.callbacks.setShowImagePicker(true);
    }
  }

  closeFilePicker(): void {
    if (this.callbacks) {
      this.callbacks.setShowImagePicker(false);
    }
  }

  // Image operations
  /**
   * Opens the photo picker («Foto o vídeo»). We own this input (instead of the file-picker's)
   * so the picked photo can be downscaled before it is uploaded. Videos too: a screen
   * recording is the easiest way to show a phone bug (user report).
   */
  selectImage(): void {
    if (!this.callbacks) return;
    this.imageInput ??= this.createPickerInput('image/*,video/*');
    this.imageInput.click();
  }

  /**
   * Any file from this device («Archivo del iPhone»). No accept filter: on iOS a PDF in Files
   * or iCloud Drive is then not greyed out (user report).
   */
  selectFiles(): void {
    if (!this.callbacks) return;
    this.anyFileInput ??= this.createPickerInput('');
    this.anyFileInput.click();
  }

  private createPickerInput(accept: string): HTMLInputElement {
    const input = document.createElement('input');
    input.type = 'file';
    if (accept) input.accept = accept;
    input.multiple = true;
    input.style.display = 'none';
    input.addEventListener('change', () => {
      const files = Array.from(input.files || []);
      // Reset so picking the same file again still fires `change`.
      input.value = '';
      void this.handleImagesPicked(files);
    });
    document.body.appendChild(input);
    return input;
  }

  async handleImagesPicked(files: File[]): Promise<void> {
    await this.attachFiles(files);
  }

  async pasteImage(): Promise<void> {
    if (!this.callbacks) return;

    try {
      const clipboardItems = await navigator.clipboard.read();

      for (const clipboardItem of clipboardItems) {
        const imageTypes = clipboardItem.types.filter((type) => type.startsWith('image/'));

        for (const imageType of imageTypes) {
          const blob = await clipboardItem.getType(imageType);
          const file = new File([blob], `pasted-image.${imageType.split('/')[1]}`, {
            type: imageType,
          });

          await this.attachFiles([file]);
          logger.log(`Successfully pasted image from clipboard`);
          return;
        }
      }

      // No image found in clipboard
      logger.log('No image found in clipboard');
      this.callbacks.dispatchEvent(
        new CustomEvent('error', {
          detail: t('toast.noClipboardImage'),
          bubbles: true,
          composed: true,
        })
      );
    } catch (error) {
      logger.error('Failed to paste image from clipboard:', error);
      this.callbacks.dispatchEvent(
        new CustomEvent('error', {
          detail: t('toast.clipboardAccessFailed'),
          bubbles: true,
          composed: true,
        })
      );
    }
  }

  // File selection handling
  async handleFileSelected(path: string, preEscaped = false): Promise<void> {
    if (!this.callbacks) return;

    const session = this.callbacks.getSession();
    const inputManager = this.callbacks.getInputManager();

    if (!path || !session || !inputManager) return;

    // Close the file picker
    this.callbacks.setShowImagePicker(false);

    const escapedPath = preEscaped ? path : shellQuotePath(path);

    // Send the path to the terminal
    await inputManager.sendInputText(escapedPath);

    logger.log(`inserted file path into terminal: ${escapedPath}`);
  }

  handleFileError(error: string): void {
    if (!this.callbacks) return;

    logger.error('File picker error:', error);
    this.callbacks.dispatchEvent(new CustomEvent('error', { detail: error }));
  }

  // Path insertion
  async insertPath(path: string, type: string): Promise<void> {
    if (!this.callbacks) return;

    const session = this.callbacks.getSession();

    if (!path || !session) return;

    const escapedPath = shellQuotePath(path);

    if (this.callbacks.insertIntoComposer?.(escapedPath)) {
      logger.log(`inserted ${type} path into the chat composer: ${escapedPath}`);
      return;
    }

    // Send the path to the terminal
    const inputManager = this.callbacks.getInputManager();
    if (inputManager) {
      await inputManager.sendInputText(escapedPath);
    }

    logger.log(`inserted ${type} path into terminal: ${escapedPath}`);
  }

  // Reset drag state
  resetDragState(): void {
    // Clear any pending drag leave timer
    if (this.dragLeaveTimer) {
      clearTimeout(this.dragLeaveTimer);
      this.dragLeaveTimer = null;
    }

    this.dragCounter = 0;
    if (this.callbacks) {
      this.callbacks.setIsDragOver(false);
    }
  }

  // Drag & Drop handlers
  handleDragOver(e: DragEvent): void {
    e.preventDefault();
    e.stopPropagation();

    // Clear any pending timers
    if (this.dragLeaveTimer) {
      clearTimeout(this.dragLeaveTimer);
      this.dragLeaveTimer = null;
    }
    if (this.globalDragOverTimer) {
      clearTimeout(this.globalDragOverTimer);
      this.globalDragOverTimer = null;
    }

    // Check if the drag contains files
    if (e.dataTransfer?.types.includes('Files') && this.callbacks) {
      this.callbacks.setIsDragOver(true);
    }
  }

  handleDragEnter(e: DragEvent): void {
    e.preventDefault();
    e.stopPropagation();

    // Clear any pending drag leave timer
    if (this.dragLeaveTimer) {
      clearTimeout(this.dragLeaveTimer);
      this.dragLeaveTimer = null;
    }

    this.dragCounter++;

    // Check if the drag contains files
    if (e.dataTransfer?.types.includes('Files') && this.callbacks) {
      this.callbacks.setIsDragOver(true);
    }
  }

  handleDragLeave(e: DragEvent): void {
    e.preventDefault();
    e.stopPropagation();

    this.dragCounter--;

    // Use a timer to handle the drag leave to avoid flicker when moving between elements
    if (this.dragLeaveTimer) {
      clearTimeout(this.dragLeaveTimer);
    }

    this.dragLeaveTimer = setTimeout(() => {
      // Check if we're really outside the drop zone
      if (this.dragCounter <= 0 && this.callbacks) {
        this.callbacks.setIsDragOver(false);
        this.dragCounter = 0; // Reset to 0 to handle any counting inconsistencies
      }
    }, 100); // Small delay to handle rapid enter/leave events
  }

  async handleDrop(e: DragEvent): Promise<void> {
    e.preventDefault();
    e.stopPropagation();

    // Clear any pending drag leave timer
    if (this.dragLeaveTimer) {
      clearTimeout(this.dragLeaveTimer);
      this.dragLeaveTimer = null;
    }

    if (this.callbacks) {
      this.callbacks.setIsDragOver(false);
    }
    this.dragCounter = 0; // Reset counter on drop

    const files = Array.from(e.dataTransfer?.files || []);

    if (files.length === 0) {
      logger.warn('No files found in drop');
      return;
    }

    await this.attachFiles(files);
  }

  handleDragEnd(e: DragEvent): void {
    e.preventDefault();
    e.stopPropagation();

    // Clear any pending drag leave timer
    if (this.dragLeaveTimer) {
      clearTimeout(this.dragLeaveTimer);
      this.dragLeaveTimer = null;
    }

    // Reset drag state when drag operation ends (e.g., user cancels with ESC)
    this.dragCounter = 0;
    if (this.callbacks) {
      this.callbacks.setIsDragOver(false);
    }

    logger.debug('Drag operation ended, resetting drag state');
  }

  handleGlobalDragOver(_e: DragEvent): void {
    // Clear any existing timer
    if (this.globalDragOverTimer) {
      clearTimeout(this.globalDragOverTimer);
      this.globalDragOverTimer = null;
    }

    // If we have an active drag state, set a timer to clear it if no drag events occur
    if (this.callbacks && this.dragCounter > 0) {
      this.globalDragOverTimer = setTimeout(() => {
        // If no drag events have occurred for 500ms, assume the drag left the window
        this.dragCounter = 0;
        if (this.callbacks) {
          this.callbacks.setIsDragOver(false);
        }
        logger.debug('No drag events detected, clearing drag state');
      }, 500);
    }
  }

  // Paste handler
  async handlePaste(e: ClipboardEvent): Promise<void> {
    if (!this.callbacks) return;

    // Check if paste handling should be enabled
    const showFileBrowser = this.callbacks.getShowFileBrowser();
    const showImagePicker = this.callbacks.getShowImagePicker();

    if (!this.shouldHandlePaste(showFileBrowser, showImagePicker)) {
      return; // Don't handle paste when modals are open
    }

    const items = Array.from(e.clipboardData?.items || []);
    const fileItems = items.filter((item) => item.kind === 'file');

    if (fileItems.length === 0) {
      return; // Let normal paste handling continue
    }

    e.preventDefault(); // Prevent default paste behavior for files

    const files = fileItems
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    await this.attachFiles(files);
  }

  // File upload
  /**
   * Uploads `files` one after another (images downscaled first) with a progress pill,
   * then types all their paths, space-separated, in one go. If one fails, the paths
   * already uploaded are typed and the pill offers Retry for the rest.
   */
  async attachFiles(files: File[]): Promise<void> {
    if (files.length > 0 && this.callbacks?.attachToComposer?.(files)) return;
    await this.uploadBatch([...files], 0, files.length, false);
  }

  private async uploadBatch(
    files: File[],
    offset: number,
    total: number,
    continuing: boolean
  ): Promise<void> {
    if (!this.callbacks || files.length === 0) return;

    // Leaving the session cancels the upload: no pill over the next screen, and no path
    // typed into the session the user left.
    const controller = new AbortController();
    this.uploadControllers.add(controller);
    const { signal } = controller;
    try {
      await this.runBatch(files, offset, total, continuing, signal);
    } finally {
      this.uploadControllers.delete(controller);
    }
  }

  private async runBatch(
    files: File[],
    offset: number,
    total: number,
    continuing: boolean,
    signal: AbortSignal
  ): Promise<void> {
    const paths: string[] = [];
    for (let i = 0; i < files.length; i++) {
      const current = offset + i + 1;
      const label = (percent: number) =>
        total > 1
          ? t('attach.uploadingMany', { current, total, percent })
          : t('attach.uploading', { percent });

      try {
        this.showUploadStatus({ text: t('attach.preparing'), percent: 0 });
        const file = await prepareImageForUpload(files[i]);
        if (signal.aborted) return;
        if (file !== files[i]) {
          logger.log(
            `downscaled ${file.name}: ${Math.round(files[i].size / 1024)} KB -> ${Math.round(file.size / 1024)} KB`
          );
          files[i] = file; // A retry re-sends the small copy.
        }
        const result = await uploadWithProgress(
          file,
          (percent) => {
            if (!signal.aborted) this.showUploadStatus({ text: label(percent), percent });
          },
          signal
        );
        paths.push(result.path);
      } catch (error) {
        if (signal.aborted) return;
        const message = error instanceof Error ? error.message : t('toast.uploadFailed');
        logger.error(`Failed to upload ${files[i].name}:`, error);
        await this.insertUploadedPaths(paths, continuing);
        const rest = files.slice(i);
        this.showUploadStatus({
          text: t('attach.failed', { error: message }),
          error: true,
          onRetry: () =>
            void this.uploadBatch(rest, offset + i, total, continuing || paths.length > 0),
        });
        return;
      }
    }

    if (signal.aborted) return;
    this.hideUploadStatus();
    await this.insertUploadedPaths(paths, continuing);
  }

  private readonly uploadControllers = new Set<AbortController>();

  /** Types the uploaded paths into the terminal, quoted when needed and space-separated. */
  private async insertUploadedPaths(paths: string[], continuing: boolean): Promise<void> {
    if (paths.length === 0) return;
    const text = paths.map(shellQuotePath).join(' ');
    // Paths from an earlier chunk of the same batch are already typed; keep them apart.
    await this.handleFileSelected(continuing ? ` ${text}` : text, true);
  }

  private showUploadStatus(state: {
    text: string;
    percent?: number;
    error?: boolean;
    onRetry?: () => void;
  }): void {
    if (!this.uploadStatusEl) {
      const el = document.createElement('div');
      el.className = 'ut-upload-status';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      el.style.cssText = [
        'position:fixed',
        'left:50%',
        'transform:translateX(-50%)',
        'bottom:calc(env(safe-area-inset-bottom, 0px) + 88px)',
        `z-index:${Z_INDEX.NOTIFICATION}`,
        'display:flex',
        'flex-direction:column',
        'gap:6px',
        'min-width:200px',
        'max-width:calc(100vw - 32px)',
        'padding:8px 12px',
        'border-radius:var(--ut-r-lg)',
        'font-size:13px',
        'background:var(--color-bg-elevated)',
        'color:var(--color-text)',
        'border:1px solid var(--color-border)',
        'box-shadow:var(--ut-drop-16-30)',
      ].join(';');
      document.body.appendChild(el);
      this.uploadStatusEl = el;
    }
    const el = this.uploadStatusEl;
    el.replaceChildren();
    el.style.borderColor = state.error ? 'var(--color-status-error)' : 'var(--color-border)';

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:10px';
    const label = document.createElement('span');
    label.className = 'ut-upload-status-text';
    label.style.cssText = 'flex:1;min-width:0;overflow-wrap:anywhere';
    label.textContent = state.text;
    row.appendChild(label);

    if (state.error) {
      const button = (text: string, action: string, onClick: () => void) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset.action = action;
        b.textContent = text;
        b.style.cssText =
          'padding:4px 10px;border-radius:var(--ut-r-md);border:1px solid var(--color-border);background:var(--color-bg-secondary);color:var(--color-text);font:inherit';
        b.addEventListener('click', onClick);
        row.appendChild(b);
      };
      if (state.onRetry) {
        const retry = state.onRetry;
        button(t('attach.retry'), 'retry', () => retry());
      }
      button(t('attach.dismiss'), 'dismiss', () => this.hideUploadStatus());
    }
    el.appendChild(row);

    if (!state.error) {
      const track = document.createElement('div');
      track.style.cssText =
        'height:4px;border-radius:var(--ut-r-2);overflow:hidden;background:var(--color-bg-secondary)';
      const bar = document.createElement('div');
      bar.className = 'ut-upload-status-bar';
      bar.style.cssText = `height:100%;width:${state.percent ?? 0}%;background:var(--color-primary);transition:width 0.2s`;
      track.appendChild(bar);
      el.appendChild(track);
    }
  }

  private hideUploadStatus(): void {
    this.uploadStatusEl?.remove();
    this.uploadStatusEl = null;
  }

  // Check if paste handling should be enabled
  shouldHandlePaste(showFileBrowser: boolean, showImagePicker: boolean): boolean {
    return !showFileBrowser && !showImagePicker;
  }
}
