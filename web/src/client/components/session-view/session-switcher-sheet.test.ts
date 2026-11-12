// @vitest-environment happy-dom

import { fixture, html } from '@open-wc/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockSession } from '@/test/utils/lit-test-utils';
import type { Session } from '../../../shared/types.js';
import type { SessionHeader } from './session-header.js';
import { closeSessionSwitcher } from './session-switcher-sheet.js';

vi.mock('../../services/terminal-socket-client.js', () => ({
  terminalSocketClient: {
    initialize: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    getConnectionStatus: vi.fn(() => true),
    onConnectionStateChange: vi.fn(() => () => {}),
  },
}));

const sendAIPrompt = vi.hoisted(() =>
  vi.fn<typeof import('../../utils/ai-sessions.js').sendAIPrompt>(() => Promise.resolve())
);
vi.mock('../../utils/ai-sessions.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/ai-sessions.js')>()),
  sendAIPrompt,
}));

import './session-header.js';

function session(id: string, extra: Partial<Session> = {}): Session {
  return {
    ...createMockSession({ id, name: `name ${id}`, command: ['claude'] }),
    ...extra,
  };
}

function pointer(type: string, target: Element, pointerType: string, x = 10, y = 10) {
  target.dispatchEvent(
    new PointerEvent(type, { bubbles: true, pointerType, clientX: x, clientY: y })
  );
}

describe('session switcher sheet (phone header)', () => {
  let header: SessionHeader;
  const current = session('current', { claudeStatus: { status: 'idle' } });
  const working = session('working', {
    claudeStatus: { status: 'busy' },
    claudeTitle: 'Refactor auth',
    lastModified: '2026-10-02T10:00:00Z',
  });
  const waiting = session('waiting', {
    claudeStatus: { status: 'waiting', waitingFor: 'permission prompt' },
    lastModified: '2026-10-02T09:00:00Z',
  });
  const exited = session('exited', { status: 'exited' });

  beforeEach(async () => {
    localStorage.clear();
    header = await fixture<SessionHeader>(html`
      <session-header
        .session=${current}
        .sessions=${[current, working, waiting, exited]}
        .isMobile=${true}
      ></session-header>
    `);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    closeSessionSwitcher();
    header.remove();
  });

  const open = () =>
    header.querySelector<HTMLButtonElement>('[data-testid="header-phone-title"]')?.click();
  const items = () => [
    ...document.body.querySelectorAll<HTMLButtonElement>('[data-testid="switcher-item"]'),
  ];

  it('lists the other running sessions in <body>, the one that needs you first', () => {
    open();
    const sheet = document.body.querySelector('[data-testid="session-switcher"]');
    expect(sheet?.parentElement).toBe(document.body);
    expect(items().map((item) => item.dataset.sessionId)).toEqual(['waiting', 'working']);
    expect(items()[0]?.textContent).toContain('Needs you · Permission request');
    expect(items()[1]?.textContent).toContain('Refactor auth');
  });

  // Phone spec 4.2 (2026-10-12): the session on screen first, checked on the selected tint;
  // every row carries the shared status pill; a grabber to swipe the sheet away.
  it('puts the current session first with a check, and a status pill on every row', () => {
    open();
    const list = document.body.querySelector('.ut-switch-list');
    const first = list?.firstElementChild as HTMLElement | null;
    expect(first?.dataset.testid).toBe('switcher-current');
    expect(first?.getAttribute('aria-current')).toBe('true');
    expect(first?.querySelector('.ut-switch-check svg')).not.toBeNull();
    for (const row of items()) {
      expect(row.querySelector('.ut-status .ut-dot')).not.toBeNull();
    }
    expect(items()[0]?.querySelector('.ut-status')?.getAttribute('data-status')).toBe(
      'needs-input'
    );
    expect(
      document.body.querySelector('[data-testid="session-switcher"] .ut-sheet-grabber')
    ).not.toBeNull();
    // Neutral avatars: an agent glyph, no hashed hue.
    expect(document.body.querySelector('.ut-switch-avatar [style*="--tool-hue"]')).toBeNull();
  });

  it('closes on a swipe down from the grabber with touch events (iOS cancels pointer events)', () => {
    open();
    const grabber = document.body.querySelector<HTMLElement>(
      '[data-testid="session-switcher"] .ut-sheet-grabber'
    );
    expect(grabber?.hasAttribute('data-sheet-handle')).toBe(true);
    const touch = (type: string, y: number) => {
      const event = new Event(type, { bubbles: true, cancelable: true }) as Event & {
        touches: Array<{ clientX: number; clientY: number }>;
      };
      event.touches = type === 'touchend' ? [] : [{ clientX: 100, clientY: y }];
      grabber?.dispatchEvent(event);
      return event;
    };
    touch('touchstart', 10);
    // Once the sheet follows the finger the native pan is cancelled.
    expect(touch('touchmove', 200).defaultPrevented).toBe(true);
    touch('touchend', 200);
    expect(document.body.querySelector('[data-testid="session-switcher"]')).toBeNull();
  });

  it('jumps to a session on touch pointerup and ignores the trailing click', () => {
    const navigate = vi.fn();
    header.addEventListener('navigate-to-session', (e) =>
      navigate((e as CustomEvent).detail.sessionId)
    );
    open();
    const target = items()[1] as HTMLButtonElement;
    pointer('pointerdown', target, 'touch');
    pointer('pointerup', target, 'touch');
    target.click();

    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('working');
    expect(document.body.querySelector('[data-testid="session-switcher"]')).toBeNull();
  });

  it('does not jump when the touch was a scroll of the list', () => {
    const navigate = vi.fn();
    header.addEventListener('navigate-to-session', navigate);
    open();
    const target = items()[0] as HTMLButtonElement;
    pointer('pointerdown', target, 'touch', 10, 10);
    pointer('pointerup', target, 'touch', 10, 60);

    expect(navigate).not.toHaveBeenCalled();
  });

  /** The view answers the header's retitle request with the API's result. */
  const answerRetitles = (result: { success: boolean; error?: string }) => {
    const retitle = vi.fn();
    header.addEventListener('session-retitle', (e) => {
      const { done, ...detail } = (e as CustomEvent).detail;
      retitle(detail);
      e.preventDefault();
      queueMicrotask(() => done?.(result));
    });
    return retitle;
  };
  const field = () =>
    document.body.querySelector<HTMLElement>('[data-testid="switcher-rename-field"]');
  const renameInput = () =>
    document.body.querySelector<HTMLInputElement>(
      '[data-testid="rename-input"]'
    ) as HTMLInputElement;
  const startRename = async () => {
    open();
    document.body.querySelector<HTMLButtonElement>('[data-testid="switcher-rename"]')?.click();
    await vi.waitFor(() => expect(renameInput()).not.toBeNull());
  };

  it('renames the title on screen in place: the row becomes a field that starts with it', async () => {
    const prompt = vi.fn();
    vi.stubGlobal('prompt', prompt);
    const retitle = answerRetitles({ success: true });
    open();
    expect(document.body.querySelector('[data-testid="switcher-reset-title"]')).toBeNull();
    await startRename();
    expect(document.body.querySelector('[data-testid="switcher-rename"]')).toBeNull();
    expect(renameInput().value).toBe('name current');
    expect(document.activeElement).toBe(renameInput());

    renameInput().value = 'New name';
    renameInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() =>
      expect(document.body.querySelector('[data-testid="session-switcher"]')).toBeNull()
    );
    expect(retitle).toHaveBeenCalledWith({ sessionId: 'current', userTitle: 'New name' });
    expect(prompt).not.toHaveBeenCalled();
  });

  it('Cancel turns the field back into the Rename row, the sheet still open', async () => {
    const retitle = answerRetitles({ success: true });
    await startRename();
    document.body.querySelector<HTMLButtonElement>('[data-testid="rename-cancel"]')?.click();
    expect(field()).toBeNull();
    expect(document.body.querySelector('[data-testid="switcher-rename"]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="session-switcher"]')).not.toBeNull();
    expect(retitle).not.toHaveBeenCalled();
  });

  it('a failed rename says why in the field and keeps the sheet open', async () => {
    answerRetitles({ success: false, error: 'Rename failed: 500' });
    await startRename();
    renameInput().value = 'New name';
    document.body.querySelector<HTMLButtonElement>('[data-testid="rename-ok"]')?.click();
    await vi.waitFor(() =>
      expect(document.body.querySelector('[data-testid="rename-error"]')?.textContent?.trim()).toBe(
        'Failed to rename session: Rename failed: 500'
      )
    );
    expect(field()).not.toBeNull();
  });

  it("offers Claude's title back once the user named the session", async () => {
    header.session = { ...current, userTitle: 'Mine', claudeTitle: 'Fix login' };
    await header.updateComplete;
    const retitle = vi.fn();
    header.addEventListener('session-retitle', (e) => retitle((e as CustomEvent).detail));
    open();
    const reset = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="switcher-reset-title"]'
    );
    expect(reset?.textContent?.trim()).toBe("Use Claude's title");
    reset?.click();

    expect(retitle).toHaveBeenCalledWith({ sessionId: 'current', userTitle: null });
  });

  it('offers the AI title update that the desktop header has as a wand', () => {
    open();
    const button = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="switcher-update-title"]'
    );
    pointer('pointerdown', button as HTMLButtonElement, 'touch');
    pointer('pointerup', button as HTMLButtonElement, 'touch');
    button?.click();

    expect(sendAIPrompt).toHaveBeenCalledTimes(1);
    expect(sendAIPrompt.mock.calls[0]?.[0]).toBe('current');
  });
});
