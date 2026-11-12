// @vitest-environment happy-dom
/**
 * Unit tests for SessionView drag & drop and paste functionality
 */

import { fixture, html } from '@open-wc/testing';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { waitForAsync } from '@/test/utils/component-helpers';
import { createMockSession } from '@/test/utils/lit-test-utils';
import type { UIStateManager } from './session-view/ui-state-manager.js';
import type { SessionView } from './session-view.js';

// SessionView's private manager that these tests read and drive directly
type SessionViewInternals = { uiStateManager: UIStateManager };
const internals = (view: SessionView) => view as unknown as SessionViewInternals;

// Mock auth client
vi.mock('../services/auth-client.js', () => ({
  authClient: {
    getAuthHeader: () => ({ Authorization: 'Bearer test-token' }),
    getCurrentUser: () => ({ username: 'test-user' }),
  },
}));

// Mock logger - store the mock functions so we can access them
const mockLogger = {
  log: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
};

vi.mock('../utils/logger.js', () => ({
  createLogger: () => mockLogger,
}));

// Mock other dependencies
vi.mock('../utils/terminal-preferences.js', () => ({
  TERMINAL_THEME_CHANGED_EVENT: 'terminal-theme-changed',
  TerminalPreferencesManager: {
    getInstance: () => ({
      getFontSize: () => 14,
      getMaxCols: () => 0,
      setMaxCols: vi.fn(),
      getTheme: () => 'auto',
      getAutoThemePair: () => ({ dark: 'untether', light: 'untether-light' }),
      setTheme: vi.fn(),
      setFontSize: vi.fn(),
      getTerminalSettings: () => ({}),
    }),
  },
  COMMON_TERMINAL_WIDTHS: [
    { label: '80', value: 80 },
    { label: '120', value: 120 },
  ],
}));

vi.mock('../services/repository-service.js', () => ({
  repositoryService: {
    getRepositoryPath: vi.fn().mockReturnValue(null),
    setRepositoryPath: vi.fn(),
    getActiveRepository: vi.fn().mockReturnValue(null),
  },
}));

vi.mock('./session-view/session-action-manager.js', () => ({
  SessionActionManager: class {
    setAuthClient = vi.fn();
    setCallbacks = vi.fn();
    terminateSession = vi.fn().mockResolvedValue({ success: true });
    clearSession = vi.fn().mockResolvedValue({ success: true });
  },
}));

describe('SessionView Drag & Drop and Paste', () => {
  let element: SessionView;
  let mockFilePicker: { uploadFile: Mock<(file: File) => Promise<void>> };

  /**
   * Uploads go straight to /api/files/upload over XMLHttpRequest (for progress). This fake
   * hands each uploaded file to `mockFilePicker.uploadFile`, so a test still controls
   * success/failure by resolving or rejecting that mock.
   */
  class FakeXHR {
    status = 0;
    responseText = '';
    upload = { addEventListener: vi.fn() };
    private listeners: Record<string, () => void> = {};
    addEventListener(type: string, cb: () => void) {
      this.listeners[type] = cb;
    }
    open = vi.fn();
    setRequestHeader = vi.fn();
    send(form: FormData) {
      const file = form.get('file') as File;
      Promise.resolve(mockFilePicker.uploadFile?.(file)).then(
        () => {
          this.status = 200;
          this.responseText = JSON.stringify({
            success: true,
            path: `/uploads/${file.name}`,
            filename: file.name,
          });
          this.listeners.load?.();
        },
        (error: Error) => {
          this.status = 500;
          this.responseText = JSON.stringify({ error: error.message });
          this.listeners.load?.();
        }
      );
    }
  }

  beforeAll(async () => {
    // Import components to register custom elements
    await import('./session-view.js');
    await import('./terminal.js');
    await import('./session-view/terminal-renderer.js');
  });

  // Helper to access the uiStateManager from the element
  const _getUiStateManager = () => {
    // biome-ignore lint/complexity/useLiteralKeys: accessing private property for testing
    // biome-ignore lint/suspicious/noExplicitAny: need to access private property
    return (element as any)['uiStateManager'];
  };

  // Helper to create a mock drag event with dataTransfer
  function createDragEvent(type: string, hasFiles = false): DragEvent {
    const event = new DragEvent(type, {
      bubbles: true,
      cancelable: true,
    });

    // Mock the dataTransfer property
    const mockDataTransfer = {
      types: hasFiles ? ['Files'] : ['text/plain'],
      files: hasFiles ? { length: 1 } : { length: 0 },
      items: hasFiles ? [{ kind: 'file' }] : [],
    };

    Object.defineProperty(event, 'dataTransfer', {
      value: mockDataTransfer,
      writable: false,
      configurable: true,
    });

    return event;
  }

  beforeEach(async () => {
    // Import component to register custom element
    await import('./session-view.js');
    await import('./terminal.js');
    await import('./session-view/terminal-renderer.js');

    // Ensure custom element is registered
    if (!customElements.get('session-view')) {
      console.error('session-view custom element not registered!');
    }
    vi.stubGlobal('XMLHttpRequest', FakeXHR);

    // Create mock file picker
    mockFilePicker = {
      uploadFile: vi.fn().mockResolvedValue(undefined),
    };

    // Set up the session view element
    const mockSession = createMockSession({
      id: 'test-session',
      status: 'running',
    });

    // Create element without session first
    element = await fixture<SessionView>(html`
      <session-view></session-view>
    `);

    // Wait for element to be fully initialized
    await element.updateComplete;

    // Now set the session
    element.session = mockSession;
    await element.updateComplete;
    // Wait for firstUpdated to be called
    await waitForAsync();

    // Give the component time to fully initialize all managers
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Mock the file picker element
    const originalQuerySelector = element.querySelector.bind(element);
    vi.spyOn(element, 'querySelector').mockImplementation((selector: string) => {
      if (selector === 'file-picker') {
        return mockFilePicker as unknown as Element;
      }
      // For the drag overlay tests, return the actual element
      // Note: session-view doesn't use shadow DOM
      return originalQuerySelector(selector) || null;
    });
  });

  /** Uploads run one at a time: after a failure, Retry re-sends the failed file and the rest. */
  async function expectRetryResumesFrom(failed: File, next: File, before: File[]) {
    const retry = await vi.waitFor(() => {
      const button = document.querySelector<HTMLButtonElement>(
        '.ut-upload-status button[data-action="retry"]'
      );
      expect(button).not.toBeNull();
      return button as HTMLButtonElement;
    });
    expect(vi.mocked(mockFilePicker.uploadFile).mock.calls.map((c) => c[0])).toEqual(before);

    retry.click();

    await vi.waitFor(() =>
      expect(vi.mocked(mockFilePicker.uploadFile).mock.calls.map((c) => c[0])).toEqual([
        ...before,
        failed,
        next,
      ])
    );
  }

  afterEach(() => {
    element.remove();
    document.querySelector('.ut-upload-status')?.remove();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    // Clear the logger mock to avoid test pollution
    mockLogger.log.mockClear();
    mockLogger.error.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.debug.mockClear();
  });

  describe('Drag Over', () => {
    it('should show drag overlay when files are dragged over', async () => {
      const dragEvent = createDragEvent('dragover', true);

      element.dispatchEvent(dragEvent);
      await element.updateComplete;

      // Access the manager using bracket notation for private property
      // biome-ignore lint/complexity/useLiteralKeys: accessing private property for testing
      // biome-ignore lint/suspicious/noExplicitAny: need to access private property
      const uiStateManager = (element as any)['uiStateManager'];
      expect(uiStateManager).toBeDefined();
      expect(uiStateManager.getState().isDragOver).toBe(true);
    });

    it('should not show drag overlay when non-files are dragged over', async () => {
      const dragEvent = createDragEvent('dragover', false);

      element.dispatchEvent(dragEvent);
      await element.updateComplete;

      // biome-ignore lint/complexity/useLiteralKeys: accessing private property for testing
      // biome-ignore lint/suspicious/noExplicitAny: need to access private property
      const uiStateManager = (element as any)['uiStateManager'];
      expect(uiStateManager.getState().isDragOver).toBe(false);
    });

    it('should prevent default behavior on dragover', () => {
      const dragEvent = createDragEvent('dragover');

      const preventDefaultSpy = vi.spyOn(dragEvent, 'preventDefault');
      const stopPropagationSpy = vi.spyOn(dragEvent, 'stopPropagation');

      element.dispatchEvent(dragEvent);

      expect(preventDefaultSpy).toHaveBeenCalled();
      expect(stopPropagationSpy).toHaveBeenCalled();
    });
  });

  describe('Drag Leave', () => {
    it('should hide drag overlay when dragging leaves the element', async () => {
      // First, trigger drag over to set isDragOver to true
      const dragOverEvent = createDragEvent('dragover', true);
      element.dispatchEvent(dragOverEvent);
      await element.updateComplete;
      // biome-ignore lint/complexity/useLiteralKeys: accessing private property for testing
      // biome-ignore lint/suspicious/noExplicitAny: need to access private property
      const uiStateManager = (element as any)['uiStateManager'];
      expect(uiStateManager.getState().isDragOver).toBe(true);

      // Test simplified behavior - drop event always sets isDragOver to false
      const dropEvent = new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
      });

      // Mock empty files
      Object.defineProperty(dropEvent, 'dataTransfer', {
        value: {
          files: [],
        },
        writable: false,
        configurable: true,
      });

      element.dispatchEvent(dropEvent);
      await element.updateComplete;

      // Drop always sets isDragOver to false
      // biome-ignore lint/complexity/useLiteralKeys: accessing private property for testing
      // biome-ignore lint/suspicious/noExplicitAny: need to access private property
      expect((element as any)['uiStateManager'].getState().isDragOver).toBe(false);
    });

    it('should hide drag overlay when drag operation is cancelled (dragend)', async () => {
      // First, trigger drag over to set isDragOver to true
      const dragOverEvent = createDragEvent('dragover', true);
      element.dispatchEvent(dragOverEvent);
      await element.updateComplete;
      // biome-ignore lint/complexity/useLiteralKeys: accessing private property for testing
      // biome-ignore lint/suspicious/noExplicitAny: need to access private property
      const uiStateManager = (element as any)['uiStateManager'];
      expect(uiStateManager.getState().isDragOver).toBe(true);

      // Simulate drag end event (e.g., user presses ESC or drags outside window)
      const dragEndEvent = new DragEvent('dragend', {
        bubbles: true,
        cancelable: true,
      });

      // Dispatch dragend on the document since that's where it's registered
      document.dispatchEvent(dragEndEvent);
      await element.updateComplete;

      // Dragend should clear the drag state
      // biome-ignore lint/complexity/useLiteralKeys: accessing private property for testing
      // biome-ignore lint/suspicious/noExplicitAny: need to access private property
      expect((element as any)['uiStateManager'].getState().isDragOver).toBe(false);
    });

    it('should keep drag overlay when dragging within the element', async () => {
      // First, trigger drag over to set isDragOver to true
      const dragOverEvent = createDragEvent('dragover', true);
      element.dispatchEvent(dragOverEvent);
      await element.updateComplete;
      // biome-ignore lint/complexity/useLiteralKeys: accessing private property for testing
      // biome-ignore lint/suspicious/noExplicitAny: need to access private property
      const uiStateManager = (element as any)['uiStateManager'];
      expect(uiStateManager.getState().isDragOver).toBe(true);

      // Create a drag leave event within bounds
      const dragLeaveEvent = new DragEvent('dragleave', {
        clientX: 50, // Inside the bounds
        clientY: 50,
        bubbles: true,
        cancelable: true,
      });

      // Mock getBoundingClientRect to return bounds that contain the mouse position
      const originalGetBoundingClientRect = element.getBoundingClientRect;
      element.getBoundingClientRect = () =>
        ({
          left: 0,
          right: 100,
          top: 0,
          bottom: 100,
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          toJSON: () => ({}),
        }) as DOMRect;

      // Mock the currentTarget for the event handler
      const proxyHandler = {
        get(target: DragEvent, prop: string | symbol): unknown {
          if (prop === 'currentTarget') {
            return element;
          }
          return Reflect.get(target, prop);
        },
      };

      const proxiedEvent = new Proxy(dragLeaveEvent, proxyHandler);

      // Dispatch the event instead of calling handler directly
      element.dispatchEvent(proxiedEvent);
      await element.updateComplete;

      // Restore original function
      element.getBoundingClientRect = originalGetBoundingClientRect;

      // biome-ignore lint/complexity/useLiteralKeys: accessing private property for testing
      // biome-ignore lint/suspicious/noExplicitAny: need to access private property
      expect((element as any)['uiStateManager'].getState().isDragOver).toBe(true);
    });
  });

  describe('Drop', () => {
    it('should handle single file drop', async () => {
      const file = new File(['test content'], 'test.txt', { type: 'text/plain' });

      const dropEvent = new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
      });

      // Mock dataTransfer with files
      Object.defineProperty(dropEvent, 'dataTransfer', {
        value: {
          files: [file],
        },
        writable: false,
        configurable: true,
      });

      const testElement = internals(element);
      testElement.uiStateManager.setIsDragOver(true);
      element.dispatchEvent(dropEvent);
      await element.updateComplete;
      expect(testElement.uiStateManager.getState().isDragOver).toBe(false);
      expect(mockFilePicker.uploadFile).toHaveBeenCalledWith(file);
    });

    it('should handle multiple file drops', async () => {
      const file1 = new File(['content1'], 'file1.txt', { type: 'text/plain' });
      const file2 = new File(['content2'], 'file2.txt', { type: 'text/plain' });

      const dropEvent = new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
      });

      // Mock dataTransfer with multiple files
      Object.defineProperty(dropEvent, 'dataTransfer', {
        value: {
          files: [file1, file2],
        },
        writable: false,
        configurable: true,
      });

      element.dispatchEvent(dropEvent);
      await element.updateComplete;

      // Wait for async operations
      await waitForAsync();

      expect(mockFilePicker.uploadFile).toHaveBeenCalledTimes(2);
      expect(mockFilePicker.uploadFile).toHaveBeenCalledWith(file1);
      expect(mockFilePicker.uploadFile).toHaveBeenCalledWith(file2);
    });

    it('should handle drop with no files gracefully', async () => {
      const dropEvent = new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
      });

      // Mock dataTransfer with no files
      Object.defineProperty(dropEvent, 'dataTransfer', {
        value: {
          files: [],
        },
        writable: false,
        configurable: true,
      });

      element.dispatchEvent(dropEvent);
      await element.updateComplete;

      expect(mockFilePicker.uploadFile).not.toHaveBeenCalled();
    });

    it('should stop at a failed file and let Retry upload the rest', async () => {
      const file1 = new File(['content1'], 'file1.txt', { type: 'text/plain' });
      const file2 = new File(['content2'], 'file2.txt', { type: 'text/plain' });
      const file3 = new File(['content3'], 'file3.txt', { type: 'text/plain' });

      // Make the second file fail
      mockFilePicker.uploadFile = vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('Upload failed'))
        .mockResolvedValueOnce(undefined);

      const dropEvent = new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
      });

      // Mock dataTransfer with multiple files
      Object.defineProperty(dropEvent, 'dataTransfer', {
        value: {
          files: [file1, file2, file3],
        },
        writable: false,
        configurable: true,
      });

      element.dispatchEvent(dropEvent);
      await element.updateComplete;

      // Wait for all promises to resolve
      await waitForAsync();

      await expectRetryResumesFrom(file2, file3, [file1, file2]);
    });

    it('should prevent default behavior on drop', () => {
      const dropEvent = new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
      });

      // Mock dataTransfer
      Object.defineProperty(dropEvent, 'dataTransfer', {
        value: {
          files: [],
        },
        writable: false,
        configurable: true,
      });

      const preventDefaultSpy = vi.spyOn(dropEvent, 'preventDefault');
      const stopPropagationSpy = vi.spyOn(dropEvent, 'stopPropagation');

      element.dispatchEvent(dropEvent);

      expect(preventDefaultSpy).toHaveBeenCalled();
      expect(stopPropagationSpy).toHaveBeenCalled();
    });
  });

  describe('Paste', () => {
    it('should handle paste of single file', async () => {
      const file = new File(['test content'], 'test.png', { type: 'image/png' });
      const clipboardData = {
        items: [
          {
            kind: 'file',
            type: 'image/png',
            getAsFile: () => file,
          },
        ],
        getData: () => '', // Return empty string for text data
      };

      const pasteEvent = new ClipboardEvent('paste', {
        clipboardData: clipboardData as unknown as DataTransfer,
        bubbles: true,
        cancelable: true,
      });

      // Dispatch on document since paste handler is on document
      document.dispatchEvent(pasteEvent);
      await element.updateComplete;

      // Images are first offered to the downscaler, which resolves asynchronously.
      await vi.waitFor(() => expect(mockFilePicker.uploadFile).toHaveBeenCalledWith(file));
    });

    it('should handle paste of multiple files', async () => {
      const file1 = new File(['content1'], 'image1.png', { type: 'image/png' });
      const file2 = new File(['content2'], 'image2.jpg', { type: 'image/jpeg' });

      const clipboardData = {
        items: [
          {
            kind: 'file',
            type: 'image/png',
            getAsFile: () => file1,
          },
          {
            kind: 'file',
            type: 'image/jpeg',
            getAsFile: () => file2,
          },
        ],
        getData: () => '', // Return empty string for text data
      };

      const pasteEvent = new ClipboardEvent('paste', {
        clipboardData: clipboardData as unknown as DataTransfer,
        bubbles: true,
        cancelable: true,
      });

      document.dispatchEvent(pasteEvent);
      await element.updateComplete;
      await waitForAsync();

      expect(mockFilePicker.uploadFile).toHaveBeenCalledTimes(2);
      expect(mockFilePicker.uploadFile).toHaveBeenCalledWith(file1);
      expect(mockFilePicker.uploadFile).toHaveBeenCalledWith(file2);
    });

    it('should not handle paste when file browser is open', async () => {
      // biome-ignore lint/complexity/useLiteralKeys: accessing private property for testing
      // biome-ignore lint/suspicious/noExplicitAny: need to access private property
      const uiStateManager = (element as any)['uiStateManager'];
      uiStateManager.setShowFileBrowser(true);
      await element.updateComplete;

      const file = new File(['test'], 'test.txt', { type: 'text/plain' });
      const clipboardData = {
        items: [
          {
            kind: 'file',
            getAsFile: () => file,
          },
        ],
        getData: () => '', // Return empty string for text data
      };

      const pasteEvent = new ClipboardEvent('paste', {
        clipboardData: clipboardData as unknown as DataTransfer,
        bubbles: true,
        cancelable: true,
      });

      document.dispatchEvent(pasteEvent);
      await element.updateComplete;

      expect(mockFilePicker.uploadFile).not.toHaveBeenCalled();
    });

    it('should not handle paste when image picker is open', async () => {
      // biome-ignore lint/complexity/useLiteralKeys: accessing private property for testing
      // biome-ignore lint/suspicious/noExplicitAny: need to access private property
      const uiStateManager = (element as any)['uiStateManager'];
      uiStateManager.setShowImagePicker(true);
      await element.updateComplete;

      const file = new File(['test'], 'test.txt', { type: 'text/plain' });
      const clipboardData = {
        items: [
          {
            kind: 'file',
            getAsFile: () => file,
          },
        ],
        getData: () => '', // Return empty string for text data
      };

      const pasteEvent = new ClipboardEvent('paste', {
        clipboardData: clipboardData as unknown as DataTransfer,
        bubbles: true,
        cancelable: true,
      });

      document.dispatchEvent(pasteEvent);
      await element.updateComplete;

      expect(mockFilePicker.uploadFile).not.toHaveBeenCalled();
    });

    it('should ignore paste events with no files', async () => {
      const clipboardData = {
        items: [
          {
            kind: 'string',
            type: 'text/plain',
          },
        ],
        getData: () => '', // Return empty string for text data
      };

      const pasteEvent = new ClipboardEvent('paste', {
        clipboardData: clipboardData as unknown as DataTransfer,
        bubbles: true,
        cancelable: true,
      });

      const preventDefaultSpy = vi.spyOn(pasteEvent, 'preventDefault');

      document.dispatchEvent(pasteEvent);
      await element.updateComplete;

      expect(mockFilePicker.uploadFile).not.toHaveBeenCalled();
      expect(preventDefaultSpy).not.toHaveBeenCalled();
    });

    it('should prevent default for file paste events', async () => {
      const file = new File(['test'], 'test.txt', { type: 'text/plain' });
      const clipboardData = {
        items: [
          {
            kind: 'file',
            getAsFile: () => file,
          },
        ],
        getData: () => '', // Return empty string for text data
      };

      const pasteEvent = new ClipboardEvent('paste', {
        clipboardData: clipboardData as unknown as DataTransfer,
        bubbles: true,
        cancelable: true,
      });

      const preventDefaultSpy = vi.spyOn(pasteEvent, 'preventDefault');

      document.dispatchEvent(pasteEvent);
      await element.updateComplete;

      expect(preventDefaultSpy).toHaveBeenCalled();
    });

    it('should stop at a failed pasted file and let Retry upload the rest', async () => {
      const file1 = new File(['content1'], 'file1.txt', { type: 'text/plain' });
      const file2 = new File(['content2'], 'file2.txt', { type: 'text/plain' });
      const file3 = new File(['content3'], 'file3.txt', { type: 'text/plain' });

      // Make the second file fail
      mockFilePicker.uploadFile = vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('Upload failed'))
        .mockResolvedValueOnce(undefined);

      const clipboardData = {
        items: [
          { kind: 'file', getAsFile: () => file1 },
          { kind: 'file', getAsFile: () => file2 },
          { kind: 'file', getAsFile: () => file3 },
        ],
        getData: () => '', // Return empty string for text data
      };

      const pasteEvent = new ClipboardEvent('paste', {
        clipboardData: clipboardData as unknown as DataTransfer,
        bubbles: true,
        cancelable: true,
      });

      document.dispatchEvent(pasteEvent);
      await element.updateComplete;

      await expectRetryResumesFrom(file2, file3, [file1, file2]);
    });
  });

  describe('Visual Overlay', () => {
    it('should toggle drag overlay state correctly', async () => {
      // Initial state
      // biome-ignore lint/complexity/useLiteralKeys: accessing private property for testing
      // biome-ignore lint/suspicious/noExplicitAny: need to access private property
      const uiStateManager = (element as any)['uiStateManager'];
      expect(uiStateManager.getState().isDragOver).toBe(false);

      // Drag over with files
      const dragOverEvent = createDragEvent('dragover', true);
      element.dispatchEvent(dragOverEvent);
      await element.updateComplete;
      expect(uiStateManager.getState().isDragOver).toBe(true);

      // Drag over without files keeps the current state (doesn't hide it)
      // The overlay is only hidden on drag leave or drop
      const dragOverNoFiles = createDragEvent('dragover', false);
      element.dispatchEvent(dragOverNoFiles);
      await element.updateComplete;
      expect(uiStateManager.getState().isDragOver).toBe(true);

      // Drop event should hide the overlay
      const dropEvent = new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(dropEvent, 'dataTransfer', {
        value: { files: [] },
        writable: false,
        configurable: true,
      });
      element.dispatchEvent(dropEvent);
      await element.updateComplete;
      expect(uiStateManager.getState().isDragOver).toBe(false);
    });
  });

  describe('Upload File', () => {
    function dropFiles(files: File[]) {
      const dropEvent = new DragEvent('drop', { bubbles: true, cancelable: true });
      Object.defineProperty(dropEvent, 'dataTransfer', {
        value: { files },
        writable: false,
        configurable: true,
      });
      element.dispatchEvent(dropEvent);
    }

    it('shows upload progress while the file is sent', async () => {
      let finish: () => void = () => {};
      mockFilePicker.uploadFile = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));

      dropFiles([new File(['test'], 'test.txt', { type: 'text/plain' })]);

      await vi.waitFor(() => expect(mockFilePicker.uploadFile).toHaveBeenCalled());
      const status = document.querySelector('.ut-upload-status');
      expect(status?.textContent).toContain('Uploading');
      expect(status?.querySelector('.ut-upload-status-bar')).not.toBeNull();

      finish();
      await vi.waitFor(() => expect(document.querySelector('.ut-upload-status')).toBeNull());
    });

    it('shows the error with a Retry button that uploads the file again', async () => {
      mockFilePicker.uploadFile = vi
        .fn()
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce(undefined);

      const file = new File(['test'], 'test.txt', { type: 'text/plain' });
      dropFiles([file]);

      const retry = await vi.waitFor(() => {
        const button = document.querySelector<HTMLButtonElement>(
          '.ut-upload-status button[data-action="retry"]'
        );
        expect(button).not.toBeNull();
        return button as HTMLButtonElement;
      });
      expect(document.querySelector('.ut-upload-status')?.textContent).toContain('Network error');

      retry.click();

      await vi.waitFor(() => expect(mockFilePicker.uploadFile).toHaveBeenCalledTimes(2));
      expect(mockFilePicker.uploadFile).toHaveBeenLastCalledWith(file);
      await vi.waitFor(() => expect(document.querySelector('.ut-upload-status')).toBeNull());
    });
  });
});
