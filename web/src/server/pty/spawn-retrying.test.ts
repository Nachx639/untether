import { describe, expect, it, vi } from 'vitest';
import { spawnRetrying } from './pty-manager.js';

describe('spawnRetrying', () => {
  it('retries "posix_spawnp failed" (node-pty being rebuilt) until it works', async () => {
    const spawn = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('posix_spawnp failed.');
      })
      .mockReturnValue('pty');
    expect(await spawnRetrying(spawn, { delayMs: 1 })).toBe('pty');
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('reports other errors at once, and this one after the last attempt', async () => {
    const other = vi.fn(() => {
      throw new Error('ENOENT');
    });
    await expect(spawnRetrying(other, { delayMs: 1 })).rejects.toThrow('ENOENT');
    expect(other).toHaveBeenCalledTimes(1);
    const stuck = vi.fn(() => {
      throw new Error('posix_spawnp failed.');
    });
    await expect(spawnRetrying(stuck, { attempts: 3, delayMs: 1 })).rejects.toThrow('posix');
    expect(stuck).toHaveBeenCalledTimes(3);
  });
});
