import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger, setVerbosityLevel, VerbosityLevel } from './logger.js';

describe('logger error formatting', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('includes Error details instead of serializing them as empty objects', () => {
    setVerbosityLevel(VerbosityLevel.ERROR);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    createLogger('logger-test').error('operation failed:', new Error('diagnostic detail'));

    expect(consoleError).toHaveBeenCalledOnce();
    expect(String(consoleError.mock.calls[0][0])).toContain('Error: diagnostic detail');
  });
});
