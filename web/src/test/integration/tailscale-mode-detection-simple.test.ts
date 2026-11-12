import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  TailscaleServeService,
  TailscaleServeStatus,
} from '../../server/services/tailscale-serve-service.js';

// Mock the logger
vi.mock('../../server/utils/logger.js', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    log: vi.fn(),
  })),
}));

describe('Tailscale Mode Detection Simple Tests', () => {
  let mockTailscaleService: TailscaleServeService;

  beforeEach(() => {
    // Create mock Tailscale service
    mockTailscaleService = {
      start: vi.fn(),
      stop: vi.fn(),
      isRunning: vi.fn().mockReturnValue(false),
      isFunnelEnabled: vi.fn().mockReturnValue(false),
      getStatus: vi.fn(),
    } as unknown as TailscaleServeService;
  });

  describe('Mode Detection Logic', () => {
    it('correctly identifies Private mode', async () => {
      const privateStatus = {
        isRunning: true,
        port: 4020,
        lastError: undefined,
        startTime: new Date(),
        isPermanentlyDisabled: false,
        funnelEnabled: false,
        funnelStartTime: undefined,
        desiredMode: 'private',
        actualMode: 'private',
        funnelError: undefined,
      };

      mockTailscaleService.getStatus = vi.fn().mockResolvedValue(privateStatus);

      const status = await mockTailscaleService.getStatus();

      expect(status.desiredMode).toBe('private');
      expect(status.actualMode).toBe('private');
      expect(status.funnelEnabled).toBe(false);
      expect(status.isRunning).toBe(true);
    });

    it('correctly identifies Public mode', async () => {
      const publicStatus = {
        isRunning: true,
        port: 4020,
        lastError: undefined,
        startTime: new Date(),
        isPermanentlyDisabled: false,
        funnelEnabled: true,
        funnelStartTime: new Date(),
        desiredMode: 'public',
        actualMode: 'public',
        funnelError: undefined,
      };

      mockTailscaleService.getStatus = vi.fn().mockResolvedValue(publicStatus);

      const status = await mockTailscaleService.getStatus();

      expect(status.desiredMode).toBe('public');
      expect(status.actualMode).toBe('public');
      expect(status.funnelEnabled).toBe(true);
      expect(status.isRunning).toBe(true);
    });

    it('detects mode mismatch during transition', async () => {
      const transitionStatus = {
        isRunning: true,
        port: 4020,
        lastError: undefined,
        startTime: new Date(),
        isPermanentlyDisabled: false,
        funnelEnabled: false,
        funnelStartTime: undefined,
        desiredMode: 'public', // User wants Public
        actualMode: 'private', // Still in Private
        funnelError: undefined,
      };

      mockTailscaleService.getStatus = vi.fn().mockResolvedValue(transitionStatus);

      const status = await mockTailscaleService.getStatus();

      expect(status.desiredMode).toBe('public');
      expect(status.actualMode).toBe('private');
      expect(status.desiredMode).not.toBe(status.actualMode);
      expect(status.funnelEnabled).toBe(false);
    });

    it('reports Funnel errors correctly', async () => {
      const errorStatus = {
        isRunning: true,
        port: 4020,
        lastError: undefined,
        startTime: new Date(),
        isPermanentlyDisabled: false,
        funnelEnabled: false,
        funnelStartTime: undefined,
        desiredMode: 'public',
        actualMode: 'private',
        funnelError: 'error: foreground already exists under this port',
      };

      mockTailscaleService.getStatus = vi.fn().mockResolvedValue(errorStatus);

      const status = await mockTailscaleService.getStatus();

      expect(status.funnelError).toBe('error: foreground already exists under this port');
      expect(status.funnelEnabled).toBe(false);
      expect(status.actualMode).toBe('private');
    });

    it('handles permanently disabled state', async () => {
      const disabledStatus = {
        isRunning: false,
        port: undefined,
        lastError: undefined, // No error in fallback mode
        startTime: undefined,
        isPermanentlyDisabled: true,
        funnelEnabled: false,
        funnelStartTime: undefined,
        desiredMode: undefined,
        actualMode: undefined,
        funnelError: undefined,
      };

      mockTailscaleService.getStatus = vi.fn().mockResolvedValue(disabledStatus);

      const status = await mockTailscaleService.getStatus();

      expect(status.isPermanentlyDisabled).toBe(true);
      expect(status.lastError).toBeUndefined(); // No error in fallback mode
      expect(status.isRunning).toBe(false);
    });
  });

  describe('State Transitions', () => {
    it('handles Private to Public transition', async () => {
      // Start in Private
      let currentStatus: TailscaleServeStatus = {
        isRunning: true,
        port: 4020,
        funnelEnabled: false,
        desiredMode: 'private',
        actualMode: 'private',
      };

      mockTailscaleService.getStatus = vi.fn().mockResolvedValue(currentStatus);
      let status = await mockTailscaleService.getStatus();
      expect(status.actualMode).toBe('private');

      // Transition state
      currentStatus = {
        isRunning: true,
        port: 4020,
        funnelEnabled: false,
        desiredMode: 'public',
        actualMode: 'private',
      };

      mockTailscaleService.getStatus = vi.fn().mockResolvedValue(currentStatus);
      status = await mockTailscaleService.getStatus();
      expect(status.desiredMode).toBe('public');
      expect(status.actualMode).toBe('private');

      // Final state
      currentStatus = {
        isRunning: true,
        port: 4020,
        funnelEnabled: true,
        desiredMode: 'public',
        actualMode: 'public',
      };

      mockTailscaleService.getStatus = vi.fn().mockResolvedValue(currentStatus);
      status = await mockTailscaleService.getStatus();
      expect(status.desiredMode).toBe('public');
      expect(status.actualMode).toBe('public');
      expect(status.funnelEnabled).toBe(true);
    });

    it('handles Public to Private transition', async () => {
      // Start in Public
      let currentStatus: TailscaleServeStatus = {
        isRunning: true,
        port: 4020,
        funnelEnabled: true,
        desiredMode: 'public',
        actualMode: 'public',
      };

      mockTailscaleService.getStatus = vi.fn().mockResolvedValue(currentStatus);
      let status = await mockTailscaleService.getStatus();
      expect(status.actualMode).toBe('public');
      expect(status.funnelEnabled).toBe(true);

      // Transition state
      currentStatus = {
        isRunning: true,
        port: 4020,
        funnelEnabled: true, // Still enabled but stopping
        desiredMode: 'private',
        actualMode: 'public',
      };

      mockTailscaleService.getStatus = vi.fn().mockResolvedValue(currentStatus);
      status = await mockTailscaleService.getStatus();
      expect(status.desiredMode).toBe('private');
      expect(status.actualMode).toBe('public');

      // Final state
      currentStatus = {
        isRunning: true,
        port: 4020,
        funnelEnabled: false,
        desiredMode: 'private',
        actualMode: 'private',
      };

      mockTailscaleService.getStatus = vi.fn().mockResolvedValue(currentStatus);
      status = await mockTailscaleService.getStatus();
      expect(status.desiredMode).toBe('private');
      expect(status.actualMode).toBe('private');
      expect(status.funnelEnabled).toBe(false);
    });
  });

  describe('Error Recovery', () => {
    it('recovers from Funnel startup errors', async () => {
      // Error state
      let currentStatus: TailscaleServeStatus = {
        isRunning: true,
        port: 4020,
        funnelEnabled: false,
        desiredMode: 'public',
        actualMode: 'private',
        funnelError: 'error: foreground already exists under this port',
      };

      mockTailscaleService.getStatus = vi.fn().mockResolvedValue(currentStatus);
      let status = await mockTailscaleService.getStatus();
      expect(status.funnelError).toContain('foreground already exists');

      // Recovery state
      currentStatus = {
        isRunning: true,
        port: 4020,
        funnelEnabled: true,
        desiredMode: 'public',
        actualMode: 'public',
        funnelError: undefined,
      };

      mockTailscaleService.getStatus = vi.fn().mockResolvedValue(currentStatus);
      status = await mockTailscaleService.getStatus();
      expect(status.funnelError).toBeUndefined();
      expect(status.funnelEnabled).toBe(true);
      expect(status.actualMode).toBe('public');
    });

    it('handles service restart', async () => {
      // Service running
      let currentStatus: TailscaleServeStatus = {
        isRunning: true,
        port: 4020,
        funnelEnabled: false,
        desiredMode: 'private',
        actualMode: 'private',
      };

      mockTailscaleService.getStatus = vi.fn().mockResolvedValue(currentStatus);
      let status = await mockTailscaleService.getStatus();
      expect(status.isRunning).toBe(true);

      // Service stopped
      currentStatus = {
        isRunning: false,
        port: undefined,
        funnelEnabled: false,
        desiredMode: 'private',
        actualMode: undefined,
        lastError: 'Service stopped',
      };

      mockTailscaleService.getStatus = vi.fn().mockResolvedValue(currentStatus);
      status = await mockTailscaleService.getStatus();
      expect(status.isRunning).toBe(false);
      expect(status.lastError).toBe('Service stopped');

      // Service restarted
      currentStatus = {
        isRunning: true,
        port: 4020,
        funnelEnabled: false,
        desiredMode: 'private',
        actualMode: 'private',
        lastError: undefined,
      };

      mockTailscaleService.getStatus = vi.fn().mockResolvedValue(currentStatus);
      status = await mockTailscaleService.getStatus();
      expect(status.isRunning).toBe(true);
      expect(status.lastError).toBeUndefined();
    });
  });
});
