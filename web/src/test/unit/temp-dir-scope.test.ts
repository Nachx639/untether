import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '../..');

const TEMP_DIR_CALLS = new Set(['mkdtemp', 'mkdtempSync', 'markedTempDir']);
const SUITE_CALLS = new Set(['describe', 'suite']);
/** Opt-out, on the line before the call, for the rare dir that has no hook to live in. */
const ALLOW_MARK = 'temp-dir-scope:';

function testFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') testFiles(full, out);
    } else if (
      entry.name.endsWith('.ts') &&
      (entry.name.endsWith('.test.ts') || full.includes(`${path.sep}test${path.sep}`))
    ) {
      out.push(full);
    }
  }
  return out;
}

/** The identifier a call chain starts at: `describe` in `describe.skip.each(rows)(…)`. */
function rootIdentifier(node: ts.Expression): string | undefined {
  let current = node;
  for (;;) {
    if (ts.isIdentifier(current)) return current.text;
    if (ts.isPropertyAccessExpression(current) || ts.isCallExpression(current)) {
      current = current.expression;
    } else return undefined;
  }
}

function isSuiteCallback(fn: ts.Node): boolean {
  const call = fn.parent;
  if (!call || !ts.isCallExpression(call) || !call.arguments.includes(fn as ts.Expression)) {
    return false;
  }
  const root = rootIdentifier(call.expression);
  return root !== undefined && SUITE_CALLS.has(root);
}

/**
 * The mkdtemp/mkdtempSync/markedTempDir calls (bare or as `x.mkdtemp…`) that run at module scope
 * or directly in a describe callback, as `line: call`. Those run at collection time: a filtered
 * run (`-t`, related runs, a skipped describe) or a run cut short creates the dir and never runs
 * the afterAll that removes it (2026-11-04, /tmp/ut-cast-* and ut-size-* left by
 * shielded-tmux.test.ts). Create the dir in beforeAll/beforeEach/a test and remove it in the
 * matching hook.
 */
function collectionTimeTempDirs(source: string, fileName = 'file.ts'): string[] {
  if (!/mkdtemp|markedTempDir/.test(source)) return [];
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lines = source.split('\n');
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : undefined;
      if (name && TEMP_DIR_CALLS.has(name)) {
        let enclosing: ts.Node | undefined = node.parent;
        while (enclosing && !ts.isFunctionLike(enclosing)) enclosing = enclosing.parent;
        if (!enclosing || isSuiteCallback(enclosing)) {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          if (lines[line - 1]?.includes(ALLOW_MARK)) return;
          found.push(`${line + 1}: ${node.getText(sf).replace(/\s+/g, ' ')}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

describe('temp dirs are created inside hooks or tests, never at collection time (2026-11-04)', () => {
  it('no test file creates a temp dir at module or describe scope', () => {
    const offenders: string[] = [];
    for (const file of testFiles(SRC)) {
      if (file.endsWith(`${path.sep}temp-dir-scope.test.ts`)) continue;
      for (const hit of collectionTimeTempDirs(fs.readFileSync(file, 'utf8'), file)) {
        offenders.push(`${path.relative(SRC, file)}:${hit}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('flags module scope and describe bodies, however the suite is spelled', () => {
    const source = [
      "const top = fs.mkdtempSync('/tmp/a-');", // 1
      "describe('x', () => {",
      "  const a = markedTempDir('/tmp/b-');", // 3
      "  const b = await fsp.mkdtemp('/tmp/c-');", // 4
      '});',
      "describe.skip('y', function () {",
      "  const c = fs.promises.mkdtemp('/tmp/d-');", // 7
      '});',
      "describe.each(rows)('z', (row) => {",
      "  const d = mkdtempSync('/tmp/e-');", // 10
      '});',
      "describe('outer', () => {",
      "  describe('inner', () => {",
      "    const e = mkdtempSync('/tmp/f-');", // 14
      '  });',
      '});',
    ].join('\n');
    expect(collectionTimeTempDirs(source).map((hit) => hit.split(':')[0])).toEqual([
      '1',
      '3',
      '4',
      '7',
      '10',
      '14',
    ]);
  });

  it('accepts hooks, tests and helpers', () => {
    const source = [
      'let dir: string;',
      "beforeAll(() => { dir = markedTempDir('/tmp/a-'); });",
      "beforeEach(async () => { dir = await fsp.mkdtemp('/tmp/b-'); });",
      "describe('x', () => {",
      "  it('t', () => { const d = fs.mkdtempSync('/tmp/c-'); });",
      "  test('u', async () => { const d = mkdtempSync('/tmp/d-'); });",
      "  const make = () => markedTempDir('/tmp/e-');",
      '});',
      "function helper() { return fs.mkdtempSync('/tmp/f-'); }",
      "// fs.mkdtempSync('/tmp/comment-')",
      'const s = "mkdtempSync(\'/tmp/string-\')";',
    ].join('\n');
    expect(collectionTimeTempDirs(source)).toEqual([]);
  });

  it('lets a marked call through, only that one', () => {
    const source = [
      '// temp-dir-scope: no hook exists here',
      "const a = fs.mkdtempSync('/tmp/a-');",
      "const b = fs.mkdtempSync('/tmp/b-');", // 3
    ].join('\n');
    expect(collectionTimeTempDirs(source).map((hit) => hit.split(':')[0])).toEqual(['3']);
  });
});
