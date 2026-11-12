#!/usr/bin/env node

/**
 * Says whether web/node_modules already is what `pnpm install --frozen-lockfile` would leave,
 * so that the Mac app's build can skip the install (mac/scripts/build-web-frontend.sh).
 *
 * 2026-11-12: node-pty is a `file:` dependency, and pnpm puts such a package in place again on
 * EVERY install, without its build/ folder: each `pnpm install --frozen-lockfile` of the app's
 * build removed pty.node and spawn-helper from the tree the development server runs from ("no
 * new session can start" until something rebuilt them). An install that would change nothing
 * else is therefore not run.
 *
 * In sync means: the lockfile pnpm kept from its last install (node_modules/.pnpm/lock.yaml) is
 * the one in web/, package.json asks for what that lockfile says (what --frozen-lockfile
 * checks), and the node-pty in node_modules has the sources of web/node-pty.
 *
 * Usage: node scripts/deps-in-sync.js   (exit 0 in sync; 1 and the reason when not)
 */

const fs = require('fs');
const path = require('path');

/** What the lockfile says the project itself asks for: { section: { name: specifier } }. */
function lockfileSpecifiers(lockText) {
  const sections = {};
  let inProject = false;
  let section = null;
  let name = null;
  for (const line of lockText.split('\n')) {
    if (/^\S/.test(line)) {
      if (inProject) break;
      continue;
    }
    if (/^ {2}\S/.test(line)) {
      inProject = line.trim() === '.:';
      continue;
    }
    if (!inProject) continue;
    let match = line.match(/^ {4}(\w+):\s*$/);
    if (match) {
      section = match[1];
      sections[section] = {};
      continue;
    }
    match = line.match(/^ {6}(.+):\s*$/);
    if (match && section) {
      name = match[1].replace(/^['"]|['"]$/g, '');
      continue;
    }
    match = line.match(/^ {8}specifier:\s*(.+)$/);
    if (match && section && name) {
      sections[section][name] = match[1].trim().replace(/^['"]|['"]$/g, '');
    }
  }
  return sections;
}

/** Every file under `dir` (relative paths), without the folders that are not sources. */
function sourceFiles(dir, skip, prefix = '') {
  const found = [];
  for (const entry of fs.readdirSync(path.join(dir, prefix), { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    if (!prefix && skip.has(entry.name)) continue;
    if (entry.isDirectory()) found.push(...sourceFiles(dir, skip, relative));
    else found.push(relative);
  }
  return found;
}

/**
 * { inSync: true } or { inSync: false, why }.
 */
function depsInSync(webDir) {
  const read = (file) => {
    try {
      return fs.readFileSync(file);
    } catch {
      return null;
    }
  };
  const lock = read(path.join(webDir, 'pnpm-lock.yaml'));
  const installed = read(path.join(webDir, 'node_modules', '.pnpm', 'lock.yaml'));
  if (!lock) return { inSync: false, why: 'there is no pnpm-lock.yaml' };
  if (!installed) return { inSync: false, why: 'node_modules holds no install (no .pnpm/lock.yaml)' };
  if (!lock.equals(installed)) {
    return { inSync: false, why: 'pnpm-lock.yaml changed since the last install' };
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(webDir, 'package.json'), 'utf8'));
  } catch (error) {
    return { inSync: false, why: `package.json cannot be read: ${error.message}` };
  }
  const locked = lockfileSpecifiers(lock.toString('utf8'));
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const wanted = manifest[section] || {};
    const has = locked[section] || {};
    const names = new Set([...Object.keys(wanted), ...Object.keys(has)]);
    for (const name of names) {
      if (wanted[name] !== has[name]) {
        return {
          inSync: false,
          why: `package.json and pnpm-lock.yaml differ on ${name} (${section}): ${wanted[name] ?? 'absent'} vs ${has[name] ?? 'absent'}`,
        };
      }
    }
  }

  // The vendored node-pty: pnpm copies it at install; the copy must be the sources of today.
  const vendored = path.join(webDir, 'node-pty');
  const copy = path.join(webDir, 'node_modules', 'node-pty');
  if (fs.existsSync(vendored)) {
    if (!fs.existsSync(path.join(copy, 'package.json'))) {
      return { inSync: false, why: 'node-pty is not installed in node_modules' };
    }
    const skip = new Set(['build', 'node_modules', 'prebuilds', '.gitignore', 'pnpm-lock.yaml']);
    const there = new Set(sourceFiles(copy, skip));
    for (const file of sourceFiles(vendored, skip)) {
      const a = read(path.join(vendored, file));
      const b = read(path.join(copy, file));
      if (!a || !b || !a.equals(b)) {
        return { inSync: false, why: `node-pty/${file} is not the one installed in node_modules` };
      }
      there.delete(file);
    }
    if (there.size) {
      return {
        inSync: false,
        why: `node_modules/node-pty has ${[...there][0]}, which web/node-pty no longer has`,
      };
    }
  }
  return { inSync: true };
}

module.exports = { depsInSync, lockfileSpecifiers };

if (require.main === module) {
  const result = depsInSync(path.join(__dirname, '..'));
  if (result.inSync) {
    console.log('node_modules is what the lockfile asks for');
  } else {
    console.log(result.why);
    process.exit(1);
  }
}
