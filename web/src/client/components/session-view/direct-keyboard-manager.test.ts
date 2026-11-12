/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DirectKeyboardManager } from './direct-keyboard-manager';
import type { InputManager } from './input-manager';

describe('DirectKeyboardManager', () => {
  let manager: DirectKeyboardManager;
  let mockInputManager: Pick<
    InputManager,
    'isKeyboardShortcut' | 'sendInput' | 'sendInputText' | 'sendPastedText'
  >;
  let originalRequestAnimationFrame: typeof requestAnimationFrame;

  const getManagerState = () =>
    manager as unknown as {
      hiddenInput: HTMLTextAreaElement | null;
      focusRetentionInterval: number | null;
      keyboardReopenTimeout: ReturnType<typeof setTimeout> | null;
      reopeningKeyboard: boolean;
    };

  beforeEach(() => {
    // Mock requestAnimationFrame
    originalRequestAnimationFrame = global.requestAnimationFrame;
    global.requestAnimationFrame = vi.fn((callback) => {
      // Execute callback immediately in test environment
      setTimeout(callback, 0);
      return 1;
    });

    manager = new DirectKeyboardManager();
    mockInputManager = {
      isKeyboardShortcut: vi.fn().mockReturnValue(false),
      sendInput: vi.fn(),
      sendInputText: vi.fn(),
      sendPastedText: vi.fn(),
    };
    manager.setInputManager(mockInputManager as InputManager);

    // Mock clipboard API using Object.defineProperty
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        readText: vi.fn().mockResolvedValue('clipboard content'),
      },
      writable: true,
      configurable: true,
    });

    // Mock secure context for clipboard API to work
    Object.defineProperty(window, 'isSecureContext', {
      value: true,
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    manager.cleanup();
    vi.useRealTimers();
    // Restore requestAnimationFrame
    global.requestAnimationFrame = originalRequestAnimationFrame;
  });

  it('should handle Paste quick key and send clipboard content', async () => {
    await manager.handleQuickKeyPress('Paste');
    expect(navigator.clipboard.readText).toHaveBeenCalled();
    expect(mockInputManager.sendPastedText).toHaveBeenCalledWith('clipboard content');
  });

  it('sends Return (the server writes \\r) from the ↵ Enter quick key', async () => {
    await manager.handleQuickKeyPress('Enter');
    expect(mockInputManager.sendInput).toHaveBeenCalledWith('enter');
    expect(mockInputManager.sendInputText).not.toHaveBeenCalled();
  });

  it('sends any Ctrl+<char> chord from the sticky Ctrl quick key', async () => {
    const sendControlSequence = vi.fn();
    Object.assign(mockInputManager, { sendControlSequence });

    await manager.handleQuickKeyPress('Ctrl+X');
    await manager.handleQuickKeyPress('Ctrl+[');

    expect(sendControlSequence.mock.calls).toEqual([['\x18'], ['\x1b']]);
    expect(mockInputManager.sendInputText).not.toHaveBeenCalled();
  });

  it("sends Claude Code's send-now chord from its quick key, key by key (user report, 2026-10-14)", async () => {
    vi.useFakeTimers();
    try {
      const sendControlSequence = vi.fn();
      Object.assign(mockInputManager, { sendControlSequence });

      await manager.handleQuickKeyPress('Ctrl+X Ctrl+S');
      await vi.advanceTimersByTimeAsync(100);

      expect(sendControlSequence.mock.calls).toEqual([['\x18'], ['\x13']]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('marks the hidden input so armed quick-key modifiers can catch typed letters', () => {
    expect(getManagerState().hiddenInput?.hasAttribute('data-direct-keyboard-input')).toBe(true);
  });

  it('recreates the hidden input only for an explicit keyboard reopen', () => {
    const originalInput = getManagerState().hiddenInput;
    expect(originalInput).toBeTruthy();

    originalInput?.focus();
    manager.ensureHiddenInputVisible();
    expect(getManagerState().hiddenInput).toBe(originalInput);

    vi.useFakeTimers();
    manager.focusHiddenInput(true);

    expect(getManagerState().hiddenInput).not.toBe(originalInput);
    expect(getManagerState().reopeningKeyboard).toBe(true);
    expect(getManagerState().focusRetentionInterval).toBeNull();

    vi.advanceTimersByTime(500);

    expect(getManagerState().reopeningKeyboard).toBe(false);
    expect(getManagerState().focusRetentionInterval).not.toBeNull();
  });

  it('restarts the reopen window after repeated TAP presses', () => {
    vi.useFakeTimers();

    manager.focusHiddenInput(true);
    vi.advanceTimersByTime(400);
    manager.focusHiddenInput(true);
    vi.advanceTimersByTime(100);

    expect(getManagerState().reopeningKeyboard).toBe(true);
    expect(getManagerState().focusRetentionInterval).toBeNull();

    vi.advanceTimersByTime(400);

    expect(getManagerState().reopeningKeyboard).toBe(false);
    expect(getManagerState().focusRetentionInterval).not.toBeNull();
  });

  it('keeps a single focus-retention interval however often it is restarted (2026-11-10 leak)', () => {
    vi.useFakeTimers();
    const baseline = vi.getTimerCount();

    manager.startFocusRetentionPublic();
    manager.startFocusRetentionPublic();
    manager.startFocusRetentionPublic();

    // Each restart used to leave the previous 100 ms interval running for good.
    expect(vi.getTimerCount() - baseline).toBe(1);

    manager.cleanup();
    expect(getManagerState().focusRetentionInterval).toBeNull();
    expect(vi.getTimerCount()).toBe(baseline);
  });

  it('cancels a pending keyboard reopen during cleanup', () => {
    vi.useFakeTimers();

    manager.focusHiddenInput(true);
    manager.cleanup();
    vi.runAllTimers();

    expect(getManagerState().hiddenInput).toBeNull();
    expect(getManagerState().keyboardReopenTimeout).toBeNull();
    expect(getManagerState().reopeningKeyboard).toBe(false);
    expect(getManagerState().focusRetentionInterval).toBeNull();
  });

  describe('when the hidden input loses focus in keyboard mode', () => {
    const enterKeyboardMode = () => {
      const updateShowQuickKeys = vi.fn();
      const callbacks = new Proxy(
        { updateShowQuickKeys, getChatMode: () => false, getKeyboardHeight: () => 0 },
        { get: (target, key) => (target as Record<string, unknown>)[key as string] ?? vi.fn() }
      );
      manager.setCallbacks(callbacks as never);
      vi.useFakeTimers();
      manager.focusHiddenInput();
      vi.advanceTimersByTime(200);
      return { input: getManagerState().hiddenInput as HTMLTextAreaElement, updateShowQuickKeys };
    };

    it('leaves keyboard mode when iOS closed the keyboard without a tap in the page', () => {
      const { input, updateShowQuickKeys } = enterKeyboardMode();
      vi.advanceTimersByTime(1000);

      input.dispatchEvent(new FocusEvent('blur'));
      vi.advanceTimersByTime(500);

      expect(manager.getKeyboardMode()).toBe(false);
      expect(updateShowQuickKeys).toHaveBeenLastCalledWith(false);
      expect(getManagerState().focusRetentionInterval).toBeNull();
    });

    it('leaves keyboard mode when another text field takes focus', () => {
      const { input } = enterKeyboardMode();
      const composer = document.createElement('textarea');
      document.body.appendChild(composer);
      document.dispatchEvent(new Event('touchstart'));

      input.dispatchEvent(new FocusEvent('blur', { relatedTarget: composer }));

      expect(manager.getKeyboardMode()).toBe(false);
      composer.remove();
    });

    it('leaves keyboard mode when focus moves into a field inside a shadow root', () => {
      const { input } = enterKeyboardMode();
      const host = document.createElement('div');
      const composer = document.createElement('textarea');
      host.attachShadow({ mode: 'open' }).appendChild(composer);
      document.body.appendChild(host);
      document.dispatchEvent(new Event('touchstart'));

      // As in a browser: the blur names no field (the composer sits behind its host), and focus
      // lands inside the shadow root.
      input.blur();
      composer.focus();
      vi.advanceTimersByTime(100);

      expect(manager.getKeyboardMode()).toBe(false);
      host.remove();
    });

    it('keeps keyboard mode when a tap in the page moved focus', () => {
      const { input } = enterKeyboardMode();
      document.dispatchEvent(new Event('touchstart'));

      input.dispatchEvent(new FocusEvent('blur'));
      vi.advanceTimersByTime(100);

      expect(manager.getKeyboardMode()).toBe(true);
    });
  });

  it.each([
    [' h', 'h'],
    ['h ', 'h'],
    ['hello world ', 'hello world'],
    [' /', '/'],
    [' /help', '/help'],
  ])('removes the placeholder space from %j', (inputValue, expected) => {
    const hiddenInput = getManagerState().hiddenInput;
    expect(hiddenInput).toBeTruthy();

    if (!hiddenInput) {
      return;
    }

    hiddenInput.value = inputValue;
    hiddenInput.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));

    expect(mockInputManager.sendInputText).toHaveBeenCalledWith(expected);
  });

  it('sends only the newly typed characters when typing outpaces the placeholder reset', () => {
    const hiddenInput = getManagerState().hiddenInput;
    expect(hiddenInput).toBeTruthy();
    if (!hiddenInput) return;

    // Fast typing: the value keeps accumulating because the reset to the placeholder only
    // happens on the next animation frame.
    for (const [value, data] of [
      [' c', 'c'],
      [' cu', 'u'],
      [' cue', 'e'],
    ]) {
      hiddenInput.value = value;
      hiddenInput.dispatchEvent(
        new InputEvent('input', { bubbles: true, inputType: 'insertText', data })
      );
    }

    expect(vi.mocked(mockInputManager.sendInputText).mock.calls).toEqual([['c'], ['u'], ['e']]);
  });

  it('keeps deleting when a held backspace moves on to words (iOS) or the line', async () => {
    const hiddenInput = getManagerState().hiddenInput;
    expect(hiddenInput).toBeTruthy();
    if (!hiddenInput) return;
    hiddenInput.focus();

    const del = async (inputType: string) => {
      hiddenInput.value = '';
      hiddenInput.dispatchEvent(new InputEvent('input', { bubbles: true, inputType }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      // The placeholder is back: iOS has something to delete and keeps repeating.
      expect(hiddenInput.value).toBe(' ');
    };

    await del('deleteContentBackward');
    await del('deleteWordBackward');
    await del('deleteWordBackward');
    await del('deleteSoftLineBackward');
    expect(vi.mocked(mockInputManager.sendInput).mock.calls).toEqual([
      ['backspace'],
      ['\x17'],
      ['\x17'],
      ['\x15'],
    ]);

    // Any other edit that empties the field gets the placeholder back too.
    hiddenInput.value = '';
    hiddenInput.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteByCut' }));
    expect(hiddenInput.value).toBe(' ');
  });

  it('sends Escape without bubbling to app navigation', () => {
    const hiddenInput = getManagerState().hiddenInput;
    expect(hiddenInput).toBeTruthy();

    const documentKeydown = vi.fn();
    document.addEventListener('keydown', documentKeydown);

    try {
      const escapeEvent = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      hiddenInput?.dispatchEvent(escapeEvent);

      expect(escapeEvent.defaultPrevented).toBe(true);
      expect(mockInputManager.sendInput).toHaveBeenCalledWith('escape');
      expect(documentKeydown).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', documentKeydown);
    }
  });

  it.each([
    ['Enter', false, 'enter'],
    ['Tab', false, 'tab'],
    ['Tab', true, 'shift_tab'],
    ['Escape', false, 'escape'],
    ['ArrowUp', false, 'arrow_up'],
    ['ArrowDown', false, 'arrow_down'],
    ['ArrowLeft', false, 'arrow_left'],
    ['ArrowRight', false, 'arrow_right'],
    ['PageUp', false, 'page_up'],
    ['PageDown', false, 'page_down'],
    ['Home', false, 'home'],
    ['End', false, 'end'],
    ['Delete', false, 'delete'],
  ])('routes hardware %s from the hidden input', (key, shiftKey, expected) => {
    const hiddenInput = getManagerState().hiddenInput;
    const keyEvent = new KeyboardEvent('keydown', {
      key,
      shiftKey,
      bubbles: true,
      cancelable: true,
    });

    hiddenInput?.dispatchEvent(keyEvent);

    expect(keyEvent.defaultPrevented).toBe(true);
    expect(mockInputManager.sendInput).toHaveBeenCalledWith(expected);
  });

  it.each([
    ['b', false],
    ['k', false],
    [',', false],
    ['3', false],
    ['{', true],
  ])(
    'lets the app shortcut ⌘%s bubble from the hidden input (never to the PTY)',
    (key, shiftKey) => {
      Object.defineProperty(navigator, 'platform', { writable: true, value: 'MacIntel' });
      const hiddenInput = getManagerState().hiddenInput;
      const keyEvent = new KeyboardEvent('keydown', {
        key,
        metaKey: true,
        shiftKey,
        bubbles: true,
        cancelable: true,
      });
      const bubbled = vi.fn();
      document.addEventListener('keydown', bubbled);
      try {
        hiddenInput?.dispatchEvent(keyEvent);
      } finally {
        document.removeEventListener('keydown', bubbled);
      }

      expect(keyEvent.defaultPrevented).toBe(false);
      expect(bubbled).toHaveBeenCalledTimes(1);
      expect(mockInputManager.sendInput).not.toHaveBeenCalled();
    }
  );

  it('preserves browser shortcuts from the hidden input', () => {
    const hiddenInput = getManagerState().hiddenInput;
    vi.mocked(mockInputManager.isKeyboardShortcut).mockReturnValueOnce(true);
    const keyEvent = new KeyboardEvent('keydown', {
      key: 'ArrowLeft',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });

    hiddenInput?.dispatchEvent(keyEvent);

    expect(keyEvent.defaultPrevented).toBe(false);
    expect(mockInputManager.sendInput).not.toHaveBeenCalled();
  });
  it('keeps its input out of iOS reach while the chat view covers the terminal', () => {
    // 2026-10-04: with the chat composer focused, iOS offered ↑ ↓ arrows to this invisible
    // input (owner's iPhone): it must be neither focusable nor a field iOS can move to.
    const input = () => getManagerState().hiddenInput as HTMLTextAreaElement;
    input().focus();
    expect(document.activeElement).toBe(input());

    manager.setUnreachable(true);
    expect(document.activeElement).not.toBe(input());
    expect(input().inert).toBe(true);
    expect(input().disabled).toBe(true);

    // Recreated (the keyboard button recreates it): still out of reach.
    manager.focusHiddenInput(true);
    expect(input().inert).toBe(true);
    expect(input().disabled).toBe(true);
    expect(document.activeElement).not.toBe(input());
    manager.exitKeyboardMode();

    // The terminal shows again: the direct keyboard works as before.
    manager.setUnreachable(false);
    expect(input().inert).toBe(false);
    expect(input().disabled).toBe(false);
    manager.focusHiddenInput(true);
    expect(document.activeElement).toBe(input());
  });
});
