import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Plugin } from 'postcss';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RM_TEST_DIR } from '../helpers/rm-test-dir.js';

const require = createRequire(import.meta.url);
const { buildStyles } = require('../../../scripts/css-build.js');
let dir: string;
let input: string;
let output: string;
const parse: Plugin = { postcssPlugin: 'parse', Once() {} };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'css-build-'));
  input = path.join(dir, 'source with spaces.css');
  output = path.join(dir, 'nested output', 'styles.css');
  fs.writeFileSync(input, '.example { color: red }');
});

afterEach(() => {
  fs.rmSync(dir, RM_TEST_DIR);
});

describe('buildStyles', () => {
  it('awaits plugins and writes transformed CSS with an inline source map', async () => {
    const plugin: Plugin = {
      postcssPlugin: 'async-transform',
      async Once(root) {
        await Promise.resolve();
        root.walkDecls('color', (declaration) => {
          declaration.value = 'blue';
        });
      },
    };
    await buildStyles({ input, output, plugins: [plugin] });
    const css = fs.readFileSync(output, 'utf8');
    expect(css).toContain('.example { color: blue }');
    const encoded = css.match(/sourceMappingURL=data:application\/json;base64,([^\s]+)/)?.[1];
    expect(encoded).toBeDefined();
    const map = JSON.parse(Buffer.from(encoded ?? '', 'base64').toString('utf8'));
    expect(map.file).toBe('styles.css');
    expect(map.sources).toEqual(['../source%20with%20spaces.css']);
    expect(map.sourcesContent).toEqual(['.example { color: red }']);
    expect(map.mappings).not.toBe('');
    expect(fs.existsSync(`${output}.map`)).toBe(false);
  });

  it('loads the configured Tailwind plugin when plugins are not overridden', async () => {
    fs.writeFileSync(
      input,
      '@theme { --color-css-build: #123456; }\n.example { color: var(--color-css-build); }'
    );
    await buildStyles({ input, output });
    const css = fs.readFileSync(output, 'utf8');
    expect(css).not.toContain('@theme');
    expect(css).toContain('--color-css-build: #123456');
    expect(css).toContain('var(--color-css-build)');
  });

  it('reports plugin warnings and retains dependency messages', async () => {
    const log = vi.fn();
    const dependency = { type: 'dependency', plugin: 'warning', file: input };
    const plugin: Plugin = {
      postcssPlugin: 'warning',
      Once(root, { result }) {
        root.warn(result, 'example warning');
        result.messages.push(dependency);
      },
    };
    const result = await buildStyles({ input, output, plugins: [plugin], log });
    expect(log).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('example warning'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining(input));
    expect(result.messages).toContainEqual(dependency);
    expect(fs.readFileSync(output, 'utf8')).toBe(result.css);
  });

  it('rejects invalid CSS without replacing existing output', async () => {
    fs.mkdirSync(path.dirname(output));
    fs.writeFileSync(output, 'previous build');
    fs.writeFileSync(input, '.broken {');
    await expect(buildStyles({ input, output, plugins: [parse] })).rejects.toThrow(
      'Unclosed block'
    );
    expect(fs.readFileSync(output, 'utf8')).toBe('previous build');
  });

  it('propagates plugin failures without writing output', async () => {
    const failure = new Error('plugin failed');
    const plugin: Plugin = {
      postcssPlugin: 'failure',
      Once() {
        throw failure;
      },
    };
    await expect(buildStyles({ input, output, plugins: [plugin] })).rejects.toBe(failure);
    expect(fs.existsSync(output)).toBe(false);
  });

  it('propagates missing-input errors', async () => {
    fs.unlinkSync(input);
    await expect(buildStyles({ input, output, plugins: [parse] })).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(fs.existsSync(output)).toBe(false);
  });

  it('propagates output-write errors', async () => {
    fs.mkdirSync(output, { recursive: true });
    await expect(buildStyles({ input, output, plugins: [parse] })).rejects.toMatchObject({
      code: 'EISDIR',
    });
  });
});
