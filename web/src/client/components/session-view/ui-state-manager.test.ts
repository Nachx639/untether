/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  restoreLocalStorage,
  setupLocalStorageMock,
} from '../../../test/utils/component-helpers.js';

const mobile = vi.hoisted(() => ({ value: true }));
vi.mock('../../utils/mobile-utils.js', () => ({ detectMobile: () => mobile.value }));

import { UIStateManager } from './ui-state-manager.js';

describe('UIStateManager chat mode preference', () => {
  beforeEach(() => {
    setupLocalStorageMock();
    mobile.value = true;
  });
  afterEach(() => restoreLocalStorage());

  it('restores the chat mode chosen in a previous session view on phones', () => {
    const first = new UIStateManager();
    first.toggleChatMode();

    const next = new UIStateManager();
    next.loadChatModePreference();
    expect(next.getState().chatMode).toBe(true);

    next.toggleChatMode();
    const after = new UIStateManager();
    after.loadChatModePreference();
    expect(after.getState().chatMode).toBe(false);
  });

  it('never restores chat mode on desktop, where it hides the terminal', () => {
    new UIStateManager().toggleChatMode();
    mobile.value = false;

    const desktop = new UIStateManager();
    desktop.loadChatModePreference();
    expect(desktop.getState().chatMode).toBe(false);
  });
});
