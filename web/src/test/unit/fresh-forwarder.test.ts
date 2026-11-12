import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ensureForwarder,
  installedForwarderPaths,
  installForwarder,
  staleForwarderProfiles,
} from '../helpers/fresh-forwarder';
import { RM_TEST_DIR } from '../helpers/rm-test-dir.js';

describe('fresh forwarder for the tests (2026-11-02)', () => {
  let crate: string;
  afterEach(() => fs.rmSync(crate, RM_TEST_DIR));

  const touch = (file: string, at: number) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'x');
    fs.utimesSync(file, at / 1000, at / 1000);
  };

  it('finds a built binary older than its sources, and nothing to do otherwise', () => {
    crate = fs.mkdtempSync(path.join(os.tmpdir(), 'fwd-'));
    const t = Date.now() - 60_000;
    touch(path.join(crate, 'src', 'main.rs'), t);
    touch(path.join(crate, 'target', 'release', 'untether-fwd'), t + 10_000);
    expect(staleForwarderProfiles(crate)).toEqual([]);
    touch(path.join(crate, 'src', 'cast_compact.rs'), t + 20_000);
    expect(staleForwarderProfiles(crate)).toEqual(['release']);
    // Never built (no target/debug): left alone.
    expect(staleForwarderProfiles(crate)).not.toContain('debug');
  });

  it('installs the built binary where the e2e tests look when it is missing there (2026-11-08)', () => {
    crate = fs.mkdtempSync(path.join(os.tmpdir(), 'fwd-'));
    const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'web-'));
    try {
      // A release binary exists (built), but a fresh worktree has none in web/native or web/bin.
      touch(path.join(crate, 'target', 'release', 'untether-fwd'), Date.now());
      const dests = installedForwarderPaths(webRoot);
      expect(dests.every((dest) => !fs.existsSync(dest))).toBe(true);
      const note = installForwarder(crate, dests);
      expect(note).toMatch(/installed the forwarder/);
      for (const dest of dests) {
        expect(fs.existsSync(dest)).toBe(true);
        expect(fs.statSync(dest).mode & 0o111).toBeGreaterThan(0); // executable
      }
      // Already installed and nothing stale: a no-op.
      expect(ensureForwarder(crate, webRoot)).toBeUndefined();
    } finally {
      fs.rmSync(webRoot, RM_TEST_DIR);
    }
  });

  it('refreshes an install left behind by a rebuild, not only a missing one (2026-11-08)', () => {
    crate = fs.mkdtempSync(path.join(os.tmpdir(), 'fwd-'));
    const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'web-'));
    try {
      const t = Date.now() - 60_000;
      // An old install the e2e tests would run, and a newer built binary (a rebuild happened).
      for (const dest of installedForwarderPaths(webRoot)) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, 'old');
        fs.utimesSync(dest, t / 1000, t / 1000);
      }
      const release = path.join(crate, 'target', 'release', 'untether-fwd');
      fs.mkdirSync(path.dirname(release), { recursive: true });
      fs.writeFileSync(release, 'new');
      fs.utimesSync(release, (t + 30_000) / 1000, (t + 30_000) / 1000);
      // No Rust sources newer than the binary, so refreshForwarder does nothing; the stale copies
      // are still updated to the newer binary.
      const note = ensureForwarder(crate, webRoot);
      expect(note).toMatch(/installed the forwarder/);
      for (const dest of installedForwarderPaths(webRoot)) {
        expect(fs.readFileSync(dest, 'utf8')).toBe('new');
      }
      // Current now: a no-op.
      expect(ensureForwarder(crate, webRoot)).toBeUndefined();
    } finally {
      fs.rmSync(webRoot, RM_TEST_DIR);
    }
  });

  it('reports it when the binary is not built and cargo cannot be run', () => {
    crate = fs.mkdtempSync(path.join(os.tmpdir(), 'fwd-'));
    const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'web-'));
    try {
      // No target/release binary and no cargo on PATH: a loud note, nothing installed.
      const savedPath = process.env.PATH;
      process.env.PATH = webRoot; // a dir with no cargo
      try {
        const note = installForwarder(crate, installedForwarderPaths(webRoot));
        expect(note).toMatch(/cargo is not available/);
      } finally {
        process.env.PATH = savedPath;
      }
      expect(installedForwarderPaths(webRoot).every((dest) => !fs.existsSync(dest))).toBe(true);
    } finally {
      fs.rmSync(webRoot, RM_TEST_DIR);
    }
  });
});
