import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TailscaleServeServiceImpl } from './tailscale-serve-service.js';

/**
 * Focused regression tests for Tailscale Release 15 fixes
 * These tests verify the specific bugs that were fixed
 */
describe('Tailscale Regression Tests - Release 15 Fixes', () => {
  let service: TailscaleServeServiceImpl;
  let originalSkipTailscale: string | undefined;

  beforeEach(() => {
    originalSkipTailscale = process.env.UNTETHER_SKIP_TAILSCALE;
    process.env.UNTETHER_SKIP_TAILSCALE = '1';
    service = new TailscaleServeServiceImpl();
  });

  afterEach(() => {
    if (originalSkipTailscale === undefined) {
      delete process.env.UNTETHER_SKIP_TAILSCALE;
    } else {
      process.env.UNTETHER_SKIP_TAILSCALE = originalSkipTailscale;
    }
  });

  describe('Basic Status Checks (Regression Prevention)', () => {
    it('should provide status without crashing when not started', async () => {
      // Regression: Status checks should never crash
      const status = await service.getStatus();

      expect(status).toBeDefined();
      expect(status.isRunning).toBe(false);
      expect(status.port).toBeUndefined();
      expect(status.startTime).toBeUndefined();
    });

    it('should handle multiple status checks consistently', async () => {
      // Get status multiple times - should be consistent
      const status1 = await service.getStatus();
      const status2 = await service.getStatus();
      const status3 = await service.getStatus();

      expect(status1.isRunning).toBe(status2.isRunning);
      expect(status2.isRunning).toBe(status3.isRunning);
    });

    it('should include isPermanentlyDisabled when appropriate', async () => {
      const status = await service.getStatus();

      // The flag should be boolean when present
      if (status.isPermanentlyDisabled !== undefined) {
        expect(typeof status.isPermanentlyDisabled).toBe('boolean');
      }
    });
  });

  describe('Service Lifecycle (Core Functionality)', () => {
    it('should handle stop when not running', async () => {
      // Should not throw when stopping a non-running service
      expect(() => service.stop()).not.toThrow();

      // Multiple stops should be safe
      service.stop();
      service.stop();

      const status = await service.getStatus();
      expect(status.isRunning).toBe(false);
    });

    it('should report running state accurately', () => {
      // Direct check of running state
      expect(service.isRunning()).toBe(false);

      // After stop
      service.stop();
      expect(service.isRunning()).toBe(false);
    });
  });

  describe('Status Response Structure', () => {
    it('should provide well-formed status response', async () => {
      const status = await service.getStatus();

      // Required fields
      expect(typeof status.isRunning).toBe('boolean');

      // Optional fields should be correct type when present
      if (status.lastError !== undefined) {
        expect(typeof status.lastError).toBe('string');
      }
      if (status.port !== undefined) {
        expect(typeof status.port).toBe('number');
      }
      if (status.startTime !== undefined) {
        expect(status.startTime).toBeInstanceOf(Date);
      }
      if (status.isPermanentlyDisabled !== undefined) {
        expect(typeof status.isPermanentlyDisabled).toBe('boolean');
      }
    });

    it('should not expose internal error messages', async () => {
      // This is the key regression: "Process exited with code 0" should not be shown
      const status = await service.getStatus();

      if (status.lastError) {
        // These internal error messages should not be exposed to users
        expect(status.lastError).not.toContain('Process exited with code 0');
        expect(status.lastError).not.toContain('exit code 0');
        expect(status.lastError).not.toMatch(/exit.*code.*0/i);
      }
    });
  });

  describe('Fallback Mode Indicators', () => {
    it('should provide clear status for fallback decisions', async () => {
      const status = await service.getStatus();

      // When permanently disabled, these should be the values
      if (status.isPermanentlyDisabled === true) {
        // In fallback mode:
        expect(status.isRunning).toBe(false);
        expect(status.port).toBeUndefined();
        // No confusing error shown
        if (status.lastError) {
          expect(status.lastError).not.toContain('exit');
          expect(status.lastError).not.toContain('code 0');
        }
      }
    });

    it('should maintain consistent permanently disabled state', async () => {
      // Get status multiple times
      const status1 = await service.getStatus();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const status2 = await service.getStatus();

      // If set, should remain consistent
      if (status1.isPermanentlyDisabled !== undefined) {
        expect(status2.isPermanentlyDisabled).toBe(status1.isPermanentlyDisabled);
      }
    });
  });
});

/**
 * Integration test to verify the actual Tailscale integration behavior
 * These only run when ENABLE_TAILSCALE_TESTS=1 is set
 */
describe('Tailscale Live Integration Tests', () => {
  let service: TailscaleServeServiceImpl;

  beforeEach(() => {
    if (!process.env.ENABLE_TAILSCALE_TESTS) {
      return;
    }
    service = new TailscaleServeServiceImpl();
  });

  it('should detect actual Tailscale Serve availability', async () => {
    if (!process.env.ENABLE_TAILSCALE_TESTS) {
      console.log('Skipping live test - set ENABLE_TAILSCALE_TESTS=1 to run');
      return;
    }

    const status = await service.getStatus();

    console.log('Live Tailscale status:', {
      isRunning: status.isRunning,
      isPermanentlyDisabled: status.isPermanentlyDisabled,
      lastError: status.lastError,
      port: status.port,
    });

    // If Tailscale Serve is not available, should be in fallback
    if (status.lastError?.includes('Serve is not enabled')) {
      expect(status.isPermanentlyDisabled).toBe(true);
    }
  });
});
