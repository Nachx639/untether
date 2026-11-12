import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RM_TEST_DIR } from '../helpers/rm-test-dir.js';

const require = createRequire(import.meta.url);
const { forwarderSourceHash, forwarderStale, writeSourceHash } =
  require('../../../scripts/fwd-source-hash.js') as {
    forwarderSourceHash: (dir: string) => string;
    forwarderStale: (sourceDir: string, binaries: string[]) => boolean;
    writeSourceHash: (binary: string, hash: string) => void;
  };
const scriptsDir = path.resolve(path.dirname(require.resolve('../../../scripts/css-watch.js')));

/**
 * build-fwd-rust.js against a fake cargo, in a copy of web/ of its own (its default output is
 * web/native and web/bin next to the script: never the real ones). 2026-11-02: it records the
 * hash of the sources next to both copies, so the doctor compares hashes instead of mtimes.
 */
describe('build-fwd-rust.js', () => {
  let dir: string;
  let web: string;
  let source: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-build-fwd-'));
    web = path.join(dir, 'web');
    source = path.join(dir, 'native', 'ut-fwd');
    fs.mkdirSync(path.join(web, 'scripts'), { recursive: true });
    for (const script of ['build-fwd-rust.js', 'fwd-source-hash.js']) {
      fs.copyFileSync(path.join(scriptsDir, script), path.join(web, 'scripts', script));
    }
    fs.writeFileSync(path.join(web, 'package.json'), '{"version":"0.0.0-test"}');
    fs.mkdirSync(path.join(source, 'src'), { recursive: true });
    fs.writeFileSync(path.join(source, 'Cargo.toml'), '[package]\nname = "untether-fwd"\n');
    fs.writeFileSync(path.join(source, 'Cargo.lock'), '# lock\n');
    fs.writeFileSync(path.join(source, 'src', 'main.rs'), 'fn main() {}\n');
    fs.writeFileSync(path.join(source, 'rust-toolchain.toml'), '[toolchain]\nchannel = "1.2.3"\n');
    const bin = path.join(dir, 'fake-bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, 'cargo'),
      [
        '#!/bin/sh',
        'if [ "$1" = "--version" ]; then echo "cargo 1.2.3 (fake)"; exit 0; fi',
        'mkdir -p "$CARGO_TARGET_DIR/release"',
        'printf "built-binary" > "$CARGO_TARGET_DIR/release/untether-fwd"',
        '',
      ].join('\n'),
      { mode: 0o755 }
    );
    fs.writeFileSync(path.join(bin, 'rustc'), '#!/bin/sh\necho "rustc 1.2.3 (fake)"\n', {
      mode: 0o755,
    });
  });
  afterEach(() => fs.rmSync(dir, RM_TEST_DIR));

  const build = () =>
    execFileSync(process.execPath, [path.join(web, 'scripts', 'build-fwd-rust.js')], {
      cwd: web,
      encoding: 'utf8',
      env: {
        ...process.env,
        UT_FWD_SOURCE_DIR: source,
        CARGO: path.join(dir, 'fake-bin', 'cargo'),
        RUSTC: path.join(dir, 'fake-bin', 'rustc'),
        CARGO_TARGET_DIR: path.join(dir, 'target'),
        ARCHS: '',
      },
    });

  it('writes web/native and web/bin copies, each with the hash of the sources', () => {
    build();
    const hash = forwarderSourceHash(source);
    for (const copy of [path.join(web, 'native'), path.join(web, 'bin')]) {
      expect(fs.readFileSync(path.join(copy, 'untether-fwd'), 'utf8')).toBe('built-binary');
      expect(fs.statSync(path.join(copy, 'untether-fwd')).mode & 0o111).not.toBe(0);
      expect(fs.readFileSync(path.join(copy, 'untether-fwd.source-hash'), 'utf8').trim()).toBe(
        hash
      );
      // Renamed into place: no temporaries left.
      expect(fs.readdirSync(copy).sort()).toEqual(['untether-fwd', 'untether-fwd.source-hash']);
    }
  });

  it('replaces a copy by rename, so a forwarder running from the old file keeps its inode', () => {
    fs.mkdirSync(path.join(web, 'native'), { recursive: true });
    fs.writeFileSync(path.join(web, 'native', 'untether-fwd'), 'old');
    const before = fs.statSync(path.join(web, 'native', 'untether-fwd')).ino;
    fs.writeFileSync(path.join(source, 'src', 'main.rs'), 'fn main() { changed(); }\n');
    build();
    expect(fs.statSync(path.join(web, 'native', 'untether-fwd')).ino).not.toBe(before);
    expect(
      fs.readFileSync(path.join(web, 'native', 'untether-fwd.source-hash'), 'utf8').trim()
    ).toBe(forwarderSourceHash(source));
  });
});

/** ensure-native-modules.js decides with this whether the forwarder copies need a rebuild. */
describe('fwd-source-hash.js forwarderStale', () => {
  let dir: string;
  let source: string;
  let native: string;
  let bin: string;
  const at = (file: string, seconds: number) => {
    const time = new Date(Date.now() - 86_400_000 + seconds * 1000);
    fs.utimesSync(file, time, time);
  };
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-fwd-stale-'));
    source = path.join(dir, 'native', 'ut-fwd');
    fs.mkdirSync(path.join(source, 'src'), { recursive: true });
    fs.writeFileSync(path.join(source, 'Cargo.toml'), '[package]\n');
    fs.writeFileSync(path.join(source, 'src', 'main.rs'), 'fn main() {}\n');
    at(path.join(source, 'Cargo.toml'), 10);
    at(path.join(source, 'src', 'main.rs'), 10);
    native = path.join(dir, 'web', 'native', 'untether-fwd');
    bin = path.join(dir, 'web', 'bin', 'untether-fwd');
    for (const file of [native, bin]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'binary');
      at(file, 20);
    }
  });
  afterEach(() => fs.rmSync(dir, RM_TEST_DIR));

  it('judges each copy on its own: a wrong hash is stale even when the other copy has none', () => {
    // Both newer than the sources, no hashes: current by mtimes.
    expect(forwarderStale(source, [native, bin])).toBe(false);
    // One copy records a hash of other sources: stale, though its mtime is recent.
    writeSourceHash(native, 'f'.repeat(64));
    expect(forwarderStale(source, [native, bin])).toBe(true);
    // The right hash on that copy, none on the other (newer than the sources): current.
    writeSourceHash(native, forwarderSourceHash(source));
    expect(forwarderStale(source, [native, bin])).toBe(false);
    // The copy without a hash is judged by mtimes: older than the sources, stale.
    at(bin, 5);
    expect(forwarderStale(source, [native, bin])).toBe(true);
  });

  it('a checkout that only touches mtimes is no change for copies with the right hash', () => {
    const hash = forwarderSourceHash(source);
    writeSourceHash(native, hash);
    writeSourceHash(bin, hash);
    at(path.join(source, 'src', 'main.rs'), 30);
    expect(forwarderStale(source, [native, bin])).toBe(false);
    fs.writeFileSync(path.join(source, 'src', 'main.rs'), 'fn main() { changed() }\n');
    expect(forwarderStale(source, [native, bin])).toBe(true);
  });
});
