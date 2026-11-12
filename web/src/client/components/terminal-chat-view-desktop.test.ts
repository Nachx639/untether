// @vitest-environment happy-dom

// 2026-10-12: desktop chat mode on a Claude Code session showed one bubble of spinner frames
// ("Musing…5", counters, the logo's block glyphs) parsed from the terminal's output. The desktop
// now shows the agent's own chat (claude-chat-view) over this view's composer; the parsed chat
// stays for plain shells and no longer turns a TUI's repaints into messages.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isPaintedNoise, isSpinnerStatus, TerminalChatView } from './terminal-chat-view.js';

type Parsed = TerminalChatView & {
  processTerminalOutput(data: string): void;
  messages: Array<{ type: string; content: string }>;
};

const at = (row: number, col: number, text: string) => `\x1b[${row};${col}H${text}`;

describe('TerminalChatView output parsing', () => {
  let view: Parsed;

  beforeEach(async () => {
    vi.useFakeTimers();
    view = new TerminalChatView() as Parsed;
    document.body.append(view);
    await view.updateComplete;
  });

  afterEach(() => {
    view.remove();
    vi.useRealTimers();
  });

  const feed = (...chunks: string[]) => {
    for (const chunk of chunks) {
      view.processTerminalOutput(chunk);
      vi.advanceTimersByTime(400);
    }
  };
  const output = () => view.messages.map((m) => m.content).join('\n');

  it("drops a spinner repainted cell by cell (Claude Code's differential renderer)", () => {
    // The frames as the PTY carries them: the cells that changed, with cursor moves and no
    // newline. Before, they became "29203✽Pondering… 30210·31217…".
    const frames: string[] = [
      at(9, 1, '· Musing… \x1b[2m(0s · ↓ 0 tokens · esc to interrupt)\x1b[0m'),
    ];
    const glyphs = '·✢✳✶✻✽';
    const verbs = ['Musing…', 'Working…', 'Pondering…'];
    for (let n = 1; n <= 30; n++) {
      let frame = at(9, 1, glyphs[n % glyphs.length]);
      if (n % 10 === 0) frame += at(9, 3, `${verbs[(n / 10) % 3]}  `);
      frame += at(9, 14, `\x1b[2m${n}\x1b[0m`);
      frame += at(9, 22, `\x1b[2m${n * 7}\x1b[0m`);
      frame += '\x1b[12;3H';
      frames.push(frame);
    }
    feed(...frames);
    expect(view.messages).toHaveLength(0);
  });

  it('drops Ink-style redraws of a status line and the block glyphs of a logo', () => {
    const erase = '\x1b[2K\x1b[1A\x1b[2K\x1b[G';
    feed(
      '\x1b[38;5;209m ▐▛███▜▌\x1b[0m\n\x1b[38;5;209m▝▜█████▛▘\x1b[0m\n  ▘▘ ▝▝\n',
      '✻ Musing… (3s · esc to interrupt)\n',
      `${erase}✶ Musing…\n`,
      `${erase}✳ Working… 12\n`,
      `${erase}* Cogitating… (40s · ↑ 1.2k tokens)\n`
    );
    expect(output()).toBe('');
  });

  it('keeps what a plain shell prints, numbers included, without its bell', () => {
    feed('hola mundo\r\n', '42\r\n', '\x07\x07total 8\r\n', 'Building...\r\n');
    expect(output()).toBe('hola mundo\n42\ntotal 8\nBuilding...');
  });

  it('keeps words painted at a cursor position and drops the counters around them', () => {
    feed(at(3, 1, 'Compiled successfully'), at(3, 30, '12'), at(4, 1, '✻'), at(5, 1, 'Listo\r\n'));
    expect(output()).toBe('Compiled successfully\nListo');
  });

  it('removes titles and links (OSC) ended by BEL or by ST', () => {
    feed('\x1b]0;claude\x07\x1b]8;;https://x.dev\x1b\\enlace\x1b]8;;\x1b\\ listo\r\n');
    expect(output()).toBe('enlace listo');
  });
});

describe('spinner and painted-text rules', () => {
  it.each([
    'Musing…',
    '✻ Musing… (5s · esc to interrupt)',
    'Musing…5',
    '· Working… 12',
    '✽ Pondering…  ',
    'Cogitating… (40s · ↑ 1.2k tokens',
  ])('%s is a spinner frame', (line) => {
    expect(isSpinnerStatus(line)).toBe(true);
  });

  it.each(['Building...', 'Listo… y subido a main', 'echo Musing', 'hola mundo'])(
    '%s is not a spinner frame',
    (line) => {
      expect(isSpinnerStatus(line)).toBe(false);
    }
  );

  it('keeps painted text with a word in it and nothing else', () => {
    expect(isPaintedNoise('5')).toBe(true);
    expect(isPaintedNoise('203')).toBe(true);
    expect(isPaintedNoise('✻')).toBe(true);
    expect(isPaintedNoise('(12s · ↓')).toBe(true);
    expect(isPaintedNoise('Compiled successfully')).toBe(false);
  });
});

describe('TerminalChatView desktop composer', () => {
  let view: TerminalChatView;

  beforeEach(async () => {
    view = new TerminalChatView();
    view.composerOnly = true;
    view.desktop = true;
    view.active = true;
    view.sessionId = 'desk-1';
    view.claudeSession = true;
    document.body.append(view);
    await view.updateComplete;
  });

  afterEach(() => {
    view.remove();
    localStorage.clear();
  });

  const $ = <T extends Element>(selector: string) => view.shadowRoot?.querySelector<T>(selector);

  it('is one card with attach, the field and Send: no + sheet or quick replies', () => {
    expect(view.hasAttribute('desktop')).toBe(true);
    expect($('[data-testid="composer-plus"]')).toBeNull();
    expect($('.plus-sheet')).toBeNull();
    expect($('.quick-prompts')).toBeNull();
    expect($('[data-testid="composer-attach"]')).not.toBeNull();
    expect($('textarea#chat-input-field')).not.toBeNull();
    expect($<HTMLButtonElement>('[data-testid="chat-send-button"]')?.disabled).toBe(true);
  });

  it('attach opens a menu: photo, this device, or the Mac (user report)', async () => {
    const attach = vi.fn();
    view.addEventListener('composer-attach', attach);
    $<HTMLButtonElement>('[data-testid="composer-attach"]')?.click();
    await view.updateComplete;
    expect($<HTMLDialogElement>('#chat-attach-menu')?.open).toBe(true);
    expect($('#chat-attach-photo')).not.toBeNull();
    expect($('#chat-attach-device-file')?.textContent).toContain('File from this device');
    expect($('#chat-attach-mac-file')?.textContent).toContain('File from the Mac');
    expect(attach).not.toHaveBeenCalled();

    $<HTMLButtonElement>('#chat-attach-device-file')?.click();
    await view.updateComplete;
    expect(attach).toHaveBeenCalledOnce();
    expect((attach.mock.calls[0][0] as CustomEvent).detail).toEqual({ source: 'device' });
    expect($<HTMLDialogElement>('#chat-attach-menu')?.open).toBe(false);
  });

  it('the attach menu opens below its button when there is no room above', async () => {
    // Verifier 2026-10-14: with the composer near the top of a short window it opened off screen.
    const button = $<HTMLButtonElement>('[data-testid="composer-attach"]');
    if (!button) throw new Error('no attach button');
    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue(
      DOMRect.fromRect({ x: 40, y: 50, width: 32, height: 32 })
    );
    const menu = $<HTMLDialogElement>('#chat-attach-menu');
    if (!menu) throw new Error('no menu');
    vi.spyOn(menu, 'offsetHeight', 'get').mockReturnValue(118);
    button.click();
    await view.updateComplete;
    expect(menu.style.top).toBe('88px');
    expect(menu.style.bottom).toBe('auto');
  });

  it("the Mac's file opens the Mac file picker, not the device's", async () => {
    const attach = vi.fn();
    view.addEventListener('composer-attach', attach);
    const picker = $<HTMLElement & { show(): Promise<void> }>('mac-file-picker');
    if (!picker) throw new Error('no mac-file-picker');
    const show = vi.spyOn(picker, 'show').mockResolvedValue();
    $<HTMLButtonElement>('[data-testid="composer-attach"]')?.click();
    await view.updateComplete;
    $<HTMLButtonElement>('#chat-attach-mac-file')?.click();
    expect(show).toHaveBeenCalledOnce();
    expect(attach).not.toHaveBeenCalled();
  });

  it('sends on Enter through the same path as the phone composer', async () => {
    const onSend = vi.fn();
    const sent = vi.fn();
    view.onSend = onSend;
    view.addEventListener('chat-message-sent', sent);
    const field = $<HTMLTextAreaElement>('#chat-input-field');
    if (!field) throw new Error('no field');
    field.value = 'Sube la rama';
    field.dispatchEvent(new InputEvent('input', { bubbles: true }));
    await view.updateComplete;
    expect($<HTMLButtonElement>('[data-testid="chat-send-button"]')?.disabled).toBe(false);
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() => expect(onSend).toHaveBeenCalled());
    expect(onSend.mock.calls.map(([data]) => data).join('')).toContain('Sube la rama');
    expect(sent).toHaveBeenCalledOnce();
    // Nothing reached the terminal while typing: the message went whole, on Enter.
    expect(onSend.mock.calls[0][0]).not.toBe('S');
  });

  it('styles the desktop card only under [composerOnly][desktop]', () => {
    const css = (TerminalChatView.styles as unknown as Array<{ cssText: string }>)
      .map((sheet) => sheet.cssText)
      .join('');
    // 2026-11-11: the chat's column token (the whole area less a margin; 720 px when comfortable), the
    // same one claude-chat-view centres the conversation with, so the two stay in line.
    expect(css).toMatch(
      /:host\(\[composerOnly\]\[desktop\]\) \.chat-input-container \{[^}]*max-width: var\(--ut-chat-column\)/
    );
    expect(css).not.toMatch(/720px/);
  });
});
