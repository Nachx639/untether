// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHORD_MS } from '../../utils/agent-chords.js';
import * as eventUtils from '../../utils/event-utils.js';
import {
  LifecycleEventManager,
  type LifecycleEventManagerCallbacks,
} from './lifecycle-event-manager.js';

/** Each test hands the manager only the callbacks its path calls. */
const partialCallbacks = (callbacks: Partial<LifecycleEventManagerCallbacks>) =>
  callbacks as LifecycleEventManagerCallbacks;

// Mock the event utils module
vi.mock('../../utils/event-utils.js');

describe('LifecycleEventManager', () => {
  let manager: LifecycleEventManager;

  beforeEach(() => {
    manager = new LifecycleEventManager();
    vi.clearAllMocks();
  });

  afterEach(() => {
    manager.cleanup();
  });

  describe('consumeEvent usage', () => {
    it('should call consumeEvent for keyboard shortcuts', () => {
      const mockCallbacks = {
        getDisableFocusManagement: vi.fn().mockReturnValue(false),
        setShowFileBrowser: vi.fn(),
        getInputManager: vi.fn().mockReturnValue({
          isKeyboardShortcut: vi.fn().mockReturnValue(false),
        }),
        handleKeyboardInput: vi.fn(),
        getIsMobile: vi.fn().mockReturnValue(false),
        getKeyboardCaptureActive: vi.fn().mockReturnValue(true),
      };

      const mockSession = {
        id: 'test-session',
        status: 'running',
      };

      manager.setCallbacks(partialCallbacks(mockCallbacks));
      manager.setSession(mockSession as Parameters<typeof manager.setSession>[0]);

      // Test Cmd+O shortcut
      const cmdOEvent = new KeyboardEvent('keydown', {
        key: 'o',
        metaKey: true,
      });

      manager.keyboardHandler(cmdOEvent);

      expect(eventUtils.consumeEvent).toHaveBeenCalledWith(cmdOEvent);
      expect(mockCallbacks.setShowFileBrowser).toHaveBeenCalledWith(true);

      // Test regular key handling
      const regularKeyEvent = new KeyboardEvent('keydown', {
        key: 'a',
      });

      manager.keyboardHandler(regularKeyEvent);

      expect(eventUtils.consumeEvent).toHaveBeenCalledWith(regularKeyEvent);
      expect(mockCallbacks.handleKeyboardInput).toHaveBeenCalledWith(regularKeyEvent);
    });

    // 2026-11-10: on a computer, the letters of a commit message (ship sheet) or of the custom
    // width were swallowed and typed into the terminal.
    it('leaves keys typed in a field that is not the terminal to that field', () => {
      const mockCallbacks = {
        getDisableFocusManagement: vi.fn().mockReturnValue(false),
        getInputManager: vi.fn().mockReturnValue({
          isKeyboardShortcut: vi.fn().mockReturnValue(false),
        }),
        handleKeyboardInput: vi.fn(),
        getIsMobile: vi.fn().mockReturnValue(false),
        getKeyboardCaptureActive: vi.fn().mockReturnValue(true),
      };
      manager.setCallbacks(partialCallbacks(mockCallbacks));
      manager.setSession({ id: 's', status: 'running' } as Parameters<
        typeof manager.setSession
      >[0]);

      const message = document.createElement('textarea');
      const terminal = document.createElement('div');
      terminal.id = 'session-terminal';
      const imeInput = document.createElement('input');
      terminal.appendChild(imeInput);
      document.body.append(message, terminal);
      const typed = (target: HTMLElement) => {
        let seen: KeyboardEvent | undefined;
        const listener = (event: Event) => {
          seen = event as KeyboardEvent;
          manager.keyboardHandler(seen);
        };
        document.addEventListener('keydown', listener);
        target.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
        document.removeEventListener('keydown', listener);
        return seen;
      };
      try {
        typed(message);
        expect(eventUtils.consumeEvent).not.toHaveBeenCalled();
        expect(mockCallbacks.handleKeyboardInput).not.toHaveBeenCalled();

        // The terminal's own hidden input still types into the terminal.
        const fromTerminal = typed(imeInput);
        expect(mockCallbacks.handleKeyboardInput).toHaveBeenCalledWith(fromTerminal);
      } finally {
        message.remove();
        terminal.remove();
      }
    });

    it('should not consume browser shortcuts', () => {
      const mockCallbacks = {
        getDisableFocusManagement: vi.fn().mockReturnValue(false),
        getInputManager: vi.fn().mockReturnValue({
          isKeyboardShortcut: vi.fn().mockReturnValue(true), // This is a browser shortcut
        }),
        getIsMobile: vi.fn().mockReturnValue(false),
        getKeyboardCaptureActive: vi.fn().mockReturnValue(true),
        handleKeyboardInput: vi.fn(),
      };

      manager.setCallbacks(partialCallbacks(mockCallbacks));

      // Test browser shortcut (e.g., Ctrl+C)
      const browserShortcut = new KeyboardEvent('keydown', {
        key: 'c',
        ctrlKey: true,
      });

      manager.keyboardHandler(browserShortcut);

      // Should not call consumeEvent for browser shortcuts
      expect(eventUtils.consumeEvent).not.toHaveBeenCalled();
    });

    it('handles the file browser shortcut before browser shortcut filtering', () => {
      const mockCallbacks = {
        getDisableFocusManagement: vi.fn().mockReturnValue(false),
        setShowFileBrowser: vi.fn(),
        getInputManager: vi.fn().mockReturnValue({
          isKeyboardShortcut: vi.fn().mockReturnValue(true),
        }),
        handleKeyboardInput: vi.fn(),
      };

      manager.setCallbacks(partialCallbacks(mockCallbacks));

      const cmdOEvent = new KeyboardEvent('keydown', {
        key: 'o',
        metaKey: true,
      });
      manager.keyboardHandler(cmdOEvent);

      expect(eventUtils.consumeEvent).toHaveBeenCalledWith(cmdOEvent);
      expect(mockCallbacks.setShowFileBrowser).toHaveBeenCalledWith(true);
      expect(mockCallbacks.getInputManager).not.toHaveBeenCalled();
    });

    it.each([
      { metaKey: true, shiftKey: true },
      { ctrlKey: true, altKey: true },
      { metaKey: true, ctrlKey: true },
    ])('preserves modified browser O shortcuts: %o', (modifiers) => {
      const isKeyboardShortcut = vi.fn().mockReturnValue(true);
      const mockCallbacks = {
        getDisableFocusManagement: vi.fn().mockReturnValue(false),
        setShowFileBrowser: vi.fn(),
        getInputManager: vi.fn().mockReturnValue({ isKeyboardShortcut }),
        handleKeyboardInput: vi.fn(),
      };

      manager.setCallbacks(partialCallbacks(mockCallbacks));

      const event = new KeyboardEvent('keydown', {
        key: 'o',
        ...modifiers,
      });
      manager.keyboardHandler(event);

      expect(isKeyboardShortcut).toHaveBeenCalledWith(event);
      expect(eventUtils.consumeEvent).not.toHaveBeenCalled();
      expect(mockCallbacks.setShowFileBrowser).not.toHaveBeenCalled();
    });

    it('should leave native IME composition events to the browser', () => {
      const mockCallbacks = {
        getDisableFocusManagement: vi.fn().mockReturnValue(false),
        getInputManager: vi.fn(),
        handleKeyboardInput: vi.fn(),
      };

      manager.setCallbacks(partialCallbacks(mockCallbacks));
      manager.setSession({
        id: 'test-session',
        status: 'running',
      } as Parameters<typeof manager.setSession>[0]);

      const composingEvent = new KeyboardEvent('keydown', { key: 'Process' });
      Object.defineProperty(composingEvent, 'isComposing', { value: true });

      manager.keyboardHandler(composingEvent);

      expect(eventUtils.consumeEvent).not.toHaveBeenCalled();
      expect(mockCallbacks.getInputManager).not.toHaveBeenCalled();
      expect(mockCallbacks.handleKeyboardInput).not.toHaveBeenCalled();
    });

    it('should leave composition events marked by the desktop IME input untouched', () => {
      const mockCallbacks = {
        getDisableFocusManagement: vi.fn().mockReturnValue(false),
        getInputManager: vi.fn(),
        handleKeyboardInput: vi.fn(),
      };

      manager.setCallbacks(partialCallbacks(mockCallbacks));
      document.body.setAttribute('data-ime-composing', 'true');

      try {
        manager.keyboardHandler(new KeyboardEvent('keydown', { key: 'a' }));
      } finally {
        document.body.removeAttribute('data-ime-composing');
      }

      expect(eventUtils.consumeEvent).not.toHaveBeenCalled();
      expect(mockCallbacks.getInputManager).not.toHaveBeenCalled();
      expect(mockCallbacks.handleKeyboardInput).not.toHaveBeenCalled();
    });

    it('routes mobile hardware Escape to the running terminal', () => {
      const mockCallbacks = {
        getDisableFocusManagement: vi.fn().mockReturnValue(false),
        getInputManager: vi.fn().mockReturnValue({
          isKeyboardShortcut: vi.fn().mockReturnValue(false),
        }),
        handleKeyboardInput: vi.fn(),
      };

      manager.setCallbacks(partialCallbacks(mockCallbacks));
      manager.setSession({
        id: 'test-session',
        status: 'running',
      } as Parameters<typeof manager.setSession>[0]);

      const escapeEvent = new KeyboardEvent('keydown', { key: 'Escape' });
      manager.mobileHardwareKeyboardHandler(escapeEvent);

      expect(eventUtils.consumeEvent).toHaveBeenCalledWith(escapeEvent);
      expect(mockCallbacks.handleKeyboardInput).toHaveBeenCalledWith(escapeEvent);
    });

    it('routes ordinary mobile hardware keys to the running terminal', () => {
      const mockCallbacks = {
        getDisableFocusManagement: vi.fn().mockReturnValue(false),
        getInputManager: vi.fn().mockReturnValue({
          isKeyboardShortcut: vi.fn().mockReturnValue(false),
        }),
        handleKeyboardInput: vi.fn(),
      };

      manager.setCallbacks(partialCallbacks(mockCallbacks));
      manager.setSession({
        id: 'test-session',
        status: 'running',
      } as Parameters<typeof manager.setSession>[0]);

      const keyEvent = new KeyboardEvent('keydown', { key: 'a' });
      manager.mobileHardwareKeyboardHandler(keyEvent);

      expect(eventUtils.consumeEvent).toHaveBeenCalledWith(keyEvent);
      expect(mockCallbacks.handleKeyboardInput).toHaveBeenCalledWith(keyEvent);
    });

    describe('in chat mode', () => {
      const chatMode = () => {
        const callbacks = {
          getDisableFocusManagement: vi.fn().mockReturnValue(false),
          getInputManager: vi.fn().mockReturnValue({
            isKeyboardShortcut: vi.fn().mockReturnValue(false),
          }),
          handleKeyboardInput: vi.fn(),
          getChatMode: vi.fn().mockReturnValue(true),
          typeIntoComposer: vi.fn().mockReturnValue(true),
        };
        manager.setCallbacks(partialCallbacks(callbacks));
        manager.setSession({
          id: 'test-session',
          status: 'running',
        } as Parameters<typeof manager.setSession>[0]);
        return callbacks;
      };

      it('types a hardware key into the composer, never the terminal under the chat view', () => {
        // After a reconnect the session view had focus: a message typed on a hardware
        // keyboard went into Claude's prompt unsent while the composer stayed empty
        // (2026-10-03); then it was dropped, Esc included (review of 2026-10-03).
        const callbacks = chatMode();
        manager.mobileHardwareKeyboardHandler(new KeyboardEvent('keydown', { key: 'a' }));
        expect(callbacks.typeIntoComposer).toHaveBeenCalledWith('a');
        expect(callbacks.handleKeyboardInput).not.toHaveBeenCalled();
      });

      it('types a character made with Option into the composer too', () => {
        // "@" is Option+2 on a Spanish layout: it started no message (fourth review, 2026-10-03).
        const callbacks = chatMode();
        manager.mobileHardwareKeyboardHandler(
          new KeyboardEvent('keydown', { key: '@', altKey: true })
        );
        expect(callbacks.typeIntoComposer).toHaveBeenCalledWith('@');
      });

      it('still sends Esc and Ctrl+C to Claude', () => {
        const callbacks = chatMode();
        manager.mobileHardwareKeyboardHandler(new KeyboardEvent('keydown', { key: 'Escape' }));
        manager.mobileHardwareKeyboardHandler(
          new KeyboardEvent('keydown', { key: 'c', ctrlKey: true })
        );
        expect(callbacks.handleKeyboardInput).toHaveBeenCalledTimes(2);
        expect(callbacks.typeIntoComposer).not.toHaveBeenCalled();
      });

      it("sends Claude Code's send chords to Claude, keys and all (user report, 2026-10-14)", () => {
        const callbacks = chatMode();
        const key = (init: KeyboardEventInit) =>
          manager.mobileHardwareKeyboardHandler(new KeyboardEvent('keydown', init));
        // Ctrl+X Ctrl+S (send now), Ctrl held between the two letters.
        key({ key: 'x', ctrlKey: true });
        key({ key: 'Control', ctrlKey: true });
        key({ key: 's', ctrlKey: true });
        // Ctrl+X Enter (queue).
        key({ key: 'x', ctrlKey: true });
        key({ key: 'Enter' });
        const sent = callbacks.handleKeyboardInput.mock.calls.map(
          ([e]) => (e as KeyboardEvent).key
        );
        expect(sent).toEqual(['x', 'Control', 's', 'x', 'Enter']);
        expect(callbacks.typeIntoComposer).not.toHaveBeenCalled();
        // Not a chord: Enter and Ctrl+S alone stay out of the hidden prompt.
        callbacks.handleKeyboardInput.mockClear();
        key({ key: 'Enter' });
        key({ key: 's', ctrlKey: true });
        key({ key: 'x', ctrlKey: true });
        key({ key: 'a' });
        key({ key: 'Enter' });
        expect(
          callbacks.handleKeyboardInput.mock.calls.map(([e]) => (e as KeyboardEvent).key)
        ).toEqual(['x']);
        expect(callbacks.typeIntoComposer).toHaveBeenCalledWith('a');
      });

      it("types into the composer even from a hidden input of the terminal under Claude's chat", () => {
        // A hidden input of the terminal had the focus under the chat view and took the keys:
        // the message went into Claude's prompt unsent (2026-10-03, SE simulator).
        const callbacks = { ...chatMode(), getChatCoversTerminal: vi.fn().mockReturnValue(true) };
        manager.setCallbacks(partialCallbacks(callbacks));
        const terminal = document.createElement('ut-terminal');
        const input = document.createElement('textarea');
        terminal.appendChild(input);
        document.body.appendChild(terminal);
        try {
          input.addEventListener('keydown', manager.mobileHardwareKeyboardHandler);
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
          expect(callbacks.typeIntoComposer).toHaveBeenCalledWith('a');
          expect(callbacks.handleKeyboardInput).not.toHaveBeenCalled();
        } finally {
          terminal.remove();
        }
      });

      it('leaves keys typed in the terminal itself to the terminal', () => {
        const callbacks = chatMode();
        const terminal = document.createElement('ut-terminal');
        const input = document.createElement('textarea');
        terminal.appendChild(input);
        document.body.appendChild(terminal);
        try {
          input.addEventListener('keydown', manager.mobileHardwareKeyboardHandler);
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
          expect(callbacks.handleKeyboardInput).toHaveBeenCalledTimes(1);
          expect(callbacks.typeIntoComposer).not.toHaveBeenCalled();
        } finally {
          terminal.remove();
        }
      });
    });

    it('leaves mobile keyboard events from editable controls untouched', () => {
      const mockCallbacks = {
        getDisableFocusManagement: vi.fn().mockReturnValue(false),
        getInputManager: vi.fn(),
        handleKeyboardInput: vi.fn(),
      };
      const input = document.createElement('input');
      document.body.appendChild(input);

      manager.setCallbacks(partialCallbacks(mockCallbacks));
      manager.setSession({
        id: 'test-session',
        status: 'running',
      } as Parameters<typeof manager.setSession>[0]);

      try {
        input.addEventListener('keydown', manager.mobileHardwareKeyboardHandler);
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
      } finally {
        input.remove();
      }

      expect(eventUtils.consumeEvent).not.toHaveBeenCalled();
      expect(mockCallbacks.getInputManager).not.toHaveBeenCalled();
      expect(mockCallbacks.handleKeyboardInput).not.toHaveBeenCalled();
    });

    it('routes the mobile file browser shortcut from the hidden keyboard input', () => {
      const mockCallbacks = {
        getDisableFocusManagement: vi.fn().mockReturnValue(false),
        setShowFileBrowser: vi.fn(),
        getInputManager: vi.fn(),
        handleKeyboardInput: vi.fn(),
      };
      const input = document.createElement('input');
      document.body.appendChild(input);

      manager.setCallbacks(partialCallbacks(mockCallbacks));

      try {
        input.addEventListener('keydown', manager.mobileHardwareKeyboardHandler);
        input.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'o',
            metaKey: true,
            bubbles: true,
          })
        );
      } finally {
        input.remove();
      }

      expect(eventUtils.consumeEvent).toHaveBeenCalledTimes(1);
      expect(mockCallbacks.setShowFileBrowser).toHaveBeenCalledWith(true);
      expect(mockCallbacks.getInputManager).not.toHaveBeenCalled();
      expect(mockCallbacks.handleKeyboardInput).not.toHaveBeenCalled();
    });

    it('routes hardware keys from the terminal paste input', () => {
      const mockCallbacks = {
        getDisableFocusManagement: vi.fn().mockReturnValue(false),
        getInputManager: vi.fn().mockReturnValue({
          isKeyboardShortcut: vi.fn().mockReturnValue(false),
        }),
        handleKeyboardInput: vi.fn(),
      };
      const pasteInput = document.createElement('textarea');
      pasteInput.className = 'terminal-paste-input';
      document.body.appendChild(pasteInput);

      manager.setCallbacks(partialCallbacks(mockCallbacks));
      manager.setSession({
        id: 'test-session',
        status: 'running',
      } as Parameters<typeof manager.setSession>[0]);

      try {
        pasteInput.addEventListener('keydown', manager.mobileHardwareKeyboardHandler);
        pasteInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
      } finally {
        pasteInput.remove();
      }

      expect(eventUtils.consumeEvent).toHaveBeenCalledTimes(1);
      expect(mockCallbacks.handleKeyboardInput).toHaveBeenCalledTimes(1);
    });

    it('routes hardware keys from the contenteditable terminal surface', () => {
      const mockCallbacks = {
        getDisableFocusManagement: vi.fn().mockReturnValue(false),
        getInputManager: vi.fn().mockReturnValue({
          isKeyboardShortcut: vi.fn().mockReturnValue(false),
        }),
        handleKeyboardInput: vi.fn(),
      };
      const terminal = document.createElement('ut-terminal');
      const terminalSurface = document.createElement('div');
      terminalSurface.className = 'terminal-container';
      terminalSurface.contentEditable = 'true';
      terminal.appendChild(terminalSurface);
      document.body.appendChild(terminal);

      manager.setCallbacks(partialCallbacks(mockCallbacks));
      manager.setSession({
        id: 'test-session',
        status: 'running',
      } as Parameters<typeof manager.setSession>[0]);

      try {
        terminalSurface.addEventListener('keydown', manager.mobileHardwareKeyboardHandler);
        terminalSurface.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'a', bubbles: true, composed: true })
        );
      } finally {
        terminal.remove();
      }

      expect(eventUtils.consumeEvent).toHaveBeenCalledTimes(1);
      expect(mockCallbacks.handleKeyboardInput).toHaveBeenCalledTimes(1);
    });

    it('routes hardware keys from the terminal renderer textarea', () => {
      const mockCallbacks = {
        getDisableFocusManagement: vi.fn().mockReturnValue(false),
        getInputManager: vi.fn().mockReturnValue({
          isKeyboardShortcut: vi.fn().mockReturnValue(false),
        }),
        handleKeyboardInput: vi.fn(),
      };
      const terminal = document.createElement('ut-terminal');
      const terminalInput = document.createElement('textarea');
      terminalInput.setAttribute('aria-label', 'Terminal input');
      terminal.appendChild(terminalInput);
      document.body.appendChild(terminal);

      manager.setCallbacks(partialCallbacks(mockCallbacks));
      manager.setSession({
        id: 'test-session',
        status: 'running',
      } as Parameters<typeof manager.setSession>[0]);

      try {
        terminalInput.addEventListener('keydown', manager.mobileHardwareKeyboardHandler);
        terminalInput.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'a', bubbles: true, composed: true })
        );
      } finally {
        terminal.remove();
      }

      expect(eventUtils.consumeEvent).toHaveBeenCalledTimes(1);
      expect(mockCallbacks.handleKeyboardInput).toHaveBeenCalledTimes(1);
    });

    it('leaves mobile keyboard events from Shadow DOM editors untouched', () => {
      const mockCallbacks = {
        getDisableFocusManagement: vi.fn().mockReturnValue(false),
        getInputManager: vi.fn(),
        handleKeyboardInput: vi.fn(),
      };
      const inlineEdit = document.createElement('inline-edit');
      const shadowRoot = inlineEdit.attachShadow({ mode: 'open' });
      const input = document.createElement('input');
      shadowRoot.appendChild(input);
      document.body.appendChild(inlineEdit);

      manager.setCallbacks(partialCallbacks(mockCallbacks));
      manager.setSession({
        id: 'test-session',
        status: 'running',
      } as Parameters<typeof manager.setSession>[0]);

      try {
        document.addEventListener('keydown', manager.mobileHardwareKeyboardHandler);
        input.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'a', bubbles: true, composed: true })
        );
      } finally {
        document.removeEventListener('keydown', manager.mobileHardwareKeyboardHandler);
        inlineEdit.remove();
      }

      expect(eventUtils.consumeEvent).not.toHaveBeenCalled();
      expect(mockCallbacks.getInputManager).not.toHaveBeenCalled();
      expect(mockCallbacks.handleKeyboardInput).not.toHaveBeenCalled();
    });

    it('leaves mobile browser shortcuts to the browser', () => {
      const mockCallbacks = {
        getDisableFocusManagement: vi.fn().mockReturnValue(false),
        getInputManager: vi.fn().mockReturnValue({
          isKeyboardShortcut: vi.fn().mockReturnValue(true),
        }),
        handleKeyboardInput: vi.fn(),
      };

      manager.setCallbacks(partialCallbacks(mockCallbacks));
      manager.setSession({
        id: 'test-session',
        status: 'running',
      } as Parameters<typeof manager.setSession>[0]);

      manager.mobileHardwareKeyboardHandler(
        new KeyboardEvent('keydown', { key: 'l', metaKey: true })
      );

      expect(eventUtils.consumeEvent).not.toHaveBeenCalled();
      expect(mockCallbacks.handleKeyboardInput).not.toHaveBeenCalled();
    });

    it('registers and removes the mobile hardware keyboard listener', () => {
      const mockCallbacks = {
        getDisableFocusManagement: vi.fn().mockReturnValue(false),
        getInputManager: vi.fn().mockReturnValue({
          isKeyboardShortcut: vi.fn().mockReturnValue(false),
        }),
        handleKeyboardInput: vi.fn(),
      };
      const lifecycle = manager as unknown as {
        setupEventListeners: (isMobile: boolean) => void;
      };

      manager.setCallbacks(partialCallbacks(mockCallbacks));
      manager.setSession({
        id: 'test-session',
        status: 'running',
      } as Parameters<typeof manager.setSession>[0]);
      lifecycle.setupEventListeners(true);

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
      expect(mockCallbacks.handleKeyboardInput).toHaveBeenCalledTimes(1);

      manager.cleanup();
      vi.clearAllMocks();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));

      expect(mockCallbacks.handleKeyboardInput).not.toHaveBeenCalled();
    });
  });
});

// 2026-10-12: leaving a session gives the PTY back to its window. For forwarded ones this is to be
// dropped once installed ut-fwd builds take the window's size back when it is typed into.
// 2026-10-12: desktop chat mode shows the agent's chat over a hidden terminal. Keys typed on the
// page went into the agent's prompt unseen, and a click on the chat's search gave the focus
// back to the session view at once.
describe('desktop chat mode over the agent chat', () => {
  let manager: LifecycleEventManager;

  beforeEach(() => {
    manager = new LifecycleEventManager();
    vi.clearAllMocks();
  });

  afterEach(() => {
    manager.cleanup();
  });

  const desktopChat = (covers = true) => {
    const callbacks = {
      getDisableFocusManagement: vi.fn().mockReturnValue(false),
      getInputManager: vi.fn().mockReturnValue({
        isKeyboardShortcut: vi.fn().mockReturnValue(false),
      }),
      handleKeyboardInput: vi.fn(),
      getIsMobile: vi.fn().mockReturnValue(false),
      getChatMode: vi.fn().mockReturnValue(true),
      getChatCoversTerminal: vi.fn().mockReturnValue(covers),
      typeIntoComposer: vi.fn().mockReturnValue(true),
    };
    manager.setCallbacks(partialCallbacks(callbacks));
    manager.setSession({
      id: 'test-session',
      status: 'running',
    } as Parameters<typeof manager.setSession>[0]);
    return callbacks;
  };

  it('starts a message in the composer from a key typed on the page', () => {
    const callbacks = desktopChat();
    const key = new KeyboardEvent('keydown', { key: 'h' });
    manager.keyboardHandler(key);
    expect(callbacks.typeIntoComposer).toHaveBeenCalledWith('h');
    expect(eventUtils.consumeEvent).toHaveBeenCalledWith(key);
    expect(callbacks.handleKeyboardInput).not.toHaveBeenCalled();
  });

  it('sends nothing else to the hidden terminal but Esc and Ctrl+C', () => {
    const callbacks = desktopChat();
    manager.keyboardHandler(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
    manager.keyboardHandler(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(callbacks.handleKeyboardInput).not.toHaveBeenCalled();
    manager.keyboardHandler(new KeyboardEvent('keydown', { key: 'Escape' }));
    manager.keyboardHandler(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true }));
    expect(callbacks.handleKeyboardInput).toHaveBeenCalledTimes(2);
  });

  it("sends Claude Code's send chords to the hidden terminal (user report, 2026-10-14)", () => {
    const callbacks = desktopChat();
    manager.keyboardHandler(new KeyboardEvent('keydown', { key: 'x', ctrlKey: true }));
    manager.keyboardHandler(new KeyboardEvent('keydown', { key: 's', ctrlKey: true }));
    manager.keyboardHandler(new KeyboardEvent('keydown', { key: 'x', ctrlKey: true }));
    manager.keyboardHandler(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true }));
    expect(callbacks.handleKeyboardInput).toHaveBeenCalledTimes(4);
    expect(callbacks.typeIntoComposer).not.toHaveBeenCalled();
    // A chord left hanging closes after a while: Enter then stays out of the terminal.
    vi.useFakeTimers();
    try {
      manager.keyboardHandler(new KeyboardEvent('keydown', { key: 'x', ctrlKey: true }));
      vi.advanceTimersByTime(CHORD_MS + 1);
      manager.keyboardHandler(new KeyboardEvent('keydown', { key: 'Enter' }));
      expect(callbacks.handleKeyboardInput).toHaveBeenCalledTimes(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves keys in the chat's own fields and buttons to them", () => {
    const callbacks = desktopChat();
    const field = document.createElement('input');
    document.body.appendChild(field);
    try {
      field.addEventListener('keydown', manager.keyboardHandler);
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', bubbles: true }));
      expect(callbacks.typeIntoComposer).not.toHaveBeenCalled();
      expect(callbacks.handleKeyboardInput).not.toHaveBeenCalled();
    } finally {
      field.remove();
    }
  });

  it('types into the terminal as before for a plain shell', () => {
    const callbacks = desktopChat(false);
    manager.keyboardHandler(new KeyboardEvent('keydown', { key: 'h' }));
    expect(callbacks.typeIntoComposer).not.toHaveBeenCalled();
    expect(callbacks.handleKeyboardInput).toHaveBeenCalled();
  });

  it('does not take the focus from the chat on a click', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const focus = vi.fn();
    const covers = vi.fn().mockReturnValue(true);
    const given: Partial<LifecycleEventManagerCallbacks> = {
      addEventListener: host.addEventListener.bind(host),
      removeEventListener: host.removeEventListener.bind(host),
      getDisableFocusManagement: vi.fn().mockReturnValue(false),
      getIsMobile: vi.fn().mockReturnValue(false),
      getChatCoversTerminal: covers,
      focus,
    };
    // setupLifecycle wires much more; the rest does nothing here.
    const stubs = new Map<PropertyKey, unknown>();
    manager.setCallbacks(
      new Proxy(given, {
        get: (target, key) => {
          if (key in target) return target[key as keyof typeof target];
          if (!stubs.has(key)) stubs.set(key, vi.fn());
          return stubs.get(key);
        },
      }) as LifecycleEventManagerCallbacks
    );
    try {
      manager.setupLifecycle();
      host.click();
      expect(focus).not.toHaveBeenCalled();
      covers.mockReturnValue(false);
      host.click();
      expect(focus).toHaveBeenCalledOnce();
    } finally {
      host.remove();
    }
  });
});

describe('leaving the session view', () => {
  function teardown(id: string) {
    const terminalLifecycleManager = { resetTerminalSize: vi.fn(), cleanup: vi.fn() };
    const manager = new LifecycleEventManager();
    const callbacks = new Proxy({} as Record<string, unknown>, {
      get: (target, name: string) => {
        if (name === 'getTerminalLifecycleManager') return () => terminalLifecycleManager;
        if (name === 'getConnectionManager' || name === 'getDirectKeyboardManager') {
          return () => null;
        }
        target[name] ??= vi.fn();
        return target[name];
      },
    });
    manager.setCallbacks(callbacks as never);
    manager.setSession({ id, status: 'running' } as Parameters<typeof manager.setSession>[0]);
    manager.teardownLifecycle();
    manager.cleanup();
    return terminalLifecycleManager.resetTerminalSize;
  }

  it('gives an external terminal its size back', () => {
    expect(teardown('tmux-1')).toHaveBeenCalledTimes(1);
  });

  it('gives a forwarded session its size back too (until ut-fwd ships the type-to-reclaim)', () => {
    expect(teardown('fwd_1791766226759_57067')).toHaveBeenCalledTimes(1);
  });
});

describe('session swipe (user report: a sideways drag on the quick replies switched sessions)', () => {
  let manager: LifecycleEventManager;
  let switchSession: ReturnType<typeof vi.fn<(direction: 'next' | 'prev') => void>>;

  beforeEach(() => {
    manager = new LifecycleEventManager();
    switchSession = vi.fn<(direction: 'next' | 'prev') => void>();
    manager.setCallbacks(
      partialCallbacks({
        getIsMobile: () => true,
        handleBack: vi.fn(),
        switchSession,
      })
    );
  });

  afterEach(() => {
    manager.cleanup();
    document.body.innerHTML = '';
  });

  const swipe = (target: HTMLElement, from: number, to: number) => {
    const start = new Event('touchstart', { bubbles: true }) as TouchEvent;
    Object.defineProperty(start, 'touches', { value: [{ clientX: from, clientY: 300 }] });
    const path: EventTarget[] = [];
    for (let node: HTMLElement | null = target; node; node = node.parentElement) path.push(node);
    Object.defineProperty(start, 'composedPath', { value: () => path });
    manager.touchStartHandler(start);
    const end = new Event('touchend', { bubbles: true }) as TouchEvent;
    Object.defineProperty(end, 'changedTouches', { value: [{ clientX: to, clientY: 305 }] });
    manager.touchEndHandler(end);
  };

  it('switches on a flick over the conversation', () => {
    const plain = document.createElement('div');
    document.body.append(plain);
    swipe(plain, 300, 100);
    expect(switchSession).toHaveBeenCalledWith('next');
  });

  it('leaves a drag that starts on [data-no-swipe] alone', () => {
    const row = document.createElement('div');
    row.setAttribute('data-no-swipe', '');
    const chip = document.createElement('button');
    row.append(chip);
    document.body.append(row);
    swipe(chip, 300, 100);
    expect(switchSession).not.toHaveBeenCalled();
  });

  it('leaves a slow drag alone', () => {
    vi.useFakeTimers();
    try {
      const plain = document.createElement('div');
      document.body.append(plain);
      const start = new Event('touchstart') as TouchEvent;
      Object.defineProperty(start, 'touches', { value: [{ clientX: 300, clientY: 300 }] });
      manager.touchStartHandler(start);
      vi.advanceTimersByTime(1500);
      const end = new Event('touchend') as TouchEvent;
      Object.defineProperty(end, 'changedTouches', { value: [{ clientX: 100, clientY: 300 }] });
      manager.touchEndHandler(end);
      expect(switchSession).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
