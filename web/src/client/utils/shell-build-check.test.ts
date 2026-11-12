import { describe, expect, it, vi } from 'vitest';
import { bundleBuildId, checkShellBuild } from './shell-build-check';

const A = '0123456789abcdef';
const B = 'fedcba9876543210';

type TestStorage = Pick<Storage, 'getItem' | 'setItem'>;

function memoryStorage(): TestStorage {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  };
}

function check(
  js: string | null,
  cssValue: string,
  storage: TestStorage = memoryStorage(),
  now = 1_000_000
) {
  const reload = vi.fn();
  const log = { warn: vi.fn(), error: vi.fn() };
  const result = checkShellBuild({ js, cssValue, reload, log, storage, now: () => now });
  return { result, reload, log };
}

describe('bundle and stylesheet from one build', () => {
  it('reads the id the build wrote into the bundle, none in an unstamped build', () => {
    expect(bundleBuildId(`ut-build-id:${A}`)).toBe(A);
    // Tests and build-ci.js leave the placeholder.
    expect(bundleBuildId()).toBeNull();
  });

  it('a matching pair, or one without ids, is left alone', () => {
    expect(check(A, ` "${A}"`).result).toBe('match');
    expect(check(null, `"${A}"`).result).toBe('unknown');
    // No stylesheet (failed to load) or one without the property.
    expect(check(A, '').result).toBe('unknown');
  });

  it('new JS with old CSS: logs it and reloads once', () => {
    const storage = memoryStorage();
    const first = check(B, `"${A}"`, storage);
    expect(first.result).toBe('reloading');
    expect(first.reload).toHaveBeenCalledTimes(1);
    expect(first.log.warn.mock.calls[0][0]).toContain(
      `bundle build ${B} runs with stylesheet build ${A}`
    );

    // Still mismatched after the reload: no loop, an error in the log instead.
    const again = check(B, `"${A}"`, storage, 1_000_000 + 30_000);
    expect(again.result).toBe('mismatch');
    expect(again.reload).not.toHaveBeenCalled();
    expect(again.log.error).toHaveBeenCalledTimes(1);

    // A minute later it may reload again.
    expect(check(B, `"${A}"`, storage, 1_000_000 + 61_000).result).toBe('reloading');
  });

  it('never reloads when the guard cannot be kept (storage blocked)', () => {
    const blocked = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {},
    };
    const { result, reload } = check(B, `"${A}"`, blocked);
    expect(result).toBe('mismatch');
    expect(reload).not.toHaveBeenCalled();
  });
});
