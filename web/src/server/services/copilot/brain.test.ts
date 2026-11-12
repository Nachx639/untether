import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { RM_TEST_DIR } from '../../../test/helpers/rm-test-dir.js';
import { Brain } from './brain';

/**
 * A stand-in for the claude CLI: logs its arguments and token, answers stream-json turns.
 * FAKE_CLAUDE_DIE_ON=n exits on the n-th message (the warm-up is the first).
 */
const FAKE = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ pid: process.pid, args, token: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null }) + '\\n');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const answer = (content) => {
  const text = content.includes('arranque') ? '@none' : '@none\\nRespuesta de prueba.';
  for (const piece of [text.slice(0, 5), text.slice(5)]) {
    out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: piece } } });
  }
  out({ type: 'result', is_error: false, result: text });
};
if (!args.includes('--input-format')) {
  answer(args[args.length - 1]);
  process.exit(0);
}
let n = 0;
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    n++;
    if (String(n) === process.env.FAKE_CLAUDE_DIE_ON) process.exit(1);
    answer(JSON.parse(line).message.content);
  }
});
process.stdin.on('end', () => process.exit(0));
`;

let dir = '';
let bin = '';
let log = '';
let tokenFile = '';
const brains: Brain[] = [];

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'copilot-brain-'));
  bin = path.join(dir, 'claude');
  writeFileSync(bin, FAKE, { mode: 0o755 });
  tokenFile = path.join(dir, 'token');
  writeFileSync(tokenFile, 'test-token\n');
});

afterAll(() => rmSync(dir, RM_TEST_DIR));

afterEach(() => {
  for (const b of brains.splice(0)) b.shutdown();
  delete process.env.FAKE_CLAUDE_DIE_ON;
});

function make(opts: { tokenFile?: string; pidFile?: string } = {}) {
  log = path.join(dir, `log-${Math.random().toString(36).slice(2)}`);
  process.env.FAKE_CLAUDE_LOG = log;
  const brain = new Brain('prompt', {
    claudeBin: bin,
    tokenFile: opts.tokenFile ?? tokenFile,
    pidFile: opts.pidFile,
  });
  brains.push(brain);
  return brain;
}

const started = () =>
  existsSync(log)
    ? readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { pid: number; args: string[]; token: string | null })
    : [];

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('copilot brain', () => {
  it('starts nothing until warm()', async () => {
    make();
    await new Promise((r) => setTimeout(r, 50));
    expect(started()).toEqual([]);
  });

  it('always passes the OAuth token and no setting sources', async () => {
    const brain = make();
    expect(await brain.warm()).toBe(true);
    expect(brain.state).toBe('ready');
    const runs = started();
    expect(runs.length).toBeGreaterThanOrEqual(1);
    for (const r of runs) {
      expect(r.token).toBe('test-token');
      const i = r.args.indexOf('--setting-sources');
      expect(i).toBeGreaterThan(-1);
      expect(r.args[i + 1]).toBe('');
      expect(r.args).toContain('--input-format');
    }
  });

  it('refuses to start claude without a token', async () => {
    const empty = path.join(dir, 'empty-token');
    writeFileSync(empty, '  \n');
    for (const file of [path.join(dir, 'missing'), empty]) {
      const brain = make({ tokenFile: file });
      expect(await brain.warm()).toBe(false);
      expect(brain.problem).toBe('no-token');
      const t = brain.turn('USUARIO: hola');
      const r = await t.done;
      expect(r.error).toBe('no-token');
      expect(started()).toEqual([]);
    }
  });

  it('streams a turn', async () => {
    const brain = make();
    await brain.warm();
    const deltas: string[] = [];
    const t = brain.turn('USUARIO: hola');
    t.onDelta((d) => deltas.push(d));
    const r = await t.done;
    expect(deltas.join('')).toBe('@none\nRespuesta de prueba.');
    expect(r.cold).toBe(false);
    expect(r.firstTokenMs).toBeGreaterThanOrEqual(0);
  });

  it('falls back to a cold run when the warm process dies', async () => {
    process.env.FAKE_CLAUDE_DIE_ON = '2';
    const brain = make();
    await brain.warm();
    const r = await brain.turn('USUARIO: hola').done;
    expect(r.text).toContain('Respuesta de prueba');
  });

  it('records its pids and ends every process on shutdown', async () => {
    const pidFile = path.join(dir, 'brain.pids');
    const brain = make({ pidFile });
    await brain.warm();
    await new Promise((r) => setTimeout(r, 200));
    const pids = readFileSync(pidFile, 'utf8').trim().split('\n').map(Number);
    expect(pids.length).toBeGreaterThanOrEqual(1);
    brain.shutdown();
    await new Promise((r) => setTimeout(r, 300));
    for (const pid of pids) expect(alive(pid)).toBe(false);
    // Shut down for good: no new process.
    const before = started().length;
    await brain.turn('USUARIO: hola').done;
    expect(started().length).toBe(before);
  });
});
