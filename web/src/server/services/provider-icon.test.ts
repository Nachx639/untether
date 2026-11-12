import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { PROVIDER_ICON_MAX_BYTES, providerIconsDir, resolveProviderIcon } from './provider-icon.js';

describe('resolveProviderIcon', () => {
  let dir: string;
  let outside: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-provider-icons-'));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-provider-out-'));
    fs.writeFileSync(path.join(dir, 'acme.png'), 'png');
    fs.writeFileSync(path.join(outside, 'secret.png'), 'secret');
  });

  afterEach(() => {
    fs.rmSync(dir, RM_TEST_DIR);
    fs.rmSync(outside, RM_TEST_DIR);
  });

  it('serves a bare image name of the folder', () => {
    expect(resolveProviderIcon('acme.png', dir)).toEqual({
      file: fs.realpathSync(path.join(dir, 'acme.png')),
      type: 'image/png',
    });
  });

  it.each([
    '../secret.png',
    '..%2Fsecret.png',
    'a/../../secret.png',
    'sub/acme.png',
    '/etc/passwd.png',
    '..\\secret.png',
    '.hidden.png',
    'a..png',
  ])('refuses the name %s', (name) => {
    expect(resolveProviderIcon(name, dir)).toMatchObject({ error: expect.any(String) });
  });

  it('refuses an absolute path that exists', () => {
    expect(resolveProviderIcon(path.join(outside, 'secret.png'), dir)).toMatchObject({
      error: 'not an icon file name',
    });
  });

  it.each(['acme.jpg', 'acme.txt', 'acme.png.exe'])('refuses the type of %s', (name) => {
    fs.writeFileSync(path.join(dir, name), 'x');
    expect(resolveProviderIcon(name, dir)).toMatchObject({ error: 'not an icon file name' });
  });

  it('refuses a symlink out of the folder, serves one inside it', () => {
    fs.symlinkSync(path.join(outside, 'secret.png'), path.join(dir, 'link.png'));
    expect(resolveProviderIcon('link.png', dir)).toMatchObject({ error: /outside/ });
    fs.symlinkSync(path.join(dir, 'acme.png'), path.join(dir, 'alias.png'));
    expect(resolveProviderIcon('alias.png', dir)).toMatchObject({ type: 'image/png' });
  });

  it('refuses a folder whose name looks like an image, and one too big', () => {
    fs.mkdirSync(path.join(dir, 'folder.png'));
    expect(resolveProviderIcon('folder.png', dir)).toMatchObject({ error: /not a file/ });
    fs.writeFileSync(path.join(dir, 'big.png'), Buffer.alloc(PROVIDER_ICON_MAX_BYTES + 1));
    expect(resolveProviderIcon('big.png', dir)).toMatchObject({ error: /larger than/ });
  });

  it('a missing file or folder is simply not found', () => {
    expect(resolveProviderIcon('nope.png', dir)).toMatchObject({ error: /not found/ });
    expect(resolveProviderIcon('acme.png', path.join(dir, 'none'))).toMatchObject({
      error: /not found/,
    });
  });

  it('the folder follows the control directory', () => {
    expect(providerIconsDir({ UNTETHER_CONTROL_DIR: '/c' })).toBe('/c/icons');
    expect(providerIconsDir({})).toBe(path.join(os.homedir(), '.untether', 'icons'));
  });
});
