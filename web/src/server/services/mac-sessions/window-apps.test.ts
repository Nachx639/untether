import { describe, expect, it, vi } from 'vitest';
import type { SessionInfo } from '../../../shared/types.js';
import { MacWindowApps } from './window-apps.js';

type Session = Pick<SessionInfo, 'id' | 'pid' | 'status'>;

const forwarded = (pid: number, status: Session['status'] = 'running'): Session => ({
  id: `fwd_1759500000000_${pid - 5}`,
  pid,
  status,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('MacWindowApps', () => {
  it('marks only sessions opened with ut in a terminal window', () => {
    const apps = new MacWindowApps(async () => 'Terminal');
    expect(apps.macWindow({ id: 'fwd_1759500000000_905' })).toEqual({ app: null });
    expect(apps.macWindow({ id: '3f0c3d5e-1111-4222-8333-944455556666' })).toBeUndefined();
    expect(apps.macWindow({ id: 'web-1' })).toBeUndefined();
  });

  it('answers what it found so far, and looks the app up in the background', async () => {
    const lookup = deferred<string | null>();
    const hostApp = vi.fn(() => lookup.promise);
    const apps = new MacWindowApps(hostApp);
    const session = forwarded(910);

    apps.refresh([session, { id: 'web-1', pid: 920, status: 'running' }]);
    expect(apps.macWindow(session)).toEqual({ app: null });
    expect(hostApp).toHaveBeenCalledWith(910);
    expect(hostApp).toHaveBeenCalledTimes(1);

    lookup.resolve('Terminal');
    await apps.settled();
    expect(apps.macWindow(session)).toEqual({ app: 'Terminal' });
  });

  it('runs one lookup at a time, only for running sessions with a pid', async () => {
    const lookup = deferred<string | null>();
    const hostApp = vi.fn(() => lookup.promise);
    const apps = new MacWindowApps(hostApp);

    apps.refresh([forwarded(910)]);
    apps.refresh([forwarded(910)]);
    expect(hostApp).toHaveBeenCalledTimes(1);
    lookup.resolve('iTerm');
    await apps.settled();

    hostApp.mockClear();
    apps.refresh([forwarded(930, 'exited'), { id: 'fwd_1759500000000_1', status: 'running' }]);
    await apps.settled();
    expect(hostApp).not.toHaveBeenCalled();
  });

  it('keeps the app once found, also after its process is gone', async () => {
    const hostApp = vi.fn(async (): Promise<string | null> => 'Visual Studio Code');
    const apps = new MacWindowApps(hostApp);
    const session = forwarded(910);
    apps.refresh([session]);
    await apps.settled();

    // Not in the process table (yet, or any more): that says nothing about the window.
    hostApp.mockResolvedValue(null);
    apps.refresh([session]);
    await apps.settled();
    expect(apps.macWindow(session)).toEqual({ app: 'Visual Studio Code' });
    const exited: Session = { ...session, status: 'exited' };
    apps.refresh([exited]);
    await apps.settled();
    expect(apps.macWindow(exited)).toEqual({ app: 'Visual Studio Code' });
  });

  it('shrugs off a lookup that fails, and looks again next time', async () => {
    const hostApp = vi.fn(async (): Promise<string | null> => {
      throw new Error('ps failed');
    });
    const apps = new MacWindowApps(hostApp);
    const session = forwarded(910);
    apps.refresh([session]);
    await apps.settled();
    expect(apps.macWindow(session)).toEqual({ app: null });

    hostApp.mockResolvedValue('SSH');
    apps.refresh([session]);
    await apps.settled();
    expect(apps.macWindow(session)).toEqual({ app: 'SSH' });
  });
});
