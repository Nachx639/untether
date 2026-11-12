import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RM_TEST_DIR } from '../helpers/rm-test-dir.js';

const require = createRequire(import.meta.url);
const { watchStyles, watchPlan } = require('../../../scripts/css-watch.js');

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, RM_TEST_DIR);
});

/**
 * Wait for `check`, doing `poke` again every 400 ms: FSEvents can miss a change made right after
 * a watch opens (seen once in this test under load).
 */
async function until(check: () => boolean, poke: () => void, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  let poked = Date.now();
  poke();
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    if (Date.now() - poked > 400) {
      poke();
      poked = Date.now();
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Wait until `count` stays the same for `quietMs`, at most `ms`. 2026-11-02: the 'unrelated'
 * check counted 4 builds instead of 3 under load: a late event from an earlier poke (the id
 * file written twice while a slow build ran) rebuilt after the test took its count. Settling
 * first, then comparing before and after, checks only what the unrelated change caused.
 */
async function settle(count: () => number, quietMs = 1000, ms = 15000): Promise<number> {
  const deadline = Date.now() + ms;
  let last = count();
  let since = Date.now();
  while (Date.now() - since < quietMs) {
    if (Date.now() > deadline) throw new Error(`still changing after ${ms} ms (at ${last})`);
    await new Promise((resolve) => setTimeout(resolve, 25));
    if (count() !== last) {
      last = count();
      since = Date.now();
    }
  }
  return last;
}

describe('watchPlan', () => {
  it('watches scanned folders recursively and other files by their folder, once', () => {
    const plan = watchPlan('/w/src/client/styles.css', [
      { type: 'dir-dependency', dir: '/w/src' },
      { type: 'dependency', file: '/w/src/client/app.ts' },
      { type: 'dependency', file: '/w/public/bundle/.build-id' },
      { type: 'dependency', file: '/w/tsconfig.json' },
      { type: 'dependency', file: '/w/vitest.config.ts' },
    ]);
    expect([...plan.dirs]).toEqual(['/w/src']);
    expect([...plan.files.keys()].sort()).toEqual(['/w', '/w/public/bundle']);
    expect([...plan.files.get('/w')].sort()).toEqual(['tsconfig.json', 'vitest.config.ts']);
  });
});

describe('watchStyles', () => {
  it('builds, then rebuilds on a change in a scanned folder or a dependency file only', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'css-watch-'));
    dirs.push(root);
    const scanned = path.join(root, 'src');
    const other = path.join(root, 'other');
    fs.mkdirSync(scanned);
    fs.mkdirSync(other);
    const idFile = path.join(other, 'id');
    fs.writeFileSync(idFile, 'one');
    fs.writeFileSync(path.join(other, 'unrelated'), 'x');
    const input = path.join(root, 'in.css');
    const output = path.join(root, 'out.css');
    fs.writeFileSync(input, 'a { color: red }');
    let builds = 0;
    // Stands in for Tailwind: scans `src`, reads the id file into the output.
    const plugin = {
      postcssPlugin: 'fake',
      OnceExit(
        root_: { append: (node: unknown) => void },
        {
          result,
          Comment,
        }: { result: { messages: unknown[] }; Comment: new (o: object) => unknown }
      ) {
        builds++;
        result.messages.push({ type: 'dir-dependency', dir: scanned, glob: '**/*' });
        result.messages.push({ type: 'dependency', file: idFile });
        root_.append(new Comment({ text: `id ${fs.readFileSync(idFile, 'utf8')}` }));
      },
    };
    const watcher = watchStyles({ input, output, plugins: [plugin], debounceMs: 30 });
    try {
      await watcher.ready;
      expect(builds).toBe(1);
      expect(fs.readFileSync(output, 'utf8')).toContain('/* id one */');
      expect(watcher.watched().sort()).toEqual([`f:${other}`, `f:${root}`, `r:${scanned}`].sort());

      fs.mkdirSync(path.join(scanned, 'deep'));
      await until(
        () => builds >= 2,
        () => fs.writeFileSync(path.join(scanned, 'deep', 'x.ts'), `class="p-${builds}"`)
      );

      await until(
        () => fs.readFileSync(output, 'utf8').includes('/* id two */'),
        () => fs.writeFileSync(idFile, 'two')
      );

      // A file next to a dependency, not read by the build: no rebuild. Once nothing else is
      // still on its way, the change and the quiet time after it (far past the 30 ms debounce)
      // must not add a build.
      const before = await settle(() => builds);
      fs.writeFileSync(path.join(other, 'unrelated'), 'y');
      expect(await settle(() => builds)).toBe(before);
    } finally {
      watcher.close();
    }
  }, 40000);

  it('keeps watching the input after a failed build and recovers when it is fixed', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'css-watch-'));
    dirs.push(root);
    const input = path.join(root, 'in.css');
    const output = path.join(root, 'out.css');
    fs.writeFileSync(input, 'a { color: red');
    const logs: string[] = [];
    const watcher = watchStyles({
      input,
      output,
      // A plugin makes postcss parse (with none it passes the text through).
      plugins: [{ postcssPlugin: 'parse', Once() {} }],
      debounceMs: 30,
      log: (line: string) => logs.push(line),
    });
    try {
      await watcher.ready;
      expect(logs.join('\n')).toContain('build failed');
      expect(fs.existsSync(output)).toBe(false);
      await until(
        () => fs.existsSync(output) && fs.readFileSync(output, 'utf8').includes('blue'),
        () => fs.writeFileSync(input, 'a { color: blue }')
      );
    } finally {
      watcher.close();
    }
  });
});
