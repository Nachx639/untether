import { describe, expect, it } from 'vitest';
import config from '../../../vitest.config';

// 2026-11-10: a check at a machine load of 100-140 failed in session-list.test.ts's beforeAll
// ("Hook timed out in 10000ms") while it imported the client. Hooks load modules, which slows
// down with the machine; tests keep their own, shorter limit.
describe('vitest timeouts', () => {
  it.each(['client', 'server'])('%s: hooks get longer than tests', (mode) => {
    const resolved = typeof config === 'function' ? config({ mode, command: 'serve' }) : config;
    const test = (resolved as { test?: { hookTimeout?: number; testTimeout?: number } }).test;
    expect(test?.testTimeout).toBe(10_000);
    expect(test?.hookTimeout).toBeGreaterThanOrEqual(60_000);
  });
});
