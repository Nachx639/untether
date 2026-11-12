// @vitest-environment happy-dom

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { fetchCallsTo } from '../../test/utils/component-helpers.js';
import type { SentChatMessage, SentChatMessageRef } from './claude-chat-view.js';
import { TerminalChatView } from './terminal-chat-view.js';

describe('TerminalChatView', () => {
  let component: TerminalChatView;

  beforeEach(async () => {
    component = new TerminalChatView();
    document.body.append(component);
    await component.updateComplete;
  });

  afterEach(() => {
    component.remove();
    vi.useRealTimers();
  });

  it('enables native autocorrect for its delta-reconciling input', () => {
    const input = component.shadowRoot?.querySelector<HTMLInputElement>('#chat-input-field');

    expect(input?.getAttribute('autocorrect')).toBe('on');
    expect(input?.getAttribute('spellcheck')).toBe('false');
    expect(input?.getAttribute('autocapitalize')).toBe('off');
  });

  it('opens a conversation at its latest message without animating down to it', async () => {
    const container = component.shadowRoot?.querySelector<HTMLElement>('.chat-messages-container');
    expect(container).not.toBeNull();
    // A smooth scroll-behavior turned the first scroll to the bottom into a ride through the
    // whole conversation (2026-10-04).
    expect(container && getComputedStyle(container).scrollBehavior).not.toBe('smooth');
    const styles = TerminalChatView.styles as unknown as Array<{ cssText: string }>;
    expect(styles.map((sheet) => sheet.cssText).join('')).not.toMatch(/scroll-behavior:\s*smooth/);
  });

  it('reconciles a corrected word with terminal backspaces', () => {
    const onSend = vi.fn();
    component.onSend = onSend;
    const input = component.shadowRoot?.querySelector<HTMLInputElement>('#chat-input-field');
    expect(input).not.toBeNull();

    if (!input) return;
    input.value = 'git chek';
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    input.value = 'git check';
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));

    expect(onSend).toHaveBeenNthCalledWith(1, 'git chek');
    expect(onSend).toHaveBeenNthCalledWith(2, '\x7fck');
  });

  it('preserves identical repeated output lines', () => {
    const testComponent = component as unknown as {
      processTerminalOutput(data: string): void;
      messages: Array<{ content: string }>;
    };

    testComponent.processTerminalOutput('same line\nsame line\n');

    expect(testComponent.messages).toHaveLength(1);
    expect(testComponent.messages[0].content).toBe('same line\nsame line');
  });

  it('joins output chunks into lines and drops the echo of the sent command', () => {
    vi.useFakeTimers();
    try {
      const testComponent = component as unknown as {
        processTerminalOutput(data: string): void;
        messages: Array<{ type: string; content: string }>;
      };
      testComponent.messages = [
        { type: 'command', content: 'echo hola', timestamp: new Date(), id: 'c1' },
      ] as never;

      for (const chunk of ['bash-3.2$ e', 'c', 'h', 'o', ' h', 'ol', 'a\r\n', 'ho', 'la\r\n'])
        testComponent.processTerminalOutput(chunk);
      testComponent.processTerminalOutput('bash-3.2$ ');
      vi.advanceTimersByTime(500);

      const output = testComponent.messages.filter((m) => m.type !== 'command');
      expect(output).toHaveLength(1);
      expect(output[0].content).toBe('hola');
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows an unterminated line after a short idle and completes it in place', () => {
    vi.useFakeTimers();
    try {
      const testComponent = component as unknown as {
        processTerminalOutput(data: string): void;
        messages: Array<{ content: string }>;
      };
      testComponent.processTerminalOutput('Downloading');
      expect(testComponent.messages).toHaveLength(0);
      vi.advanceTimersByTime(200);
      expect(testComponent.messages[0].content).toBe('Downloading');
      testComponent.processTerminalOutput(' done\n');
      expect(testComponent.messages).toHaveLength(1);
      expect(testComponent.messages[0].content).toBe('Downloading done');
    } finally {
      vi.useRealTimers();
    }
  });

  it('replaces the terminal output subscription when its source changes', async () => {
    const firstUnsubscribe = vi.fn();
    const secondUnsubscribe = vi.fn();
    const firstSubscribe = vi.fn(() => firstUnsubscribe);
    const secondSubscribe = vi.fn(() => secondUnsubscribe);

    component.active = true;
    component.subscribeToOutput = firstSubscribe;
    await component.updateComplete;
    component.subscribeToOutput = secondSubscribe;
    await component.updateComplete;

    expect(firstSubscribe).toHaveBeenCalledOnce();
    expect(firstUnsubscribe).toHaveBeenCalledOnce();
    expect(secondSubscribe).toHaveBeenCalledOnce();

    component.remove();
    expect(secondUnsubscribe).toHaveBeenCalledOnce();
  });

  it('only listens to terminal output while chat mode is active', async () => {
    const unsubscribe = vi.fn();
    const subscribe = vi.fn(() => unsubscribe);
    component.subscribeToOutput = subscribe;
    await component.updateComplete;

    expect(subscribe).not.toHaveBeenCalled();

    component.active = true;
    await component.updateComplete;
    expect(subscribe).toHaveBeenCalledOnce();

    component.active = false;
    await component.updateComplete;
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('keeps only the tail of very long output in a message', () => {
    const testComponent = component as unknown as {
      processTerminalOutput(data: string): void;
      messages: Array<{ content: string }>;
    };

    for (let i = 0; i < 3000; i++)
      testComponent.processTerminalOutput(`line ${i} ${'x'.repeat(20)}\n`);

    expect(testComponent.messages).toHaveLength(1);
    expect(testComponent.messages[0].content.length).toBeLessThanOrEqual(20_000);
    expect(testComponent.messages[0].content.endsWith(`line 2999 ${'x'.repeat(20)}`)).toBe(true);
  });

  it('renders only the input bar and ignores output as a composer', async () => {
    const subscribe = vi.fn(() => vi.fn());
    component.composerOnly = true;
    component.subscribeToOutput = subscribe;
    component.active = true;
    await component.updateComplete;

    expect(component.shadowRoot?.querySelector('.chat-messages-container')).toBeNull();
    expect(component.shadowRoot?.querySelector('#chat-input-field')).not.toBeNull();
    expect(subscribe).not.toHaveBeenCalled();
  });

  // 2026-10-12 (user report, iPhone): a tap in the middle of the text has to leave the caret there.
  // The composer's text is never a Lit binding, so nothing the composer renders puts it back
  // at the end: not typing (the send button replaces the mic), not a state change.
  it('keeps the caret where it was put while the composer renders again', async () => {
    component.composerOnly = true;
    component.active = true;
    await component.updateComplete;
    const input = component.shadowRoot?.querySelector<HTMLTextAreaElement>('#chat-input-field');
    if (!input) throw new Error('composer not rendered');

    input.value = 'hola que tal estas';
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    await component.updateComplete;
    input.focus();
    input.setSelectionRange(5, 5);
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    component.requestUpdate();
    await component.updateComplete;
    component.ptyCols = 50;
    await component.updateComplete;

    expect(input.value).toBe('hola que tal estas');
    expect([input.selectionStart, input.selectionEnd]).toEqual([5, 5]);
    expect(component.shadowRoot?.querySelector('#chat-input-field')).toBe(input);
  });

  it("never cancels a touch on the composer's text (iOS places the caret from it)", async () => {
    component.composerOnly = true;
    component.active = true;
    await component.updateComplete;
    const input = component.shadowRoot?.querySelector<HTMLTextAreaElement>('#chat-input-field');
    if (!input) throw new Error('composer not rendered');
    const events = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click'].map((type) => {
      const init = { bubbles: true, cancelable: true, composed: true };
      const event = type.startsWith('pointer')
        ? new PointerEvent(type, { ...init, pointerType: 'touch' })
        : new MouseEvent(type, init);
      input.dispatchEvent(event);
      return [type, event.defaultPrevented];
    });
    expect(events.filter(([, prevented]) => prevented)).toEqual([]);
  });

  it('suggests Claude Code slash commands in the composer', async () => {
    component.composerOnly = true;
    component.active = true;
    await component.updateComplete;
    const input = component.shadowRoot?.querySelector<HTMLTextAreaElement>('#chat-input-field');
    if (!input) throw new Error('composer not rendered');

    input.value = '/co';
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    await component.updateComplete;
    const options = [...(component.shadowRoot?.querySelectorAll('.slash-list strong') ?? [])].map(
      (el) => el.textContent
    );
    expect(options).toEqual(['/compact', '/context', '/cost', '/config']);

    component.shadowRoot?.querySelector<HTMLButtonElement>('.slash-list button')?.click();
    await component.updateComplete;
    expect(input.value).toBe('/compact ');
    expect(component.shadowRoot?.querySelector('.slash-list')).toBeNull();
  });

  // WebKit sends no click for a touch whose pointerdown was cancelled (2026-10-12, iPhone QA):
  // these buttons must act on the touch's pointerup alone.
  describe('touch taps that bring no click', () => {
    const touchOnly = (el: Element) => {
      el.dispatchEvent(
        new PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true, cancelable: true })
      );
      el.dispatchEvent(new Event('touchstart', { bubbles: true }));
      el.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch', bubbles: true }));
      el.dispatchEvent(new Event('touchend', { bubbles: true }));
    };
    const q = <T extends Element>(selector: string) => {
      const found = component.shadowRoot?.querySelector<T>(selector);
      if (!found) throw new Error(`no ${selector}`);
      return found;
    };

    beforeEach(async () => {
      component.composerOnly = true;
      component.active = true;
      await component.updateComplete;
    });

    it('the + button opens its sheet', async () => {
      touchOnly(q('[data-testid="composer-plus"]'));
      await component.updateComplete;
      expect(q('[data-testid="composer-plus"]').getAttribute('aria-expanded')).toBe('true');
    });

    it('the Enter button sends a bare Enter, once even when a click follows', async () => {
      const onSend = vi.fn();
      component.onSend = onSend;
      await component.updateComplete;
      const enter = q<HTMLButtonElement>('[data-testid="chat-enter-button"]');
      touchOnly(enter);
      enter.click();
      expect(onSend).toHaveBeenCalledTimes(1);
      expect(onSend).toHaveBeenCalledWith('\r');
    });

    it('a slash command is picked', async () => {
      const input = q<HTMLTextAreaElement>('#chat-input-field');
      input.value = '/co';
      input.dispatchEvent(new InputEvent('input', { bubbles: true }));
      await component.updateComplete;
      touchOnly(q('.slash-list button'));
      await component.updateComplete;
      expect(input.value).toBe('/compact ');
    });
  });

  it('keeps a slim row of quick replies over the field with the keyboard up (portrait)', async () => {
    component.composerOnly = true;
    component.claudeSession = true;
    component.compactChrome = true;
    await component.updateComplete;
    expect(component.shadowRoot?.querySelector('.quick-prompts')).toBeNull();
    document.documentElement.setAttribute('data-keyboard-visible', 'true');
    try {
      await vi.waitFor(() =>
        expect(component.shadowRoot?.querySelector('.quick-prompts.slim')).not.toBeNull()
      );
      // On its side the row stays behind the composer's button.
      component.landscape = true;
      await component.updateComplete;
      expect(component.shadowRoot?.querySelector('.quick-prompts')).toBeNull();
    } finally {
      document.documentElement.removeAttribute('data-keyboard-visible');
    }
  });

  it('suggests Codex slash commands in a Codex session', async () => {
    component.composerOnly = true;
    component.active = true;
    component.agent = 'codex';
    await component.updateComplete;
    const input = component.shadowRoot?.querySelector<HTMLTextAreaElement>('#chat-input-field');
    if (!input) throw new Error('composer not rendered');

    input.value = '/';
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    await component.updateComplete;
    const options = [...(component.shadowRoot?.querySelectorAll('.slash-list strong') ?? [])].map(
      (el) => el.textContent
    );
    expect(options).toEqual(['/new', '/compact', '/model', '/approvals', '/review', '/diff']);
  });

  it('suggests Gemini slash commands in a Gemini session', async () => {
    component.composerOnly = true;
    component.active = true;
    component.agent = 'gemini';
    await component.updateComplete;
    const input = component.shadowRoot?.querySelector<HTMLTextAreaElement>('#chat-input-field');
    if (!input) throw new Error('composer not rendered');

    input.value = '/c';
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    await component.updateComplete;
    const options = [...(component.shadowRoot?.querySelectorAll('.slash-list strong') ?? [])].map(
      (el) => el.textContent
    );
    expect(options).toEqual(['/clear', '/compress', '/chat']);
  });

  it('keeps IME confirmations and other sessions out of a composer send', async () => {
    const onSend = vi.fn();
    component.onSend = onSend;
    component.composerOnly = true;
    component.sessionId = 'a';
    component.active = true;
    await component.updateComplete;
    const input = component.shadowRoot?.querySelector<HTMLTextAreaElement>('#chat-input-field');
    if (!input) throw new Error('composer not rendered');

    input.value = 'にほん';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true }));
    expect(onSend).not.toHaveBeenCalled();
    expect(input.value).toBe('にほん');

    component.sessionId = 'b';
    await component.updateComplete;
    expect(input.value).toBe('');
  });

  it('keeps each session its own unsent draft and forgets it once sent', async () => {
    const stored = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
      removeItem: (key: string) => stored.delete(key),
    });
    const onSend = vi.fn();
    component.onSend = onSend;
    component.composerOnly = true;
    component.sessionId = 'draft-a';
    component.active = true;
    await component.updateComplete;
    const input = component.shadowRoot?.querySelector<HTMLTextAreaElement>('#chat-input-field');
    if (!input) throw new Error('composer not rendered');

    input.value = 'half a thought';
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    component.sessionId = 'draft-b';
    await component.updateComplete;
    expect(input.value).toBe('');

    component.sessionId = 'draft-a';
    await component.updateComplete;
    expect(input.value).toBe('half a thought');

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    component.sessionId = 'draft-b';
    await component.updateComplete;
    component.sessionId = 'draft-a';
    await component.updateComplete;
    expect(onSend).toHaveBeenCalledWith('half a thought');
    expect(input.value).toBe('');
    vi.unstubAllGlobals();
  });

  it('tells the chat view about a message the moment it is sent, before typing it', async () => {
    vi.useFakeTimers();
    const onSend = vi.fn();
    component.onSend = onSend;
    component.composerOnly = true;
    component.active = true;
    component.sessionId = 's1';
    await component.updateComplete;
    const sent = vi.fn();
    component.addEventListener('chat-message-sent', (e) => sent((e as CustomEvent).detail));
    const input = component.shadowRoot?.querySelector<HTMLTextAreaElement>('#chat-input-field');
    if (!input) throw new Error('composer not rendered');

    input.value = 'arregla el login';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(sent).toHaveBeenCalledOnce();
    expect(sent.mock.calls[0][0]).toEqual({
      sessionId: 's1',
      id: expect.any(String),
      text: 'arregla el login',
      at: expect.any(Number),
      startedAt: expect.any(Number),
    });
    // Its Enter is still to come.
    expect(onSend.mock.calls).toEqual([['arregla el login']]);
    await vi.advanceTimersByTimeAsync(100);
    expect(onSend.mock.calls).toEqual([['arregla el login'], ['\r']]);
  });

  describe("Claude Code's send chords (user report, 2026-10-14)", () => {
    let onSend: Mock;
    let input: HTMLTextAreaElement;
    const key = (init: KeyboardEventInit) =>
      input.dispatchEvent(new KeyboardEvent('keydown', { cancelable: true, ...init }));

    beforeEach(async () => {
      vi.useFakeTimers();
      onSend = vi.fn();
      component.onSend = onSend;
      component.composerOnly = true;
      component.claudeSession = true;
      component.active = true;
      component.sessionId = 's1';
      await component.updateComplete;
      const found = component.shadowRoot?.querySelector<HTMLTextAreaElement>('#chat-input-field');
      if (!found) throw new Error('composer not rendered');
      input = found;
    });

    it('Ctrl+X Ctrl+S in the box types the message and sends it now', async () => {
      input.value = 'para y mira esto';
      key({ key: 'x', ctrlKey: true });
      key({ key: 'Control', ctrlKey: true });
      key({ key: 's', ctrlKey: true });
      await vi.advanceTimersByTimeAsync(200);
      expect(onSend.mock.calls).toEqual([['para y mira esto'], ['\x18'], ['\x13']]);
      expect(input.value).toBe('');
    });

    it('Ctrl+X Enter queues it', async () => {
      input.value = 'luego esto';
      key({ key: 'x', ctrlKey: true });
      key({ key: 'Enter' });
      await vi.advanceTimersByTimeAsync(200);
      expect(onSend.mock.calls).toEqual([['luego esto'], ['\x18'], ['\r']]);
    });

    it('with nothing in the box, the chord goes alone (sends what Claude queued)', async () => {
      key({ key: 'x', ctrlKey: true });
      key({ key: 's', ctrlKey: true });
      await vi.advanceTimersByTimeAsync(200);
      expect(onSend.mock.calls).toEqual([['\x18'], ['\x13']]);
    });

    it('Ctrl+S alone, or long after Ctrl+X, sends nothing; Enter stays a plain send', async () => {
      key({ key: 's', ctrlKey: true });
      key({ key: 'x', ctrlKey: true });
      await vi.advanceTimersByTimeAsync(5000);
      key({ key: 's', ctrlKey: true });
      await vi.advanceTimersByTimeAsync(200);
      expect(onSend).not.toHaveBeenCalled();
      input.value = 'hola';
      key({ key: 'Enter' });
      await vi.advanceTimersByTimeAsync(200);
      expect(onSend.mock.calls).toEqual([['hola'], ['\r']]);
    });

    it('the + sheet offers them on a phone, which has no Ctrl key here', async () => {
      const q = (selector: string) =>
        component.shadowRoot?.querySelector<HTMLButtonElement>(selector) ?? null;
      q('[data-testid="composer-plus"]')?.click();
      await component.updateComplete;
      expect(q('#composer-queue-send')).toBeNull();
      q('#composer-send-now')?.click();
      await vi.advanceTimersByTimeAsync(200);
      expect(onSend.mock.calls).toEqual([['\x18'], ['\x13']]);

      onSend.mockClear();
      input.value = 'cuando acabes';
      input.dispatchEvent(new InputEvent('input', { bubbles: true }));
      q('[data-testid="composer-plus"]')?.click();
      await component.updateComplete;
      q('#composer-queue-send')?.click();
      await vi.advanceTimersByTimeAsync(200);
      expect(onSend.mock.calls).toEqual([['cuando acabes'], ['\x18'], ['\r']]);
    });

    it('not for a plain shell', async () => {
      component.claudeSession = false;
      await component.updateComplete;
      component.shadowRoot
        ?.querySelector<HTMLButtonElement>('[data-testid="composer-plus"]')
        ?.click();
      await component.updateComplete;
      expect(component.shadowRoot?.querySelector('#composer-send-now')).toBeNull();
    });
  });

  it('dictates into the composer in the phone language, after what was typed', async () => {
    const instances: Array<Record<string, unknown> & { start: ReturnType<typeof vi.fn> }> = [];
    class FakeRecognition {
      lang = '';
      interimResults = false;
      continuous = false;
      onresult: ((event: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      start = vi.fn();
      stop = vi.fn(() => this.onend?.());
      abort = vi.fn();
      constructor() {
        instances.push(this as never);
      }
    }
    vi.stubGlobal('webkitSpeechRecognition', FakeRecognition);
    Object.defineProperty(navigator, 'language', { value: 'es-ES', configurable: true });
    component.composerOnly = true;
    component.active = true;
    await component.updateComplete;
    const input = component.shadowRoot?.querySelector<HTMLTextAreaElement>('#chat-input-field');
    if (!input) throw new Error('composer not rendered');
    input.value = 'arregla';

    const mic = () =>
      component.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="dictate-button"]');
    mic()?.click();
    const recognition = instances[0] as unknown as FakeRecognition;
    expect(recognition.lang).toBe('es-ES');
    expect(recognition.start).toHaveBeenCalled();
    recognition.onresult?.({
      results: [[{ transcript: ' el login' }], [{ transcript: ' por favor' }]],
    });
    expect(input.value).toBe('arregla el login por favor');

    await component.updateComplete;
    mic()?.click();
    expect(recognition.stop).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('cancels delayed terminal sync when chat mode is deactivated', async () => {
    vi.useFakeTimers();
    const getTerminalInputLine = vi.fn(() => '');
    component.getTerminalInputLine = getTerminalInputLine;
    component.active = true;
    await component.updateComplete;

    const callsBeforeDeactivation = getTerminalInputLine.mock.calls.length;
    component.active = false;
    await component.updateComplete;
    await vi.advanceTimersByTimeAsync(500);

    expect(getTerminalInputLine).toHaveBeenCalledTimes(callsBeforeDeactivation);
  });
  it("takes a hardware key's character when nothing had the focus, and the focus with it", async () => {
    component.composerOnly = true;
    component.active = true;
    component.sessionId = 's1';
    await component.updateComplete;
    expect(component.typeFromKeyboard('h')).toBe(true);
    component.typeFromKeyboard('i');
    const input = component.shadowRoot?.querySelector<HTMLTextAreaElement>('#chat-input-field');
    expect(input?.value).toBe('hi');
    expect(component.shadowRoot?.activeElement).toBe(input);
  });

  it('writes the keys that follow until they pause, which iOS would drop meanwhile', async () => {
    // "Responde" typed with nothing focused reached the composer as "RE" (2026-10-03, SE).
    vi.useFakeTimers();
    component.composerOnly = true;
    component.active = true;
    component.sessionId = 's1';
    await component.updateComplete;
    const input = component.shadowRoot?.querySelector<HTMLTextAreaElement>('#chat-input-field');
    if (!input) throw new Error('no composer');
    const key = (k: string, init: KeyboardEventInit = {}) => {
      const event = new KeyboardEvent('keydown', {
        key: k,
        bubbles: true,
        cancelable: true,
        ...init,
      });
      input.dispatchEvent(event);
      return event.defaultPrevented;
    };
    component.typeFromKeyboard('R');
    for (const k of 'esx') expect(key(k)).toBe(true);
    expect(key('Backspace')).toBe(true);
    expect(input.value).toBe('Res');
    // Option makes characters ("@" on a Spanish layout); Cmd makes shortcuts.
    expect(key('@', { altKey: true })).toBe(true);
    expect(key('a', { metaKey: true })).toBe(false);
    expect(key('Backspace')).toBe(true);
    expect(input.value).toBe('Res');
    await vi.advanceTimersByTimeAsync(1500);
    expect(key('p')).toBe(true);
    expect(input.value).toBe('Resp');
    // A pause: iOS writes again, the composer leaves it.
    await vi.advanceTimersByTimeAsync(2500);
    expect(key('o')).toBe(false);
    expect(input.value).toBe('Resp');
    vi.useRealTimers();
  });

  describe('a menu on screen that typing cannot answer', () => {
    const trustFolder = readFileSync(
      path.join(__dirname, '../../server/services/__fixtures__/claude-waiting/trust-folder.txt'),
      'utf8'
    );
    const options = () => [
      ...(component.shadowRoot?.querySelectorAll<HTMLButtonElement>('.screen-menu-option') ?? []),
    ];
    const show = async (screen: string) => {
      component.getScreenText = () => screen;
      component.composerOnly = true;
      component.active = true;
      component.sessionId = 's1';
      await component.updateComplete;
      await vi.advanceTimersByTimeAsync(800);
      await component.updateComplete;
    };

    beforeEach(() => {
      vi.useFakeTimers();
      component.claudeSession = true;
    });
    afterEach(() => vi.unstubAllGlobals());

    const labels = () => options().map((el) => el.querySelector('.pd-label')?.textContent?.trim());

    it('offers its options instead of the quick prompts', async () => {
      await show(trustFolder);
      // The chat's prompt anatomy (phone-spec §3.6): numbered rows, option 1 the primary, the
      // question in the app's language; an answer still sends Claude's own option.
      expect(labels()).toEqual(['No, exit', 'Yes, I trust this folder']);
      expect(options().map((el) => el.querySelector('.pd-num')?.textContent)).toEqual(['1', '2']);
      expect(options()[0].classList.contains('primary')).toBe(true);
      expect(options()[0].title).toBe('No, exit');
      expect(component.shadowRoot?.querySelector('.screen-menu-question')?.textContent).toBe(
        'Trust this folder?'
      );
      expect(component.shadowRoot?.querySelector('.pd-eyebrow')?.textContent).toContain(
        'Claude needs you'
      );
      expect(component.shadowRoot?.querySelectorAll('.quick-prompt')).toHaveLength(0);
    });

    it('shows a menu only once a second read confirms it (user report: a card flashed)', async () => {
      // One read finds the menu, the quick re-read does not: a state the buffer passed
      // through, never shown.
      let reads = 0;
      component.getScreenText = () => (reads++ === 0 ? trustFolder : '');
      component.composerOnly = true;
      component.active = true;
      component.sessionId = 's1';
      await component.updateComplete;
      await vi.advanceTimersByTimeAsync(800);
      await component.updateComplete;
      expect(options()).toHaveLength(0);
    });

    it('reads no menu from the terminal while it replays its history', async () => {
      let settling = true;
      component.screenSettling = () => settling;
      await show(trustFolder);
      await vi.advanceTimersByTimeAsync(1400);
      await component.updateComplete;
      expect(options()).toHaveLength(0);
      settling = false;
      await vi.advanceTimersByTimeAsync(900);
      await component.updateComplete;
      expect(options()).toHaveLength(2);
    });

    it('does not send typed text into it, where Enter would confirm "No, exit"', async () => {
      await show(trustFolder);
      const onSend = vi.fn();
      component.onSend = onSend;
      const input = component.shadowRoot?.querySelector<HTMLTextAreaElement>('#chat-input-field');
      if (!input) throw new Error('composer not rendered');
      input.value = 'sí';
      input.dispatchEvent(new InputEvent('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      await vi.advanceTimersByTimeAsync(300);
      await component.updateComplete;

      expect(onSend).not.toHaveBeenCalled();
      expect(input.value).toBe('sí');
      // In the block: a note under the composer would resize the terminal.
      expect(
        component.shadowRoot?.querySelector('[data-testid="screen-menu-note"]')?.textContent
      ).toContain('tap one of its options');
      expect(component.shadowRoot?.querySelector('[data-testid="dictation-note"]')).toBeNull();
      // Above the options in the block, which grows upward: the buttons stay put when it comes
      // and goes.
      const note = component.shadowRoot?.querySelector('[data-testid="screen-menu-note"]');
      const firstOption = component.shadowRoot?.querySelector('.screen-menu-option');
      expect(
        note &&
          firstOption &&
          note.compareDocumentPosition(firstOption) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
    });

    it('drops an answer still on its way when another session opens', async () => {
      // Its result landed on the new session: "the prompt changed" there, and its menu blanked
      // (fourth review of 2026-10-03).
      let finish: (response: Response) => void = () => {};
      vi.stubGlobal(
        'fetch',
        vi.fn(() => new Promise<Response>((resolve) => (finish = resolve)))
      );
      await show(trustFolder);
      options()[1].click();
      component.sessionId = 's2';
      await component.updateComplete;
      finish(new Response(JSON.stringify({ error: 'The prompt changed' }), { status: 409 }));
      await vi.advanceTimersByTimeAsync(10);
      await component.updateComplete;
      const internals = component as unknown as { refreshScreenMenu: boolean };
      expect(internals.refreshScreenMenu).toBe(false);
      expect(component.shadowRoot?.querySelector('[data-testid="screen-menu-note"]')).toBeNull();
    });

    it('never sends text into a menu hidden right after an answer', async () => {
      // Review of 2026-10-03: Codex's approvals come back to back with the same options; the
      // next one stayed hidden for 3 s and a quick prompt sent its Enter to it.
      const fetchMock = vi.fn(async () => new Response('{}'));
      vi.stubGlobal('fetch', fetchMock);
      await show(trustFolder);
      options()[1].click();
      await vi.advanceTimersByTimeAsync(50);
      await component.updateComplete;
      expect(options()).toHaveLength(0);
      const onSend = vi.fn();
      component.onSend = onSend;
      const input = component.shadowRoot?.querySelector<HTMLTextAreaElement>('#chat-input-field');
      if (!input) throw new Error('composer not rendered');
      input.value = 'sigue';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      await vi.advanceTimersByTimeAsync(50);
      await component.updateComplete;
      expect(onSend).not.toHaveBeenCalled();
      // Shown again, with the note.
      expect(options()).toHaveLength(2);
      expect(component.shadowRoot?.querySelector('[data-testid="screen-menu-note"]')).toBeTruthy();
    });

    it("forgets the last session's menu when another session opens", async () => {
      const fetchMock = vi.fn(async () => new Response('{}'));
      vi.stubGlobal('fetch', fetchMock);
      await show(trustFolder);
      options()[1].click();
      await vi.advanceTimersByTimeAsync(50);
      // Another new session with the same dialog, within the 3 s an answer hides it for.
      component.sessionId = 's2';
      await component.updateComplete;
      await vi.advanceTimersByTimeAsync(800);
      await component.updateComplete;
      expect(options()).toHaveLength(2);
    });

    it('leaves the options to the chat view when it shows them, still never typing into it', async () => {
      component.menuInChat = true;
      await show(trustFolder);
      expect(options()).toHaveLength(0);
      const onSend = vi.fn();
      component.onSend = onSend;
      const input = component.shadowRoot?.querySelector<HTMLTextAreaElement>('#chat-input-field');
      if (!input) throw new Error('composer not rendered');
      input.value = 'sí';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      await vi.advanceTimersByTimeAsync(50);
      await component.updateComplete;
      expect(onSend).not.toHaveBeenCalled();
      expect(
        component.shadowRoot?.querySelector('[data-testid="dictation-note"]')?.textContent
      ).toContain('tap one of its options');
      component.menuInChat = false;
    });

    it('says what the menu is about above its question', async () => {
      await show(
        readFileSync(
          path.join(
            __dirname,
            '../../server/services/__fixtures__/claude-waiting/permission-bash.txt'
          ),
          'utf8'
        )
      );
      expect(
        component.shadowRoot?.querySelector('[data-testid="screen-menu-detail"]')?.textContent
      ).toContain('rm -rf dist/ && pnpm build');
    });

    it('floats over the terminal instead of taking room from it', () => {
      // Taking room, it shrank the terminal until the menu no longer fit, then went away, in a
      // loop (2026-10-03, keyboard open on an iPhone SE).
      expect(TerminalChatView.styles.toString()).toMatch(
        /\.screen-menu \{[^}]*position: absolute;[^}]*bottom: 100%;/
      );
    });

    it('picks nothing at the end of a drag that began on an option; a still tap picks it', async () => {
      const fetchMock = vi.fn(async () => new Response('{}'));
      vi.stubGlobal('fetch', fetchMock);
      await show(trustFolder);
      const touch = (dy: number) => {
        const at = (y: number) => ({
          pointerType: 'touch',
          pointerId: 7,
          clientX: 200,
          clientY: y,
          bubbles: true,
          composed: true,
        });
        options()[1].dispatchEvent(new PointerEvent('pointerdown', at(600)));
        options()[1].dispatchEvent(new PointerEvent('pointerup', at(600 + dy)));
      };
      touch(-100);
      await vi.advanceTimersByTimeAsync(10);
      expect(fetchCallsTo(fetchMock, '/api/sessions/')).toHaveLength(0);
      touch(2);
      await vi.advanceTimersByTimeAsync(10);
      expect(fetchCallsTo(fetchMock, '/api/sessions/')).toHaveLength(1);
    });

    it('picks an option through the server, which moves the cursor there', async () => {
      const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response('{}'));
      vi.stubGlobal('fetch', fetchMock);
      await show(trustFolder);

      options()[1].click();
      await vi.advanceTimersByTimeAsync(10);
      await component.updateComplete;

      expect(fetchCallsTo(fetchMock, '/api/sessions/')).toHaveLength(1);
      const [[url, init]] = fetchCallsTo(fetchMock, '/api/sessions/');
      expect(url).toBe('/api/sessions/s1/answer');
      expect(JSON.parse(String(init?.body))).toEqual({
        option: 2,
        question: 'Quick safety check: Is this a project you created or one you trust?',
        options: ['No, exit', 'Yes, I trust this folder'],
        key: expect.stringContaining('Accessingworkspace'),
      });
      // Gone at once, and not shown again while the screen still draws it.
      expect(options()).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1500);
      await component.updateComplete;
      expect(options()).toHaveLength(0);
    });

    it('holds the block steady while Claude redraws the menu', async () => {
      // The block resizes the terminal and Claude redraws: the question may scroll out of
      // view, or a poll may land mid-redraw. Changing the block each time looped (2026-10-03).
      await show(trustFolder);
      const question = () =>
        component.shadowRoot?.querySelector('.screen-menu-question')?.textContent;
      const full = 'Trust this folder?';
      expect(question()).toBe(full);

      component.getScreenText = () => trustFolder.split('\n').slice(8).join('\n');
      await vi.advanceTimersByTimeAsync(700);
      await component.updateComplete;
      expect(question()).toBe(full);

      component.getScreenText = () => '';
      await vi.advanceTimersByTimeAsync(700);
      await component.updateComplete;
      expect(options()).toHaveLength(2);

      component.getScreenText = () => trustFolder;
      await vi.advanceTimersByTimeAsync(700);
      component.getScreenText = () => '';
      await vi.advanceTimersByTimeAsync(1400);
      await component.updateComplete;
      expect(options()).toHaveLength(0);
    });

    it("offers Codex's update prompt, where Enter would run a global npm install", async () => {
      const codexUpdate = readFileSync(
        path.join(__dirname, '../../server/services/__fixtures__/claude-waiting/codex-update.txt'),
        'utf8'
      );
      component.claudeSession = false;
      component.agent = 'codex';
      await show(codexUpdate);
      expect(labels()).toEqual([
        'Update now (runs `npm install -g @openai/codex`)',
        'Skip',
        'Skip until next version',
      ]);
    });

    it("leaves Claude's numbered answers alone (no cursor, no key hints)", async () => {
      await show('⏺ Two ways to do it. Which one?\n\n1. Rewrite it\n2. Patch it\n\n❯ ');
      expect(options()).toHaveLength(0);
    });

    it('leaves plain shells alone', async () => {
      component.claudeSession = false;
      component.agent = 'zsh';
      await show(trustFolder);
      expect(options()).toHaveLength(0);
    });
  });

  describe('a message while Claude waits on a numbered menu', () => {
    const planApproval = readFileSync(
      path.join(
        __dirname,
        '../../server/services/__fixtures__/claude-waiting/plan-approval-live.txt'
      ),
      'utf8'
    );
    let fetchMock: ReturnType<typeof vi.fn>;
    const respond = (status: number, body: unknown = {}) =>
      fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status }));
    const send = async (text: string) => {
      const input = component.shadowRoot?.querySelector<HTMLTextAreaElement>('#chat-input-field');
      if (!input) throw new Error('composer not rendered');
      input.value = text;
      input.dispatchEvent(new InputEvent('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      await vi.advanceTimersByTimeAsync(300);
      return input;
    };

    beforeEach(async () => {
      vi.useFakeTimers();
      fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      component.composerOnly = true;
      component.active = true;
      component.claudeSession = true;
      component.sessionId = 's1';
      component.claudeWaiting = true;
      component.getScreenText = () => planApproval;
      await component.updateComplete;
    });
    afterEach(() => vi.unstubAllGlobals());

    it('sends a correction as a reply, never as text plus Enter on "Yes"', async () => {
      // Typed into the menu, Enter executed the plan in QA (2026-10-03).
      const onSend = vi.fn();
      component.onSend = onSend;
      respond(200, { success: true });
      const input = await send('no, mejor llámalo adios.txt');

      expect(onSend).not.toHaveBeenCalled();
      const [[url, init]] = fetchCallsTo(fetchMock, '/api/sessions/');
      expect(url).toBe('/api/sessions/s1/reply');
      expect(JSON.parse(String(init?.body))).toEqual({
        text: 'no, mejor llámalo adios.txt',
        question: 'Would you like to proceed?',
        options: [
          'Yes, and switch to BYPASS PERMISSIONS (no further prompts) for this session',
          'Yes, manually approve edits',
          'Tell Claude what to change',
        ],
        key: expect.stringContaining('Claudehaswrittenupaplan'),
      });
      expect(input.value).toBe('');
    });

    it('picks an option when its number is typed', async () => {
      respond(200, { success: true });
      await send('2');
      const [[url, init]] = fetchCallsTo(fetchMock, '/api/sessions/');
      expect(url).toBe('/api/sessions/s1/answer');
      expect(JSON.parse(String(init?.body))).toMatchObject({ option: 2 });
    });

    it('types the message as usual when Claude turns out not to be waiting', async () => {
      const onSend = vi.fn();
      component.onSend = onSend;
      respond(409, { error: 'not-waiting' });
      // Claude moved on to its prompt: no menu any more.
      component.getScreenText = () => `⏺ Hecho.\n\n${'─'.repeat(40)}\n❯ \n${'─'.repeat(40)}`;
      await send('sigue');
      expect(onSend.mock.calls).toEqual([['sigue'], ['\r']]);
    });

    it('never types into a menu still on screen when Claude says it is not waiting', async () => {
      // Its Enter would confirm the highlighted option: here, the plan with bypass permissions.
      const onSend = vi.fn();
      component.onSend = onSend;
      fetchMock.mockImplementation(async () => {
        component.claudeWaiting = false;
        return new Response(JSON.stringify({ error: 'not-waiting' }), { status: 409 });
      });
      const input = await send('sigue');
      expect(onSend).not.toHaveBeenCalled();
      expect(input.value).toBe('sigue');
      expect(component.shadowRoot?.querySelector('[data-testid="screen-menu-note"]')).toBeTruthy();
    });

    it('keeps the message, and refuses a second send, until the server says it was typed', async () => {
      // Review of 2026-10-03: a double tap posted twice; the reply was cleared before it was typed.
      let finish: (response: Response) => void = () => {};
      fetchMock.mockImplementation(() => new Promise<Response>((resolve) => (finish = resolve)));
      const input = await send('usa pnpm');
      expect(input.value).toBe('usa pnpm');
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      await vi.advanceTimersByTimeAsync(300);
      expect(fetchCallsTo(fetchMock, '/api/sessions/')).toHaveLength(1);
      finish(new Response(JSON.stringify({ error: 'not-delivered' }), { status: 504 }));
      await vi.advanceTimersByTimeAsync(300);
      // Not typed: the message stays for another try.
      expect(input.value).toBe('usa pnpm');
    });

    it('sends an attached image with the reply, never typed into the menu', async () => {
      // Review of 2026-10-03: with an attachment the message skipped the server, and the
      // Enter (or a digit in the upload's file name) answered the plan approval.
      const onSend = vi.fn();
      component.onSend = onSend;
      respond(200, { success: true });
      component.attachmentUploader = async () => ({ path: '/tmp/uploads/2b1c0d7e-shot.png' });
      component.addAttachments([new File(['x'], 'shot.png', { type: 'image/png' })]);
      await vi.advanceTimersByTimeAsync(50);
      await send('mira esto');
      expect(onSend).not.toHaveBeenCalled();
      const [[url, init]] = fetchCallsTo(fetchMock, '/api/sessions/');
      expect(url).toBe('/api/sessions/s1/reply');
      expect(JSON.parse(String(init?.body)).text).toBe('/tmp/uploads/2b1c0d7e-shot.png mira esto');
    });

    it('hides the quick prompts, which are not answers to it', () => {
      expect(component.shadowRoot?.querySelectorAll('.quick-prompt')).toHaveLength(0);
    });

    describe('in the chat view above', () => {
      let sent: Mock<(detail: SentChatMessage) => void>;
      let failed: Mock<(detail: SentChatMessageRef) => void>;
      const sentId = () => sent.mock.calls[0][0].id;

      beforeEach(() => {
        sent = vi.fn();
        failed = vi.fn();
        component.addEventListener('chat-message-sent', (e) => sent((e as CustomEvent).detail));
        component.addEventListener('chat-message-failed', (e) => failed((e as CustomEvent).detail));
      });

      it('shows a reply at once, then that it was not delivered; Retry sends it again', async () => {
        let finish: (response: Response) => void = () => {};
        fetchMock.mockImplementation(() => new Promise<Response>((resolve) => (finish = resolve)));
        const input = await send('usa pnpm');
        // While the server is still on it.
        expect(sent).toHaveBeenCalledOnce();
        expect(sent.mock.calls[0][0]).toMatchObject({ sessionId: 's1', text: 'usa pnpm' });
        finish(new Response(JSON.stringify({ error: 'not-delivered' }), { status: 504 }));
        await vi.advanceTimersByTimeAsync(10);
        expect(failed).toHaveBeenCalledWith({ sessionId: 's1', id: sentId() });
        expect(input.value).toBe('usa pnpm');

        respond(200, { success: true });
        component.resendMessage({ sessionId: 's1', id: sentId() });
        // The same bubble, sending again.
        expect(sent).toHaveBeenCalledTimes(2);
        expect(sent.mock.calls[1][0]).toMatchObject({ id: sentId(), text: 'usa pnpm' });
        await vi.advanceTimersByTimeAsync(10);
        const replies = fetchCallsTo(fetchMock, '/api/sessions/s1/reply');
        expect(replies).toHaveLength(2);
        expect(JSON.parse(String(replies[1][1]?.body)).text).toBe('usa pnpm');
        // Through: the box that still held it empties.
        expect(input.value).toBe('');
        expect(failed).toHaveBeenCalledOnce();
      });

      it('brings back the same bubble when the failed text is sent again from the box', async () => {
        respond(409, { error: 'The prompt changed' });
        const input = await send('usa pnpm');
        expect(failed).toHaveBeenCalledOnce();
        respond(200, { success: true });
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
        await vi.advanceTimersByTimeAsync(300);
        expect(sent).toHaveBeenCalledTimes(2);
        expect(sent.mock.calls[1][0].id).toBe(sentId());
      });

      it('leaves what is being written in the box when a retry ends up typed', async () => {
        const onSend = vi.fn();
        component.onSend = onSend;
        respond(504, { error: 'not-delivered' });
        const input = await send('usa pnpm');
        // Claude went back to its prompt meanwhile, and the next message is being written.
        component.claudeWaiting = false;
        component.getScreenText = () => `⏺ Hecho.\n\n${'─'.repeat(40)}\n❯ \n${'─'.repeat(40)}`;
        input.value = 'otra cosa';
        component.resendMessage({ sessionId: 's1', id: sentId() });
        await vi.advanceTimersByTimeAsync(300);
        expect(onSend.mock.calls).toEqual([['usa pnpm'], ['\r']]);
        expect(input.value).toBe('otra cosa');
        expect(sent).toHaveBeenCalledTimes(2);
        expect(sent.mock.calls[1][0].id).toBe(sentId());
      });

      it('shows no bubble for an option picked by its number: an answer is no message', async () => {
        respond(200, { success: true });
        await send('2');
        expect(fetchCallsTo(fetchMock, '/api/sessions/').map(([url]) => url)).toEqual([
          '/api/sessions/s1/answer',
        ]);
        expect(sent).not.toHaveBeenCalled();
      });

      it('retries nothing for another session', async () => {
        respond(409, { error: 'The prompt changed' });
        await send('usa pnpm');
        const id = sentId();
        component.sessionId = 's2';
        await component.updateComplete;
        component.resendMessage({ sessionId: 's1', id });
        component.resendMessage({ sessionId: 's2', id });
        await vi.advanceTimersByTimeAsync(300);
        expect(fetchCallsTo(fetchMock, '/api/sessions/')).toHaveLength(1);
      });
    });
  });

  describe('quick prompts', () => {
    const chips = () => [
      ...(component.shadowRoot?.querySelectorAll<HTMLButtonElement>('.quick-prompt:not(.edit)') ??
        []),
    ];
    const chip = (label: string) => {
      const found = chips().find((el) => el.textContent?.trim() === label);
      if (!found) throw new Error(`no chip ${label}`);
      return found;
    };
    const touchTap = (el: HTMLElement) => {
      const down = new PointerEvent('pointerdown', { pointerType: 'touch', cancelable: true });
      el.dispatchEvent(down);
      el.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch', bubbles: true }));
      el.click();
      return down;
    };

    afterEach(() => vi.unstubAllGlobals());

    beforeEach(async () => {
      component.composerOnly = true;
      component.active = true;
      await component.updateComplete;
    });

    it('sends a prompt on the first touch, once, like typing it and pressing send', async () => {
      vi.useFakeTimers();
      const onSend = vi.fn();
      component.onSend = onSend;
      expect(chips().map((el) => el.textContent?.trim())).toEqual([
        'Continue',
        'Yes',
        'Explain that',
        'Run the tests',
        'Fix…',
        '/compact',
      ]);

      const down = touchTap(chip('/compact'));
      await vi.advanceTimersByTimeAsync(100);

      expect(down.defaultPrevented).toBe(true);
      expect(onSend.mock.calls).toEqual([['/compact'], ['\r']]);
    });

    it('puts a template prompt in the field to finish instead of sending it', async () => {
      const onSend = vi.fn();
      component.onSend = onSend;
      const input = component.shadowRoot?.querySelector<HTMLTextAreaElement>('#chat-input-field');

      touchTap(chip('Fix…'));
      await component.updateComplete;

      expect(onSend).not.toHaveBeenCalled();
      expect(input?.value).toBe('Fix ');
      expect(chips()).toHaveLength(0);
    });

    it('stays out of the way while typing and for sessions that are not Claude Code', async () => {
      const input = component.shadowRoot?.querySelector<HTMLTextAreaElement>('#chat-input-field');
      if (!input) throw new Error('composer not rendered');
      input.value = 'hola';
      input.dispatchEvent(new InputEvent('input', { bubbles: true }));
      await component.updateComplete;
      expect(chips()).toHaveLength(0);

      input.value = '';
      input.dispatchEvent(new InputEvent('input', { bubbles: true }));
      await component.updateComplete;
      expect(chips().length).toBeGreaterThan(0);

      component.claudeSession = false;
      await component.updateComplete;
      expect(chips()).toHaveLength(0);

      // Codex is a coding agent too: its sessions keep the prompts.
      component.agent = 'codex';
      await component.updateComplete;
      expect(chips().length).toBeGreaterThan(0);

      component.agent = 'gemini';
      await component.updateComplete;
      expect(chips().length).toBeGreaterThan(0);
    });

    it('edits, reorders and keeps a custom list per device after a long press', async () => {
      vi.useFakeTimers();
      const stored = new Map<string, string>();
      vi.stubGlobal('localStorage', {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => stored.set(key, value),
        removeItem: (key: string) => stored.delete(key),
      });
      const onSend = vi.fn();
      component.onSend = onSend;
      const held = chip('Yes');
      held.dispatchEvent(
        new PointerEvent('pointerdown', { pointerType: 'touch', cancelable: true })
      );
      await vi.advanceTimersByTimeAsync(600);
      held.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch' }));
      held.click();
      await vi.advanceTimersByTimeAsync(100);
      expect(onSend).not.toHaveBeenCalled();

      const editor = () => component.shadowRoot?.querySelector('.prompt-editor');
      const rows = () => [...(editor()?.querySelectorAll('li:not(.add-row)') ?? [])];
      expect(rows()).toHaveLength(6);
      rows()[0].querySelector<HTMLButtonElement>('.prompt-remove')?.click();
      await component.updateComplete;
      editor()?.querySelector<HTMLButtonElement>('.prompt-add')?.click();
      await component.updateComplete;
      const added = rows()[rows().length - 1];
      const [label, text] = [...added.querySelectorAll('input')];
      label.value = 'Commit';
      label.dispatchEvent(new InputEvent('input'));
      text.value = 'Commit the changes';
      text.dispatchEvent(new InputEvent('input'));
      // The drag handle moves its row with the arrow keys too (and a drag of it).
      added
        .querySelector<HTMLButtonElement>('.prompt-handle')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
      await component.updateComplete;
      editor()?.querySelector<HTMLButtonElement>('.save')?.click();
      await component.updateComplete;

      expect(editor()).toBeNull();
      const expected = ['Yes', 'Explain that', 'Run the tests', 'Fix…', 'Commit', '/compact'];
      expect(chips().map((el) => el.textContent?.trim())).toEqual(expected);
      const reloaded = new TerminalChatView();
      reloaded.composerOnly = true;
      document.body.append(reloaded);
      await reloaded.updateComplete;
      const reloadedLabels = [
        ...(reloaded.shadowRoot?.querySelectorAll('.quick-prompt:not(.edit)') ?? []),
      ].map((el) => el.textContent?.trim());
      expect(reloadedLabels).toEqual(expected);
      reloaded.remove();

      chip('Commit').dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch' }));
      await vi.advanceTimersByTimeAsync(100);
      expect(onSend.mock.calls).toEqual([['Commit the changes'], ['\r']]);
      await vi.advanceTimersByTimeAsync(1000);

      component.shadowRoot
        ?.querySelector<HTMLButtonElement>('[data-testid="edit-quick-prompts"]')
        ?.click();
      await component.updateComplete;
      editor()?.querySelector<HTMLButtonElement>('.prompt-reset')?.click();
      await component.updateComplete;
      expect(chips()).toHaveLength(6);
      expect([...stored.keys()]).toEqual([]);
    });

    it('ignores a touch that scrolled the row, from a chip or the pencil', async () => {
      const onSend = vi.fn();
      component.onSend = onSend;
      const pencil = component.shadowRoot?.querySelector(
        '[data-testid="edit-quick-prompts"]'
      ) as HTMLElement;
      // Composed, as a browser's: the document sees where the finger went down.
      const touch = (el: Element, toX: number) => {
        const at = (x: number) => ({
          pointerType: 'touch',
          pointerId: 7,
          clientX: x,
          bubbles: true,
          cancelable: true,
          composed: true,
        });
        el.dispatchEvent(new PointerEvent('pointerdown', at(100)));
        el.dispatchEvent(new PointerEvent('pointerup', at(toX)));
      };
      touch(chip('Continue'), 40);
      touch(pencil, 40);
      await component.updateComplete;
      expect(onSend).not.toHaveBeenCalled();
      expect(component.shadowRoot?.querySelector('.prompt-editor')).toBeNull();

      touch(pencil, 102);
      await component.updateComplete;
      expect(component.shadowRoot?.querySelector('.prompt-editor')).not.toBeNull();
    });
  });
});

describe('TerminalChatView interactive options per message (2026-11-10)', () => {
  type Internals = {
    messages: Array<{ id: string; type: string; content: string; timestamp: Date }>;
    interactiveOptionsOf(message: unknown): Array<{ label: string; response: string }> | null;
    detectInteractiveOptions(content: string): unknown;
  };
  let component: TerminalChatView;

  beforeEach(async () => {
    component = new TerminalChatView();
    document.body.append(component);
    await component.updateComplete;
  });

  afterEach(() => {
    component.remove();
  });

  it('finds the same options as the detector, once per text', () => {
    const view = component as unknown as Internals;
    const detect = vi.spyOn(view, 'detectInteractiveOptions');
    const message = { id: 'm', type: 'output', content: '1) uno\n2) dos', timestamp: new Date() };
    const expected = view.detectInteractiveOptions(message.content);
    detect.mockClear();

    expect(view.interactiveOptionsOf(message)).toEqual(expected);
    expect(view.interactiveOptionsOf(message)).toEqual(expected);
    expect(detect).toHaveBeenCalledTimes(1);

    // The text grew (partial output): read again.
    message.content = 'sin opciones';
    expect(view.interactiveOptionsOf(message)).toBeNull();
    expect(detect).toHaveBeenCalledTimes(2);
    message.content = 'Seguir? (y/n)';
    expect(view.interactiveOptionsOf(message)?.map((option) => option.response)).toEqual([
      'y',
      'n',
    ]);
  });

  it('keeps one answer per message, not one per text', () => {
    const view = component as unknown as Internals;
    const detect = vi.spyOn(view, 'detectInteractiveOptions');
    const first = { id: 'a', type: 'output', content: '1) x\n2) y', timestamp: new Date() };
    const second = { ...first, id: 'b' };
    view.interactiveOptionsOf(first);
    view.interactiveOptionsOf(second);
    expect(detect).toHaveBeenCalledTimes(2);
  });
});

describe('composer drafts of sessions that are gone (2026-11-10)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('prunes only the drafts whose session is not live, and nothing on an empty list', async () => {
    // The shared test setup replaces localStorage with no-op mocks: use a real store here.
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, String(value)),
      removeItem: (key: string) => void store.delete(key),
      key: (index: number) => [...store.keys()][index] ?? null,
      get length() {
        return store.size;
      },
    });
    const { DRAFT_GONE_AFTER_MS, loadDraft, pruneDrafts, saveDraft } = await import(
      './terminal-chat-view/composer-storage.js'
    );
    saveDraft('live', 'keep me');
    saveDraft('dead', 'unsent');
    store.set('other-key', 'untouched');

    pruneDrafts([]);
    expect(loadDraft('dead')).toBe('unsent');

    // Missing from one list is not gone: a remote that did not answer, a list still loading.
    pruneDrafts(['live'], 1_000);
    expect(loadDraft('dead')).toBe('unsent');
    // Back in a list, its absence starts over.
    pruneDrafts(['live', 'dead'], 2_000);
    pruneDrafts(['live'], 3_000);
    pruneDrafts(['live'], 3_000 + DRAFT_GONE_AFTER_MS - 1);
    expect(loadDraft('dead')).toBe('unsent');

    pruneDrafts(['live'], 3_000 + DRAFT_GONE_AFTER_MS);
    expect(loadDraft('live')).toBe('keep me');
    expect(loadDraft('dead')).toBe('');
    expect(store.get('other-key')).toBe('untouched');
  });
});
