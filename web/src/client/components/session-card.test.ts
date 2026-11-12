// @vitest-environment happy-dom
import { fixture, html } from '@open-wc/testing';
import { afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { setupFetchMock } from '@/test/utils/component-helpers';
import { createMockSession } from '@/test/utils/lit-test-utils';
import { resetFactoryCounters } from '@/test/utils/test-factories';
import type { AuthClient } from '../services/auth-client';

// Mock AuthClient
vi.mock('../services/auth-client');

// Mock copyToClipboard and formatPathForDisplay
vi.mock('../utils/path-utils', () => ({
  copyToClipboard: vi.fn(() => Promise.resolve(true)),
  formatPathForDisplay: vi.fn((path) => path), // Just return the path as-is for tests
}));

// Kill asks first (utils/confirm-dialog.ts): answer yes unless a test says otherwise.
const confirmDialog = vi.fn(() => Promise.resolve(true));
vi.mock('../utils/confirm-dialog', () => ({ confirmDialog: () => confirmDialog() }));

// Import component type
import type { SessionCard } from './session-card';

// The kill-in-progress flag is private state.
const internals = (el: SessionCard) => el as unknown as { killing: boolean };

describe('SessionCard', () => {
  let element: SessionCard;
  let fetchMock: ReturnType<typeof setupFetchMock>;
  let mockAuthClient: AuthClient;

  beforeAll(async () => {
    // Import components to register custom elements
    await import('./session-card');
    await import('./ut-terminal-buffer');
    await import('./copy-icon');
    await import('./clickable-path');
  });

  beforeEach(async () => {
    // Reset factory counters for test isolation
    resetFactoryCounters();

    // Setup fetch mock
    fetchMock = setupFetchMock();

    // Create mock auth client
    mockAuthClient = {
      getAuthHeader: vi.fn(() => ({ Authorization: 'Bearer test-token' })),
    } as unknown as AuthClient;

    // Create default session
    const mockSession = createMockSession();

    // Create component
    element = await fixture<SessionCard>(html`
      <session-card .session=${mockSession} .authClient=${mockAuthClient}></session-card>
    `);

    await element.updateComplete;
  });

  afterEach(() => {
    element?.remove();
    fetchMock.clear();
    vi.clearAllMocks();
  });

  describe('initialization', () => {
    it('should create component with default state', () => {
      expect(element).toBeDefined();
      expect(internals(element).killing).toBe(false);
    });

    it('should render session details', async () => {
      await element.updateComplete;
      const name = element.querySelector('.ut-card-name');
      expect(name?.textContent).toContain('Test Session');
      // Status comes from deriveSessionStatus: a quiet running session is idle.
      const status = element.querySelector('[data-testid="session-status"]');
      expect(status?.getAttribute('data-status')).toBe('idle');
      // The card is one link for the keyboard, named after the session.
      const card = element.querySelector('[data-testid="session-card"]');
      expect(card?.getAttribute('role')).toBe('link');
      expect(card?.getAttribute('aria-label')).toContain('Test Session');
    });

    it('renders the terminal buffer behind «More»', async () => {
      expect(element.querySelector('ut-terminal-buffer')).toBeNull();
      (element.querySelector('[data-testid="session-card-more"]') as HTMLButtonElement).click();
      await element.updateComplete;
      const terminalBuffer = element.querySelector('ut-terminal-buffer') as HTMLElement & {
        sessionId: string;
      };
      expect(terminalBuffer).toBeTruthy();
      // Component uses property binding, not attribute
      expect(terminalBuffer?.sessionId).toBe(element.session.id);
      // Home previews: the last lines, always on the dark palette.
      const buffer = terminalBuffer as unknown as { appearance: string };
      expect(buffer.appearance).toBe('dark');
    });
  });

  describe('session display', () => {
    /** «More»: the card's details (command, branch, folder, diff) in the preview's place. */
    const openMore = async () => {
      (element.querySelector('[data-testid="session-card-more"]') as HTMLButtonElement).click();
      await element.updateComplete;
    };

    it('reads at a glance: title, state, one line and time; the rest behind «More» (2026-11-08)', async () => {
      const long =
        'Runs the card component tests after cutting their text down to a single line, then checks the screenshots';
      element.session = {
        ...createMockSession({ name: 'Test Session', gitBranch: 'feat/cards', status: 'running' }),
        gitInsertionCount: 4,
        gitDeletionCount: 1,
        claudeStatus: { status: 'busy' },
        explain: { text: long, at: Date.now() },
      };
      await element.updateComplete;
      const status = element.querySelector('[data-testid="session-status"]') as HTMLElement;
      const line = status.textContent?.trim() ?? '';
      expect(line.length).toBeLessThanOrEqual(80);
      expect(line.endsWith('…')).toBe(true);
      expect(line.startsWith('Runs the card component tests')).toBe(true);
      // Nothing else by default: no command, branch, folder or diff, the preview is there.
      for (const selector of [
        '.ut-card-command',
        '.ut-card-branch',
        'clickable-path',
        '[data-testid="session-diff"]',
      ]) {
        expect(element.querySelector(selector), selector).toBeNull();
      }
      // Not even the terminal's last lines: several lines of output (2026-11-08 review).
      expect(element.querySelector('.ut-card-preview')).toBeNull();
      const more = element.querySelector('[data-testid="session-card-more"]') as HTMLButtonElement;
      expect(more.textContent?.trim()).toBe('More');
      expect(more.getAttribute('aria-expanded')).toBe('false');

      // «More» shows the preview and the details; a click on it does not open the session.
      const select = vi.fn();
      element.addEventListener('session-select', select);
      await openMore();
      expect(select).not.toHaveBeenCalled();
      const details = element.querySelector('[data-testid="session-card-details"]') as HTMLElement;
      expect(details.querySelector('.ut-card-branch')?.textContent?.trim()).toBe('feat/cards');
      expect(details.querySelector('[data-testid="session-diff"]')?.textContent).toContain('+4');
      expect(details.querySelector('clickable-path')).toBeTruthy();
      expect(element.querySelector('.ut-card-preview ut-terminal-buffer')).toBeTruthy();
      expect(more.getAttribute('aria-expanded')).toBe('true');
      expect(more.textContent?.trim()).toBe('Less');
      await openMore();
      expect(element.querySelector('[data-testid="session-card-details"]')).toBeNull();
      expect(element.querySelector('.ut-card-preview')).toBeNull();
    });

    it('without a line from the model, the short status of always; never one for another state', async () => {
      element.session = {
        ...createMockSession({ status: 'exited', exitCode: 0 }),
        explain: { text: 'Running the tests', at: Date.now() },
      };
      await element.updateComplete;
      expect(
        element.querySelector('[data-testid="session-status"]')?.textContent?.trim()
      ).not.toContain('Running the tests');
    });

    it('the list row is one line too: no folder, branch or diff, its line instead', async () => {
      element.layout = 'row';
      element.session = {
        ...createMockSession({ gitBranch: 'feat/cards', status: 'running' }),
        gitInsertionCount: 4,
        gitDeletionCount: 1,
        claudeStatus: { status: 'busy' },
        explain: { text: 'Fixing the login test', at: Date.now() },
      };
      await element.updateComplete;
      const line = element.querySelector('[data-testid="session-line"]') as HTMLElement;
      expect(line.textContent?.trim()).toBe('Fixing the login test');
      // Where it runs, on hover.
      expect(line.getAttribute('title')).toContain('feat/cards');
      expect(element.querySelector('clickable-path')).toBeNull();
      expect(element.querySelector('[data-testid="session-diff"]')).toBeNull();
    });

    it('should display session name or command', async () => {
      element.session = createMockSession({ name: 'Test Session' });
      await element.updateComplete;
      expect(element.querySelector('.ut-card-name')?.textContent).toContain('Test Session');
      // A custom name shows the command, behind «More» (2026-11-08).
      expect(element.querySelector('.ut-card-command')).toBeFalsy();
      await openMore();
      expect(element.querySelector('.ut-card-command')).toBeTruthy();

      // Without a name it falls back to the command, shown once.
      const sessionWithoutName = createMockSession({ command: ['npm', 'run', 'dev'] });
      sessionWithoutName.name = '';
      element.session = sessionWithoutName;
      await element.updateComplete;
      expect(element.querySelector('.ut-card-name')?.textContent).toBe('npm run dev');
      expect(element.querySelector('.ut-card-command')).toBeFalsy();
    });

    it('prefers the title the user gave it', async () => {
      element.session = { ...createMockSession({ name: 'claude (~/x)' }), userTitle: 'Mi tarea' };
      await element.updateComplete;
      expect(element.querySelector('.ut-card-name')?.textContent).toBe('Mi tarea');
    });

    it('shows working while the terminal is active', async () => {
      element.session = {
        ...createMockSession({ status: 'running' }),
        activityStatus: { isActive: true },
      };
      await element.updateComplete;
      const status = element.querySelector('[data-testid="session-status"]');
      expect(status?.getAttribute('data-status')).toBe('working');
      expect(status?.textContent).toContain('Working');
    });

    it('shows idle without the relative time the header already shows', async () => {
      element.session = {
        ...createMockSession({ status: 'running' }),
        lastModified: new Date(Date.now() - 9 * 60_000).toISOString(),
      };
      await element.updateComplete;
      const status = element.querySelector('[data-testid="session-status"]');
      expect(status?.getAttribute('data-status')).toBe('idle');
      expect(status?.textContent?.trim()).toBe('Idle');
    });

    it('shows a finished session with its exit code', async () => {
      element.session = createMockSession({ status: 'exited', exitCode: 2 });
      await element.updateComplete;
      const status = element.querySelector('[data-testid="session-status"]');
      expect(status?.getAttribute('data-status')).toBe('exited-error');
      expect(status?.textContent).toContain('2');
    });

    it('marks a session that needs you with a pill and the attention border', async () => {
      element.session = {
        ...createMockSession({ status: 'running' }),
        claudeStatus: { status: 'waiting' },
      };
      await element.updateComplete;
      const card = element.querySelector('[data-testid="session-card"]');
      expect(card?.classList.contains('is-attention')).toBe(true);
      expect(
        element.querySelector('.ut-card-head .ut-status[data-status="needs-input"]')
      ).toBeTruthy();
    });

    it('should display Git branch when available', async () => {
      const mockBranch = 'feature/awesome-feature';
      element.session = createMockSession({ gitBranch: mockBranch });
      await element.updateComplete;
      await openMore();

      const gitBranchElement = element.querySelector('.ut-card-branch');
      expect(gitBranchElement?.textContent?.trim()).toBe(mockBranch);
    });

    it('shows a detached HEAD as its short SHA with a tooltip', async () => {
      element.session = createMockSession({ gitBranch: 'a1b2c3d4e5f6' });
      await element.updateComplete;
      await openMore();
      const chip = element.querySelector('.ut-card-branch');
      expect(chip?.textContent?.trim()).toBe('a1b2c3d');
      expect(chip?.getAttribute('title')).toBe('Detached HEAD');
    });

    it('should display the diff counts', async () => {
      element.session = {
        ...createMockSession({ gitBranch: 'main' }),
        gitInsertionCount: 12,
        gitDeletionCount: 3,
      };
      await element.updateComplete;
      await openMore();
      const diff = element.querySelector('[data-testid="session-diff"]');
      expect(diff?.textContent).toContain('+12');
      expect(diff?.textContent).toContain('−3');
    });

    it('should not display Git status when no branch is set', async () => {
      element.session = createMockSession({ gitBranch: undefined });
      await element.updateComplete;

      expect(element.querySelector('.ut-card-branch')).toBeFalsy();
    });

    it('should display working directory', async () => {
      await openMore();
      const workingDir = element.querySelector('clickable-path') as HTMLElement & { path: string };
      expect(workingDir).toBeTruthy();
      // Component uses property binding, not attribute
      expect(workingDir?.path).toBe(element.session.workingDir);
    });
  });

  describe('click handling', () => {
    it('should emit session-select event when card is clicked', async () => {
      const selectHandler = vi.fn();
      element.addEventListener('session-select', selectHandler);

      const card = element.querySelector('[data-testid="session-card"]') as HTMLElement;
      card.click();
      expect(selectHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          detail: element.session,
        })
      );
    });

    it('should prevent event bubbling on kill button click', async () => {
      const selectHandler = vi.fn();
      element.addEventListener('session-select', selectHandler);

      const killButton = element.querySelector('#session-kill-button') as HTMLElement;
      killButton.click();
      // Should not trigger session select
      expect(selectHandler).not.toHaveBeenCalled();
    });
  });

  describe('kill functionality', () => {
    it('should show kill button for running sessions', async () => {
      element.session = createMockSession({ status: 'running' });
      await element.updateComplete;

      const killButton = element.querySelector('#session-kill-button');
      expect(killButton).toBeTruthy();
    });

    it('should show cleanup button for exited sessions', async () => {
      element.session = createMockSession({ status: 'exited' });
      await element.updateComplete;

      const cleanupButton = element.querySelector('#session-kill-button');
      expect(cleanupButton).toBeTruthy();
    });

    it('keeps the hover actions out of the Tab order', () => {
      for (const button of element.querySelectorAll('.ut-card-actions button')) {
        expect(button.getAttribute('tabindex')).toBe('-1');
      }
    });

    it('offers Reopen and Remove on a finished session', async () => {
      element.session = createMockSession({ status: 'exited' });
      await element.updateComplete;
      expect(element.querySelector('[data-testid="reopen-session-button"]')).toBeTruthy();
      expect(element.querySelector('#session-kill-button')?.getAttribute('aria-label')).toBe(
        'Remove'
      );
      expect(element.querySelector('[data-testid="rename-session-button"]')).toBeFalsy();
    });

    it('a running session can be muted from its card, like the phone row (2026-10-18)', async () => {
      fetchMock.mockResponse(`/api/sessions/${element.session.id}/mute`, { success: true });
      const mute = element.querySelector<HTMLButtonElement>('[data-testid="mute-session-button"]');
      expect(mute?.getAttribute('aria-pressed')).toBe('false');
      mute?.click();
      await vi.waitFor(() => expect(element.session.muted).toBe(true));
    });

    it('its group menu anchors it to another group of the home (2026-11-04)', async () => {
      const repo = '/Users/n/Projects/finanzas';
      fetchMock.mockResponse(`/api/sessions/${element.session.id}/group-pin`, {
        success: true,
        groupPin: { repoPath: repo },
      });
      element.groupMenu = {
        choices: [
          { key: repo, name: 'finanzas', folder: true },
          { key: null, name: '', folder: false },
        ],
        groupOf: new Map([[element.session.id, null]]),
      };
      await element.updateComplete;
      const pinned = vi.fn();
      element.addEventListener('session-group-pinned', pinned);
      vi.useFakeTimers();
      // Also when an assertion in between fails: the next test gets the real clock.
      onTestFinished(() => {
        vi.useRealTimers();
      });
      element.querySelector<HTMLButtonElement>('[data-testid="group-pin-session-button"]')?.click();
      vi.advanceTimersByTime(600);
      const sheet = document.body.querySelector('[data-testid="group-pin-sheet"]');
      expect(sheet?.querySelector('[data-testid="group-pin-here"]')).not.toBeNull();
      sheet?.querySelector<HTMLButtonElement>('[data-testid="group-pin-move"]')?.click();
      vi.advanceTimersByTime(600);
      expect(document.body.querySelector('[data-testid="group-pin-to-others"]')).toBeNull();
      document.body
        .querySelector<HTMLButtonElement>(`[data-testid="group-pin-to-${repo}"]`)
        ?.click();
      vi.useRealTimers();
      await vi.waitFor(() => expect(pinned).toHaveBeenCalled());
      expect(element.session.groupPin).toEqual({ repoPath: repo });
      expect(document.body.querySelector('[data-testid="group-pin-sheet"]')).toBeNull();
    });

    it('a finished session keeps its group menu (2026-11-04 review)', async () => {
      element.session = {
        ...createMockSession({ status: 'exited' }),
        groupPin: { repoPath: null },
      };
      await element.updateComplete;
      const button = element.querySelector<HTMLButtonElement>(
        '[data-testid="group-pin-session-button"]'
      );
      expect(button?.getAttribute('aria-pressed')).toBe('true');
    });

    it('asks before killing a running session; no means nothing happens', async () => {
      fetchMock.mockResponse(`/api/sessions/${element.session.id}`, { success: true });
      confirmDialog.mockResolvedValueOnce(false);
      expect(await element.confirmKill()).toBe(false);
      expect(fetchMock.getCalls().length).toBe(0);

      const killedHandler = vi.fn();
      element.addEventListener('session-killed', killedHandler);
      expect(await element.confirmKill()).toBe(true);
      expect(killedHandler).toHaveBeenCalled();
    });

    it('removes a finished session without asking', async () => {
      element.session = createMockSession({ status: 'exited' });
      await element.updateComplete;
      fetchMock.mockResponse(`/api/sessions/${element.session.id}`, { success: true });
      await element.confirmKill();
      expect(confirmDialog).not.toHaveBeenCalled();
    });

    it('should handle successful kill', async () => {
      fetchMock.mockResponse(`/api/sessions/${element.session.id}`, { success: true });

      const killedHandler = vi.fn();
      element.addEventListener('session-killed', killedHandler);

      await element.kill();

      expect(mockAuthClient.getAuthHeader).toHaveBeenCalled();
      expect(killedHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          detail: {
            sessionId: element.session.id,
            session: element.session,
          },
        })
      );
    });

    it('should handle kill error', async () => {
      fetchMock.mockResponse(
        `/api/sessions/${element.session.id}`,
        { error: 'Permission denied' },
        { status: 403 }
      );

      const errorHandler = vi.fn();
      element.addEventListener('session-kill-error', errorHandler);

      await element.kill();

      expect(errorHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          detail: {
            sessionId: element.session.id,
            error: expect.stringContaining('Failed to terminate session'),
          },
        })
      );
    });

    it('a failed remove of a finished session leaves the card usable (not collapsed)', async () => {
      element.session = createMockSession({ status: 'exited' });
      await element.updateComplete;
      fetchMock.mockResponse(
        `/api/sessions/${element.session.id}`,
        { error: 'nope' },
        { status: 500 }
      );
      expect(await element.kill()).toBe(false);
      expect(element.classList.contains('black-hole-collapsing')).toBe(false);
    });

    it('should show the closing state', async () => {
      // Mock a slow response
      fetchMock.mockResponse(
        `/api/sessions/${element.session.id}`,
        () => new Promise((resolve) => setTimeout(() => resolve({ success: true }), 100))
      );

      const killPromise = element.kill();
      expect(internals(element).killing).toBe(true);

      await element.updateComplete;
      expect(element.querySelector('.ut-card-killing')?.textContent).toContain('Closing session');

      await killPromise;
      expect(internals(element).killing).toBe(false);
    });

    it('should prevent multiple simultaneous kills', async () => {
      fetchMock.mockResponse(`/api/sessions/${element.session.id}`, { success: true });

      // Start first kill
      const firstKill = element.kill();

      // Try second kill immediately
      const secondKill = element.kill();

      // Second kill should return false immediately
      expect(await secondKill).toBe(false);

      // First kill should succeed
      expect(await firstKill).toBe(true);
    });

    it('should handle cleanup for exited sessions', async () => {
      element.session = createMockSession({ status: 'exited' });
      await element.updateComplete;

      fetchMock.mockResponse(`/api/sessions/${element.session.id}`, { success: true });

      const killedHandler = vi.fn();
      element.addEventListener('session-killed', killedHandler);

      await element.kill();

      // Should use DELETE endpoint for exited sessions
      const calls = fetchMock.getCalls();
      const deleteCall = calls.find((call) =>
        call[0].includes(`/api/sessions/${element.session.id}`)
      );
      expect(deleteCall).toBeDefined();
      expect(deleteCall?.[1]?.method).toBe('DELETE');
      expect(killedHandler).toHaveBeenCalled();
    });
  });

  describe('styling', () => {
    it('should dim the card while killing', async () => {
      internals(element).killing = true;
      await element.updateComplete;
      const card = element.querySelector('[data-testid="session-card"]');
      expect(card?.classList.contains('is-killing')).toBe(true);
    });

    it('should apply exited styling for exited sessions', async () => {
      element.session = createMockSession({ status: 'exited' });
      await element.updateComplete;
      const card = element.querySelector('[data-testid="session-card"]');
      expect(card?.classList.contains('is-exited')).toBe(true);
    });

    // Live in colour, finished in grey (2026-10-12): list.css tints the tile from data-status.
    it('draws the agent tile with its state dot on cards, not on list rows', async () => {
      const card = () => element.querySelector('[data-testid="session-card"]');
      expect(card()?.querySelector('.ut-card-avatar > .ut-agent-glyph')).toBeTruthy();
      expect(card()?.querySelector('.ut-card-avatar > .ut-card-dot')).toBeTruthy();
      element.session = createMockSession({ status: 'exited' });
      await element.updateComplete;
      expect(card()?.getAttribute('data-status')).toMatch(/^exited/);
      expect(card()?.classList.contains('is-exited')).toBe(true);
      element.layout = 'row';
      await element.updateComplete;
      expect(card()?.querySelector('.ut-card-avatar')).toBeFalsy();
      expect(card()?.querySelector('.ut-dot[data-status]')).toBeTruthy();
    });

    it('renders one 40px row in list view', async () => {
      element.layout = 'row';
      await element.updateComplete;
      const row = element.querySelector('[data-testid="session-card"]');
      expect(row?.classList.contains('ut-srow')).toBe(true);
      expect(element.querySelector('ut-terminal-buffer')).toBeFalsy();
    });

    it('is the Tab stop only when the list says so', async () => {
      const card = () => element.querySelector('[data-testid="session-card"]');
      expect(card()?.getAttribute('tabindex')).toBe('-1');
      element.tabStop = true;
      await element.updateComplete;
      expect(card()?.getAttribute('tabindex')).toBe('0');
    });
  });

  describe('rename', () => {
    it('edits the title in place and saves it as the user title', async () => {
      fetchMock.mockResponse(`/api/sessions/${element.session.id}`, { success: true });
      const renamed = vi.fn();
      element.addEventListener('session-renamed', renamed);
      element.startRename();
      await element.updateComplete;
      const input = element.querySelector(
        '[data-testid="session-rename-input"]'
      ) as HTMLInputElement;
      expect(input).toBeTruthy();
      input.value = 'Nuevo nombre';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await vi.waitFor(() => expect(renamed).toHaveBeenCalled());
      expect(renamed.mock.calls[0][0].detail).toMatchObject({ userTitle: 'Nuevo nombre' });
      const call = fetchMock.getCalls().find((c) => c[1]?.method === 'PATCH');
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({ userTitle: 'Nuevo nombre' });
    });

    it('Escape cancels without saving', async () => {
      element.startRename();
      await element.updateComplete;
      const input = element.querySelector(
        '[data-testid="session-rename-input"]'
      ) as HTMLInputElement;
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await element.updateComplete;
      expect(element.querySelector('[data-testid="session-rename-input"]')).toBeFalsy();
      expect(fetchMock.getCalls().length).toBe(0);
    });
  });

  describe('cleanup', () => {
    it('should clean up intervals on disconnect', () => {
      // Set up some intervals
      internals(element).killing = true;

      // Disconnect
      element.disconnectedCallback();

      // Intervals should be cleared (no way to directly test, but should not throw)
      expect(() => element.disconnectedCallback()).not.toThrow();
    });
  });

  describe('preview tail (ut-terminal-buffer)', () => {
    it('keeps the last lines that fit, without the trailing blank rows', async () => {
      const { renderTail } = await import('./ut-terminal-buffer');
      const row = (text: string) => [...text].map((char) => ({ char, width: 1 }));
      const cells = [row('one'), row('two'), row('three'), [], row('   '), []];
      const html = renderTail(cells, 2, 13.5);
      expect(html).not.toContain('one');
      expect(html).toContain('two');
      expect(html).toContain('three');
      expect(html.match(/terminal-line/g)).toHaveLength(2);
      expect(html).toContain('height: 13.5px');
    });
  });

  // 2026-10-24: the grid's orchestrator card did not show its project's app icon.
  describe("orchestrator's project app icon", () => {
    const ICON = 'blob:http://localhost/app-icon';

    it('fills the card avatar, the agent mark small in its corner', async () => {
      element.projectIcon = ICON;
      await element.updateComplete;
      expect(element.querySelector('[data-testid="card-project-icon"]')).toBeNull();
      element.orchestrator = true;
      await element.updateComplete;
      const avatar = element.querySelector('.ut-card-avatar') as HTMLElement;
      expect(avatar.getAttribute('data-icon')).toBe('project');
      expect(avatar.querySelector('img')?.getAttribute('src')).toBe(ICON);
      expect(avatar.querySelector('.ut-agent-glyph')).not.toBeNull();
      avatar.querySelector('img')?.dispatchEvent(new Event('error'));
      await element.updateComplete;
      expect(avatar.hasAttribute('data-icon')).toBe(false);
      expect(avatar.querySelector('img')).toBeNull();
    });

    it('takes the glyph s place in the list view row', async () => {
      element.orchestrator = true;
      element.layout = 'row';
      await element.updateComplete;
      expect(element.querySelector('[data-testid="card-project-icon"]')).toBeNull();
      element.projectIcon = ICON;
      await element.updateComplete;
      expect(element.querySelector('[data-testid="card-project-icon"]')?.getAttribute('src')).toBe(
        ICON
      );
    });
  });
});
