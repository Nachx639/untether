import { parseVerbosityLevel, VerbosityLevel } from './logger.js';

/**
 * Parse verbosity level from environment variables
 * Checks UNTETHER_LOG_LEVEL first, then falls back to UNTETHER_DEBUG for backward compatibility
 * @returns The parsed verbosity level or undefined if not set
 */
export function parseVerbosityFromEnv(): VerbosityLevel | undefined {
  // Check UNTETHER_LOG_LEVEL first
  if (process.env.UNTETHER_LOG_LEVEL) {
    const parsed = parseVerbosityLevel(process.env.UNTETHER_LOG_LEVEL);
    if (parsed !== undefined) {
      return parsed;
    }
    // Warn about invalid value
    console.warn(`Invalid UNTETHER_LOG_LEVEL: ${process.env.UNTETHER_LOG_LEVEL}`);
    console.warn('Valid levels: silent, error, warn, info, verbose, debug');
  }

  // Check legacy UNTETHER_DEBUG for backward compatibility
  if (process.env.UNTETHER_DEBUG === '1' || process.env.UNTETHER_DEBUG === 'true') {
    return VerbosityLevel.DEBUG;
  }

  return undefined;
}
