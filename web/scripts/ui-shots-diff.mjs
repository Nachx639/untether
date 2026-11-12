#!/usr/bin/env node
// Compares two folders of ui-shots.mjs screenshots, file by file, and says which views changed.
//
//   node web/scripts/ui-shots-diff.mjs <before> <after> [--out <dir>] [--channel-delta 3] [--max-pixels 12]
//
// A pixel counts only when a channel moved more than --channel-delta (of 255): font antialiasing
// wobbles by a few steps. A view fails when more than --max-pixels counted pixels differ: WebKit
// re-rasterizes a few pixels of a logo between frames (2026-11-09). A file on one side only, or a
// different size, always fails. Exit 0: every view matches; 1: something changed; 2: bad usage.
// For each view that fails, <out>/<name> shows the after picture dimmed with the changes in red.
import fs from 'node:fs';
import path from 'node:path';
import { encodePng, pngPixels } from './png-pixels.mjs';

function usage(message) {
  console.error(`ui-shots-diff: ${message}`);
  console.error('usage: ui-shots-diff.mjs <before> <after> [--out <dir>] [--channel-delta n] [--max-pixels n]');
  process.exit(2);
}

function parseArgs(argv) {
  const options = { dirs: [], channelDelta: 3, maxPixels: 12 };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (!flag.startsWith('--')) {
      options.dirs.push(path.resolve(flag));
      continue;
    }
    const value = argv[++index];
    if (value === undefined) usage(`${flag} needs a value`);
    if (flag === '--out') options.out = path.resolve(value);
    else if (flag === '--channel-delta' || flag === '--max-pixels') {
      const number = Number(value);
      if (!Number.isInteger(number) || number < 0) usage(`${flag} takes a whole number`);
      options[flag === '--max-pixels' ? 'maxPixels' : 'channelDelta'] = number;
    } else usage(`unknown option ${flag}`);
  }
  if (options.dirs.length !== 2) usage('it takes two folders');
  for (const dir of options.dirs) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) usage(`not a folder: ${dir}`);
  }
  return options;
}

/** The screenshots of a folder: a failed or unsettled view's debug pictures are not one. */
const shots = (dir) =>
  fs.readdirSync(dir).filter((name) => name.endsWith('.png') && !/-(FAILED|UNSETTLED-[AB])\.png$/.test(name));

function compare(beforeFile, afterFile, channelDelta) {
  const before = pngPixels(fs.readFileSync(beforeFile));
  const after = pngPixels(fs.readFileSync(afterFile));
  if (before.width !== after.width || before.height !== after.height || before.channels !== after.channels) {
    return { resized: `${before.width}x${before.height} → ${after.width}x${after.height}` };
  }
  const { channels, width } = after;
  const marked = Buffer.from(after.pixels);
  let changed = 0;
  let largest = 0;
  const box = { left: width, top: after.height, right: -1, bottom: -1 };
  for (let at = 0; at < after.pixels.length; at += channels) {
    let delta = 0;
    for (let channel = 0; channel < 3; channel++) {
      delta = Math.max(delta, Math.abs(before.pixels[at + channel] - after.pixels[at + channel]));
    }
    largest = Math.max(largest, delta);
    if (delta > channelDelta) {
      changed++;
      const x = (at / channels) % width;
      const y = Math.floor(at / channels / width);
      box.left = Math.min(box.left, x);
      box.right = Math.max(box.right, x);
      box.top = Math.min(box.top, y);
      box.bottom = Math.max(box.bottom, y);
      marked[at] = 255;
      marked[at + 1] = 0;
      marked[at + 2] = 0;
    } else {
      for (let channel = 0; channel < 3; channel++) marked[at + channel] >>= 2;
    }
  }
  return { changed, largest, box, picture: { ...after, pixels: marked } };
}

const options = parseArgs(process.argv.slice(2));
const [beforeDir, afterDir] = options.dirs;
const beforeNames = shots(beforeDir);
const afterNames = shots(afterDir);
const names = [...new Set([...beforeNames, ...afterNames])].sort();
if (names.length === 0) usage('no screenshots in either folder');

let failed = 0;
for (const name of names) {
  if (!beforeNames.includes(name) || !afterNames.includes(name)) {
    failed++;
    console.log(`DIFF  ${name}: only in ${beforeNames.includes(name) ? 'before' : 'after'}`);
    continue;
  }
  const result = compare(path.join(beforeDir, name), path.join(afterDir, name), options.channelDelta);
  if (result.resized) {
    failed++;
    console.log(`DIFF  ${name}: size changed, ${result.resized}`);
  } else if (result.changed > options.maxPixels) {
    failed++;
    const { left, top, right, bottom } = result.box;
    console.log(
      `DIFF  ${name}: ${result.changed} pixels changed (at most ${result.largest}/255), box ${left},${top} to ${right},${bottom}`
    );
    if (options.out) {
      fs.mkdirSync(options.out, { recursive: true });
      fs.writeFileSync(path.join(options.out, name), encodePng(result.picture));
    }
  } else {
    console.log(`same  ${name}: ${result.changed} pixels over the tolerance (largest change ${result.largest}/255)`);
  }
}
console.log(`ui-shots-diff: ${names.length - failed}/${names.length} views match (delta ${options.channelDelta}, up to ${options.maxPixels} pixels)`);
process.exit(failed ? 1 : 0);
