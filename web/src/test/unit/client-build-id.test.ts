import { createRequire } from 'node:module';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import postcss from 'postcss';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildIdInBundle, buildIdInCss } from '../../shared/shell-version';
import { RM_TEST_DIR } from '../helpers/rm-test-dir.js';

const require = createRequire(import.meta.url);
const { writeClientBuild, PLACEHOLDER_MARK } = require('../../../scripts/client-build-id.js');

let dir: string;
let idFile: string;
const file = (rel: string) => path.join(dir, rel);
const out = (rel: string, text: string) => ({ path: file(rel), contents: Buffer.from(text) });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-build-id-'));
  idFile = file('.build-id');
});

afterEach(() => {
  fs.rmSync(dir, RM_TEST_DIR);
});

describe('client build id', () => {
  it('stamps the entry over the placeholder, same length, and writes the id file last', () => {
    const entry = `import"./chunks/chunk-X.js";const m="${PLACEHOLDER_MARK}";`;
    const id = writeClientBuild(
      [
        out('client-bundle.js', entry),
        out('chunks/chunk-X.js', 'x'),
        out('client-bundle.js.map', '{}'),
      ],
      { idFile }
    );
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    const stamped = fs.readFileSync(file('client-bundle.js'), 'utf8');
    expect(buildIdInBundle(stamped)).toBe(id);
    expect(stamped.length).toBe(entry.length);
    expect(fs.readFileSync(idFile, 'utf8').trim()).toBe(id);
    expect(fs.readFileSync(file('chunks/chunk-X.js'), 'utf8')).toBe('x');
  });

  it('the same output gives the same id and touches no file', () => {
    const files = () => [out('client-bundle.js', `"${PLACEHOLDER_MARK}"`), out('chunks/c.js', 'c')];
    const id = writeClientBuild(files(), { idFile });
    const past = new Date('2020-01-01');
    for (const rel of ['client-bundle.js', 'chunks/c.js', '.build-id'])
      fs.utimesSync(file(rel), past, past);
    expect(writeClientBuild(files(), { idFile })).toBe(id);
    for (const rel of ['client-bundle.js', 'chunks/c.js', '.build-id']) {
      expect(fs.statSync(file(rel)).mtime.getTime()).toBe(past.getTime());
    }
    expect(
      writeClientBuild([out('client-bundle.js', `"${PLACEHOLDER_MARK}";2`)], { idFile })
    ).not.toBe(id);
  });

  it('refuses a build whose id would land in a chunk (its name would lie about its bytes)', () => {
    expect(() =>
      writeClientBuild(
        [
          out('client-bundle.js', `"${PLACEHOLDER_MARK}"`),
          out('chunks/c.js', `"${PLACEHOLDER_MARK}"`),
        ],
        { idFile }
      )
    ).toThrow(/only the entry/);
    expect(() => writeClientBuild([out('client-bundle.js', 'no mark')], { idFile })).toThrow(
      /no ut-build-id/
    );
    expect(fs.existsSync(file('client-bundle.js'))).toBe(false);
  });

  it('the stylesheet declares the id the bundle build wrote', async () => {
    const plugin = require('../../../scripts/postcss-build-id.js');
    const { BUILD_ID_FILE } = require('../../../scripts/client-build-id.js');
    const saved = fs.existsSync(BUILD_ID_FILE) ? fs.readFileSync(BUILD_ID_FILE, 'utf8') : null;
    try {
      fs.mkdirSync(path.dirname(BUILD_ID_FILE), { recursive: true });
      fs.writeFileSync(BUILD_ID_FILE, '0123456789abcdef\n');
      const result = await postcss([plugin()]).process('.a{color:red}', { from: 'styles.css' });
      expect(buildIdInCss(result.css)).toBe('0123456789abcdef');
      // postcss --watch rebuilds when the id changes.
      expect(result.messages).toContainEqual(
        expect.objectContaining({ type: 'dependency', file: BUILD_ID_FILE })
      );
    } finally {
      if (saved === null) fs.rmSync(BUILD_ID_FILE, { force: true });
      else fs.writeFileSync(BUILD_ID_FILE, saved);
    }
  });
});
