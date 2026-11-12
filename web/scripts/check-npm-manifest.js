#!/usr/bin/env node
// package.npm.json is the manifest that gets published; its dependency versions must be the ones
// package.json (and the lockfile) carry. build-npm.js refuses a drifted manifest, but only at its
// step 6, after the whole build; this is the same comparison, run by `pnpm run check`.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (name) => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const source = read('package.json');
const published = read('package.npm.json');

const drift = [];
for (const [name, version] of Object.entries(published.dependencies || {})) {
  const expected = (source.dependencies || {})[name];
  if (expected && expected !== version) drift.push(`${name}: ${version}, package.json has ${expected}`);
}
for (const [name, version] of Object.entries(published.optionalDependencies || {})) {
  const expected = (source.optionalDependencies || {})[name];
  if (expected !== version) {
    drift.push(`${name} (optional): ${version}, package.json has ${expected ?? 'nothing'}`);
  }
}
if (published.version !== source.version) {
  drift.push(`version: ${published.version}, package.json has ${source.version}`);
}

if (drift.length > 0) {
  console.error('package.npm.json differs from package.json:');
  for (const line of drift) console.error(`  ${line}`);
  process.exit(1);
}
