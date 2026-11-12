import express from 'express';
import * as fs from 'fs';
import type { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { EventLog } from '../services/event-log.js';
import { createEventRoutes } from './events.js';

describe('event routes', () => {
  let dir: string;
  let log: EventLog;
  let servers: Array<{ close: () => void }>;

  const appWith = (eventLog: EventLog) => {
    const app = express();
    app.use(
      '/api',
      createEventRoutes({ eventLog, resolveProject: async (dir) => dir.replace(/\/web$/, '') })
    );
    return app;
  };

  /** Reads an SSE stream until `count` events came; returns them. */
  async function stream(
    app: express.Application,
    url: string,
    count: number,
    headers: Record<string, string> = {},
    during?: () => void
  ): Promise<Array<{ id?: string; event?: string; data: string }>> {
    const server = app.listen(0, '127.0.0.1');
    servers.push(server);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${port}${url}`, {
      headers,
      signal: controller.signal,
    });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const messages: Array<{ id?: string; event?: string; data: string }> = [];
    let started = false;
    while (messages.length < count) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let end = buffer.indexOf('\n\n');
      while (end >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const message: { id?: string; event?: string; data: string } = { data: '' };
        for (const line of block.split('\n')) {
          if (line.startsWith('id: ')) message.id = line.slice(4);
          else if (line.startsWith('event: ')) message.event = line.slice(7);
          else if (line.startsWith('data: ')) message.data = line.slice(6);
        }
        if (message.data) messages.push(message);
        end = buffer.indexOf('\n\n');
      }
      if (!started && during) {
        started = true;
        during();
      }
    }
    controller.abort();
    return messages;
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-events-routes-'));
    log = new EventLog({ dir });
    servers = [];
  });
  afterEach(() => {
    for (const server of servers) server.close();
    fs.rmSync(dir, RM_TEST_DIR);
  });

  it('GET /api/events: a page after an id, with filters; bad ones are a 400', async () => {
    log.record({ type: 'task.state', taskId: 't1', project: '/repos/app', state: 'working' });
    log.record({ type: 'push', pushType: 'x', title: 'Hi' });
    log.record({ type: 'task.state', taskId: 't1', project: '/repos/app', state: 'needs_you' });
    const app = appWith(log);
    const page = await request(app).get('/api/events?after=1&types=task&project=/repos/app/web');
    expect(page.status).toBe(200);
    expect(page.body.events.map((e: { id: number }) => e.id)).toEqual([3]);
    expect(page.body).toMatchObject({ cursor: 3, lastId: 3, gap: false, reset: false });
    expect((await request(app).get('/api/events?types=nope')).status).toBe(400);
    expect((await request(app).get('/api/events?after=x')).status).toBe(400);
  });

  it('streams the backlog then live events; Last-Event-ID resumes after a restart', async () => {
    log.record({ type: 'task.state', taskId: 'a' });
    log.record({ type: 'task.state', taskId: 'b' });
    const first = await stream(appWith(log), '/api/events/stream?after=0', 3, {}, () =>
      log.record({ type: 'session.state', sessionId: 's', state: 'waiting' })
    );
    expect(first.map((m) => [m.id, m.event])).toEqual([
      ['1', 'task.state'],
      ['2', 'task.state'],
      ['3', 'session.state'],
    ]);
    // The server restarts; events came meanwhile; EventSource reconnects with Last-Event-ID.
    const restarted = new EventLog({ dir });
    restarted.record({ type: 'task.state', taskId: 'c' });
    restarted.record({ type: 'push', pushType: 'x', title: 'Ready' });
    const second = await stream(appWith(restarted), '/api/events/stream?after=0', 2, {
      'Last-Event-ID': '3',
    });
    expect(second.map((m) => m.id)).toEqual(['4', '5']);
    expect(JSON.parse(second[0].data)).toMatchObject({ id: 4, type: 'task.state', taskId: 'c' });
  });

  it('streams only what the filters let through', async () => {
    log.record({ type: 'push', pushType: 'x', title: 'skip' });
    log.record({ type: 'task.state', taskId: 'a', project: '/repos/app' });
    log.record({ type: 'task.state', taskId: 'b', project: '/repos/other' });
    const got = await stream(
      appWith(log),
      '/api/events/stream?types=task&project=/repos/app',
      2,
      {},
      () => log.record({ type: 'task.state', taskId: 'c', project: '/repos/app' })
    );
    expect(got.map((m) => m.id)).toEqual(['2', '4']);
  });
});
