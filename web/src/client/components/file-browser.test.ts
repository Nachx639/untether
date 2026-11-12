// @vitest-environment happy-dom
import { fixture, html } from '@open-wc/testing';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  restoreLocalStorage,
  setupFetchMock,
  setupLocalStorageMock,
  waitForAsync,
} from '@/test/utils/component-helpers';
import type { Session } from '../../shared/types.js';
import type { AuthClient } from '../services/auth-client';

// Mock AuthClient
vi.mock('../services/auth-client');

// Import component type
import type { FileBrowser } from './file-browser';

// Private state and methods the tests drive directly.
type FileBrowserInternals = {
  currentPath: string;
  currentFullPath: string;
  loadDirectory(dirPath: string): Promise<void>;
  handleSelect(): void;
};
const internals = (el: FileBrowser) => el as unknown as FileBrowserInternals;

describe('FileBrowser', () => {
  let element: FileBrowser;
  let fetchMock: ReturnType<typeof setupFetchMock>;
  let mockAuthClient: AuthClient;
  let _localStorageMock: ReturnType<typeof setupLocalStorageMock>;

  beforeAll(async () => {
    // Import components to register custom elements
    await import('./file-browser');
    await import('./modal-wrapper');
    await import('./monaco-editor');
  });

  beforeEach(async () => {
    // Setup localStorage mock with isolation
    _localStorageMock = setupLocalStorageMock();

    // Setup fetch mock
    fetchMock = setupFetchMock();

    // Create mock auth client
    mockAuthClient = {
      getAuthHeader: vi.fn(() => ({ Authorization: 'Bearer test-token' })),
    } as unknown as AuthClient;

    // Mock authClient.instance
    vi.mocked(await import('../services/auth-client')).authClient = mockAuthClient;

    // Create component
    element = await fixture<FileBrowser>(html`
      <file-browser
        .visible=${false}
        .mode=${'browse'}
        .session=${{ id: 'test-session', workingDir: '/home/user' } as Session}
      ></file-browser>
    `);
  });

  afterEach(() => {
    vi.clearAllMocks();
    restoreLocalStorage();
    fetchMock.clear();
  });

  describe('handleSelect method - absolute path fix', () => {
    it('should use currentFullPath when available instead of currentPath', async () => {
      // Set up the component in select mode but not visible yet
      element.mode = 'select';

      // Manually set the internal state to simulate a directory with relative path
      // This simulates the state after navigating to a directory that returned relative paths
      internals(element).currentPath = '../..';
      internals(element).currentFullPath = '/Users/alice/Desktop';

      // Now make it visible (this would normally trigger a load, but we'll skip that)
      element.visible = true;
      await element.updateComplete;

      // Listen for directory-selected event
      const eventPromise = new Promise<CustomEvent>((resolve) => {
        element.addEventListener('directory-selected', resolve as EventListener, { once: true });
      });

      // Call handleSelect directly (simulating a click on select button)
      internals(element).handleSelect();

      // Wait for event
      const event = await eventPromise;

      // Verify the event contains the absolute path (currentFullPath), not the relative path
      expect(event.detail).toBe('/Users/alice/Desktop');
      expect(event.detail).not.toBe('../..');
    });

    it('opened from the session list, starts in the repository base path, not the server’s folder', async () => {
      fetchMock.mockResponse('/api/config', { repositoryBasePath: '~/Projects' });
      const { serverConfigService } = await import('../services/server-config-service.js');
      (serverConfigService as unknown as { clearCache(): void }).clearCache();
      element.session = null;
      element.visible = true;
      await element.updateComplete;
      await waitForAsync();
      const browse = fetchMock
        .getCalls()
        .map((call) => String(call[0]))
        .filter((url) => url.startsWith('/api/fs/browse'));
      expect(new URL(browse[0], 'http://ut.test').searchParams.get('path')).toBe('~/Projects');
    });

    it('should fall back to currentPath when currentFullPath is not available', async () => {
      // Set up the component in select mode
      element.mode = 'select';

      // Mock the initial directory load that will happen when visible is set
      fetchMock.mockResponse(
        `/api/fs/browse?path=${encodeURIComponent('/home/user')}&showHidden=false&gitFilter=all`,
        {
          path: '/home/user',
          fullPath: '/home/user',
          gitStatus: null,
          files: [],
        }
      );

      element.visible = true;
      await element.updateComplete;
      await waitForAsync();

      // A missing or blocked folder keeps only currentPath (currentFullPath is '')
      internals(element).currentPath = '/home/user/projects';
      internals(element).currentFullPath = '';

      // Listen for directory-selected event
      const eventPromise = new Promise<CustomEvent>((resolve) => {
        element.addEventListener('directory-selected', resolve as EventListener, { once: true });
      });

      // Call handleSelect directly
      internals(element).handleSelect();

      // Wait for event
      const event = await eventPromise;

      // Should use currentPath as fallback
      expect(event.detail).toBe('/home/user/projects');
    });

    it('should not dispatch event when currentPath is empty', async () => {
      element.mode = 'select';

      // Mock the initial directory load
      fetchMock.mockResponse(
        `/api/fs/browse?path=${encodeURIComponent('/home/user')}&showHidden=false&gitFilter=all`,
        {
          path: '/home/user',
          fullPath: '/home/user',
          gitStatus: null,
          files: [],
        }
      );

      element.visible = true;
      await element.updateComplete;
      await waitForAsync();

      // Now clear the paths to test empty path behavior
      internals(element).currentPath = '';
      internals(element).currentFullPath = '';

      // Listen for directory-selected event
      let eventFired = false;
      element.addEventListener('directory-selected', () => {
        eventFired = true;
      });

      // Call handleSelect directly
      internals(element).handleSelect();

      // Wait a bit to ensure no event is fired
      await waitForAsync(50);

      expect(eventFired).toBe(false);
    });

    it('should not dispatch event when not in select mode', async () => {
      // Setup component in browse mode
      element.mode = 'browse';
      element.visible = true;
      internals(element).currentPath = '/some/path';
      internals(element).currentFullPath = '/Users/test/some/path';
      await element.updateComplete;

      // Listen for directory-selected event
      let eventFired = false;
      element.addEventListener('directory-selected', () => {
        eventFired = true;
      });

      // Call handleSelect directly
      internals(element).handleSelect();

      await waitForAsync(50);

      expect(eventFired).toBe(false);
    });
  });

  describe('integration with directory navigation', () => {
    it('should correctly pass absolute path when selecting after navigation', async () => {
      element.mode = 'select';

      // Mock initial load response when component becomes visible
      // File browser uses /api/fs/browse when not in noAuthMode
      fetchMock.mockResponse(
        `/api/fs/browse?path=${encodeURIComponent('/home/user')}&showHidden=false&gitFilter=all`,
        {
          path: '/home/user',
          fullPath: '/home/user',
          gitStatus: null,
          files: [
            {
              name: 'Desktop',
              path: 'Desktop',
              type: 'directory',
              size: 0,
              modified: '2025-01-15T10:00:00Z',
            },
          ],
        }
      );

      element.visible = true;
      await element.updateComplete;
      await waitForAsync();

      // Mock response for navigating to Desktop with relative paths
      // File browser uses /api/fs/browse when not in noAuthMode
      fetchMock.mockResponse(
        `/api/fs/browse?path=${encodeURIComponent('Desktop')}&showHidden=false&gitFilter=all`,
        {
          path: '..',
          fullPath: '/Users/alice/Desktop',
          gitStatus: null,
          files: [
            {
              name: '..',
              path: '../..',
              type: 'directory',
              size: 0,
              modified: '2025-01-15T10:00:00Z',
            },
          ],
        }
      );

      // Simulate navigation to Desktop
      await internals(element).loadDirectory('Desktop');
      await waitForAsync();

      // After loading, currentPath will be set to fullPath (due to line 179 in file-browser.ts)
      // and currentFullPath will also be set to fullPath
      expect(internals(element).currentPath).toBe('/Users/alice/Desktop');
      expect(internals(element).currentFullPath).toBe('/Users/alice/Desktop');

      // Listen for directory-selected event
      const eventPromise = new Promise<CustomEvent>((resolve) => {
        element.addEventListener('directory-selected', resolve as EventListener, { once: true });
      });

      // Select this directory
      internals(element).handleSelect();
      const event = await eventPromise;

      // Should get absolute path
      expect(event.detail).toBe('/Users/alice/Desktop');
    });

    it('should handle multiple parent directory navigations correctly', async () => {
      element.mode = 'select';

      // Start at a deep directory
      internals(element).currentPath = '.';
      internals(element).currentFullPath = '/Users/alice/Projects/untether/web';
      element.visible = true;
      await element.updateComplete;

      // Simulate state after navigating up multiple levels
      internals(element).currentPath = '../../..';
      internals(element).currentFullPath = '/Users/alice';

      // Listen for event
      const eventPromise = new Promise<CustomEvent>((resolve) => {
        element.addEventListener('directory-selected', resolve as EventListener, { once: true });
      });

      // Select directory
      internals(element).handleSelect();
      const event = await eventPromise;

      // Should return absolute path, not relative
      expect(event.detail).toBe('/Users/alice');
      expect(event.detail).not.toContain('..');
    });
  });

  describe('image preview', () => {
    it('loads the image with the auth header and shows a blob URL', async () => {
      const calls: Array<{ url: string; headers?: HeadersInit }> = [];
      global.fetch = vi.fn(async (url: string, options?: RequestInit) => {
        calls.push({ url, headers: options?.headers });
        if (url.startsWith('/api/fs/preview')) {
          return {
            ok: true,
            json: async () => ({ type: 'image', url: '/api/fs/raw?path=a.png', size: 3 }),
          };
        }
        if (url.startsWith('/api/fs/browse')) {
          return { ok: true, json: async () => ({ path: '/', fullPath: '/', files: [] }) };
        }
        return { ok: true, blob: async () => new Blob(['png']) };
      }) as unknown as typeof global.fetch;
      const createObjectURL = vi.fn(() => 'blob:preview-1');
      URL.createObjectURL = createObjectURL;
      URL.revokeObjectURL = vi.fn();

      element.visible = true;
      await element.updateComplete;
      await (element as unknown as { loadPreview(f: unknown): Promise<void> }).loadPreview({
        name: 'a.png',
        path: 'a.png',
        type: 'file',
        size: 3,
        modified: '',
      });
      await element.updateComplete;

      const raw = calls.find((c) => c.url === '/api/fs/raw?path=a.png');
      expect(raw?.headers).toEqual({ Authorization: 'Bearer test-token' });
      expect(element.querySelector('img')?.getAttribute('src')).toBe('blob:preview-1');
    });

    it('a slow image for an earlier tap does not replace the newer one', async () => {
      let releaseA: () => void = () => {};
      global.fetch = vi.fn(async (url: string) => {
        if (url.startsWith('/api/fs/preview')) {
          const name = new URLSearchParams(url.split('?')[1]).get('path');
          return {
            ok: true,
            json: async () => ({ type: 'image', url: `/api/fs/raw?path=${name}`, size: 3 }),
          };
        }
        if (url.startsWith('/api/fs/browse')) {
          return { ok: true, json: async () => ({ path: '/', fullPath: '/', files: [] }) };
        }
        if (url.endsWith('a.png')) await new Promise<void>((resolve) => (releaseA = resolve));
        return { ok: true, blob: async () => new Blob([url]) };
      }) as unknown as typeof global.fetch;
      let n = 0;
      URL.createObjectURL = vi.fn(() => `blob:${++n}`);
      const revoke = vi.fn();
      URL.revokeObjectURL = revoke;
      element.visible = true;
      await element.updateComplete;
      const load = (name: string) =>
        (element as unknown as { loadPreview(f: unknown): Promise<void> }).loadPreview({
          name,
          path: name,
          type: 'file',
          size: 3,
          modified: '',
        });

      const a = load('a.png');
      await load('b.png'); // B finishes first and is shown
      releaseA();
      await a;
      await element.updateComplete;

      expect(element.querySelector('img')?.getAttribute('src')).toBe('blob:1');
      expect(revoke).toHaveBeenCalledWith('blob:2'); // A's late image is dropped, not leaked
    });
  });

  describe('copy path', () => {
    it('copies the absolute path, not the server-cwd-relative one, and says so', async () => {
      const writeText = vi.fn(async () => {});
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      const internals = element as unknown as {
        currentFullPath: string;
        selectedFile: unknown;
      };
      element.visible = true;
      await element.updateComplete;
      internals.currentFullPath = '/Users/me/project';
      internals.selectedFile = {
        name: 'a.ts',
        path: '../../Users/me/project/a.ts',
        type: 'file',
        size: 1,
        modified: '',
      };
      await element.updateComplete;

      const button = [...element.querySelectorAll('button')].find(
        (b) => b.textContent?.trim() === 'Copy Path'
      );
      button?.click();
      await waitForAsync();
      await element.updateComplete;

      expect(writeText).toHaveBeenCalledWith('/Users/me/project/a.ts');
      expect(button?.textContent?.trim()).toBe('Copied');
    });
  });

  describe('filter', () => {
    it('narrows the listing by name and clears when entering another folder', async () => {
      const file = (name: string, type: 'file' | 'directory' = 'file') => ({
        name,
        path: name,
        type,
        size: 1,
        modified: '',
      });
      fetchMock.mockResponse('/api/fs/browse?path=%2Fhome%2Fuser&showHidden=false&gitFilter=all', {
        path: '/home/user',
        fullPath: '/home/user',
        gitStatus: null,
        files: [file('src', 'directory'), file('README.md'), file('package.json')],
      });
      fetchMock.mockResponse('/api/fs/browse?path=src&showHidden=false&gitFilter=all', {
        path: '/home/user/src',
        fullPath: '/home/user/src',
        gitStatus: null,
        files: [file('index.ts')],
      });
      element.visible = true;
      await element.updateComplete;
      await waitForAsync();
      await element.updateComplete;

      const input = element.querySelector('input[type="search"]') as HTMLInputElement;
      input.value = 'READ';
      input.dispatchEvent(new Event('input'));
      await element.updateComplete;
      const names = () =>
        [...element.querySelectorAll('span.truncate')].map((n) => n.textContent?.trim());
      expect(names()).toEqual(['README.md']);

      input.value = 'sr';
      input.dispatchEvent(new Event('input'));
      await element.updateComplete;
      (element.querySelector('span.truncate') as HTMLElement).click();
      await waitForAsync();
      await element.updateComplete;
      expect(names()).toEqual(['index.ts']);
      expect((element.querySelector('input[type="search"]') as HTMLInputElement).value).toBe('');
    });
  });

  describe('search (user report: an accented name was not found)', () => {
    const file = (name: string, type: 'file' | 'directory' = 'file') => ({
      name,
      path: name,
      type,
      size: 1,
      modified: '2026-03-01T10:00:00Z',
    });
    const NAME = 'Hoja de inscripción - ejemplo.pdf';
    const typeQuery = async (value: string) => {
      const input = element.querySelector('#file-browser-search') as HTMLInputElement;
      input.value = value;
      input.dispatchEvent(new Event('input'));
      await element.updateComplete;
    };
    const searchCalls = () =>
      fetchMock
        .getCalls()
        .map((call) => String(call[0]))
        .filter((url) => url.startsWith('/api/fs/search'));
    const settle = async () => {
      await new Promise((resolve) => setTimeout(resolve, 320));
      await waitForAsync();
      await element.updateComplete;
    };

    beforeEach(async () => {
      fetchMock.mockResponse('/api/fs/browse?path=%2Fhome%2Fuser&showHidden=false&gitFilter=all', {
        path: '/home/user',
        fullPath: '/home/user',
        gitStatus: null,
        files: [file(NAME), file('otro.txt')],
      });
      element.visible = true;
      await element.updateComplete;
      await waitForAsync();
      await element.updateComplete;
    });

    it('matches the folder without accents or case, words in any order', async () => {
      const names = () =>
        [...element.querySelectorAll('.fb-row span.truncate')].map((n) => n.textContent?.trim());
      await typeQuery('INSCRIPCION hoja');
      expect(names()).toEqual([NAME]);
      await typeQuery('hoja otro');
      expect(names()).toEqual([]);
    });

    it('lists matches across the Mac below, debounced, and opens one in its folder', async () => {
      const hit = {
        name: NAME,
        path: `/home/user/Downloads/${NAME}`,
        type: 'file',
        size: 10,
        modified: '2026-03-01T10:00:00Z',
        area: 'home',
        parent: 'Downloads',
      };
      const inIcloud = {
        ...hit,
        path: `/home/user/Library/Mobile Documents/com~apple~CloudDocs/Trámites/${NAME}`,
        area: 'icloud',
        parent: 'Trámites',
      };
      // Already listed in this folder: not repeated under "On this Mac".
      const here = { ...hit, path: `/home/user/${NAME}`, parent: '' };
      fetchMock.mockResponse(`/api/fs/search?q=${encodeURIComponent('hoja inscripcion')}`, {
        results: [hit, inIcloud, here],
        truncated: false,
      });
      fetchMock.mockResponse(
        '/api/fs/browse?path=%2Fhome%2Fuser%2FDownloads&showHidden=false&gitFilter=all',
        {
          path: '/home/user/Downloads',
          fullPath: '/home/user/Downloads',
          gitStatus: null,
          files: [file(NAME)],
        }
      );

      await typeQuery('h');
      await typeQuery('hoja');
      await typeQuery('hoja inscripcion');
      expect(element.querySelector('#file-browser-global-results')).toBeTruthy();
      await settle();
      // One request for the last text: the earlier keystrokes never reached the server.
      expect(searchCalls()).toEqual([`/api/fs/search?q=${encodeURIComponent('hoja inscripcion')}`]);
      const rows = [
        ...element.querySelectorAll('[data-testid="file-browser-global-row"]'),
      ] as HTMLElement[];
      expect(rows.map((r) => r.dataset.path)).toEqual([hit.path, inIcloud.path]);
      expect(rows[0].querySelector('.fb-hit-meta')?.textContent).toContain('Downloads');
      expect(rows[1].querySelector('.fb-hit-meta')?.textContent).toContain(
        'iCloud Drive › Trámites'
      );

      rows[0].click();
      await waitForAsync();
      await element.updateComplete;
      const state = element as unknown as {
        currentFullPath: string;
        selectedFile: { name: string } | null;
      };
      expect(state.currentFullPath).toBe('/home/user/Downloads');
      expect(state.selectedFile?.name).toBe(NAME);
      expect(element.querySelector('#file-browser-global-results')).toBeNull();
    });

    it('cancels a search still in flight when the text changes', async () => {
      const signals: AbortSignal[] = [];
      const previous = global.fetch;
      // The server is slow: the search never answers within the test.
      global.fetch = ((_url: string, init?: RequestInit) => {
        if (init?.signal) signals.push(init.signal);
        return new Promise(() => {});
      }) as unknown as typeof global.fetch;
      try {
        await typeQuery('hoja');
        await vi.waitFor(() => expect(signals).toHaveLength(1));
        await typeQuery('hojas');
        expect(signals[0].aborted).toBe(true);
      } finally {
        global.fetch = previous;
      }
    });

    it('Enter on a result folder button only opens the folder, not the file', async () => {
      const hit = {
        name: NAME,
        path: `/home/user/Downloads/${NAME}`,
        type: 'file',
        size: 10,
        modified: '2026-03-01T10:00:00Z',
        area: 'home',
        parent: 'Downloads',
      };
      fetchMock.mockResponse(`/api/fs/search?q=${encodeURIComponent('hoja')}`, {
        results: [hit],
        truncated: false,
      });
      await typeQuery('hoja');
      await settle();
      const row = element.querySelector('[data-testid="file-browser-global-row"]') as HTMLElement;
      const opened = vi.spyOn(
        element as unknown as { openGlobalHit: (h: unknown) => Promise<void> },
        'openGlobalHit'
      );
      const button = row.querySelector('[data-testid="file-browser-global-folder"]') as HTMLElement;
      button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      expect(opened).not.toHaveBeenCalled();
      row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      expect(opened).toHaveBeenCalledTimes(1);
    });

    it('does not search the Mac for a single character', async () => {
      await typeQuery('h');
      await settle();
      expect(searchCalls()).toEqual([]);
      expect(element.querySelector('#file-browser-global-results')).toBeNull();
    });
  });

  describe('sort by recent', () => {
    it('lists the most recently modified entries first', async () => {
      const entry = (name: string, modified: string) => ({
        name,
        path: name,
        type: 'file' as const,
        size: 1,
        modified,
      });
      fetchMock.mockResponse('/api/fs/browse?path=%2Fhome%2Fuser&showHidden=false&gitFilter=all', {
        path: '/home/user',
        fullPath: '/home/user',
        gitStatus: null,
        files: [
          entry('a.ts', '2026-01-01T00:00:00Z'),
          entry('b.ts', '2026-03-01T00:00:00Z'),
          entry('c.ts', '2026-02-01T00:00:00Z'),
        ],
      });
      element.visible = true;
      await element.updateComplete;
      await waitForAsync();
      await element.updateComplete;
      const names = () =>
        [...element.querySelectorAll('span.truncate')].map((n) => n.textContent?.trim());
      expect(names()).toEqual(['a.ts', 'b.ts', 'c.ts']);

      const recent = [...element.querySelectorAll('button')].find(
        (b) => b.textContent?.trim() === 'Recent'
      );
      recent?.click();
      await element.updateComplete;
      expect(names()).toEqual(['b.ts', 'c.ts', 'a.ts']);
    });
  });

  describe('breadcrumbs', () => {
    it('jumps straight to an ancestor folder when tapped', async () => {
      fetchMock.mockResponse('/api/fs/browse?path=%2Fhome%2Fuser&showHidden=false&gitFilter=all', {
        path: '/srv/app/src/lib',
        fullPath: '/srv/app/src/lib',
        gitStatus: null,
        files: [],
      });
      element.visible = true;
      await element.updateComplete;
      await waitForAsync();
      await element.updateComplete;

      const crumbs = [...element.querySelectorAll('nav button')];
      expect(crumbs.map((b) => b.textContent?.trim())).toEqual(['/', 'srv', 'app', 'src', 'lib']);
      (crumbs[2] as HTMLButtonElement).click();
      await waitForAsync();

      const urls = fetchMock.getCalls().map(([url]) => url);
      expect(urls).toContain('/api/fs/browse?path=%2Fsrv%2Fapp&showHidden=false&gitFilter=all');
    });
  });

  // Missing folders (design spec 5.3, 2026-10-12).
  // User report (2026-10-14): Downloads hung forever after a fresh app install (macOS privacy
  // prompt pending); the server now answers {error: 'permission-pending', folder, place}.
  describe('a folder macOS privacy holds', () => {
    const browse = (path: string) =>
      `/api/fs/browse?${new URLSearchParams({ path, showHidden: 'false', gitFilter: 'all' })}`;
    const blocked = { error: 'permission-pending', folder: 'Downloads', place: 'downloads' };

    it('says how to allow it, with a retry that lists the folder once allowed', async () => {
      fetchMock.mockResponse(browse('/home/user'), {
        path: '/home/user',
        fullPath: '/home/user',
        gitStatus: null,
        files: [],
      });
      fetchMock.mockResponse(browse('/home/user/Downloads'), blocked, { status: 503 });
      element.visible = true;
      await element.updateComplete;
      await waitForAsync();

      await internals(element).loadDirectory('/home/user/Downloads');
      await element.updateComplete;
      const box = element.querySelector('[data-testid="file-browser-blocked"]') as HTMLElement;
      expect(box).toBeTruthy();
      expect(box.dataset.error).toBe('permission-pending');
      expect(box.textContent?.replace(/\s+/g, ' ')).toContain(
        'Untether read Downloads. On the Mac: System Settings › Privacy & Security › Full Disk Access'
      );
      expect(element.querySelector('[data-testid="file-browser-missing"]')).toBeNull();

      fetchMock.mockResponse(browse('/home/user/Downloads'), {
        path: '/home/user/Downloads',
        fullPath: '/home/user/Downloads',
        gitStatus: null,
        files: [],
      });
      (element.querySelector('#file-browser-blocked-retry') as HTMLButtonElement).click();
      await waitForAsync();
      await element.updateComplete;
      expect(element.querySelector('[data-testid="file-browser-blocked"]')).toBeNull();
      expect(internals(element).currentFullPath).toBe('/home/user/Downloads');
    });

    it('does not jump to ~ when the start folder is held (it exists)', async () => {
      fetchMock.mockResponse(
        browse('/home/user'),
        { ...blocked, error: 'permission-denied', folder: 'Desktop', place: 'desktop' },
        { status: 403 }
      );
      element.visible = true;
      await element.updateComplete;
      await waitForAsync();
      await element.updateComplete;
      expect(fetchMock.getCalls().map(([url]) => url)).not.toContain(browse('~'));
      const box = element.querySelector('[data-testid="file-browser-blocked"]') as HTMLElement;
      expect(box.dataset.error).toBe('permission-denied');
      expect(box.textContent).toContain('Desktop');
    });

    it('search notes the folders it could not read, under partial results', async () => {
      fetchMock.mockResponse(browse('/home/user'), {
        path: '/home/user',
        fullPath: '/home/user',
        gitStatus: null,
        files: [],
      });
      fetchMock.mockResponse(`/api/fs/search?q=${encodeURIComponent('informe')}`, {
        results: [
          {
            name: 'informe.txt',
            path: '/home/user/Projects/informe.txt',
            type: 'file',
            size: 1,
            modified: '2026-03-01T10:00:00Z',
            area: 'home',
            parent: 'Projects',
          },
        ],
        truncated: false,
        blocked: [blocked, { error: 'permission-denied', folder: 'Desktop', place: 'desktop' }],
      });
      element.visible = true;
      await element.updateComplete;
      await waitForAsync();
      await element.updateComplete;

      const input = element.querySelector('#file-browser-search') as HTMLInputElement;
      input.value = 'informe';
      input.dispatchEvent(new Event('input'));
      await vi.waitFor(() =>
        expect(element.querySelectorAll('[data-testid="file-browser-global-row"]')).toHaveLength(1)
      );
      expect(element.querySelector('#file-browser-global-blocked')?.textContent?.trim()).toBe(
        'Couldn’t read Downloads, Desktop: some results may be missing'
      );
    });
  });

  describe('a folder that does not exist', () => {
    const browse = (path: string) =>
      `/api/fs/browse?${new URLSearchParams({ path, showHidden: 'false', gitFilter: 'all' })}`;

    it('opens ~ instead when the start folder is gone', async () => {
      fetchMock.mockResponse(
        browse('/home/user'),
        { error: 'Directory not found' },
        { status: 404 }
      );
      fetchMock.mockResponse(browse('~'), {
        path: '~',
        fullPath: '/Users/me',
        gitStatus: null,
        files: [],
      });
      element.visible = true;
      await element.updateComplete;
      await waitForAsync();
      await element.updateComplete;

      expect(fetchMock.getCalls().map(([url]) => url)).toContain(browse('~'));
      expect(element.querySelector('[data-testid="file-browser-missing"]')).toBeNull();
      expect(internals(element).currentFullPath).toBe('/Users/me');
    });

    it('says so inline, with a way back home, when navigated to', async () => {
      fetchMock.mockResponse(browse('/home/user'), {
        path: '/home/user',
        fullPath: '/home/user',
        gitStatus: null,
        files: [],
      });
      fetchMock.mockResponse(browse('/gone'), { error: 'Directory not found' }, { status: 404 });
      fetchMock.mockResponse(browse('~'), {
        path: '~',
        fullPath: '/Users/me',
        gitStatus: null,
        files: [],
      });
      element.visible = true;
      await element.updateComplete;
      await waitForAsync();

      await internals(element).loadDirectory('/gone');
      await element.updateComplete;
      const missing = element.querySelector('[data-testid="file-browser-missing"]');
      expect(missing?.textContent?.replace(/\s+/g, ' ')).toMatch(
        /This folder doesn.t exist: \/gone/
      );
      expect(element.querySelector('[role="alert"]')).toBeNull();

      (element.querySelector('[data-testid="file-browser-go-home"]') as HTMLButtonElement).click();
      await waitForAsync();
      await element.updateComplete;
      expect(element.querySelector('[data-testid="file-browser-missing"]')).toBeNull();
      expect(internals(element).currentFullPath).toBe('/Users/me');
    });
  });

  describe('one request per navigation (2026-11-10)', () => {
    const browseUrl = (dir: string) =>
      `/api/fs/browse?path=${encodeURIComponent(dir)}&showHidden=false&gitFilter=all`;
    const listing = (dir: string) => ({ path: dir, fullPath: dir, gitStatus: null, files: [] });

    it('a browser created already visible lists its folder once', async () => {
      fetchMock.mockResponse(browseUrl('/home/user'), listing('/home/user'));
      const el = await fixture<FileBrowser>(html`
        <file-browser
          .visible=${true}
          .mode=${'browse'}
          .session=${{ id: 'test-session', workingDir: '/home/user' } as Session}
        ></file-browser>
      `);
      await waitForAsync();
      await el.updateComplete;
      const browse = fetchMock
        .getCalls()
        .map((call) => String(call[0]))
        .filter((url) => url.startsWith('/api/fs/browse'));
      expect(browse).toHaveLength(1);
    });

    it('an element removed while it loads leaves no listener on document or window', async () => {
      const added: Array<[EventTarget, string, unknown]> = [];
      const removed: Array<[EventTarget, string, unknown]> = [];
      const record = (list: typeof added, target: EventTarget) => (type: string, fn: unknown) => {
        list.push([target, type, fn]);
      };
      const spies = [
        vi.spyOn(document, 'addEventListener').mockImplementation(record(added, document) as never),
        vi
          .spyOn(document, 'removeEventListener')
          .mockImplementation(record(removed, document) as never),
        vi.spyOn(window, 'addEventListener').mockImplementation(record(added, window) as never),
        vi
          .spyOn(window, 'removeEventListener')
          .mockImplementation(record(removed, window) as never),
      ];
      try {
        const el = document.createElement('file-browser') as FileBrowser;
        el.visible = true;
        document.body.appendChild(el);
        el.remove(); // gone before the auth config or the folder came back
        await waitForAsync();
        const ours = added.filter(([, type]) => type === 'keydown' || type === 'resize');
        expect(ours.length).toBeGreaterThan(0);
        for (const [target, type, fn] of ours) {
          expect(removed.some(([t, ty, f]) => t === target && ty === type && f === fn)).toBe(true);
        }
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    });

    it('a slow answer for an earlier folder does not replace the folder navigated to next', async () => {
      let releaseSlow: () => void = () => {};
      const entry = (name: string) => ({
        name,
        path: name,
        type: 'file',
        size: 1,
        modified: '2026-03-01T10:00:00Z',
      });
      global.fetch = vi.fn(async (url: string) => {
        if (url.startsWith('/api/fs/browse')) {
          const dir = new URLSearchParams(url.split('?')[1]).get('path') ?? '';
          if (dir === '/slow') await new Promise<void>((resolve) => (releaseSlow = resolve));
          return {
            ok: true,
            status: 200,
            json: async () => ({
              path: dir,
              fullPath: dir,
              gitStatus: null,
              files: [entry(`in-${dir.slice(1)}.txt`)],
            }),
          };
        }
        return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
      }) as unknown as typeof global.fetch;

      element.visible = true;
      await element.updateComplete;
      await waitForAsync();

      const slow = internals(element).loadDirectory('/slow');
      await internals(element).loadDirectory('/fast');
      releaseSlow();
      await slow;
      await element.updateComplete;

      expect(internals(element).currentFullPath).toBe('/fast');
      const names = Array.from(element.querySelectorAll('.fb-row'))
        .map((row) => row.textContent)
        .join(' ');
      expect(names).toContain('in-fast.txt');
      expect(names).not.toContain('in-slow.txt');
    });
  });

  // 2026-11-11: Escape did nothing; the modal-wrapper that used to close it is gone.
  describe('Escape', () => {
    it('closes the browser, and only leaves the path field while that is being edited', async () => {
      element.visible = true;
      await element.updateComplete;
      await waitForAsync();
      const cancelled = vi.fn();
      element.addEventListener('browser-cancel', cancelled);
      const pressEscape = () =>
        document.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
        );

      (element as unknown as { editingPath: boolean }).editingPath = true;
      pressEscape();
      expect(cancelled).not.toHaveBeenCalled();
      expect((element as unknown as { editingPath: boolean }).editingPath).toBe(false);

      pressEscape();
      expect(cancelled).toHaveBeenCalledTimes(1);

      // Hidden: not its key.
      element.visible = false;
      pressEscape();
      expect(cancelled).toHaveBeenCalledTimes(1);
    });
  });

  describe('Enter on the document', () => {
    it('does not also insert the path when a focused row already handled that Enter', async () => {
      element.visible = true;
      await element.updateComplete;
      await waitForAsync();
      const priv = element as unknown as {
        selectedFile: unknown;
        insertPathIntoTerminal(): void;
      };
      priv.selectedFile = { name: 'a.ts', path: 'a.ts', type: 'file', size: 1, modified: '' };
      const insert = vi.spyOn(priv, 'insertPathIntoTerminal').mockImplementation(() => {});

      const handled = new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      });
      handled.preventDefault();
      document.dispatchEvent(handled);
      expect(insert).not.toHaveBeenCalled();

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      expect(insert).toHaveBeenCalledTimes(1);
    });
  });
});
