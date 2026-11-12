import { describe, expect, it, vi } from 'vitest';
import { handleNotificationClick, notificationClickTarget } from './sw-notification-click';

const waiting = { type: 'claude-waiting', sessionId: 'abc' };
const origin = 'https://mac.example';

function clients(windows: Array<{ url: string; focused?: boolean }>) {
  const opened: string[] = [];
  const posted: Array<{ url: string; message: unknown }> = [];
  const list = windows.map((w) => ({
    ...w,
    focus: vi.fn(async () => {}),
    postMessage: (message: unknown) => posted.push({ url: w.url, message }),
  }));
  return {
    opened,
    posted,
    api: {
      matchAll: async () => list,
      openWindow: async (url: string) => {
        opened.push(url);
        return null;
      },
    },
  };
}

describe('notification click', () => {
  it('opens "Claude needs you" straight to the answer sheet', async () => {
    expect(notificationClickTarget('', waiting).url).toBe('/session/abc?answer=1');
    expect(notificationClickTarget('answer', waiting).url).toBe('/session/abc?answer=1');
    // Other pushes keep opening the plain session.
    expect(notificationClickTarget('', { type: 'claude-finished', sessionId: 'abc' }).url).toBe(
      '/session/abc'
    );

    const { api, opened } = clients([]);
    await handleNotificationClick('', waiting, api, origin);
    expect(opened).toEqual(['https://mac.example/session/abc?answer=1']);
  });

  it('opens "Codex needs you" on the answer sheet too, "Codex finished" on its session', () => {
    const codexWaiting = { type: 'codex-waiting', sessionId: 'abc' };
    expect(notificationClickTarget('', codexWaiting).url).toBe('/session/abc?answer=1');
    expect(notificationClickTarget('answer', codexWaiting).url).toBe('/session/abc?answer=1');
    expect(notificationClickTarget('', { type: 'codex-finished', sessionId: 'abc' }).url).toBe(
      '/session/abc'
    );
  });

  it('reuses the focused app window and asks it to open the sheet', async () => {
    const { api, opened, posted } = clients([
      { url: `${origin}/` },
      { url: `${origin}/session/other`, focused: true },
    ]);
    await handleNotificationClick('', waiting, api, origin);
    expect(opened).toEqual([]);
    expect(posted).toEqual([
      {
        url: `${origin}/session/other`,
        message: { type: 'notification-action', action: 'answer', data: waiting },
      },
    ]);
  });

  it('opens a task confirmation in the confirm sheet', async () => {
    const data = { type: 'task-confirm', confirmId: 'c 1' };
    expect(notificationClickTarget('', data)).toEqual({
      url: '/?confirm=c%201',
      action: 'confirm',
    });
    expect(notificationClickTarget('view-session', data).action).toBe('confirm');
    // Without an id it is just the app.
    expect(notificationClickTarget('', { type: 'task-confirm' }).url).toBe('/');

    const { api, opened } = clients([]);
    await handleNotificationClick('', data, api, origin);
    expect(opened).toEqual(['https://mac.example/?confirm=c%201']);
  });

  // 2026-11-11: "View Logs" of a "session ended" push opened the ended session when the app
  // was open (the app knows no such action) and the log viewer when it was closed.
  it('opens the log viewer for "View Logs", with the app open or closed', async () => {
    const data = { type: 'session-exit', sessionId: 'abc' };
    const closed = clients([]);
    await handleNotificationClick('view-logs', data, closed.api, origin);
    expect(closed.opened).toEqual(['https://mac.example/logs']);

    const open = clients([{ url: `${origin}/session/other`, focused: true }]);
    await handleNotificationClick('view-logs', data, open.api, origin);
    expect(open.opened).toEqual(['https://mac.example/logs']);
    expect(open.posted).toEqual([]);
  });

  it('never hands a tap to the log viewer: it cannot act on it', async () => {
    const { api, opened, posted } = clients([
      { url: `${origin}/logs`, focused: true },
      { url: `${origin}/logs.html?tail=1` },
    ]);
    await handleNotificationClick('', waiting, api, origin);
    expect(posted).toEqual([]);
    expect(opened).toEqual(['https://mac.example/session/abc?answer=1']);

    // The app's own preview view (/preview/<id>) is still the app.
    const app = clients([{ url: `${origin}/preview/pv-1` }]);
    await handleNotificationClick('', waiting, app.api, origin);
    expect(app.posted).toHaveLength(1);
  });

  it('does nothing for Dismiss', async () => {
    const { api, opened, posted } = clients([{ url: `${origin}/` }]);
    await handleNotificationClick('dismiss', waiting, api, origin);
    expect(opened).toEqual([]);
    expect(posted).toEqual([]);
  });
});

describe('preview-ready notification', () => {
  it('opens /preview/<id>, deep-linked to its page', async () => {
    const { notificationClickTarget } = await import('./sw-notification-click');
    expect(
      notificationClickTarget('', {
        type: 'preview-ready',
        id: 'pshop123',
        sessionId: 's1',
        port: 5173,
        path: '/about',
      })
    ).toEqual({ url: '/preview/pshop123?path=%2Fabout', action: 'view-session' });
    expect(
      notificationClickTarget('', {
        type: 'preview-ready',
        id: 'pshop123',
        sessionId: 's1',
        port: 5173,
      })
    ).toEqual({ url: '/preview/pshop123', action: 'view-session' });
  });

  it("opens a task's push at its row in the list, not its agent's terminal", async () => {
    const ready = { type: 'task-ready', sessionId: 's1', taskId: 't 1' };
    expect(notificationClickTarget('', ready)).toEqual({
      url: '/?task=t%201',
      action: 'view-task',
    });
    expect(notificationClickTarget('view-session', ready).url).toBe('/?task=t%201');
    // Pushes with no session at all (not run, setup failed) still go somewhere.
    expect(notificationClickTarget('', { type: 'task-missed', taskId: 't2' }).url).toBe(
      '/?task=t2'
    );
    // The confirm push keeps its sheet.
    expect(
      notificationClickTarget('', { type: 'task-confirm', confirmId: 'c1', taskId: 't1' }).url
    ).toBe('/?confirm=c1');

    const { api, posted } = clients([{ url: `${origin}/session/x` }]);
    await handleNotificationClick('', ready, api, origin);
    expect(posted[0].message).toEqual({
      type: 'notification-action',
      action: 'view-task',
      data: ready,
    });
  });
});
