import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { CLAUDE_HOOK_EVENTS, claudeHookFiles, withClaudeHooks } from './claude-hooks.js';
import { createProviderLauncher } from './model-provider-launch.js';
import type { ProviderPricing } from './model-provider-pricing.js';

// 2026-11-11 (server audit): an interactive provider session started with the `/model` picker
// as its `--settings`; Claude takes one, so it ran without Untether's hooks and its state
// (working, waiting, done) came from reading the screen.
describe('an interactive provider session', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ut-provider-launch-')));
  });
  afterEach(() => fs.rmSync(dir, RM_TEST_DIR));

  const launcher = () =>
    createProviderLauncher({
      providers: () => [
        {
          id: 'acme',
          label: 'Acme',
          baseUrl: 'https://api.acme.example',
          keyEnv: 'ACME_KEY',
          models: ['big', 'small'],
          defaultModel: 'big',
        },
      ],
      readKey: async () => 'k',
      pricing: {
        contextWindows: async () => ({}),
        discoverModels: async () => [],
      } as unknown as ProviderPricing,
      untetherDir: dir,
    });

  it('starts with the picker and the hooks in one settings file, known as hooked', async () => {
    const launch = await launcher().interactive({ id: 'acme', model: 'big' }, ['claude']);
    expect(launch).not.toBeNull();
    const command = launch?.command ?? [];
    const settingsPath = command[command.indexOf('--settings') + 1];
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(settings.modelPicker.options.map((o: { model: string }) => o.model)).toEqual([
      'big',
      'small',
    ]);
    expect(Object.keys(settings.hooks).sort()).toEqual([...CLAUDE_HOOK_EVENTS].sort());
    const hooks = claudeHookFiles(dir);
    expect(JSON.stringify(settings.hooks)).toContain(hooks.script);
    expect(fs.existsSync(hooks.script)).toBe(true);
    // What the spawn does with it: the command keeps its own settings and counts as hooked
    // (a copy; an untouched command comes back as the same array).
    const spawned = withClaudeHooks(command, hooks.settings);
    expect(spawned).toEqual(command);
    expect(spawned).not.toBe(command);
  });
});
