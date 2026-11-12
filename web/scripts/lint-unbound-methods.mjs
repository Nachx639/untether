#!/usr/bin/env node
/**
 * No method is taken off its object (2026-11-11). `const waiting = this.deps.messages?.waiting;
 * … waiting(id, why)` calls the method with no `this`: "Cannot read properties of undefined
 * (reading 'messages')", an uncaught exception in a timer that stopped the server at least
 * eight times in 16 hours. No test saw it because the test doubles were loose functions.
 *
 * The rule (typescript-eslint's unbound-method) is in neither biome nor oxlint as installed
 * (oxlint's needs the oxlint-tsgolint package), so it is checked here with the TypeScript
 * compiler: a member that is a METHOD (a class's, an object literal's or an interface's
 * `name(): …`) may be called, tested for being there, assigned to or bound; anything else
 * (kept in a variable, destructured, passed as a value) fails. What is meant to be passed
 * around is declared as a function property (`name: () => …`, an arrow function field) or
 * with `this: void`, and what is taken from an object is wrapped: `(x) => object.method(x)`.
 *
 *   node scripts/lint-unbound-methods.mjs [tsconfig ...]   (default: tsconfig.server.json)
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A declaration whose `this` is the object it is called on. */
function needsThis(declaration) {
  if (!ts.isMethodDeclaration(declaration) && !ts.isMethodSignature(declaration)) return false;
  const first = declaration.parameters[0];
  // `method(this: void, …)` says it uses none.
  if (
    first &&
    ts.isIdentifier(first.name) &&
    first.name.text === 'this' &&
    first.type?.kind === ts.SyntaxKind.VoidKeyword
  ) {
    return false;
  }
  return true;
}

function isMethod(symbol, program) {
  const declarations = symbol?.declarations ?? [];
  if (!declarations.length) return false;
  return declarations.some((declaration) => {
    if (!needsThis(declaration)) return false;
    const file = declaration.getSourceFile();
    // The language's and the libraries' own (console.log, Array.prototype.push, …) are not
    // this project's to declare: only its own methods are looked at.
    return !program.isSourceFileDefaultLibrary(file) && !program.isSourceFileFromExternalLibrary(file);
  });
}

const COMPARISONS = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.InstanceOfKeyword,
]);

/** Only its truth is looked at: `!x`, `if (x)`, `x ? … : …`, and `&&`/`||` inside those. */
function isOnlyTested(node) {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isParenthesizedExpression(parent)) return isOnlyTested(parent);
  if (ts.isPrefixUnaryExpression(parent)) return parent.operator === ts.SyntaxKind.ExclamationToken;
  if (ts.isIfStatement(parent) || ts.isWhileStatement(parent) || ts.isDoStatement(parent)) {
    return parent.expression === node;
  }
  if (ts.isConditionalExpression(parent)) return parent.condition === node;
  if (ts.isBinaryExpression(parent)) {
    const operator = parent.operatorToken.kind;
    if (
      operator === ts.SyntaxKind.AmpersandAmpersandToken ||
      operator === ts.SyntaxKind.BarBarToken
    ) {
      return isOnlyTested(parent);
    }
  }
  return false;
}

/** Uses that never call the method without its object. */
function isSafeUse(node) {
  let child = node;
  let parent = node.parent;
  while (
    parent &&
    (ts.isParenthesizedExpression(parent) ||
      ts.isNonNullExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isSatisfiesExpression(parent))
  ) {
    child = parent;
    parent = parent.parent;
  }
  if (!parent) return true;
  // object.method(…), object.method`…`
  if (ts.isCallExpression(parent) && parent.expression === child) return true;
  if (ts.isTaggedTemplateExpression(parent) && parent.tag === child) return true;
  // object.method.bind(object), .call, .apply, .name, .length
  if (ts.isPropertyAccessExpression(parent) && parent.expression === child) return true;
  // Is it there? typeof, !, if (…), … ? :, ===
  if (ts.isTypeOfExpression(parent) || ts.isDeleteExpression(parent)) return true;
  if (isOnlyTested(child)) return true;
  if (ts.isBinaryExpression(parent)) {
    const operator = parent.operatorToken.kind;
    if (COMPARISONS.has(operator)) return true;
    // object.method = …
    if (operator === ts.SyntaxKind.EqualsToken && parent.left === child) return true;
    // `object.method && …`: the left side is only tested (its value is not what comes out
    // of `&&`; out of `||` and `??` it is, so those are a use).
    if (operator === ts.SyntaxKind.AmpersandAmpersandToken && parent.left === child) return true;
  }
  return false;
}

/**
 * Every place in the program's own files (not declaration files) where a method is taken
 * off its object: [{ file, line, column, text }].
 */
export function findUnboundMethods(program) {
  const checker = program.getTypeChecker();
  const found = [];
  const report = (node, name) => {
    const file = node.getSourceFile();
    const { line, character } = file.getLineAndCharacterOfPosition(node.getStart());
    found.push({ file: file.fileName, line: line + 1, column: character + 1, text: name });
  };
  const visit = (node) => {
    if (ts.isPropertyAccessExpression(node)) {
      if (isMethod(checker.getSymbolAtLocation(node.name), program) && !isSafeUse(node)) {
        report(node, node.getText());
      }
    } else if (ts.isObjectBindingPattern(node)) {
      // const { method } = object
      const type = checker.getTypeAtLocation(node);
      for (const element of node.elements) {
        if (element.dotDotDotToken) continue;
        const key = element.propertyName ?? element.name;
        if (!ts.isIdentifier(key) && !ts.isStringLiteral(key)) continue;
        const property = checker.getApparentType(type).getProperty(key.text);
        if (isMethod(property, program)) report(element, `{ ${element.getText()} }`);
      }
    }
    ts.forEachChild(node, visit);
  };
  for (const file of program.getSourceFiles()) {
    if (file.isDeclarationFile) continue;
    if (program.isSourceFileFromExternalLibrary(file)) continue;
    visit(file);
  }
  return found;
}

export function programOf(tsconfig) {
  const read = ts.readConfigFile(tsconfig, ts.sys.readFile);
  if (read.error) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(tsconfig));
  return ts.createProgram({
    rootNames: parsed.fileNames,
    options: { ...parsed.options, noEmit: true, incremental: false, composite: false },
  });
}

function main(args) {
  const configs = args.length ? args : ['tsconfig.server.json'];
  const seen = new Set();
  let count = 0;
  for (const config of configs) {
    for (const hit of findUnboundMethods(programOf(path.resolve(WEB, config)))) {
      const where = `${path.relative(WEB, hit.file)}:${hit.line}:${hit.column}`;
      if (seen.has(where)) continue;
      seen.add(where);
      count++;
      console.error(`${where}  ${hit.text}`);
    }
  }
  if (count) {
    console.error(
      `\n${count} method${count === 1 ? '' : 's'} taken off ${count === 1 ? 'its' : 'their'} object: called later, \`this\` is undefined. ` +
        'Call it on the object (`(x) => object.method(x)`), or declare it as a function property if it uses no `this`.'
    );
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
