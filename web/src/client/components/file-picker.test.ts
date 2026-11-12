// @vitest-environment happy-dom
/**
 * Unit tests for FilePicker component
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import './file-picker.js';
import type { FilePicker } from './file-picker.js';

// Private state the tests set directly.
type FilePickerInternals = {
  uploading: boolean;
  uploadProgress: number;
  fileInput: HTMLInputElement | null;
};
const internals = (el: FilePicker) => el as unknown as FilePickerInternals;

// Mock auth client
vi.mock('../services/auth-client.js', () => ({
  authClient: {
    getAuthHeader: () => ({ Authorization: 'Bearer test-token' }),
  },
}));

// Mock logger
vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({
    log: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('FilePicker Component', () => {
  let element: FilePicker;
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    container.innerHTML = '<file-picker></file-picker>';
    element = container.querySelector('file-picker') as FilePicker;
  });

  afterEach(() => {
    container.remove();
    vi.unstubAllGlobals();
  });

  it('should render when visible', async () => {
    element.visible = true;
    await element.updateComplete;

    const modal = element.querySelector('.fixed');
    expect(modal).toBeTruthy();
  });

  it('should not render when not visible', async () => {
    element.visible = false;
    await element.updateComplete;

    const modal = element.querySelector('.fixed');
    expect(modal).toBeFalsy();
  });

  it('should show upload progress when uploading', async () => {
    element.visible = true;
    internals(element).uploading = true;
    internals(element).uploadProgress = 50;
    await element.updateComplete;

    const progressText = element.querySelector('span');
    expect(progressText?.textContent).toContain('Uploading...');

    const progressBar = element.querySelector('.bg-gradient-to-r');
    expect(progressBar).toBeTruthy();
  });

  it('should show file selection button when not uploading', async () => {
    element.visible = true;
    internals(element).uploading = false;
    await element.updateComplete;

    const fileButton = element.querySelector('#file-picker-choose-button');
    expect(fileButton).toBeTruthy();
  });

  it('should emit file-cancel event when cancel button is clicked', async () => {
    element.visible = true;
    await element.updateComplete;

    const cancelEventSpy = vi.fn();
    element.addEventListener('file-cancel', cancelEventSpy);

    const cancelButton = element.querySelector<HTMLButtonElement>('#file-picker-cancel-button');

    expect(cancelButton).toBeTruthy();
    cancelButton?.click();

    expect(cancelEventSpy).toHaveBeenCalledOnce();
  });

  it('should emit file-cancel when clicking outside modal', async () => {
    element.visible = true;
    await element.updateComplete;

    const cancelEventSpy = vi.fn();
    element.addEventListener('file-cancel', cancelEventSpy);

    const backdrop = element.querySelector('.fixed');
    expect(backdrop).toBeTruthy();

    backdrop?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(cancelEventSpy).toHaveBeenCalledOnce();
  });

  it('should not emit file-cancel when clicking inside modal', async () => {
    element.visible = true;
    await element.updateComplete;

    const cancelEventSpy = vi.fn();
    element.addEventListener('file-cancel', cancelEventSpy);

    const modal = element.querySelector('.bg-elevated');
    expect(modal).toBeTruthy();

    modal?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(cancelEventSpy).not.toHaveBeenCalled();
  });

  it('should disable cancel button when uploading', async () => {
    element.visible = true;
    internals(element).uploading = true;
    await element.updateComplete;

    const cancelButton = element.querySelector('#file-picker-cancel-button');

    expect(cancelButton?.hasAttribute('disabled')).toBe(true);
  });

  it('should create file input element on connect', () => {
    // The file input should be created when the component connects
    const fileInputs = document.querySelectorAll('input[type="file"]');
    expect(fileInputs.length).toBeGreaterThan(0);
  });

  it('should handle file input click', async () => {
    element.visible = true;
    await element.updateComplete;

    const fileButton = element.querySelector<HTMLButtonElement>('#file-picker-choose-button');

    expect(fileButton).toBeTruthy();

    // Mock file input
    const mockFileInput = {
      removeAttribute: vi.fn(),
      click: vi.fn(),
      remove: vi.fn(),
    } as Pick<HTMLInputElement, 'removeAttribute' | 'click' | 'remove'>;
    internals(element).fileInput = mockFileInput as HTMLInputElement;

    fileButton?.click();

    expect(mockFileInput.removeAttribute).toHaveBeenCalledWith('capture');
    expect(mockFileInput.click).toHaveBeenCalled();
  });

  it('should accept any file type', () => {
    const fileInputs = document.querySelectorAll('input[type="file"]');
    const fileInput = fileInputs[fileInputs.length - 1] as HTMLInputElement;
    expect(fileInput.accept).toBe('*/*');
  });

  it('should clean up file input on disconnect', () => {
    const initialInputCount = document.querySelectorAll('input[type="file"]').length;

    element.remove();

    const finalInputCount = document.querySelectorAll('input[type="file"]').length;
    expect(finalInputCount).toBeLessThan(initialInputCount);
  });

  /** The user picks `file` in the browser's own chooser: the hidden input changes. */
  function choose(file: File) {
    const input = internals(element).fileInput as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change'));
  }

  function stubUpload(file: { name: string; type: string; relativePath: string }) {
    const xhr = {
      upload: { addEventListener: vi.fn() },
      addEventListener: vi.fn(),
      open: vi.fn(),
      setRequestHeader: vi.fn(),
      send: vi.fn(),
      status: 200,
      responseText: JSON.stringify({
        success: true,
        filename: file.name,
        originalName: file.name,
        size: 100,
        mimetype: file.type,
        path: `/path/to/${file.name}`,
        relativePath: file.relativePath,
      }),
    };
    vi.stubGlobal(
      'XMLHttpRequest',
      vi.fn(function XMLHttpRequest() {
        return xhr as unknown as XMLHttpRequest;
      })
    );
    return xhr;
  }

  it.each([
    { name: 'test.txt', type: 'text/plain', relativePath: 'test.txt' },
    { name: 'test.png', type: 'image/png', relativePath: 'uploads/test.png' },
  ])('uploads a chosen $type file and says which one it was', async (file) => {
    const xhr = stubUpload(file);
    const selected = vi.fn();
    element.addEventListener('file-selected', selected);

    choose(new File(['contents'], file.name, { type: file.type }));

    expect(xhr.send).toHaveBeenCalledOnce();
    const load = xhr.addEventListener.mock.calls.find((call) => call[0] === 'load');
    if (!load) throw new Error('the upload never listened for load');
    load[1]();
    await vi.waitFor(() => expect(selected).toHaveBeenCalledOnce());
    expect(selected.mock.calls[0][0].detail).toMatchObject({ relativePath: file.relativePath });
  });
});
