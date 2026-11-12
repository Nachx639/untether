// @vitest-environment happy-dom
import { fixture, html } from '@open-wc/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../../shared/types.js';
import type { CompactMenu } from './compact-menu.js';
import './compact-menu.js';

const running = { id: 's1', status: 'running', command: ['claude'] } as Session;

async function openDesktop(extra: { onTalk?: () => void; onUploadImage?: () => void }) {
  const menu = await fixture<CompactMenu>(
    html`<compact-menu
      desktop
      .session=${running}
      .onTalk=${extra.onTalk}
      .onUploadImage=${extra.onUploadImage}
      .onTerminateSession=${() => {}}
    ></compact-menu>`
  );
  (menu.querySelector('button[data-menu-button]') as HTMLElement).click();
  await menu.updateComplete;
  return menu;
}

describe('compact menu on the desktop', () => {
  it('offers «Conversar» like the phone sheet', async () => {
    vi.useFakeTimers();
    try {
      const onTalk = vi.fn();
      const menu = await openDesktop({ onTalk });
      const item = menu.querySelector<HTMLElement>('[data-testid="voice-copilot-menu-button"]');
      expect(item).not.toBeNull();
      item?.click();
      vi.runAllTimers();
      expect(onTalk).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('opens the image picker inside the tap (no timer: iOS blocks input.click() after one)', async () => {
    const onUploadImage = vi.fn();
    const menu = await openDesktop({ onUploadImage });
    menu.querySelector<HTMLElement>('[data-testid="compact-upload-image"]')?.click();
    expect(onUploadImage).toHaveBeenCalledTimes(1);
  });
});

describe('a compact menu removed while open (2026-11-03)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const sheet of document.querySelectorAll('[data-testid="session-menu-sheet"]')) {
      sheet.remove();
    }
  });

  const resizeListeners = (spy: ReturnType<typeof vi.spyOn>) =>
    spy.mock.calls.filter(([type]) => type === 'resize').length;

  it('desktop: a late update attaches nothing to the window', async () => {
    // session-view.test.ts, load 177: a late update of the menu ran after the file's teardown
    // and threw on the missing window; in the app it left a resize listener behind.
    const menu = await openDesktop({});
    expect(menu.querySelector('#compact-menu-panel')).not.toBeNull();
    const added = vi.spyOn(window, 'addEventListener');
    const removed = vi.spyOn(window, 'removeEventListener');
    menu.remove();
    const removedOnDisconnect = resizeListeners(removed);
    expect(removedOnDisconnect).toBe(1);
    menu.session = { ...running, name: 'renamed' } as Session;
    await menu.updateComplete;
    expect(resizeListeners(added)).toBe(0);
    expect(resizeListeners(removed)).toBe(removedOnDisconnect);
  });

  it('phone: a late update never puts the sheet back in <body>', async () => {
    const menu = await fixture<CompactMenu>(
      html`<compact-menu .session=${running} .onTerminateSession=${() => {}}></compact-menu>`
    );
    (menu.querySelector('button[data-menu-button]') as HTMLElement).click();
    await menu.updateComplete;
    expect(document.querySelector('[data-testid="session-menu-sheet"]')).not.toBeNull();
    menu.remove();
    expect(document.querySelector('[data-testid="session-menu-sheet"]')).toBeNull();
    menu.session = { ...running, name: 'renamed' } as Session;
    await menu.updateComplete;
    expect(document.querySelector('[data-testid="session-menu-sheet"]')).toBeNull();
  });

  it('comes back closed when put on the page again', async () => {
    const menu = await openDesktop({});
    const parent = menu.parentElement as HTMLElement;
    menu.remove();
    parent.append(menu);
    await menu.updateComplete;
    expect(menu.querySelector('#compact-menu-panel')).toBeNull();
  });
});
