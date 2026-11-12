import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
// @ts-expect-error a plain script (scripts/lint-typeaware.sh runs it on the whole server)
import { findUnboundMethods } from '../../../scripts/lint-unbound-methods.mjs';

const FILE = path.resolve(__dirname, 'unbound-fixture.ts');

/** The methods taken off their object in `source`, as the text of each place. */
function taken(source: string): string[] {
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    lib: ['lib.es2022.d.ts'],
    types: [],
  };
  const host = ts.createCompilerHost(options);
  const real = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion) =>
    name === FILE
      ? ts.createSourceFile(name, source, languageVersion, true)
      : real(name, languageVersion);
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (name) => name === FILE || fileExists(name);
  const program = ts.createProgram({ rootNames: [FILE], options, host });
  const errors = ts
    .getPreEmitDiagnostics(program)
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
  expect(errors).toEqual([]);
  return (findUnboundMethods(program) as Array<{ text: string }>).map((hit) => hit.text);
}

const LEDGER = `
  class Ledger {
    private messages = new Map<string, string>();
    waiting(id: string, why: string): void { this.messages.set(id, why); }
    plain(this: void, id: string): string { return id; }
    arrow = (id: string): string => this.messages.get(id) ?? '';
  }
  interface Deps { messages?: { waiting?(id: string, why: string): void }; log?: (text: string) => void }
`;

describe('no method is taken off its object (2026-11-11)', () => {
  it("fails on the incident's own lines: a class's method kept in a variable and called bare", () => {
    expect(
      taken(`${LEDGER}
        class Orchestrator {
          constructor(private readonly deps: { messages?: Ledger }) {}
          noteWaiting(id: string): void {
            const waiting = this.deps.messages?.waiting;
            if (!waiting) return;
            waiting(id, 'busy');
          }
        }
        new Orchestrator({}).noteWaiting('m1');`)
    ).toEqual(['this.deps.messages?.waiting']);
  });

  it('fails on an interface method, a destructured one, one passed as a value and one behind ??', () => {
    expect(
      taken(`${LEDGER}
        declare const deps: Deps;
        declare const ledger: Ledger;
        const viaInterface = deps.messages?.waiting;
        const { waiting } = ledger;
        const { waiting: renamed } = ledger;
        ['a'].forEach(ledger.plain);
        const later: Array<(id: string, why: string) => void> = [ledger.waiting];
        const either = deps.messages?.waiting ?? ledger.waiting;
        export { viaInterface, waiting, renamed, later, either };`)
    ).toEqual([
      'deps.messages?.waiting',
      '{ waiting }',
      '{ waiting: renamed }',
      'ledger.waiting',
      'deps.messages?.waiting',
      'ledger.waiting',
    ]);
  });

  it('lets a method be called, tested, bound, wrapped or assigned, and function properties go anywhere', () => {
    expect(
      taken(`${LEDGER}
        declare const deps: Deps;
        declare const ledger: Ledger;
        ledger.waiting('m1', 'busy');
        deps.messages?.waiting?.('m1', 'busy');
        if (!deps.messages?.waiting) throw new Error('none');
        declare const other: Deps;
        const there = typeof ledger.waiting === 'function' && other.messages?.waiting !== undefined;
        const wrapped = other.messages?.waiting && there ? (id: string) => ledger.waiting(id, 'busy') : undefined;
        const bound = ledger.waiting.bind(ledger);
        const noThis = ledger.plain;
        const field = ledger.arrow;
        const log = deps.log;
        const push = [1].push;
        ledger.waiting = () => {};
        export { wrapped, bound, noThis, field, log, push };`)
    ).toEqual([]);
  });
});
