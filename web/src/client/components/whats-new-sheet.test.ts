// @vitest-environment happy-dom

import { fixture, html } from '@open-wc/testing';
import { afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { FullHeader } from './full-header';
import {
  closeWhatsNew,
  openWhatsNew,
  shouldAutoShowWhatsNew,
  WHATS_NEW_STORAGE_KEY,
  WHATS_NEW_VERSION,
} from './whats-new-sheet';

vi.mock('./notification-status.js', () => ({}));

function setScreen({ coarse, width, height }: { coarse: boolean; width: number; height: number }) {
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: query.includes('coarse') ? coarse : false,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList
  );
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
}

describe('whats-new sheet', () => {
  beforeAll(async () => {
    await import('./full-header');
  });

  beforeEach(() => {
    // The shared test setup mocks localStorage with no-op spies; this needs a working one.
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, String(value)),
      removeItem: (key: string) => store.delete(key),
      clear: () => store.clear(),
    });
  });

  afterEach(() => {
    closeWhatsNew();
    vi.unstubAllGlobals();
  });

  it('shows once per version on a phone', () => {
    setScreen({ coarse: true, width: 390, height: 844 });
    expect(shouldAutoShowWhatsNew()).toBe(true);

    openWhatsNew();
    expect(document.querySelector('[data-testid="whats-new"]')).not.toBeNull();
    expect(localStorage.getItem(WHATS_NEW_STORAGE_KEY)).toBe(WHATS_NEW_VERSION);
    expect(shouldAutoShowWhatsNew()).toBe(false);

    // A phone that saw an older version sees the new one.
    localStorage.setItem(WHATS_NEW_STORAGE_KEY, '2000-01-01');
    expect(shouldAutoShowWhatsNew()).toBe(true);
  });

  it('shows by itself only the cards added since the version a phone last saw', () => {
    setScreen({ coarse: true, width: 390, height: 844 });
    const cards = () => document.querySelectorAll('.wn-card').length;
    localStorage.setItem(WHATS_NEW_STORAGE_KEY, '2026-10-03f');
    openWhatsNew({ onlyNew: true });
    expect([...document.querySelectorAll('.wn-card-body')].map((el) => el.textContent)).toEqual([
      'tmux sessions and Claude Code, Codex or Gemini running in other terminals now appear in the list. Follow them live, and open a tmux session to type into it.',
    ]);
    closeWhatsNew();
    localStorage.setItem(WHATS_NEW_STORAGE_KEY, '2026-10-03d');
    openWhatsNew({ onlyNew: true });
    // The 3 newest first; the rest one tap away (phone-spec §4.4, 2026-10-12).
    expect([...document.querySelectorAll('.wn-card-title')].map((el) => el.textContent)).toEqual([
      'Your other terminals, here too',
      'Answer from the Agents tab',
      'See what you approve',
    ]);
    const all = document.querySelector<HTMLButtonElement>('[data-testid="whats-new-all"]');
    expect(all?.textContent).toMatch(/See all updates \(\d+\)/);
    all?.click();
    const total = cards();
    expect(total).toBeGreaterThan(11);
    expect(document.querySelector('[data-testid="whats-new-all"]')).toBeNull();
    closeWhatsNew();
    // Further behind, first time, or from the menu: still 3 cards, then the whole list.
    localStorage.setItem(WHATS_NEW_STORAGE_KEY, '2026-10-03');
    openWhatsNew({ onlyNew: true });
    expect(cards()).toBe(3);
    closeWhatsNew();
    localStorage.removeItem(WHATS_NEW_STORAGE_KEY);
    openWhatsNew({ onlyNew: true });
    expect(cards()).toBe(3);
    closeWhatsNew();
    openWhatsNew();
    expect(cards()).toBe(3);
    document.querySelector<HTMLButtonElement>('[data-testid="whats-new-all"]')?.click();
    expect(cards()).toBe(total);
  });

  it('uses icons.ts glyphs (no emoji), a grabber, no header X; bodies expand on tap', () => {
    setScreen({ coarse: true, width: 390, height: 844 });
    openWhatsNew();
    const sheet = document.querySelector('[data-testid="whats-new"]') as HTMLElement;
    expect(sheet.querySelector('.ut-grabber')).not.toBeNull();
    expect(sheet.querySelector('[data-testid="whats-new-x"]')).toBeNull();
    const icons = [...sheet.querySelectorAll('.wn-icon')];
    expect(icons.every((el) => el.querySelector('svg.ut-icon'))).toBe(true);
    expect(/\p{Extended_Pictographic}/u.test(icons.map((el) => el.textContent).join(''))).toBe(
      false
    );
    const text = sheet.querySelector<HTMLButtonElement>('.wn-text');
    expect(text?.getAttribute('aria-expanded')).toBe('false');
    text?.click();
    expect(sheet.querySelector('.wn-text')?.getAttribute('aria-expanded')).toBe('true');
  });

  it('is blocked by an open modal-wrapper dialog or the notifications banner', async () => {
    const { whatsNewBlocked } = await import('./whats-new-sheet');
    expect(whatsNewBlocked()).toBe(false);
    const host = document.createElement('div');
    host.className = 'ut-modal-host';
    document.body.append(host);
    expect(whatsNewBlocked()).toBe(true);
    host.remove();
  });

  it('never shows by itself on desktop or tablets', () => {
    setScreen({ coarse: false, width: 1440, height: 900 });
    expect(shouldAutoShowWhatsNew()).toBe(false);
    setScreen({ coarse: true, width: 1024, height: 768 });
    expect(shouldAutoShowWhatsNew()).toBe(false);
  });

  it('reopens from the phone More menu after it was seen', async () => {
    setScreen({ coarse: true, width: 390, height: 844 });
    localStorage.setItem(WHATS_NEW_STORAGE_KEY, WHATS_NEW_VERSION);
    const header = await fixture<FullHeader>(html`<full-header></full-header>`);

    header.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')?.click();
    await header.updateComplete;
    // The ⋯ menu is an action sheet rendered into <body> since the phone redesign.
    const item =
      document.querySelector<HTMLButtonElement>('[data-testid="phone-menu-whats-new"]') ??
      Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((button) =>
        button.textContent?.includes("What's new")
      );
    expect(item).toBeTruthy();
    // Sheets ignore the click that finishes the opening tap for a moment (by the clock).
    vi.useFakeTimers({ toFake: ['Date'] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    vi.setSystemTime(Date.now() + 600);
    item?.click();

    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="whats-new"]')).not.toBeNull()
    );
  });

  it('ignores the click that finishes the opening tap, then closes', () => {
    vi.useFakeTimers();
    try {
      openWhatsNew();
      const done = document.querySelector<HTMLButtonElement>('[data-testid="whats-new-done"]');
      done?.click();
      expect(document.querySelector('[data-testid="whats-new"]')).not.toBeNull();

      vi.advanceTimersByTime(600);
      done?.click();
      expect(document.querySelector('[data-testid="whats-new"]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
