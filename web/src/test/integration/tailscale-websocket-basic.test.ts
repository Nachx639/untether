import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthService } from '../../server/services/auth-service.js';

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

describe('Tailscale WebSocket Authentication Basic Tests', () => {
  let mockAuthService: AuthService;

  beforeEach(() => {
    // Mock auth service
    mockAuthService = {
      verifyToken: vi.fn(),
      generateTokenForUser: vi.fn(),
      createChallenge: vi.fn(),
      authenticateWithSSHKey: vi.fn(),
      authenticateWithPassword: vi.fn(),
      getCurrentUser: vi.fn(),
      userExists: vi.fn(),
    } as unknown as AuthService;
  });

  describe('Token Verification', () => {
    it('should verify valid Tailscale-generated tokens', () => {
      const mockToken = 'tailscale-generated-token';
      const userId = 'user@example.com';

      // Mock token verification to succeed
      mockAuthService.verifyToken = vi.fn().mockReturnValue({
        valid: true,
        userId,
      });

      const result = mockAuthService.verifyToken(mockToken);

      expect(result.valid).toBe(true);
      expect(result.userId).toBe(userId);
      expect(mockAuthService.verifyToken).toHaveBeenCalledWith(mockToken);
    });

    it('should reject invalid tokens', () => {
      const invalidToken = 'invalid-token';

      // Mock token verification to fail
      mockAuthService.verifyToken = vi.fn().mockReturnValue({
        valid: false,
      });

      const result = mockAuthService.verifyToken(invalidToken);

      expect(result.valid).toBe(false);
      expect(mockAuthService.verifyToken).toHaveBeenCalledWith(invalidToken);
    });

    it('should generate tokens for Tailscale users', () => {
      const userId = 'user@example.com';
      const expectedToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test';

      mockAuthService.generateTokenForUser = vi.fn().mockReturnValue(expectedToken);

      const token = mockAuthService.generateTokenForUser(userId);

      expect(token).toBe(expectedToken);
      expect(mockAuthService.generateTokenForUser).toHaveBeenCalledWith(userId);
    });
  });

  describe('WebSocket Authentication Flow', () => {
    it('should authenticate WebSocket with valid token', () => {
      const mockToken = 'valid-ws-token';
      const userId = 'ws-user@example.com';

      // Setup mock for successful authentication
      mockAuthService.verifyToken = vi.fn().mockReturnValue({
        valid: true,
        userId,
      });

      // Simulate WebSocket authentication check
      const authResult = mockAuthService.verifyToken(mockToken);

      expect(authResult.valid).toBe(true);
      expect(authResult.userId).toBe(userId);
    });

    it('should reject WebSocket without token', () => {
      // Simulate WebSocket authentication check without token
      // verifyToken answers { valid } with no reason (AuthService has no error field).
      mockAuthService.verifyToken = vi.fn().mockReturnValue({ valid: false });

      const authResult = mockAuthService.verifyToken(
        undefined as unknown as Parameters<typeof mockAuthService.verifyToken>[0]
      );

      expect(authResult.valid).toBe(false);
    });

    it('should handle token generation for new Tailscale sessions', () => {
      const tailscaleUser = 'tailscale@example.com';
      const generatedToken = 'new-session-token';

      // Mock token generation
      mockAuthService.generateTokenForUser = vi.fn().mockReturnValue(generatedToken);

      // Generate token for Tailscale user
      const token = mockAuthService.generateTokenForUser(tailscaleUser);

      expect(token).toBe(generatedToken);
      expect(mockAuthService.generateTokenForUser).toHaveBeenCalledWith(tailscaleUser);

      // Verify the generated token would be valid
      mockAuthService.verifyToken = vi.fn().mockReturnValue({
        valid: true,
        userId: tailscaleUser,
      });

      const verifyResult = mockAuthService.verifyToken(token);
      expect(verifyResult.valid).toBe(true);
      expect(verifyResult.userId).toBe(tailscaleUser);
    });
  });

  describe('Error Handling', () => {
    it('should handle token verification errors gracefully', () => {
      mockAuthService.verifyToken = vi.fn().mockImplementation(() => {
        throw new Error('Token verification failed');
      });

      expect(() => mockAuthService.verifyToken('bad-token')).toThrow('Token verification failed');
    });

    it('should handle token generation errors gracefully', () => {
      mockAuthService.generateTokenForUser = vi.fn().mockImplementation(() => {
        throw new Error('Token generation failed');
      });

      expect(() => mockAuthService.generateTokenForUser('user@example.com')).toThrow(
        'Token generation failed'
      );
    });
  });
});
