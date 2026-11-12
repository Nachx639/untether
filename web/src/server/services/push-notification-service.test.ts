import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { needsYouSeenKey } from '../../shared/ws-v3.js';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { DEFAULT_NOTIFICATION_PREFERENCES } from '../../types/config.js';
import type { VapidManager } from '../utils/vapid-manager.js';
import { ATTENTION_SEEN_MS } from './agent-attention-policy.js';
import {
  HELD_PUSH_STALE_MS,
  NOTIFICATION_PREFERENCE_FOR_TYPE,
  PushNotificationService,
} from './push-notification-service.js';

let dir: string;
const services: PushNotificationService[] = [];
beforeEach(() => {
  // Never the real ~/.untether: a fake 'sub1' once landed in a real user's subscriptions.
  dir = mkdtempSync(path.join(tmpdir(), 'ut-push-'));
});
afterEach(async () => {
  // A held push or bell a timer sent may still be writing subscriptions.json into dir.
  await Promise.all(services.splice(0).map((service) => service.settled()));
  rmSync(dir, RM_TEST_DIR);
});

function makeService(sendNotification: ReturnType<typeof vi.fn>) {
  const vapid = { isEnabled: () => true, sendNotification } as unknown as VapidManager;
  const service = new PushNotificationService(vapid, dir);
  services.push(service);
  const subs = (service as unknown as { subscriptions: Map<string, unknown> }).subscriptions;
  const add = (id: string) =>
    subs.set(id, {
      id,
      endpoint: `https://push.example/${id}`,
      keys: { p256dh: 'p', auth: 'a' },
      subscribedAt: new Date().toISOString(),
      isActive: true,
    });
  return { service, add, subs };
}

/** Only sessions on screen, nothing reported as seen, no client otherwise active. */
function viewing(service: PushNotificationService, isSessionViewed: (id: string) => boolean) {
  service.setAttentionView({
    isSessionViewed,
    wasSeenSince: () => false,
    isAnyClientActive: () => false,
  });
}

function pushError(message: string, statusCode?: number) {
  return Object.assign(new Error(message), { statusCode });
}

describe('PushNotificationService', () => {
  it('says why a push was not sent', async () => {
    // "Claude finished" never reached the iPhone and nothing said why (2026-10-03).
    const sendNotification = vi.fn().mockResolvedValue(undefined);
    const { service, add } = makeService(sendNotification);
    const push = (type: string, sessionId: string) =>
      service.sendNotification({ type, title: 't', body: 'b', data: { sessionId } });
    expect((await push('claude-finished', 's1')).skipped).toBe('no-subscriptions');
    add('sub1');
    service.setMuteFilter((id) => id === 'quiet');
    expect((await push('claude-finished', 'quiet')).skipped).toBe('muted');
    viewing(service, (id) => id === 'shown');
    expect((await push('claude-finished', 'shown')).skipped).toBe('on-screen');
    service.setPreferenceFilter((type) => type !== 'session-exit');
    expect((await push('session-exit', 's1')).skipped).toBe('preferences');
    const sent = await push('claude-finished', 's1');
    expect(sent.skipped).toBeUndefined();
    expect(sent.sent).toBe(1);
  });

  it('records each push but bells in the event log once, with its title and not its body', async () => {
    const { service } = makeService(vi.fn().mockResolvedValue(undefined));
    const events: unknown[] = [];
    service.setEventSink((event) => events.push(event));
    await service.sendNotification({
      type: 'task-needs-you',
      title: 'Task needs you',
      body: 'the agent wrote this',
      data: { sessionId: 's1', taskId: 't1' },
    });
    await service.sendNotification({ type: 'bell', title: 'Bell', body: 'x' });
    // A held push sent later is the same push: not recorded again.
    await service.sendNotification({ type: 'task-needs-you', title: 'again', body: 'x' }, 1);
    expect(events).toEqual([
      {
        type: 'push',
        pushType: 'task-needs-you',
        title: 'Task needs you',
        sessionId: 's1',
        taskId: 't1',
      },
    ]);
  });

  it('drops notifications about a muted session and still sends the others', async () => {
    const sendNotification = vi.fn().mockResolvedValue(undefined);
    const { service, add } = makeService(sendNotification);
    add('sub1');
    service.setMuteFilter((id) => id === 'quiet');

    const muted = await service.sendNotification({
      type: 'claude-finished',
      title: 't',
      body: 'b',
      data: { sessionId: 'quiet' },
    });
    expect(muted.sent).toBe(0);
    expect(sendNotification).not.toHaveBeenCalled();

    const loud = await service.sendNotification({
      type: 'claude-finished',
      title: 't',
      body: 'b',
      data: { sessionId: 'loud' },
    });
    expect(loud.sent).toBe(1);
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });

  it('skips agent, bell and command pushes about a session the user is viewing', async () => {
    const sendNotification = vi.fn().mockResolvedValue(undefined);
    const { service, add } = makeService(sendNotification);
    add('sub1');
    viewing(service, (id) => id === 'on-screen');

    for (const type of [
      'claude-finished',
      'codex-waiting',
      'gemini-finished',
      'bell',
      'command-finished',
      'command-error',
      'task-ready',
      'task-failed',
      'task-merged',
    ]) {
      const result = await service.sendNotification({
        type,
        title: 't',
        body: 'b',
        data: { sessionId: 'on-screen' },
      });
      expect(result.sent, type).toBe(0);
    }
    expect(sendNotification).not.toHaveBeenCalled();

    // Another session, a test push and session start/exit still go out.
    await service.sendNotification({
      type: 'claude-finished',
      title: 't',
      body: 'b',
      data: { sessionId: 'elsewhere' },
    });
    await service.sendNotification({
      type: 'test',
      title: 't',
      body: 'b',
      data: { sessionId: 'on-screen' },
    });
    await service.sendNotification({
      type: 'session-exit',
      title: 't',
      body: 'b',
      data: { sessionId: 'on-screen' },
    });
    // "Task not run" has no session to look at; a task type that only starts like ours goes too.
    await service.sendNotification({
      type: 'task-missed',
      title: 't',
      body: 'b',
      data: { sessionId: 'on-screen' },
    });
    await service.sendNotification({
      type: 'task-ready-ish',
      title: 't',
      body: 'b',
      data: { sessionId: 'on-screen' },
    });
    expect(sendNotification).toHaveBeenCalledTimes(5);
  });

  it('sends "Preview ready" unless that preview view is on screen, even with its session open', async () => {
    const sendNotification = vi.fn().mockResolvedValue(undefined);
    const { service, add } = makeService(sendNotification);
    add('sub1');
    viewing(service, (id) => id === 's1');
    service.setPreviewViewedFilter((id) => id === 'pshop123');
    const ready = (id: string, port: number) =>
      service.sendNotification({
        type: 'preview-ready',
        title: 't',
        body: 'b',
        data: { id, sessionId: 's1', port },
      });

    expect((await ready('pshop123', 5173)).sent).toBe(0); // its view is on screen
    expect((await ready('papi4567', 3000)).sent).toBe(1); // the terminal (or another preview) is
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });

  it('sends with a timeout and does not wait on one stuck endpoint before the others', async () => {
    const started: string[] = [];
    // VapidManager's parameters, so the options it is called with are typed below.
    const sendNotification = vi.fn((...[sub]: Parameters<VapidManager['sendNotification']>) => {
      started.push(sub.endpoint);
      return sub.endpoint.endsWith('stuck') ? new Promise(() => {}) : Promise.resolve();
    });
    const { service, add } = makeService(sendNotification);
    add('stuck');
    add('ok');

    void service.sendNotification({ type: 'test', title: 't', body: 'b' });
    await Promise.resolve();
    expect(started).toEqual(['https://push.example/stuck', 'https://push.example/ok']);
    expect(sendNotification.mock.calls[0][2]).toMatchObject({
      timeout: expect.any(Number),
      TTL: expect.any(Number),
    });
  });

  it('removes gone or unusable subscriptions but keeps them on server-side auth errors', async () => {
    const sendNotification = vi.fn((sub: { endpoint: string }) => {
      const id = sub.endpoint.split('/').pop();
      if (id === 'gone') return Promise.reject(pushError('Received unexpected response code', 410));
      if (id === 'missing')
        return Promise.reject(pushError('Received unexpected response code', 404));
      if (id === 'badkey')
        return Promise.reject(pushError('The subscription p256dh value should be 65 bytes long.'));
      if (id === 'jwt') return Promise.reject(pushError('Received unexpected response code', 403));
      return Promise.resolve();
    });
    const { service, add, subs } = makeService(sendNotification);
    for (const id of ['gone', 'missing', 'badkey', 'jwt', 'ok']) add(id);

    const result = await service.sendNotification({ type: 'test', title: 't', body: 'b' });
    expect(result).toMatchObject({ sent: 1, failed: 4 });
    expect([...subs.keys()].sort()).toEqual(['jwt', 'ok']);
    const saved = JSON.parse(readFileSync(path.join(dir, 'subscriptions.json'), 'utf8'));
    expect(saved.map((s: { id: string }) => s.id).sort()).toEqual(['jwt', 'ok']);
  });
});

describe('PushNotificationService subscriptions file (2026-11-10)', () => {
  const file = () => path.join(dir, 'subscriptions.json');

  it('a push that removes nothing does not rewrite the file', async () => {
    const { service, add } = makeService(vi.fn(() => Promise.resolve()));
    add('ok');
    await service.sendNotification({ type: 'test', title: 't', body: 'b' });
    expect(existsSync(file())).toBe(false);
  });

  it('pushes at once that each remove a subscription leave whole JSON and no temporary', async () => {
    const sendNotification = vi.fn((sub: { endpoint: string }) =>
      sub.endpoint.includes('gone')
        ? Promise.reject(pushError('Received unexpected response code', 410))
        : Promise.resolve()
    );
    const { service, add } = makeService(sendNotification);
    for (let i = 0; i < 40; i++) add(`keep-${i}`);
    add('gone-a');
    const first = service.sendNotification({ type: 'test', title: 't', body: 'b' });
    add('gone-b');
    const second = service.sendNotification({ type: 'test', title: 't', body: 'b' });
    await Promise.all([first, second]);
    const saved = JSON.parse(readFileSync(file(), 'utf8'));
    expect(saved).toHaveLength(40);
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('an unreadable file is set aside, not overwritten with an empty list', async () => {
    writeFileSync(file(), '[{"id":"phone","endpoint":"https://push.example/phone"');
    const { service } = makeService(vi.fn(() => Promise.resolve()));
    await service.initialize();
    const aside = readdirSync(dir).filter((name) => name.startsWith('subscriptions.json.bad-'));
    expect(aside).toHaveLength(1);
    expect(readFileSync(path.join(dir, aside[0]), 'utf8')).toContain('"phone"');
  });
});

describe('PushNotificationService bells', () => {
  const bell = (id: string) => ({ type: 'bell', title: 'b', body: 'b', data: { sessionId: id } });
  const claude = (id: string) => ({
    type: 'claude-finished',
    title: 'c',
    body: 'c',
    data: { sessionId: id },
  });

  afterEach(() => vi.useRealTimers());

  it('sends one bell per session per minute, under one tag per session', async () => {
    vi.useFakeTimers();
    const sendNotification = vi.fn().mockResolvedValue(undefined);
    const { service, add } = makeService(sendNotification);
    add('phone');
    for (let i = 0; i < 12; i++) {
      service.queueSessionBell('s1', bell('s1'));
      await vi.advanceTimersByTimeAsync(1000);
    }
    await vi.advanceTimersByTimeAsync(5000);
    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(JSON.parse(sendNotification.mock.calls[0][1]).tag).toBe('untether-bell-s1');

    await vi.advanceTimersByTimeAsync(60_000);
    service.queueSessionBell('s1', bell('s1'));
    service.queueSessionBell('s2', bell('s2'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(sendNotification).toHaveBeenCalledTimes(3);
  });

  it('drops a bell when the agent notification for that session lands around it', async () => {
    vi.useFakeTimers();
    const sendNotification = vi.fn().mockResolvedValue(undefined);
    const { service, add } = makeService(sendNotification);
    add('phone');

    // Bell first, Claude-finished 1.5 s later: only Claude's notification.
    service.queueSessionBell('s1', bell('s1'));
    await vi.advanceTimersByTimeAsync(1500);
    await service.sendNotification(claude('s1'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(sendNotification.mock.calls.map((c) => JSON.parse(c[1]).data.type)).toEqual([
      'claude-finished',
    ]);

    // Claude first, bell right after: dropped too.
    await service.sendNotification(claude('s2'));
    expect(service.queueSessionBell('s2', bell('s2'))).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(sendNotification).toHaveBeenCalledTimes(2);
  });
});

describe('PushNotificationService preference filter', () => {
  it('with default preferences, only agent notifications and command errors reach the phone', async () => {
    const sendNotification = vi.fn().mockResolvedValue(undefined);
    const { service, add } = makeService(sendNotification);
    add('phone');
    service.setPreferenceFilter((type) => {
      const key = NOTIFICATION_PREFERENCE_FOR_TYPE[type];
      return key ? DEFAULT_NOTIFICATION_PREFERENCES[key] !== false : true;
    });

    const types = ['session-start', 'session-exit', 'session-error', 'command-finished', 'bell'];
    for (const type of types) {
      expect((await service.sendNotification({ type, title: 't', body: 'b' })).sent).toBe(0);
    }
    expect(sendNotification).not.toHaveBeenCalled();
    for (const type of [
      'claude-waiting',
      'claude-finished',
      'command-error',
      'preview-ready',
      'test',
    ]) {
      expect((await service.sendNotification({ type, title: 't', body: 'b' })).sent).toBe(1);
    }
  });

  describe('important pushes while a client may be looking (agent-attention-policy)', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    function attention() {
      const sendNotification = vi.fn().mockResolvedValue(undefined);
      const { service, add } = makeService(sendNotification);
      add('sub1');
      const view = {
        viewed: new Set<string>(),
        seen: new Map<string, number>(),
        active: false,
      };
      service.setAttentionView({
        isSessionViewed: (id) => view.viewed.has(id),
        wasSeenSince: (key, since) => (view.seen.get(key) ?? -1) >= since,
        isAnyClientActive: () => view.active,
      });
      return { service, sendNotification, view };
    }
    const needsYou = (taskId = 't1', sessionId = 's1') => ({
      type: 'task-needs-you',
      title: 't',
      body: 'b',
      tag: `untether-task-${taskId}`,
      data: { sessionId, taskId },
    });
    const confirm = (confirmId = 'c1') => ({
      type: 'task-confirm',
      title: 't',
      body: 'b',
      tag: `untether-confirm-${confirmId}`,
      data: { confirmId },
    });

    it('never sends a held push whose subject was resolved meanwhile (2026-11-09)', async () => {
      const { service, sendNotification, view } = attention();
      view.viewed.add('s1');
      expect((await service.sendNotification(needsYou())).skipped).toBe('held');
      expect((await service.sendNotification(needsYou('t2', 's1'))).skipped).toBe('held');
      service.withdrawHeld((push) => push.data?.taskId === 't1');
      view.viewed.clear();
      await vi.advanceTimersByTimeAsync(ATTENTION_SEEN_MS);
      expect(sendNotification).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(sendNotification.mock.calls[0])).toContain('t2');
    });

    it('sends at once when no client is looking', async () => {
      const { service, sendNotification } = attention();
      expect((await service.sendNotification(needsYou())).sent).toBe(1);
      expect((await service.sendNotification(confirm())).sent).toBe(1);
      expect(
        (await service.sendNotification({ type: 'untether-doctor', title: 't', body: 'b' })).sent
      ).toBe(1);
      expect(sendNotification).toHaveBeenCalledTimes(3);
    });

    it('holds "needs you" while its session is on screen and sends it if the user looked away', async () => {
      const { service, sendNotification, view } = attention();
      view.viewed.add('s1');
      expect((await service.sendNotification(needsYou())).skipped).toBe('held');
      expect(sendNotification).not.toHaveBeenCalled();
      view.viewed.delete('s1');
      await vi.advanceTimersByTimeAsync(ATTENTION_SEEN_MS);
      expect(sendNotification).toHaveBeenCalledTimes(1);
    });

    it('drops "needs you" that stayed on screen the whole hold', async () => {
      const { service, sendNotification, view } = attention();
      view.viewed.add('s1');
      await service.sendNotification(needsYou());
      await vi.advanceTimersByTimeAsync(ATTENTION_SEEN_MS);
      expect(sendNotification).not.toHaveBeenCalled();
    });

    it('drops a confirmation the attention strip showed during the hold, sends one it did not', async () => {
      const { service, sendNotification, view } = attention();
      view.active = true; // the list is on screen somewhere
      expect((await service.sendNotification(confirm('c1'))).skipped).toBe('held');
      expect((await service.sendNotification(confirm('c2'))).skipped).toBe('held');
      // Seen before the push was held does not count: only after.
      view.seen.set('confirm:c2', Date.now() - 1);
      await vi.advanceTimersByTimeAsync(1_000);
      view.seen.set('confirm:c1', Date.now());
      await vi.advanceTimersByTimeAsync(ATTENTION_SEEN_MS);
      expect(sendNotification).toHaveBeenCalledTimes(1);
      const sent = JSON.parse(sendNotification.mock.calls[0][1] as string);
      expect(sent.data.confirmId).toBe('c2');
    });

    it('a newer push under the same tag replaces the held one', async () => {
      const { service, sendNotification, view } = attention();
      view.viewed.add('s1');
      await service.sendNotification({ ...needsYou(), body: 'first' });
      await vi.advanceTimersByTimeAsync(ATTENTION_SEEN_MS / 2);
      await service.sendNotification({ ...needsYou(), body: 'second' });
      view.viewed.delete('s1');
      await vi.advanceTimersByTimeAsync(ATTENTION_SEEN_MS);
      expect(sendNotification).toHaveBeenCalledTimes(1);
      expect(JSON.parse(sendNotification.mock.calls[0][1] as string).body).toBe('second');
    });

    it('settled() and shutdown wait for a held push a timer sent, subscriptions write included', async () => {
      const { service, sendNotification, view } = attention();
      let release!: () => void;
      // A gone endpoint: the one case that rewrites subscriptions.json after a push.
      sendNotification.mockImplementation(
        () => new Promise<void>((_, reject) => (release = () => reject(pushError('gone', 410))))
      );
      view.viewed.add('s1');
      await service.sendNotification(needsYou());
      view.viewed.delete('s1');
      await vi.advanceTimersByTimeAsync(ATTENTION_SEEN_MS);
      expect(sendNotification).toHaveBeenCalledTimes(1);
      let done = false;
      const settled = service.settled().then(() => (done = true));
      const shutdown = service.shutdown();
      await vi.advanceTimersByTimeAsync(0);
      expect(done).toBe(false);
      release();
      await Promise.all([settled, shutdown]);
      expect(JSON.parse(readFileSync(path.join(dir, 'subscriptions.json'), 'utf8'))).toHaveLength(
        0
      );
    });

    it('a shutdown sends the held pushes nobody has seen', async () => {
      const { service, sendNotification, view } = attention();
      view.viewed.add('s1');
      await service.sendNotification(needsYou());
      view.viewed.delete('s1');
      await service.shutdown();
      expect(sendNotification).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(ATTENTION_SEEN_MS);
      expect(sendNotification).toHaveBeenCalledTimes(1);
    });

    it('a held push survives a restart: held again for what was left, then sent unless seen (2026-11-02)', async () => {
      const first = attention();
      first.view.viewed.add('s1');
      await first.service.sendNotification(needsYou());
      await vi.advanceTimersByTimeAsync(ATTENTION_SEEN_MS - 10_000);
      // The server goes without a shutdown (a dev restart, a crash): its timer with it.
      const held = (
        first.service as unknown as { heldPushes: Map<string, { timer: NodeJS.Timeout }> }
      ).heldPushes;
      for (const { timer } of held.values()) clearTimeout(timer);
      const second = attention();
      await second.service.initialize();
      await vi.advanceTimersByTimeAsync(9_000);
      expect(second.sendNotification).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(second.sendNotification).toHaveBeenCalledTimes(1);
      expect(first.sendNotification).not.toHaveBeenCalled();
      // Sent: gone from disk, a third server sends nothing.
      expect(existsSync(path.join(dir, 'held-pushes.json'))).toBe(false);
    });

    it('a held push seen during the hold is not sent by the next server either', async () => {
      const first = attention();
      first.view.viewed.add('s1');
      const heldAt = Date.now();
      await first.service.sendNotification(needsYou());
      const second = attention();
      second.view.seen.set(needsYouSeenKey('t1'), heldAt + 1);
      await second.service.initialize();
      await vi.advanceTimersByTimeAsync(ATTENTION_SEEN_MS);
      expect(second.sendNotification).not.toHaveBeenCalled();
    });

    it('a held push whose time passed long before the next start is dropped', async () => {
      const first = attention();
      first.view.viewed.add('s1');
      await first.service.sendNotification(needsYou());
      vi.setSystemTime(Date.now() + ATTENTION_SEEN_MS + HELD_PUSH_STALE_MS + 1);
      const second = attention();
      await second.service.initialize();
      await vi.advanceTimersByTimeAsync(ATTENTION_SEEN_MS);
      expect(second.sendNotification).not.toHaveBeenCalled();
      expect(existsSync(path.join(dir, 'held-pushes.json'))).toBe(false);
    });

    it('the doctor has nothing a client shows: sent at once even with clients active', async () => {
      const { service, sendNotification, view } = attention();
      view.active = true;
      await service.sendNotification({ type: 'untether-doctor', title: 't', body: 'b' });
      expect(sendNotification).toHaveBeenCalledTimes(1);
    });

    it('ordinary pushes are still skipped, not held, while their session is on screen', async () => {
      const { service, sendNotification, view } = attention();
      view.viewed.add('s1');
      const result = await service.sendNotification({
        type: 'task-ready',
        title: 't',
        body: 'b',
        data: { sessionId: 's1', taskId: 't1' },
      });
      expect(result.skipped).toBe('on-screen');
      await vi.advanceTimersByTimeAsync(ATTENTION_SEEN_MS * 2);
      expect(sendNotification).not.toHaveBeenCalled();
    });
  });
});
