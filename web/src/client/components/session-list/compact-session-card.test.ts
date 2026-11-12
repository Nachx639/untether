// @vitest-environment happy-dom
import { fixture, html } from '@open-wc/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupFetchMock } from '@/test/utils/component-helpers';
import { createMockSession } from '@/test/utils/lit-test-utils';
import type { AuthClient } from '../../services/auth-client';

const deleteSession = vi.fn();
vi.mock('../../services/session-action-service.js', () => ({
  sessionActionService: { deleteSession: (...args: unknown[]) => deleteSession(...args) },
}));

import type { CompactSessionCard } from './compact-session-card';
import './compact-session-card';

describe('CompactSessionCard', () => {
  // 2026-10-20 audit: a double click on remove sent two DELETEs.
  it('removes a finished session once while the first remove is on its way', async () => {
    let finish: () => void = () => {};
    deleteSession.mockImplementation(
      () => new Promise((resolve) => (finish = () => resolve({ success: true })))
    );
    const element = await fixture<CompactSessionCard>(html`
      <compact-session-card
        .session=${createMockSession({ status: 'exited' })}
        .authClient=${{ getAuthHeader: () => ({}) } as unknown as AuthClient}
      ></compact-session-card>
    `);
    const remove = (element as unknown as { handleDelete: (e: Event) => Promise<void> })
      .handleDelete;
    const first = remove.call(element, new Event('click'));
    await remove.call(element, new Event('click'));
    finish();
    await first;
    expect(deleteSession).toHaveBeenCalledTimes(1);
  });

  // 2026-11-11 (client audit): the sidebar cut a session's title at its end; the end is what
  // tells two sessions apart, and task rows already kept it (.ut-mid).
  it('cuts a long title in the middle and keeps its end, like a task row', async () => {
    const name = 'Revisión 2ª vuelta: arreglos claros de agentes e infraestructura';
    const element = await fixture<CompactSessionCard>(html`
      <compact-session-card
        .session=${createMockSession({ status: 'running', name })}
        .authClient=${{ getAuthHeader: () => ({}) } as unknown as AuthClient}
      ></compact-session-card>
    `);
    const title = element.querySelector('.ut-side-name') as HTMLElement;
    expect(title.classList.contains('ut-mid')).toBe(true);
    expect(title.getAttribute('dir')).toBe('auto');
    expect(title.getAttribute('title')).toBe(name);
    expect(title.querySelector('.ut-mid-start')?.textContent).toBe(
      'Revisión 2ª vuelta: arreglos claros de agentes'
    );
    expect(title.querySelector('.ut-mid-end')?.textContent).toBe(' e infraestructura');
    expect(title.textContent).toBe(name);
  });

  // 2026-10-24: the sidebar did not say which session was its project's orchestrator.
  it("marks its project's orchestrator", async () => {
    const element = await fixture<CompactSessionCard>(html`
      <compact-session-card
        .session=${createMockSession({ status: 'running' })}
        .authClient=${{ getAuthHeader: () => ({}) } as unknown as AuthClient}
      ></compact-session-card>
    `);
    expect(element.querySelector('[data-testid="compact-orchestrator-badge"]')).toBeNull();
    element.orchestrator = true;
    await element.updateComplete;
    const badge = element.querySelector('[data-testid="compact-orchestrator-badge"]');
    expect(badge?.textContent?.trim()).toBe('Orchestrator');
    expect(badge?.querySelector('svg')).not.toBeNull();
    expect(element.querySelector('.ut-side-avatar')?.classList.contains('is-orchestrator')).toBe(
      true
    );
    expect(
      element.querySelector('[data-testid="compact-session-card"]')?.getAttribute('aria-label')
    ).toContain('Orchestrator');
  });

  it("fills an orchestrator's tile with its project's app icon, as on the phone", async () => {
    const element = await fixture<CompactSessionCard>(html`
      <compact-session-card
        .session=${createMockSession({ status: 'running' })}
        .authClient=${{ getAuthHeader: () => ({}) } as unknown as AuthClient}
        .projectIcon=${'blob:http://localhost/app-icon'}
      ></compact-session-card>
    `);
    const avatar = () => element.querySelector('.ut-side-avatar') as HTMLElement;
    // Only the orchestrator's row carries it.
    expect(element.querySelector('[data-testid="compact-project-icon"]')).toBeNull();
    element.orchestrator = true;
    await element.updateComplete;
    expect(avatar().getAttribute('data-icon')).toBe('project');
    expect(element.querySelector('[data-testid="compact-project-icon"]')?.getAttribute('src')).toBe(
      'blob:http://localhost/app-icon'
    );
    expect(avatar().querySelector('svg')).not.toBeNull();
    // One that can't load gives the plain tile back.
    element.querySelector('img')?.dispatchEvent(new Event('error'));
    await element.updateComplete;
    expect(avatar().hasAttribute('data-icon')).toBe(false);
    expect(element.querySelector('img')).toBeNull();
  });

  // 2026-11-07: the user could not take a session out of the bakery group from the sidebar.
  describe('group menu', () => {
    const repo = '/Users/n/Projects/bakery';
    const sheet = () => document.body.querySelector('[data-testid="group-pin-sheet"]');
    const groupButton = (element: CompactSessionCard) =>
      element.querySelector<HTMLButtonElement>('[data-testid="compact-group-pin-button"]');

    async function anchored() {
      const session = { ...createMockSession({ status: 'running' }), groupPin: { repoPath: repo } };
      return fixture<CompactSessionCard>(html`
        <compact-session-card
          .session=${session}
          .authClient=${{ getAuthHeader: () => ({}) } as unknown as AuthClient}
          .groupMenu=${{
            choices: [
              { key: repo, name: 'bakery', folder: true },
              { key: null, name: '', folder: false },
            ],
            groupOf: new Map([[session.id, repo]]),
          }}
        ></compact-session-card>
      `);
    }

    afterEach(() => {
      vi.useRealTimers();
      for (const open of document.body.querySelectorAll('[data-testid="group-pin-sheet"]')) {
        open.remove();
      }
    });

    it('its hover button opens the group menu without opening the session', async () => {
      const element = await anchored();
      const select = vi.fn();
      element.addEventListener('session-select', select);
      const button = groupButton(element);
      expect(button?.getAttribute('title')).toBe('Group');
      expect(button?.getAttribute('aria-label')).toBe('Group');
      expect(button?.getAttribute('aria-pressed')).toBe('true');
      expect(button?.closest('.ut-side-hover')).not.toBeNull();
      vi.useFakeTimers();
      button?.click();
      vi.advanceTimersByTime(600);
      expect(select).not.toHaveBeenCalled();
      expect(sheet()?.querySelector('[data-testid="group-pin-clear"]')).not.toBeNull();
      expect(sheet()?.querySelector('[data-testid="group-pin-move"]')).not.toBeNull();
    });

    it('a right click on the row opens the same menu instead of the browser one', async () => {
      const element = await anchored();
      const select = vi.fn();
      element.addEventListener('session-select', select);
      const row = element.querySelector('[data-testid="compact-session-card"]') as HTMLElement;
      const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      vi.useFakeTimers();
      row.dispatchEvent(event);
      vi.advanceTimersByTime(600);
      expect(event.defaultPrevented).toBe(true);
      expect(select).not.toHaveBeenCalled();
      expect(sheet()?.querySelector('[data-testid="group-pin-clear"]')).not.toBeNull();
    });

    it('moving it to "Otras" saves the anchor, tells the list and redraws the row', async () => {
      const element = await anchored();
      const fetchMock = setupFetchMock();
      fetchMock.mockResponse(`/api/sessions/${element.session.id}/group-pin`, {
        success: true,
        groupPin: { repoPath: null },
      });
      const pinned = vi.fn();
      element.addEventListener('session-group-pinned', pinned);
      vi.useFakeTimers();
      groupButton(element)?.click();
      vi.advanceTimersByTime(600);
      sheet()?.querySelector<HTMLButtonElement>('[data-testid="group-pin-move"]')?.click();
      vi.advanceTimersByTime(600);
      // Its own group is not offered.
      expect(document.body.querySelector(`[data-testid="group-pin-to-${repo}"]`)).toBeNull();
      document.body
        .querySelector<HTMLButtonElement>('[data-testid="group-pin-to-others"]')
        ?.click();
      vi.useRealTimers();
      await vi.waitFor(() => expect(pinned).toHaveBeenCalled());
      expect(pinned.mock.calls[0][0].detail).toEqual({
        sessionId: element.session.id,
        groupPin: { repoPath: null },
      });
      expect(fetchMock.getCalls()[0][1]?.body).toBe(
        JSON.stringify({ groupPin: { repoPath: null } })
      );
      expect(element.session.groupPin).toEqual({ repoPath: null });
      expect(sheet()).toBeNull();
    });
  });
});
