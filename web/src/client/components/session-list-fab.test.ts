// @vitest-environment happy-dom
import { fixture, fixtureCleanup, html } from '@open-wc/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../shared/types.js';
import { readStylesheet } from '../../test/utils/stylesheets.js';
import type { AuthClient } from '../services/auth-client.js';
import './session-list.js';
import { lazyViews } from '../utils/lazy-views.js';
import { SessionList } from './session-list.js';

// 2026-10-12 (phone-spec 3.3): the floating "+" that had to dodge rows, and the footer with
// counts, "Mostrar" and "Cerrar todas", became one bottom tab bar: Sesiones | Agentes and "+".
const session = (overrides: Partial<Session> = {}) =>
  ({
    id: 's1',
    name: 'bar',
    command: ['zsh'],
    workingDir: '/tmp',
    status: 'running',
    startedAt: new Date().toISOString(),
    lastModified: new Date().toISOString(),
    ...overrides,
  }) as unknown as Session;

describe('phone bottom tab bar', () => {
  beforeEach(() => {
    vi.spyOn(
      SessionList.prototype as unknown as { usePhoneRows: () => boolean },
      'usePhoneRows'
    ).mockReturnValue(true);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({}))
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    fixtureCleanup();
    document.documentElement.style.removeProperty('--ut-bottom-chrome');
    for (const host of document.body.querySelectorAll('.ut-phone-sheet-host')) host.remove();
  });

  async function mount(sessions: Session[] = [session()], compactMode = false) {
    const list = await fixture<SessionList>(
      html`<session-list
        .sessions=${sessions}
        .compactMode=${compactMode}
        .authClient=${{ getAuthHeader: () => ({}) } as unknown as AuthClient}
      ></session-list>`
    );
    await list.updateComplete;
    return list;
  }

  const bar = (list: SessionList) =>
    list.querySelector<HTMLElement>('[data-testid="session-list-footer"]');

  it('holds the two tabs and the one "+", and none of the old footer', async () => {
    const list = await mount([session(), session({ id: 'x', status: 'exited' })]);
    const footer = bar(list);
    expect(footer).not.toBeNull();
    expect(
      footer?.querySelector('[data-testid="tab-sessions"]')?.getAttribute('aria-selected')
    ).toBe('true');
    expect(footer?.querySelector('[data-testid="tab-agents"]')).not.toBeNull();
    expect(footer?.querySelector('[data-testid="phone-new-session"]')).not.toBeNull();
    // Counts, "Mostrar" and "Cerrar todas" are gone (the header's ⋯ closes them all).
    expect(
      footer?.querySelector('#show-exited-toggle, [data-testid="kill-all-button"]')
    ).toBeNull();
    expect(footer?.textContent).not.toMatch(/\d+ (running|activas)/);
    expect(list.querySelector('[data-testid="new-session-fab"], .new-chat-fab')).toBeNull();
  });

  it('counts the agents that need you on the Agentes tab', async () => {
    const list = await mount([
      session({ id: 'w', command: ['claude'], claudeStatus: { status: 'waiting' } as never }),
    ]);
    expect(bar(list)?.querySelector('[data-testid="tab-agents"]')?.textContent).toContain('1');
  });

  it('"+" asks first: Sesión (today\'s sheet) or Tarea (the compose sheet)', async () => {
    const list = await mount();
    const later = () => vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1000);
    bar(list)?.querySelector<HTMLButtonElement>('[data-testid="phone-new-session"]')?.click();
    await list.updateComplete;
    const choice = document.body.querySelector('[data-testid="new-choice-sheet"]');
    expect(choice).not.toBeNull();
    expect(choice?.querySelector('[data-testid="new-choice-session"]')?.textContent).toContain(
      'Session'
    );
    expect(choice?.querySelector('[data-testid="new-choice-task"]')?.textContent).toContain(
      'own branch'
    );

    const now = later();
    document.body.querySelector<HTMLButtonElement>('[data-testid="new-choice-session"]')?.click();
    now.mockRestore();
    await list.updateComplete;
    expect(document.body.querySelector('[data-testid="new-choice-sheet"]')).toBeNull();
    expect(document.body.querySelector('.psr-sheet-title')?.textContent).toBe(
      'What do you want to open?'
    );

    const openTaskComposeSheet = vi.fn();
    vi.spyOn(lazyViews.taskComposeSheet, 'use').mockImplementation((fn) =>
      fn({ openTaskComposeSheet } as never)
    );
    bar(list)?.querySelector<HTMLButtonElement>('[data-testid="phone-new-session"]')?.click();
    await list.updateComplete;
    const again = later();
    document.body.querySelector<HTMLButtonElement>('[data-testid="new-choice-task"]')?.click();
    again.mockRestore();
    expect(openTaskComposeSheet).toHaveBeenCalledTimes(1);
    expect(
      openTaskComposeSheet.mock.calls[0][0].agents.map((a: { agent: string }) => a.agent)
    ).toEqual(['claude']);
  });

  it('«Conversar» opens the copilot over every session, within the tap (user decision)', async () => {
    const openCopilot = vi.fn();
    vi.spyOn(lazyViews.copilotSheet, 'use').mockImplementation((fn) =>
      fn({ openCopilot } as never)
    );
    const list = await mount();
    const talk = list.querySelector<HTMLButtonElement>('#voice-copilot-global-button');
    expect(talk?.closest('[data-testid="session-list-footer"]')).not.toBeNull();
    expect(talk?.textContent).toContain('Talk');
    expect(talk?.querySelector('svg')).not.toBeNull();
    talk?.click();
    expect(openCopilot).toHaveBeenCalledWith({ mode: 'global' });
  });

  it('is not in the sidebar opened from a session', async () => {
    const list = await mount([session()], true);
    expect(bar(list)).toBeNull();
  });

  it('steps aside while a field in the list has focus (kbd-open)', async () => {
    const list = await mount();
    const textarea = list.querySelector('ask-claude-box textarea') as HTMLTextAreaElement;
    textarea.focus();
    textarea.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    await list.updateComplete;
    expect(list.classList.contains('kbd-open')).toBe(true);
    textarea.blur();
    textarea.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(list.classList.contains('kbd-open')).toBe(false);
  });

  it('puts --ut-bottom-chrome back to 0 when it goes away', async () => {
    const list = await mount();
    const footer = bar(list) as HTMLElement;
    footer.getBoundingClientRect = () => ({ height: 83 }) as DOMRect;
    (list as unknown as { publishBottomChrome(): void }).publishBottomChrome();
    expect(document.documentElement.style.getPropertyValue('--ut-bottom-chrome')).toBe('83px');
    list.remove();
    expect(document.documentElement.style.getPropertyValue('--ut-bottom-chrome')).toBe('0px');
  });
});

describe('phone bottom chrome CSS', () => {
  const css = readStylesheet('styles/list.css');

  it('is 49 px plus the bottom safe area, hidden while the keyboard is up', () => {
    expect(css).toMatch(
      /\.ut-tabbar \{[^}]*min-height: var\(--p-bar-h, calc\(49px \+ env\(safe-area-inset-bottom/
    );
    expect(css).toMatch(
      /session-list\.kbd-open \.ut-tabbar,\s*session-list\.kbd-open \.ut-needs--phone \{\s*display: none;/
    );
  });

  it('lives under the left column of a phone on its side', () => {
    expect(css).toMatch(
      /\.main-list-scroll:has\(\.phone-landscape\) \[data-testid='session-list-footer'\] \{\s*grid-column: 1;\s*grid-row: 3;/
    );
  });
});
