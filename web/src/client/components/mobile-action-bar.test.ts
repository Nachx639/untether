/**
 * @vitest-environment happy-dom
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fixture, html } from '@open-wc/testing';
import { describe, expect, it, vi } from 'vitest';
import type { Session } from '../../shared/types.js';
import {
  BottomChrome,
  type MobileActionBar,
  type MobileActionBarCallbacks,
} from './mobile-action-bar.js';
import { OPEN_SESSION_MENU_EVENT } from './session-view/compact-menu.js';
import './mobile-action-bar.js';

async function renderBar() {
  const onShowKeyboard = vi.fn();
  const bar = await fixture<MobileActionBar>(html`
    <mobile-action-bar .callbacks=${{ onShowKeyboard } as unknown as MobileActionBarCallbacks}></mobile-action-bar>
  `);
  // detectMobile() is false under happy-dom.
  (bar as unknown as { isMobile: boolean }).isMobile = true;
  await bar.updateComplete;
  const button = bar.querySelector<HTMLButtonElement>('button[aria-label="Keyboard"]');
  if (!button) throw new Error('keyboard button not rendered');
  return { button, onShowKeyboard };
}

describe('MobileActionBar keyboard button', () => {
  it('opens the keyboard once from touchend, ignoring the pointer and click that follow', async () => {
    const { button, onShowKeyboard } = await renderBar();

    button.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }));
    button.dispatchEvent(new Event('pointerup', { bubbles: true, cancelable: true }));
    expect(onShowKeyboard).not.toHaveBeenCalled();

    const touchEnd = new Event('touchend', { bubbles: true, cancelable: true });
    button.dispatchEvent(touchEnd);
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(onShowKeyboard).toHaveBeenCalledOnce();
    expect(touchEnd.defaultPrevented).toBe(true);
  });

  it('opens the keyboard when a tap lands on the real field over the button', async () => {
    const { button, onShowKeyboard } = await renderBar();
    const proxy = button.parentElement?.querySelector('textarea');
    vi.useFakeTimers();

    try {
      proxy?.focus();
      // The click that follows the tap is swallowed, not a second activation.
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

      expect(onShowKeyboard).toHaveBeenCalledOnce();
    } finally {
      vi.runAllTimers();
      vi.useRealTimers();
    }
  });

  it('opens the keyboard from a mouse click', async () => {
    const { button, onShowKeyboard } = await renderBar();

    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(onShowKeyboard).toHaveBeenCalledOnce();
  });
});

describe('MobileActionBar buttons', () => {
  it('pastes on a tap, not at the end of a drag that started on Paste', async () => {
    const onPasteFromClipboard = vi.fn();
    const bar = await fixture<MobileActionBar>(html`
      <mobile-action-bar .callbacks=${{ onPasteFromClipboard } as unknown as MobileActionBarCallbacks}></mobile-action-bar>
    `);
    (bar as unknown as { isMobile: boolean }).isMobile = true;
    await bar.updateComplete;
    const paste = bar.querySelector('button[aria-label="Paste"]') as HTMLButtonElement;
    // iOS ends a drag that began on a button with a pointerup on it.
    const touch = (dy: number) => {
      const at = (y: number) => ({
        pointerType: 'touch',
        pointerId: 7,
        clientX: 120,
        clientY: y,
        bubbles: true,
        cancelable: true,
      });
      paste.dispatchEvent(new PointerEvent('pointerdown', at(700)));
      paste.dispatchEvent(new PointerEvent('pointerup', at(700 + dy)));
    };
    touch(-100);
    expect(onPasteFromClipboard).not.toHaveBeenCalled();
    touch(2);
    expect(onPasteFromClipboard).toHaveBeenCalledOnce();
    // The click that follows the tap does not paste a second time.
    paste.click();
    expect(onPasteFromClipboard).toHaveBeenCalledOnce();
  });

  it('a keyboard / VoiceOver activation (a click with no pointer before it) acts', async () => {
    const onPasteFromClipboard = vi.fn();
    const bar = await fixture<MobileActionBar>(html`
      <mobile-action-bar .callbacks=${{ onPasteFromClipboard } as unknown as MobileActionBarCallbacks}></mobile-action-bar>
    `);
    (bar as unknown as { isMobile: boolean }).isMobile = true;
    await bar.updateComplete;
    (bar.querySelector('button[aria-label="Paste"]') as HTMLButtonElement).click();
    expect(onPasteFromClipboard).toHaveBeenCalledOnce();
  });
});

// Phone spec 3.3 (2026-10-12): a toolbar of at most five evenly spaced 44 px icon buttons with
// 11 px labels, an amber Responder pill while the agent waits, side safe areas, hidden while
// the keyboard is up, and its height published for the toasts.
describe('MobileActionBar toolbar', () => {
  const mount = async (session: Partial<Session> | null, keyboardVisible = false) => {
    const bar = await fixture<MobileActionBar>(html`
      <mobile-action-bar
        .session=${session as Session}
        .keyboardVisible=${keyboardVisible}
        .callbacks=${{} as MobileActionBarCallbacks}
      ></mobile-action-bar>
    `);
    (bar as unknown as { isMobile: boolean }).isMobile = true;
    bar.requestUpdate();
    await bar.updateComplete;
    return bar;
  };
  const ids = (bar: HTMLElement) =>
    [...bar.querySelectorAll('[data-testid^="action-bar-"]')].map((el) =>
      el.getAttribute('data-testid')
    );

  it('shows Keyboard, Paste, Files and ⋯ as icon buttons, Preview only with a port', async () => {
    const bar = await mount({ id: 's', status: 'running' });
    expect(bar.querySelector('[role="toolbar"]')).not.toBeNull();
    expect(ids(bar)).toEqual([
      'action-bar-keyboard',
      'action-bar-clipboard',
      'action-bar-files',
      'action-bar-more',
    ]);
    for (const button of bar.querySelectorAll('.ut-ab-btn')) {
      expect(button.querySelector('svg')).not.toBeNull();
      expect(button.querySelector('.ut-ab-label')).not.toBeNull();
    }
    // No emoji, no Theme, no chevron popover.
    expect(bar.textContent).not.toMatch(/[⌨📋📁⚙🌓➕]/u);
    expect(bar.querySelector('[aria-expanded]')).toBeNull();

    const withPreview = await mount({
      id: 'p',
      status: 'running',
      previewPorts: [{ port: 5173, source: 'ut-open', at: 1 }],
    });
    expect(ids(withPreview)).toContain('action-bar-preview');
    expect(ids(withPreview).length).toBeLessThanOrEqual(5);
  });

  it('turns the middle slots into Responder while the agent waits', async () => {
    const bar = await mount({
      id: 'w',
      status: 'running',
      claudeStatus: { status: 'waiting', waitingFor: 'permission prompt' },
    });
    expect(ids(bar)).toEqual([
      'action-bar-keyboard',
      'action-bar-clipboard',
      'action-bar-reply',
      'action-bar-more',
    ]);
    const opened = vi.fn();
    window.addEventListener('ut-open-answer-sheet', opened);
    try {
      bar.querySelector<HTMLButtonElement>('[data-testid="action-bar-reply"]')?.click();
      expect((opened.mock.calls[0][0] as CustomEvent).detail).toEqual({ sessionId: 'w' });
    } finally {
      window.removeEventListener('ut-open-answer-sheet', opened);
    }
  });

  it('opens the session sheet from ⋯', async () => {
    const bar = await mount({ id: 's', status: 'running' });
    const opened = vi.fn();
    window.addEventListener(OPEN_SESSION_MENU_EVENT, opened);
    try {
      const more = bar.querySelector('[data-testid="action-bar-more"]') as HTMLElement;
      const at = { pointerType: 'touch', pointerId: 3, clientX: 5, clientY: 5, bubbles: true };
      more.dispatchEvent(new PointerEvent('pointerdown', at));
      more.dispatchEvent(new PointerEvent('pointerup', at));
      expect(opened).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(OPEN_SESSION_MENU_EVENT, opened);
    }
  });

  it('hides while the soft keyboard is up', async () => {
    const bar = await mount({ id: 's', status: 'running' }, true);
    expect(bar.querySelector('.ut-action-bar')).toBeNull();
  });

  it('pads its sides by the safe areas, at least 8 px (landscape notch)', () => {
    const css = readFileSync(resolve(__dirname, '../styles/session.css'), 'utf8');
    const rule = css.slice(
      css.indexOf('.ut-action-bar {'),
      css.indexOf('}', css.indexOf('.ut-action-bar {'))
    );
    expect(rule).toContain('max(8px, env(safe-area-inset-right, 0px))');
    expect(rule).toContain('max(8px, env(safe-area-inset-left, 0px))');
    expect(rule).toContain('env(safe-area-inset-bottom, 0px)');
    expect(rule).toContain('font-family: var(--font-ui)');
  });

  it('publishes its height as --ut-bottom-chrome and gives it back only if still its own', () => {
    const root = document.documentElement.style;
    const bar = new BottomChrome();
    const keys = new BottomChrome();
    bar.set(49);
    expect(root.getPropertyValue('--ut-bottom-chrome')).toBe('49px');
    keys.set(99);
    bar.clear();
    expect(root.getPropertyValue('--ut-bottom-chrome')).toBe('99px');
    keys.clear();
    expect(root.getPropertyValue('--ut-bottom-chrome')).toBe('0px');
  });
});
