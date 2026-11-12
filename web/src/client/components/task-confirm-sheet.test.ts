// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskConfirmation } from '../../shared/task-confirmations';
import {
  CONFIRM_GONE_CLOSE_MS,
  CONFIRM_OPEN_GUARD_MS,
  closeTaskConfirmSheet,
  isTaskConfirmSheetOpen,
  openTaskConfirmSheet,
} from './task-confirm-sheet';

const pending: TaskConfirmation = {
  id: 'c1',
  kind: 'merge-risk',
  createdAt: new Date(1_000_000).toISOString(),
  expiresAt: new Date(1_000_000 + 30 * 60_000).toISOString(),
  where: 'login-google',
  taskId: 't1',
  summary: 'Merge login-google with its risky changes',
  detail: ['secrets: .env'],
  requestedBy: { sessionId: 's9', name: 'orchestrator' },
};

function mockApi(list: TaskConfirmation[], post: { status: number; body?: unknown }) {
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (method === 'GET') return new Response(JSON.stringify({ confirmations: list }));
      return new Response(JSON.stringify(post.body ?? {}), { status: post.status });
    })
  );
  return calls;
}

const sheet = () => document.querySelector('[data-testid="task-confirm-sheet"]');
const tap = (el: Element | null | undefined) => {
  el?.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true }));
  el?.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch', bubbles: true }));
};

describe('task confirm sheet', () => {
  let now = 1_000_000;
  beforeEach(() => {
    now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    vi.useFakeTimers({ toFake: ['setTimeout'] });
  });
  afterEach(() => {
    closeTaskConfirmSheet();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('shows the pending action with who asked and when it expires', async () => {
    mockApi([pending], { status: 200 });
    openTaskConfirmSheet({ id: 'c1' });
    await vi.advanceTimersByTimeAsync(10);
    expect(sheet()?.getAttribute('data-phase')).toBe('ready');
    expect(sheet()?.querySelector('#task-confirm-title')?.textContent).toContain(
      'Merge it with its risky changes'
    );
    expect(sheet()?.textContent).toContain('login-google');
    expect(sheet()?.querySelector('[data-testid="task-confirm-detail"]')?.textContent).toContain(
      'secrets: .env'
    );
    const who = sheet()?.querySelector('[data-testid="task-confirm-who"]')?.textContent ?? '';
    expect(who).toContain('Asked by orchestrator');
    expect(who).toContain('Expires in 30 min');
  });

  it('approves with one tap and closes with a message', async () => {
    const calls = mockApi([pending], { status: 200, body: { status: 'approved' } });
    const onDone = vi.fn();
    openTaskConfirmSheet({ id: 'c1', onDone, authHeader: () => ({ Authorization: 'Bearer x' }) });
    await vi.advanceTimersByTimeAsync(10);
    // Not in the first moments: the opening tap must not approve.
    tap(document.getElementById('task-confirm-approve'));
    await vi.advanceTimersByTimeAsync(10);
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
    now += CONFIRM_OPEN_GUARD_MS + 1;
    tap(document.getElementById('task-confirm-approve'));
    await vi.advanceTimersByTimeAsync(10);
    expect(calls.filter((c) => c.method === 'POST')).toEqual([
      { method: 'POST', url: '/api/confirmations/c1', body: { approve: true } },
    ]);
    expect(onDone).toHaveBeenCalledWith('Approved', 'success');
    expect(isTaskConfirmSheetOpen()).toBe(false);
  });

  it('declines', async () => {
    const calls = mockApi([pending], { status: 200, body: { status: 'declined' } });
    const onDone = vi.fn();
    openTaskConfirmSheet({ id: 'c1', onDone });
    await vi.advanceTimersByTimeAsync(10);
    now += CONFIRM_OPEN_GUARD_MS + 1;
    tap(document.getElementById('task-confirm-decline'));
    await vi.advanceTimersByTimeAsync(10);
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ approve: false });
    expect(onDone).toHaveBeenCalledWith('Declined', 'info');
  });

  it('says when the action failed after approving', async () => {
    mockApi([pending], { status: 409, body: { error: 'busy', message: 'The task is busy' } });
    const onDone = vi.fn();
    openTaskConfirmSheet({ id: 'c1', onDone });
    await vi.advanceTimersByTimeAsync(10);
    now += CONFIRM_OPEN_GUARD_MS + 1;
    tap(document.getElementById('task-confirm-approve'));
    await vi.advanceTimersByTimeAsync(10);
    expect(onDone).toHaveBeenCalledWith('Could not do it: The task is busy', 'error');
  });

  it('an expired or answered request says so and closes itself', async () => {
    mockApi([], { status: 404 });
    openTaskConfirmSheet({ id: 'c1' });
    await vi.advanceTimersByTimeAsync(10);
    expect(sheet()?.getAttribute('data-phase')).toBe('gone');
    expect(document.querySelector('[data-testid="task-confirm-gone"]')).not.toBeNull();
    expect(document.getElementById('task-confirm-approve')).toBeNull();
    await vi.advanceTimersByTimeAsync(CONFIRM_GONE_CLOSE_MS + 10);
    expect(isTaskConfirmSheetOpen()).toBe(false);
  });

  it('passes the outcome kind with the message', async () => {
    mockApi([pending], { status: 200 });
    const onDone = vi.fn();
    openTaskConfirmSheet({ id: 'c1', onDone });
    await vi.advanceTimersByTimeAsync(10);
    now += CONFIRM_OPEN_GUARD_MS + 1;
    tap(document.getElementById('task-confirm-approve'));
    await vi.advanceTimersByTimeAsync(10);
    expect(onDone).toHaveBeenCalledWith('Approved', 'success');

    mockApi([pending], { status: 409, body: { message: 'The task is busy' } });
    const failed = vi.fn();
    openTaskConfirmSheet({ id: 'c1', onDone: failed });
    await vi.advanceTimersByTimeAsync(10);
    now += CONFIRM_OPEN_GUARD_MS + 1;
    tap(document.getElementById('task-confirm-decline'));
    await vi.advanceTimersByTimeAsync(10);
    expect(failed).toHaveBeenCalledWith('Could not do it: The task is busy', 'error');
  });

  it('a request it could not read (offline, 403) offers Retry instead of saying it expired', async () => {
    let online = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        if (!online) return new Response('{}', { status: 403 });
        return new Response(JSON.stringify({ confirmations: [pending] }));
      })
    );
    openTaskConfirmSheet({ id: 'c1' });
    await vi.advanceTimersByTimeAsync(3000);
    expect(sheet()?.getAttribute('data-phase')).toBe('unreachable');
    expect(document.querySelector('[data-testid="task-confirm-gone"]')).toBeNull();
    // It stays open: no "expired" auto-close.
    await vi.advanceTimersByTimeAsync(CONFIRM_GONE_CLOSE_MS + 10);
    expect(isTaskConfirmSheetOpen()).toBe(true);

    online = true;
    now += CONFIRM_OPEN_GUARD_MS + 1;
    tap(document.querySelector('[data-testid="task-confirm-retry"]'));
    await vi.advanceTimersByTimeAsync(10);
    expect(sheet()?.getAttribute('data-phase')).toBe('ready');
  });

  it('a kind this client has no words for gets the generic title, not a raw key', async () => {
    mockApi([{ ...pending, kind: 'brand-new' as TaskConfirmation['kind'] }], { status: 200 });
    openTaskConfirmSheet({ id: 'c1' });
    await vi.advanceTimersByTimeAsync(10);
    const title = sheet()?.querySelector('#task-confirm-title')?.textContent ?? '';
    expect(title).not.toContain('notify.taskConfirmKind');
    expect(title.trim().length).toBeGreaterThan(0);
  });
});
