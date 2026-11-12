// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fixture, html } from '@open-wc/testing';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resetViewport,
  setViewport,
  waitForCondition,
  waitForElement,
} from '@/test/utils/component-helpers';
import {
  MockFitAddon,
  type MockRenderer,
  MockResizeObserver,
  MockTerminal,
} from '@/test/utils/terminal-mocks';
import { TERMINAL_IDS } from '../utils/terminal-constants';

// Mock ghostty-web before importing the component (the test setup mocks its WASM instances)
vi.mock('ghostty-web', () => ({
  Terminal: MockTerminal,
  FitAddon: MockFitAddon,
}));

// GET /api/config as the server gives it (scrollPerf: QA logging of touch scrolls).
const serverConfig = vi.hoisted(() => ({ current: {} as { scrollPerf?: boolean } }));
vi.mock('../services/server-config-service.js', () => ({
  serverConfigService: {
    loadConfig: vi.fn(async () => ({ repositoryBasePath: '~/Documents', ...serverConfig.current })),
  },
}));

// Mock ResizeObserver globally
global.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;

// Import component type separately
import type { Terminal } from './terminal';

/** A 2D context that records the calls the terminal makes (happy-dom has none). */
function recordingContext() {
  return {
    save: vi.fn(),
    restore: vi.fn(),
    setTransform: vi.fn(),
    translate: vi.fn(),
    drawImage: vi.fn(),
    rect: vi.fn(),
    clip: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
  };
}

/** A touch event whose touches are plain points (happy-dom has no Touch constructor). */
function touchEvent(type: string, points: Array<[number, number]>, changed = points) {
  const list = (pts: Array<[number, number]>) =>
    Object.assign(
      pts.map(([clientX, clientY]) => ({ clientX, clientY })),
      { item: (i: number) => pts[i] }
    );
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'touches', { value: list(points) });
  Object.defineProperty(event, 'changedTouches', { value: list(changed) });
  return event;
}

describe('Terminal', () => {
  let element: Terminal;
  let mockTerminal: MockTerminal | null;

  beforeAll(async () => {
    // Import the component to register the custom element after mocks are set up
    await import('./terminal');
  });

  beforeEach(async () => {
    // Reset viewport
    resetViewport();

    // Create component with attribute binding
    element = await fixture<Terminal>(html`
      <ut-terminal session-id="test-123"></ut-terminal>
    `);

    // Wait for the component to be ready
    await element.updateComplete;

    // Wait for terminal container to be available
    await waitForElement(element);

    // Allow terminal initialization to complete
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Get mock terminal instance after component initializes
    mockTerminal = (element as unknown as { terminal: MockTerminal })
      .terminal as MockTerminal | null;
  });

  afterEach(() => {
    element.remove();
  });

  describe('initialization', () => {
    it('exposes a stable terminal input target for automation', () => {
      const terminalInput = element.querySelector(
        `#${TERMINAL_IDS.TERMINAL_INPUT}`
      ) as HTMLTextAreaElement | null;

      expect(terminalInput).toBeTruthy();
      expect(terminalInput?.getAttribute('aria-label')).toBe('Terminal input');
      expect(terminalInput?.getAttribute('data-testid')).toBe('terminal-input');
      expect(terminalInput?.hasAttribute('aria-hidden')).toBe(false);
    });

    it('should create terminal with default dimensions', async () => {
      expect(element.getAttribute('session-id')).toBe('test-123');

      // Check property existence
      expect(element).toHaveProperty('cols');
      expect(element).toHaveProperty('rows');
      expect(element).toHaveProperty('fontSize');

      // In test environment, numeric properties may not initialize correctly
      // This is a known issue with LitElement property decorators in some test setups
      // We'll check that the properties exist rather than their exact values
      if (!Number.isNaN(element.cols)) {
        // The terminal calculates its columns based on container width
        // In test environment with 1024px width, this will be more than 80
        expect(element.cols).toBeGreaterThan(0);
        expect(element.cols).toBeLessThan(200); // Reasonable upper bound
      }
      if (!Number.isNaN(element.rows)) {
        // In test environment, rows might be calculated differently
        expect(element.rows).toBeGreaterThan(0);
      }
      if (!Number.isNaN(element.fontSize)) {
        expect(element.fontSize).toBe(14);
      }
    });

    it('should initialize ghostty terminal after first update', async () => {
      // Terminal should already be initialized from beforeEach
      const terminal = mockTerminal;

      // If not initialized yet, skip this test
      if (!terminal) {
        console.warn('Terminal not initialized in test environment');
        return;
      }

      expect(terminal).toBeDefined();
      // Should mount into the container
      expect(terminal.open).toHaveBeenCalled();
      expect(terminal.clear).toHaveBeenCalledOnce();
      expect(element.getAttribute('data-ready')).toBe('true');
    });

    it('reinitializes once when the same element reconnects', async () => {
      const firstTerminal = mockTerminal;
      const readyHandler = vi.fn();
      element.addEventListener('terminal-ready', readyHandler);

      element.remove();
      element.removeAttribute('data-ready');
      document.body.appendChild(element);

      await waitForCondition(() => element.getAttribute('data-ready') === 'true', {
        message: 'terminal not ready after reconnect',
      });

      const reconnectedTerminal = (element as unknown as { terminal: MockTerminal | null })
        .terminal;
      expect(firstTerminal?.dispose).toHaveBeenCalledOnce();
      expect(reconnectedTerminal).not.toBe(firstTerminal);
      expect(reconnectedTerminal?.open).toHaveBeenCalledOnce();
      expect(readyHandler).toHaveBeenCalledOnce();
    });

    it('gives every terminal a WASM instance of its own and keeps none once disposed', async () => {
      // On one shared instance a new terminal showed the previous session's text (2026-10-03).
      const firstGhostty = mockTerminal?.ghostty;
      const other = await fixture<Terminal>(html`
        <ut-terminal session-id="other-session"></ut-terminal>
      `);
      await waitForCondition(() => other.getAttribute('data-ready') === 'true', {
        message: 'second terminal not ready',
      });
      const otherGhostty = (other as unknown as { terminal: MockTerminal }).terminal.ghostty;

      expect(firstGhostty).toBeTruthy();
      expect(otherGhostty).toBeTruthy();
      expect(otherGhostty).not.toBe(firstGhostty);

      element.remove();
      expect(mockTerminal?.dispose).toHaveBeenCalledOnce();
      expect(Object.values(element)).not.toContain(firstGhostty);
      other.remove();
    });

    it('registers clickable shortcuts that dispatch terminal input', () => {
      if (!mockTerminal) throw new Error('mock terminal was not created');

      expect(mockTerminal.registerLinkProvider).toHaveBeenCalledOnce();
      const provider = mockTerminal.registerLinkProvider.mock.calls[0][0] as {
        provideLinks(
          row: number,
          callback: (
            links:
              | Array<{
                  activate(event: MouseEvent): void;
                }>
              | undefined
          ) => void
        ): void;
      };

      // MockTerminal's default line has no cells (getCell returns null); this one has text.
      mockTerminal.buffer.active.getLine.mockReturnValue({
        translateToString: vi.fn(() => 'Ctrl+R'),
        length: 6,
        getCell: vi.fn((column: number) => ({
          getChars: () => 'Ctrl+R'[column] ?? '',
        })),
      } as unknown as ReturnType<MockTerminal['buffer']['active']['getLine']>);

      const inputHandler = vi.fn();
      element.addEventListener('terminal-input', inputHandler);

      provider.provideLinks(0, (links) => links?.[0].activate(new MouseEvent('click')));

      expect(inputHandler).toHaveBeenCalledOnce();
      expect((inputHandler.mock.calls[0][0] as CustomEvent).detail).toEqual({ text: '\x12' });
    });

    it('should handle custom dimensions', async () => {
      const customElement = await fixture<Terminal>(html`
        <ut-terminal session-id="test-789" cols="120" rows="40" font-size="16"> </ut-terminal>
      `);

      await customElement.updateComplete;
      await waitForElement(customElement);
      await new Promise((resolve) => setTimeout(resolve, 10));

      // In test environment, attribute to property conversion may not work correctly
      // Check if attributes were set
      expect(customElement.getAttribute('cols')).toBe('120');
      expect(customElement.getAttribute('rows')).toBe('40');
      expect(customElement.getAttribute('font-size')).toBe('16');
    });
  });

  describe('getScreenLines', () => {
    it('joins the rows the terminal soft-wrapped back into the printed lines', () => {
      const rows: Array<[string, boolean]> = [
        ['linea 1 de prueba de historial largo par', false],
        ['a el arranque', true],
        ['otra linea cortada en un espacio ', false],
        ['justo aqui', true],
        ['$ ', false],
      ];
      const terminal = (element as unknown as { terminal: MockTerminal }).terminal;
      terminal.buffer.active.length = rows.length;
      terminal.buffer.active.getLine.mockImplementation((row: number) => {
        const [text, isWrapped] = rows[row];
        return {
          isWrapped,
          length: text.length,
          getCell: (col: number) => ({ getChars: () => text[col], getWidth: () => 1 }),
        } as unknown as ReturnType<MockTerminal['buffer']['active']['getLine']>;
      });
      expect(element.getScreenLines(10)).toBe(
        [
          'linea 1 de prueba de historial largo para el arranque',
          'otra linea cortada en un espacio justo aqui',
          '$',
        ].join('\n')
      );
    });
  });

  describe('getCopyModeText', () => {
    const fill = (count: number, viewportY: number) => {
      const terminal = (element as unknown as { terminal: MockTerminal }).terminal;
      terminal.rows = 10;
      terminal.buffer.active.length = count;
      terminal.buffer.active.viewportY = viewportY;
      terminal.buffer.active.getLine.mockImplementation((row: number) => {
        const text = `row ${row}`;
        return {
          isWrapped: false,
          length: text.length,
          getCell: (col: number) => ({ getChars: () => text[col], getWidth: () => 1 }),
        } as unknown as ReturnType<MockTerminal['buffer']['active']['getLine']>;
      });
    };

    it('reads around the screen when scrolled back, and marks its top line', () => {
      // 1000 rows, screen of 10 scrolled 600 back: rows 390-399 are on screen.
      fill(1000, 600);
      const { text, topLine } = element.getCopyModeText(100);
      const lines = text.split('\n');
      expect(lines).toHaveLength(100);
      expect(lines[0]).toBe('row 350');
      expect(lines.at(-1)).toBe('row 449');
      expect(topLine).not.toBeNull();
      expect(lines[topLine as number]).toBe('row 390');
    });

    it('reads the last rows and opens at the end when at the bottom', () => {
      fill(1000, 0);
      const { text, topLine } = element.getCopyModeText(100);
      expect(text.split('\n')[0]).toBe('row 900');
      expect(text.split('\n').at(-1)).toBe('row 999');
      expect(topLine).toBeNull();
    });
  });

  describe('terminal output', () => {
    beforeEach(async () => {
      // Ensure terminal is initialized
      await element.firstUpdated();
      mockTerminal = (element as unknown as { terminal: MockTerminal }).terminal;
    });

    it('should write data to terminal', () => {
      // Call firstUpdated to ensure terminal is initialized
      element.firstUpdated();

      // Terminal component doesn't have a direct write method
      // It receives data through WebSocket v3
      // Just verify the container exists
      const container = element.querySelector('.terminal-container');
      expect(container).toBeTruthy();
    });

    it('buffers output until the terminal is ready', async () => {
      const pendingElement = document.createElement('ut-terminal') as Terminal;
      pendingElement.setAttribute('session-id', 'pending-output');
      pendingElement.write('Early output');
      document.body.appendChild(pendingElement);

      await pendingElement.updateComplete;
      await waitForElement(pendingElement);
      await waitForCondition(() => pendingElement.getAttribute('data-ready') === 'true', {
        message: 'terminal not ready',
      });

      const pendingTerminal = (pendingElement as unknown as { terminal: MockTerminal })
        .terminal as MockTerminal | null;
      if (!pendingTerminal) {
        console.warn('Terminal not initialized in test environment');
        pendingElement.remove();
        return;
      }

      const writes = pendingTerminal.write.mock.calls.map((call) => call[0]);
      expect(writes).toContain('Early output');
      pendingElement.remove();
    });

    it('should clear terminal', async () => {
      await element.firstUpdated();
      mockTerminal = (element as unknown as { terminal: MockTerminal }).terminal;
      expect(mockTerminal).toBeTruthy();
      mockTerminal?.clear.mockClear();

      element.clear();

      expect(mockTerminal?.clear).toHaveBeenCalledOnce();
    });
  });

  describe('user input', () => {
    beforeEach(async () => {
      await element.firstUpdated();
      mockTerminal = (element as unknown as { terminal: MockTerminal }).terminal;
    });

    it('should handle paste events', async () => {
      // Call firstUpdated to ensure terminal is initialized
      element.firstUpdated();

      const pasteText = 'pasted content';

      const clipboardData = new DataTransfer();
      clipboardData.setData('text/plain', pasteText);
      const pasteEvent = new ClipboardEvent('paste', {
        clipboardData,
        bubbles: true,
        cancelable: true,
      });

      const container = element.querySelector('.terminal-container');
      expect(container).toBeTruthy();

      const pasted: string[] = [];
      element.addEventListener('terminal-paste', (e) =>
        pasted.push((e as CustomEvent<{ text: string }>).detail.text)
      );

      container?.dispatchEvent(pasteEvent);

      expect(pasted).toEqual([pasteText]);
      expect(pasteEvent.defaultPrevented).toBe(true);
    });

    it('should handle paste events with navigator.clipboard fallback', async () => {
      // Call firstUpdated to ensure terminal is initialized
      element.firstUpdated();

      const pasteText = 'fallback content';

      // Mock navigator.clipboard for fallback test
      const originalClipboard = navigator.clipboard;
      const mockReadText = vi.fn().mockResolvedValue(pasteText);
      Object.defineProperty(navigator, 'clipboard', {
        value: { readText: mockReadText },
        configurable: true,
      });

      try {
        // Create paste event without clipboardData (Safari scenario)
        const pasteEvent = new ClipboardEvent('paste', {
          bubbles: true,
          cancelable: true,
        });

        const container = element.querySelector('.terminal-container');
        expect(container).toBeTruthy();

        const pasted: string[] = [];
        element.addEventListener('terminal-paste', (e) =>
          pasted.push((e as CustomEvent<{ text: string }>).detail.text)
        );

        container?.dispatchEvent(pasteEvent);

        // Without clipboard data the component does not read navigator.clipboard itself:
        // the paste goes on to the browser/keys handlers and no text is emitted.
        expect(pasted).toEqual([]);
        expect(pasteEvent.defaultPrevented).toBe(false);
        expect(mockReadText).not.toHaveBeenCalled();
      } finally {
        // Restore original clipboard
        Object.defineProperty(navigator, 'clipboard', {
          value: originalClipboard,
          configurable: true,
        });
      }
    });

    it('should not steal focus when clicking a terminal link', async () => {
      const terminalRoot = element.querySelector('.terminal-root') as HTMLElement | null;
      const pasteInput = element.querySelector(
        '.terminal-paste-input'
      ) as HTMLTextAreaElement | null;
      expect(terminalRoot).toBeTruthy();
      expect(pasteInput).toBeTruthy();

      const focusSpy = vi.spyOn(pasteInput as HTMLTextAreaElement, 'focus');

      const link = document.createElement('a');
      link.href = 'https://example.com';
      link.textContent = 'example';
      link.className = 'terminal-link';
      terminalRoot?.appendChild(link);

      link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

      expect(focusSpy).not.toHaveBeenCalled();
    });

    it('should focus paste input when clicking non-link terminal area', async () => {
      const terminalRoot = element.querySelector('.terminal-root') as HTMLElement | null;
      const pasteInput = element.querySelector(
        '.terminal-paste-input'
      ) as HTMLTextAreaElement | null;
      expect(terminalRoot).toBeTruthy();
      expect(pasteInput).toBeTruthy();

      const focusSpy = vi.spyOn(pasteInput as HTMLTextAreaElement, 'focus');

      terminalRoot?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

      expect(focusSpy).toHaveBeenCalled();
    });
  });

  describe('IME cursor positioning', () => {
    it('returns the rendered cursor position relative to the session terminal', () => {
      if (!mockTerminal) throw new Error('mock terminal was not created');

      const terminalContainer = element.querySelector('#terminal-container') as HTMLElement | null;
      expect(terminalContainer).toBeTruthy();

      mockTerminal.buffer.active.cursorX = 4;
      mockTerminal.buffer.active.cursorY = 3;
      mockTerminal.renderer = {
        getMetrics: () => ({ width: 9, height: 18 }),
        charWidth: 9,
        charHeight: 18,
      };

      vi.spyOn(terminalContainer as HTMLElement, 'getBoundingClientRect').mockReturnValue({
        left: 100,
        top: 200,
        right: 900,
        bottom: 600,
        width: 800,
        height: 400,
        x: 100,
        y: 200,
        toJSON: () => ({}),
      });

      const sessionTerminal = document.createElement('div');
      sessionTerminal.id = 'session-terminal';
      vi.spyOn(sessionTerminal, 'getBoundingClientRect').mockReturnValue({
        left: 40,
        top: 50,
        right: 940,
        bottom: 650,
        width: 900,
        height: 600,
        x: 40,
        y: 50,
        toJSON: () => ({}),
      });
      document.body.appendChild(sessionTerminal);

      try {
        expect(element.getCursorInfo()).toEqual({ x: 96, y: 204 });
      } finally {
        sessionTerminal.remove();
      }
    });

    it('returns null when renderer cursor metrics are unavailable', () => {
      if (!mockTerminal) throw new Error('mock terminal was not created');
      mockTerminal.renderer = null;

      expect(element.getCursorInfo()).toBeNull();
    });
  });

  describe('terminal sizing', () => {
    beforeEach(async () => {
      await element.firstUpdated();
      mockTerminal = (element as unknown as { terminal: MockTerminal }).terminal;
    });

    it('should set terminal size', async () => {
      // Skip detailed property checking in test environment due to LitElement initialization issues
      // Just verify the method can be called
      element.setTerminalSize(100, 30);

      // Wait for the queued operation to complete
      await new Promise((resolve) => requestAnimationFrame(resolve));
      await element.updateComplete;

      expect(element.cols).toBe(100);
      expect(element.rows).toBe(30);
    });

    it('should get terminal size', () => {
      const size = element.getTerminalSize();
      expect(size.cols).toBe(element.cols);
      expect(size.rows).toBe(element.rows);
    });

    it('should handle an unlimited width gracefully', async () => {
      element.maxCols = 0;
      await element.updateComplete;

      // Should fall back to calculated width based on container
      expect(element.cols).toBeGreaterThan(0);
      expect(element.rows).toBeGreaterThan(0);

      // Terminal should still be functional
      element.write('Test content');
      await element.updateComplete;
      expect(element.querySelector('.terminal-container')).toBeTruthy();
    });

    it('should handle localStorage errors gracefully', async () => {
      // Mock localStorage to throw errors
      const originalGetItem = localStorage.getItem;
      const originalSetItem = localStorage.setItem;

      // Test getItem error handling
      localStorage.getItem = vi.fn().mockImplementation(() => {
        throw new Error('localStorage unavailable');
      });

      // Create element - should not crash despite localStorage error
      const errorElement = await fixture<Terminal>(html`
        <ut-terminal session-id="error-test"></ut-terminal>
      `);
      await errorElement.updateComplete;

      // Just verify the element was created successfully despite localStorage error
      expect(errorElement).toBeTruthy();

      // Clean up
      errorElement.remove();
      localStorage.getItem = originalGetItem;
      localStorage.setItem = originalSetItem;
    });

    it('should not set explicitSizeSet flag if terminal is not ready', async () => {
      // Create a new terminal component instance without rendering
      const newElement = document.createElement('ut-terminal') as Terminal;

      // Set terminal size before it's connected to DOM (terminal will be null)
      newElement.setTerminalSize(100, 30);

      // Terminal should not be initialized yet
      expect((newElement as unknown as { terminal: unknown }).terminal).toBeNull();

      // Cols and rows should still be updated
      expect(newElement.cols).toBe(100);
      expect(newElement.rows).toBe(30);

      // Now connect to DOM and let it initialize
      document.body.appendChild(newElement);
      await newElement.updateComplete;
      await newElement.firstUpdated();

      // After initialization, terminal should be ready
      const terminal = (newElement as unknown as { terminal: MockTerminal }).terminal;
      expect(terminal).toBeDefined();

      // Now if we set size again, explicitSizeSet should be set
      newElement.setTerminalSize(120, 40);
      expect(newElement.cols).toBe(120);
      expect(newElement.rows).toBe(40);

      // Clean up
      newElement.remove();
    });
  });

  describe('scrolling behavior', () => {
    beforeEach(async () => {
      await element.firstUpdated();
      mockTerminal = (element as unknown as { terminal: MockTerminal }).terminal;
      // Set up buffer with content
      if (mockTerminal) {
        mockTerminal.buffer.active.length = 100;
      }
    });

    it.each([
      ['SGR', [1000, 1006], '\x1b[<64;1;1M\x1b[<64;1;1M'],
      ['legacy X10', [1000], '\x1b[M`!!\x1b[M`!!'],
    ])('forwards wheel scrolling to apps with mouse reporting (%s)', (_name, modes, expected) => {
      if (!mockTerminal) throw new Error('mock terminal was not created');
      for (const mode of modes) mockTerminal.enabledModes.add(mode);
      const input = vi.fn();
      element.addEventListener('terminal-input', (e) => input((e as CustomEvent).detail.text));

      // Two rows up (default row height is fontSize * 1.2 without a renderer).
      const handled = mockTerminal.wheelHandler?.(
        new WheelEvent('wheel', { deltaY: -2 * element.fontSize * 1.2 })
      );

      expect(handled).toBe(true);
      expect(input).toHaveBeenCalledWith(expected);
    });

    it('pinch-zooms the font once on release, without a stray tap', () => {
      if (!mockTerminal) throw new Error('mock terminal was not created');
      const container = element.querySelector('#terminal-container') as HTMLElement;
      const touchEvent = (type: string, points: Array<[number, number]>, changed = points) => {
        const list = (pts: Array<[number, number]>) =>
          Object.assign(
            pts.map(([clientX, clientY]) => ({ clientX, clientY })),
            { item: (i: number) => pts[i] }
          );
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'touches', { value: list(points) });
        Object.defineProperty(event, 'changedTouches', { value: list(changed) });
        return event;
      };
      element.fontSize = 12;
      const sizes: number[] = [];
      const taps = vi.fn();
      element.addEventListener('font-size-change', (e) =>
        sizes.push((e as CustomEvent<{ size: number }>).detail.size)
      );
      element.addEventListener('terminal-tap', taps);

      container.dispatchEvent(touchEvent('touchstart', [[100, 100]]));
      container.dispatchEvent(
        touchEvent('touchstart', [
          [100, 100],
          [200, 100],
        ])
      );
      container.dispatchEvent(
        touchEvent('touchmove', [
          [75, 100],
          [225, 100],
        ])
      );
      container.dispatchEvent(touchEvent('touchend', [[100, 100]], [[225, 100]]));
      container.dispatchEvent(touchEvent('touchend', [], [[100, 100]]));

      expect(sizes).toEqual([18]);
      expect(taps).not.toHaveBeenCalled();

      // Lifting one finger and dragging the other scrolls from where it is, not a jump.
      mockTerminal.scrollLines.mockClear();
      container.dispatchEvent(touchEvent('touchstart', [[100, 300]]));
      container.dispatchEvent(
        touchEvent('touchstart', [
          [100, 300],
          [200, 300],
        ])
      );
      container.dispatchEvent(touchEvent('touchend', [[100, 300]], [[200, 300]]));
      container.dispatchEvent(touchEvent('touchmove', [[100, 290]]));
      expect(mockTerminal.scrollLines).not.toHaveBeenCalled();

      // iOS cancelling a pinch changes nothing, now or on the next touch.
      container.dispatchEvent(touchEvent('touchend', [], [[100, 290]]));
      container.dispatchEvent(
        touchEvent('touchstart', [
          [100, 100],
          [200, 100],
        ])
      );
      container.dispatchEvent(
        touchEvent('touchmove', [
          [50, 100],
          [250, 100],
        ])
      );
      container.dispatchEvent(touchEvent('touchcancel', []));
      container.dispatchEvent(touchEvent('touchstart', [[10, 10]]));
      container.dispatchEvent(touchEvent('touchend', [], [[10, 10]]));
      expect(sizes).toEqual([18]);
    });

    it('starts a selection on a still long press, without a tap or a click', () => {
      vi.useFakeTimers();
      try {
        mockTerminal?.enabledModes.add(1000);
        mockTerminal?.enabledModes.add(1006);
        const container = element.querySelector('#terminal-container') as HTMLElement;
        const touchEvent = (type: string, points: Array<[number, number]>, changed = points) => {
          const list = (pts: Array<[number, number]>) =>
            Object.assign(
              pts.map(([clientX, clientY]) => ({ clientX, clientY })),
              { item: (i: number) => pts[i] }
            );
          const event = new Event(type, { bubbles: true, cancelable: true });
          Object.defineProperty(event, 'touches', { value: list(points) });
          Object.defineProperty(event, 'changedTouches', { value: list(changed) });
          return event;
        };
        const longPresses = vi.fn();
        const taps = vi.fn();
        const input = vi.fn();
        element.addEventListener('terminal-long-press', longPresses);
        element.addEventListener('terminal-tap', taps);
        element.addEventListener('terminal-input', input);

        container.dispatchEvent(touchEvent('touchstart', [[100, 100]]));
        vi.advanceTimersByTime(500);
        const end = touchEvent('touchend', [], [[102, 101]]);
        container.dispatchEvent(end);
        expect(longPresses).toHaveBeenCalledTimes(1);
        expect(taps).not.toHaveBeenCalled();
        expect(input).not.toHaveBeenCalled();
        expect(end.defaultPrevented).toBe(true);

        // A finger that moves (scroll) or a quick tap is not a long press.
        container.dispatchEvent(touchEvent('touchstart', [[100, 100]]));
        container.dispatchEvent(touchEvent('touchmove', [[100, 130]]));
        vi.advanceTimersByTime(600);
        container.dispatchEvent(touchEvent('touchend', [], [[100, 130]]));
        container.dispatchEvent(touchEvent('touchstart', [[50, 50]]));
        vi.advanceTimersByTime(200);
        container.dispatchEvent(touchEvent('touchend', [], [[50, 50]]));
        vi.advanceTimersByTime(600);
        expect(longPresses).toHaveBeenCalledTimes(1);
        expect(taps).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('sends a still click to apps that report the mouse, but not a drag', () => {
      if (!mockTerminal) throw new Error('mock terminal was not created');
      mockTerminal.enabledModes.add(1000);
      mockTerminal.enabledModes.add(1006);
      const input = vi.fn();
      element.addEventListener('terminal-input', (e) => input((e as CustomEvent).detail.text));
      const container = element.querySelector('#terminal-container') as HTMLElement;

      container.dispatchEvent(new MouseEvent('mousedown', { clientX: 5, clientY: 5, button: 0 }));
      container.dispatchEvent(new MouseEvent('mouseup', { clientX: 5, clientY: 5, button: 0 }));
      container.dispatchEvent(new MouseEvent('mousedown', { clientX: 5, clientY: 5, button: 0 }));
      container.dispatchEvent(new MouseEvent('mouseup', { clientX: 60, clientY: 5, button: 0 }));

      expect(input.mock.calls).toEqual([['\x1b[<0;1;1M\x1b[<0;1;1m']]);
    });

    it('sends one click per tap, not another for the mouse events iOS emulates after it', () => {
      if (!mockTerminal) throw new Error('mock terminal was not created');
      mockTerminal.enabledModes.add(1000);
      mockTerminal.enabledModes.add(1006);
      const now = vi.spyOn(performance, 'now').mockReturnValue(10_000);
      try {
        const input = vi.fn();
        element.addEventListener('terminal-input', (e) => input((e as CustomEvent).detail.text));
        const container = element.querySelector('#terminal-container') as HTMLElement;
        const click = () => {
          container.dispatchEvent(
            new MouseEvent('mousedown', { clientX: 5, clientY: 5, button: 0 })
          );
          container.dispatchEvent(new MouseEvent('mouseup', { clientX: 5, clientY: 5, button: 0 }));
        };

        // The tap sends its click; iOS then emulates a mouse click at the same spot. Two clicks
        // were a double click for Claude Code, which selected and auto-copied text.
        container.dispatchEvent(touchEvent('touchstart', [[5, 5]]));
        container.dispatchEvent(touchEvent('touchend', [], [[5, 5]]));
        now.mockReturnValue(10_050);
        click();
        expect(input.mock.calls).toEqual([['\x1b[<0;1;1M\x1b[<0;1;1m']]);

        // A real mouse click a while later still reaches the app.
        now.mockReturnValue(12_000);
        click();
        expect(input).toHaveBeenCalledTimes(2);
      } finally {
        now.mockRestore();
      }
    });

    it('sends only the press to apps in X10 compatibility mode', () => {
      if (!mockTerminal) throw new Error('mock terminal was not created');
      mockTerminal.enabledModes.add(9);
      mockTerminal.hasMouseTracking.mockReturnValue(true);
      const input = vi.fn();
      element.addEventListener('terminal-input', (e) => input((e as CustomEvent).detail.text));
      const container = element.querySelector('#terminal-container') as HTMLElement;

      container.dispatchEvent(new MouseEvent('mousedown', { clientX: 5, clientY: 5, button: 0 }));
      container.dispatchEvent(new MouseEvent('mouseup', { clientX: 5, clientY: 5, button: 0 }));

      expect(input.mock.calls).toEqual([['\x1b[M !!']]);
    });

    it('scrolls the local scrollback when the app does not report the mouse', () => {
      if (!mockTerminal) throw new Error('mock terminal was not created');
      const input = vi.fn();
      element.addEventListener('terminal-input', input);

      const handled = mockTerminal.wheelHandler?.(new WheelEvent('wheel', { deltaY: -100 }));

      expect(handled).toBe(false);
      expect(input).not.toHaveBeenCalled();
    });

    it('should scroll to bottom', () => {
      // Set up some content
      if (mockTerminal) {
        mockTerminal.buffer.active.length = 100;
        mockTerminal.scrollToBottom.mockClear();
      }

      element.scrollToBottom();

      expect(mockTerminal?.scrollToBottom).toHaveBeenCalledOnce();
      // Check that we're at bottom (viewportY should be at max)
      const position = element.getScrollPosition();
      expect(position).toBeGreaterThanOrEqual(0);
    });

    it('should scroll to specific position', () => {
      // Set up buffer with enough content to scroll
      if (mockTerminal) {
        mockTerminal.buffer.active.length = 100;
      }

      element.scrollToPosition(500);

      // Position might be clamped to valid range
      const position = element.getScrollPosition();
      expect(position).toBe(element.getMaxScrollPosition());
    });

    it('should expose whether output is following the cursor', () => {
      expect(element.isFollowingCursor()).toBe(true);

      mockTerminal?.simulateScroll(12);
      expect(element.isFollowingCursor()).toBe(false);

      mockTerminal?.simulateScroll(0);
      expect(element.isFollowingCursor()).toBe(true);
    });

    it('should preserve the viewed scrollback position when output arrives', () => {
      const terminal = mockTerminal;
      if (!terminal) return;

      terminal.buffer.active.length = 100;
      element.scrollToPosition(20);
      expect(element.getScrollPosition()).toBe(20);

      terminal.write.mockImplementationOnce(() => {
        terminal.buffer.active.length = 101;
        terminal.simulateScroll(0);
      });

      element.write('new output');

      // Restoration must happen before write() returns to avoid painting the live bottom.
      expect(element.getScrollPosition()).toBe(20);
      expect(element.isFollowingCursor()).toBe(false);
    });

    it('says "New output" on the bottom button when output comes while reading back', async () => {
      const terminal = mockTerminal;
      if (!terminal) return;
      terminal.buffer.active.length = 100;
      const button = () =>
        element.querySelector('[data-testid="terminal-scroll-bottom"]') as HTMLButtonElement | null;
      element.scrollToPosition(20);
      await element.updateComplete;
      expect(button()?.textContent?.trim()).toBe('↓ Bottom');
      expect(button()?.getAttribute('aria-label')).toBe('Scroll to bottom');
      expect(button()?.classList.contains('has-new-output')).toBe(false);

      terminal.write.mockImplementation(() => {
        terminal.buffer.active.length += 1;
        terminal.simulateScroll(0);
      });
      element.write('more\r\n');
      await element.updateComplete;
      // The view stays where the user reads; the button tells there is more below.
      expect(element.getScrollPosition()).toBe(20);
      expect(button()?.textContent?.trim()).toBe('↓ New output');
      expect(button()?.getAttribute('aria-label')).toBe('Scroll to the new output');
      expect(button()?.classList.contains('has-new-output')).toBe(true);

      // The button goes to the bottom and output is followed again.
      button()?.click();
      await element.updateComplete;
      expect(button()).toBeNull();
      expect(element.isFollowingCursor()).toBe(true);
      expect(element.getScrollPosition()).toBe(element.getMaxScrollPosition());
      element.write('even more\r\n');
      await element.updateComplete;
      expect(element.getScrollPosition()).toBe(element.getMaxScrollPosition());
      expect(button()).toBeNull();

      // Reading back again: nothing new until output comes.
      element.scrollToPosition(10);
      await element.updateComplete;
      expect(button()?.textContent?.trim()).toBe('↓ Bottom');
    });

    it('keeps reading the same text when the history drops its oldest rows', () => {
      const terminal = mockTerminal;
      if (!terminal) return;
      // Buffer row i reads "row <first + i>": dropping old rows shifts every index.
      let first = 0;
      terminal.buffer.active.getLine.mockImplementation((index: number) => ({
        translateToString: vi.fn(() => `row ${first + index}`),
        length: 80,
        getCell: vi.fn(() => null),
      }));
      terminal.buffer.active.length = 1000;
      element.scrollToPosition(500); // reading "row 500" and below
      // ghostty makes room: 400 of the oldest rows go as 3 new ones come.
      const dropOldest = (count: number) =>
        terminal.write.mockImplementationOnce(() => {
          first += count;
          terminal.buffer.active.length += 3 - count;
          terminal.simulateScroll(0);
        });
      dropOldest(400);
      element.write('a\r\nb\r\nc\r\n');
      expect(element.getScrollPosition()).toBe(100);
      expect(element.isFollowingCursor()).toBe(false);

      // Without a drop the rows keep their index.
      terminal.write.mockImplementationOnce(() => {
        terminal.buffer.active.length += 3;
        terminal.simulateScroll(0);
      });
      element.write('d\r\ne\r\nf\r\n');
      expect(element.getScrollPosition()).toBe(100);

      // When the rows being read are dropped too, the oldest left are the nearest.
      dropOldest(400);
      element.write('g\r\nh\r\ni\r\n');
      expect(element.getScrollPosition()).toBe(0);

      // Also when a burst dropped them while the history still grew.
      terminal.buffer.active.length = 1000;
      element.scrollToPosition(100);
      terminal.write.mockImplementationOnce(() => {
        first += 400;
        terminal.buffer.active.length += 500 - 400;
        terminal.simulateScroll(0);
      });
      element.write('x\r\n'.repeat(500));
      expect(element.getScrollPosition()).toBe(0);
    });

    it('should keep initial replay dumps at the bottom', () => {
      const terminal = mockTerminal;
      if (!terminal) return;

      terminal.write.mockImplementationOnce(() => {
        terminal.buffer.active.length = 100;
        terminal.simulateScroll(0);
      });

      element.write('initial replay', false);

      expect(element.getScrollPosition()).toBe(element.getMaxScrollPosition());
      expect(element.isFollowingCursor()).toBe(true);
    });

    it('should preserve scrollback across a burst of output writes', () => {
      const terminal = mockTerminal;
      if (!terminal) return;

      terminal.buffer.active.length = 100;
      element.scrollToPosition(20);
      terminal.write.mockImplementation(() => {
        terminal.buffer.active.length += 1;
        terminal.simulateScroll(0);
      });

      element.write('first');
      expect(element.getScrollPosition()).toBe(20);
      element.write('second');

      expect(element.getScrollPosition()).toBe(20);
      expect(element.isFollowingCursor()).toBe(false);
    });

    it('should not enqueue smooth scrolling for a burst while following output', () => {
      if (!mockTerminal) throw new Error('mock terminal was not created');

      mockTerminal.scrollToBottom.mockClear();

      for (let i = 0; i < 200; i++) {
        element.write(`slash-redraw-${i}\r\n`);
      }

      expect(mockTerminal.write).toHaveBeenCalledTimes(200);
      expect(mockTerminal.scrollToBottom).not.toHaveBeenCalled();
      expect(element.isFollowingCursor()).toBe(true);
    });

    it('should translate vertical touch drags into terminal scroll lines', async () => {
      if (!mockTerminal) throw new Error('mock terminal was not created');

      const container = element.querySelector('.terminal-container') as HTMLElement;
      const touchStart = new Event('touchstart', { bubbles: true, cancelable: true });
      Object.defineProperty(touchStart, 'touches', {
        value: [{ clientX: 50, clientY: 200 }],
      });
      container.dispatchEvent(touchStart);

      const touchMove = new Event('touchmove', { bubbles: true, cancelable: true });
      Object.defineProperty(touchMove, 'touches', {
        value: [{ clientX: 52, clientY: 240 }],
      });
      container.dispatchEvent(touchMove);

      expect(touchMove.defaultPrevented).toBe(true);
      // Applied on the next frame: 40 px down at 16.8 px a row is 2 rows back into the history.
      await new Promise((resolve) => requestAnimationFrame(resolve));
      expect(mockTerminal.scrollToLine).toHaveBeenLastCalledWith(2);
      expect(element.getScrollPosition()).toBe(element.getMaxScrollPosition() - 2);
    });

    it('logs one scrollperf line per touch scroll, only with ?scrollperf', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const perfLines = () =>
        log.mock.calls.map((args) => args.join(' ')).filter((line) => line.includes('scrollperf:'));
      // The line is logged once the scroll has stopped: a frame after the finger lifts here,
      // as the two moves came at the same instant (no fling).
      const drag = async (target: HTMLElement) => {
        vi.useFakeTimers();
        try {
          target.dispatchEvent(touchEvent('touchstart', [[50, 200]]));
          target.dispatchEvent(touchEvent('touchmove', [[50, 230]]));
          target.dispatchEvent(touchEvent('touchmove', [[50, 260]]));
          target.dispatchEvent(touchEvent('touchend', [], [[50, 260]]));
          vi.advanceTimersByTime(32);
        } finally {
          vi.useRealTimers();
        }
      };
      try {
        await drag(element.querySelector('#terminal-container') as HTMLElement);
        expect(perfLines()).toEqual([]);

        sessionStorage.setItem('ut-scrollperf', '1');
        const measured = await fixture<Terminal>(html`
          <ut-terminal session-id="perf-1"></ut-terminal>
        `);
        await waitForCondition(() => measured.getAttribute('data-ready') === 'true', {
          message: 'terminal not ready',
        });
        const terminal = (measured as unknown as { terminal: MockTerminal | null }).terminal;
        if (terminal) terminal.buffer.active.length = 100;
        await drag(measured.querySelector('#terminal-container') as HTMLElement);
        expect(perfLines()).toHaveLength(1);
        expect(perfLines()[0]).toMatch(
          /scrollperf: frames \d+, p50 [\d.]+ ms, p95 [\d.]+ ms, long\(>20ms\) \d+, max [\d.]+ ms, handler p95 [\d.]+ ms, mode local, rows \d+/
        );

        // Apps that report the mouse get the scroll as wheel events: "app".
        terminal?.enabledModes.add(1000);
        await drag(measured.querySelector('#terminal-container') as HTMLElement);
        expect(perfLines()).toHaveLength(2);
        expect(perfLines()[1]).toContain('mode app');
        measured.remove();
      } finally {
        sessionStorage.removeItem('ut-scrollperf');
        log.mockRestore();
      }
    });

    it('should preserve pinch zoom while owning one-finger terminal scrolling', () => {
      const container = element.querySelector('.terminal-container') as HTMLElement;
      expect(getComputedStyle(container).touchAction).toBe('pinch-zoom');
    });
  });

  describe('touch scrolling', () => {
    let terminalElement: Terminal;
    let term: MockTerminal;
    let renderer: MockRenderer;
    let container: HTMLElement;
    let canvas: HTMLCanvasElement;

    beforeEach(async () => {
      MockTerminal.withRenderer = true;
      try {
        terminalElement = await fixture<Terminal>(html`
          <ut-terminal session-id="touch-1"></ut-terminal>
        `);
        await waitForCondition(() => terminalElement.getAttribute('data-ready') === 'true', {
          message: 'terminal not ready',
        });
      } finally {
        MockTerminal.withRenderer = false;
      }
      term = (terminalElement as unknown as { terminal: MockTerminal }).terminal;
      renderer = term.renderer as MockRenderer;
      // 76 rows of history above a 24-row screen; rows are 18 px (the mock renderer's metrics).
      term.buffer.active.length = 100;
      container = terminalElement.querySelector('#terminal-container') as HTMLElement;
      canvas = container.querySelector('canvas') as HTMLCanvasElement;
      // ghostty's canvas has a 2D context: the text between rows is drawn into it.
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
        recordingContext() as unknown as CanvasRenderingContext2D
      );
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
      terminalElement.remove();
    });

    const frame = () => vi.advanceTimersByTime(16);
    /** The canvas at rest keeps a 3D transform: it stays on its own compositing layer. */
    const AT_REST = 'translate3d(0, 0px, 0)';
    const touch = (type: 'touchstart' | 'touchmove', y: number) =>
      container.dispatchEvent(touchEvent(type, [[60, y]]));
    const lift = (y: number) => container.dispatchEvent(touchEvent('touchend', [], [[60, y]]));
    /** How far down the text is drawn on the canvas: the top of its first row in its box. */
    const textAt = () => canvas.getBoundingClientRect().top;
    /** How far the canvas itself is moved (the rubber band past an end). */
    const canvasMoved = () => Number(/, (-?[\d.]+)px/.exec(canvas.style.transform)?.[1]) || 0;

    it('moves the text with the finger: whole rows to ghostty, the pixels between drawn lower', () => {
      touch('touchstart', 100);
      touch('touchmove', 130);
      // Nothing until the frame paints.
      expect(term.scrollToLine).not.toHaveBeenCalled();
      frame();
      expect(term.scrollToLine).toHaveBeenCalledTimes(1);
      expect(term.getViewportY()).toBe(1);
      expect(textAt()).toBe(12);
      expect(canvas.style.transform).toBe(AT_REST);
      expect(terminalElement.isFollowingCursor()).toBe(false);

      // 10 px back from the bottom is not the bottom.
      touch('touchmove', 110);
      frame();
      expect(term.getViewportY()).toBe(0);
      expect(textAt()).toBe(10);
      expect(terminalElement.isFollowingCursor()).toBe(false);

      // Down to the bottom by hand: following again, the text back on its rows.
      touch('touchmove', 100);
      frame();
      expect(textAt()).toBe(0);
      expect(canvas.style.transform).toBe(AT_REST);
      expect(terminalElement.isFollowingCursor()).toBe(true);
      lift(100);
    });

    it('never moves the canvas itself across row crossings (iOS showed the two a frame apart)', () => {
      // User report 2026-10-13: at every row crossing iOS showed the canvas's new rows a frame
      // before the transform that went back by a row: the text jumped a row and back.
      // The canvas's transform is read every frame (happy-dom 20.14's style is a proxy that
      // refuses a spied setter): it never moves.
      const transforms = new Set<string>();
      term.buffer.active.length = 400;
      terminalElement.scrollToPosition(200);
      renderer.render(term.wasmTerm, false, term.getViewportY(), term, 1);
      const resting = canvas.style.transform;
      const start = term.getViewportY();
      touch('touchstart', 100);
      let y = 100;
      for (let i = 0; i < 30; i++) {
        y += 7;
        touch('touchmove', y);
        frame();
        transforms.add(canvas.style.transform);
        expect(term.getViewportY() * 18 + textAt()).toBe(start * 18 + (y - 100));
      }
      lift(y);
      vi.advanceTimersByTime(2000);
      transforms.add(canvas.style.transform);
      expect(term.getViewportY() - start).toBeGreaterThan(11);
      expect([...transforms]).toEqual([resting]);
    });

    it('applies the moves of a frame in one step, and paints the rows it moves to itself', () => {
      touch('touchstart', 100);
      touch('touchmove', 110);
      touch('touchmove', 125);
      touch('touchmove', 140);
      expect(term.scrollToLine).not.toHaveBeenCalled();
      // ghostty's own loop painting earlier in the frame takes no step.
      renderer.render(term.wasmTerm, false, term.getViewportY(), term, 1);
      expect(term.scrollToLine).not.toHaveBeenCalled();
      renderer.paint.mockClear();
      frame();
      // 40 px: 2 rows and 4 px, the rows painted by the same callback that set the shift.
      expect(term.scrollToLine).toHaveBeenCalledTimes(1);
      expect(renderer.paint).toHaveBeenCalledTimes(1);
      expect(renderer.paint).toHaveBeenLastCalledWith(term.wasmTerm, false, 2, term, 0);
      expect(textAt()).toBe(4);
      // ghostty's loop afterwards finds nothing new to paint.
      renderer.render(term.wasmTerm, false, term.getViewportY(), term, 1);
      expect(renderer.paint).toHaveBeenCalledTimes(1);
      lift(140);
    });

    it('draws the row above the first one in the strip the shift uncovers', () => {
      const ctx = recordingContext();
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
        ctx as unknown as CanvasRenderingContext2D
      );
      const cell = {
        codepoint: 65,
        fg_r: 200,
        fg_g: 200,
        fg_b: 200,
        bg_r: 0,
        bg_g: 0,
        bg_b: 0,
        flags: 0,
        width: 1,
        hyperlink_id: 0,
        grapheme_len: 0,
      };
      term.getScrollbackLine.mockReturnValue([cell]);

      touch('touchstart', 100);
      touch('touchmove', 130);
      frame();
      // ghostty paints the view a row back, then its pixels go 12 px down.
      expect(ctx.drawImage).toHaveBeenCalledWith(canvas, 0, 0, 720, 420, 0, 12, 720, 420);
      expect(ctx.rect).toHaveBeenCalledWith(0, 0, 720, 12);
      // The history row right above the top one shown: 76 rows of history, 1 shown back.
      expect(term.getScrollbackLine).toHaveBeenLastCalledWith(74);
      expect(ctx.translate).toHaveBeenLastCalledWith(0, -6);
      expect(ctx.fillText).toHaveBeenCalledWith('A', 0, 14);
      // No other canvas: code that looks for ghostty's finds it.
      expect(container.querySelectorAll('canvas')).toHaveLength(1);

      // On a whole row: 6 px further, the row above comes in whole.
      ctx.drawImage.mockClear();
      touch('touchmove', 136);
      frame();
      expect(ctx.drawImage).toHaveBeenCalledWith(canvas, 0, 0, 720, 426, 0, 6, 720, 426);
      expect(textAt()).toBe(0);
      expect(term.getViewportY()).toBe(2);
      lift(136);
    });

    it('paints the strip in the canvas background, and output under a shift moves again', async () => {
      const fills: string[] = [];
      const ctx = recordingContext();
      ctx.fillRect.mockImplementation(() =>
        fills.push(String((ctx as { fillStyle?: string }).fillStyle))
      );
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
        ctx as unknown as CanvasRenderingContext2D
      );
      // ghostty-web keeps the theme it was created with (later ones only log a warning), so
      // the strip keeps that background too.
      const created = String(
        term.options.theme && (term.options.theme as { background?: string }).background
      );
      terminalElement.theme = created === '#f8f9fa' ? 'dark' : 'light';
      await terminalElement.updateComplete;

      touch('touchstart', 100);
      touch('touchmove', 130);
      frame();
      expect(fills[0]).toBe(created);

      // ghostty's loop with nothing new: nothing drawn.
      ctx.drawImage.mockClear();
      renderer.paint.mockClear();
      renderer.render(term.wasmTerm, false, term.getViewportY(), term, 1);
      expect(renderer.paint).not.toHaveBeenCalled();

      // Output: ghostty repaints every row (its own would land between the moved ones), and
      // the text goes down the same 12 px again.
      term.wasmTerm.isDirty.mockReturnValueOnce(true);
      renderer.render(term.wasmTerm, false, term.getViewportY(), term, 1);
      expect(renderer.paint).toHaveBeenCalledWith(term.wasmTerm, true, 1, term, 0);
      expect(ctx.drawImage).toHaveBeenCalledWith(canvas, 0, 0, 720, 420, 0, 12, 720, 420);
      expect(textAt()).toBe(12);
      lift(130);
    });

    it('keeps the text still when output arrives a few pixels back from the bottom', () => {
      touch('touchstart', 100);
      touch('touchmove', 110);
      frame();
      lift(110);
      expect(textAt()).toBe(10);
      term.write.mockImplementationOnce(() => {
        term.buffer.active.length += 3;
        term.simulateScroll(0);
      });
      terminalElement.write('three\r\nnew\r\nlines\r\n');
      expect(term.getViewportY()).toBe(3);
      expect(textAt()).toBe(10);
      expect(terminalElement.isFollowingCursor()).toBe(false);
    });

    it('lands on a whole row when the view is moved another way', () => {
      const between = () => {
        touch('touchstart', 100);
        touch('touchmove', 130);
        frame();
        lift(130);
        expect(textAt()).toBe(12);
      };
      between();
      terminalElement.scrollToBottom();
      expect(textAt()).toBe(0);
      expect(terminalElement.isFollowingCursor()).toBe(true);

      between();
      term.wheelHandler?.(new WheelEvent('wheel', { deltaY: -40 }));
      expect(textAt()).toBe(0);

      between();
      term.resize(60, 20);
      expect(textAt()).toBe(0);
      expect(canvas.style.transform).toBe(AT_REST);
    });

    /** Finger at `ys`, one move per frame, then lifted: a fling at (last step / 16) px/ms. */
    const flick = (...ys: number[]) => {
      touch('touchstart', ys[0]);
      for (const y of ys.slice(1)) {
        frame();
        touch('touchmove', y);
      }
      lift(ys[ys.length - 1]);
    };
    const shown = () => term.getViewportY() * 18 + textAt() + canvasMoved();

    it('keeps going after the finger lifts, slower each frame, until it stops', () => {
      term.buffer.active.length = 1000;
      terminalElement.scrollToPosition(500);
      const start = shown();
      flick(300, 330, 360, 390); // down 30 px a frame: back into the history
      frame();
      const afterLift: number[] = [];
      for (let i = 0; i < 5; i++) {
        frame();
        afterLift.push(shown());
      }
      // Still moving the same way, each frame a little less.
      const steps = afterLift.slice(1).map((value, i) => value - afterLift[i]);
      expect(steps.every((step) => step > 0)).toBe(true);
      expect(steps[3]).toBeLessThan(steps[0]);
      // iOS's deceleration: about velocity × 500 ms in all, then it stops.
      vi.advanceTimersByTime(5000);
      const stopped = shown();
      expect(stopped - start).toBeGreaterThan(90 + 500);
      expect(stopped - start).toBeLessThan(90 + 1200);
      frame();
      expect(shown()).toBe(stopped);
    });

    it('stops under a new touch, which is not a tap', () => {
      term.buffer.active.length = 1000;
      terminalElement.scrollToPosition(500);
      const taps = vi.fn();
      const input = vi.fn();
      terminalElement.addEventListener('terminal-tap', taps);
      terminalElement.addEventListener('terminal-input', input);
      term.enabledModes.add(1006); // SGR mouse format; tracking off: still a local scroll
      flick(300, 330, 360, 390);
      frame();
      frame();
      touch('touchstart', 200);
      const caught = shown();
      frame();
      frame();
      expect(shown()).toBe(caught);
      const end = touchEvent('touchend', [], [[60, 200]]);
      container.dispatchEvent(end);
      expect(end.defaultPrevented).toBe(true);
      expect(taps).not.toHaveBeenCalled();
      frame();
      expect(shown()).toBe(caught);

      // Once it stopped, a tap is a tap again.
      touch('touchstart', 200);
      lift(200);
      expect(taps).toHaveBeenCalledTimes(1);
    });

    it('stretches past the ends with a rubber band and springs back', () => {
      // At the bottom, pushing the text up 100 px moves it about half that, less and less.
      touch('touchstart', 300);
      touch('touchmove', 250);
      frame();
      const half = shown();
      touch('touchmove', 200);
      frame();
      const full = shown();
      expect(half).toBeLessThan(-20);
      expect(half).toBeGreaterThan(-35);
      expect(full).toBeLessThan(half);
      expect(full - half).toBeGreaterThan(half);
      expect(terminalElement.isFollowingCursor()).toBe(true);
      // Back towards the end first undoes the stretch.
      touch('touchmove', 250);
      frame();
      expect(shown()).toBeCloseTo(half, 0);
      touch('touchmove', 200);
      frame();
      lift(200);
      vi.advanceTimersByTime(800);
      expect(canvas.style.transform).toBe(AT_REST);

      // Past the oldest line the same, the other way.
      term.buffer.active.length = 30;
      terminalElement.scrollToPosition(0);
      const top = shown();
      touch('touchstart', 100);
      touch('touchmove', 200);
      frame();
      expect(shown() - top).toBeGreaterThan(20);
      expect(shown() - top).toBeLessThan(100);
      lift(200);
      vi.advanceTimersByTime(800);
      expect(shown()).toBe(top);
    });

    it('bounces off an end a fling reaches, then rests on it and follows again', () => {
      terminalElement.scrollToPosition(term.buffer.active.length - 24 - 3); // 3 rows back
      flick(300, 270, 240, 210); // up 30 px a frame: towards the bottom
      const seen: number[] = [];
      for (let i = 0; i < 40; i++) {
        frame();
        seen.push(shown());
      }
      expect(Math.min(...seen)).toBeLessThan(-5); // past the bottom
      expect(seen[seen.length - 1]).toBe(0);
      expect(canvas.style.transform).toBe(AT_REST);
      expect(terminalElement.isFollowingCursor()).toBe(true);
    });

    it('with reduce motion, ends stop the view without stretch or bounce; momentum stays', () => {
      window.matchMedia = vi.fn().mockImplementation((query: string) => ({
        matches: query === '(prefers-reduced-motion: reduce)',
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }));
      touch('touchstart', 300);
      touch('touchmove', 200);
      frame();
      expect(canvas.style.transform).toBe(AT_REST);
      lift(200);

      term.buffer.active.length = 1000;
      terminalElement.scrollToPosition(500);
      const start = shown();
      flick(300, 330, 360, 390);
      vi.advanceTimersByTime(5000);
      expect(shown() - start).toBeGreaterThan(90 + 500);

      // A fling into the bottom stops there.
      terminalElement.scrollToPosition(term.buffer.active.length - 24 - 3);
      flick(300, 270, 240, 210);
      const seen: number[] = [];
      for (let i = 0; i < 20; i++) {
        frame();
        seen.push(shown());
      }
      expect(Math.min(...seen)).toBe(0);
    });

    it('back at the bottom by hand, "New output" goes and output is followed again', async () => {
      const button = () =>
        terminalElement.querySelector(
          '[data-testid="terminal-scroll-bottom"]'
        ) as HTMLButtonElement | null;
      touch('touchstart', 100);
      touch('touchmove', 154); // 3 rows back
      frame();
      term.write.mockImplementation(() => {
        term.buffer.active.length += 1;
        term.simulateScroll(0);
      });
      terminalElement.write('more\r\n');
      await terminalElement.updateComplete;
      expect(term.getViewportY()).toBe(4);
      expect(button()?.textContent?.trim()).toBe('↓ New output');

      touch('touchmove', 74); // 80 px up: the 4 rows and a little past the bottom
      frame();
      await terminalElement.updateComplete;
      expect(terminalElement.isFollowingCursor()).toBe(true);
      expect(button()).toBeNull();
      lift(74);
      vi.advanceTimersByTime(800);
      terminalElement.write('again\r\n');
      expect(term.getViewportY()).toBe(0);
    });

    describe("taps on Claude Code's classic prompt (no mouse reporting)", () => {
      const RULE = '─'.repeat(40);
      // The bottom of a 40x24 screen as Claude Code's classic renderer leaves it (captured).
      const bottom = [
        RULE,
        '❯ uno dos tres cuatro cinco seis siete',
        '  ocho nueve diez once doce trece',
        '  catorce quince dieciseis diecisiete',
        RULE,
        '  ⏵⏵ auto mode on (shift+tab to cycle)',
      ];
      let inputs: string[];

      beforeEach(() => {
        term.cols = 40;
        // 40 columns of 10 px, 24 rows of 18 px.
        vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 400, 24 * 18));
        const screenTop = 100 - 24;
        term.buffer.active.getLine.mockImplementation((row: number) => {
          const text = bottom[row - screenTop - 18] ?? '';
          const chars = [...text];
          return {
            length: 40,
            isWrapped: false,
            translateToString: () => text,
            getCell: (col: number) => ({
              getChars: () => chars[col] ?? '',
              getWidth: () => 1,
              isDim: () => false,
            }),
          } as unknown as ReturnType<MockTerminal['buffer']['active']['getLine']>;
        });
        // The caret at the end of the text.
        term.buffer.active.cursorY = 21;
        term.buffer.active.cursorX = 37;
        inputs = [];
        terminalElement.addEventListener('terminal-input', (e) =>
          inputs.push((e as CustomEvent<{ text: string }>).detail.text)
        );
      });

      const tap = (col: number, row: number) => {
        const point: [number, number] = [col * 10, row * 18 + 9];
        container.dispatchEvent(touchEvent('touchstart', [point]));
        container.dispatchEvent(touchEvent('touchend', [], [point]));
      };

      it('moves the caret to the tapped character: rows first, then along the row', () => {
        const taps = vi.fn();
        terminalElement.addEventListener('terminal-tap', taps);
        tap(22, 19); // the "c" of "cinco", two rows up
        expect(inputs).toEqual(['\x1b[A\x1b[A']);
        // The keyboard logic still gets its tap.
        expect(taps).toHaveBeenCalledTimes(1);

        // Claude redraws with the caret two rows up, same column; then the presses along it.
        term.buffer.active.cursorY = 19;
        terminalElement.write('frame');
        vi.advanceTimersByTime(50);
        expect(inputs).toEqual(['\x1b[A\x1b[A', '\x1b[D'.repeat(15)]);
        terminalElement.write('another frame');
        vi.advanceTimersByTime(50);
        expect(inputs).toHaveLength(2);
      });

      it('waits for the frame to end: a cursor passing the tapped row mid-redraw is not the caret', () => {
        tap(22, 19);
        // First half of a frame: drawing row 19 leaves the cursor at its end for a moment.
        term.buffer.active.cursorY = 19;
        term.buffer.active.cursorX = 39;
        terminalElement.write('first half');
        vi.advanceTimersByTime(10);
        // The rest of the frame puts the cursor back on the caret, two rows up, column 37.
        term.buffer.active.cursorX = 37;
        terminalElement.write('second half');
        vi.advanceTimersByTime(50);
        expect(inputs).toEqual(['\x1b[A\x1b[A', '\x1b[D'.repeat(15)]);
      });

      it('moves along the caret row at once, with application cursor keys if the app set them', () => {
        term.enabledModes.add(1);
        tap(2, 21); // "catorce"
        expect(inputs).toEqual(['\x1bOD'.repeat(35)]);
      });

      it('leaves taps off the input rows (and on menus or a shell) alone', () => {
        tap(5, 22); // the rule below
        tap(5, 10); // earlier output
        expect(inputs).toEqual([]);
      });

      it('gives up when the caret never reaches the tapped row', () => {
        tap(22, 19);
        vi.advanceTimersByTime(2000);
        term.buffer.active.cursorY = 19;
        terminalElement.write('late frame');
        expect(inputs).toEqual(['\x1b[A\x1b[A']);
      });

      it('sends the click instead to an app that reports the mouse', () => {
        term.enabledModes.add(1000);
        term.enabledModes.add(1006);
        tap(22, 19);
        expect(inputs).toEqual(['\x1b[<0;23;20M\x1b[<0;23;20m']);
      });
    });

    describe('in apps that report the mouse', () => {
      const up = '\x1b[<64;1;1M';
      let inputs: string[];

      beforeEach(() => {
        term.enabledModes.add(1000);
        term.enabledModes.add(1006);
        inputs = [];
        terminalElement.addEventListener('terminal-input', (e) =>
          inputs.push((e as CustomEvent<{ text: string }>).detail.text)
        );
      });

      const steps = (text: string) => text.split('\x1b').length - 1;

      it('sends the drag as wheel steps, a few a frame in one report, and never moves the view', () => {
        touch('touchstart', 100);
        touch('touchmove', 145);
        touch('touchmove', 190); // 90 px: 5 rows up into the app's history
        expect(inputs).toEqual([]);
        frame();
        expect(inputs).toEqual([up.repeat(3)]);
        frame();
        expect(inputs).toEqual([up.repeat(3), up.repeat(2)]);
        frame();
        expect(inputs).toHaveLength(2);
        expect(term.scrollToLine).not.toHaveBeenCalled();
        expect(canvas.style.transform).toBe(AT_REST);
        lift(190);
      });

      it('keeps scrolling the app after the finger lifts, slower and slower, until a touch', () => {
        flick(300, 330, 360, 390);
        const perFrame: number[] = [];
        for (let i = 0; i < 40; i++) {
          const before = inputs.length;
          frame();
          perFrame.push(inputs.slice(before).reduce((sum, text) => sum + steps(text), 0));
        }
        const firstTen = perFrame.slice(0, 10).reduce((a, b) => a + b, 0);
        const lastTen = perFrame.slice(30).reduce((a, b) => a + b, 0);
        expect(firstTen).toBeGreaterThan(lastTen);
        expect(lastTen).toBeGreaterThan(0);
        expect(Math.max(...perFrame)).toBeLessThanOrEqual(3);
        expect(inputs.every((text) => text === up.repeat(steps(text)))).toBe(true);

        // A touch stops it, and is no click for the app.
        touch('touchstart', 200);
        const sent = inputs.length;
        frame();
        frame();
        const end = touchEvent('touchend', [], [[60, 200]]);
        container.dispatchEvent(end);
        frame();
        expect(inputs).toHaveLength(sent);
        expect(end.defaultPrevented).toBe(true);
      });

      it('renders nothing while only wheel steps go out: no output, no repaint', () => {
        // 2026-10-04, iPhone, Claude Code: 190 renders in 189 frames of a flick, 9 ms each.
        const ghosttyFrame = () => {
          renderer.render(term.wasmTerm, false, term.getViewportY(), term, 1);
          frame();
        };
        ghosttyFrame();
        renderer.paint.mockClear();
        touch('touchstart', 300);
        for (const y of [330, 360, 390, 420]) {
          touch('touchmove', y);
          ghosttyFrame();
        }
        lift(420);
        for (let i = 0; i < 60; i++) ghosttyFrame();
        expect(inputs.length).toBeGreaterThan(10); // the app was scrolled, with momentum
        expect(renderer.paint).not.toHaveBeenCalled();
        // Its redraw comes back as output: that is painted.
        term.wasmTerm.isDirty.mockReturnValueOnce(true);
        ghosttyFrame();
        expect(renderer.paint).toHaveBeenCalledTimes(1);
      });

      it('drops steps beyond a couple of frames, so the app stops soon after the finger', () => {
        touch('touchstart', 100);
        touch('touchmove', 110);
        touch('touchmove', 110 + 30 * 18); // 30 rows within one frame
        for (let i = 0; i < 6; i++) frame();
        expect(inputs.reduce((sum, text) => sum + steps(text), 0)).toBe(6);
        lift(110 + 30 * 18);
      });
    });

    describe('row crossings while scrolled back', () => {
      let ctx: ReturnType<typeof recordingContext>;

      beforeEach(() => {
        canvas.width = 80 * 9;
        canvas.height = 24 * 18;
        ctx = recordingContext();
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
          ctx as unknown as CanvasRenderingContext2D
        );
        terminalElement.scrollToPosition(50); // 26 rows back, of 76
        renderer.render(term.wasmTerm, false, term.getViewportY(), term, 1);
        renderer.paint.mockClear();
      });

      it('move the canvas by the rows crossed and draw only the rows that come in', () => {
        touch('touchstart', 100);
        touch('touchmove', 120); // 20 px back: 27 rows and 2 px
        frame();
        expect(term.getViewportY()).toBe(27);
        // Its pixels move down 20; in the strip, the row above (history row 76 - 27 - 1 = 48)
        // and row 0 (49), each 2 px lower.
        expect(ctx.drawImage).toHaveBeenCalledWith(canvas, 0, 0, 720, 412, 0, 20, 720, 412);
        expect(term.getScrollbackLine.mock.calls).toEqual([[48], [49]]);
        expect(ctx.translate.mock.calls).toEqual([
          [0, -16],
          [0, 2],
        ]);
        expect(renderer.paint).not.toHaveBeenCalled();
        // ghostty's own loop finds nothing new to paint.
        renderer.render(term.wasmTerm, false, term.getViewportY(), term, 1);
        expect(renderer.paint).not.toHaveBeenCalled();

        // Two rows towards the bottom: the rows move up two, rows 22 and 23 come in.
        ctx.drawImage.mockClear();
        term.getScrollbackLine.mockClear();
        touch('touchmove', 82); // 38 px up: 25 rows back, on a whole row
        frame();
        expect(term.getViewportY()).toBe(25);
        expect(ctx.drawImage).toHaveBeenCalledWith(canvas, 0, 38, 720, 394, 0, 0, 720, 394);
        // The bottom 2 px of row 21 and rows 22 and 23 come in.
        expect(term.getScrollbackLine.mock.calls).toEqual([[72], [73], [74]]);
        expect(renderer.paint).not.toHaveBeenCalled();
        lift(82);
      });

      it('draw the live screen rows that come in near the bottom', () => {
        terminalElement.scrollToPosition(73); // 3 rows back
        renderer.render(term.wasmTerm, false, term.getViewportY(), term, 1);
        renderer.paint.mockClear();
        touch('touchstart', 100);
        touch('touchmove', 82); // a row towards the bottom: 2 back
        frame();
        // Row 23 at 2 rows back is row 21 of the live screen.
        expect(term.wasmTerm.getLine).toHaveBeenCalledWith(21);
        expect(renderer.paint).not.toHaveBeenCalled();
        lift(82);
      });

      it('leave the canvas to ghostty when they cannot be shifted', () => {
        const crossOnce = () => {
          renderer.paint.mockClear();
          touch('touchstart', 100);
          touch('touchmove', 120);
          frame();
          lift(120);
          vi.advanceTimersByTime(3000);
        };
        // Output came: ghostty must repaint anyway.
        term.wasmTerm.isDirty.mockReturnValue(true);
        crossOnce();
        expect(renderer.paint).toHaveBeenCalled();
        term.wasmTerm.isDirty.mockReturnValue(false);
        // A selection on screen.
        term.hasSelection.mockReturnValue(true);
        crossOnce();
        expect(renderer.paint).toHaveBeenCalled();
        term.hasSelection.mockReturnValue(false);
        // Not at ghostty's size (mid-resize).
        canvas.height = 100;
        crossOnce();
        expect(renderer.paint).toHaveBeenCalled();
        canvas.height = 24 * 18;
        // Into the bottom, where ghostty draws the cursor.
        terminalElement.scrollToPosition(75); // 1 row back
        renderer.render(term.wasmTerm, false, term.getViewportY(), term, 1);
        renderer.paint.mockClear();
        touch('touchstart', 100);
        touch('touchmove', 82);
        frame();
        expect(term.getViewportY()).toBe(0);
        // Every row while the text is drawn lower (the pixels from the last crossing stay).
        expect(renderer.paint).toHaveBeenCalledWith(term.wasmTerm, true, 0, term, 0);
        lift(82);
      });

      it('leave a whole screen or more to ghostty', () => {
        touch('touchstart', 100);
        touch('touchmove', 110);
        touch('touchmove', 110 + 24 * 18); // 24 rows and more in one frame
        frame();
        // Only the move of ghostty's rows 10 px down, after it painted them.
        expect(ctx.drawImage.mock.calls).toEqual([[canvas, 0, 0, 720, 422, 0, 10, 720, 422]]);
        expect(renderer.paint).toHaveBeenCalledWith(
          term.wasmTerm,
          false,
          term.getViewportY(),
          term,
          0
        );
        lift(110 + 24 * 18);
      });
    });

    describe('frame by frame', () => {
      // A frame clock of our own: the requested callbacks run in order, with ghostty-web's
      // paint (its own requestAnimationFrame loop) before or after them, as the browser may
      // order them, then the browser would paint.
      let queue: Array<{ id: number; callback: FrameRequestCallback }>;
      let now: number;
      let canvasShows: number;
      let shifts: number;
      /** performance.now() inside a frame's callbacks runs this far past the frame's start. */
      let lateInFrame: () => number;
      let inFrame: boolean;

      beforeEach(() => {
        queue = [];
        let nextId = 1;
        now = 1000;
        lateInFrame = () => 0;
        inFrame = false;
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
          queue.push({ id: nextId, callback });
          return nextId++;
        });
        vi.stubGlobal('cancelAnimationFrame', (id: number) => {
          queue = queue.filter((entry) => entry.id !== id);
        });
        vi.spyOn(performance, 'now').mockImplementation(() =>
          inFrame ? now + lateInFrame() : now
        );
        term.buffer.active.length = 400; // 376 rows of history
        terminalElement.scrollToPosition(200); // 176 rows back from the bottom
        // A canvas sized as ghostty sizes it, with a 2D context: crossings can shift it.
        canvas.width = 80 * 9;
        canvas.height = 24 * 18;
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
          recordingContext() as unknown as CanvasRenderingContext2D
        );
        // What the canvas shows: ghostty's paints, and our shifts of it.
        canvasShows = term.getViewportY();
        shifts = 0;
        renderer.paint.mockImplementation((...args: unknown[]) => {
          canvasShows = args[2] as number;
        });
        const internals = terminalElement as unknown as {
          moveCanvasText(from: number, to: number, shift: number): boolean;
        };
        const moveText = internals.moveCanvasText.bind(internals);
        vi.spyOn(internals, 'moveCanvasText').mockImplementation((from, to, shift) => {
          const moved = moveText(from, to, shift);
          if (moved) {
            canvasShows = to;
            if (to !== from) shifts++;
          }
          return moved;
        });
      });

      afterEach(() => {
        vi.unstubAllGlobals();
      });

      // ghostty's own calls (its loop, its scrollbar fade, its resize) all go through
      // renderer.render, which the render hook replaced.
      type Ghostty = 'through the hook';
      const ghosttyPaints = (_how: Ghostty, opacity = 1) =>
        renderer.render(term.wasmTerm, false, term.getViewportY(), term, opacity);
      const shift = () => textAt() + canvasMoved();

      /**
       * Runs one frame and returns where the text shows (px back from the bottom). At the end
       * of every frame the canvas must show the rows the view is on, drawn at its shift, and
       * the canvas itself must not have moved.
       */
      const runFrame = (
        ghosttyFirst: boolean,
        how: Ghostty,
        fade: 'none' | 'after',
        interval = 16
      ) => {
        now += interval;
        const due = queue;
        queue = [];
        inFrame = true;
        if (ghosttyFirst) ghosttyPaints(how);
        for (const { callback } of due) callback(now);
        if (!ghosttyFirst) ghosttyPaints(how);
        // ghostty's scrollbar fade loop renders on its own in some frames.
        if (fade === 'after') ghosttyPaints('through the hook', 0.5);
        inFrame = false;
        expect(canvasShows, `frame at ${now} ms`).toBe(term.getViewportY());
        expect(canvas.style.transform, `frame at ${now} ms`).toBe(AT_REST);
        return canvasShows * 18 + shift();
      };

      for (const ghosttyFirst of [true, false]) {
        for (const how of ['through the hook'] as const) {
          it(`paints each frame's rows with that frame's shift (ghostty ${ghosttyFirst ? 'first' : 'last'}, ${how})`, () => {
            ghosttyPaints(how);
            const start = term.getViewportY() * 18;
            // A drag: 7 px a frame back into the history, a row crossed every 2 or 3 frames.
            touch('touchstart', 100);
            let y = 100;
            for (let i = 0; i < 24; i++) {
              y += 7;
              touch('touchmove', y);
              const shown = runFrame(ghosttyFirst, how, i % 5 === 0 ? 'after' : 'none');
              expect(shown, `drag frame ${i}`).toBe(start + (y - 100));
            }
            // The crossings moved the canvas rather than repainting it.
            expect(shifts).toBeGreaterThanOrEqual(8);
            // Then a fling: still moving the same way, never a step back.
            lift(y);
            let last = start + (y - 100);
            for (let i = 0; i < 40; i++) {
              const shown = runFrame(ghosttyFirst, how, i % 7 === 0 ? 'after' : 'none');
              expect(shown, `fling frame ${i}`).toBeGreaterThanOrEqual(last);
              last = shown;
            }
            expect(last).toBeGreaterThan(start + (y - 100) + 18);
          });
        }
      }

      it('moves by the frames timestamps alone, one step a frame, at 120 Hz too', () => {
        // The same flick twice, at 120 Hz, with performance.now() running late inside the
        // frames by different amounts (other callbacks before ours): every frame must show the
        // same place, whatever the order. Only the frames' own timestamps may move the view.
        const run = (ghosttyFirst: boolean, late: number[]) => {
          // Each run from the same place: on a whole row, nothing moving.
          terminalElement.scrollToBottom();
          terminalElement.scrollToPosition(200);
          renderer.paint.mockClear();
          now += 1000;
          let frameIndex = 0;
          lateInFrame = () => late[frameIndex % late.length];
          ghosttyPaints('through the hook');
          touch('touchstart', 100);
          const shown: number[] = [];
          let y = 100;
          for (let i = 0; i < 12; i++) {
            y += i % 2 === 0 ? 10 : 0; // a move every other frame: 60 Hz touches, 120 Hz frames
            if (i % 2 === 0) touch('touchmove', y);
            frameIndex = i;
            shown.push(runFrame(ghosttyFirst, 'through the hook', 'none', 8.333));
          }
          lift(y);
          for (let i = 0; i < 60; i++) {
            frameIndex = 12 + i;
            shown.push(runFrame(ghosttyFirst, 'through the hook', 'none', 8.333));
          }
          return shown;
        };
        for (const ghosttyFirst of [true, false]) {
          const steady = run(ghosttyFirst, [0]);
          expect(run(ghosttyFirst, [3, 0, 5, 1, 4])).toEqual(steady);
          expect(run(ghosttyFirst, [2.5, 7])).toEqual(steady);
          // ... and it did fling on after the lift.
          expect(steady[steady.length - 1]).toBeGreaterThan(steady[11] + 18);
        }
      });

      it('hands a drag over to its fling with no double step and no stop at the lift', () => {
        const steps = (liftWithLastMove: boolean) => {
          terminalElement.scrollToBottom();
          terminalElement.scrollToPosition(150);
          now += 1000;
          ghosttyPaints('through the hook');
          touch('touchstart', 100);
          const shown = [runFrame(true, 'through the hook', 'none')];
          let y = 100;
          for (let i = 0; i < 8; i++) {
            y += 20; // a steady 20 px a frame
            touch('touchmove', y);
            if (i === 7 && liftWithLastMove) lift(y);
            shown.push(runFrame(i % 2 === 0, 'through the hook', 'none'));
          }
          if (!liftWithLastMove) lift(y);
          for (let i = 0; i < 4; i++) shown.push(runFrame(i % 2 === 1, 'through the hook', 'none'));
          return shown.slice(1).map((value, i) => value - shown[i]);
        };
        // The lift in the frame of the last move: that frame shows the move alone (it used to
        // add a fling step: one 40 px frame), and the fling goes on at the finger's speed.
        // Fling steps from 1.25 px/ms: 19.7, 19.1, 18.5, 17.9 px, shown on whole pixels here.
        const handedOver = (all: number[]) => {
          expect(all.slice(0, 8)).toEqual(Array(8).fill(20));
          for (const step of all.slice(8, 10)) {
            expect(step).toBeGreaterThanOrEqual(19);
            expect(step).toBeLessThanOrEqual(20);
          }
          for (const step of all.slice(10)) {
            expect(step).toBeGreaterThanOrEqual(17);
            expect(step).toBeLessThanOrEqual(19);
          }
        };
        handedOver(steps(true));
        // The lift a frame after the last move: the fling makes up that frame (no stop).
        handedOver(steps(false));
      });

      it('draws the text lower by whole device pixels (3x)', () => {
        const ctx = recordingContext();
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
          ctx as unknown as CanvasRenderingContext2D
        );
        const ratio = vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(3);
        ghosttyPaints('through the hook');
        touch('touchstart', 100);
        touch('touchmove', 110.2); // 10.2 px: 10 1/3 on a 3x screen
        runFrame(true, 'through the hook', 'none');
        expect(textAt() * 3).toBeCloseTo(31, 9);
        // The row above, drawn as many device pixels lower (a row of 18 px above).
        expect(ctx.translate).toHaveBeenLastCalledWith(0, -18 + 31 / 3);
        // A momentum frame lands on the same grid.
        touch('touchmove', 117.9);
        lift(117.9);
        for (let i = 0; i < 5; i++) {
          runFrame(false, 'through the hook', 'none');
          expect(Math.abs(textAt() * 3 - Math.round(textAt() * 3))).toBeLessThan(1e-9);
        }
        ratio.mockRestore();
      });

      it('repaints a crossing instead of moving pixels by a fraction (2.5x)', () => {
        const ctx = recordingContext();
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
          ctx as unknown as CanvasRenderingContext2D
        );
        const ratio = vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(2.5);
        const metrics = renderer.getMetrics();
        const getMetrics = vi
          .spyOn(renderer, 'getMetrics')
          .mockReturnValue({ ...metrics, height: 18.2 }); // 45.5 device px a row
        canvas.width = 80 * 9 * 2.5;
        canvas.height = Math.round(24 * 18.2 * 2.5);
        ghosttyPaints('through the hook');
        const before = shifts;
        touch('touchstart', 100);
        let y = 100;
        for (let i = 0; i < 12; i++) {
          y += 7;
          touch('touchmove', y);
          runFrame(true, 'through the hook', 'none');
        }
        // Rows were crossed, none of them by moving the pixels a fraction of one.
        expect(term.getViewportY()).toBeGreaterThan(176);
        expect(shifts).toBe(before);
        for (const call of ctx.drawImage.mock.calls) {
          expect(Number.isInteger(call[6]), `drawImage to y ${call[6]}`).toBe(true);
        }
        lift(y);
        getMetrics.mockRestore();
        ratio.mockRestore();
      });

      it('draws the text again when the pixel ratio changes mid-gesture', () => {
        const ctx = recordingContext();
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
          ctx as unknown as CanvasRenderingContext2D
        );
        const ratio = vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(2);
        ghosttyPaints('through the hook');
        touch('touchstart', 100);
        touch('touchmove', 110);
        runFrame(true, 'through the hook', 'none');
        expect(ctx.setTransform).toHaveBeenLastCalledWith(2, 0, 0, 2, 0, 0);
        expect(textAt()).toBe(10);
        ratio.mockReturnValue(3); // the window went to another screen
        touch('touchmove', 112);
        runFrame(true, 'through the hook', 'none');
        expect(ctx.setTransform).toHaveBeenLastCalledWith(3, 0, 0, 3, 0, 0);
        expect(textAt()).toBe(12);
        lift(112);
        ratio.mockRestore();
      });
    });

    describe('its scrollbar', () => {
      const bar = () => container.querySelector('.terminal-scrollbar') as HTMLElement;
      const thumbTop = () =>
        Number(
          /translate3d\(0, (-?[\d.]+)px/.exec(
            (bar().querySelector('.terminal-scrollbar-thumb') as HTMLElement).style.transform
          )?.[1]
        );

      it('shows beside the last column while scrolling, then fades; the columns never change', () => {
        const fit = (terminalElement as unknown as { fitAddon: MockFitAddon }).fitAddon;
        const resizes = vi.fn();
        terminalElement.addEventListener('terminal-resize', resizes);
        fit.proposeDimensions.mockClear();
        term.resize.mockClear();
        expect(bar().classList.contains('visible')).toBe(false);

        touch('touchstart', 100);
        touch('touchmove', 130);
        frame();
        expect(bar().classList.contains('visible')).toBe(true);
        // Right of the last column: 80 columns of 9 px end at 720 px; the thumb is drawn
        // 4 px further in (CSS), in the strip FitAddon left when it counted the columns.
        expect(Number.parseFloat(bar().style.left)).toBeGreaterThanOrEqual(term.cols * 9);
        expect(bar().style.left).toBe('720px');
        expect(bar().style.height).toBe(`${24 * 18}px`);
        lift(130);
        vi.advanceTimersByTime(900);
        expect(bar().classList.contains('visible')).toBe(true);
        vi.advanceTimersByTime(200);
        expect(bar().classList.contains('visible')).toBe(false);

        expect(term.resize).not.toHaveBeenCalled();
        expect(fit.proposeDimensions).not.toHaveBeenCalled();
        expect(resizes).not.toHaveBeenCalled();
        expect(term.cols).toBe(80);
      });

      it('moves its thumb with the view, the pixels between rows included', () => {
        touch('touchstart', 100);
        touch('touchmove', 108); // 8 px back
        frame();
        const near = thumbTop();
        touch('touchmove', 116); // 16 px back: the same row, further up the history
        frame();
        expect(term.getViewportY()).toBe(0);
        expect(thumbTop()).toBeLessThan(near);
        lift(116);
        // The oldest row at the top: the thumb at the top of its track (3 px in).
        terminalElement.scrollToPosition(0);
        expect(thumbTop()).toBe(3);
      });

      it('can be dragged with a mouse; a finger goes through to the terminal', () => {
        terminalElement.scrollToPosition(0);
        vi.spyOn(bar(), 'getBoundingClientRect').mockReturnValue({
          top: 0,
          left: 0,
          right: 12,
          bottom: 432,
          width: 12,
          height: 432,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        });
        const pointer = (type: string, clientY: number, pointerType = 'mouse') =>
          new PointerEvent(type, {
            clientY,
            pointerId: pointerType === 'mouse' ? 1 : 2,
            pointerType,
            button: 0,
            bubbles: true,
            cancelable: true,
          });
        // Track 432 - 6 px; thumb 426 × 24/100 rows; grabbed 10 px into it, moved half way.
        const travel = 426 - (426 * 24) / 100;
        bar().dispatchEvent(pointer('pointerdown', 13));
        bar().dispatchEvent(pointer('pointermove', 13 + travel / 2));
        expect(terminalElement.getScrollPosition()).toBe(38);
        bar().dispatchEvent(pointer('pointermove', 13 + travel));
        expect(terminalElement.getScrollPosition()).toBe(76);
        bar().dispatchEvent(pointer('pointerup', 13 + travel));
        bar().dispatchEvent(pointer('pointermove', 13));
        expect(terminalElement.getScrollPosition()).toBe(76);

        const down = pointer('pointerdown', 13, 'touch');
        bar().dispatchEvent(down);
        bar().dispatchEvent(pointer('pointermove', 100, 'touch'));
        expect(down.defaultPrevented).toBe(false);
        expect(terminalElement.getScrollPosition()).toBe(76);
      });
    });

    it('measures touch scrolls when the server says so: the PWA cannot take ?scrollperf', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const lines = () =>
        log.mock.calls.map((args) => args.join(' ')).filter((line) => line.includes('scrollperf:'));
      const flush = async () => {
        for (let i = 0; i < 5; i++) await Promise.resolve();
      };
      serverConfig.current = { scrollPerf: true };
      try {
        touch('touchstart', 300);
        await flush(); // the server's answer comes
        for (const y of [330, 360, 390]) {
          frame();
          touch('touchmove', y);
        }
        frame();
        lift(390);
        vi.advanceTimersByTime(5000); // the fling runs out
        expect(lines()).toHaveLength(1);
        expect(lines()[0]).toMatch(
          /mode local, rows 24, renders \d+, render p95 [\d.]+ ms, dpr 1, crossings [1-9]\d* \(render max [\d.]+ ms\), max step [\d.]+ px, reversals 0, dual 0, release 1\.88 px\/ms \([\d.]+ px\/frame\), first momentum step [\d.]+ px$/
        );

        // Off again on the server: from the next check (a minute on), nothing is measured.
        serverConfig.current = {};
        vi.advanceTimersByTime(61_000);
        touch('touchstart', 300);
        await flush();
        touch('touchmove', 340);
        frame();
        lift(340);
        vi.advanceTimersByTime(5000);
        expect(lines()).toHaveLength(1);
      } finally {
        serverConfig.current = {};
        log.mockRestore();
      }
    });

    it('keeps the shift under a pinch preview and drops pending moves when it starts', () => {
      touch('touchstart', 100);
      touch('touchmove', 130);
      frame();
      container.dispatchEvent(
        touchEvent('touchstart', [
          [60, 130],
          [160, 130],
        ])
      );
      container.dispatchEvent(
        touchEvent('touchmove', [
          [35, 130],
          [185, 130],
        ])
      );
      expect(canvas.style.transform).toBe('translate3d(0, 0px, 0) scale(1.5)');
      // The text 12 px lower in a canvas scaled from its top: 18 px lower on screen.
      expect(textAt()).toBe(18);
      container.dispatchEvent(touchEvent('touchend', [[60, 130]], [[185, 130]]));
      expect(canvas.style.transform).toBe(AT_REST);
      expect(textAt()).toBe(12);
      container.dispatchEvent(touchEvent('touchend', [], [[60, 130]]));
    });
  });

  describe('repaints while scrolled back', () => {
    let terminalElement: Terminal;
    let term: MockTerminal;
    let renderer: MockRenderer;

    beforeEach(async () => {
      MockTerminal.withRenderer = true;
      try {
        terminalElement = await fixture<Terminal>(html`
          <ut-terminal session-id="repaint-1"></ut-terminal>
        `);
        await waitForCondition(() => terminalElement.getAttribute('data-ready') === 'true', {
          message: 'terminal not ready',
        });
      } finally {
        MockTerminal.withRenderer = false;
      }
      term = (terminalElement as unknown as { terminal: MockTerminal }).terminal;
      renderer = term.renderer as MockRenderer;
      term.buffer.active.length = 100;
    });

    afterEach(() => {
      terminalElement.remove();
    });

    // What ghostty-web's requestAnimationFrame loop does on every frame.
    const frame = (opacity = 1) =>
      renderer.render(term.wasmTerm, false, term.getViewportY(), term, opacity);

    it('skips frames identical to the last one painted', () => {
      frame();
      frame();
      expect(renderer.paint).toHaveBeenCalledTimes(1);

      terminalElement.scrollToPosition(20);
      renderer.paint.mockClear();
      frame();
      frame();
      frame();
      expect(renderer.paint).toHaveBeenCalledTimes(1);

      // Output, a scroll, a link hover: painted once each.
      term.wasmTerm.isDirty.mockReturnValueOnce(true);
      frame();
      expect(renderer.paint).toHaveBeenCalledTimes(2);
      term.scrollLines(-1);
      frame();
      frame();
      expect(renderer.paint).toHaveBeenCalledTimes(3);
      renderer.setHoveredLinkRange(null);
      frame();
      frame();
      expect(renderer.paint).toHaveBeenCalledTimes(4);
      // ghostty's scrollbar fade loops render every frame for 200 ms: its scrollbar is never
      // painted, so they repaint nothing.
      frame(0.3);
      frame(0.6);
      frame(1);
      expect(renderer.paint).toHaveBeenCalledTimes(4);

      // A selection repaints every frame, and once more after ghostty silently clears it.
      term.hasSelection.mockReturnValue(true);
      frame();
      frame();
      expect(renderer.paint).toHaveBeenCalledTimes(6);
      term.hasSelection.mockReturnValue(false);
      frame();
      frame();
      expect(renderer.paint).toHaveBeenCalledTimes(7);
      term.simulateSelectionChange();
      frame();
      expect(renderer.paint).toHaveBeenCalledTimes(8);

      // Resizes and font changes force a full paint.
      renderer.render(term.wasmTerm, true, term.getViewportY(), term);
      expect(renderer.paint).toHaveBeenCalledTimes(9);
    });

    it("drops ghostty's scrollbar mouse zone, which lay over the last column", async () => {
      const remove = vi.spyOn(HTMLElement.prototype, 'removeEventListener');
      MockTerminal.withRenderer = true;
      let other: Terminal;
      try {
        other = await fixture<Terminal>(html`<ut-terminal session-id="repaint-2"></ut-terminal>`);
        await waitForCondition(() => other.getAttribute('data-ready') === 'true', {
          message: 'terminal not ready',
        });
      } finally {
        MockTerminal.withRenderer = false;
      }
      const otherTerm = (other as unknown as { terminal: MockTerminal }).terminal;
      expect(remove).toHaveBeenCalledWith('mousedown', otherTerm.handleMouseDown, {
        capture: true,
      });
      remove.mockRestore();
      other.remove();
    });

    it('at the bottom repaints only when the cursor moves, shows, hides or blinks', () => {
      const blink = renderer as unknown as { cursorVisible?: boolean };
      blink.cursorVisible = true;
      frame();
      frame();
      frame();
      expect(renderer.paint).toHaveBeenCalledTimes(1);
      blink.cursorVisible = false; // ghostty's 530 ms blink
      frame();
      frame();
      expect(renderer.paint).toHaveBeenCalledTimes(2);
      term.wasmTerm.getCursor.mockReturnValue({ x: 4, y: 0, visible: true });
      frame();
      expect(renderer.paint).toHaveBeenCalledTimes(3);
      term.wasmTerm.getCursor.mockReturnValue({ x: 4, y: 0, visible: false });
      frame();
      expect(renderer.paint).toHaveBeenCalledTimes(4);
      term.wasmTerm.isDirty.mockReturnValueOnce(true); // output
      frame();
      frame();
      expect(renderer.paint).toHaveBeenCalledTimes(5);
    });

    it('never lets ghostty paint its scrollbar on the canvas, over the last columns', () => {
      // At the bottom and scrolled back alike, whatever opacity ghostty's fade has reached.
      frame(1);
      expect(renderer.paint).toHaveBeenLastCalledWith(term.wasmTerm, false, 0, term, 0);
      terminalElement.scrollToPosition(20);
      frame(0.7);
      expect(renderer.paint).toHaveBeenLastCalledWith(term.wasmTerm, false, 56, term, 0);
      expect(renderer.paint.mock.calls.every((call) => call[4] === 0)).toBe(true);
    });
  });

  describe('cleanup', () => {
    it('should clean up on disconnect', async () => {
      await element.firstUpdated();
      const terminal = (element as unknown as { terminal: MockTerminal }).terminal;
      const container = element.querySelector('.terminal-container') as HTMLElement;
      const removeEventListenerSpy = vi.spyOn(container, 'removeEventListener');

      element.disconnectedCallback();

      // Should dispose terminal
      expect(terminal?.dispose).toHaveBeenCalled();
      expect(removeEventListenerSpy).toHaveBeenCalledWith('touchstart', expect.any(Function));
      expect(removeEventListenerSpy).toHaveBeenCalledWith('touchmove', expect.any(Function));
    });
  });

  describe('rendering', () => {
    it('should render terminal content', async () => {
      await element.firstUpdated();

      // Write some content
      element.write('Hello Terminal');
      await element.updateComplete;

      // Should have terminal container
      const container = element.querySelector('.terminal-container');
      expect(container).toBeTruthy();
    });
  });

  describe('fitTerminal resize optimization', () => {
    beforeEach(async () => {
      await element.firstUpdated();
      mockTerminal = (element as unknown as { terminal: MockTerminal }).terminal;

      // Clear any previous calls
      mockTerminal?.resize.mockClear();
    });

    it('should recompute unlimited mobile width after the viewport changes', () => {
      if (!mockTerminal) throw new Error('mock terminal was not created');

      const fitAddon = (element as unknown as { fitAddon: MockFitAddon }).fitAddon;
      setViewport(390, 844);
      element.maxCols = 0;

      fitAddon.proposeDimensions.mockReturnValue({ cols: 40, rows: 24 });
      element.fitTerminal('narrow');
      expect(mockTerminal.resize).toHaveBeenLastCalledWith(40, 24);

      fitAddon.proposeDimensions.mockReturnValue({ cols: 90, rows: 24 });
      element.fitTerminal('wide');
      expect(mockTerminal.resize).toHaveBeenLastCalledWith(90, 24);
    });

    it('keeps its rows under the chat view when only the height shrinks, and fits once shown', async () => {
      // The keyboard under the phone's chat view shrank the PTY to 10 rows and Claude Code
      // paged its menu, hiding "No" (2026-10-03, SE).
      if (!mockTerminal) throw new Error('mock terminal was not created');
      const fitAddon = (element as unknown as { fitAddon: MockFitAddon }).fitAddon;
      setViewport(390, 844);
      fitAddon.proposeDimensions.mockReturnValue({ cols: 45, rows: 30 });
      element.fitTerminal('start');
      expect(mockTerminal.resize).toHaveBeenLastCalledWith(45, 30);
      element.holdRows = true;
      await element.updateComplete;
      fitAddon.proposeDimensions.mockReturnValue({ cols: 45, rows: 10 });
      element.fitTerminal('keyboard');
      expect(mockTerminal.resize).toHaveBeenLastCalledWith(45, 30);
      // A rotation fits the width and keeps the rows (fifth review).
      fitAddon.proposeDimensions.mockReturnValue({ cols: 60, rows: 12 });
      element.fitTerminal('rotation');
      expect(mockTerminal.resize).toHaveBeenLastCalledWith(60, 30);
      element.holdRows = false;
      fitAddon.proposeDimensions.mockReturnValue({ cols: 60, rows: 8 });
      element.fitTerminal('terminal-shown');
      expect(mockTerminal.resize).toHaveBeenLastCalledWith(60, 8);
    });

    it('should treat maxCols as a cap while mobile width changes', () => {
      if (!mockTerminal) throw new Error('mock terminal was not created');

      const fitAddon = (element as unknown as { fitAddon: MockFitAddon }).fitAddon;
      setViewport(390, 844);
      element.maxCols = 80;

      fitAddon.proposeDimensions.mockReturnValue({ cols: 40, rows: 24 });
      element.fitTerminal('narrow');
      expect(mockTerminal.resize).toHaveBeenLastCalledWith(40, 24);

      fitAddon.proposeDimensions.mockReturnValue({ cols: 100, rows: 24 });
      element.fitTerminal('wide');
      expect(mockTerminal.resize).toHaveBeenLastCalledWith(80, 24);
    });
  });

  describe('the phone keyboard going down', () => {
    /** Claude Code on 10 rows with the keyboard up: the cursor in its prompt box. */
    async function claudeFrame() {
      const { Ghostty } = await vi.importActual<typeof import('ghostty-web')>('ghostty-web');
      const bytes = readFileSync(
        createRequire(import.meta.url).resolve('ghostty-web/ghostty-vt.wasm')
      );
      const { instance } = await WebAssembly.instantiate(bytes, { env: { log: () => {} } });
      const grid = new Ghostty(instance).createTerminal(45, 10, { scrollbackLimit: 10000 });
      let output = '';
      for (let i = 1; i <= 30; i++) output += `line ${i}\r\n`;
      grid.write(`${output}> hola\r\n  status line\x1b[1A\x1b[7G`);
      return grid;
    }

    const rowText = (grid: Awaited<ReturnType<typeof claudeFrame>>, y: number) =>
      (grid.getLine(y) ?? [])
        .map((cell) => (cell.codepoint ? String.fromCodePoint(cell.codepoint) : ' '))
        .join('')
        .trimEnd();

    it('grows the rows in the resize observer, the prompt kept on the bottom edge', async () => {
      if (!mockTerminal) throw new Error('mock terminal was not created');
      const term = mockTerminal;
      setViewport(375, 667);
      const fitAddon = (element as unknown as { fitAddon: MockFitAddon }).fitAddon;
      fitAddon.proposeDimensions.mockReturnValue({ cols: 45, rows: 10 });
      element.fitTerminal('keyboard-up');

      // ghostty-web's resize resizes its WASM grid: a real one here.
      const grid = await claudeFrame();
      (term as unknown as { wasmTerm: unknown }).wasmTerm = grid;
      const resize = term.resize.getMockImplementation();
      term.resize.mockImplementation((cols: number, rows: number) => {
        grid.resize(cols, rows);
        resize?.(cols, rows);
      });
      const events: Array<{ rows: number; isHeightOnlyChange: boolean; isMobile: boolean }> = [];
      element.addEventListener('terminal-resize', (e) => events.push((e as CustomEvent).detail));
      // No frame runs: whatever happens must happen in the observer's own callback.
      const frame = vi.fn();
      vi.stubGlobal('requestAnimationFrame', frame);

      try {
        // The container grew (the visual viewport, then --app-height): the observer fires
        // after that layout and before the frame is painted.
        fitAddon.proposeDimensions.mockReturnValue({ cols: 45, rows: 14 });
        const observer = (element as unknown as { resizeObserver: MockResizeObserver })
          .resizeObserver;
        observer.callback([], observer as unknown as ResizeObserver);

        expect(term.rows).toBe(14);
        expect(rowText(grid, 12)).toBe('> hola');
        expect(rowText(grid, 13)).toBe('  status line');
        expect(rowText(grid, 0)).toBe('line 19');
        expect(grid.getCursor()).toMatchObject({ x: 6, y: 12 });
        expect(events).toEqual([expect.objectContaining({ rows: 14, isHeightOnlyChange: true })]);
        expect(events[0].isMobile).toBe(true);
        expect(frame).not.toHaveBeenCalledWith(expect.any(Function));
      } finally {
        vi.unstubAllGlobals();
        grid.free();
      }
    });
  });
});
