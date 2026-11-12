#!/usr/bin/env node
// @ts-check
/**
 * The personal-trace guard, as a module with no dependencies: the test of the working repository
 * (web/src/test/unit/personal-trace-guard.test.ts) and the public exporter
 * (scripts/public-export.sh, on a copy with nothing installed) read the same rules.
 *
 * The repository is meant to be public (2026-11-11). Until then its comments quoted the person
 * who asked for each change by name, and its examples and tests used that person's own projects,
 * assistants and home folder as data. No tracked text file or file name carries any of that
 * again:
 *
 *   - a vetoed proper name (a person, their projects, their assistants), as a whole word or a
 *     camelCase piece, whatever the case;
 *   - a home folder (/Users/<name>, /home/<name>) that is not one of the generic markers below;
 *   - a tailnet (<name>.ts.net) that is not one of the made-up ones below;
 *   - an e-mail address that is not an example or a no-reply one.
 *
 * The vetoed names are not written here, or the guard itself would publish them: VETOED holds a
 * hash of each (lower case). To veto another name, add what this prints:
 *
 *   node -e 'console.log(require("crypto").createHash("sha256").update("untether-trace:" + process.argv[1].toLowerCase()).digest("hex").slice(0, 16))' <name>
 *
 * Examples use the neutral names instead: the projects «bakery», «atlas», «toolshed», «inkwell»
 * and «skylark», the person «Alex», the agent «Otter», the home /Users/alex or /Users/me.
 *
 * As a command: `node scripts/personal-trace.mjs <folder>` reads every file git tracks in that
 * folder, prints each trace with its place and exits 1 if there is any.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const VETOED = new Set([
  '21a64cba9bb677fd',
  '3bf058e039311774',
  '19599aeb3a92c8ab',
  '995963c2749cbc01',
  'c7d35b7d48179edb',
  '49e0ffec8ae264e8',
  '205568a02cb968b4',
  '0d51c6d3115978d1',
  '3bbbb4e3707d85c4',
  'baba3254003bfbe3',
]);

/** Home folders nobody owns: placeholders of docs and tests, and CI's own. */
const GENERIC_HOMES = new Set([
  ...'me n u x you user username user1 user2 user123 user_name'.split(' '),
  ...'test tester testuser test_user dev developer example admin owner'.split(' '),
  ...'alex alice alice-smith bob jane john john.doe someone something'.split(' '),
  ...'another remote twin demouser runner user.com'.split(' '),
  // One long name, and where a narrow screen cut it (the tests of wrapped permission dialogs).
  ...'alexandrapublicdemouser alexandr alexand apublicdemouser'.split(' '),
  // Not a home: path-utils' tests of "Users" and "home" in the middle of a path.
  ...'path file Library .untether'.split(' '),
]);

/** Tailnets nobody owns. */
const EXAMPLE_TAILNETS = new Set([
  ...'tailnet tailnet-name tail tail1234 tail-scale example unknown'.split(' '),
  ...'mac machine linux darwin iphone recent old'.split(' '),
]);

const EXAMPLE_MAIL = [
  /@(?:[a-z0-9-]+\.)*example\.(?:com|org|net)$/i,
  /\.(?:invalid|local|localdomain|test)$/i,
  /^(?:no-?reply|git)@/i,
  /@users\.noreply\.github\.com$/i,
];

/**
 * Other people's addresses that belong where they are, by file.
 * @type {{ file: string; match: RegExp; why: string }[]}
 */
export const ALLOWED_MAIL = [
  {
    file: 'web/node-pty/src/unix/pty.cc',
    match: /^(?:nicm@users\.sourceforge\.net|josh@elsasser\.org|toc@daybefore\.net)$/,
    why: 'copyright notice of the code node-pty took from tmux',
  },
];

/** @param {string} word */
const hashOf = (word) =>
  createHash('sha256').update(`untether-trace:${word.toLowerCase()}`).digest('hex').slice(0, 16);

/**
 * Runs of letters already read, and the vetoed words each one holds (most hold none).
 * @type {Map<string, string[]>}
 */
const seenRuns = new Map();

/**
 * The vetoed words of a text, by hash: each run of letters whole, and its camelCase pieces.
 * @param {string} text
 * @returns {Set<string>}
 */
function vetoedIn(text) {
  /** @type {Set<string>} */
  const hits = new Set();
  for (const run of text.match(/[A-Za-zÀ-ɏ]+/g) ?? []) {
    let found = seenRuns.get(run);
    if (!found) {
      const pieces = run.match(/[A-ZÀ-Þ]?[a-zß-ÿ]+|[A-Z]+(?![a-z])/g) ?? [];
      found = [...new Set([run, ...pieces].map(hashOf))].filter((hash) => VETOED.has(hash));
      seenRuns.set(run, found);
    }
    for (const hash of found) hits.add(hash);
  }
  return hits;
}

const HOME = /\/(?:Users|home)\/([A-Za-z0-9._-]+)/g;
// The label is read backwards from each ".ts.net": a pattern starting with the label would
// try every position of every long run of letters (8 s over the repository).
const TAILNET_END = /\.ts\.net\b/g;
const LABEL_BEFORE = /[A-Za-z0-9-]+$/;
// A package@version or an image@2x is no address: its "domain" starts with a digit.
const MAIL =
  /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@(?![0-9])[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

/**
 * What a text gives away, each as `kind: what` (a vetoed name as its hash, never in clear).
 * @param {string} text
 * @param {string} [file] the path of the file the text comes from, for ALLOWED_MAIL
 * @returns {string[]}
 */
export function tracesIn(text, file = '') {
  /** @type {string[]} */
  const found = [];
  for (const hash of vetoedIn(text)) found.push(`name: a vetoed name (hash ${hash})`);
  for (const [, name] of text.matchAll(HOME)) {
    const home = name.replace(/\.+$/, '');
    if (!GENERIC_HOMES.has(home)) found.push(`home: ${home}`);
  }
  for (const end of text.matchAll(TAILNET_END)) {
    const before = text.slice(Math.max(0, end.index - 63), end.index);
    const tailnet = before.match(LABEL_BEFORE)?.[0];
    if (tailnet && !EXAMPLE_TAILNETS.has(tailnet.toLowerCase())) {
      found.push(`tailnet: ${tailnet}.ts.net`);
    }
  }
  for (const [mail] of text.matchAll(MAIL)) {
    if (EXAMPLE_MAIL.some((example) => example.test(mail))) continue;
    if (ALLOWED_MAIL.some((entry) => entry.file === file && entry.match.test(mail))) continue;
    found.push(`mail: ${mail}`);
  }
  return found;
}

/**
 * The files git tracks in a folder (its index: a file added and not yet committed counts).
 * @param {string} root
 * @returns {string[]}
 */
export function trackedFiles(root) {
  return execFileSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\0')
    .filter(Boolean);
}

/**
 * Every trace in the tracked files of a folder, names and contents, each with its place; and the
 * ALLOWED_MAIL entries that excused nothing (the list can only shrink).
 * @param {string} root
 * @returns {{ stray: string[]; unusedMail: string[] }}
 */
export function tracesInTree(root) {
  /** @type {string[]} */
  const stray = [];
  const usedMail = new Set();
  for (const file of trackedFiles(root)) {
    for (const trace of tracesIn(file)) stray.push(`${file} (its name): ${trace}`);
    let content;
    try {
      content = fs.readFileSync(path.join(root, file));
    } catch {
      continue; // Deleted in the working tree, or a link to nowhere.
    }
    if (content.subarray(0, 8000).includes(0)) continue; // Binary, as git reads it.
    const text = content.toString('utf8');
    for (const entry of ALLOWED_MAIL) {
      if (entry.file !== file) continue;
      if ((text.match(MAIL) ?? []).some((mail) => entry.match.test(mail))) usedMail.add(entry);
    }
    if (tracesIn(text, file).length === 0) continue;
    // Only now line by line, to say where.
    text.split('\n').forEach((line, index) => {
      for (const trace of tracesIn(line, file)) stray.push(`${file}:${index + 1}: ${trace}`);
    });
  }
  return {
    stray,
    unusedMail: ALLOWED_MAIL.filter((entry) => !usedMail.has(entry)).map((entry) => entry.file),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.argv[2];
  if (!root) {
    console.error('usage: node scripts/personal-trace.mjs <folder with a git repository>');
    process.exit(2);
  }
  const { stray } = tracesInTree(path.resolve(root));
  for (const line of stray) console.log(line);
  if (stray.length > 0) {
    console.error(`personal traces: ${stray.length}`);
    process.exit(1);
  }
}
