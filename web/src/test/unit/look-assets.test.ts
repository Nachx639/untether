import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { RM_TEST_DIR } from '../helpers/rm-test-dir.js';

it('publishes look textures byte-for-byte alongside the combined stylesheet on repeated builds', () => {
  const web = resolve(__dirname, '../../..');
  const root = mkdtempSync(join(tmpdir(), 'ut-look-assets-'));
  try {
    writeFileSync(join(root, '.untether-test-run'), 'look-assets');
    const assets = 'src/client/assets/looks/clay';
    const styles = 'src/client/styles/looks';
    mkdirSync(join(root, assets), { recursive: true });
    mkdirSync(join(root, styles), { recursive: true });
    const names = readdirSync(join(web, assets));
    expect(names).toHaveLength(4);
    for (const name of names) {
      expect(statSync(join(web, assets, name)).size, name).toBeLessThan(60_000);
      copyFileSync(join(web, assets, name), join(root, assets, name));
    }
    const sheets = ['clay.css', 'clay.effects.css'];
    const expectedSheet = sheets
      .map((name) => readFileSync(join(web, styles, name), 'utf8'))
      .join('\n')
      // Each texture is named by its content, so a changed one is never an old cached copy.
      .replace(
        /(\/looks\/clay\/)([a-z0-9-]+\.(?:webp|png))/g,
        (_whole, dir: string, name: string) => {
          const digest = createHash('sha256').update(readFileSync(join(web, assets, name)));
          return `${dir}${name}?v=${digest.digest('hex').slice(0, 16)}`;
        }
      );
    expect(expectedSheet).toMatch(/clay-grano\.webp\?v=[0-9a-f]{16}"/);
    for (const name of sheets) {
      copyFileSync(join(web, styles, name), join(root, styles, name));
    }
    for (let build = 0; build < 2; build++) {
      execFileSync(process.execPath, [join(web, 'scripts/copy-assets.js')], { cwd: root });
      const sheet = readFileSync(join(root, 'public/looks/clay.css'), 'utf8');
      // Publish both complete layers, independent of how Clay paints its rim. The old
      // nine-slice tile remains an asset, but rounded material no longer references it.
      expect(sheet).toBe(expectedSheet);
      const references = [
        ...sheet.matchAll(/url\(["']?\/looks\/clay\/([^"')?]+)\?v=[0-9a-f]{16}["']?\)/g),
      ];
      expect(sheet).not.toMatch(/\/looks\/clay\/[^"')?]+["')]/);
      expect(references.length).toBeGreaterThan(0);
      for (const [, name] of references) {
        expect(names).toContain(name);
      }
      for (const name of names) {
        expect(readFileSync(join(root, 'public/looks/clay', name))).toEqual(
          readFileSync(join(web, assets, name))
        );
      }
    }
  } finally {
    rmSync(root, RM_TEST_DIR);
  }
});

it('every look texture is small and every texture a look sheet names exists', () => {
  const web = resolve(__dirname, '../../..');
  const assets = join(web, 'src/client/assets/looks');
  const styles = join(web, 'src/client/styles/looks');
  const published = new Map<string, string[]>();
  for (const look of readdirSync(assets)) {
    const names = readdirSync(join(assets, look));
    published.set(look, names);
    for (const name of names) {
      expect(statSync(join(assets, look, name)).size, `${look}/${name}`).toBeLessThan(60_000);
    }
  }
  expect(published.get('nature')).toEqual(['nature-papel.webp']);
  for (const sheet of readdirSync(styles)) {
    const text = readFileSync(join(styles, sheet), 'utf8');
    for (const [, look, name] of text.matchAll(/url\(["']?\/looks\/([\w-]+)\/([^"')]+)["']?\)/g)) {
      expect(published.get(look), `${sheet}: /looks/${look}/${name}`).toContain(name);
    }
  }
});
