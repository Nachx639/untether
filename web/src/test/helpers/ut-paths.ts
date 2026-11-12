import { createRequire } from 'node:module';
import * as path from 'path';

const require = createRequire(import.meta.url);

/**
 * Get the path to the ut script for testing
 */
export function getUtScriptPath(): string {
  return path.join(process.cwd(), 'bin', 'ut');
}

/**
 * The `untether` CLI for tests: the launcher scripts/ensure-test-cli.js writes over the bundle of
 * the current code. Never native/untether (a Mac app build left in the checkout, as old as that
 * build) nor bin/untether (it needs a build a fresh worktree does not have).
 */
export function getUntetherBinaryPath(): string {
  return path.join(process.cwd(), 'native', 'untether-test');
}

/**
 * Builds that CLI when it is missing or older than the code, and returns its path. For tests that
 * start it: `pnpm test` has done it already (pretest), a file run on its own has not.
 */
export async function ensureUntetherBinary(): Promise<string> {
  const { ensureTestCli } = require('../../../scripts/ensure-test-cli.js') as {
    ensureTestCli: () => Promise<string>;
  };
  return ensureTestCli();
}
