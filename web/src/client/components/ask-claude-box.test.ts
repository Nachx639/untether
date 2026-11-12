// @vitest-environment happy-dom
import { fixture, html } from '@open-wc/testing';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFoundation } from '../../test/utils/stylesheets.js';
import type { AskClaudeBox } from './ask-claude-box';

describe('ask-claude-box', () => {
  const store = new Map<string, string>();

  beforeAll(async () => {
    await import('./ask-claude-box');
  });

  beforeEach(() => {
    vi.mocked(localStorage.getItem).mockImplementation((key) => store.get(key) ?? null);
    vi.mocked(localStorage.setItem).mockImplementation((key, value) => {
      store.set(key, value);
    });
    vi.mocked(localStorage.removeItem).mockImplementation((key) => {
      store.delete(key);
    });
  });

  afterEach(() => {
    store.clear();
    vi.mocked(localStorage.getItem).mockReset();
    vi.mocked(localStorage.setItem).mockReset();
    vi.mocked(localStorage.removeItem).mockReset();
  });

  const type = (box: AskClaudeBox, text: string) => {
    const input = box.querySelector('textarea') as HTMLTextAreaElement;
    input.value = text;
    input.dispatchEvent(new Event('input'));
  };

  // 2026-10-12 (user report, iPhone): a tap in the middle of the text has to leave the caret there;
  // the box binds .value, which must not put it back at the end as the text is typed.
  it('keeps the caret where it was put while typing renders the box again', async () => {
    const box = await fixture<AskClaudeBox>(html`<ask-claude-box></ask-claude-box>`);
    const input = box.querySelector('textarea') as HTMLTextAreaElement;
    type(box, 'hola que tal estas');
    await box.updateComplete;
    input.focus();
    // Typing a comma after "hola" (happy-dom's setRangeText leaves the caret at the end).
    input.value = 'hola, que tal estas';
    input.setSelectionRange(5, 5);
    input.dispatchEvent(new Event('input'));
    await box.updateComplete;
    box.requestUpdate();
    await box.updateComplete;

    expect(input.value).toBe('hola, que tal estas');
    expect([input.selectionStart, input.selectionEnd]).toEqual([5, 5]);
  });

  it('keeps an unsent question as a draft for the next visit', async () => {
    const box = await fixture<AskClaudeBox>(html`<ask-claude-box></ask-claude-box>`);
    type(box, 'half a question');
    box.remove();

    const again = await fixture<AskClaudeBox>(html`<ask-claude-box></ask-claude-box>`);
    expect((again.querySelector('textarea') as HTMLTextAreaElement).value).toBe('half a question');
  });

  it("shows the folder's own name, keeping the whole path for its label", async () => {
    const box = await fixture<AskClaudeBox>(
      html`<ask-claude-box folder="~/.untether-qa/qa-trust-3"></ask-claude-box>`
    );
    const chip = box.querySelector('[data-testid="ask-claude-folder"]') as HTMLButtonElement;
    expect(chip.querySelector('bdi')?.textContent).toBe('qa-trust-3');
    expect(chip.getAttribute('aria-label')).toContain('~/.untether-qa/qa-trust-3');
    const { folderName } = await import('./ask-claude-box');
    expect([
      folderName('~'),
      folderName('/'),
      folderName('~/Projects/'),
      folderName('/opt/x'),
    ]).toEqual(['~', '/', 'Projects', 'x']);
  });

  it('sends on a touch pointerup once, ignoring the trailing click, and clears the field', async () => {
    const box = await fixture<AskClaudeBox>(html`<ask-claude-box folder="/work"></ask-claude-box>`);
    const asked = vi.fn();
    box.addEventListener('ask-claude', (e) => asked((e as CustomEvent).detail.text));
    type(box, '  fix the build  ');
    await box.updateComplete;

    const send = box.querySelector('[data-testid="ask-claude-send"]') as HTMLButtonElement;
    send.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch', bubbles: true }));
    send.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(asked.mock.calls).toEqual([['fix the build']]);
    expect((box.querySelector('textarea') as HTMLTextAreaElement).value).toBe('');
    expect(store.has('ut-ask-claude-draft')).toBe(false);
  });

  it('sends nothing at the end of a scroll that started on Send; a still tap sends', async () => {
    const box = await fixture<AskClaudeBox>(html`<ask-claude-box folder="/work"></ask-claude-box>`);
    const asked = vi.fn();
    box.addEventListener('ask-claude', (e) => asked((e as CustomEvent).detail.text));
    type(box, 'fix the build');
    await box.updateComplete;

    const send = box.querySelector('[data-testid="ask-claude-send"]') as HTMLButtonElement;
    // iOS ends a scroll of the list that began on the button with a pointerup on it.
    const touch = (dy: number) => {
      const at = (y: number) => ({
        pointerType: 'touch',
        pointerId: 7,
        clientX: 40,
        clientY: y,
        bubbles: true,
      });
      send.dispatchEvent(new PointerEvent('pointerdown', at(300)));
      send.dispatchEvent(new PointerEvent('pointerup', at(300 + dy)));
    };
    touch(-100);
    expect(asked).not.toHaveBeenCalled();
    touch(2);
    send.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(asked.mock.calls).toEqual([['fix the build']]);
  });

  it('grows to the text without counting its padding twice (no blank line)', async () => {
    const box = await fixture<AskClaudeBox>(html`<ask-claude-box></ask-claude-box>`);
    const input = box.querySelector('textarea') as HTMLTextAreaElement;
    input.style.boxSizing = 'content-box';
    input.style.padding = '12px';
    // One line of text: 22 px of content + 24 px of padding.
    Object.defineProperty(input, 'scrollHeight', { configurable: true, get: () => 46 });
    type(box, 'h');
    expect(input.style.height).toBe('22px');
  });

  it('asks Codex once picked, and remembers the pick', async () => {
    const box = await fixture<AskClaudeBox>(html`<ask-claude-box></ask-claude-box>`);
    const textarea = () => box.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea().placeholder).toBe('Ask Claude…');
    const codex = box.querySelector('[data-testid="ask-agent-codex"]') as HTMLButtonElement;
    codex.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await box.updateComplete;
    expect(codex.getAttribute('aria-checked')).toBe('true');
    expect(textarea().placeholder).toBe('Ask Codex…');
    expect(store.get('ut-ask-agent')).toBe('codex');

    const asked = vi.fn();
    box.addEventListener('ask-claude', (e) => asked((e as CustomEvent).detail));
    type(box, 'hola');
    box.send();
    expect(asked).toHaveBeenCalledWith({ text: 'hola', agent: 'codex', mode: 'session' });

    box.remove();
    const again = await fixture<AskClaudeBox>(html`<ask-claude-box></ask-claude-box>`);
    expect((again.querySelector('textarea') as HTMLTextAreaElement).placeholder).toBe('Ask Codex…');
  });

  // 2026-10-12 (phone-spec 4.1): the names always (no marks), Tareas a clock icon in the box's
  // corner, the folder chip clamped by CSS (list.css) so it gives way first on a narrow row.
  it('always names the agents, and shows the folder by its name next to them', async () => {
    const box = await fixture<AskClaudeBox>(
      html`<ask-claude-box .folder=${'/Users/x/Projects/untether'} .tasks=${true}></ask-claude-box>`
    );
    for (const [agent, name] of [
      ['claude', 'Claude'],
      ['codex', 'Codex'],
    ]) {
      const button = box.querySelector(`[data-testid="ask-agent-${agent}"]`) as HTMLElement;
      expect(button.getAttribute('role')).toBe('radio');
      expect(button.getAttribute('aria-label')).toBe(name);
      expect(button.querySelector('.ask-agent-name')?.textContent).toBe(name);
    }
    expect(box.querySelector('.ask-agent-mark')).toBeNull();
    expect(box.querySelector('[data-testid="ask-claude-folder"] bdi')?.textContent).toBe(
      'untether'
    );
    const tasks = box.querySelector('[data-testid="open-tasks"]') as HTMLElement;
    expect(tasks.querySelector('svg')).not.toBeNull();
    expect(tasks.textContent?.trim()).toBe('');
  });

  it('no stylesheet rule swaps names for marks any more', () => {
    const css = readFoundation();
    expect(css).not.toMatch(/@container ask-start/);
    expect(css).not.toMatch(/\.ask-agent-(mark|name) \{\s*display: none;/);
  });

  it('dictates into the question with the microphone', async () => {
    const started: FakeRecognition[] = [];
    class FakeRecognition {
      onresult: ((e: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      start() {
        started.push(this);
      }
      stop() {
        this.onend?.();
      }
      abort() {}
    }
    vi.stubGlobal('webkitSpeechRecognition', FakeRecognition);
    try {
      const box = await fixture<AskClaudeBox>(html`<ask-claude-box></ask-claude-box>`);
      const mic = box.querySelector('[data-testid="ask-claude-mic"]') as HTMLButtonElement;
      mic.click();
      started.at(-1)?.onresult?.({ results: [[{ transcript: 'hola Claude' }]] });
      await box.updateComplete;
      expect(box.querySelector('textarea')?.value).toBe('hola Claude');
      expect(mic.getAttribute('aria-pressed')).toBe('true');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // P6 (2026-10-18): in a git repository the text becomes a task by default (routed to the
  // open task it belongs to, or a new one); the chip turns it back into a plain session.
  it('shows Tarea / Sesión only in a repository, Tarea by default, and remembers the pick', async () => {
    const plain = await fixture<AskClaudeBox>(
      html`<ask-claude-box folder="/tmp"></ask-claude-box>`
    );
    expect(plain.querySelector('[data-testid="ask-mode"]')).toBeNull();
    const plainAsked = vi.fn();
    plain.addEventListener('ask-claude', (e) => plainAsked((e as CustomEvent).detail.mode));
    type(plain, 'hola');
    plain.send();
    expect(plainAsked).toHaveBeenCalledWith('session');
    plain.remove();

    const box = await fixture<AskClaudeBox>(
      html`<ask-claude-box folder="/repo" .repo=${true}></ask-claude-box>`
    );
    const chip = () => box.querySelector('[data-testid="ask-mode"]') as HTMLButtonElement;
    expect(chip().dataset.mode).toBe('task');
    expect(chip().textContent?.trim()).toBe('Task');
    expect(chip().classList.contains('task')).toBe(true);
    expect((box.querySelector('textarea') as HTMLTextAreaElement).placeholder).toBe(
      'What needs doing?'
    );
    const asked = vi.fn();
    box.addEventListener('ask-claude', (e) => asked((e as CustomEvent).detail));
    type(box, 'arregla el login');
    box.send();
    expect(asked).toHaveBeenLastCalledWith({
      text: 'arregla el login',
      agent: 'claude',
      mode: 'task',
    });

    // A touch acts on pointerup once; its trailing click is ignored.
    chip().dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch', bubbles: true }));
    chip().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await box.updateComplete;
    expect(chip().dataset.mode).toBe('session');
    expect(chip().textContent?.trim()).toBe('Session');
    expect(store.get('ut-ask-mode')).toBe('session');
    expect((box.querySelector('textarea') as HTMLTextAreaElement).placeholder).toBe('Ask Claude…');
    type(box, 'una pregunta');
    box.send();
    expect(asked).toHaveBeenLastCalledWith({
      text: 'una pregunta',
      agent: 'claude',
      mode: 'session',
    });

    box.remove();
    const again = await fixture<AskClaudeBox>(
      html`<ask-claude-box folder="/repo" .repo=${true}></ask-claude-box>`
    );
    expect(
      (again.querySelector('[data-testid="ask-mode"]') as HTMLButtonElement).dataset.mode
    ).toBe('session');
  });

  it('gives the question back when the session could not start', async () => {
    const box = await fixture<AskClaudeBox>(html`<ask-claude-box></ask-claude-box>`);
    type(box, 'hello');
    box.send();
    box.restore('hello');
    await box.updateComplete;
    expect((box.querySelector('textarea') as HTMLTextAreaElement).value).toBe('hello');
  });

  it('Send waits while the dictation is still being transcribed (2026-10-20)', async () => {
    const box = await fixture<AskClaudeBox>(html`<ask-claude-box folder="/work"></ask-claude-box>`);
    const asked = vi.fn();
    box.addEventListener('ask-claude', asked);
    type(box, 'fix the build');
    (box as unknown as { dictation: string }).dictation = 'transcribing';
    await box.updateComplete;
    const send = box.querySelector('[data-testid="ask-claude-send"]') as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    box.send();
    expect(asked).not.toHaveBeenCalled();
  });
});
