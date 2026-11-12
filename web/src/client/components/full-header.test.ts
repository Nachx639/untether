// @vitest-environment happy-dom

import { fixture, html } from '@open-wc/testing';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { FullHeader } from './full-header';

vi.mock('./notification-status.js', () => ({}));

describe('FullHeader', () => {
  beforeAll(async () => {
    await import('./full-header');
  });

  it.each([
    ['password', 'System Account'],
    ['ssh-key', 'SSH Key'],
    ['tailscale', 'Tailscale'],
    [null, 'Authenticated'],
    ['future-auth-method', 'Authenticated'],
  ])('shows a friendly label for the %s auth method', async (authMethod, expectedLabel) => {
    const element = await fixture<FullHeader>(html`
      <full-header .currentUser=${'test-user'} .authMethod=${authMethod}></full-header>
    `);

    const menuButton = element.querySelector<HTMLButtonElement>('[data-testid="account-button"]');
    expect(menuButton?.getAttribute('aria-label')).toBe('User menu');
    menuButton?.click();
    await element.updateComplete;

    expect(element.querySelector('[data-testid="auth-method-label"]')?.textContent?.trim()).toBe(
      expectedLabel
    );
  });

  it('is the desktop toolbar: wordmark without count, search trigger, one primary action, no mono', async () => {
    const element = await fixture<FullHeader>(html`<full-header></full-header>`);
    const header = element.querySelector('[data-testid="home-header"]');
    expect(header).not.toBeNull();
    expect(element.querySelector('.ut-brand-name')?.textContent?.trim()).toBe('Untether');
    expect(element.textContent).not.toMatch(/\(\d+\)/);
    expect(element.querySelector('.font-mono')).toBeNull();
    expect(element.querySelectorAll('.ut-btn--primary')).toHaveLength(1);
    // Icon buttons are borderless and named.
    for (const button of element.querySelectorAll<HTMLButtonElement>(
      '.ut-toolbar > .ut-icon-btn'
    )) {
      expect(button.getAttribute('aria-label')).toBeTruthy();
      expect(button.className).not.toMatch(/\bborder\b/);
    }
    const opened = vi.fn();
    element.addEventListener('open-palette', opened);
    element.querySelector<HTMLButtonElement>('[data-testid="header-search"]')?.click();
    expect(opened).toHaveBeenCalledOnce();
  });

  // 2026-10-12: the row had overflow-hidden and cut the focus ring of every header button.
  it('keeps its buttons out of any overflow-hidden ancestor, so focus rings are whole', async () => {
    const element = await fixture<FullHeader>(html`
      <full-header .currentUser=${'test-user'}></full-header>
    `);
    const buttons = [...element.querySelectorAll<HTMLButtonElement>('button')];
    expect(buttons.length).toBeGreaterThanOrEqual(5);
    for (const button of buttons) {
      for (let el = button.parentElement; el && el !== document.body; el = el.parentElement) {
        expect(el.classList.contains('overflow-hidden'), el.className).toBe(false);
        expect(['hidden', 'clip']).not.toContain(el.style.overflow);
      }
    }
  });

  // QA 2026-10-12: a mouse-opened menu leaves focus on the trigger, outside the menu.
  it('closes the account menu on Escape even when focus is outside it', async () => {
    const element = await fixture<FullHeader>(
      html`<full-header .currentUser=${'alice'}></full-header>`
    );
    element.querySelector<HTMLButtonElement>('[data-testid="account-button"]')?.click();
    await element.updateComplete;
    await element.updateComplete;
    expect(element.querySelector('[data-testid="account-menu"]')).not.toBeNull();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await element.updateComplete;
    expect(element.querySelector('[data-testid="account-menu"]')).toBeNull();
  });

  // 2026-10-12 (phone-spec 3.4): logo + wordmark, one ⋯ opening an action sheet; no "+".
  describe('on a phone', () => {
    const phone = () => {
      vi.spyOn(
        (customElements.get('full-header') as unknown as { prototype: object }).prototype as {
          isPhone(): boolean;
        },
        'isPhone'
      ).mockReturnValue(true);
    };

    it('is the wordmark and one ⋯, with no count, "+" or mono', async () => {
      phone();
      const element = await fixture<FullHeader>(
        html`<full-header .sessions=${[{ id: 'a', status: 'running' }] as never}></full-header>`
      );
      const header = element.querySelector('[data-testid="phone-header"]');
      expect(header?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Untether');
      expect(element.querySelector('[data-testid="create-session-button"]')).toBeNull();
      expect(element.querySelector('.font-mono, theme-toggle-icon')).toBeNull();
      const more = element.querySelector<HTMLButtonElement>('[data-testid="phone-header-more"]');
      expect(more?.classList.contains('ut-icon-btn')).toBe(true);
      more?.click();
      const sheet = document.body.querySelector('[data-testid="phone-header-menu"]');
      expect(sheet?.querySelector('[data-testid="phone-menu-appearance"]')).not.toBeNull();
      expect(
        sheet?.querySelector('[data-testid="kill-all-button"]')?.classList.contains('destructive')
      ).toBe(true);
      sheet?.querySelector<HTMLButtonElement>('.psr-sheet-cancel')?.click();
      vi.restoreAllMocks();
    });

    it('a tap on the title scrolls the list to the top', async () => {
      phone();
      const scroller = await fixture<HTMLElement>(
        html`<div class="main-list-scroll"><full-header></full-header></div>`
      );
      const scrollTo = vi.fn();
      scroller.scrollTo = scrollTo as never;
      scroller.querySelector<HTMLButtonElement>('[data-testid="phone-header-title"]')?.click();
      expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 0 }));
      vi.restoreAllMocks();
    });
  });
});
