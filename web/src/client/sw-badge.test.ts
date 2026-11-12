import { describe, expect, it, vi } from 'vitest';
import { syncAppBadge } from './sw-badge';

function registrationWith(tags: string[]) {
  return { getNotifications: vi.fn().mockResolvedValue(tags.map((tag) => ({ tag }))) };
}

describe('syncAppBadge', () => {
  it('badges the number of sessions with a Claude notification on screen', async () => {
    const nav = { setAppBadge: vi.fn().mockResolvedValue(undefined), clearAppBadge: vi.fn() };
    await syncAppBadge(
      registrationWith([
        'untether-claude-a',
        'untether-claude-b',
        'untether-codex-c',
        'untether-bell-a',
      ]),
      nav
    );
    expect(nav.setAppBadge).toHaveBeenCalledWith(3);
  });

  it('clears the badge once no Claude notification is left', async () => {
    const nav = { setAppBadge: vi.fn(), clearAppBadge: vi.fn().mockResolvedValue(undefined) };
    await syncAppBadge(registrationWith(['untether-session-exit-a']), nav);
    expect(nav.clearAppBadge).toHaveBeenCalled();
    expect(nav.setAppBadge).not.toHaveBeenCalled();
  });

  it('does nothing where badging is unsupported or listing fails', async () => {
    await expect(syncAppBadge(registrationWith(['untether-claude-a']), {})).resolves.toBe(
      undefined
    );
    const nav = { setAppBadge: vi.fn() };
    await expect(
      syncAppBadge({ getNotifications: vi.fn().mockRejectedValue(new Error('x')) }, nav)
    ).resolves.toBe(undefined);
    expect(nav.setAppBadge).not.toHaveBeenCalled();
  });
});
