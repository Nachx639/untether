import { execSync, spawn, spawnSync } from 'child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeAll, describe, expect, it } from 'vitest';
import { RM_TEST_DIR } from '../helpers/rm-test-dir.js';

describe('ut command', () => {
  const projectRoot = join(__dirname, '../../..');
  const utScriptPath = join(projectRoot, 'bin/ut');
  const packageJsonPath = join(projectRoot, 'package.json');

  function runUt(
    args: string[],
    env: NodeJS.ProcessEnv = process.env
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn('bash', [utScriptPath, ...args], {
        cwd: projectRoot,
        stdio: 'pipe',
        env: {
          ...env,
          // Keep tests independent of installed app bundles and slow DerivedData searches.
          UNTETHER_BIN: env.UNTETHER_BIN ?? join(projectRoot, 'bin/untether'),
          UNTETHER_FWD_BIN: env.UNTETHER_FWD_BIN ?? join(projectRoot, 'bin/untether-fwd'),
        },
      });
      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });
      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });
      child.once('error', reject);
      child.once('close', (code) => resolve({ code, stdout, stderr }));
    });
  }

  beforeAll(() => {
    // Ensure the ut script exists
    expect(existsSync(utScriptPath)).toBe(true);
    expect(existsSync(packageJsonPath)).toBe(true);
  });

  it('should have valid bash syntax', () => {
    // Test bash syntax using bash -n (no-exec mode)
    expect(() => {
      execSync(`bash -n "${utScriptPath}"`, {
        stdio: 'pipe',
        cwd: projectRoot,
      });
    }).not.toThrow();
  });

  it('should be executable', () => {
    const stats = require('fs').statSync(utScriptPath);
    expect(stats.mode & 0o111).toBeTruthy(); // Check execute permissions
  });

  it('should NOT be included in package.json bin section', () => {
    const packageJson = JSON.parse(require('fs').readFileSync(packageJsonPath, 'utf8'));
    expect(packageJson.bin).toBeDefined();
    // ut should NOT be in bin section to avoid conflicts with other tools
    expect(packageJson.bin.ut).toBeUndefined();
    expect(packageJson.bin.untether).toBe('./bin/untether');
  });

  it('should show help when called with --help', async () => {
    const { code, stdout, stderr } = await runUt(['--help']);

    expect(code).toBe(0);
    expect(stdout).toContain('ut - Untether TTY Forward Wrapper');
    expect(stdout).toContain('USAGE:');
    expect(stdout).toContain('EXAMPLES:');
    expect(stdout).toContain('OPTIONS:');
    expect(stdout).toContain('UNTETHER BINARY:');
    expect(stdout).toContain('Path:');
    expect(stderr).toBe('');
  }, 10000); // 10 second timeout

  it('should show help when called with no arguments', async () => {
    const { code, stdout } = await runUt([]);

    expect(code).toBe(0);
    expect(stdout).toContain('ut - Untether TTY Forward Wrapper');
    expect(stdout).toContain('USAGE:');
  }, 10000);

  it('should handle title command outside session correctly', async () => {
    const { code, stderr } = await runUt(['title', 'test'], {
      ...process.env,
      UNTETHER_SESSION_ID: '',
    });

    expect(code).toBe(1);
    expect(stderr).toContain("ut title' can only be used inside an Untether session");
  }, 10000);

  it('should detect if script contains required functions', () => {
    const scriptContent = require('fs').readFileSync(utScriptPath, 'utf8');

    // Check for essential functions and structures
    expect(scriptContent).toContain('show_help()');
    expect(scriptContent).toContain('resolve_command()');
    expect(scriptContent).toContain('UNTETHER_BIN');
    expect(scriptContent).toContain('exec "$UNTETHER_BIN"');

    // Check for critical conditionals
    expect(scriptContent).toContain('if [ -z "$UNTETHER_BIN" ]');
    expect(scriptContent).toContain('if [ -n "$UNTETHER_SESSION_ID" ]');

    // Check that follow command handling exists
    expect(scriptContent).toContain('if [[ "$1" == "follow" ]]');
    expect(scriptContent).toContain('if [[ "$1" == "unfollow" ]]');
  });

  it('should be included in npm package files', () => {
    const packageJson = JSON.parse(require('fs').readFileSync(packageJsonPath, 'utf8'));
    expect(packageJson.files).toContain('bin/');
  });

  it('should pass --title-mode as separate argv tokens to the forwarder', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'ut-title-mode-'));
    const mockUntetherPath = join(tempDir, 'mock-untether.sh');
    const argvOutputPath = join(tempDir, 'argv.txt');

    try {
      writeFileSync(
        mockUntetherPath,
        `#!/usr/bin/env bash
printf '%s\n' "$@" > "$UT_ARGV_OUTPUT"
`,
        'utf8'
      );
      chmodSync(mockUntetherPath, 0o755);

      const result = spawnSync(
        'bash',
        [utScriptPath, '-S', '--title-mode', 'static', 'echo', 'test'],
        {
          encoding: 'utf8',
          cwd: projectRoot,
          env: {
            ...process.env,
            UNTETHER_BIN: mockUntetherPath,
            UNTETHER_FWD_BIN: mockUntetherPath,
            UNTETHER_SESSION_ID: '',
            UT_ARGV_OUTPUT: argvOutputPath,
          },
        }
      );

      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(readFileSync(argvOutputPath, 'utf8').trimEnd().split('\n')).toEqual([
        '--title-mode',
        'static',
        'echo',
        'test',
      ]);
    } finally {
      rmSync(tempDir, RM_TEST_DIR);
    }
  });

  it('should prefix fwd when falling back to the server CLI', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'ut-title-mode-fallback-'));
    const mockUntetherPath = join(tempDir, 'mock-untether.sh');
    const argvOutputPath = join(tempDir, 'argv.txt');

    try {
      writeFileSync(
        mockUntetherPath,
        `#!/usr/bin/env bash
printf '%s\n' "$@" > "$UT_ARGV_OUTPUT"
`,
        'utf8'
      );
      chmodSync(mockUntetherPath, 0o755);

      const result = spawnSync(
        'bash',
        [utScriptPath, '-S', '--title-mode', 'static', 'echo', 'test'],
        {
          encoding: 'utf8',
          cwd: projectRoot,
          env: {
            ...process.env,
            UNTETHER_BIN: mockUntetherPath,
            UNTETHER_FWD_BIN: join(tempDir, 'missing-forwarder'),
            UNTETHER_SESSION_ID: '',
            UT_ARGV_OUTPUT: argvOutputPath,
          },
        }
      );

      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(readFileSync(argvOutputPath, 'utf8').trimEnd().split('\n')).toEqual([
        'fwd',
        '--title-mode',
        'static',
        'echo',
        'test',
      ]);
    } finally {
      rmSync(tempDir, RM_TEST_DIR);
    }
  });

  describe('ut task / ut project', () => {
    /** A fake untether binary: knows `task` in its help (or not) and records its argv. */
    function fakeUntether(knowsTasks: boolean) {
      const tempDir = mkdtempSync(join(tmpdir(), 'ut-task-'));
      const bin = join(tempDir, 'mock-untether.sh');
      const argvFile = join(tempDir, 'argv.txt');
      writeFileSync(
        bin,
        `#!/usr/bin/env bash
if [ "$1" = "help" ]; then
  echo "Usage:"
  ${knowsTasks ? 'echo "  untether task <command> [args]        Tasks"' : 'echo "  untether status"'}
  exit 0
fi
printf '%s\n' "$@" > "${argvFile}"
echo "session=$UNTETHER_SESSION_ID"
`,
        'utf8'
      );
      chmodSync(bin, 0o755);
      return { tempDir, bin, argvFile };
    }

    const run = (args: string[], bin: string, sessionId: string) =>
      spawnSync('bash', [utScriptPath, ...args], {
        encoding: 'utf8',
        cwd: projectRoot,
        env: {
          ...process.env,
          UNTETHER_BIN: bin,
          UNTETHER_FWD_BIN: bin,
          UNTETHER_SESSION_ID: sessionId,
          UNTETHER_PREFER_DERIVED_DATA: '',
        },
      });

    it('passes task and project commands to untether outside a session, quietly', () => {
      const { tempDir, bin, argvFile } = fakeUntether(true);
      try {
        const result = run(['task', 'list', '--all'], bin, '');
        expect(result.status).toBe(0);
        expect(result.stderr).toBe('');
        expect(result.stdout).toBe('session=\n');
        expect(readFileSync(argvFile, 'utf8').trimEnd().split('\n')).toEqual([
          'task',
          'list',
          '--all',
        ]);
      } finally {
        rmSync(tempDir, RM_TEST_DIR);
      }
    });

    it('allows them inside a session (an agent reports with ut task done)', () => {
      const { tempDir, bin, argvFile } = fakeUntether(true);
      try {
        const done = run(['task', 'done', '--summary', 'Login hecho'], bin, 'sess-42');
        expect(done.status).toBe(0);
        expect(done.stdout).toBe('session=sess-42\n');
        expect(readFileSync(argvFile, 'utf8').trimEnd().split('\n')).toEqual([
          'task',
          'done',
          '--summary',
          'Login hecho',
        ]);
        const show = run(['project', 'show'], bin, 'sess-42');
        expect(show.status).toBe(0);
        expect(readFileSync(argvFile, 'utf8').trimEnd().split('\n')).toEqual(['project', 'show']);
        // Other commands are still refused inside a session.
        const other = run(['ls'], bin, 'sess-42');
        expect(other.status).toBe(1);
        expect(other.stderr).toContain('Already inside an Untether session');
      } finally {
        rmSync(tempDir, RM_TEST_DIR);
      }
    });

    it('refuses with a clear error when the untether binary is too old to know tasks', () => {
      const { tempDir, bin, argvFile } = fakeUntether(false);
      try {
        const result = run(['task', 'list'], bin, 'sess-42');
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("does not support 'ut task' yet");
        expect(existsSync(argvFile)).toBe(false);
      } finally {
        rmSync(tempDir, RM_TEST_DIR);
      }
    });
  });
});
