import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RM_TEST_DIR } from '../helpers/rm-test-dir.js';
import { getUntetherBinaryPath } from '../helpers/ut-paths.js';

// 2026-11-11: the tests started native/untether when a build of the Mac app had left one in the
// checkout (as old as that build), and bin/untether, which needs a build, when nothing else was
// there. They start the launcher of the bundle ensure-test-cli.js keeps up to date, whatever
// else the checkout holds.
describe('getUntetherBinaryPath', () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) fs.rmSync(dir, RM_TEST_DIR);
  });

  it('is the test launcher, also next to a native binary from another build', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ut-paths-')));
    dirs.push(root);
    fs.mkdirSync(path.join(root, 'native'));
    fs.writeFileSync(path.join(root, 'native', 'untether'), '');
    vi.spyOn(process, 'cwd').mockReturnValue(root);

    expect(getUntetherBinaryPath()).toBe(path.join(root, 'native', 'untether-test'));
  });

  it('is the test launcher in a checkout without any build', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ut-paths-')));
    dirs.push(root);
    vi.spyOn(process, 'cwd').mockReturnValue(root);

    expect(getUntetherBinaryPath()).toBe(path.join(root, 'native', 'untether-test'));
  });
});
