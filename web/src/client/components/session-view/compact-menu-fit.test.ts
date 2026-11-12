// @vitest-environment happy-dom
import { fixture, html } from '@open-wc/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../../shared/types.js';
import { type CompactMenu, OPEN_SESSION_MENU_EVENT } from './compact-menu.js';
import './compact-menu.js';

// Phones (phone spec 4.2, 2026-10-12): the ⋯ menu is a bottom action sheet in <body>, with a
// grabber, grouped 56 px items, a scrolling body that fits the screen, and Cancel apart.
describe('compact menu on a phone', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    for (const sheet of document.querySelectorAll('[data-testid="session-menu-sheet"]')) {
      sheet.remove();
    }
  });

  const openSheet = async (session: Partial<Session> = {}, extra: Record<string, unknown> = {}) => {
    const full = { id: 's1', status: 'running', command: ['zsh'], ...session } as Session;
    const menu = await fixture<CompactMenu>(
      html`<compact-menu
        .session=${full}
        .onShareSession=${() => {}}
        .onShieldSession=${() => {}}
        .onSelectText=${() => {}}
        .onShowChanges=${() => {}}
        .onTerminateSession=${extra.onTerminateSession ?? (() => {})}
        .onWidthSelect=${extra.onWidthSelect}
        .onMaxWidthToggle=${extra.onMaxWidthToggle}
        .onFitOff=${extra.onFitOff}
        .chatToggleInHeader=${Boolean(extra.chatToggleInHeader)}
        .widthLabel=${(extra.widthLabel as string) ?? '∞'}
      ></compact-menu>`
    );
    (menu.querySelector('button[data-menu-button]') as HTMLElement).click();
    await menu.updateComplete;
    const sheet = document.body.querySelector<HTMLElement>(
      '[data-testid="session-menu-sheet"] .psr-sheet'
    );
    return { menu, sheet };
  };

  it('opens a bottom sheet in <body> with a grabber, groups and a separate Cancel', async () => {
    const { sheet } = await openSheet();
    expect(sheet?.getAttribute('role')).toBe('dialog');
    expect(sheet?.querySelector('.ut-sheet-grabber')).not.toBeNull();
    expect(sheet?.querySelector('.ut-session-sheet-scroll')).not.toBeNull();
    const groups = [...(sheet?.querySelectorAll('.psr-sheet-group') ?? [])].map((group) =>
      [...group.querySelectorAll('[data-testid]')].map((el) => el.getAttribute('data-testid'))
    );
    expect(groups[0]).toEqual([
      'compact-file-browser',
      'compact-preview',
      'compact-changes-unavailable',
      'compact-upload-image',
    ]);
    expect(groups[1]).toEqual([
      'compact-select-text',
      'compact-chat-mode-toggle',
      'compact-fit-width',
    ]);
    expect(groups[2]).toEqual(['compact-share-session', 'compact-shield-session']);
    expect(groups[3]).toEqual(['compact-terminate-session']);
    expect(sheet?.querySelector('[data-testid="compact-menu-cancel"]')).not.toBeNull();
    // No theme or accent on the phone menu, no orange items, no mono.
    expect(
      sheet?.querySelector('[data-testid^="compact-theme"], [data-testid^="compact-accent"]')
    ).toBeNull();
    expect(sheet?.querySelector('.text-primary, .text-primary-text, .font-mono')).toBeNull();
    expect(
      sheet
        ?.querySelector('[data-testid="compact-terminate-session"]')
        ?.classList.contains('destructive')
    ).toBe(true);
  });

  it('leaves Chat/Terminal out when the header shows its own toggle', async () => {
    const { sheet } = await openSheet({}, { chatToggleInHeader: true });
    expect(sheet?.querySelector('[data-testid="compact-chat-mode-toggle"]')).toBeNull();
  });

  it('fit to screen is a switch: on at ∞, turning it on picks the screen width', async () => {
    vi.useFakeTimers();
    const onWidthSelect = vi.fn();
    const onMaxWidthToggle = vi.fn();
    const on = await openSheet({}, { onWidthSelect, onMaxWidthToggle });
    const fit = on.sheet?.querySelector('[data-testid="compact-fit-width"]');
    expect(fit?.getAttribute('role')).toBe('switch');
    expect(fit?.getAttribute('aria-checked')).toBe('true');
    on.menu.remove();

    const off = await openSheet({}, { onWidthSelect, onMaxWidthToggle, widthLabel: '80' });
    const fitOff = off.sheet?.querySelector<HTMLElement>('[data-testid="compact-fit-width"]');
    expect(fitOff?.getAttribute('aria-checked')).toBe('false');
    fitOff?.click();
    vi.advanceTimersByTime(100);
    expect(onWidthSelect).toHaveBeenCalledWith(0);
  });

  it('turning fit to screen off goes back to the width used before', async () => {
    vi.useFakeTimers();
    const onFitOff = vi.fn();
    const onMaxWidthToggle = vi.fn();
    const on = await openSheet({}, { onFitOff, onMaxWidthToggle });
    on.sheet?.querySelector<HTMLElement>('[data-testid="compact-fit-width"]')?.click();
    vi.advanceTimersByTime(100);
    expect(onFitOff).toHaveBeenCalledTimes(1);
    expect(onMaxWidthToggle).not.toHaveBeenCalled();
  });

  it('opens from the action bar and closes on Cancel', async () => {
    const menu = await fixture<CompactMenu>(
      html`<compact-menu .session=${{ id: 's2', status: 'running', command: ['zsh'] } as Session}></compact-menu>`
    );
    window.dispatchEvent(new CustomEvent(OPEN_SESSION_MENU_EVENT));
    await menu.updateComplete;
    const cancel = document.body.querySelector<HTMLElement>('[data-testid="compact-menu-cancel"]');
    expect(cancel).not.toBeNull();
    cancel?.click();
    await menu.updateComplete;
    expect(document.body.querySelector('[data-testid="session-menu-sheet"]')).toBeNull();
  });
});

// Desktop ⋯ menu (2026-10-12): a 280 px .ut-menu with groups, clamped to the viewport.
describe('compact menu on the desktop', () => {
  afterEach(() => vi.restoreAllMocks());

  const open = async (session: Partial<Session> = {}, extra: Record<string, unknown> = {}) => {
    const full = { id: 'd1', status: 'running', command: ['zsh'], ...session } as Session;
    const menu = await fixture<CompactMenu>(
      html`<compact-menu
        desktop
        .session=${full}
        .hasGitRepo=${true}
        .onShowChanges=${() => {}}
        .onRename=${() => {}}
        .onSelectText=${() => {}}
        .onShareSession=${() => {}}
        .onShieldSession=${() => {}}
        .onTerminateSession=${extra.onTerminateSession}
        .onOpenSettings=${() => {}}
        .widthLabel=${'∞'}
      ></compact-menu>`
    );
    (menu.querySelector('button[data-menu-button]') as HTMLElement).click();
    await menu.updateComplete;
    return menu;
  };

  it('groups View / Session / Appearance, then Settings and Terminate (danger)', async () => {
    const menu = await open();
    const panel = menu.querySelector('#compact-menu-panel') as HTMLElement;
    expect(panel.classList.contains('ut-menu')).toBe(true);
    expect(panel.classList.contains('ut-session-menu')).toBe(true);
    expect(panel.getAttribute('role')).toBe('menu');
    const labels = [...panel.querySelectorAll('.ut-menu-label')].map((el) =>
      el.textContent?.trim()
    );
    expect(labels).toEqual(['View', 'Session', 'Appearance']);
    const ids = [...panel.querySelectorAll('[data-testid]')].map((el) =>
      el.getAttribute('data-testid')
    );
    expect(ids).toEqual(
      expect.arrayContaining([
        'compact-view-chat',
        'compact-view-terminal',
        'compact-file-browser',
        'compact-changes',
        'compact-worktree-toggle',
        'compact-rename',
        'compact-select-text',
        'compact-width-settings',
        'compact-share-session',
        'compact-theme-toggle',
        'compact-settings',
        'compact-terminate-session',
      ])
    );
    const terminate = panel.querySelector('[data-testid="compact-terminate-session"]');
    expect(terminate?.classList.contains('ut-menu-item--danger')).toBe(true);
    // Terminate is last, after a separator.
    expect(panel.lastElementChild).toBe(terminate);
    expect(panel.querySelector('.font-mono, .text-primary, .text-primary-text')).toBeNull();
    // The width item shows ∞ on its right; Settings shows its shortcut.
    expect(
      panel.querySelector('[data-testid="compact-width-settings"] .ut-menu-trail')?.textContent
    ).toBe('∞');
    expect(
      panel.querySelector('[data-testid="compact-settings"] .ut-menu-trail')?.textContent
    ).toMatch(/⌘,|Ctrl\+,/);
  });

  it('shows Shield as a switch row with its help in the tooltip', async () => {
    const menu = await open();
    const row = menu.querySelector('[data-testid="compact-shield-session"]');
    expect(row?.getAttribute('role')).toBe('menuitemcheckbox');
    expect(row?.getAttribute('aria-checked')).toBe('false');
    expect(row?.getAttribute('title')).toBe('Keeps running if Untether restarts');
    expect(row?.querySelector('.ut-switch')).not.toBeNull();
  });

  it('accent swatches carry the accent caption and mark the selected one', async () => {
    const menu = await open();
    const swatches = [...menu.querySelectorAll('.ut-session-menu-swatch')];
    expect(swatches.length).toBeGreaterThan(3);
    expect(swatches.filter((s) => s.getAttribute('aria-pressed') === 'true')).toHaveLength(1);
    expect(menu.querySelector('.ut-session-menu-caption')?.textContent).toBe('Accent color');
  });

  it('closes on Escape and gives focus back to the ⋯ button', async () => {
    const menu = await open();
    const panel = menu.querySelector('#compact-menu-panel') as HTMLElement;
    panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await menu.updateComplete;
    expect(menu.querySelector('#compact-menu-panel')).toBeNull();
    expect(document.activeElement).toBe(menu.querySelector('button[data-menu-button]'));
  });

  it('runs Terminate from the menu (the handler confirms in the app dialog)', async () => {
    vi.useFakeTimers();
    const onTerminateSession = vi.fn();
    const menu = await open({}, { onTerminateSession });
    (menu.querySelector('[data-testid="compact-terminate-session"]') as HTMLElement).click();
    vi.advanceTimersByTime(100);
    expect(onTerminateSession).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
