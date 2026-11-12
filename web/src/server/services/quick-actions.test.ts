import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_QUICK_ACTIONS } from '../../shared/quick-actions.js';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { loadQuickActions, quickActionsRoot, saveQuickActions } from './quick-actions.js';

describe('quick actions service', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ut-quick-actions-')));
  });

  afterEach(() => {
    fs.rmSync(dir, RM_TEST_DIR);
  });

  const writeFile = (content: string) => {
    fs.mkdirSync(path.join(dir, '.untether'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.untether', 'quick-actions.json'), content);
  };

  it('serves the defaults when the project has no file', async () => {
    const result = await loadQuickActions(dir);
    expect(result).toEqual({
      source: 'default',
      path: path.join(dir, '.untether', 'quick-actions.json'),
      actions: DEFAULT_QUICK_ACTIONS,
      warnings: [],
    });
  });

  it("serves the file's valid actions with warnings for the others", async () => {
    writeFile(
      JSON.stringify({
        version: 1,
        actions: [
          { id: 'deploy-check', emoji: '🚦', label: 'Check', prompt: 'Is CI green?' },
          { id: 'broken', emoji: '🙂' },
        ],
      })
    );
    const result = await loadQuickActions(dir);
    expect(result.source).toBe('file');
    expect(result.actions.map((a) => a.id)).toEqual(['deploy-check']);
    expect(result.warnings).toEqual(['action 2: label is required']);
  });

  it('falls back to the defaults when the file is not valid JSON', async () => {
    writeFile('{ nope');
    const result = await loadQuickActions(dir);
    expect(result.source).toBe('default');
    expect(result.warnings).toEqual(['not valid JSON']);
  });

  it('saves the list, creating .untether, and reads it back', async () => {
    const actions = [
      { id: 'a', emoji: '⚡', label: 'A', prompt: 'do a', agents: ['codex' as const] },
    ];
    const saved = await saveQuickActions(dir, actions);
    expect(saved.source).toBe('file');
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(dir, '.untether', 'quick-actions.json'), 'utf8')
    );
    expect(onDisk).toEqual({ version: 1, actions });
    expect((await loadQuickActions(dir)).actions).toEqual(actions);
    expect(fs.readdirSync(path.join(dir, '.untether'))).toEqual(['quick-actions.json']);
  });

  it("uses the repository's root from a subfolder, and the folder itself outside git", async () => {
    expect(await quickActionsRoot(dir)).toBe(dir);
    execFileSync('git', ['init', '-q'], { cwd: dir });
    const sub = path.join(dir, 'src', 'deep');
    fs.mkdirSync(sub, { recursive: true });
    expect(await quickActionsRoot(sub)).toBe(dir);
  });
});
