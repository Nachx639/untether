// @vitest-environment happy-dom

import { fixture, html } from '@open-wc/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMockSession } from '@/test/utils/lit-test-utils';
import type { Session } from '../../../shared/types.js';
import { rememberMacSessionsPlatform } from '../../utils/mac-sessions.js';
import type { SessionHeader } from './session-header.js';

const terminalSocketClientMock = vi.hoisted(() => ({
  initialize: vi.fn(),
  subscribe: vi.fn(() => () => {}),
  getConnectionStatus: vi.fn(() => true),
  onConnectionStateChange: vi.fn(() => () => {}),
}));

vi.mock('../../services/terminal-socket-client.js', () => ({
  terminalSocketClient: terminalSocketClientMock,
}));

import './session-header.js';

describe('SessionHeader', () => {
  const elements: SessionHeader[] = [];

  afterEach(() => {
    for (const element of elements) {
      element.remove();
    }
    elements.length = 0;
  });

  async function renderHeader(options: {
    isMobile: boolean;
    sessionName?: string;
    showBackButton?: boolean;
    showSidebarToggle?: boolean;
    sidebarCollapsed?: boolean;
    onBack?: () => void;
    onSidebarToggle?: () => void;
  }): Promise<SessionHeader> {
    const element = await fixture<SessionHeader>(html`
      <session-header
        .session=${createMockSession({
          id: 'header-controls',
          name: options.sessionName,
        })}
        .isMobile=${options.isMobile}
        .showBackButton=${options.showBackButton ?? false}
        .showSidebarToggle=${options.showSidebarToggle ?? false}
        .sidebarCollapsed=${options.sidebarCollapsed ?? false}
        .onBack=${options.onBack}
        .onSidebarToggle=${options.onSidebarToggle}
      ></session-header>
    `);
    elements.push(element);
    return element;
  }

  // Phone header (phone spec 3.4, 2026-10-12): one borderless chevron back (44 px) that says
  // where it goes, the title, and 44 px icon buttons: no boxed tiles.
  it('renders one 44px borderless back to the list and 44px icon buttons on phones', async () => {
    const onBack = vi.fn();
    const onSidebarToggle = vi.fn();
    const element = await renderHeader({
      isMobile: true,
      showSidebarToggle: true,
      sidebarCollapsed: true,
      onBack,
      onSidebarToggle,
    });

    const back = element.querySelector<HTMLButtonElement>('[data-testid="session-sidebar-toggle"]');
    const chatButton = element.querySelector<HTMLButtonElement>(
      '[data-testid="chat-mode-toggle-button-compact"]'
    );
    const menuButton = element.querySelector<HTMLButtonElement>(
      'compact-menu button[aria-label="More actions menu"]'
    );
    expect(element.querySelector('[data-testid="session-back-button"]')).toBeNull();
    expect(back?.classList.contains('ut-ph-back')).toBe(true);
    expect(back?.className).not.toMatch(/border|bg-bg-tertiary/);
    expect(back?.getAttribute('aria-label')).toBe('Sessions');
    expect(back?.querySelector('svg')).toBeTruthy();
    for (const button of [chatButton, menuButton]) {
      expect(button?.classList.contains('ut-icon-btn')).toBe(true);
      expect(button?.classList.contains('ut-ph-icon')).toBe(true);
    }
    // Chat on is the pressed icon toggle, never an orange tile.
    expect(chatButton?.getAttribute('aria-pressed')).toBe('false');
    expect(element.querySelector('.bg-primary, .text-primary, .font-mono')).toBeNull();
    // The desktop-only shortcuts are not on a phone.
    expect(element.querySelector('[data-testid="go-to-root-button"]')).toBeNull();
    expect(element.querySelector('[data-testid="create-session-button"]')).toBeNull();

    back?.click();
    expect(onSidebarToggle).toHaveBeenCalledTimes(1);
    expect(onBack).not.toHaveBeenCalled();
  });

  // 2026-10-12, user request: back from a terminal must land on the home control center. The app
  // gives a phone's session view the Back (to home) and no sidebar toggle.
  it('a phone in the split view goes home with Back, never opening the sidebar', async () => {
    const onBack = vi.fn();
    const onSidebarToggle = vi.fn();
    const element = await renderHeader({
      isMobile: true,
      showBackButton: true,
      showSidebarToggle: false,
      sidebarCollapsed: true,
      onBack,
      onSidebarToggle,
    });
    expect(element.querySelector('[data-testid="session-sidebar-toggle"]')).toBeNull();
    const back = element.querySelector<HTMLButtonElement>('[data-testid="session-back-button"]');
    expect(back?.hasAttribute('aria-controls')).toBe(false);
    back?.click();
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onSidebarToggle).not.toHaveBeenCalled();
  });

  it('a standalone session view goes back with its own Back', async () => {
    const onBack = vi.fn();
    const element = await renderHeader({ isMobile: true, showBackButton: true, onBack });
    const back = element.querySelector<HTMLButtonElement>('[data-testid="session-back-button"]');
    back?.click();
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('marks chat mode as a pressed icon toggle', async () => {
    const element = await fixture<SessionHeader>(html`
      <session-header
        .session=${createMockSession({ id: 'chat-on' })}
        .isMobile=${true}
        .chatMode=${true}
      ></session-header>
    `);
    elements.push(element);
    const chat = element.querySelector('[data-testid="chat-mode-toggle-button-compact"]');
    expect(chat?.getAttribute('aria-pressed')).toBe('true');
    expect(chat?.className).not.toContain('bg-primary');
  });

  it('shows a shield icon, not the emoji, for a shielded session', async () => {
    const element = await fixture<SessionHeader>(html`
      <session-header
        .session=${{ ...createMockSession({ id: 'shielded' }), shielded: true }}
        .isMobile=${true}
      ></session-header>
    `);
    elements.push(element);
    const shield = element.querySelector('[data-testid="header-shield-badge"]');
    expect(shield?.querySelector('svg')).toBeTruthy();
    expect(element.textContent).not.toContain('🛡');
  });

  it('desktop back is a borderless icon button with its label for screen readers', async () => {
    const element = await renderHeader({ isMobile: false, showBackButton: true });
    const backButton = element.querySelector<HTMLButtonElement>(
      '[data-testid="session-back-button"]'
    );

    expect(backButton?.classList.contains('ut-icon-btn')).toBe(true);
    expect(backButton?.getAttribute('aria-label')).toBe('Back');
    expect(backButton?.querySelector('svg')).toBeTruthy();
  });

  describe('desktop toolbar (one row at every width)', () => {
    const desktop = async (session: Partial<Session> = {}, extra: Partial<SessionHeader> = {}) => {
      const element = await fixture<SessionHeader>(html`
        <session-header
          .session=${{ ...createMockSession({ id: 'desk', name: 'api server' }), ...session }}
          .isMobile=${false}
          .showSidebarToggle=${true}
          .hasGitRepo=${Boolean(session.gitRepoPath)}
          .onShowChanges=${extra.onShowChanges}
          .onSidebarToggle=${extra.onSidebarToggle}
          .chatMode=${extra.chatMode ?? false}
          .onToggleChatMode=${extra.onToggleChatMode}
        ></session-header>
      `);
      elements.push(element);
      return element;
    };

    it('renders the same controls whatever the width (no compact switch)', async () => {
      const element = await desktop(
        { gitRepoPath: '/r', gitBranch: 'main' },
        { onShowChanges: () => {} }
      );
      const ids = () =>
        [...element.querySelectorAll('.ut-session-header-actions [data-testid]')].map((el) =>
          el.getAttribute('data-testid')
        );
      const wide = ids();
      // A narrow container used to swap the buttons for a menu; it must not any more.
      element.style.width = '600px';
      window.dispatchEvent(new Event('resize'));
      await element.updateComplete;
      expect(ids()).toEqual(wide);
      expect(wide).toEqual(
        expect.arrayContaining([
          'keyboard-capture-button',
          'header-view-switch',
          'chat-mode-toggle-button',
          'terminal-mode-button',
          'header-files-button',
          'header-changes-button',
        ])
      );
      expect(element.querySelector('compact-menu')?.hasAttribute('desktop')).toBe(true);
      // No status pill, no theme/settings/width buttons in the bar: they live in ⋯.
      expect(element.querySelector('session-status-dropdown')).toBeNull();
      expect(element.querySelector('theme-toggle-icon')).toBeNull();
      expect(element.querySelector('notification-status')).toBeNull();
      expect(element.querySelector('.width-selector-button')).toBeNull();
    });

    it('has no orange text, no mono outside data, and no bordered icon boxes', async () => {
      const element = await desktop(
        { gitRepoPath: '/r', gitBranch: 'main' },
        { onShowChanges: () => {} }
      );
      const bar = element.querySelector('[data-testid="session-header-bar"]') as HTMLElement;
      expect(bar.classList.contains('ut-session-header')).toBe(true);
      expect(bar.querySelector('.text-primary')).toBeNull();
      expect(bar.querySelector('.border-primary')).toBeNull();
      for (const button of bar.querySelectorAll('.ut-session-header-actions > button')) {
        expect(button.className).not.toContain('border');
      }
      expect(bar.querySelector('.font-mono:not(git-status-badge *)')).toBeNull();
    });

    it('toggles the sidebar from its own button, with ⌘B in the tooltip', async () => {
      const onSidebarToggle = vi.fn();
      const element = await desktop({}, { onSidebarToggle });
      const toggle = element.querySelector<HTMLButtonElement>(
        '[data-testid="session-sidebar-toggle"]'
      );
      expect(toggle?.classList.contains('ut-icon-btn')).toBe(true);
      expect(toggle?.title).toMatch(/\(⌘B\)|\(Ctrl\+B\)/);
      toggle?.click();
      expect(onSidebarToggle).toHaveBeenCalledTimes(1);
    });

    it('shows the status dot, a shield icon (not an emoji) and what Claude waits for', async () => {
      const element = await desktop({
        shielded: true,
        claudeStatus: { status: 'waiting', waitingFor: 'permission' } as Session['claudeStatus'],
      });
      const dot = element.querySelector('[data-testid="header-status-dot"]');
      expect(dot?.classList.contains('ut-dot')).toBe(true);
      expect(dot?.className).not.toContain('sm:hidden');
      expect(dot?.getAttribute('data-status')).toBe('needs-input');
      const shield = element.querySelector('[data-testid="header-shield-badge"]');
      expect(shield?.querySelector('svg')).toBeTruthy();
      expect(shield?.textContent).not.toContain('🛡');
      expect(shield?.getAttribute('title')).toBeTruthy();
      const waiting = element.querySelector('[data-testid="header-claude-status"]');
      expect(waiting?.classList.contains('ut-session-header-waiting')).toBe(true);
      expect(waiting?.textContent).toMatch(/^·\s/);
    });

    it('switches Chat | Terminal from the segmented control', async () => {
      const onToggleChatMode = vi.fn();
      const element = await desktop({}, { onToggleChatMode });
      const chat = element.querySelector<HTMLButtonElement>(
        '[data-testid="chat-mode-toggle-button"]'
      );
      const terminal = element.querySelector<HTMLButtonElement>(
        '[data-testid="terminal-mode-button"]'
      );
      expect(terminal?.getAttribute('aria-pressed')).toBe('true');
      expect(chat?.getAttribute('aria-pressed')).toBe('false');
      terminal?.click();
      expect(onToggleChatMode).not.toHaveBeenCalled();
      chat?.click();
      expect(onToggleChatMode).toHaveBeenCalledTimes(1);
    });

    // 2026-10-18: the desktop title edited the generated `name`, which `ut title` and git
    // events rewrite and the list hides under Claude's title: the rename seemed lost.
    it("shows and renames the title the list shows (the user's title), not the session name", async () => {
      const element = await desktop({ claudeTitle: 'Fix login', userTitle: undefined });
      const editor = element.querySelector('inline-edit') as HTMLElement & {
        value: string;
        onSave: (value: string) => void;
      };
      expect(editor.value).toBe('Fix login');
      const retitles: unknown[] = [];
      element.addEventListener('session-retitle', (e) =>
        retitles.push((e as CustomEvent).detail.userTitle)
      );
      element.addEventListener('session-rename', () => retitles.push('legacy name rename'));
      editor.onSave('  ATLAS ');
      editor.onSave('   ');
      expect(retitles).toEqual(['ATLAS', null]);
    });

    it('offers Reopen and Clear on an exited session through the status chip', async () => {
      const element = await desktop({ status: 'exited', exitCode: 0 });
      const chip = element.querySelector(
        '[data-testid="session-status-chip"]'
      ) as HTMLButtonElement;
      expect(chip).toBeTruthy();
      expect(chip.textContent).not.toMatch(/[A-Z]{4,}/);
    });
  });

  it('shows the title on one ellipsized line on mobile, without the desktop details', async () => {
    const sessionName =
      'Issue 516 iPhone session title that is intentionally very long to verify truncation';
    const element = await renderHeader({ isMobile: true, sessionName });
    const titleContainer = element.querySelector<HTMLElement>(
      '[data-testid="session-title-container"]'
    );
    const title = titleContainer?.querySelector<HTMLElement>('[data-testid="header-phone-title"]');
    expect(titleContainer?.classList.contains('ut-ph-title-wrap')).toBe(true);
    expect(title?.querySelector('.ut-ph-title-text')?.textContent?.trim()).toBe(sessionName);
    expect(element.querySelector('[data-testid="session-details"]')).toBeNull();
  });

  it('opens the preview from its chip on a tap, not at the end of a drag', async () => {
    const element = await fixture<SessionHeader>(html`
      <session-header
        .session=${{
          ...createMockSession({ id: 'with-preview' }),
          previewPorts: [{ port: 5173, source: 'ut-open', at: 1 }],
        }}
        .isMobile=${true}
      ></session-header>
    `);
    elements.push(element);
    const opened = vi.fn();
    window.addEventListener('ut-open-preview', opened);
    try {
      const chip = element.querySelector('[data-testid="preview-chip"]') as HTMLElement;
      // iOS ends a drag that began on the chip with a pointerup on it.
      const touch = (dy: number) => {
        const at = (y: number) => ({
          pointerType: 'touch',
          pointerId: 7,
          clientX: 300,
          clientY: y,
          bubbles: true,
        });
        chip.dispatchEvent(new PointerEvent('pointerdown', at(30)));
        chip.dispatchEvent(new PointerEvent('pointerup', at(30 + dy)));
      };
      touch(100);
      expect(opened).not.toHaveBeenCalled();
      touch(2);
      chip.click();
      expect(opened).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('ut-open-preview', opened);
    }
  });

  describe('Claude status on phones', () => {
    async function renderClaude(claudeStatus: Session['claudeStatus'], claudeTitle?: string) {
      const session: Session = {
        ...createMockSession({
          id: 'claude-header',
          name: 'claude (~/Projects)',
          command: ['claude'],
        }),
        claudeStatus,
        claudeTitle,
      };
      const element = await fixture<SessionHeader>(html`
        <session-header .session=${session} .sessions=${[session]} .isMobile=${true}></session-header>
      `);
      elements.push(element);
      return { element, session };
    }

    const statusText = (element: SessionHeader) =>
      element.querySelector('[data-testid="header-claude-status"]')?.textContent?.trim() ?? '';
    const titleText = (element: SessionHeader) =>
      element.querySelector('.ut-ph-title-text')?.textContent?.trim() ?? '';
    const captionText = (element: SessionHeader) =>
      element.querySelector('.ut-ph-caption')?.textContent?.trim() ?? '';
    const stripText = (element: SessionHeader) =>
      element.querySelector('[data-testid="header-needs-you-strip"]')?.textContent?.trim() ?? '';

    it('shows the conversation title instead of the session name, with the name below', async () => {
      const { element } = await renderClaude({ status: 'idle' }, 'Fix the login bug');
      expect(titleText(element)).toBe('Fix the login bug');
      expect(captionText(element)).toBe('claude (~/Projects)');
    });

    it("shows the title the user gave the session over Claude's", async () => {
      const { element, session } = await renderClaude({ status: 'idle', title: 'Fix login' });
      session.userTitle = 'Mi tarea';
      element.sessions = [{ ...session }];
      element.session = { ...session };
      await element.updateComplete;
      expect(titleText(element)).toBe('Mi tarea');
      expect(captionText(element)).toBe('claude (~/Projects)');
    });

    it('says when Claude needs you, and what for in an amber strip with Responder', async () => {
      const { element, session } = await renderClaude({
        status: 'waiting',
        waitingFor: 'Bash permission',
      });
      expect(statusText(element)).toBe('Needs you');
      expect(stripText(element)).toContain('Claude needs you · Bash permission');
      // The words around the reason are affixes a narrow strip hides (2026-10-12 QA).
      const affixes = [...element.querySelectorAll('.ut-ph-strip-affix')].map(
        (el) => el.textContent
      );
      expect(affixes).toEqual(['Claude needs you · ', '']);
      expect(element.querySelector('.ut-dot[data-status="needs-input"]')).toBeTruthy();
      const opened = vi.fn();
      window.addEventListener('ut-open-answer-sheet', opened);
      try {
        element.querySelector<HTMLButtonElement>('[data-testid="header-needs-you-reply"]')?.click();
        expect(opened).toHaveBeenCalledTimes(1);
        expect((opened.mock.calls[0][0] as CustomEvent).detail).toEqual({ sessionId: session.id });
      } finally {
        window.removeEventListener('ut-open-answer-sheet', opened);
      }
    });

    it('shows an OK an agent waits for in its own session, and counts it on the way back (2026-10-20)', async () => {
      const { taskStore } = await import('../../services/task-store.js');
      taskStore.set([], [], [], [
        {
          id: 'conf-1',
          kind: 'project-settings',
          createdAt: '2026-10-20T18:24:00.000Z',
          expiresAt: '2026-10-20T18:54:00.000Z',
          where: 'atlas',
          repoPath: '/repo',
          summary: 'Change the task settings of atlas',
          detail: [],
          requestedBy: {},
        },
      ] as never);
      try {
        const { element } = await renderClaude({ status: 'idle' });
        await element.updateComplete;
        const strip = element.querySelector('[data-testid="header-confirm-strip"]');
        expect(strip?.textContent).toContain('atlas');
        const opened = vi.fn();
        window.addEventListener('ut-open-task-confirm', opened);
        try {
          element.querySelector<HTMLButtonElement>('[data-testid="header-confirm-open"]')?.click();
          expect((opened.mock.calls[0][0] as CustomEvent).detail).toEqual({ id: 'conf-1' });
        } finally {
          window.removeEventListener('ut-open-task-confirm', opened);
        }
      } finally {
        taskStore.reset();
      }
    });

    it("an orchestrator's header shows its project's icon, in the terminal and the chat alike (2026-10-20)", async () => {
      const { taskStore } = await import('../../services/task-store.js');
      const iconFor = vi.spyOn(taskStore, 'iconFor').mockReturnValue('blob:atlas');
      const { element, session } = await renderClaude({ status: 'idle' });
      taskStore.set([], [{ repoPath: '/repo/atlas', sessionId: session.id }]);
      try {
        element.requestUpdate();
        await element.updateComplete;
        const img = element.querySelector('[data-testid="header-project-icon"]');
        expect(img?.getAttribute('src')).toBe('blob:atlas');
        expect(iconFor).toHaveBeenCalledWith('/repo/atlas');
        // Not an orchestrator: no icon.
        taskStore.set([], []);
        element.requestUpdate();
        await element.updateComplete;
        expect(element.querySelector('[data-testid="header-project-icon"]')).toBeNull();
      } finally {
        iconFor.mockRestore();
        taskStore.reset();
      }
    });

    it('pulses the dot only while working; idle holds still and has no strip', async () => {
      const { element, session } = await renderClaude({ status: 'idle' });
      expect(element.querySelector('.ut-dot[data-status="idle"]')).toBeTruthy();
      expect(element.querySelector('[data-testid="header-needs-you-strip"]')).toBeNull();
      expect(element.querySelector('.animate-ping')).toBeNull();
      session.claudeStatus = { status: 'busy' };
      element.sessions = [session];
      await element.updateComplete;
      expect(element.querySelector('.ut-dot[data-status="working"]')).toBeTruthy();
    });

    it("says what Claude waits for in the user's language, as the list does", async () => {
      const { element } = await renderClaude({
        status: 'waiting',
        waitingFor: 'permission prompt',
      });
      expect(statusText(element)).toBe('Needs you');
      expect(stripText(element)).toContain('Permission request');
    });

    it('updates live when the app polls a new status into the same session object', async () => {
      const { element, session } = await renderClaude({ status: 'idle' });
      expect(statusText(element)).toBe('');

      session.claudeStatus = { status: 'busy' };
      element.sessions = [session];
      await element.updateComplete;

      expect(statusText(element)).toBe('Working');
    });
  });
});

// Opened with ut in a terminal window: a full session, marked as one that lives on the Mac.
describe('SessionHeader of a session in a Mac window', () => {
  const elements: SessionHeader[] = [];

  afterEach(() => {
    for (const element of elements) element.remove();
    elements.length = 0;
  });

  async function renderWindow(options: {
    app: string | null;
    platform?: string;
    isMobile?: boolean;
    claudeStatus?: Session['claudeStatus'];
  }) {
    const session: Session = {
      ...createMockSession({ id: 'fwd_1759500000_20085', name: 'claude', command: ['claude'] }),
      macWindow: { app: options.app },
      claudeStatus: options.claudeStatus,
    };
    const element = await fixture<SessionHeader>(html`
      <session-header
        .session=${session}
        .sessions=${[session]}
        .serverPlatform=${options.platform ?? 'darwin'}
        .isMobile=${options.isMobile ?? true}
      ></session-header>
    `);
    elements.push(element);
    return element;
  }

  const marker = (element: SessionHeader) =>
    element.querySelector('[data-testid="header-mac-window-badge"]');
  const where = (element: SessionHeader) =>
    element.querySelector('[data-testid="header-mac-window"]')?.textContent?.trim();

  it('marks it with a monitor icon and says it runs on the Mac, in which app', async () => {
    const element = await renderWindow({ app: 'Terminal' });
    expect(marker(element)?.querySelector('svg')).toBeTruthy();
    expect(marker(element)?.getAttribute('role')).toBe('img');
    expect(marker(element)?.getAttribute('aria-label')).toBe(
      'Runs in a terminal window on this Mac'
    );
    expect(marker(element)?.getAttribute('title')).toBe('Runs in a terminal window on this Mac');
    expect(where(element)).toBe('On the Mac · Terminal');
    expect(
      element.querySelector('[data-testid="header-phone-title"]')?.getAttribute('aria-label')
    ).toMatch(/^claude, On the Mac · Terminal, Idle.* — Switch session$/);
  });

  it('says only "On the Mac" when the app is unknown, and "this computer" off macOS', async () => {
    expect(where(await renderWindow({ app: null }))).toBe('On the Mac');
    const linux = await renderWindow({ app: 'kitty', platform: 'linux' });
    expect(where(linux)).toBe('On this computer · kitty');
    expect(marker(linux)?.getAttribute('aria-label')).toBe(
      'Runs in a terminal window on this computer'
    );
    expect(where(await renderWindow({ app: null, platform: '' }))).toBe('On this computer');
  });

  it('keeps the marker while the agent works, which says what it does', async () => {
    const element = await renderWindow({ app: 'iTerm', claudeStatus: { status: 'busy' } });
    expect(marker(element)).not.toBeNull();
    expect(element.querySelector('[data-testid="header-claude-status"]')?.textContent).toContain(
      'Working'
    );
  });

  it('marks it on the desktop too, and nothing else gets the marker', async () => {
    expect(marker(await renderWindow({ app: 'Terminal', isMobile: false }))).not.toBeNull();
    const plain = await fixture<SessionHeader>(html`
      <session-header .session=${createMockSession({ id: 'plain' })} .isMobile=${true}></session-header>
    `);
    elements.push(plain);
    expect(marker(plain)).toBeNull();
    expect(where(plain)).toBeUndefined();
  });

  it('says it as its row in the list does, with the platform the list reported', async () => {
    rememberMacSessionsPlatform('darwin');
    const ssh = await renderWindow({ app: 'SSH', platform: '' });
    expect(where(ssh)).toBe('On the Mac · SSH session');
    expect(marker(ssh)?.getAttribute('aria-label')).toBe('Runs in a terminal window on this Mac');

    rememberMacSessionsPlatform('linux');
    expect(where(await renderWindow({ app: 'kitty', platform: '' }))).toBe(
      'On this computer · kitty'
    );
  });
});

describe('SessionHeader navigation badge', () => {
  it('counts the other sessions that wait for you on the sidebar button', async () => {
    localStorage.clear();
    const make = (id: string, status?: string): Session => ({
      ...createMockSession({ id, command: ['claude'] }),
      claudeStatus: status ? { status } : undefined,
    });
    const current = make('me', 'waiting');
    const element = await fixture<SessionHeader>(html`
      <session-header
        .session=${current}
        .sessions=${[current, make('a', 'waiting'), make('b', 'waiting'), make('c', 'busy')]}
        .isMobile=${true}
        .showSidebarToggle=${true}
        .sidebarCollapsed=${true}
      ></session-header>
    `);
    const button = element.querySelector('[data-testid="session-sidebar-toggle"]');
    const badge = button?.querySelector('[data-testid="header-nav-badge"]');

    expect(badge?.textContent?.trim()).toBe('2');
    expect(badge?.hasAttribute('data-waiting')).toBe(true);
    expect(button?.getAttribute('aria-label')).toBe('Sessions (2 other sessions need you)');

    element.sessions = [current];
    await element.updateComplete;
    expect(button?.querySelector('[data-testid="header-nav-badge"]')).toBeNull();
    element.remove();
  });
});

describe('SessionHeader on a phone on its side', () => {
  // 2026-10-04: on a Pro Max in landscape the header took three lines (title, subtitle, folder
  // row) and left the chat about a third of the height.
  const setWindow = (width: number, height: number) => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
  };
  afterEach(() => setWindow(1024, 768));

  const session = (): Session => ({
    ...createMockSession({
      id: 'landscape',
      name: 'clasico-qa',
      command: ['claude'],
      workingDir: '/Users/alice/.untether-qa/qa-git',
    }),
    userTitle: 'Números del 1 al 150 con cuadrados',
    gitRepoPath: '/Users/alice/.untether-qa/qa-git',
    gitBranch: 'main',
  });

  const mount = async (isMobile = true) => {
    const element = await fixture<SessionHeader>(html`
      <session-header
        .session=${session()}
        .isMobile=${isMobile}
        .showSidebarToggle=${true}
        .sidebarCollapsed=${true}
      ></session-header>
    `);
    await element.updateComplete;
    return element;
  };

  const oneLine = (element: SessionHeader) =>
    element.querySelector('[data-testid="session-header-bar"]')?.hasAttribute('data-one-line') ??
    false;

  it('is one 36 px line: the title and the dot (the caption hides), every control stays', async () => {
    setWindow(956, 330);
    const element = await mount();
    expect(oneLine(element)).toBe(true);
    const title = element.querySelector('[data-testid="header-phone-title"]');
    expect(title?.querySelector('.ut-ph-title-text')?.textContent).toContain(
      'Números del 1 al 150 con cuadrados'
    );
    expect(element.querySelector('[data-testid="session-details"]')).toBeNull();
    expect(element.querySelector('[data-testid="header-status-dot"]')).not.toBeNull();
    expect(element.querySelector('[data-testid="session-sidebar-toggle"]')).not.toBeNull();
    expect(element.querySelector('[data-testid="chat-mode-toggle-button-compact"]')).not.toBeNull();
    expect(element.querySelector('compact-menu')).not.toBeNull();
    element.remove();
  });

  it('goes back to two lines when the phone is turned upright, and again on its side', async () => {
    setWindow(956, 330);
    const element = await mount();
    expect(oneLine(element)).toBe(true);

    setWindow(440, 830);
    window.dispatchEvent(new Event('resize'));
    await element.updateComplete;
    expect(oneLine(element)).toBe(false);
    expect(element.querySelector('.ut-ph-caption')?.textContent).toContain('clasico-qa');

    setWindow(956, 330);
    window.dispatchEvent(new Event('orientationchange'));
    await element.updateComplete;
    expect(oneLine(element)).toBe(true);
    element.remove();
  });

  it('an SE on its side is one line too', async () => {
    setWindow(667, 323);
    const element = await mount();
    expect(oneLine(element)).toBe(true);
    element.remove();
  });

  it('a short desktop window keeps the desktop header', async () => {
    setWindow(956, 330);
    const element = await mount(false);
    expect(oneLine(element)).toBe(false);
    expect(element.querySelector('[data-testid="session-details"]')).not.toBeNull();
    element.remove();
  });
  it('says so when asking for a new title fails (it used to fail only in the console)', async () => {
    const fetchMock = vi.fn(async () => new Response('nope', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const header = await fixture<SessionHeader>(html`
        <session-header .session=${createMockSession({ id: 'retitle' })}></session-header>
      `);
      (header as unknown as { handleMagicButton: () => void }).handleMagicButton();
      await vi.waitFor(() => expect(document.querySelector('.ut-toast')).not.toBeNull());
    } finally {
      vi.unstubAllGlobals();
      for (const el of document.querySelectorAll('.ut-toast')) el.remove();
    }
  });
});
