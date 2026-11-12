import { describe, expect, it } from 'vitest';
import { isShuttingDown as serverIsShuttingDown, setShuttingDown } from './server.js';
import { isShuttingDown } from './services/shutdown-state.js';

describe('shutdown state', () => {
  it('is one flag: what the server sets on shutdown is what the PTY manager reads', () => {
    // pty-manager reads services/shutdown-state; server.ts set a copy of its own, so on a
    // deploy pty-manager re-attached shielded sessions while the server went down.
    setShuttingDown(true);
    try {
      expect(isShuttingDown()).toBe(true);
      expect(serverIsShuttingDown()).toBe(true);
    } finally {
      setShuttingDown(false);
    }
  });
});
