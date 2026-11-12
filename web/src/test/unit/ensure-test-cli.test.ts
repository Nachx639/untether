import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RM_TEST_DIR } from '../helpers/rm-test-dir.js';

const require = createRequire(import.meta.url);
const { cliBundleIsStale } = require('../../../scripts/ensure-test-cli.js') as {
  cliBundleIsStale: (bundle: string, srcDir: string) => boolean;
};

// 2026-11-10 (scripts/docs audit): the test CLI was built only when it was missing, so the tests
// that start it ran an old CLI for as long as the checkout lived.
describe('ensure-test-cli', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, RM_TEST_DIR);
  });

  function checkout() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ensure-test-cli-'));
    dirs.push(root);
    const src = path.join(root, 'src');
    const bundle = path.join(root, 'dist', 'untether-cli');
    const write = (file: string, at: number) => {
      const full = path.join(root, file);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, '');
      fs.utimesSync(full, at, at);
    };
    return { src, bundle, write };
  }

  it('asks for a build when there is no bundle', () => {
    const { src, bundle, write } = checkout();
    write('src/cli.ts', 1000);
    expect(cliBundleIsStale(bundle, src)).toBe(true);
  });

  it('asks for a build when the code is newer than the bundle', () => {
    const { src, bundle, write } = checkout();
    write('src/cli.ts', 1000);
    write('src/server/services/tasks.ts', 1000);
    write('dist/untether-cli', 2000);
    expect(cliBundleIsStale(bundle, src)).toBe(false);

    write('src/server/services/tasks.ts', 3000);
    expect(cliBundleIsStale(bundle, src)).toBe(true);
  });

  it('does not rebuild for what the bundle is not made from', () => {
    const { src, bundle, write } = checkout();
    write('src/cli.ts', 1000);
    write('dist/untether-cli', 2000);
    write('src/client/app.ts', 3000);
    write('src/test/unit/some.test.ts', 3000);
    write('src/server/routes/tasks.test.ts', 3000);
    expect(cliBundleIsStale(bundle, src)).toBe(false);
  });
});
