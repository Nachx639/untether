import { EventEmitter } from 'events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RM_TEST_DIR } from '../../../test/helpers/rm-test-dir.js';
import { SessionStateSource } from './session-source';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dirs: string[] = [];
const sources: SessionStateSource[] = [];
afterEach(() => {
  for (const s of sources.splice(0)) s.stop();
  for (const d of dirs.splice(0)) rmSync(d, RM_TEST_DIR);
});

function setup(withSessionsDir = true) {
  const claudeDir = mkdtempSync(path.join(os.tmpdir(), 'copilot-source-'));
  dirs.push(claudeDir);
  if (withSessionsDir) mkdirSync(path.join(claudeDir, 'sessions'));
  let looks = 0;
  const events = new EventEmitter();
  const source = new SessionStateSource({
    access: {
      snapshot: async () => {
        looks++;
        return [];
      },
    },
    sessionEvents: events,
    claudeDir,
    idleTickMs: 60_000,
    busyTickMs: 60_000,
    debounceMs: 10,
  });
  sources.push(source);
  return { source, events, claudeDir, looks: () => looks };
}

describe('copilot session state source', () => {
  it('does nothing until started, and stops looking when stopped', async () => {
    const t = setup();
    await sleep(30);
    expect(t.looks()).toBe(0);
    t.source.start();
    await sleep(30);
    expect(t.looks()).toBe(1);
    expect(t.source.watching).toBe(true);
    t.source.stop();
    expect(t.source.watching).toBe(false);
    t.events.emit('sessionStarted');
    await sleep(30);
    expect(t.looks()).toBe(1);
  });

  // 2026-10-23: failed a project check under load (1 look after 300 ms): the folder watch is
  // FSEvents on macOS, whose delivery has no fixed latency. It waits for the second look up to a
  // deadline far below the 60 s backup tick, so only the watch can bring it.
  it('looks again when a Claude status file changes', async () => {
    const t = setup();
    t.source.start();
    await sleep(30);
    writeFileSync(path.join(t.claudeDir, 'sessions', '123.json'), '{"status":"busy"}');
    await vi.waitFor(() => expect(t.looks()).toBeGreaterThanOrEqual(2), {
      timeout: 5000,
      interval: 20,
    });
  });

  it('looks again when a session starts or exits', async () => {
    const t = setup();
    t.source.start();
    await sleep(30);
    t.events.emit('sessionExited');
    await sleep(40);
    expect(t.looks()).toBeGreaterThanOrEqual(2);
  });

  it('works without a sessions folder (no claude has run yet)', async () => {
    const t = setup(false);
    t.source.start();
    await sleep(30);
    expect(t.looks()).toBe(1);
    expect(t.source.watching).toBe(false);
  });
});
