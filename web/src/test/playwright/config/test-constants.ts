/**
 * Test configuration constants for Playwright tests
 */

export const CLEANUP_CONFIG = {
  DEFAULT_AGE_MINUTES: 30,
  PATTERN_PREFIX: /^(test-|pool-|batch-)/,
} as const;
