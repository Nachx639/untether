import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { MAX_PENDING_CONFIRMATIONS } from '../../shared/task-confirmations.js';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { confirmationPayload, TaskConfirmations } from './task-confirmations.js';

function store(now = { value: 1_000_000 }) {
  const run = vi.fn(async (action: string) => `ran ${action}`);
  const notify = vi.fn();
  const confirmations = new TaskConfirmations<string, string>({
    run,
    notify,
    now: () => now.value,
  });
  return { confirmations, run, notify, now };
}

const request = (key: string, action = key) => ({
  kind: 'discard' as const,
  where: 'Login',
  summary: 'Discard: Login',
  detail: ['ut/login → main'],
  taskId: 't1',
  requestedBy: { sessionId: 's1', name: 'Claude' },
  action,
  key,
});

describe('TaskConfirmations', () => {
  it('keeps a request, pushes it once per key and runs it once when approved', async () => {
    const { confirmations, run, notify } = store();
    const first = confirmations.request(request('a'));
    expect(confirmations.request(request('a')).id).toBe(first.id);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({
      kind: 'discard',
      where: 'Login',
      taskId: 't1',
      requestedBy: { sessionId: 's1', name: 'Claude' },
      createdAt: new Date(1_000_000).toISOString(),
      expiresAt: new Date(1_000_000 + 30 * 60 * 1000).toISOString(),
    });
    expect(confirmations.get(first.id)?.id).toBe(first.id);
    expect(await confirmations.answer(first.id, true)).toEqual({
      status: 'approved',
      result: 'ran a',
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(await confirmations.answer(first.id, true)).toEqual({ status: 'gone' });
    expect(confirmations.list()).toEqual([]);
  });

  it('answers the session that asked where it was reopened (Llevar a Untether, 2026-10-25)', async () => {
    const { confirmations, run } = store();
    const asked = confirmations.request(request('a', 'from s1'));
    confirmations.request({ ...request('b'), requestedBy: { sessionId: 's2' } });
    expect(confirmations.sessionReplaced('s1', 's9', (action) => action.replace('s1', 's9'))).toBe(
      1
    );
    expect(confirmations.get(asked.id)?.requestedBy).toEqual({ sessionId: 's9', name: 'Claude' });
    expect(
      confirmations
        .list()
        .map((entry) => entry.requestedBy.sessionId)
        .sort()
    ).toEqual(['s2', 's9']);
    await confirmations.answer(asked.id, true);
    expect(run).toHaveBeenCalledWith('from s9');
  });

  it('drops declined and expired ones, and the oldest past the cap', async () => {
    const { confirmations, run, now } = store();
    const declined = confirmations.request(request('a'));
    expect(await confirmations.answer(declined.id, false)).toEqual({ status: 'declined' });
    const old = confirmations.request(request('b'));
    now.value += 30 * 60 * 1000;
    expect(confirmations.get(old.id)).toBeUndefined();
    expect(await confirmations.answer(old.id, true)).toEqual({ status: 'gone' });
    expect(run).not.toHaveBeenCalled();

    const ids = Array.from(
      { length: MAX_PENDING_CONFIRMATIONS + 1 },
      (_, i) => confirmations.request(request(`k${i}`)).id
    );
    const left = confirmations.list().map((entry) => entry.id);
    expect(left).toHaveLength(MAX_PENDING_CONFIRMATIONS);
    expect(left).not.toContain(ids[0]);
    expect(left.at(-1)).toBe(ids.at(-1));
  });

  it('keeps what became of each one, so whoever asked can wait for it (2026-10-23)', async () => {
    const { confirmations, run, now } = store();
    const ok = confirmations.request(request('a'));
    expect(confirmations.outcome(ok.id)?.status).toBe('pending');
    await confirmations.answer(ok.id, true);
    expect(confirmations.outcome(ok.id)).toMatchObject({ status: 'approved', result: 'ran a' });
    const no = confirmations.request(request('b'));
    await confirmations.answer(no.id, false);
    expect(confirmations.outcome(no.id)?.status).toBe('declined');
    run.mockRejectedValueOnce(new Error('boom'));
    const broken = confirmations.request(request('c'));
    await expect(confirmations.answer(broken.id, true)).rejects.toThrow('boom');
    expect(confirmations.outcome(broken.id)).toMatchObject({ status: 'failed', message: 'boom' });
    const late = confirmations.request(request('d'));
    now.value += 31 * 60 * 1000;
    expect(confirmations.outcome(late.id)?.status).toBe('expired');
    expect(confirmations.outcome('unknown')).toBeUndefined();
  });

  it('builds a push the phone localizes by kind, with a deep link id and no session', () => {
    const { confirmations } = store();
    const confirmation = confirmations.request(request('a'));
    const payload = confirmationPayload(confirmation);
    expect(payload).toMatchObject({
      type: 'task-confirm',
      title: '🔐 Confirm · Login',
      body: 'Discard: Login',
      tag: `untether-confirm-${confirmation.id}`,
      requireInteraction: true,
      data: {
        type: 'task-confirm',
        confirmId: confirmation.id,
        kind: 'discard',
        where: 'Login',
        detail: 'ut/login → main',
        taskId: 't1',
      },
    });
    // No sessionId: a muted or on-screen session never swallows a confirmation.
    expect(payload.data).not.toHaveProperty('sessionId');
  });

  it('tells whoever asked when a confirmation expires unanswered (2026-10-20)', () => {
    const now = { value: 1_000_000 };
    const onExpired = vi.fn();
    const confirmations = new TaskConfirmations<string, string>({
      run: async () => 'x',
      notify: vi.fn(),
      onExpired,
      now: () => now.value,
      ttlMs: 1000,
    });
    const asked = confirmations.request(request('a'));
    now.value += 999;
    expect(confirmations.list()).toHaveLength(1);
    expect(onExpired).not.toHaveBeenCalled();
    now.value += 1;
    expect(confirmations.list()).toEqual([]);
    expect(onExpired).toHaveBeenCalledTimes(1);
    expect(onExpired.mock.calls[0][0]).toMatchObject({ id: asked.id, taskId: 't1' });
    confirmations.list();
    expect(onExpired).toHaveBeenCalledTimes(1);
  });

  it('survives a restart when kept on disk, privately; one that expired meanwhile is told (2026-10-20)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-confirm-'));
    try {
      const storePath = path.join(dir, 'confirmations.json');
      const now = { value: 1_000_000 };
      const make = (onExpired = vi.fn()) => {
        const run = vi.fn(async (action: string) => `ran ${action}`);
        const confirmations = new TaskConfirmations<string, string>({
          run,
          notify: vi.fn(),
          onExpired,
          now: () => now.value,
          storePath,
        });
        return { confirmations, run, onExpired };
      };
      const first = make();
      const kept = first.confirmations.request(request('a', 'checkCommand'));
      first.confirmations.request(request('b'));
      expect(fs.statSync(storePath).mode & 0o777).toBe(0o600);

      // The server restarts: both are back, and approving one runs its action.
      const second = make();
      expect(second.confirmations.list().map((entry) => entry.id)).toContain(kept.id);
      expect(await second.confirmations.answer(kept.id, true)).toEqual({
        status: 'approved',
        result: 'ran checkCommand',
      });

      // Down past its expiry: the one left is told as expired, and gone.
      now.value += 24 * 60 * 60 * 1000;
      const third = make();
      expect(third.onExpired).toHaveBeenCalledTimes(1);
      expect(third.confirmations.list()).toEqual([]);
      expect(make().confirmations.list()).toEqual([]);
    } finally {
      fs.rmSync(dir, RM_TEST_DIR);
    }
  });
});

describe('TaskConfirmations with the user’s autoApprove (2026-10-24)', () => {
  function auto(on = { value: true }) {
    const run = vi.fn(async (action: string) => `ran ${action}`);
    const notify = vi.fn();
    const log = vi.fn();
    const confirmations = new TaskConfirmations<string, string>({
      run,
      notify,
      log,
      now: () => 1_000_000,
      autoApprove: () => on.value,
      failedOf: (result) => (result.startsWith('ran fail') ? 'it broke' : undefined),
    });
    return { confirmations, run, notify, log, on };
  }

  it('runs an approved action at once, says so in a notice, and keeps it as settled', async () => {
    const { confirmations, run, notify, log } = auto();
    const outcome = await confirmations.submit(request('a'));
    expect(outcome).toMatchObject({
      status: 'approved',
      result: 'ran a',
      confirmation: { kind: 'discard', where: 'Login', autoApproved: true },
    });
    expect(run).toHaveBeenCalledWith('a');
    expect(confirmations.list()).toEqual([]);
    expect(confirmations.outcome(outcome.confirmation.id)).toMatchObject({
      status: 'approved',
      result: 'ran a',
      confirmation: { autoApproved: true },
    });
    // One informational push, never the "task-confirm" one that asks.
    expect(notify).toHaveBeenCalledTimes(1);
    const payload = notify.mock.calls[0][0];
    expect(payload.type).toBe('task-auto-approved');
    expect(payload.requireInteraction).toBeUndefined();
    expect(payload.title).toBe('✅ Done without asking · Login');
    expect(payload.data).toMatchObject({
      type: 'task-auto-approved',
      kind: 'discard',
      where: 'Login',
      taskId: 't1',
      confirmId: outcome.confirmation.id,
    });
    expect(log).toHaveBeenCalledWith('Approved without asking (autoApprove): Discard: Login');
  });

  it('tells a result that did not work, and an action that threw, as failed', async () => {
    const { confirmations, notify, run } = auto();
    const failed = await confirmations.submit(request('f', 'fail'));
    expect(failed.status).toBe('approved');
    expect(notify.mock.calls[0][0]).toMatchObject({
      title: '⚠️ Approved without asking, but it failed · Login',
      data: { failed: 'it broke' },
    });
    run.mockRejectedValueOnce(new Error('boom'));
    const threw = await confirmations.submit(request('t'));
    expect(threw).toMatchObject({ status: 'failed', message: 'boom' });
    expect(confirmations.outcome(threw.confirmation.id)?.status).toBe('failed');
  });

  it('runs the same request once while it runs, and approves one that waited from before', async () => {
    const { confirmations, run, on } = auto({ value: false });
    const waiting = await confirmations.submit(request('w'));
    expect(waiting.status).toBe('pending');
    on.value = true;
    const again = await confirmations.submit(request('w'));
    expect(again).toMatchObject({
      status: 'approved',
      confirmation: { id: waiting.confirmation.id },
    });
    expect(confirmations.list()).toEqual([]);
    const [one, two] = await Promise.all([
      confirmations.submit(request('x')),
      confirmations.submit(request('x')),
    ]);
    expect(one.confirmation.id).toBe(two.confirmation.id);
    expect(run.mock.calls.filter(([action]) => action === 'x')).toHaveLength(1);
  });

  it('approves every one still waiting when asked (the setting was just turned on)', async () => {
    const { confirmations, run, on } = auto({ value: false });
    const a = confirmations.request(request('a'));
    const b = confirmations.request(request('b'));
    on.value = true;
    const outcomes = await confirmations.approveAllWaiting();
    expect(outcomes.map((outcome) => outcome.confirmation.id)).toEqual([a.id, b.id]);
    expect(run).toHaveBeenCalledTimes(2);
    expect(confirmations.list()).toEqual([]);
  });

  it('off (the default) keeps today’s behaviour: pending, with the push that asks', async () => {
    const { confirmations, run, notify } = store();
    const outcome = await confirmations.submit(request('a'));
    expect(outcome.status).toBe('pending');
    expect(run).not.toHaveBeenCalled();
    expect(notify.mock.calls[0][0].type).toBe('task-confirm');
    expect(confirmations.list()).toHaveLength(1);
  });
});
