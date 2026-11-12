import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RM_TEST_DIR } from '../helpers/rm-test-dir.js';

const require = createRequire(import.meta.url);
const { buildNativeAddon, resolvePrebuild } = require('../../../scripts/native-modules.js');

// 2026-10-12: `npm rebuild` / `pnpm rebuild` silently built nothing under ignore-scripts=true,
// so the Mac bundle lost authenticate_pam.node. The helper must build in the package's real
// (pnpm store) directory and fail loudly when node-gyp produces nothing.
describe('native addon builder', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, RM_TEST_DIR);
  });

  function fakePackage() {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'native-addon-')));
    dirs.push(root);
    const real = path.join(root, 'store', 'authenticate-pam');
    fs.mkdirSync(real, { recursive: true });
    fs.writeFileSync(path.join(real, 'package.json'), '{}');
    const link = path.join(root, 'node_modules', 'authenticate-pam');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(real, link);
    const resolve = (id: string) => path.join(root, 'node_modules', id);
    return { real, resolve };
  }

  it('runs node-gyp in the realpath of the package and returns the .node file', () => {
    const { real, resolve } = fakePackage();
    const exec = vi.fn((_cmd: string, _args: string[], opts: { cwd: string }) => {
      fs.mkdirSync(path.join(opts.cwd, 'build', 'Release'), { recursive: true });
      fs.writeFileSync(path.join(opts.cwd, 'build', 'Release', 'authenticate_pam.node'), '');
    });
    const out = buildNativeAddon('authenticate-pam', 'authenticate_pam.node', { exec, resolve });
    expect(exec).toHaveBeenCalledOnce();
    expect(exec.mock.calls[0][1]).toContain('rebuild');
    expect(exec.mock.calls[0][2].cwd).toBe(real);
    expect(out).toBe(path.join(real, 'build', 'Release', 'authenticate_pam.node'));
  });

  it('throws when node-gyp produced no .node file', () => {
    const { resolve } = fakePackage();
    const exec = vi.fn();
    expect(() =>
      buildNativeAddon('authenticate-pam', 'authenticate_pam.node', { exec, resolve })
    ).toThrow(/did not produce/);
  });
});

// 2026-11-11: build-npm.js ran `npx prebuild`, which downloads and runs the tool when it is not
// installed. It comes from web/node-pty's own node_modules or the build stops.
describe('prebuild for the npm package', () => {
  it('is the one installed in node-pty, run with this node', () => {
    const resolve = (id: string) => `/checkout/web/node-pty/node_modules/${id}`;
    expect(resolvePrebuild('/checkout/web/node-pty', resolve)).toEqual([
      process.execPath,
      ['/checkout/web/node-pty/node_modules/prebuild/bin.js'],
    ]);
  });

  it('says what to run when it is not installed, and never names npx as the way', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'no-prebuild-')));
    try {
      fs.writeFileSync(path.join(dir, 'package.json'), '{}');
      expect(() => resolvePrebuild(dir)).toThrow(/pnpm install --frozen-lockfile/);
      expect(() => resolvePrebuild(dir)).toThrow(/never downloaded/);
    } finally {
      fs.rmSync(dir, RM_TEST_DIR);
    }
  });
});
