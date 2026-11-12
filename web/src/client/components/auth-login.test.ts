// @vitest-environment happy-dom
import { fixture, html } from '@open-wc/testing';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clickElement,
  getTextContent,
  setupFetchMock,
  submitForm,
  typeInInput,
  waitForAsync,
} from '@/test/utils/component-helpers';
import {
  createAuthConfig,
  createAuthResult,
  resetFactoryCounters,
} from '@/test/utils/test-factories';
import type { AuthClient } from '../services/auth-client';

// Mock AuthClient
vi.mock('../services/auth-client');

// Import component type
import type { AuthLogin } from './auth-login';

type AuthResponse = Awaited<ReturnType<AuthClient['authenticate']>>;
// createAuthResult's options type is looser than AuthResponse (authMethod: string, success optional).
const authResult = (options: Parameters<typeof createAuthResult>[0]) =>
  createAuthResult(options) as AuthResponse;

describe('AuthLogin', () => {
  let element: AuthLogin;
  let fetchMock: ReturnType<typeof setupFetchMock>;
  let mockAuthClient: AuthClient;

  beforeAll(async () => {
    // Import component to register custom element
    await import('./auth-login');
  });

  beforeEach(async () => {
    // Reset factory counters for test isolation
    resetFactoryCounters();

    // Setup fetch mock
    fetchMock = setupFetchMock();

    // Create mock auth client
    mockAuthClient = {
      getCurrentSystemUser: vi.fn(() => Promise.resolve('testuser')),
      getUserAvatar: vi.fn(() => Promise.resolve('/avatar.png')),
      authenticateWithPassword: vi.fn(),
      authenticate: vi.fn(), // The component uses authenticate, not authenticateWithSSHKey
      getAuthHeader: vi.fn(() => ({ Authorization: 'Bearer test-token' })),
    } as unknown as AuthClient;

    // Mock auth config with factory
    fetchMock.mockResponse(
      '/api/auth/config',
      createAuthConfig({
        enableSSHKeys: true,
        disallowUserPassword: false,
        noAuth: false,
      })
    );

    // Create component
    element = await fixture<AuthLogin>(html`
      <auth-login .authClient=${mockAuthClient}></auth-login>
    `);

    await element.updateComplete;
    // Wait a short time for async operations
    await waitForAsync(10);
  });

  afterEach(() => {
    element.remove();
    fetchMock.clear();
  });

  describe('initialization', () => {
    it('should create component and load user info', () => {
      expect(element).toBeDefined();
      expect(mockAuthClient.getCurrentSystemUser).toHaveBeenCalled();
      expect(mockAuthClient.getUserAvatar).toHaveBeenCalledWith('testuser');
    });

    it('should display current user', async () => {
      // Look for user in the rendered content
      const content = element.textContent;
      expect(content).toContain('testuser');
    });

    it('should show user avatar', async () => {
      const avatar = element.querySelector('img[alt*="Avatar"]');
      expect(avatar).toBeTruthy();
      expect(avatar?.getAttribute('src')).toBe('/avatar.png');
    });

    it('should load auth configuration', async () => {
      const calls = fetchMock.getCalls();
      const configCall = calls.find((call) => call[0] === '/api/auth/config');
      expect(configCall).toBeTruthy();
    });

    it('should auto-login when no auth required', async () => {
      // Create new component with no-auth config
      fetchMock.mockResponse(
        '/api/auth/config',
        createAuthConfig({
          enableSSHKeys: false,
          disallowUserPassword: false,
          noAuth: true,
        })
      );

      const authHandler = vi.fn();
      const noAuthElement = await fixture<AuthLogin>(html`
        <auth-login .authClient=${mockAuthClient} @auth-success=${authHandler}> </auth-login>
      `);

      // Wait for auto-login
      await waitForAsync(10);

      expect(authHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          detail: expect.objectContaining({
            success: true,
            authMethod: 'no-auth',
          }),
        })
      );

      noAuthElement.remove();
    });

    it('stays neutral and usable when not signed in (current-user → null)', async () => {
      vi.mocked(mockAuthClient.getCurrentSystemUser).mockResolvedValue(null);
      vi.mocked(mockAuthClient.getUserAvatar).mockClear();

      const neutralElement = await fixture<AuthLogin>(html`
        <auth-login .authClient=${mockAuthClient}></auth-login>
      `);
      await waitForAsync(10);

      // No system account name is shown and no avatar lookup is made, but sign-in still works.
      expect(mockAuthClient.getUserAvatar).not.toHaveBeenCalled();
      expect(neutralElement.querySelector('form')).toBeTruthy();
      expect(neutralElement.textContent).not.toContain('Failed to load user information');

      neutralElement.remove();
    });
  });

  describe('password authentication', () => {
    it('should show password form', () => {
      const passwordForm = element.querySelector('form');
      const passwordInput = element.querySelector(
        '[data-testid="password-input"]'
      ) as HTMLInputElement;
      expect(passwordForm).toBeTruthy();
      expect(passwordInput).toBeTruthy();
      expect(element.textContent).toContain('Mac password');
      expect(element.textContent).toContain('The password you use to unlock this Mac.');
      expect(element.textContent).toContain('does not store it');
      expect(passwordInput.autocomplete).toBe('current-password');
      expect(passwordInput.getAttribute('aria-describedby')).toBe('password-help');
    });

    it('should describe configured password authentication without requesting a system password', async () => {
      fetchMock.mockResponse(
        '/api/auth/config',
        createAuthConfig({
          enableSSHKeys: true,
          passwordAuthMode: 'configured',
        })
      );

      const configuredAuthElement = await fixture<AuthLogin>(html`
        <auth-login .authClient=${mockAuthClient}></auth-login>
      `);
      await waitForAsync(10);

      expect(configuredAuthElement.textContent).toContain('Untether password');
      expect(configuredAuthElement.textContent).toContain(
        'The password set for this Untether host.'
      );
      expect(configuredAuthElement.textContent).not.toContain('unlock this Mac');

      configuredAuthElement.remove();
    });

    it('should handle successful password login', async () => {
      vi.mocked(mockAuthClient.authenticateWithPassword).mockResolvedValue(
        authResult({
          success: true,
          userId: 'testuser',
          authMethod: 'password',
        })
      );

      const authHandler = vi.fn();
      element.addEventListener('auth-success', authHandler);

      // Type password
      await typeInInput(element, '[data-testid="password-input"]', 'testpass123');

      // Submit form
      const form = element.querySelector('form');
      if (form) {
        await submitForm(element, 'form');
      }

      // Wait for async operation
      await waitForAsync(10);

      // "Keep me signed in" defaults on only on phones; this desktop login gets 24 h.
      expect(mockAuthClient.authenticateWithPassword).toHaveBeenCalledWith(
        'testuser',
        'testpass123',
        false
      );
      expect(authHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          detail: expect.objectContaining({
            success: true,
            userId: 'testuser',
          }),
        })
      );
    });

    it('should handle password login failure', async () => {
      vi.mocked(mockAuthClient.authenticateWithPassword).mockResolvedValue(
        authResult({
          success: false,
          error: 'Invalid password',
        })
      );

      // Type password and submit
      await typeInInput(element, '[data-testid="password-input"]', 'wrongpass');
      await submitForm(element, 'form');

      // Wait for async operation
      await waitForAsync(10);

      // Should show error
      const errorText = getTextContent(element, '[data-testid="error-message"]');
      expect(errorText).toContain('Invalid password');
    });

    it('should disable form while loading', async () => {
      // Answered by the test itself, once it has seen the form disabled.
      let answer: (result: never) => void = () => {};
      vi.mocked(mockAuthClient.authenticateWithPassword).mockImplementation(
        () =>
          new Promise((resolve) => {
            answer = resolve as (result: never) => void;
          })
      );

      const submitButton = element.querySelector(
        '[data-testid="password-submit"]'
      ) as HTMLButtonElement;

      // Submit form
      await submitForm(element, 'form');

      // Button should be disabled during loading
      expect(submitButton?.disabled).toBe(true);

      // Its answer ends the loading.
      answer({ success: false, error: 'nope' } as never);
      await vi.waitFor(() =>
        expect(getTextContent(element, '[data-testid="error-message"]')).toContain('nope')
      );
    });

    it('should not show password form when disabled', async () => {
      // Create component with password disabled
      fetchMock.mockResponse(
        '/api/auth/config',
        createAuthConfig({
          enableSSHKeys: true,
          disallowUserPassword: true,
          noAuth: false,
        })
      );

      const disabledElement = await fixture<AuthLogin>(html`
        <auth-login .authClient=${mockAuthClient}></auth-login>
      `);

      await disabledElement.updateComplete;
      await waitForAsync(10);

      const passwordInput = disabledElement.querySelector('input[type="password"]');
      expect(passwordInput).toBeFalsy();

      disabledElement.remove();
    });
  });

  describe('SSH key authentication', () => {
    // With a password available too, SSH waits behind "Use SSH key" (design spec 5.3).
    beforeEach(async () => {
      element.querySelector<HTMLButtonElement>('[data-testid="use-ssh-key"]')?.click();
      await element.updateComplete;
    });

    it('should show SSH key button when enabled, behind "Use SSH key"', () => {
      const sshButton = element.querySelector('[data-testid="ssh-login"]');
      expect(sshButton).toBeTruthy();
      expect(element.querySelector('[data-testid="use-ssh-key"]')).toBeNull();
      expect(element.querySelector('[data-testid="manage-keys"]')?.textContent?.trim()).toBe(
        'Manage'
      );
    });

    it('should handle successful SSH key auth', async () => {
      vi.mocked(mockAuthClient.authenticate).mockResolvedValue(
        authResult({
          success: true,
          userId: 'testuser',
          authMethod: 'ssh-key',
        })
      );

      const authHandler = vi.fn();
      element.addEventListener('auth-success', authHandler);

      // Click SSH button using data-testid
      await clickElement(element, '[data-testid="ssh-login"]');

      // Wait for async operation
      await waitForAsync(10);

      expect(mockAuthClient.authenticate).toHaveBeenCalledWith('testuser');
      expect(authHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          detail: expect.objectContaining({
            success: true,
            authMethod: 'ssh-key',
          }),
        })
      );
    });

    it('should handle SSH key auth failure', async () => {
      vi.mocked(mockAuthClient.authenticate).mockResolvedValue(
        authResult({
          success: false,
          error: 'SSH key not authorized',
        })
      );

      // Click SSH button using data-testid
      await clickElement(element, '[data-testid="ssh-login"]');

      // Wait for async operation
      await waitForAsync(10);

      // Component shows the error from the auth result
      const errorDiv = element.querySelector('[data-testid="error-message"]');
      expect(errorDiv?.textContent).toBeTruthy();
      expect(errorDiv?.textContent).toContain('SSH key not authorized');
    });

    it('should not show SSH button when disabled', async () => {
      // Create component with SSH disabled
      fetchMock.mockResponse(
        '/api/auth/config',
        createAuthConfig({
          enableSSHKeys: false,
          disallowUserPassword: false,
          noAuth: false,
        })
      );

      const disabledElement = await fixture<AuthLogin>(html`
        <auth-login .authClient=${mockAuthClient}></auth-login>
      `);

      await disabledElement.updateComplete;
      await waitForAsync(10);

      const sshButton = disabledElement.querySelector('[data-testid="ssh-login"]');
      expect(sshButton).toBeFalsy();

      disabledElement.remove();
    });
  });

  describe('error handling', () => {
    it('should handle user info loading error', async () => {
      vi.mocked(mockAuthClient.getCurrentSystemUser).mockRejectedValue(new Error('Network error'));

      const errorElement = await fixture<AuthLogin>(html`
        <auth-login .authClient=${mockAuthClient}></auth-login>
      `);

      await errorElement.updateComplete;
      await waitForAsync(10);

      const errorText = errorElement.textContent;
      expect(errorText).toContain('Failed to load user information');

      errorElement.remove();
    });

    it('should handle auth config loading error', async () => {
      fetchMock.mockResponse('/api/auth/config', { error: 'Config error' }, { status: 500 });

      const configElement = await fixture<AuthLogin>(html`
        <auth-login .authClient=${mockAuthClient}></auth-login>
      `);

      await configElement.updateComplete;
      await waitForAsync(10);

      // Should still render with default config
      expect(configElement.querySelector('form')).toBeTruthy();

      configElement.remove();
    });
  });

  describe('UI elements', () => {
    it('should show title', () => {
      const title = element.querySelector('h2')?.textContent;
      expect(title).toContain('Untether');
    });

    it('should show login prompt', () => {
      // Look for authentication prompt text
      const content = element.textContent;
      expect(content).toBeTruthy();
      expect(content).toContain('Please authenticate to continue');
    });

    it('should have accessible password input', () => {
      const passwordInput = element.querySelector('[data-testid="password-input"]');
      expect(passwordInput).toBeTruthy();
      // Check for either placeholder or label
      const hasPlaceholder = passwordInput?.getAttribute('placeholder');
      const hasAriaLabel = passwordInput?.getAttribute('aria-label');
      expect(hasPlaceholder || hasAriaLabel).toBeTruthy();
    });
  });

  // Phone addendum (phone-spec §4.4, 2026-10-12).
  describe('phone details', () => {
    it("shows the user's initial, neutral, when there is no avatar", async () => {
      (mockAuthClient.getUserAvatar as ReturnType<typeof vi.fn>).mockResolvedValueOnce('');
      const noAvatar = await fixture<AuthLogin>(html`
        <auth-login .authClient=${mockAuthClient}></auth-login>
      `);
      await waitForAsync(10);
      await noAvatar.updateComplete;
      const initial = noAvatar.querySelector('[data-testid="login-initial"]');
      expect(initial?.textContent?.trim()).toBe('T');
      expect(initial?.classList.contains('al-initial')).toBe(true);
      expect(noAvatar.querySelector('.al-avatar svg')).toBeNull();
      noAvatar.remove();
    });

    it('submits with the keyboard Go key and pins the submit button (al-submit)', () => {
      const input = element.querySelector('[data-testid="password-input"]');
      expect(input?.getAttribute('enterkeyhint')).toBe('go');
      expect(
        element.querySelector('[data-testid="password-submit"]')?.classList.contains('al-submit')
      ).toBe(true);
    });
  });
});
