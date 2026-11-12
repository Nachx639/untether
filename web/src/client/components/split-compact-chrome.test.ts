// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeChatView } from './claude-chat-view.js';
import './claude-chat-view.js';
import { TerminalChatView } from './terminal-chat-view.js';

// Under a split preview on a small phone the session pane is short; the chat keeps only the
// conversation and the composer (an SE showed no messages at all, 2026-10-03).
describe('compact chrome (short pane under a split preview)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('Claude chat drops its title bar and permission-mode row', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          available: true,
          agent: 'claude',
          status: 'idle',
          title: 'Descripción de carpeta',
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
    expect(view.shadowRoot?.querySelector('.top')).not.toBeNull();

    view.compactChrome = true;
    await view.updateComplete;
    expect(view.shadowRoot?.querySelector('[data-testid="mode-chip"]')).toBeNull();
    expect(view.shadowRoot?.querySelector('.top')).toBeNull();
  });

  it('the composer drops its prompt chips', async () => {
    const composer = new TerminalChatView();
    composer.composerOnly = true;
    composer.claudeSession = true;
    document.body.append(composer);
    await composer.updateComplete;
    expect(composer.shadowRoot?.querySelector('.quick-prompts')).not.toBeNull();

    composer.compactChrome = true;
    await composer.updateComplete;
    expect(composer.shadowRoot?.querySelector('.quick-prompts')).toBeNull();
  });
});
