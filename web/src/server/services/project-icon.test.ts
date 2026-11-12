import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { PROJECT_ICON_MAX_BYTES, resolveProjectIcon } from './project-icon.js';

describe('resolveProjectIcon (2026-10-20)', () => {
  let repo: string;
  let outside: string;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-icon-repo-'));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-icon-out-'));
    fs.mkdirSync(path.join(repo, 'assets'));
    fs.writeFileSync(path.join(repo, 'assets', 'icon.png'), 'png');
    fs.writeFileSync(path.join(outside, 'secret.png'), 'png');
  });

  afterEach(() => {
    fs.rmSync(repo, RM_TEST_DIR);
    fs.rmSync(outside, RM_TEST_DIR);
  });

  it('takes an image inside the project', () => {
    expect(resolveProjectIcon(repo, 'assets/icon.png')).toMatchObject({
      file: fs.realpathSync(path.join(repo, 'assets', 'icon.png')),
      type: 'image/png',
    });
  });

  it('refuses what is not an image, missing, too big, or outside the project', () => {
    fs.writeFileSync(path.join(repo, '.env.png.txt'), 'x');
    expect(resolveProjectIcon(repo, '.env.png.txt')).toMatchObject({ error: /must be an image/ });
    expect(resolveProjectIcon(repo, 'assets/nope.png')).toMatchObject({ error: /not found/ });
    fs.writeFileSync(path.join(repo, 'big.png'), Buffer.alloc(PROJECT_ICON_MAX_BYTES + 1));
    expect(resolveProjectIcon(repo, 'big.png')).toMatchObject({ error: /larger than/ });
    expect(resolveProjectIcon(repo, '../secret.png')).toMatchObject({ error: /not found|inside/ });
    // A link inside the project to a file outside it is outside.
    fs.symlinkSync(path.join(outside, 'secret.png'), path.join(repo, 'link.png'));
    expect(resolveProjectIcon(repo, 'link.png')).toMatchObject({ error: /inside the project/ });
  });
});
