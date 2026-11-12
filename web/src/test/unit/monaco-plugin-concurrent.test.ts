import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { RM_TEST_DIR } from '../helpers/rm-test-dir.js';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const BUILD = `
const { monacoPlugin } = require(${JSON.stringify(path.join(WEB, 'scripts/monaco-plugin.js'))});
let start;
monacoPlugin.setup({ onStart: (fn) => { start = fn; }, onResolve: () => {} });
start().then(() => process.exit(0), (error) => { console.error(error.message); process.exit(1); });
`;

function build() {
  const child = spawn(process.execPath, ['-e', BUILD], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  return new Promise<{ code: number | null; stderr: string; pid?: number }>((resolve) => {
    child.on('close', (code) => resolve({ code, stderr, pid: child.pid }));
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * 2026-11-09: two builds at once (the suite and ui-shots.mjs) shared public/monaco-editor, and one
 * checked the other's half-written bundle and failed the run.
 */
describe('Monaco bundle build', () => {
  it('several at once all succeed, leave the bundle whole and no temporary folder', async () => {
    // Staggered: one build's start falling in the middle of another is what broke it.
    const results = await Promise.all(
      [0, 350, 700, 1050].map(async (delay) => {
        await new Promise((resolve) => setTimeout(resolve, delay));
        return build();
      })
    );
    for (const result of results) expect(result.code, result.stderr).toBe(0);

    const publicDir = path.join(WEB, 'public');
    const bundle = fs.readFileSync(path.join(publicDir, 'monaco-editor/monaco.js'), 'utf8');
    expect(bundle).toContain('DOMPurify');
    // Its own builds' folders, and those of processes that are gone. Another live process's
    // folder is a build going on (2026-11-11: ui-shots.mjs's, in the same run of the suite,
    // failed this test: "expected [ 'monaco-editor.34695.tmp' ] to deeply equal []").
    const own = new Set(results.map((result) => result.pid));
    const left = fs.readdirSync(publicDir).filter((name) => {
      const pid = Number(/^monaco-editor\.(\d+)\.tmp$/.exec(name)?.[1]);
      return name.endsWith('.tmp') && (!pid || own.has(pid) || !alive(pid));
    });
    expect(left).toEqual([]);
  }, 120_000);

  it('a build killed in the middle leaves a folder the next build removes; a live one is kept', async () => {
    const publicDir = path.join(WEB, 'public');
    fs.mkdirSync(publicDir, { recursive: true });
    // A pid that is gone: a process that ran and ended.
    const gone = spawn(process.execPath, ['-e', '']);
    await new Promise((resolve) => gone.on('close', resolve));
    const dead = path.join(publicDir, `monaco-editor.${gone.pid}.tmp`);
    // A build going on in a process that lives: this test's own.
    const live = path.join(publicDir, `monaco-editor.${process.pid}.tmp`);
    fs.mkdirSync(dead, { recursive: true });
    fs.writeFileSync(path.join(dead, 'monaco.js'), 'half');
    fs.mkdirSync(live, { recursive: true });
    try {
      const result = await build();
      expect(result.code, result.stderr).toBe(0);
      expect(fs.existsSync(dead)).toBe(false);
      expect(fs.existsSync(live)).toBe(true);
    } finally {
      fs.rmSync(dead, RM_TEST_DIR);
      fs.rmSync(live, RM_TEST_DIR);
    }
  }, 120_000);
});
