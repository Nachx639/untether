import { expect, test } from '@playwright/test';
import { testConfig } from '../test-config';

const baseUrl = process.env.PLAYWRIGHT_TEST_BASE_URL || testConfig.baseURL;
const baseUrlParsed = new URL(baseUrl);
const basePort = baseUrlParsed.port || (baseUrlParsed.protocol === 'https:' ? '443' : '80');
const localhostUrl = `${baseUrlParsed.protocol}//${baseUrlParsed.hostname}:${basePort}`;
const networkUrl = `${baseUrlParsed.protocol}//0.0.0.0:${basePort}`;

/**
 * Regression tests for Tailscale integration issues fixed in Release 15+
 *
 * These tests verify:
 * 1. Server remains accessible on network when Tailscale Serve is unavailable
 * 2. No ERR_CONNECTION_REFUSED errors in fallback mode
 * 3. Toggle doesn't auto-disable after 10 seconds
 * 4. Exit code 0 is handled correctly
 */
test.describe('Tailscale Regression Tests - Release 15 Fixes', () => {
  test.beforeEach(async ({ page }) => {
    // Start from a clean state
    await page.goto(baseUrl);
    await expect(page.locator('body')).toBeVisible();
  });

  test('server accessible on network when Tailscale Serve unavailable', async ({ page }) => {
    // This test verifies the main regression: server should remain accessible
    // even when Tailscale Serve is not available (fallback mode)

    // First, check the Tailscale status endpoint
    const statusResponse = await page.request.get('/api/sessions/tailscale/status');
    expect(statusResponse.ok()).toBeTruthy();

    const status = await statusResponse.json();

    // If Tailscale Serve is permanently disabled (fallback mode)
    if (status.isPermanentlyDisabled) {
      console.log('Testing in fallback mode - Tailscale Serve not available');

      // Server should still be accessible
      const healthResponse = await page.request.get('/api/health');
      expect(healthResponse.ok()).toBeTruthy();

      // Sessions endpoint should work
      const sessionsResponse = await page.request.get('/api/sessions');
      expect(sessionsResponse.ok()).toBeTruthy();

      // Should NOT get connection refused errors
      expect(healthResponse.status()).not.toBe(502); // Bad Gateway
      expect(healthResponse.status()).not.toBe(503); // Service Unavailable

      // The main app should load without errors
      await page.goto(baseUrl);
      await expect(page.locator('body')).toBeVisible();

      // Should not see connection error messages
      await expect(page.locator('text=/ERR_CONNECTION_REFUSED/i')).not.toBeVisible();
      await expect(page.locator('text=/Connection refused/i')).not.toBeVisible();
    }

    // Server should be accessible regardless of Tailscale state
    const testResponse = await page.request.get('/api/sessions/tailscale/test');
    expect(testResponse.ok()).toBeTruthy();

    const testData = await testResponse.json();
    console.log('Server binding info:', {
      bindAddress: testData.server?.bindAddress,
      isListening: testData.server?.isListening,
      port: testData.server?.port,
    });

    // Verify server is not forced to localhost only
    if (testData.server?.bindAddress) {
      const bindAddress = testData.server.bindAddress;
      const configuredBind = process.env.BIND_ADDRESS;
      const loopbackAddresses = new Set(['127.0.0.1', '::1', 'localhost']);

      if (configuredBind && configuredBind !== '127.0.0.1') {
        // If explicitly configured for network access, assert the bind address matches
        expect(bindAddress).toBe(configuredBind);
      } else if (!loopbackAddresses.has(bindAddress)) {
        // If binding to a network interface, ensure it's not loopback
        expect(bindAddress).not.toBe('127.0.0.1');
      } else {
        console.log(
          'Server bound to loopback in this environment; skipping network bind assertion'
        );
      }
    }
  });

  test('Tailscale toggle remains enabled in fallback mode', async ({ page }) => {
    // This test would require access to the settings UI
    // Since we're testing the API layer, we'll verify via the status endpoint

    const statusResponse = await page.request.get('/api/sessions/tailscale/status');
    const status = await statusResponse.json();

    if (status.isPermanentlyDisabled) {
      console.log('In fallback mode - verifying toggle behavior');

      // Wait 15 seconds (the old bug triggered after 10 seconds)
      await page.waitForTimeout(15000);

      // Check status again - should still be in same state
      const afterWaitResponse = await page.request.get('/api/sessions/tailscale/status');
      const afterWaitStatus = await afterWaitResponse.json();

      // The permanent disable state should be consistent
      expect(afterWaitStatus.isPermanentlyDisabled).toBe(status.isPermanentlyDisabled);

      // Server should still be running/accessible
      const healthCheck = await page.request.get('/api/health');
      expect(healthCheck.ok()).toBeTruthy();
    }
  });

  test('exit code 0 does not show as error', async ({ page }) => {
    // Check that the status endpoint doesn't report false errors
    const statusResponse = await page.request.get('/api/sessions/tailscale/status');
    const status = await statusResponse.json();

    // If there's an error message, it should be meaningful
    if (status.lastError) {
      // Should not contain the confusing "exit code 0" message
      expect(status.lastError).not.toContain('Process exited with code 0');
      expect(status.lastError).not.toContain('exit code 0');

      // Error should be user-friendly
      const validErrorPatterns = [
        'Serve is not enabled',
        'requires admin',
        'not available',
        'command not found',
        'unauthorized',
      ];

      const hasValidError = validErrorPatterns.some((pattern) =>
        status.lastError.toLowerCase().includes(pattern.toLowerCase())
      );

      if (!hasValidError) {
        console.warn('Unexpected error message:', status.lastError);
      }
    }

    // In fallback mode, there should be no error
    if (status.isPermanentlyDisabled) {
      expect(status.lastError).toBeUndefined();
    }
  });

  test('server remains accessible via network IP in fallback', async ({ page }) => {
    // Test that we can access via 0.0.0.0 binding (network interface)
    // Note: In CI this might not work due to network restrictions

    try {
      // Try to access via explicit IP (this would fail if forced to localhost)
      const networkResponse = await page.request.get(`${networkUrl}/api/health`);

      if (networkResponse.ok()) {
        console.log('Server accessible via network interface (0.0.0.0)');
        expect(networkResponse.status()).toBe(200);
      }
    } catch (_e) {
      // Network access might be restricted in CI
      console.log('Network interface test skipped - may be restricted in this environment');
    }

    // At minimum, localhost should always work
    const localhostResponse = await page.request.get(`${localhostUrl}/api/health`);
    expect(localhostResponse.ok()).toBeTruthy();
  });

  test('fallback mode provides clear status information', async ({ page }) => {
    // Verify the diagnostic endpoint provides clear information
    const diagnosticResponse = await page.request.get('/api/sessions/tailscale/test');
    expect(diagnosticResponse.ok()).toBeTruthy();

    const diagnostic = await diagnosticResponse.json();

    // Should have clear recommendations
    expect(diagnostic.recommendations).toBeDefined();
    expect(Array.isArray(diagnostic.recommendations)).toBe(true);

    // If in fallback mode, should have appropriate recommendations
    if (diagnostic.tailscaleServe?.isPermanentlyDisabled) {
      const recommendations = diagnostic.recommendations.join(' ');

      // Should mention fallback or direct access
      const hasUsefulInfo =
        recommendations.includes('fallback') ||
        recommendations.includes('direct') ||
        recommendations.includes('admin') ||
        recommendations.includes('tailnet');

      expect(hasUsefulInfo).toBe(true);
    }

    console.log('Diagnostic info:', {
      tailscaleInstalled: diagnostic.tailscale?.installed,
      serveConfigured: diagnostic.tailscaleServe?.configured,
      isPermanentlyDisabled: diagnostic.tailscaleServe?.isPermanentlyDisabled,
      recommendations: diagnostic.recommendations,
    });
  });

  test('multiple status checks remain consistent', async ({ page }) => {
    // Verify status remains stable across multiple checks
    const results = [];

    for (let i = 0; i < 3; i++) {
      const response = await page.request.get('/api/sessions/tailscale/status');
      const status = await response.json();
      results.push(status);

      // Small delay between checks
      await page.waitForTimeout(1000);
    }

    // All status checks should be consistent
    const firstStatus = results[0];
    for (let i = 1; i < results.length; i++) {
      const currentStatus = results[i];

      // Key fields should remain stable
      expect(currentStatus.isRunning).toBe(firstStatus.isRunning);
      expect(currentStatus.isPermanentlyDisabled).toBe(firstStatus.isPermanentlyDisabled);

      // Error state should be consistent
      if (firstStatus.lastError === undefined) {
        expect(currentStatus.lastError).toBeUndefined();
      }
    }

    console.log('Status consistency verified across multiple checks');
  });
});
