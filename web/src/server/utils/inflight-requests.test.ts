import * as http from 'http';
import * as net from 'net';
import { describe, expect, it, vi } from 'vitest';
import { createInflightRequests } from './inflight-requests';

function exchange(method: string) {
  const req = new http.IncomingMessage(new net.Socket());
  req.method = method;
  return { req, res: new http.ServerResponse(req) };
}

describe('requests in flight', () => {
  it('counts what changes something until its response closes, once, and never a read', () => {
    const inflight = createInflightRequests();
    const next = vi.fn();
    const writes = ['POST', 'PUT', 'PATCH', 'DELETE'].map((method) => exchange(method));
    const reads = ['GET', 'HEAD', 'OPTIONS'].map((method) => exchange(method));
    for (const { req, res } of [...writes, ...reads]) inflight.middleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(7);
    expect(inflight.count()).toBe(4);

    writes[0].res.emit('close');
    writes[0].res.emit('close');
    expect(inflight.count()).toBe(3);
    for (const { res } of writes.slice(1)) res.emit('close');
    expect(inflight.count()).toBe(0);
  });
});
