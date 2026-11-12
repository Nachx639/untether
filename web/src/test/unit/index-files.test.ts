import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '../..');

/**
 * 2026-11-11: over 14 days task-cli.ts, shared/tasks.ts, task-merge.ts, task-commands.ts,
 * types/config.ts and doctor-checks.ts took 21 of the 43 merges with conflicts between tasks:
 * every task that added a command, a field, a setting or a check edited the same file. They
 * are lists of parts now. Logic written in a list again, or a part no list names (never
 * registered, never exported), fails here: the change belongs in the part's own file.
 */
const INDEXES: Record<string, { parts?: { dir: string; match: RegExp }; why: string }> = {
  'shared/tasks.ts': {
    parts: { dir: 'shared/tasks', match: /\.ts$/ },
    why: 'a type, a limit or a TaskRecord field goes in its area under shared/tasks/',
  },
  'shared/tasks/record.ts': {
    why: 'a TaskRecord field goes in its area (shared/tasks/queue.ts, merge.ts, ...)',
  },
  'types/config.ts': {
    parts: { dir: 'types/config', match: /\.ts$/ },
    why: 'a setting, its type or its default goes in its area under types/config/',
  },
  'types/config/untether-config.ts': {
    why: 'a setting goes in its area (types/config/tasks.ts, sessions.ts, ...)',
  },
  'server/task-cli.ts': {
    parts: { dir: 'server/task-cli', match: /^(task|project)-.*\.ts$/ },
    why: 'a command, its options and its help go in its family under server/task-cli/',
  },
  'server/services/task-commands.ts': {
    parts: {
      dir: 'server/services',
      match: /^task-commands-(?!core|shared|types).*(?<!\.test)\.ts$/,
    },
    why: 'an op and its schema go in its family (server/services/task-commands-*.ts)',
  },
  'server/services/task-merge.ts': {
    why: 'a step of the merge pipeline goes in its file (server/services/task-merge-*.ts)',
  },
  'server/services/doctor-checks.ts': {
    why: "a check goes in its area's file (server/services/doctor-checks-*.ts)",
  },
};

const isNames = (node: ts.Expression): boolean =>
  ts.isIdentifier(node) || (ts.isArrayLiteralExpression(node) && node.elements.every(isNames));

/** `register(a, [b, c])`: a call that only names things. */
const isRegistration = (node: ts.Expression | undefined): boolean =>
  !!node &&
  ts.isCallExpression(node) &&
  (ts.isIdentifier(node.expression) || node.expression.kind === ts.SyntaxKind.SuperKeyword) &&
  node.arguments.every(isNames);

/** What a file that only lists its parts may hold. */
function onlyLists(statement: ts.Statement): boolean {
  if (ts.isImportDeclaration(statement)) return true;
  if (ts.isExportDeclaration(statement)) return !!statement.moduleSpecifier;
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.every((d) => isRegistration(d.initializer));
  }
  // `interface TaskRecord extends TaskCoreFields, TaskQueueFields {}`.
  if (ts.isInterfaceDeclaration(statement)) {
    return !!statement.heritageClauses?.length && statement.members.length === 0;
  }
  // `class TaskCommands extends TaskCommandsCore { constructor(deps) { super(deps, [...]); } }`.
  if (ts.isClassDeclaration(statement)) {
    if (!statement.heritageClauses?.length || statement.members.length !== 1) return false;
    const [only] = statement.members;
    if (!ts.isConstructorDeclaration(only) || only.body?.statements.length !== 1) return false;
    const [call] = only.body.statements;
    return ts.isExpressionStatement(call) && isRegistration(call.expression);
  }
  return false;
}

function parse(file: string): ts.SourceFile {
  const full = path.join(SRC, file);
  return ts.createSourceFile(full, fs.readFileSync(full, 'utf8'), ts.ScriptTarget.Latest, true);
}

/** Logic in a list: each statement that is neither an import, a re-export nor a registration. */
function logicIn(source: ts.SourceFile): string[] {
  return source.statements
    .filter((statement) => !onlyLists(statement))
    .map((statement) => {
      const line = source.getLineAndCharacterOfPosition(statement.getStart()).line + 1;
      return `${line}: ${statement.getText().split('\n')[0]}`;
    });
}

describe('the files that only list their parts', () => {
  for (const [file, { parts, why }] of Object.entries(INDEXES)) {
    it(`${file} holds imports, re-exports and registrations only (${why})`, () => {
      expect(logicIn(parse(file))).toEqual([]);
    });
    if (!parts) continue;
    it(`${file} names every part of ${parts.dir}/`, () => {
      const named = new Set(
        parse(file)
          .statements.map((statement) =>
            (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
            statement.moduleSpecifier &&
            ts.isStringLiteral(statement.moduleSpecifier)
              ? statement.moduleSpecifier.text
              : undefined
          )
          .filter((target): target is string => !!target)
          .map((target) =>
            path.relative(
              path.join(SRC, parts.dir),
              path.join(SRC, file, '..', target.replace(/\.js$/, '.ts'))
            )
          )
      );
      const present = fs
        .readdirSync(path.join(SRC, parts.dir))
        .filter((name) => parts.match.test(name) && !name.endsWith('.test.ts'));
      expect(present.length).toBeGreaterThan(0);
      expect(present.filter((name) => !named.has(name))).toEqual([]);
    });
  }

  it('tells logic from a list', () => {
    const logic = (text: string) =>
      logicIn(ts.createSourceFile('x.ts', text, ts.ScriptTarget.Latest, true));
    expect(logic("import { a } from './a.js';\nexport * from './b.js';")).toEqual([]);
    expect(logic('export const { run } = create([a, b]);')).toEqual([]);
    expect(logic('export interface R extends A, B {}')).toEqual([]);
    expect(logic('export class C extends Core { constructor(d: D) { super(d, [a]); } }')).toEqual(
      []
    );
    expect(logic('export const MAX = 3;')).toEqual(['1: export const MAX = 3;']);
    expect(logic('export function f() {}')).toEqual(['1: export function f() {}']);
    expect(logic('export interface R extends A { extra?: string }')).toHaveLength(1);
    expect(logic('export const x = create([a], { flag: true });')).toHaveLength(1);
    expect(
      logic('export class C extends Core { constructor() { super([a]); } run() {} }')
    ).toHaveLength(1);
  });
});
