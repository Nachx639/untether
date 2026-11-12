import { execSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RM_TEST_DIR } from '../helpers/rm-test-dir.js';

describe('native dependency replacements', () => {
  it('uses Node APIs instead of importing uuid, node-fetch or chalk', () => {
    const sourceDir = new URL('../../', import.meta.url);
    const imports: string[] = [];

    for (const entry of readdirSync(sourceDir, { recursive: true, withFileTypes: true })) {
      // Only regular source files: never read symlink targets outside this tree.
      if (!entry.isFile() || !/\.[cm]?[jt]sx?$/.test(entry.name)) continue;
      const file = join(entry.parentPath, entry.name);
      const source = readFileSync(file, 'utf8');
      if (
        /\b(?:from\s*|import\s*\(?\s*|require\s*\(\s*)['"](?:uuid|node-fetch|chalk)(?:\/[^'"]*)?['"]/.test(
          source
        )
      ) {
        imports.push(relative(fileURLToPath(sourceDir), file));
      }
    }

    expect(imports, `External native-API replacements in ${fileURLToPath(sourceDir)}`).toEqual([]);
  });
});

const removedDependencies = [
  '@codemirror/commands',
  '@codemirror/lang-css',
  '@codemirror/lang-html',
  '@codemirror/lang-javascript',
  '@codemirror/lang-json',
  '@codemirror/lang-markdown',
  '@codemirror/lang-python',
  '@codemirror/state',
  '@codemirror/theme-one-dark',
  '@codemirror/view',
  '@testing-library/dom',
  'autoprefixer',
  'node-fetch',
  'postcss-cli',
  'puppeteer',
  'ws-mock',
  'uuid',
];
const webDir = new URL('../../../', import.meta.url);

describe('removed dependencies', () => {
  it.each(['package.json', 'package.npm.json'])('%s excludes the unused dependencies', (file) => {
    const manifest = JSON.parse(readFileSync(new URL(file, webDir), 'utf8'));
    for (const section of [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies',
    ]) {
      for (const dependency of removedDependencies) {
        expect(manifest[section] ?? {}, `${file}: ${section}`).not.toHaveProperty(dependency);
      }
    }
    expect(manifest.pnpm?.onlyBuiltDependencies ?? []).not.toContain('puppeteer');
  });

  it('prunes the removed packages from the pnpm lockfile', () => {
    const lockfile = readFileSync(new URL('pnpm-lock.yaml', webDir), 'utf8');
    const retained = removedDependencies.filter(
      (dependency) => lockfile.includes(`${dependency}@`) || lockfile.includes(`${dependency}:`)
    );
    expect(retained).toEqual([]);
    expect(lockfile.includes('@codemirror/'), 'CodeMirror remains in the lockfile').toBe(false);
    expect(lockfile.includes('puppeteer-core@'), 'Puppeteer remains in the lockfile').toBe(false);
  });

  it('does not declare or reexport Dynamic through the unused Swift helper', () => {
    for (const file of ['Package.swift', 'Sources/UntetherDependencies/Dependencies.swift']) {
      const path = new URL(`../ios/${file}`, webDir);
      if (existsSync(path)) {
        expect(readFileSync(path, 'utf8')).not.toMatch(/mhdhejazi\/Dynamic|\bimport\s+Dynamic\b/);
      }
    }
  });

  // 2026-11-11: mac/Package.swift is gone (the app is built by Untether.xcodeproj alone and
  // nothing read the manifest). With no manifest, SwiftPM can resolve neither SwiftLint, nor
  // SwiftFormat, nor swift-log through it; a manifest that comes back must be looked at again.
  it('has no SwiftPM manifest for the Mac app (SwiftLint, SwiftFormat and swift-log cannot come through it)', () => {
    expect(existsSync(new URL('../mac/Package.swift', webDir))).toBe(false);
  });

  it('does not include swift-log or its Logging product in the Mac Xcode project', () => {
    const project = readFileSync(
      new URL('../mac/Untether.xcodeproj/project.pbxproj', webDir),
      'utf8'
    );
    expect(project).not.toMatch(/swift-log|\bLogging\b|SwiftLint|SwiftFormat/i);
  });

  it('does not retain swift-log in Swift package resolutions', () => {
    for (const file of [
      'Package.resolved',
      'Untether.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved',
    ]) {
      const path = new URL(`../mac/${file}`, webDir);
      // SwiftPM may remove the resolution file when no dependencies remain.
      if (existsSync(path)) {
        const resolved = JSON.parse(readFileSync(path, 'utf8'));
        expect(resolved.pins.map((pin: { identity: string }) => pin.identity)).not.toContain(
          'swift-log'
        );
      }
    }
  });

  it.each(['package.json', 'package.npm.json'])('%s does not depend on chalk directly', (file) => {
    const manifest = JSON.parse(readFileSync(new URL(file, webDir), 'utf8'));
    for (const section of [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies',
    ]) {
      expect(manifest[section] ?? {}, `${file}: ${section}`).not.toHaveProperty('chalk');
    }
  });

  it('does not resolve chalk directly in the pnpm lockfile', () => {
    const lockfile = readFileSync(new URL('pnpm-lock.yaml', webDir), 'utf8');
    // concurrently still needs chalk as a development-only transitive dependency.
    const importers = lockfile.split('\npackages:\n')[0];
    expect(importers).not.toMatch(/^\s+chalk:/m);
  });

  it.each(['package.json', 'package.npm.json'])(
    '%s does not depend on signal-exit directly',
    (file) => {
      const manifest = JSON.parse(readFileSync(new URL(file, webDir), 'utf8'));
      for (const section of [
        'dependencies',
        'devDependencies',
        'optionalDependencies',
        'peerDependencies',
      ]) {
        expect(manifest[section] ?? {}, `${file}: ${section}`).not.toHaveProperty('signal-exit');
      }
    }
  );

  it('does not resolve signal-exit directly in the pnpm lockfile', () => {
    const lockfile = readFileSync(new URL('pnpm-lock.yaml', webDir), 'utf8');
    // Other tools still need signal-exit transitively.
    const importers = lockfile.split('\npackages:\n')[0];
    expect(importers).not.toMatch(/^\s+signal-exit:/m);
  });

  it('does not declare signal-exit as a CLI external dependency', () => {
    const require = createRequire(import.meta.url);
    const { externalDependencies } = require('../../../scripts/build-cli.js');
    expect(externalDependencies).not.toContain('signal-exit');
  });

  it('does not declare rimraf directly in the vendored node-pty package', () => {
    const manifest = JSON.parse(readFileSync(new URL('node-pty/package.json', webDir), 'utf8'));
    for (const section of [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies',
    ]) {
      expect(manifest[section] ?? {}, section).not.toHaveProperty('rimraf');
    }
    const lockfile = readFileSync(new URL('node-pty/pnpm-lock.yaml', webDir), 'utf8');
    const importers = lockfile.split('\npackages:\n')[0];
    expect(importers).not.toMatch(/^\s+rimraf:/m);
  });

  it('cleans only node-pty build outputs using Node, including when outputs are missing', () => {
    const manifest = JSON.parse(readFileSync(new URL('node-pty/package.json', webDir), 'utf8'));
    const root = mkdtempSync(join(tmpdir(), 'node-pty-clean-'));
    try {
      const bin = join(root, 'bin');
      mkdirSync(bin);
      // No external cleanup binary or installed package is available to the script.
      symlinkSync(process.execPath, join(bin, 'node'));
      for (const dir of ['lib', 'build', 'src']) {
        mkdirSync(join(root, dir, 'nested'), { recursive: true });
        writeFileSync(join(root, dir, 'nested', 'keep.txt'), dir);
      }
      writeFileSync(join(root, 'package.json'), '{}');
      // Build output symlinks must not cause source files to be removed.
      symlinkSync(join(root, 'src'), join(root, 'lib', 'source'));

      for (let run = 0; run < 2; run++) {
        execSync(manifest.scripts.clean, {
          cwd: root,
          env: { ...process.env, PATH: bin },
          stdio: 'pipe',
        });
        expect(existsSync(join(root, 'lib'))).toBe(false);
        expect(existsSync(join(root, 'build'))).toBe(false);
        expect(readFileSync(join(root, 'src', 'nested', 'keep.txt'), 'utf8')).toBe('src');
        expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe('{}');
      }
    } finally {
      rmSync(root, RM_TEST_DIR);
    }
  });
});
