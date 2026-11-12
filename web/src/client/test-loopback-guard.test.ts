// @vitest-environment happy-dom
import { createRequire } from 'node:module';
import type net from 'node:net';
import { describe, expect, it } from 'vitest';

describe('client test workers', () => {
  it('start their test servers on 127.0.0.1 only, as the server ones do', () => {
    // Some client tests run the server's routes through supertest; without this, another
    // process's loopback listener on the same port could answer them (2026-10-04).
    const netModule = createRequire(import.meta.url)('node:net') as typeof net;
    const proto = netModule.Server.prototype as unknown as Record<symbol, unknown>;
    expect(proto[Symbol.for('untether.test.loopbackServers')]).toBe(true);
  });
});
