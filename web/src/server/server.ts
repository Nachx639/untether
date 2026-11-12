// Untether server entry point. The server itself is built in server-app.ts (createApp), from
// the setup steps in server-*.ts; it starts in server-start.ts (startUntetherServer).

export { createApp } from './server-app.js';
export {
  isLoopbackBindAddress,
  leftoverServeRoutesRefusal,
  normalizeRemoteUrl,
  parseArgs,
  resolveRemoteUrl,
  unsafeNoAuthReason,
  watchParentWhenUnauthenticated,
} from './server-config.js';
export { startUntetherServer } from './server-start.js';

// One shutdown flag for the whole server (services/shutdown-state.ts). This file kept a copy
// of its own and set only that one, so the PTY manager, which reads the shared module, never
// saw a shutdown: while the server went down it re-attached shielded sessions' tmux clients and
// could restore a program whose tmux server was gone (review of 2026-10-03).
export { isShuttingDown, setShuttingDown } from './services/shutdown-state.js';

// Export for testing
export * from './version.js';
