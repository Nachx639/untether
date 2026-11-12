/**
 * @vitest-environment happy-dom
 */
import { fixture, html } from '@open-wc/testing';
import { describe, expect, it, vi } from 'vitest';
import type { Session } from '../../../shared/types.js';
import type { OverlaysCallbacks, OverlaysContainer } from './overlays-container.js';
import { UIStateManager } from './ui-state-manager.js';
import './overlays-container.js';

const createCallbacks = (): OverlaysCallbacks => ({
  onCtrlKey: vi.fn(),
  onSendCtrlSequence: vi.fn(),
  onClearCtrlSequence: vi.fn(),
  onCtrlAlphaCancel: vi.fn(),
  onQuickKeyPress: vi.fn(),
  onCloseFileBrowser: vi.fn(),
  onInsertPath: vi.fn(),
  onFileSelected: vi.fn(),
  onFileError: vi.fn(),
  onCloseFilePicker: vi.fn(),
  onWidthSelect: vi.fn(),
  onFontSizeChange: vi.fn(),
  onThemeChange: vi.fn(),
  onCloseWidthSelector: vi.fn(),
});

describe('OverlaysContainer', () => {
  it('does not float a keyboard button over the terminal on mobile', async () => {
    const uiStateManager = new UIStateManager();
    uiStateManager.setIsMobile(true);
    const element = await fixture<OverlaysContainer>(html`
      <overlays-container
        .uiState=${uiStateManager.getState()}
        .callbacks=${createCallbacks()}
      ></overlays-container>
    `);

    expect(element.querySelector('.mobile-keyboard-button')).toBeNull();
  });

  it('leaves "Session ended" to its own layer under the session header', async () => {
    // This container stacks above the header: the badge here covered the ⋮ menu (2026-10-03).
    const uiStateManager = new UIStateManager();
    const element = await fixture<OverlaysContainer>(html`
      <overlays-container
        .session=${{ id: 's', status: 'exited', claudeSessionId: 'c1' } as unknown as Session}
        .uiState=${uiStateManager.getState()}
        .callbacks=${createCallbacks()}
      ></overlays-container>
    `);

    expect(element.textContent).not.toContain('Session exited');
    expect(element.textContent).not.toContain('Resume Claude conversation');
  });
});
