import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { RM_TEST_DIR } from '../helpers/rm-test-dir.js';

const SRC = path.resolve(__dirname, '../..');

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

/** Strips `( … )`, `as …`, `satisfies …` and `!` around an expression. */
function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function setsRecursiveTrue(arg: ts.Expression): boolean {
  const options = unwrap(arg);
  return (
    ts.isObjectLiteralExpression(options) &&
    options.properties.some(
      (prop) =>
        ts.isPropertyAssignment(prop) &&
        prop.name.getText() === 'recursive' &&
        unwrap(prop.initializer).kind === ts.SyntaxKind.TrueKeyword
    )
  );
}

/**
 * The rm/rmSync calls (bare or as `x.rm`/`x.rmSync`) that spell out `recursive: true` in an
 * inline options object instead of passing RM_TEST_DIR, as `line: call` (first line, 1-based).
 * Parsed with the TypeScript compiler, so a call whose options span several lines counts too:
 * the earlier line regex missed those (2026-11-02).
 */
function recursiveRmOffenders(source: string, fileName = 'file.ts'): string[] {
  if (!/\brm(?:Sync)?\b/.test(source)) return [];
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : undefined;
      if ((name === 'rm' || name === 'rmSync') && node.arguments.slice(1).some(setsRecursiveTrue)) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        found.push(`${line + 1}: ${node.getText(sf).replace(/\s+/g, ' ')}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

describe('RM_TEST_DIR (teardowns that race a still-writing service, 2026-11-02)', () => {
  it('every recursive rm/rmSync in test code uses RM_TEST_DIR', () => {
    // A bare { recursive: true } gives up on the first ENOTEMPTY: a timer's write landing in the
    // dir mid-removal failed push-notification-service.test.ts under load.
    const offenders: string[] = [];
    for (const file of testFiles(SRC)) {
      if (file.endsWith(`${path.sep}rm-test-dir.test.ts`)) continue;
      for (const hit of recursiveRmOffenders(fs.readFileSync(file, 'utf8'), file)) {
        offenders.push(`${path.relative(SRC, file)}:${hit}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('flags recursive options on one line or spread over several', () => {
    const source = [
      'fs.rmSync(dir, { recursive: true, force: true });', // 1
      'await fs.promises.rm(path.join(a, b), {', // 2
      '  recursive: true,',
      '  force: true,',
      '});',
      'rmSync(', // 6
      '  dir,',
      '  {',
      '    force: true,',
      '    recursive: true,',
      '  }',
      ');',
      'fsp.rm(dir, ({ recursive: true } as const));', // 13
    ].join('\n');
    expect(recursiveRmOffenders(source).map((hit) => hit.split(':')[0])).toEqual([
      '1',
      '2',
      '6',
      '13',
    ]);
  });

  it('accepts RM_TEST_DIR, non-recursive removals and look-alikes, on one line or several', () => {
    const source = [
      'fs.rmSync(dir, RM_TEST_DIR);',
      'fs.rmSync(',
      '  path.join(a, b),',
      '  RM_TEST_DIR',
      ');',
      'await fs.promises.rm(file, {',
      '  force: true,',
      '});',
      'fs.rmSync(dir, {',
      '  recursive: false,',
      '});',
      'fs.rmdirSync(dir, {',
      '  recursive: true,',
      '});',
      'const opts = { recursive: true };',
      '// fs.rmSync(dir, { recursive: true }) in a comment',
      "const s = 'rmSync(dir, { recursive: true })';",
    ].join('\n');
    expect(recursiveRmOffenders(source)).toEqual([]);
  });

  it('removes a dir that gains a file while being removed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-rm-test-dir-'));
    for (let i = 0; i < 200; i++) fs.writeFileSync(path.join(dir, `f${i}`), 'x');
    // A writer racing the removal, as a service's timer does in a teardown.
    let writes = 0;
    const writer = setInterval(() => {
      try {
        fs.writeFileSync(path.join(dir, `late${writes++}`), 'x');
      } catch {
        // dir already gone
      }
    }, 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    try {
      fs.rmSync(dir, RM_TEST_DIR);
    } finally {
      clearInterval(writer);
    }
    expect(fs.existsSync(dir)).toBe(false);
  });
});
