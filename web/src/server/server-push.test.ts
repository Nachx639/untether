import { describe, expect, it } from 'vitest';
import { commandDurationText } from './server-push.js';

describe('commandDurationText', () => {
  it('whole minutes and the seconds left, never rounded up (2026-11-10)', () => {
    expect(commandDurationText(5000)).toBe('5s');
    expect(commandDurationText(59_600)).toBe('1m 0s');
    // 90 s read "2m 30s", 119.6 s read "2m 60s".
    expect(commandDurationText(90_000)).toBe('1m 30s');
    expect(commandDurationText(119_600)).toBe('2m 0s');
  });
});
