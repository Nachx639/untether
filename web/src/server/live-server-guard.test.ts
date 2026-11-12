import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';

// src/test/setup.ts keeps server tests off the live servers on this machine (2026-10-03).
// HEAD on a path no server has: should the guard ever regress, this test changes nothing on
// the live server it then reaches (2026-10-04; it used to POST /api/git/event to 4020).
describe('tests and the live servers', () => {
  it.each([
    'http://localhost:4020/__ut-test-guard',
    'http://127.0.0.1:4021/__ut-test-guard',
    'http://[::1]:4030/__ut-test-guard',
  ])('refuses %s', async (url) => {
    await expect(fetch(url, { method: 'HEAD' })).rejects.toThrow(/live Untether/);
  });

  it("still reaches a test's own server", async () => {
    const server = createServer((_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe('ok');
    } finally {
      server.close();
    }
  });
});
