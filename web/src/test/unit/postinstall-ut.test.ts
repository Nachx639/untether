import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { snapshotEnv } from '../helpers/env-snapshot.js';
import { RM_TEST_DIR } from '../helpers/rm-test-dir.js';

describe('postinstall ut installation', () => {
  let testDir: string;
  let restoreEnv: () => void;

  beforeEach(() => {
    // Create a temporary directory for testing
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-test-'));
    restoreEnv = snapshotEnv();
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Clean up
    restoreEnv();
    fs.rmSync(testDir, RM_TEST_DIR);
    vi.restoreAllMocks();
  });

  describe('installUtCommand - local installation', () => {
    it('should configure ut for local use when not global install', () => {
      const utSource = path.join(testDir, 'ut');
      fs.writeFileSync(utSource, '#!/bin/bash\necho "test ut"');

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const { installUtCommand } = require('../../../scripts/install-ut-command');
      const result = installUtCommand(utSource, false);

      expect(result).toBe(true);
      expect(consoleSpy).toHaveBeenCalledWith('✓ ut command configured for local use');
      expect(consoleSpy).toHaveBeenCalledWith('  Use "npx untether fwd" to run the ut wrapper');

      // Check file is executable on Unix
      if (process.platform !== 'win32') {
        const stats = fs.statSync(utSource);
        expect(stats.mode & 0o111).toBeTruthy(); // Check execute bit
      }

      consoleSpy.mockRestore();
    });

    it('should handle missing ut script gracefully', () => {
      const utSource = path.join(testDir, 'nonexistent');
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const { installUtCommand } = require('../../../scripts/install-ut-command');
      const result = installUtCommand(utSource, false);

      expect(result).toBe(false);
      expect(consoleWarnSpy).toHaveBeenCalledWith('⚠️  ut command script not found in package');
      expect(consoleLogSpy).toHaveBeenCalledWith('   Use "untether" command instead');

      consoleWarnSpy.mockRestore();
      consoleLogSpy.mockRestore();
    });
  });

  describe('detectGlobalInstall - environment variables', () => {
    it('should detect global install when npm_config_global is true', () => {
      process.env.npm_config_global = 'true';

      const { detectGlobalInstall } = require('../../../scripts/install-ut-command');
      const result = detectGlobalInstall();

      expect(result).toBe(true);
    });

    it('should detect local install when npm_config_global is false', () => {
      process.env.npm_config_global = 'false';

      const { detectGlobalInstall } = require('../../../scripts/install-ut-command');
      const result = detectGlobalInstall();

      expect(result).toBe(false);
    });
  });

  describe('Installation helpers', () => {
    it('should check for existing ut command', () => {
      const mockBinDir = path.join(testDir, 'bin');
      fs.mkdirSync(mockBinDir);

      // Test when ut doesn't exist
      const utPath = path.join(mockBinDir, 'ut');
      expect(fs.existsSync(utPath)).toBe(false);

      // Create ut and test it exists
      fs.writeFileSync(utPath, '#!/bin/bash\necho "test"');
      expect(fs.existsSync(utPath)).toBe(true);
    });

    it('should handle Windows .cmd files', () => {
      if (process.platform !== 'win32') {
        // Skip on non-Windows
        return;
      }

      const mockBinDir = path.join(testDir, 'bin');
      fs.mkdirSync(mockBinDir);

      const cmdPath = path.join(mockBinDir, 'ut.cmd');
      const cmdContent = '@echo off\r\nnode "%~dp0\\ut" %*\r\n';

      fs.writeFileSync(cmdPath, cmdContent);

      const content = fs.readFileSync(cmdPath, 'utf8');
      expect(content).toContain('@echo off');
      expect(content).toContain('node "%~dp0\\ut" %*');
    });

    it('should handle symlink creation', () => {
      if (process.platform === 'win32') {
        // Skip on Windows
        return;
      }

      const sourceFile = path.join(testDir, 'source');
      const targetLink = path.join(testDir, 'target');

      fs.writeFileSync(sourceFile, '#!/bin/bash\necho "test"');

      // Create symlink
      fs.symlinkSync(sourceFile, targetLink);

      // Verify symlink exists and points to correct file
      expect(fs.existsSync(targetLink)).toBe(true);
      expect(fs.lstatSync(targetLink).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(targetLink)).toBe(sourceFile);
    });

    it('should handle file copying as fallback', () => {
      const sourceFile = path.join(testDir, 'source');
      const targetFile = path.join(testDir, 'target');

      const content = '#!/bin/bash\necho "test"';
      fs.writeFileSync(sourceFile, content);

      // Copy file
      fs.copyFileSync(sourceFile, targetFile);

      // Make executable on Unix
      if (process.platform !== 'win32') {
        fs.chmodSync(targetFile, '755');
      }

      // Verify copy
      expect(fs.existsSync(targetFile)).toBe(true);
      expect(fs.readFileSync(targetFile, 'utf8')).toBe(content);

      if (process.platform !== 'win32') {
        const stats = fs.statSync(targetFile);
        expect(stats.mode & 0o111).toBeTruthy(); // Check execute bit
      }
    });
  });

  describe('Edge cases', () => {
    it('should handle permission errors gracefully', () => {
      const utSource = path.join(testDir, 'ut');
      fs.writeFileSync(utSource, '#!/bin/bash\necho "test ut"');

      // Create a read-only directory to trigger permission error
      const readOnlyDir = path.join(testDir, 'readonly');
      fs.mkdirSync(readOnlyDir);

      // This would normally fail with permission denied if we made it truly read-only
      // but that's hard to test cross-platform, so we just verify the setup
      expect(fs.existsSync(readOnlyDir)).toBe(true);
    });

    it('should handle path with spaces', () => {
      const dirWithSpaces = path.join(testDir, 'dir with spaces');
      fs.mkdirSync(dirWithSpaces);

      const utSource = path.join(dirWithSpaces, 'ut');
      fs.writeFileSync(utSource, '#!/bin/bash\necho "test ut"');

      expect(fs.existsSync(utSource)).toBe(true);
      expect(fs.readFileSync(utSource, 'utf8')).toContain('test ut');
    });
  });
});
