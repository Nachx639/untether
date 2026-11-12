import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VerbosityLevel } from '../../server/utils/logger';
import { parseVerbosityFromEnv } from '../../server/utils/verbosity-parser';
import { snapshotEnv } from '../helpers/env-snapshot.js';

describe('Verbosity Parser', () => {
  let restoreEnv: () => void;

  beforeEach(() => {
    // Reset environment variables before each test
    restoreEnv = snapshotEnv();
    delete process.env.UNTETHER_LOG_LEVEL;
    delete process.env.UNTETHER_DEBUG;
  });

  afterEach(() => {
    restoreEnv();
  });

  describe('parseVerbosityFromEnv', () => {
    it('should return undefined when no environment variables are set', () => {
      expect(parseVerbosityFromEnv()).toBeUndefined();
    });

    it('should parse UNTETHER_LOG_LEVEL correctly', () => {
      process.env.UNTETHER_LOG_LEVEL = 'info';
      expect(parseVerbosityFromEnv()).toBe(VerbosityLevel.INFO);

      process.env.UNTETHER_LOG_LEVEL = 'DEBUG';
      expect(parseVerbosityFromEnv()).toBe(VerbosityLevel.DEBUG);

      process.env.UNTETHER_LOG_LEVEL = 'silent';
      expect(parseVerbosityFromEnv()).toBe(VerbosityLevel.SILENT);
    });

    it('should return undefined for invalid UNTETHER_LOG_LEVEL', () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      process.env.UNTETHER_LOG_LEVEL = 'invalid';
      expect(parseVerbosityFromEnv()).toBeUndefined();

      expect(consoleWarnSpy).toHaveBeenCalledTimes(2);
      expect(consoleWarnSpy).toHaveBeenCalledWith('Invalid UNTETHER_LOG_LEVEL: invalid');
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        'Valid levels: silent, error, warn, info, verbose, debug'
      );

      consoleWarnSpy.mockRestore();
    });

    it('should handle UNTETHER_DEBUG=1', () => {
      process.env.UNTETHER_DEBUG = '1';
      expect(parseVerbosityFromEnv()).toBe(VerbosityLevel.DEBUG);
    });

    it('should handle UNTETHER_DEBUG=true', () => {
      process.env.UNTETHER_DEBUG = 'true';
      expect(parseVerbosityFromEnv()).toBe(VerbosityLevel.DEBUG);
    });

    it('should ignore UNTETHER_DEBUG when set to other values', () => {
      process.env.UNTETHER_DEBUG = '0';
      expect(parseVerbosityFromEnv()).toBeUndefined();

      process.env.UNTETHER_DEBUG = 'false';
      expect(parseVerbosityFromEnv()).toBeUndefined();

      process.env.UNTETHER_DEBUG = 'yes';
      expect(parseVerbosityFromEnv()).toBeUndefined();
    });

    it('should prioritize UNTETHER_LOG_LEVEL over UNTETHER_DEBUG', () => {
      process.env.UNTETHER_LOG_LEVEL = 'warn';
      process.env.UNTETHER_DEBUG = '1';
      expect(parseVerbosityFromEnv()).toBe(VerbosityLevel.WARN);
    });

    it('should return DEBUG when UNTETHER_LOG_LEVEL is invalid but UNTETHER_DEBUG is set', () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      process.env.UNTETHER_LOG_LEVEL = 'invalid';
      process.env.UNTETHER_DEBUG = '1';
      expect(parseVerbosityFromEnv()).toBe(VerbosityLevel.DEBUG);

      expect(consoleWarnSpy).toHaveBeenCalledTimes(2);
      expect(consoleWarnSpy).toHaveBeenCalledWith('Invalid UNTETHER_LOG_LEVEL: invalid');

      consoleWarnSpy.mockRestore();
    });
  });
});
