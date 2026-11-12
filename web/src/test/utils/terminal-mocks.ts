import { vi } from 'vitest';

/**
 * Stand-in for ghostty-web's CanvasRenderer, drawing into the canvas the mock terminal adds.
 * `paint` records what reaches it: the component wraps `render`.
 */
export function createMockRenderer(canvas: HTMLCanvasElement) {
  const paint = vi.fn();
  const renderer = {
    paint,
    render: paint as (...args: unknown[]) => void,
    getMetrics: vi.fn(() => ({ width: 9, height: 18, baseline: 14 })),
    remeasureFont: vi.fn(),
    // As ghostty's: the canvas's CSS size for the cells, its pixels at the renderer's ratio.
    resize: vi.fn((cols: number, rows: number) => {
      const { width, height } = renderer.getMetrics();
      canvas.style.width = `${cols * width}px`;
      canvas.style.height = `${rows * height}px`;
      canvas.width = cols * width * renderer.devicePixelRatio;
      canvas.height = rows * height * renderer.devicePixelRatio;
    }),
    getCanvas: vi.fn(() => canvas),
    setHoveredHyperlinkId: vi.fn(),
    setHoveredLinkRange: vi.fn(),
    charWidth: 9,
    charHeight: 18,
    // Read from the page when the terminal opens, as ghostty's (private there).
    devicePixelRatio: window.devicePixelRatio || 1,
  };
  return renderer;
}

export type MockRenderer = ReturnType<typeof createMockRenderer>;

/**
 * Mock Terminal class for ghostty-web
 */
export class MockTerminal {
  /**
   * Tests that need ghostty's canvas and renderer set this before creating the element; most
   * tests rely on the fontSize * 1.2 row height the component uses without a renderer.
   */
  static withRenderer = false;

  element: HTMLDivElement;
  cols: number = 80;
  rows: number = 24;
  options: Record<string, unknown> = { fontSize: 14, theme: {} };
  renderer: unknown = null;
  buffer = {
    active: {
      cursorY: 0,
      cursorX: 0,
      length: 0,
      viewportY: 0,
      getLine: vi.fn((_index: number) => ({
        translateToString: vi.fn((_trimRight?: boolean) => 'Line'),
        length: 80,
        getCell: vi.fn(() => null),
      })),
      getNullCell: vi.fn(() => ({
        getChars: () => '',
        getCode: () => 0,
        getWidth: () => 1,
        isCombined: () => 0,
        getFgColorMode: () => 0,
        getBgColorMode: () => 0,
        getFgColor: () => 0,
        getBgColor: () => 0,
        isAttributeDefault: () => true,
        hasExtendedAttrs: () => false,
        getExtendedAttrs: () => 0,
        isUnderline: () => false,
        isItalic: () => false,
        isDim: () => false,
        isBold: () => false,
        isInvisible: () => false,
        isInverse: () => false,
        isStrikethrough: () => false,
        isOverline: () => false,
      })),
    },
    normal: {
      scrollTop: 0,
      scrollBottom: 23,
    },
  };

  onData = vi.fn((callback: (data: string) => void) => {
    this._onDataCallback = callback;
    return { dispose: vi.fn() };
  });

  onResize = vi.fn((callback: (size: { cols: number; rows: number }) => void) => {
    this._onResizeCallback = callback;
    return { dispose: vi.fn() };
  });

  onScroll = vi.fn((callback: (viewportY: number) => void) => {
    this._onScrollCallback = callback;
    return { dispose: vi.fn() };
  });

  onSelectionChange = vi.fn((callback: () => void) => {
    this._onSelectionChangeCallback = callback;
    return { dispose: vi.fn() };
  });

  /** The WASM terminal: its dirty state (output since the last paint) and its rows. */
  wasmTerm = this.createWasmTerm();

  private createWasmTerm() {
    const rowsNow = () => this.rows;
    return {
      /** The grid's height: ghostty-web's resize resizes its WASM terminal too. */
      get rows() {
        return rowsNow();
      },
      /** Output written straight to the WASM terminal (not through write()). */
      write: vi.fn((_data: string | Uint8Array) => {}),
      getScrollbackLength: vi.fn(() => 0),
      isAlternateScreen: vi.fn(() => false),
      getMode: vi.fn((_mode: number, _isAnsi?: boolean) => false),
      isDirty: vi.fn(() => false),
      getCursor: vi.fn(() => ({ x: 0, y: 0, visible: true })),
      /** A row of the live screen; none unless a test provides them. */
      getLine: vi.fn((_row: number): ReturnType<MockTerminal['getScrollbackLine']> => null),
      getGraphemeString: vi.fn((_row: number, _col: number) => ' '),
      getScrollbackGraphemeString: vi.fn((_offset: number, _col: number) => ' '),
    };
  }

  /** ghostty-web's mousedown listener for its in-canvas scrollbar (private there). */
  handleMouseDown = vi.fn();

  // Nothing fires title or key events in the mock, so their listeners are not kept.
  onTitleChange = vi.fn((_callback: (title: string) => void) => ({ dispose: vi.fn() }));

  onKey = vi.fn((_callback: (event: { key: string; domEvent: KeyboardEvent }) => void) => ({
    dispose: vi.fn(),
  }));

  private _onDataCallback?: (data: string) => void;
  private _onResizeCallback?: (size: { cols: number; rows: number }) => void;
  private _onScrollCallback?: (viewportY: number) => void;
  private _onSelectionChangeCallback?: () => void;

  /** The Ghostty (its WASM instance) passed in; dispose() lets go of it, as ghostty-web does. */
  ghostty: unknown;

  constructor(options: { ghostty?: unknown } = {}) {
    this.ghostty = options.ghostty;
    this.element =
      typeof document !== 'undefined'
        ? document.createElement('div')
        : ({} as unknown as HTMLDivElement);
  }

  loadAddon = vi.fn((_addon: unknown) => {
    // no-op for tests
  });

  registerLinkProvider = vi.fn();

  /** DEC private modes the app has enabled (e.g. 1000 mouse tracking, 1006 SGR). */
  enabledModes = new Set<number>();
  wheelHandler?: (event: WheelEvent) => boolean;

  attachCustomWheelEventHandler = vi.fn((handler: (event: WheelEvent) => boolean) => {
    this.wheelHandler = handler;
  });

  hasMouseTracking = vi.fn(() => [1000, 1002, 1003].some((mode) => this.enabledModes.has(mode)));

  getMode = vi.fn((mode: number) => this.enabledModes.has(mode));

  open = vi.fn((element: HTMLElement) => {
    element.appendChild(this.element);
    if (MockTerminal.withRenderer) {
      const canvas = document.createElement('canvas');
      element.appendChild(canvas);
      const renderer = createMockRenderer(canvas);
      this.renderer = renderer;
      // ghostty's open() sizes the canvas for the grid.
      renderer.resize(this.cols, this.rows);
    }
  });

  write = vi.fn((_data: string | Uint8Array, callback?: () => void) => {
    // write() is for terminal output, should not trigger onData callback
    // onData is only for user input
    callback?.();
  });

  writeln = vi.fn((data: string) => {
    this.write(`${data}\r\n`);
  });

  clear = vi.fn();

  reset = vi.fn();

  focus = vi.fn();

  blur = vi.fn();

  resize = vi.fn((cols: number, rows: number) => {
    // Ghostty resize expects integer values
    if (!Number.isInteger(cols) || !Number.isInteger(rows)) {
      throw new Error('This API only accepts integers');
    }
    const changed = cols !== this.cols || rows !== this.rows;
    this.cols = cols;
    this.rows = rows;
    // ghostty sizes the canvas for the new grid.
    if (changed) (this.renderer as MockRenderer | null)?.resize(cols, rows);
    if (this._onResizeCallback) {
      this._onResizeCallback({ cols, rows });
    }
  });

  dispose = vi.fn(() => {
    this.ghostty = undefined;
  });

  scrollToBottom = vi.fn(() => {
    this.buffer.active.viewportY = 0;
    this._onScrollCallback?.(0);
  });

  scrollToTop = vi.fn();

  scrollLines = vi.fn((amount: number) => {
    const max = Math.max(0, this.buffer.active.length - this.rows);
    this.buffer.active.viewportY = Math.max(
      0,
      Math.min(max, this.buffer.active.viewportY - amount)
    );
    this._onScrollCallback?.(this.buffer.active.viewportY);
  });

  scrollToLine = vi.fn((line: number) => {
    const max = Math.max(0, this.buffer.active.length - this.rows);
    const clamped = Math.max(0, Math.min(max, line));
    this.buffer.active.viewportY = clamped;
    if (this._onScrollCallback) this._onScrollCallback(this.buffer.active.viewportY);
  });

  getViewportY = vi.fn(() => this.buffer.active.viewportY);

  /** Rows of history above the live screen (the normal buffer's length minus the screen). */
  getScrollbackLength = vi.fn(() => Math.max(0, this.buffer.active.length - this.rows));

  /** Cells of a history row (0 = oldest); the mock has none unless a test provides them. */
  getScrollbackLine = vi.fn(
    (
      _offset: number
    ): Array<{
      codepoint: number;
      fg_r: number;
      fg_g: number;
      fg_b: number;
      bg_r: number;
      bg_g: number;
      bg_b: number;
      flags: number;
      width: number;
      hyperlink_id: number;
      grapheme_len: number;
    }> | null => null
  );

  select = vi.fn();

  selectAll = vi.fn();

  clearSelection = vi.fn();

  getSelection = vi.fn(() => '');

  hasSelection = vi.fn(() => false);

  paste = vi.fn((data: string) => {
    if (this._onDataCallback) {
      this._onDataCallback(data);
    }
  });

  refresh = vi.fn();

  // Simulate user typing
  simulateTyping(text: string) {
    if (this._onDataCallback) {
      this._onDataCallback(text);
    }
  }

  // Simulate terminal output
  simulateOutput(text: string) {
    // This would normally update the terminal buffer
    // For testing, we just track that write was called
    this.write(text);
  }

  // Simulate resize event
  simulateResize(cols: number, rows: number) {
    this.resize(cols, rows);
  }

  simulateScroll(viewportY: number) {
    this.buffer.active.viewportY = viewportY;
    this._onScrollCallback?.(viewportY);
  }

  simulateSelectionChange() {
    this._onSelectionChangeCallback?.();
  }
}

/**
 * Mock FitAddon for ghostty-web fit addon
 */
export class MockFitAddon {
  proposeDimensions = vi.fn(() => ({ cols: 80, rows: 24 }));
  fit = vi.fn();
  dispose = vi.fn();
}

/**
 * Mock WebLinksAddon for legacy tests
 */
export class MockWebLinksAddon {
  activate = vi.fn();
  dispose = vi.fn();
}

/**
 * Mock Search addon for legacy tests
 */
export class MockSearchAddon {
  findNext = vi.fn();
  findPrevious = vi.fn();
  dispose = vi.fn();
}

/**
 * Creates a mock WebSocket for terminal connections
 */
export function createTerminalWebSocket() {
  return {
    url: '',
    readyState: WebSocket.CONNECTING as number,
    send: vi.fn(),
    close: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),

    // Helper methods for testing
    mockOpen() {
      this.readyState = WebSocket.OPEN;
      const event = new Event('open');
      this.dispatchEvent(event);
    },

    mockMessage(data: unknown) {
      const event = new MessageEvent('message', { data });
      this.dispatchEvent(event);
    },

    mockClose(code = 1000, reason = 'Normal closure') {
      this.readyState = WebSocket.CLOSED;
      const event = new CloseEvent('close', { code, reason });
      this.dispatchEvent(event);
    },

    mockError(error: Error) {
      const event = new ErrorEvent('error', { error });
      this.dispatchEvent(event);
    },
  };
}

/**
 * Mock ResizeObserver for terminal resize testing
 */
export class MockResizeObserver {
  callback: ResizeObserverCallback;
  observedElements = new Set<Element>();

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }

  observe = vi.fn((element: Element) => {
    this.observedElements.add(element);
  });

  unobserve = vi.fn((element: Element) => {
    this.observedElements.delete(element);
  });

  disconnect = vi.fn(() => {
    this.observedElements.clear();
  });

  // Simulate resize
  simulateResize(element: Element, contentRect: Partial<DOMRectReadOnly>) {
    if (this.observedElements.has(element)) {
      const entry = {
        target: element,
        contentRect: {
          x: 0,
          y: 0,
          width: 800,
          height: 600,
          top: 0,
          right: 800,
          bottom: 600,
          left: 0,
          ...contentRect,
        } as DOMRectReadOnly,
        borderBoxSize: [],
        contentBoxSize: [],
        devicePixelContentBoxSize: [],
      };
      this.callback([entry as ResizeObserverEntry], this as ResizeObserver);
    }
  }
}

/**
 * Creates mock binary data for buffer testing
 */
export function createMockBufferData(cols: number, rows: number): ArrayBuffer {
  // Create a simple buffer with some test data
  const buffer = new ArrayBuffer(cols * rows * 12); // 12 bytes per cell
  const view = new DataView(buffer);

  // Fill with some test pattern
  for (let i = 0; i < cols * rows; i++) {
    const offset = i * 12;
    view.setUint32(offset, 0x41 + (i % 26), true); // Character 'A' + offset
    view.setUint32(offset + 4, 0xffffff, true); // White foreground
    view.setUint32(offset + 8, 0x000000, true); // Black background
  }

  return buffer;
}

/**
 * Mock for terminal binary protocol
 */
export function createMockBinaryMessage(type: string, data: unknown): ArrayBuffer {
  const encoder = new TextEncoder();
  const typeBytes = encoder.encode(type);
  const dataStr = JSON.stringify(data);
  const dataBytes = encoder.encode(dataStr);

  const buffer = new ArrayBuffer(4 + typeBytes.length + dataBytes.length);
  const view = new DataView(buffer);

  // Type length
  view.setUint32(0, typeBytes.length, true);

  // Type string
  new Uint8Array(buffer, 4, typeBytes.length).set(typeBytes);

  // Data
  new Uint8Array(buffer, 4 + typeBytes.length).set(dataBytes);

  return buffer;
}
