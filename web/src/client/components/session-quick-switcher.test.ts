// @vitest-environment happy-dom
import { fixture, fixtureCleanup, html } from '@open-wc/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMockSession } from '../../test/utils/lit-test-utils.js';
import { setLocale } from '../i18n/index.js';
import { repoFamilies, type SessionQuickSwitcher } from './session-quick-switcher.js';
import './session-quick-switcher.js';

describe('session-quick-switcher', () => {
  afterEach(async () => {
    await setLocale('en');
    fixtureCleanup();
  });

  it('prompts and reports no matches in the chosen language, and follows a language change', async () => {
    await setLocale('es');
    const switcher = await fixture<SessionQuickSwitcher>(
      html`<session-quick-switcher
        visible
        .sessions=${[createMockSession({ name: 'api' })]}
      ></session-quick-switcher>`
    );
    const input = switcher.querySelector('input') as HTMLInputElement;
    expect(input.placeholder).toBe('Buscar o saltar a sesión…');
    await vi.waitFor(() =>
      expect(switcher.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe(
        'Cambio rápido de sesión'
      )
    );

    input.value = 'zzz';
    input.dispatchEvent(new Event('input'));
    await switcher.updateComplete;
    expect(switcher.textContent).toContain('Ninguna sesión coincide');

    await setLocale('en');
    await switcher.updateComplete;
    expect(input.placeholder).toBe('Search or jump to session…');
    expect(switcher.textContent).toContain('No matching sessions');
  });

  it('renders the input inside a real dialog, with sessions, actions and quick starts', async () => {
    const switcher = await fixture<SessionQuickSwitcher>(
      html`<session-quick-switcher
        visible
        .sessions=${[
          createMockSession({ id: 'a', name: '\u001b[1mapi\u001b[0m', command: ['/usr/bin/zsh'] }),
        ]}
      ></session-quick-switcher>`
    );
    await vi.waitFor(() => expect(switcher.querySelector('[role="dialog"]')).not.toBeNull());
    const input = switcher.querySelector('#quick-switcher-input') as HTMLInputElement;
    const dialog = input.closest('[role="dialog"]') as HTMLElement;
    expect(dialog).not.toBeNull();
    // happy-dom does no layout, so no real height: check the dialog box IS the palette (the
    // 2026-10 bug was an empty 512x2 box beside the content) and holds the list.
    expect(dialog.classList.contains('ut-dialog--palette')).toBe(true);
    expect(dialog.contains(switcher.querySelector('.ut-palette-list'))).toBe(true);

    const rows = [...switcher.querySelectorAll<HTMLElement>('.ut-pal-row')];
    expect(rows.map((row) => row.dataset.kind)).toEqual(
      expect.arrayContaining(['session', 'action', 'quick'])
    );
    // ANSI is stripped from names.
    expect(rows[0].textContent).toContain('api');
    expect(rows[0].textContent).not.toContain('\u001b');
    expect(rows[0].getAttribute('aria-selected')).toBe('true');

    const action = vi.fn();
    switcher.addEventListener('palette-action', (e) => action((e as CustomEvent).detail.action));
    await setLocale('es');
    input.value = 'ajustes';
    input.dispatchEvent(new Event('input'));
    await switcher.updateComplete;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(action).toHaveBeenCalledWith('settings');
  });

  // QA 2026-10-12: two rows the sidebar files under one repo were labelled differently.
  it('labels sessions with the repo family the sidebar groups them by', async () => {
    const worktree = {
      ...createMockSession({ id: 'a', name: 'git log' }),
      gitRepoPath: '/p/untether-design',
      gitMainRepoPath: '/p/untether',
    };
    const nested = {
      ...createMockSession({ id: 'b', name: 'shell' }),
      gitRepoPath: '/p/untether-design',
      gitMainRepoPath: '/p/untether-design',
      gitBranch: 'main',
    };
    expect([...repoFamilies([worktree, nested]).values()]).toEqual(['/p/untether', '/p/untether']);
    const switcher = await fixture<SessionQuickSwitcher>(
      html`<session-quick-switcher visible .sessions=${[worktree, nested]}></session-quick-switcher>`
    );
    const where = [...switcher.querySelectorAll('.ut-pal-where')].map((el) =>
      el.textContent?.trim()
    );
    expect(where).toContain('untether');
    expect(where).toContain('untether · main');
    expect(where).not.toContain('untether-design');
  });
});
