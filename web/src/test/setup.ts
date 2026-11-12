// Global test setup for Vitest

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { webcrypto } from 'crypto';
import { vi } from 'vitest';
import { setServerLogging } from '../client/utils/logger';
import { writeMark } from './helpers/system-sound-guard';
import { installLoopbackServers } from './loopback-servers';
import { MockFitAddon, MockTerminal } from './utils/terminal-mocks';

// Mock ghostty-web (WASM/canvas) for unit tests
vi.mock('ghostty-web', () => ({
  Terminal: MockTerminal,
  FitAddon: MockFitAddon,
}));

// Each terminal instantiates the served ghostty-vt.wasm (terminal-ghostty.ts, tested on its
// own): the mocked Terminal gets a new stand-in for every instance instead.
vi.mock('../client/components/terminal-ghostty.js', () => ({
  createGhostty: vi.fn(async () => ({})),
  preloadGhosttyModule: vi.fn(),
}));

// 2026-11-03: a replaced process.env (`process.env = { ... }`) is not what Node 26 hands to
// child processes, which get the real environment: tts.test.ts's fakes lost their settings
// and 10 tests failed only on Node 26. Replacing it throws here, naming the fix.
{
  const realEnv = process.env;
  Object.defineProperty(process, 'env', {
    configurable: true,
    enumerable: true,
    get: () => realEnv,
    set: () => {
      throw new Error(
        'Tests must not replace process.env (child processes would not see it on Node 26+): ' +
          'change keys in place and restore with snapshotEnv() from test/helpers/env-snapshot.ts'
      );
    },
  });
}

// Server tests never touch the real home (2026-10-02: a push test saved a fake
// subscription into ~/.untether/notifications/subscriptions.json, the live server's data).
if (typeof window === 'undefined' && !process.env.UNTETHER_TEST_REAL_HOME) {
  if (!process.env.HOME?.startsWith(process.env.UNTETHER_TEST_RUN_DIR ?? tmpdir())) {
    // Inside the run's directory (global-setup.ts), which is removed when the run ends.
    const parent = process.env.UNTETHER_TEST_RUN_DIR ?? tmpdir();
    // temp-dir-scope: setup file runs once per test file before any hook exists, HOME must be set now
    process.env.HOME = mkdtempSync(join(parent, 'h-'));
  }
  // These move the agents' data out of HOME: set in the developer's shell, tests would read
  // (and could write) their real Claude, Codex and Gemini folders.
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CODEX_HOME;
  delete process.env.GEMINI_CLI_HOME;
}

// Disable SEA loader for tests
process.env.UNTETHER_SEA = '';
// Prevent spawned test servers from creating persistent signing material in the real home.
process.env.JWT_SECRET ??= 'untether-test-only-jwt-secret';

// Polyfill crypto for Node.js environments
if (!globalThis.crypto) {
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto,
    configurable: true,
  });
}

// Mock the native pty module before any imports
vi.mock('node-pty', () => {
  // Create a more complete mock that simulates PTY behavior
  const createMockPty = (command: string, args: string[]) => {
    let dataCallback: ((data: string) => void) | null = null;
    let exitCallback: ((exitInfo: { exitCode: number; signal?: number }) => void) | null = null;
    let isKilled = false;
    let cols = 80;
    let rows = 24;

    const mockPty = {
      pid: Math.floor(Math.random() * 10000) + 1000,
      cols,
      rows,
      process: command,
      handleFlowControl: false,
      on: vi.fn(),
      resize: vi.fn((newCols: number, newRows: number) => {
        cols = newCols;
        rows = newRows;
      }),
      write: vi.fn((data: string) => {
        // Simulate echo behavior for 'cat' command
        if (command === 'sh' && args[0] === '-c' && args[1] === 'cat' && dataCallback) {
          // Echo back the input
          setTimeout(() => {
            if (!isKilled && dataCallback) {
              dataCallback(data);
            }
          }, 10);
        }
      }),
      kill: vi.fn((signal?: string) => {
        isKilled = true;
        // Simulate process exit
        if (exitCallback) {
          setTimeout(() => {
            exitCallback?.({ exitCode: signal === 'SIGTERM' ? 143 : 137, signal: 15 });
          }, 50);
        }
      }),
      onData: vi.fn((callback: (data: string) => void) => {
        dataCallback = callback;
        // For 'echo' command, immediately output but don't exit yet
        if (command === 'echo' && args[0] === 'test') {
          setTimeout(() => {
            if (dataCallback) dataCallback('test\n');
            // Don't exit immediately - let the test control when to exit
          }, 10);
        }
      }),
      onExit: vi.fn((callback: (exitInfo: { exitCode: number; signal?: number }) => void) => {
        exitCallback = callback;
        // For 'exit' command, exit immediately
        if (command === 'exit') {
          setTimeout(() => {
            if (exitCallback) exitCallback({ exitCode: 0 });
          }, 10);
        }
        // For 'echo' command, exit after a longer delay
        if (command === 'echo') {
          setTimeout(() => {
            if (!isKilled && exitCallback) exitCallback({ exitCode: 0 });
          }, 2000); // Wait 2 seconds before exiting
        }
      }),
    };

    return mockPty;
  };

  return {
    spawn: vi.fn((command: string, args: string[], _options: unknown) => {
      return createMockPty(command, args);
    }),
  };
});

// Mock global objects that might not exist in test environments
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// Mock IntersectionObserver
global.IntersectionObserver = class IntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  root = null;
  rootMargin = '';
  scrollMargin = '';
  thresholds = [];
};

// Mock localStorage for tests
const localStorageMock = {
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
  length: 0,
  key: vi.fn(),
};

// Add localStorage to global scope
if (typeof global !== 'undefined') {
  // biome-ignore lint/suspicious/noExplicitAny: Test setup requires any for global mocking
  (global as any).localStorage = localStorageMock;
}

// Prevent duplicate custom element registration in tests (a module re-imported after
// vi.resetModules() defines its elements again). Wrap define once: re-wrapping before every
// test stacked wrappers that shared a "seen" set, so the outer one marked a name and the inner
// one skipped it — any element first imported inside a test was never registered
// (2026-10-02). The real registry is the only source of truth.
const PATCHED = Symbol.for('untether.test.customElementsPatched');

function patchCustomElements() {
  if (typeof window === 'undefined' || !window.customElements) return;
  const registry = window.customElements as CustomElementRegistry & { [PATCHED]?: boolean };
  if (registry[PATCHED]) return;
  const originalDefine = registry.define.bind(registry);
  registry.define = (
    name: string,
    elementConstructor: CustomElementConstructor,
    options?: ElementDefinitionOptions
  ) => {
    if (registry.get(name)) return;
    originalDefine(name, elementConstructor, options);
  };
  registry[PATCHED] = true;
}

// Apply patch immediately for module imports
patchCustomElements();

// Re-apply before each test in case the environment swapped the registry (no-op otherwise)
beforeEach(() => {
  patchCustomElements();
});
// Mock matchMedia (only if window exists - for browser tests)
if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });

  // Also add localStorage to window for browser tests
  // biome-ignore lint/suspicious/noExplicitAny: Test setup requires any for window mocking
  (window as any).localStorage = localStorageMock;
}

// Mock WebSocket for tests that need it
global.WebSocket = class WebSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  url: string;
  readyState: number = WebSocket.CONNECTING;
  binaryType: 'blob' | 'arraybuffer' = 'blob';

  constructor(url: string) {
    super();
    this.url = url;
  }

  send() {}
  close() {
    this.readyState = WebSocket.CLOSED;
  }
} as unknown as typeof WebSocket;

// Set up fetch mock (only for non-e2e tests)
if (typeof window !== 'undefined') {
  global.fetch = vi.fn();
  // Client loggers send nothing to the server in tests: the sink's late dynamic import and
  // /api/auth/config lookup landed in tests that stub fetch and count their own calls
  // (2026-11-02, terminal-chat-view under load). logger.test.ts turns it back on.
  setServerLogging(false);
}

// Server tests never reach the live servers on this machine: 4020/4021 are the developer's own Untether
// and 4030/4031 the QA one. 2026-10-03: a git-event test relayed without stubbing fetch and
// POSTed a fake event to the real 4020 on every run ("Unauthorized request to POST
// /git/event" in its log). Tests needing HTTP start their own server elsewhere or stub fetch.
if (typeof window === 'undefined' && typeof globalThis.fetch === 'function') {
  const realFetch = globalThis.fetch.bind(globalThis);
  const livePorts = new Set(['4020', '4021', '4030', '4031']);
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    let url: URL | null = null;
    try {
      url = new URL(href);
    } catch {
      url = null;
    }
    if (
      url &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
      livePorts.has(url.port)
    ) {
      throw new Error(`test tried to reach the live Untether at ${url.host}: stub fetch`);
    }
    return realFetch(input, init);
  }) as typeof fetch;
}

// Test servers listen on 127.0.0.1 only, supertest's included (2026-10-04: another process's
// loopback listener on the same port answered route tests with 404/401 or hung up).
// Client tests too: some run the server's own routes through supertest (e.g. the Mac sessions
// contract test, which got a stranger's 403 on 2026-10-04 while this was server-only).
installLoopbackServers();

// What this worker runs from when on: a system alert sound from a process it started is
// reported with the test (global-setup.ts, system-sound-guard.ts).
const testFile = () => {
  const file = expect.getState().testPath;
  return file ? file.replace(`${process.cwd()}/`, '') : 'unknown file';
};
beforeAll(() => writeMark(`${testFile()} (beforeAll)`));
beforeEach(() => writeMark(`${testFile()} > ${expect.getState().currentTestName ?? '?'}`));
afterAll(() => writeMark(`${testFile()} (afterAll)`));

// Configure console to reduce noise in tests
const originalError = console.error;
const originalWarn = console.warn;

beforeAll(() => {
  // Suppress specific console errors/warnings during tests
  console.error = (...args: unknown[]) => {
    if (
      typeof args[0] === 'string' &&
      (args[0].includes('Not implemented') || args[0].includes('Failed to fetch'))
    ) {
      return;
    }
    originalError.call(console, ...args);
  };

  console.warn = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].includes('LitElement')) {
      return;
    }
    originalWarn.call(console, ...args);
  };
});

afterAll(() => {
  console.error = originalError;
  console.warn = originalWarn;
});

// Force garbage collection between test suites if available
afterEach(() => {
  if (global.gc) {
    global.gc();
  }
});

// A sheet's pointerup guard must not swallow the first click of the next test.
import { afterEach as afterEachGhost } from 'vitest';
import { resetGhostClickGuard } from '../client/utils/ghost-click.js';

afterEachGhost(() => resetGhostClickGuard());
