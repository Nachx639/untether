import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The Mac and iOS apps are compiled Swift: their lists of agents are generated from the shared
 * registry (web/src/shared/agents.ts) by web/scripts/sync-agent-registry.mjs. An agent added
 * to the registry and not to them fails here, with the command that brings them up to date.
 */
describe('agent registry: native mirrors', () => {
  it('the Mac and iOS lists of agents match the registry', () => {
    const output = execFileSync(
      process.execPath,
      ['--experimental-strip-types', 'scripts/sync-agent-registry.mjs', '--check'],
      { cwd: path.resolve(__dirname, '../../..'), encoding: 'utf8' }
    );
    expect(output).toContain('native mirrors match');
  });
});
