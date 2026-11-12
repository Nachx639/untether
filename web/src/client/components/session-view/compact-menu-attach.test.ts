// @vitest-environment happy-dom
import { fixture, html } from '@open-wc/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MacModeRequest } from '../../../shared/mac-sessions.js';
import type { Session, SessionMultiplexer } from '../../../shared/types.js';
import type { CompactMenu } from './compact-menu.js';
import './compact-menu.js';

const tmux = (
  mode: SessionMultiplexer['mode'],
  sizing: SessionMultiplexer['sizing'] = 'others'
): SessionMultiplexer => ({
  type: 'tmux',
  socketPath: '/tmp/tmux-501/default',
  serverPid: 15674,
  serverStartedAt: 1727426400,
  sessionId: '$0',
  sessionName: '0',
  mode,
  sizing,
  source: 'mac-sessions',
});

const session = (overrides: Partial<Session> = {}) =>
  ({
    id: 's1',
    name: 'tmux: 0',
    command: ['/opt/homebrew/bin/tmux'],
    workingDir: '/Users/u/project',
    status: 'running',
    ...overrides,
  }) as Session;

// A tmux session opened from "On this Mac": watch or type, and which screen sets the size.
describe('compact menu of an opened tmux session', () => {
  afterEach(() => {
    vi.useRealTimers();
    for (const sheet of document.querySelectorAll('[data-testid="session-menu-sheet"]')) {
      sheet.remove();
    }
  });

  async function openMenu(target: Session) {
    const menu = await fixture<CompactMenu>(
      html`<compact-menu .session=${target} .onTerminateSession=${() => {}}></compact-menu>`
    );
    (menu.querySelector('button[data-menu-button]') as HTMLElement).click();
    await menu.updateComplete;
    const changes: MacModeRequest[] = [];
    menu.addEventListener('attach-mode-change', (e) =>
      changes.push((e as CustomEvent<MacModeRequest>).detail)
    );
    // Phones: the menu is a bottom sheet rendered into <body> (compact-menu.ts).
    const item = (testId: string) =>
      document.body.querySelector<HTMLButtonElement>(
        `[data-testid="session-menu-sheet"] [data-testid="${testId}"]`
      );
    return { menu, changes, item };
  }

  it('offers Watch only and Fit to this screen while typing, and says Disconnect', async () => {
    vi.useFakeTimers();
    const { changes, item } = await openMenu(session({ multiplexer: tmux('control') }));
    expect(item('compact-attach-watch')?.textContent?.trim()).toBe('Watch only');
    expect(item('compact-attach-fit')?.textContent).toContain('Fit to this screen');
    expect(item('compact-attach-fit')?.textContent).toContain(
      'Other terminals showing this session switch to this size while you use it here.'
    );
    expect(item('compact-attach-control')).toBeNull();
    expect(item('compact-terminate-session')?.textContent?.trim()).toBe('Disconnect');

    item('compact-attach-watch')?.click();
    await vi.advanceTimersByTimeAsync(60);
    expect(changes).toEqual([{ mode: 'watch' }]);
  });

  it('gives the size back to the other terminals once it follows this screen', async () => {
    vi.useFakeTimers();
    const { changes, item } = await openMenu(session({ multiplexer: tmux('control', 'here') }));
    expect(item('compact-attach-fit')?.textContent?.trim()).toBe('Use the other terminal’s size');
    item('compact-attach-fit')?.click();
    await vi.advanceTimersByTimeAsync(60);
    expect(changes).toEqual([{ sizing: 'others' }]);
  });

  it('offers Take control while watching, and no size of its own', async () => {
    vi.useFakeTimers();
    const { changes, item } = await openMenu(session({ multiplexer: tmux('watch') }));
    expect(item('compact-attach-control')?.textContent?.trim()).toBe('Take control');
    expect(item('compact-attach-watch')).toBeNull();
    expect(item('compact-attach-fit')).toBeNull();
    item('compact-attach-control')?.click();
    await vi.advanceTimersByTimeAsync(60);
    expect(changes).toEqual([{ mode: 'control' }]);
  });

  it('has none of it for other sessions; one attached from the tmux modal still disconnects', async () => {
    const plain = await openMenu(session({ name: 'zsh', command: ['zsh'] }));
    expect(plain.item('compact-attach-watch')).toBeNull();
    expect(plain.item('compact-attach-control')).toBeNull();
    expect(plain.item('compact-terminate-session')?.textContent?.trim()).toBe('Terminate Session');
    plain.menu.remove();

    const modal = await openMenu(session({ name: 'tmux: work' }));
    expect(modal.item('compact-attach-watch')).toBeNull();
    expect(modal.item('compact-terminate-session')?.textContent?.trim()).toBe('Disconnect');
  });
});
