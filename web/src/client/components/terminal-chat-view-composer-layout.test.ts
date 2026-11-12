// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  composerHeightFor,
  rememberRecentCommand,
  TerminalChatView,
} from './terminal-chat-view.js';

/** Phone chat composer: how the field and its row behave while typing. */
describe('TerminalChatView phone composer layout', () => {
  let component: TerminalChatView;
  const field = () =>
    component.shadowRoot?.querySelector<HTMLTextAreaElement>('textarea.composer-input') ?? null;

  beforeEach(async () => {
    localStorage.clear();
    component = new TerminalChatView();
    component.composerOnly = true;
    component.active = true;
    component.sessionId = 'layout-test';
    document.body.append(component);
    await component.updateComplete;
  });

  afterEach(() => {
    component.remove();
    vi.restoreAllMocks();
  });

  describe('composerHeightFor', () => {
    const style = (boxSizing: string) => ({
      boxSizing,
      paddingTop: '12px',
      paddingBottom: '12px',
      borderTopWidth: '1px',
      borderBottomWidth: '1px',
    });

    it('does not count the padding twice on a content-box field', () => {
      // One line of 21.6 px text plus 24 px of padding.
      expect(composerHeightFor(45.6, style('content-box'))).toBeCloseTo(21.6);
    });

    it('adds only the borders on a border-box field', () => {
      expect(composerHeightFor(45.6, style('border-box'))).toBeCloseTo(47.6);
    });
  });

  it('keeps one typed line exactly as tall as the empty field', async () => {
    const input = field();
    if (!input) throw new Error('no composer');
    // happy-dom does no layout: give the field iPhone WebKit's numbers.
    Object.defineProperty(input, 'scrollHeight', { configurable: true, get: () => 46 });
    const real = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el, pseudo) => {
      const computed = real(el, pseudo);
      if (el !== input) return computed;
      return {
        ...computed,
        boxSizing: 'content-box',
        paddingTop: '12px',
        paddingBottom: '12px',
        borderTopWidth: '1px',
        borderBottomWidth: '1px',
      } as CSSStyleDeclaration;
    });

    input.value = 'hello';
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));

    // 46 px here would be content height + padding again: an empty extra line under the text.
    expect(input.style.height).toBe('22px');
  });

  it('announces its focus so the conversation can scroll to the end', () => {
    const seen = vi.fn();
    document.addEventListener('composer-focus', seen);
    field()?.dispatchEvent(new FocusEvent('focus'));
    document.removeEventListener('composer-focus', seen);
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('pads its bottom with the clearance the session view hands it', () => {
    const css = TerminalChatView.styles.toString();
    expect(css).toMatch(
      /:host\(\[composerOnly\]\) \.chat-input-container \{[^}]*padding-bottom: calc\(0\.625rem \+ var\(--composer-safe-bottom, 0px\)\)/
    );
  });
});

/** Desktop chat mode: centered composer card, send inside, calm empty state (2026-10-12). */
describe('TerminalChatView desktop composer', () => {
  let component: TerminalChatView;
  const root = () => component.shadowRoot as ShadowRoot;
  const send = () => root().querySelector<HTMLButtonElement>('[data-testid="chat-send-button"]');

  const mount = async () => {
    component = new TerminalChatView();
    component.active = true;
    component.sessionId = 'desktop-test';
    component.onSend = vi.fn();
    document.body.append(component);
    await component.updateComplete;
  };

  beforeEach(() => {
    // The global test setup stubs localStorage with no-op mocks: give it a real store.
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, String(value)),
      removeItem: (key: string) => store.delete(key),
      clear: () => store.clear(),
    });
  });
  afterEach(() => {
    component?.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows the translated empty state with the chat icon, no emoji', async () => {
    await mount();
    const empty = root().querySelector('[data-testid="chat-empty-state"]');
    expect(empty?.querySelector('.ut-chat-empty-tile svg')).not.toBeNull();
    expect(empty?.textContent).toContain('Type like you’re chatting');
    expect(empty?.textContent).toContain('Each message is sent to the terminal with Enter.');
    expect(empty?.textContent).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(root().querySelector('[data-testid="chat-suggestions"]')).toBeNull();
  });

  it('offers up to three recent commands as suggestions', async () => {
    for (const command of ['ls', 'git status', 'pnpm test', 'git status']) {
      rememberRecentCommand(command);
    }
    await mount();
    const chips = [...root().querySelectorAll('[data-testid="chat-suggestions"] button')].map(
      (chip) => chip.textContent?.trim()
    );
    expect(chips).toEqual(['git status', 'pnpm test', 'ls']);
  });

  it('keeps send disabled while the box is empty', async () => {
    await mount();
    expect(send()?.disabled).toBe(true);
    const input = root().querySelector<HTMLInputElement>('#chat-input-field');
    if (!input) throw new Error('no input');
    input.value = 'ls -la';
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    await component.updateComplete;
    expect(send()?.disabled).toBe(false);

    send()?.click();
    await component.updateComplete;
    expect(send()?.disabled).toBe(true);
  });

  it('styles the desktop composer as a centered card (820 px, or the chat column when wider) with a 32 px send inside', () => {
    const css = TerminalChatView.styles.toString();
    expect(css).toMatch(
      /:host\(:not\(\[composerOnly\]\)\) \{[^}]*--chat-card-width: max\(820px, var\(--ut-chat-column\)\)/
    );
    expect(css).toMatch(
      /:host\(:not\(\[composerOnly\]\)\) \.chat-input-container \{[^}]*max-width: var\(--chat-card-width\)/
    );
    expect(css).toMatch(/:host\(:not\(\[composerOnly\]\)\) \.send-button \{[^}]*width: 32px/);
  });
});

// Phone composer (phone-spec §3.5-3.7, 2026-10-12): one trailing primary slot, quick replies
// only while Claude is idle, the + sheet, the bottom chrome for toasts.
describe('TerminalChatView phone composer slots', () => {
  let composer: TerminalChatView;
  const root = () => composer.shadowRoot as ShadowRoot;

  beforeEach(async () => {
    localStorage.clear();
    composer = new TerminalChatView();
    composer.composerOnly = true;
    composer.claudeSession = true;
    composer.active = true;
    composer.sessionId = 'slots';
    document.body.append(composer);
    await composer.updateComplete;
  });

  afterEach(() => {
    composer.remove();
    vi.restoreAllMocks();
  });

  it('shows mic and a ghost Enter when empty, a filled Send only with something to send', async () => {
    expect(root().querySelector('[data-testid="chat-send-button"]')).toBeNull();
    expect(root().querySelector('[data-testid="dictate-button"]')).not.toBeNull();
    const enter = root().querySelector<HTMLButtonElement>('[data-testid="chat-enter-button"]');
    expect(enter?.getAttribute('aria-label')).toBe('Send Enter');
    const sent: string[] = [];
    composer.onSend = (data) => sent.push(data);
    enter?.click();
    expect(sent).toEqual(['\r']);

    const field = root().querySelector('textarea') as HTMLTextAreaElement;
    field.value = 'hola';
    field.dispatchEvent(new InputEvent('input', { bubbles: true }));
    await composer.updateComplete;
    expect(root().querySelector('[data-testid="chat-send-button"]')).not.toBeNull();
    expect(root().querySelector('[data-testid="dictate-button"]')).toBeNull();
  });

  it('never types a bare Enter into a menu on screen', async () => {
    composer.getScreenText = () =>
      ' Quick safety check: Is this a project you created or one you trust?\n\n ❯ No, exit\n   Yes, I trust this folder\n\n Enter to confirm · Esc to cancel';
    const sent: string[] = [];
    composer.onSend = (data) => sent.push(data);
    await composer.updateComplete;
    (composer as unknown as { sendEnter: () => void }).sendEnter();
    expect(sent).toEqual([]);
  });

  it('hides the quick replies while Claude works (the chat says so) or the mic is on', async () => {
    expect(root().querySelectorAll('.quick-prompt:not(.edit)').length).toBeGreaterThan(0);
    // The pencil sits outside the scrolling chips.
    expect(root().querySelector('.qp-scroller .edit')).toBeNull();
    document.dispatchEvent(
      new CustomEvent('claude-chat-state', {
        detail: { sessionId: 'slots', busy: true, asking: false },
      })
    );
    await composer.updateComplete;
    expect(root().querySelector('.quick-prompts')).toBeNull();
    document.dispatchEvent(
      new CustomEvent('claude-chat-state', {
        detail: { sessionId: 'slots', busy: false, asking: false },
      })
    );
    await composer.updateComplete;
    expect(root().querySelector('.quick-prompts')).not.toBeNull();
    (composer as unknown as { dictation: string }).dictation = 'recording';
    await composer.updateComplete;
    expect(root().querySelector('.quick-prompts')).toBeNull();
    // The recording capsule takes the field's place, with cancel, time and stop.
    expect(root().querySelector('[data-testid="recording-capsule"]')).not.toBeNull();
    expect(root().querySelector('.rec-time')?.textContent).toMatch(/^\d+:\d\d$/);
    expect(root().querySelector('[data-testid="dictation-note"]')).toBeNull();
  });

  it('folds attach into the + sheet and sets --ut-bottom-chrome while mounted', async () => {
    const plus = root().querySelector<HTMLButtonElement>('[data-testid="composer-plus"]');
    plus?.click();
    await composer.updateComplete;
    expect(plus?.getAttribute('aria-expanded')).toBe('true');
    // User report: the device's picker could not reach a PDF on the Mac. The sheet offers the
    // photo library, the iPhone's files and the Mac's files.
    const menu = root().querySelector('#chat-attach-menu');
    expect([...(menu?.querySelectorAll('.action-item') ?? [])].map((item) => item.id)).toEqual([
      'chat-attach-photo',
      'chat-attach-device-file',
      'chat-attach-mac-file',
    ]);
    const sources: unknown[] = [];
    composer.addEventListener('composer-attach', (e) => sources.push((e as CustomEvent).detail));
    root().querySelector<HTMLButtonElement>('[data-testid="composer-attach"]')?.click();
    expect(sources).toEqual([{ source: 'media' }]);
    expect(document.documentElement.style.getPropertyValue('--ut-bottom-chrome')).toMatch(/px$/);
    composer.remove();
    expect(document.documentElement.style.getPropertyValue('--ut-bottom-chrome')).toBe('0px');
  });

  it('lets the field grow in its column capsule (no 0% flex basis holding it at one line)', () => {
    // 2026-10-12: .chat-input's flex: 1 kept the phone field at its 42 px min-height in WebKit,
    // so a long message scrolled inside one line and taps landed on the wrong line.
    const css = (TerminalChatView.styles as unknown as Array<{ cssText: string }>)
      .map((sheet) => sheet.cssText)
      .join('');
    const rule = /:host\(\[composerOnly\]\)\s*\.composer-capsule\s*\.chat-input\s*\{([^}]*)\}/.exec(
      css
    );
    expect(rule?.[1]).toMatch(/flex:\s*0 0 auto/);
    expect(css).toMatch(/\.composer-capsule\s*\{[^}]*flex-direction:\s*column/);
  });
});
