// User report (2026-10-14): a Mac-window session went back and forth between a phone's and
// its window's width while only the phone was in use, and each change left a copy of Claude
// Code's screen in the history. One owner per session now decides its size.
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeWsV3ResizePayload, encodeWsV3ResizePayload } from '../../shared/ws-v3';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { PtyManager, SIZE_SWEEP_INTERVAL_MS } from './pty-manager';
import {
  ANONYMOUS_OWNER,
  awayGiveBackDecision,
  SIZE_AWAY_GIVE_BACK_MS,
  SIZE_ECHO_MS,
  SizeOwners,
  sizeGiveBackDecision,
  sizeRequestDecision,
  WINDOW_OWNER,
} from './size-owner';

vi.mock('../utils/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), log: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

describe('resize payload', () => {
  it('carries the claim and the page id', () => {
    const payload = encodeWsV3ResizePayload(57, 72, { claim: true, clientId: 'page-1' });
    expect(decodeWsV3ResizePayload(payload)).toEqual({
      cols: 57,
      rows: 72,
      claim: true,
      clientId: 'page-1',
    });
    expect(decodeWsV3ResizePayload(encodeWsV3ResizePayload(80, 24))).toEqual({
      cols: 80,
      rows: 24,
      claim: false,
      clientId: null,
    });
  });

  // 2026-11-11: a RESIZE of only cols and rows (before the flags existed) was still taken.
  it('is the whole header or nothing', () => {
    const whole = encodeWsV3ResizePayload(80, 24);
    expect(whole.byteLength).toBe(12);
    expect(decodeWsV3ResizePayload(whole.subarray(0, 8))).toBeNull();
    expect(decodeWsV3ResizePayload(whole.subarray(0, 11))).toBeNull();
  });
});

describe('sizeRequestDecision', () => {
  const base = {
    forwarded: true,
    owner: null,
    clientId: 'phone',
    claim: false,
    ownerViewing: true,
  };

  it('leaves a Mac-window session to its window until a page claims it', () => {
    expect(sizeRequestDecision(base)).toEqual({ apply: false, reason: 'window-owns' });
    expect(sizeRequestDecision({ ...base, claim: true })).toEqual({ apply: true, owner: 'phone' });
  });

  it("applies the owner's own changes, ignores another page's", () => {
    expect(sizeRequestDecision({ ...base, owner: 'phone' })).toEqual({
      apply: true,
      owner: 'phone',
    });
    expect(sizeRequestDecision({ ...base, owner: 'desktop' })).toEqual({
      apply: false,
      reason: 'other-client-owns',
    });
    expect(sizeRequestDecision({ ...base, owner: WINDOW_OWNER })).toEqual({
      apply: false,
      reason: 'window-owns',
    });
  });

  it('hands the size on when its owning page no longer shows the session', () => {
    expect(sizeRequestDecision({ ...base, owner: 'desktop', ownerViewing: false })).toEqual({
      apply: true,
      owner: 'phone',
    });
  });

  it('never hands it to a page that does not show the session either (a tab left behind)', () => {
    expect(
      sizeRequestDecision({
        ...base,
        owner: 'phone',
        clientId: 'desktop',
        ownerViewing: false,
        senderViewing: false,
      })
    ).toEqual({ apply: false, reason: 'other-client-owns' });
    expect(
      sizeRequestDecision({
        ...base,
        owner: 'phone',
        clientId: 'desktop',
        ownerViewing: false,
        senderViewing: true,
      })
    ).toEqual({ apply: true, owner: 'desktop' });
    // Its own owner, back from a lock before its next VIEWING frame: still its own.
    expect(
      sizeRequestDecision({ ...base, owner: 'phone', ownerViewing: false, senderViewing: false })
    ).toEqual({ apply: true, owner: 'phone' });
  });

  it('gives a session started from Untether to the first page that sizes it', () => {
    expect(sizeRequestDecision({ ...base, forwarded: false })).toEqual({
      apply: true,
      owner: 'phone',
    });
  });

  it('applies a resize from a client without an id (a native app) as before', () => {
    expect(sizeRequestDecision({ ...base, owner: 'desktop', clientId: null })).toEqual({
      apply: true,
      owner: ANONYMOUS_OWNER,
    });
    expect(sizeRequestDecision({ ...base, owner: ANONYMOUS_OWNER })).toEqual({
      apply: true,
      owner: 'phone',
    });
  });
});

describe('sizeGiveBackDecision', () => {
  it('gives the size back only from its owner, while nobody else shows the session', () => {
    const base = { owner: 'phone', clientId: 'phone', viewedElsewhere: false };
    expect(sizeGiveBackDecision(base)).toBeNull();
    expect(sizeGiveBackDecision({ ...base, viewedElsewhere: true })).toBe('viewed-elsewhere');
    expect(sizeGiveBackDecision({ ...base, owner: 'desktop' })).toBe('not-owner');
    expect(sizeGiveBackDecision({ ...base, owner: WINDOW_OWNER })).toBe('not-owner');
  });
});

// User report 2026-10-14: a Mac window stayed at a locked phone's width.
describe('awayGiveBackDecision', () => {
  const base = {
    forwarded: true,
    owner: 'phone',
    awayMs: SIZE_AWAY_GIVE_BACK_MS,
    viewedElsewhere: false,
  };
  it('gives a Mac window its size back once the owning page has been away long enough', () => {
    expect(awayGiveBackDecision(base)).toBe(true);
    expect(awayGiveBackDecision({ ...base, awayMs: SIZE_AWAY_GIVE_BACK_MS - 1 })).toBe(false);
    expect(awayGiveBackDecision({ ...base, awayMs: 75_000 })).toBe(false);
    expect(awayGiveBackDecision({ ...base, awayMs: 0 })).toBe(false);
  });
  it('never for a page nothing is known of, nor while another page looks at the session', () => {
    expect(awayGiveBackDecision({ ...base, awayMs: null })).toBe(false);
    expect(awayGiveBackDecision({ ...base, viewedElsewhere: true })).toBe(false);
  });
  it('only for a page owning a Mac-window session', () => {
    expect(awayGiveBackDecision({ ...base, forwarded: false })).toBe(false);
    expect(awayGiveBackDecision({ ...base, owner: WINDOW_OWNER })).toBe(false);
    expect(awayGiveBackDecision({ ...base, owner: ANONYMOUS_OWNER })).toBe(false);
    expect(awayGiveBackDecision({ ...base, owner: null })).toBe(false);
  });
});

describe('SizeOwners', () => {
  it("takes a late echo of the server's own resize for its own, another size for the window's", () => {
    let now = 1000;
    const owners = new SizeOwners(() => now);
    owners.setOwner('fwd_1', 'phone');
    owners.noteSent('fwd_1', 80, 33);
    owners.noteSent('fwd_1', 80, 72);
    // The 80x33 shows up in the recording after the 80x72 was already sent.
    now += 200;
    expect(owners.noteStreamSize('fwd_1', 80, 33)).toBe(false);
    expect(owners.noteStreamSize('fwd_1', 80, 72)).toBe(false);
    expect(owners.owner('fwd_1')).toBe('phone');
    // Long after, the last size sent is still its own; an older one is not.
    now += SIZE_ECHO_MS + 1;
    expect(owners.noteStreamSize('fwd_1', 80, 72)).toBe(false);
    expect(owners.noteStreamSize('fwd_1', 80, 33)).toBe(true);
    expect(owners.owner('fwd_1')).toBe(WINDOW_OWNER);
  });

  it('a size nobody asked for means the window took it', () => {
    const owners = new SizeOwners();
    owners.setOwner('fwd_1', 'phone');
    owners.noteSent('fwd_1', 57, 72);
    expect(owners.noteStreamSize('fwd_1', 120, 67)).toBe(true);
    expect(owners.owner('fwd_1')).toBe(WINDOW_OWNER);
  });
});

describe('PtyManager with a Mac-window session', () => {
  let dir: string;
  let manager: PtyManager;
  const id = 'fwd_1_2';
  let stdout: string;
  const castResize = (cols: number, rows: number, t = 1) =>
    fs.appendFileSync(stdout, `[${t},"r","${cols}x${rows}"]\n[${t},"o","x"]\n`);

  beforeAll(async () => {
    await PtyManager.initialize();
  });

  // The forwarder's control socket: a message to a session without one fails (2026-10-20).
  let forwarderSocket: net.Server;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'utso-'));
    fs.mkdirSync(path.join(dir, id));
    stdout = path.join(dir, id, 'stdout');
    fs.writeFileSync(stdout, '{"version":2,"width":120,"height":67}\n');
    forwarderSocket = net.createServer((socket) => socket.resume());
    await new Promise<void>((resolve) =>
      forwarderSocket.listen(path.join(dir, id, 'ipc.sock'), resolve)
    );
    manager = new PtyManager(dir);
  });

  afterEach(async () => {
    await new Promise((resolve) => forwarderSocket.close(resolve));
    fs.rmSync(path.join(dir, id), RM_TEST_DIR);
    fs.rmdirSync(dir);
  });

  it('follows its owner, ignores the others, and notices the window taking it back', () => {
    manager.setClientViewingCheck(() => true);
    // A page only showing it (a reload): the window keeps it.
    expect(manager.resizeSession(id, 57, 72, { clientId: 'phone' })).toEqual({
      applied: false,
      reason: 'window-owns',
    });
    // A tap on the phone.
    expect(manager.resizeSession(id, 57, 72, { clientId: 'phone', claim: true })).toEqual({
      applied: true,
    });
    castResize(57, 72);
    // The phone's keyboard: its own change.
    expect(manager.resizeSession(id, 57, 33, { clientId: 'phone' }).applied).toBe(true);
    castResize(57, 33);
    // The desktop page open on it, its window resized: not the owner.
    expect(manager.resizeSession(id, 184, 39, { clientId: 'desktop' }).applied).toBe(false);
    expect(manager.getSizeOwner(id)).toBe('phone');
    // Typed into at the Mac: the forwarder resizes the PTY itself.
    castResize(120, 67);
    expect(manager.resizeSession(id, 57, 72, { clientId: 'phone' })).toEqual({
      applied: false,
      reason: 'window-owns',
    });
    expect(manager.getSizeOwner(id)).toBe(WINDOW_OWNER);
  });

  it('sends nothing for a size the PTY already has (a reload, a claim at the same size)', () => {
    const send = vi.spyOn(
      manager as unknown as { sendControlMessage: (...args: unknown[]) => boolean },
      'sendControlMessage'
    );
    // The recording says 120x67 before the server first looks.
    castResize(120, 67);
    expect(manager.getSizeOwner(id)).toBeNull();
    expect(manager.resizeSession(id, 120, 67, { clientId: 'desk', claim: true })).toEqual({
      applied: true,
    });
    expect(send).not.toHaveBeenCalled();
    expect(manager.getSizeOwner(id)).toBe('desk');
    manager.resizeSession(id, 104, 46, { clientId: 'desk' });
    castResize(104, 46);
    manager.resizeSession(id, 104, 46, { clientId: 'desk' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('gives the size back only for its owner, and the window owns it afterwards', () => {
    manager.resizeSession(id, 57, 72, { clientId: 'phone', claim: true });
    castResize(57, 72);
    expect(manager.resetSessionSize(id, { clientId: 'desktop', viewedElsewhere: false })).toEqual({
      reset: false,
      reason: 'not-owner',
    });
    expect(manager.resetSessionSize(id, { clientId: 'phone', viewedElsewhere: true })).toEqual({
      reset: false,
      reason: 'viewed-elsewhere',
    });
    expect(manager.resetSessionSize(id, { clientId: 'phone' })).toEqual({ reset: true });
    expect(manager.getSizeOwner(id)).toBe(WINDOW_OWNER);
  });
  describe('with its owning page away', () => {
    let away: Map<string, number | null>;
    let viewedElsewhere: boolean;
    let send: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      vi.useFakeTimers();
      away = new Map();
      viewedElsewhere = false;
      manager.setClientViewingCheck(() => true);
      manager.setClientPresenceChecks({
        awayMs: (clientId) => (away.has(clientId) ? (away.get(clientId) ?? null) : null),
        viewedElsewhere: () => viewedElsewhere,
      });
      send = vi
        .spyOn(
          manager as unknown as { sendControlMessage: (...args: unknown[]) => boolean },
          'sendControlMessage'
        )
        .mockReturnValue(true);
      manager.resizeSession(id, 57, 72, { clientId: 'phone', claim: true });
      castResize(57, 72);
      send.mockClear();
    });

    afterEach(async () => {
      await manager.shutdown();
      vi.useRealTimers();
    });

    const resets = () =>
      send.mock.calls.filter((call: unknown[]) => (call[1] as { cmd: string }).cmd === 'reset-size')
        .length;

    it('keeps the size through a short absence, gives it back after a long one', async () => {
      away.set('phone', 75_000);
      await vi.advanceTimersByTimeAsync(SIZE_SWEEP_INTERVAL_MS * 4);
      expect(resets()).toBe(0);
      expect(manager.getSizeOwner(id)).toBe('phone');

      away.set('phone', SIZE_AWAY_GIVE_BACK_MS);
      await vi.advanceTimersByTimeAsync(SIZE_SWEEP_INTERVAL_MS);
      expect(resets()).toBe(1);
      expect(manager.getSizeOwner(id)).toBe(WINDOW_OWNER);

      // Back on the phone without using it: its resizes are skipped, nothing more is sent.
      away.set('phone', 0);
      castResize(120, 67);
      expect(manager.resizeSession(id, 57, 72, { clientId: 'phone' }).applied).toBe(false);
      await vi.advanceTimersByTimeAsync(SIZE_SWEEP_INTERVAL_MS * 4);
      expect(resets()).toBe(1);
      // A tap takes it again.
      expect(manager.resizeSession(id, 57, 72, { clientId: 'phone', claim: true }).applied).toBe(
        true
      );
      expect(manager.getSizeOwner(id)).toBe('phone');
    });

    it('does nothing for a page it knows nothing of, or while another page looks at it', async () => {
      await vi.advanceTimersByTimeAsync(SIZE_SWEEP_INTERVAL_MS * 4);
      expect(resets()).toBe(0);
      away.set('phone', 10 * 60_000);
      viewedElsewhere = true;
      await vi.advanceTimersByTimeAsync(SIZE_SWEEP_INTERVAL_MS * 2);
      expect(resets()).toBe(0);
      expect(manager.getSizeOwner(id)).toBe('phone');
    });

    it('sends nothing when the window took the size back meanwhile (typed into)', async () => {
      castResize(120, 67);
      away.set('phone', 10 * 60_000);
      await vi.advanceTimersByTimeAsync(SIZE_SWEEP_INTERVAL_MS * 2);
      expect(resets()).toBe(0);
      expect(manager.getSizeOwner(id)).toBe(WINDOW_OWNER);
    });

    it('tries again later when the forwarder does not answer', async () => {
      send.mockReturnValue(false);
      away.set('phone', 10 * 60_000);
      await vi.advanceTimersByTimeAsync(SIZE_SWEEP_INTERVAL_MS);
      expect(manager.getSizeOwner(id)).toBe('phone');
      send.mockReturnValue(true);
      await vi.advanceTimersByTimeAsync(SIZE_SWEEP_INTERVAL_MS);
      expect(manager.getSizeOwner(id)).toBe(WINDOW_OWNER);
    });
  });
});
