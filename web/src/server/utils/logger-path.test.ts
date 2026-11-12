import { describe, expect, it } from 'vitest';
import { defaultLogFile } from './logger.js';

// Every server logged to ~/.untether/log.txt and deleted it on start: each throwaway test
// server wiped the real server's log (2026-10-03).
describe('defaultLogFile', () => {
  it('keeps the real server where it was and gives every other server its own file', () => {
    expect(defaultLogFile(undefined, '/Users/n')).toBe('/Users/n/.untether/log.txt');
    expect(defaultLogFile('/Users/n/.untether/control', '/Users/n')).toBe(
      '/Users/n/.untether/log.txt'
    );
    expect(defaultLogFile('/Users/n/.untether-qa/control', '/Users/n')).toBe(
      '/Users/n/.untether-qa/log.txt'
    );
    expect(defaultLogFile('/tmp/vtg.e7b7', '/Users/n')).toBe('/tmp/vtg.e7b7/log.txt');
  });
});
