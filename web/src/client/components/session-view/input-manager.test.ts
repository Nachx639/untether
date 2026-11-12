// @vitest-environment happy-dom
import { afterAll, afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { Session } from '../../../shared/types.js';
import { InputManager, isAppShortcut } from './input-manager.js';

// Mock fetch globally, for this file only
const setupFetch = global.fetch;
global.fetch = vi.fn();
afterAll(() => {
  global.fetch = setupFetch;
});

const terminalSocketClientMock = vi.hoisted(() => ({
  initialize: vi.fn(),
  getConnectionStatus: vi.fn(() => true),
  onConnectionStateChange: vi.fn(() => () => {}),
  sendInputText: vi.fn().mockReturnValue(true),
  sendInputKey: vi.fn().mockReturnValue(true),
}));

vi.mock('../../services/terminal-socket-client.js', () => ({
  terminalSocketClient: terminalSocketClientMock,
}));

// We don't need to mock browser-shortcuts because the tests should verify
// the actual behavior of the module

describe('InputManager', () => {
  let inputManager: InputManager;
  let mockSession: Session;
  let mockCallbacks: {
    requestUpdate: Mock<() => void>;
    getKeyboardCaptureActive: Mock<() => boolean>;
  };

  beforeEach(() => {
    inputManager = new InputManager();
    mockSession = {
      id: 'test-session-id',
      name: 'Test Session',
      status: 'running',
      startedAt: new Date().toISOString(),
      lastModified: new Date().toISOString(),
      command: ['bash'],
      workingDir: '/home/test',
      pid: 12345,
    };

    mockCallbacks = {
      requestUpdate: vi.fn(),
      getKeyboardCaptureActive: vi.fn().mockReturnValue(false), // Default to capture OFF for browser shortcut tests
    };

    inputManager.setSession(mockSession);
    inputManager.setCallbacks(mockCallbacks);

    // Reset fetch mock
    vi.mocked(global.fetch).mockReset();
    terminalSocketClientMock.sendInputText.mockClear();
    terminalSocketClientMock.sendInputKey.mockClear();
  });

  it.each([
    [true, '\x1b[200~line one\nline two\x1b[201~'],
    [false, 'line one\nline two'],
  ])('pastes multi-line text with bracketed paste=%s', async (bracketed, expected) => {
    terminalSocketClientMock.sendInputText.mockReturnValue(true);
    inputManager.setCallbacks({
      ...mockCallbacks,
      getTerminalElement: () =>
        ({ isBracketedPasteEnabled: () => bracketed }) as unknown as ReturnType<
          NonNullable<Parameters<InputManager['setCallbacks']>[0]['getTerminalElement']>
        >,
    });

    await inputManager.sendPastedText('line one\nline two');

    expect(terminalSocketClientMock.sendInputText).toHaveBeenCalledWith(
      'test-session-id',
      expected
    );
  });

  afterEach(() => {
    inputManager.cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("typed text takes the session's size, a scroll's wheel reports do not", async () => {
    const inputSent = vi.fn();
    inputManager.setCallbacks({ ...mockCallbacks, inputSent });

    await inputManager.sendInputText('\x1b[<64;10;5M\x1b[<64;10;5M', { scroll: true });
    expect(terminalSocketClientMock.sendInputText).toHaveBeenCalledWith(
      'test-session-id',
      '\x1b[<64;10;5M\x1b[<64;10;5M'
    );
    expect(inputSent).not.toHaveBeenCalled();

    await inputManager.sendInputText('a');
    expect(inputSent).toHaveBeenCalledTimes(1);
  });

  it('cancels pending IME setup retries during cleanup', async () => {
    inputManager.cleanup();
    vi.useFakeTimers();
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('zh-CN');

    const getTerminalElement = vi.fn().mockReturnValue(null);
    inputManager = new InputManager();
    inputManager.setCallbacks({
      requestUpdate: vi.fn(),
      getTerminalElement,
    });
    inputManager.setSession(mockSession);

    expect(getTerminalElement).toHaveBeenCalledTimes(1);

    inputManager.cleanup();
    await vi.advanceTimersByTimeAsync(1000);

    expect(getTerminalElement).toHaveBeenCalledTimes(1);
  });

  describe('Option/Alt + Arrow key navigation', () => {
    it('should send Escape+b for Alt+Left arrow', async () => {
      const event = new KeyboardEvent('keydown', {
        key: 'ArrowLeft',
        altKey: true,
      });

      await inputManager.handleKeyboardInput(event);

      expect(terminalSocketClientMock.sendInputText).toHaveBeenCalledWith(
        'test-session-id',
        '\x1bb'
      );
    });

    it('should send Escape+f for Alt+Right arrow', async () => {
      const event = new KeyboardEvent('keydown', {
        key: 'ArrowRight',
        altKey: true,
      });

      await inputManager.handleKeyboardInput(event);

      expect(terminalSocketClientMock.sendInputText).toHaveBeenCalledWith(
        'test-session-id',
        '\x1bf'
      );
    });

    it('should send regular arrow keys without Alt modifier', async () => {
      const event = new KeyboardEvent('keydown', {
        key: 'ArrowLeft',
        altKey: false,
      });

      await inputManager.handleKeyboardInput(event);

      expect(terminalSocketClientMock.sendInputKey).toHaveBeenCalledWith(
        'test-session-id',
        'arrow_left'
      );
    });
  });

  it('sends both Escapes of a quick Esc Esc: Claude Code reads Esc Esc itself', async () => {
    const listener = vi.fn();
    document.addEventListener('capture-toggled', listener);
    try {
      await inputManager.handleKeyboardInput(new KeyboardEvent('keydown', { key: 'Escape' }));
      await inputManager.handleKeyboardInput(new KeyboardEvent('keydown', { key: 'Escape' }));
    } finally {
      document.removeEventListener('capture-toggled', listener);
    }

    expect(terminalSocketClientMock.sendInputKey.mock.calls).toEqual([
      ['test-session-id', 'escape'],
      ['test-session-id', 'escape'],
    ]);
    expect(listener).toHaveBeenCalledOnce();
  });

  describe('Option/Alt + Backspace word deletion', () => {
    it('should send Ctrl+W for Alt+Backspace', async () => {
      const event = new KeyboardEvent('keydown', {
        key: 'Backspace',
        altKey: true,
      });

      await inputManager.handleKeyboardInput(event);

      expect(terminalSocketClientMock.sendInputText).toHaveBeenCalledWith(
        'test-session-id',
        '\x17'
      );
    });

    it('should send regular Backspace without Alt modifier', async () => {
      const event = new KeyboardEvent('keydown', {
        key: 'Backspace',
        altKey: false,
      });

      await inputManager.handleKeyboardInput(event);

      expect(terminalSocketClientMock.sendInputKey).toHaveBeenCalledWith(
        'test-session-id',
        'backspace'
      );
    });
  });

  describe('Cross-platform consistency', () => {
    it('should not interfere with standard copy/paste shortcuts', async () => {
      // Mock navigator.platform for macOS
      Object.defineProperty(navigator, 'platform', {
        value: 'MacIntel',
        configurable: true,
      });

      // Test Cmd+C on macOS (should not send anything)
      const copyEvent = new KeyboardEvent('keydown', {
        key: 'c',
        metaKey: true,
      });
      await inputManager.handleKeyboardInput(copyEvent);

      // Test Cmd+V on macOS (should not send anything)
      const pasteEvent = new KeyboardEvent('keydown', {
        key: 'v',
        metaKey: true,
      });
      await inputManager.handleKeyboardInput(pasteEvent);

      // Input goes through the terminal socket, not fetch: nothing was sent for copy/paste
      expect(terminalSocketClientMock.sendInputText).not.toHaveBeenCalled();
      expect(terminalSocketClientMock.sendInputKey).not.toHaveBeenCalled();
    });
  });

  describe("Ctrl+X off Apple (Claude Code's send chords, user report 2026-10-14)", () => {
    const press = (init: KeyboardEventInit, target: HTMLElement) => {
      const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
      Object.defineProperty(event, 'target', { value: target, configurable: true });
      return event;
    };

    beforeEach(() => {
      Object.defineProperty(navigator, 'platform', { value: 'Win32', configurable: true });
    });

    afterEach(() => {
      Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true });
    });

    it('sends Ctrl+X to the terminal, where there is nothing to cut', async () => {
      terminalSocketClientMock.sendInputText.mockReturnValue(true);
      const terminal = document.createElement('div');
      const ctrlX = press({ key: 'x', ctrlKey: true }, terminal);
      expect(inputManager.isKeyboardShortcut(ctrlX)).toBe(false);
      await inputManager.handleKeyboardInput(ctrlX);
      await inputManager.handleKeyboardInput(press({ key: 's', ctrlKey: true }, terminal));
      expect(terminalSocketClientMock.sendInputText.mock.calls.map(([, text]) => text)).toEqual([
        '\x18',
        '\x13',
      ]);
      // The terminal's own hidden input too.
      const paste = document.createElement('textarea');
      paste.className = 'terminal-paste-input';
      expect(inputManager.isKeyboardShortcut(press({ key: 'x', ctrlKey: true }, paste))).toBe(
        false
      );
      // And the desktop IME input in the terminal's container, which a desktop browser focuses.
      const container = document.createElement('div');
      container.id = 'session-terminal';
      const ime = document.createElement('input');
      container.appendChild(ime);
      expect(inputManager.isKeyboardShortcut(press({ key: 'x', ctrlKey: true }, ime))).toBe(false);
    });

    it('keeps cut and paste where they mean something', () => {
      const field = document.createElement('textarea');
      expect(inputManager.isKeyboardShortcut(press({ key: 'x', ctrlKey: true }, field))).toBe(true);
      const terminal = document.createElement('div');
      expect(inputManager.isKeyboardShortcut(press({ key: 'v', ctrlKey: true }, terminal))).toBe(
        true
      );
    });
  });

  describe('Session state handling', () => {
    it('should not send input to exited sessions', async () => {
      mockSession.status = 'exited';

      const event = new KeyboardEvent('keydown', {
        key: 'ArrowLeft',
        altKey: true,
      });

      await inputManager.handleKeyboardInput(event);

      expect(terminalSocketClientMock.sendInputText).not.toHaveBeenCalled();
      expect(terminalSocketClientMock.sendInputKey).not.toHaveBeenCalled();
    });

    it('should update session status when receiving 400 response', async () => {
      // Force HTTP fallback
      terminalSocketClientMock.sendInputText.mockReturnValueOnce(false);
      const mockResponse = {
        ok: false,
        status: 400,
        json: vi.fn().mockResolvedValue({}),
      };
      vi.mocked(global.fetch).mockResolvedValueOnce(mockResponse as unknown as Response);

      const event = new KeyboardEvent('keydown', {
        key: 'a',
      });

      await inputManager.handleKeyboardInput(event);

      expect(mockSession.status).toBe('exited');
      expect(mockCallbacks.requestUpdate).toHaveBeenCalled();
    });
  });

  it('keeps HTTP fallback writes in the order they were sent', async () => {
    terminalSocketClientMock.sendInputText.mockReturnValue(false);
    const bodies: string[] = [];
    let releaseFirst: () => void = () => {};
    vi.mocked(global.fetch).mockImplementation(async (url, init) => {
      if (!String(url).endsWith('/input')) return { ok: true, status: 200 } as Response;
      const body = String(init?.body);
      if (bodies.length === 0) {
        bodies.push(body);
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      } else {
        bodies.push(body);
      }
      return { ok: true, status: 200 } as Response;
    });

    const message = inputManager.sendInputText('hola');
    const enter = inputManager.sendInputText('\r');
    await Promise.resolve();
    await Promise.resolve();
    expect(bodies).toHaveLength(1);

    releaseFirst();
    await Promise.all([message, enter]);
    expect(bodies.map((b) => JSON.parse(b).text)).toEqual(['hola', '\r']);
  });

  describe('Browser shortcut detection', () => {
    it('should detect Cmd+Shift+A as browser shortcut on macOS', () => {
      Object.defineProperty(navigator, 'platform', {
        writable: true,
        value: 'MacIntel',
      });

      const event = new KeyboardEvent('keydown', {
        key: 'A',
        metaKey: true,
        shiftKey: true,
      });
      // Mock a target element (simulating event fired on document body)
      Object.defineProperty(event, 'target', {
        value: document.createElement('div'),
        configurable: true,
      });

      expect(inputManager.isKeyboardShortcut(event)).toBe(true);
    });

    it('should detect Cmd+1-9 as browser shortcuts on macOS', () => {
      Object.defineProperty(navigator, 'platform', {
        writable: true,
        value: 'MacIntel',
      });

      for (let i = 1; i <= 9; i++) {
        const event = new KeyboardEvent('keydown', {
          key: i.toString(),
          metaKey: true,
        });
        // Mock a target element
        Object.defineProperty(event, 'target', {
          value: document.createElement('div'),
          configurable: true,
        });

        expect(inputManager.isKeyboardShortcut(event)).toBe(true);
      }
    });

    it('should detect Cmd+Option+Left/Right as browser shortcuts on macOS', () => {
      Object.defineProperty(navigator, 'platform', {
        writable: true,
        value: 'MacIntel',
      });

      const leftEvent = new KeyboardEvent('keydown', {
        key: 'ArrowLeft',
        metaKey: true,
        altKey: true,
      });
      Object.defineProperty(leftEvent, 'target', {
        value: document.createElement('div'),
        configurable: true,
      });

      const rightEvent = new KeyboardEvent('keydown', {
        key: 'ArrowRight',
        metaKey: true,
        altKey: true,
      });
      Object.defineProperty(rightEvent, 'target', {
        value: document.createElement('div'),
        configurable: true,
      });

      expect(inputManager.isKeyboardShortcut(leftEvent)).toBe(true);
      expect(inputManager.isKeyboardShortcut(rightEvent)).toBe(true);
    });
  });

  describe('App shortcuts beat keyboard capture (macOS)', () => {
    const press = (
      init: KeyboardEventInit,
      target: HTMLElement = document.createElement('div')
    ) => {
      const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
      Object.defineProperty(event, 'target', { value: target, configurable: true });
      return event;
    };

    beforeEach(() => {
      Object.defineProperty(navigator, 'platform', { writable: true, value: 'MacIntel' });
      mockCallbacks.getKeyboardCaptureActive.mockReturnValue(true);
    });

    it.each([
      ['⌘B', { key: 'b', metaKey: true }],
      ['⌘K', { key: 'k', metaKey: true }],
      ['⌘,', { key: ',', metaKey: true }],
      ['⌘1', { key: '1', metaKey: true }],
      ['⌘9', { key: '9', metaKey: true }],
      ['⌘⇧[ (key "{")', { key: '{', code: 'BracketLeft', metaKey: true, shiftKey: true }],
      ['⌘⇧] (key "}")', { key: '}', code: 'BracketRight', metaKey: true, shiftKey: true }],
    ])('%s is never sent to the PTY, even with capture on', (_name, init) => {
      const event = press(init);
      expect(isAppShortcut(event, true)).toBe(true);
      expect(inputManager.isKeyboardShortcut(event)).toBe(true);
      // Not consumed: it must bubble to app.ts.
      expect(event.defaultPrevented).toBe(false);
    });

    it('also from a text field (the chat composer, an inline rename)', () => {
      const input = document.createElement('textarea');
      expect(inputManager.isKeyboardShortcut(press({ key: 'k', metaKey: true }, input))).toBe(true);
      expect(inputManager.isKeyboardShortcut(press({ key: 'b', metaKey: true }, input))).toBe(true);
    });

    it('leaves terminal chords alone: ⌃B, ⌃K, ⌥B, ⌘⌥B, ⌘A and ⌘0 are not app shortcuts', () => {
      expect(isAppShortcut(press({ key: 'b', ctrlKey: true }), true)).toBe(false);
      expect(isAppShortcut(press({ key: 'k', ctrlKey: true }), true)).toBe(false);
      expect(isAppShortcut(press({ key: 'b', altKey: true }), true)).toBe(false);
      expect(isAppShortcut(press({ key: 'b', metaKey: true, altKey: true }), true)).toBe(false);
      expect(isAppShortcut(press({ key: 'a', metaKey: true }), true)).toBe(false);
      expect(isAppShortcut(press({ key: '0', metaKey: true }), true)).toBe(false);
      // ⌘A still goes to the terminal with capture on.
      expect(inputManager.isKeyboardShortcut(press({ key: 'a', metaKey: true }))).toBe(false);
    });

    it('is Mac-only: Ctrl+B elsewhere stays a terminal key', () => {
      expect(isAppShortcut(press({ key: 'b', metaKey: true }), false)).toBe(false);
      expect(isAppShortcut(press({ key: 'b', ctrlKey: true }), false)).toBe(false);
    });
  });
});
