// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeChatView } from './claude-chat-view.js';
import './claude-chat-view.js';
import { TerminalChatView } from './terminal-chat-view.js';

// 2026-10-04: on a phone on its side (a Pro Max in landscape, about 190 pt of chat) the pane is
// short, so the chat's mode chip and prompt chips went away with no way back, and the bubbles
// sat along the left edge of a 956 pt screen.
describe('chat chrome on a phone on its side', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  async function mountChat() {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          available: true,
          agent: 'claude',
          status: 'idle',
          title: 'Números',
          messages: [{ role: 'user', text: 'hola', timestamp: new Date().toISOString() }],
        }),
      }))
    );
    const view = document.createElement('claude-chat-view') as ClaudeChatView;
    view.sessionId = 's';
    view.getScreenTail = () => '⏵⏵ bypass permissions on';
    document.body.appendChild(view);
    const internals = view as unknown as { loaded: boolean };
    await vi.waitFor(() => expect(internals.loaded).toBe(true));
    await vi.waitFor(() =>
      expect(view.shadowRoot?.querySelector('[data-testid="mode-chip"]')).not.toBeNull()
    );
    return view;
  }

  it('the conversation is the centred column (reflected for its styles)', async () => {
    const view = await mountChat();
    expect(view.hasAttribute('landscape')).toBe(false);
    view.landscape = true;
    await view.updateComplete;
    expect(view.hasAttribute('landscape')).toBe(true);
  });

  it('a short pane keeps the mode chip, floating over the conversation instead of a row', async () => {
    const view = await mountChat();
    view.compactChrome = true;
    view.landscape = true;
    await view.updateComplete;
    const chip = view.shadowRoot?.querySelector('[data-testid="mode-chip"]');
    expect(chip?.closest('.mode-row')?.classList.contains('floating')).toBe(true);
    expect(chip?.closest('.scroll-area')).not.toBeNull();
    expect(view.shadowRoot?.querySelector('.scroll-area')?.classList.contains('with-mode')).toBe(
      true
    );
    // The title bar stays out: the one-line session header names it.
    expect(view.shadowRoot?.querySelector('.top')).toBeNull();

    // Upright with a short pane (an SE with the keyboard open): no chip, as before.
    view.landscape = false;
    await view.updateComplete;
    expect(view.shadowRoot?.querySelector('[data-testid="mode-chip"]')).toBeNull();
  });

  async function mountComposer() {
    const composer = new TerminalChatView();
    composer.composerOnly = true;
    composer.claudeSession = true;
    composer.compactChrome = true;
    composer.landscape = true;
    document.body.append(composer);
    await composer.updateComplete;
    return composer;
  }

  const tap = async (composer: TerminalChatView, element: Element | null | undefined) => {
    element?.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    await composer.updateComplete;
  };

  it('the prompt chips open from the composer as one slim row', async () => {
    const composer = await mountComposer();
    const root = () => composer.shadowRoot;
    expect(root()?.querySelector('.quick-prompts')).toBeNull();
    const toggle = root()?.querySelector('[data-testid="quick-prompts-toggle"]');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(toggle?.getAttribute('aria-label')).toBe('Quick prompts');

    await tap(composer, toggle);
    const row = root()?.querySelector('.quick-prompts');
    expect(row?.classList.contains('slim')).toBe(true);
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');

    await tap(composer, toggle);
    expect(root()?.querySelector('.quick-prompts')).toBeNull();
  });

  it('a prompt sent from the slim row closes it', async () => {
    const composer = await mountComposer();
    const sent: string[] = [];
    composer.onSend = (data) => sent.push(data);
    await tap(composer, composer.shadowRoot?.querySelector('[data-testid="quick-prompts-toggle"]'));
    await tap(composer, composer.shadowRoot?.querySelector('.quick-prompt:not(.edit)'));
    expect(sent.length).toBe(1);
    expect(composer.shadowRoot?.querySelector('.quick-prompts')).toBeNull();
  });

  it('upright, or with room, there is no button: the chips are a row or gone as before', async () => {
    const composer = await mountComposer();
    composer.landscape = false;
    await composer.updateComplete;
    expect(composer.shadowRoot?.querySelector('[data-testid="quick-prompts-toggle"]')).toBeNull();
    expect(composer.shadowRoot?.querySelector('.quick-prompts')).toBeNull();

    composer.landscape = true;
    composer.compactChrome = false;
    await composer.updateComplete;
    expect(composer.shadowRoot?.querySelector('[data-testid="quick-prompts-toggle"]')).toBeNull();
    expect(composer.shadowRoot?.querySelector('.quick-prompts')?.classList.contains('slim')).toBe(
      false
    );
  });
});
