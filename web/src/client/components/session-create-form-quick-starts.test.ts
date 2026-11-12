// @vitest-environment happy-dom
import { fixture, html } from '@open-wc/testing';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  restoreLocalStorage,
  setupFetchMock,
  setupLocalStorageMock,
  waitForAsync,
} from '@/test/utils/component-helpers';
import type { AuthClient } from '../services/auth-client';

vi.mock('../services/auth-client');

import type { SessionCreateForm } from './session-create-form';

// "Quick start" buttons of the new-session form whose program is not on the Mac (2026-10-03).
describe('new-session form: quick starts the Mac does not have', () => {
  let element: SessionCreateForm;
  let fetchMock: ReturnType<typeof setupFetchMock>;
  const authClient = {
    getAuthHeader: () => ({ Authorization: 'Bearer t' }),
  } as unknown as AuthClient;

  beforeAll(async () => {
    await import('./session-create-form');
  });

  beforeEach(() => {
    setupLocalStorageMock();
    fetchMock = setupFetchMock();
    fetchMock.mockResponse('/api/server/status', { macAppConnected: false, isHQMode: false });
    fetchMock.mockResponse('/api/config', {
      repositoryBasePath: '~/',
      quickStartCommands: [{ name: '✨ claude', command: 'claude' }, { command: 'gemini' }],
    });
    fetchMock.mockResponse('/api/quick-start/availability', { claude: true, gemini: false });
    fetchMock.mockResponse('/api/sessions', { sessionId: 'new-1' });
  });

  afterEach(() => {
    element?.remove();
    restoreLocalStorage();
    vi.clearAllMocks();
  });

  async function open() {
    element = await fixture<SessionCreateForm>(html`
      <session-create-form .authClient=${authClient} .visible=${true}></session-create-form>
    `);
    await waitForAsync();
    await element.updateComplete;
  }

  const pill = (label: string) =>
    [
      ...element.querySelectorAll<HTMLButtonElement>('[data-testid="quick-start-pills"] .cf-agent'),
    ].find((button) => button.textContent?.includes(label));
  const missingButton = () =>
    element.querySelector<HTMLButtonElement>('[data-testid="quick-start-missing"]');
  const missingItem = (label: string) =>
    [...element.querySelectorAll<HTMLButtonElement>('.cf-missing-item')].find((button) =>
      button.textContent?.includes(label)
    );
  const notice = () => element.querySelector('#quick-start-unavailable-notice');
  const sessionPosts = () => fetchMock.getCalls().filter(([url]) => url === '/api/sessions');

  it('collapses the missing one into "+1 not installed"; the others are pills, without emoji', async () => {
    await open();
    await vi.waitFor(() => expect(missingButton()?.textContent).toContain('+1 not installed'));

    expect(pill('gemini')).toBeUndefined();
    expect(pill('claude')?.textContent?.trim()).toBe('claude');
    expect(pill('claude')?.textContent).not.toContain('✨');

    missingButton()?.click();
    await element.updateComplete;
    await element.querySelector('quick-start-section')?.updateComplete;
    expect(missingItem('gemini')?.getAttribute('aria-disabled')).toBe('true');
    expect(element.querySelector('.cf-missing-menu')?.textContent).toContain('Not installed');
  });

  it('picking it says why and picks nothing; an available one is picked and created', async () => {
    await open();
    await vi.waitFor(() => expect(missingButton()).toBeTruthy());
    const commandBefore = element.command;

    missingButton()?.click();
    await element.querySelector('quick-start-section')?.updateComplete;
    missingItem('gemini')?.click();
    await element.updateComplete;
    await element.querySelector('quick-start-section')?.updateComplete;
    expect(notice()?.textContent?.trim()).toBe('gemini is not installed on the Mac');
    expect(element.command).toBe(commandBefore);

    pill('claude')?.click();
    await element.updateComplete;
    await element.querySelector('quick-start-section')?.updateComplete;
    expect(element.command).toBe('claude');
    expect(pill('claude')?.getAttribute('aria-pressed')).toBe('true');
    expect(notice()).toBeNull();

    element.querySelector<HTMLButtonElement>('#session-create-button')?.click();
    await vi.waitFor(() => expect(sessionPosts()).toHaveLength(1));
    expect(JSON.parse(sessionPosts()[0][1]?.body as string).command).toEqual(['claude']);
  });

  it('on an HQ, whose sessions run on other machines, never asks and dims nothing', async () => {
    fetchMock.mockResponse('/api/server/status', { macAppConnected: false, isHQMode: true });
    fetchMock.mockResponse('/api/remotes', [{ id: 'm1', name: 'Mac mini', url: 'http://m1' }]);
    await open();

    expect(pill('gemini')).toBeTruthy();
    expect(missingButton()).toBeNull();
    expect(fetchMock.getCalls().some(([url]) => url === '/api/quick-start/availability')).toBe(
      false
    );
  });
});
