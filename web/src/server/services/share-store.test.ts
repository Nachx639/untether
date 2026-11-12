import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { SHARE_TOKEN_RE, ShareStore, sharesFileFor } from './share-store.js';

describe('ShareStore', () => {
  it('creates unguessable links that expire', () => {
    let now = 1_000_000;
    const store = new ShareStore({ now: () => now });
    const a = store.create('s1', 15);
    const b = store.create('s1', 15);
    expect(a.token).toMatch(SHARE_TOKEN_RE);
    expect(a.token).not.toBe(b.token);
    expect(a.expiresAt).toBe(now + 15 * 60_000);
    expect(store.get(a.token)?.sessionId).toBe('s1');
    now += 15 * 60_000;
    expect(store.get(a.token)).toBeUndefined();
  });

  it('follows a session reopened as another (Llevar a Untether, 2026-10-25)', () => {
    const store = new ShareStore({ now: () => 0 });
    const link = store.create('fwd_1_2', 15);
    store.create('other', 15);
    expect(store.sessionReplaced('fwd_1_2', 'new-1')).toBe(1);
    expect(store.get(link.token)?.sessionId).toBe('new-1');
    expect(store.listFor('fwd_1_2')).toEqual([]);
    expect(store.listFor('other')).toHaveLength(1);
  });

  it('caps a link at 24 h and refuses malformed tokens', () => {
    const store = new ShareStore({ now: () => 0 });
    expect(store.create('s1', 10_000).expiresAt).toBe(24 * 60 * 60_000);
    expect(store.get('../../etc/passwd')).toBeUndefined();
    expect(store.get('')).toBeUndefined();
  });

  it('revokes, and lists a session’s live links newest first (at most 10)', () => {
    let now = 0;
    const store = new ShareStore({ now: () => now });
    const tokens: string[] = [];
    for (let i = 0; i < 12; i++) {
      now += 1000;
      tokens.push(store.create('s1', 60).token);
    }
    store.create('s2', 60);
    const listed = store.listFor('s1').map((record) => record.token);
    expect(listed).toEqual(tokens.slice(2).reverse());
    expect(store.revoke(tokens[11])).toBe(true);
    expect(store.get(tokens[11])).toBeUndefined();
    expect(store.revoke(tokens[11])).toBe(false);
  });

  it('keeps links across restarts in a private file, without the expired ones', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-share-'));
    try {
      const file = sharesFileFor(path.join(dir, 'control'));
      expect(file).toBe(path.join(dir, 'shares.json'));
      let now = 0;
      const first = new ShareStore({ file, now: () => now });
      const short = first.create('s1', 15);
      const long = first.create('s1', 60);
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      now = 20 * 60_000;
      const second = new ShareStore({ file, now: () => now });
      expect(second.load()).toBe(1);
      expect(second.get(long.token)?.sessionId).toBe('s1');
      expect(second.get(short.token)).toBeUndefined();
    } finally {
      fs.rmSync(dir, RM_TEST_DIR);
    }
  });
});
