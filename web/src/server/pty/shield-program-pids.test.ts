import { describe, expect, it, vi } from 'vitest';
import { ShieldProgramPids } from './shield-program-pids.js';

describe('ShieldProgramPids', () => {
  it('asks tmux once for several sessions when it can (2026-11-02), one by one otherwise', async () => {
    const panePid = vi.fn(async (sessionId: string) => (sessionId === 'a' ? 10 : 20));
    const panePids = vi.fn(
      async (ids: string[]) => new Map(ids.map((id) => [id, id === 'a' ? 11 : null]))
    );
    const pids = new ShieldProgramPids(panePid, () => true, 10, panePids);

    expect(await pids.refresh(['a', 'b'])).toEqual([{ sessionId: 'a', to: 11 }]);
    expect(panePids).toHaveBeenCalledTimes(1);
    expect(panePid).not.toHaveBeenCalled();
    expect(pids.get('a')).toBe(11);
    expect(pids.get('b')).toBeUndefined();

    // Live stored pid, b gone: nothing to ask until the full check.
    await pids.refresh(['a', 'b']);
    expect(panePids).toHaveBeenCalledTimes(1);

    // One session to ask: its own call.
    const single = new ShieldProgramPids(panePid, () => true, 10, panePids);
    await single.refresh(['b']);
    expect(panePid).toHaveBeenCalledWith('b');
    expect(single.get('b')).toBe(20);
  });
});
