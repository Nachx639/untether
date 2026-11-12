// @vitest-environment happy-dom
import { fixture, html } from '@open-wc/testing';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthClient } from '../services/auth-client';

vi.mock('../services/auth-client');

import type { SessionList } from './session-list';

// Phone quick starts whose program is not on the Mac (2026-10-03: gemini and crush started
// sessions that only failed with "command not found").
/** The setup's fetch: each test replaces it, afterEach puts it back. */
const setupFetch = globalThis.fetch;

describe('phone quick starts the Mac does not have', () => {
  let element: SessionList;
  let answerAvailability: (availability: Record<string, boolean>) => void;
  const errors: string[] = [];

  beforeAll(async () => {
    await import('./session-list');
  });

  beforeEach(async () => {
    errors.length = 0;
    const availability = new Promise<Record<string, boolean>>((resolve) => {
      answerAvailability = resolve;
    });
    global.fetch = vi.fn(async (url: string | URL | Request) => {
      if (String(url) === '/api/quick-start/availability') {
        return new Response(JSON.stringify(await availability), { status: 200 });
      }
      if (String(url) === '/api/sessions') {
        return new Response(JSON.stringify({ sessionId: 'new-1' }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    element = await fixture<SessionList>(html`
      <session-list
        .authClient=${{ getAuthHeader: () => ({ Authorization: 'Bearer t' }) } as unknown as AuthClient}
        @error=${(e: CustomEvent<string>) => errors.push(e.detail)}
      ></session-list>
    `);
    const list = element as unknown as {
      usePhoneRows: () => boolean;
      quickStartsLoaded: boolean;
      quickStarts: Array<{ name?: string; command: string }>;
    };
    vi.spyOn(list, 'usePhoneRows').mockReturnValue(true);
    // The first (desktop) render's empty state already asked the server for the quick starts:
    // let that answer land before setting them.
    await new Promise((resolve) => setTimeout(resolve, 0));
    list.quickStartsLoaded = true;
    list.quickStarts = [
      { name: '✨ claude', command: 'claude --dangerously-skip-permissions' },
      { name: '✨ gemini', command: 'gemini' },
      { command: 'zsh' },
    ];
    element.requestUpdate();
    await element.updateComplete;
  });

  afterEach(() => {
    globalThis.fetch = setupFetch;
    document.body.querySelector('.psr-sheet-cancel')?.dispatchEvent(new Event('click'));
    element.remove();
    vi.restoreAllMocks();
  });

  const tool = (label: string) =>
    [...element.querySelectorAll<HTMLButtonElement>('.phone-empty-tools .phone-tool')].find(
      (button) => button.textContent?.includes(label)
    ) as HTMLButtonElement;
  const sheetItems = () => [
    ...document.body.querySelectorAll<HTMLButtonElement>('.psr-sheet-group button'),
  ];
  const sessionPosts = () =>
    vi.mocked(global.fetch).mock.calls.filter(([url]) => String(url) === '/api/sessions');
  // The sheets ignore the tap that opened them: tap a second later.
  const tapLater = (button: HTMLElement | undefined) => {
    const now = Date.now();
    const later = vi.spyOn(Date, 'now').mockReturnValue(now + 1000);
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    later.mockRestore();
  };
  const answer = async (availability: Record<string, boolean>) => {
    answerAvailability(availability);
    await vi.waitFor(() => expect(tool('gemini').classList.contains('unavailable')).toBe(true));
  };

  it('dims the missing one with a note once the Mac answers, and nothing before', async () => {
    expect(tool('gemini').classList.contains('unavailable')).toBe(false);
    expect(element.querySelector('.phone-tool-note')).toBeNull();

    await answer({ claude: true, gemini: false, zsh: true });

    expect(tool('gemini').getAttribute('aria-disabled')).toBe('true');
    expect(tool('gemini').querySelector('.phone-tool-note')?.textContent?.trim()).toBe(
      'Not installed'
    );
    expect(tool('claude').classList.contains('unavailable')).toBe(false);
    expect(tool('claude').hasAttribute('aria-disabled')).toBe(false);
    expect(tool('zsh').querySelector('.phone-tool-note')).toBeNull();
  });

  it('tapping it says why and starts nothing; an available one still starts its session', async () => {
    await answer({ claude: true, gemini: false, zsh: true });
    const created = vi.fn();
    element.addEventListener('session-created', created);

    tool('gemini').click();
    expect(errors).toEqual(['gemini is not installed on the Mac']);
    expect(sheetItems()).toHaveLength(0);
    expect(sessionPosts()).toHaveLength(0);

    tool('claude').click();
    expect(sheetItems().map((item) => item.textContent?.trim())).toContain('~');
    tapLater(sheetItems().find((item) => item.textContent?.trim() === '~'));
    await vi.waitFor(() => expect(created).toHaveBeenCalled());
    expect(sessionPosts()).toHaveLength(1);
    expect(JSON.parse(sessionPosts()[0][1]?.body as string)).toMatchObject({
      command: ['claude', '--dangerously-skip-permissions'],
      workingDir: '~',
    });
    expect(errors).toHaveLength(1);
  });

  it('the "+" sheet marks it too, and tapping it there starts nothing', async () => {
    await answer({ claude: true, gemini: false, zsh: true });
    (element as unknown as { openToolSheet: () => void }).openToolSheet();

    const gemini = sheetItems().find((item) => item.textContent?.includes('gemini'));
    expect(gemini?.classList.contains('unavailable')).toBe(true);
    expect(gemini?.querySelector('.psr-sheet-note')?.textContent?.trim()).toBe('Not installed');
    const claude = sheetItems().find((item) => item.textContent?.includes('claude'));
    expect(claude?.classList.contains('unavailable')).toBe(false);
    expect(claude?.querySelector('.psr-sheet-note')).toBeNull();

    tapLater(gemini);
    expect(errors).toEqual(['gemini is not installed on the Mac']);
    expect(sheetItems()).toHaveLength(0);
    expect(sessionPosts()).toHaveLength(0);
  });
});
