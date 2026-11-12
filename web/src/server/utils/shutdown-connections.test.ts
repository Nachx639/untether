import * as http from 'http';
import * as net from 'net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { createInflightRequests } from './inflight-requests';
import { closeConnectionsForShutdown } from './shutdown-connections';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/**
 * A server holding what phones hold: a keep-alive socket, an event stream and a WebSocket.
 * An upload (any POST) takes 600 ms, longer than the 300 ms shutdowns used to give it.
 */
async function busyServer() {
  const inflight = createInflightRequests();
  let uploadArrived: () => void = () => undefined;
  const uploadReceived = new Promise<void>((resolve) => {
    uploadArrived = resolve;
  });
  const server = http.createServer((req, res) => {
    inflight.middleware(req, res, () => {
      if (req.url === '/stream') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: hi\n\n');
        return; // never ends, like an event stream
      }
      if (req.method === 'POST') {
        uploadArrived();
        req.resume();
        setTimeout(() => res.end('saved'), 600);
        return;
      }
      res.end('ok');
    });
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  const agent = new http.Agent({ keepAlive: true });
  cleanups.push(() => agent.destroy());
  await new Promise<void>((resolve) => {
    http.get({ host: '127.0.0.1', port, path: '/', agent }, (res) => {
      res.resume();
      res.on('end', () => resolve());
    });
  });
  await new Promise<void>((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/stream' }, (res) => {
      res.once('data', () => resolve());
      res.on('error', () => undefined);
    });
    req.on('error', () => undefined);
    cleanups.push(() => req.destroy());
  });
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((resolve) => ws.once('open', resolve));
  const closeCodes: number[] = [];
  ws.on('close', (code) => closeCodes.push(code));
  ws.on('error', () => undefined);
  cleanups.push(() => ws.terminate());
  return { server, wss, closeCodes, port, inflight, uploadReceived };
}

const closing = (server: http.Server) =>
  new Promise<number>((resolve) => {
    const started = Date.now();
    server.close(() => resolve(Date.now() - started));
  });

/** Resolves with the response body; rejects when the connection is cut before it. */
const upload = (port: number) =>
  new Promise<string>((resolve, reject) => {
    const options = { host: '127.0.0.1', port, method: 'POST', path: '/upload', agent: false };
    const req = http.request(options, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        body += chunk;
      });
      res.on('end', () => resolve(body));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end('photo');
  });

describe('closing connections on shutdown', () => {
  it('without it, close() is still waiting on the open connections', async () => {
    const { server, wss, inflight } = await busyServer();
    const result = await Promise.race([
      closing(server).then(() => 'closed'),
      new Promise((resolve) => setTimeout(() => resolve('still waiting'), 400)),
    ]);
    expect(result).toBe('still waiting');
    closeConnectionsForShutdown(server, wss, inflight.count);
  });

  it('lets close() finish at once, event stream included, WebSockets told the server is going away', async () => {
    const { server, wss, closeCodes, inflight } = await busyServer();
    const closed = closing(server);
    closeConnectionsForShutdown(server, wss, inflight.count);
    expect(await closed).toBeLessThan(1000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(closeCodes).toEqual([1001]);
  });

  it('lets an upload in flight finish before cutting the rest', async () => {
    const { server, wss, port, inflight, uploadReceived } = await busyServer();
    const saved = upload(port);
    await uploadReceived;
    const closed = closing(server);
    closeConnectionsForShutdown(server, wss, inflight.count);
    expect(await saved).toBe('saved');
    expect(await closed).toBeLessThan(1000);
  });
});

describe('cutting what is still open on shutdown', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Shuts a fake server down with requests of these methods in flight. */
  function shutDownWith(...methods: string[]) {
    const inflight = createInflightRequests();
    const responses = methods.map((method) => {
      const req = new http.IncomingMessage(new net.Socket());
      req.method = method;
      const res = new http.ServerResponse(req);
      inflight.middleware(req, res, () => undefined);
      return res;
    });
    const server = { closeIdleConnections: vi.fn(), closeAllConnections: vi.fn() };
    const client = { close: vi.fn(), terminate: vi.fn() };
    closeConnectionsForShutdown(server, { clients: new Set([client]) }, inflight.count);
    return { server, client, responses };
  }

  it('happens 50 ms later, the close frames out, when nothing is in flight', () => {
    const { server, client } = shutDownWith();
    expect(server.closeIdleConnections).toHaveBeenCalledOnce();
    expect(client.close).toHaveBeenCalledWith(1001, 'Server restarting');
    expect(server.closeAllConnections).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(server.closeAllConnections).toHaveBeenCalledOnce();
    expect(client.terminate).toHaveBeenCalledOnce();
  });

  it('waits for a POST in flight and happens within 50 ms of its end', () => {
    const { server, client, responses } = shutDownWith('POST');
    vi.advanceTimersByTime(2000);
    expect(server.closeAllConnections).not.toHaveBeenCalled();
    expect(client.terminate).not.toHaveBeenCalled();
    responses[0].emit('close');
    vi.advanceTimersByTime(50);
    expect(server.closeAllConnections).toHaveBeenCalledOnce();
    expect(client.terminate).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(5000);
    expect(server.closeAllConnections).toHaveBeenCalledOnce();
  });

  it('happens after 5 s at the latest when a request never finishes', () => {
    const { server } = shutDownWith('POST');
    vi.advanceTimersByTime(4999);
    expect(server.closeAllConnections).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(server.closeAllConnections).toHaveBeenCalledOnce();
  });

  it('does not wait for a GET in flight: event streams never end', () => {
    const { server } = shutDownWith('GET');
    vi.advanceTimersByTime(50);
    expect(server.closeAllConnections).toHaveBeenCalledOnce();
  });
});
