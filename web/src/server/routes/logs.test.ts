import express from 'express';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { getLogFilePath } from '../utils/logger.js';
import { CLIENT_LOGS_PER_MINUTE, createLogRoutes, MAX_CLIENT_LOG_BYTES } from './logs.js';

vi.mock('../utils/logger.js', () => ({
  createLogger: vi.fn(() => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
  flushLogger: vi.fn(),
  getLogFilePath: vi.fn(() => '/nonexistent/untether.log'),
  logFromModule: vi.fn(),
}));

// 2026-10-20 (security audit): POST /api/logs/client took 10 MB bodies from anyone.
describe('POST /api/logs/client limits', () => {
  const appWith = (now: { t: number }) => {
    const app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use('/api', createLogRoutes({ now: () => now.t }));
    return app;
  };
  const entry = { level: 'log', module: 'test', args: ['hello'] };

  it('refuses an entry over 256 KB', async () => {
    const app = appWith({ t: 0 });
    const big = { ...entry, args: ['x'.repeat(MAX_CLIENT_LOG_BYTES + 1)] };
    expect((await request(app).post('/api/logs/client').send(big)).status).toBe(413);
    expect((await request(app).post('/api/logs/client').send(entry)).status).toBe(204);
  });

  it('takes at most CLIENT_LOGS_PER_MINUTE entries a minute from one client', async () => {
    const now = { t: 0 };
    const app = appWith(now);
    for (let i = 0; i < CLIENT_LOGS_PER_MINUTE; i++) {
      await request(app).post('/api/logs/client').send(entry);
    }
    const over = await request(app).post('/api/logs/client').send(entry);
    expect(over.status).toBe(429);
    now.t += 60_000;
    expect((await request(app).post('/api/logs/client').send(entry)).status).toBe(204);
  });
});

// 2026-11-10 (iOS audit): the iOS log viewer downloaded the whole file every 2 seconds.
describe('GET /api/logs/raw', () => {
  let dir = '';
  let logFile = '';
  const lines = Array.from(
    { length: 200 },
    (_, i) => `2026-11-10T00:00:00.000Z LOG   [test] line ${String(i).padStart(3, '0')}`
  );
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'untether-test-logs-'));
    logFile = path.join(dir, 'log.txt');
    fs.writeFileSync(logFile, `${lines.join('\n')}\n`);
  });
  afterAll(() => {
    fs.rmSync(dir, RM_TEST_DIR);
  });
  const app = express();
  app.use('/api', createLogRoutes());
  const raw = async (query = '') => {
    vi.mocked(getLogFilePath).mockReturnValue(logFile);
    return (await request(app).get(`/api/logs/raw${query}`)).text;
  };

  afterEach(() => {
    vi.mocked(getLogFilePath).mockReturnValue('/nonexistent/untether.log');
  });

  it('answers the whole file without tail', async () => {
    expect(await raw()).toBe(`${lines.join('\n')}\n`);
  });

  it('answers only the last whole lines with tail', async () => {
    const text = await raw('?tail=500');
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(500);
    const got = text.trimEnd().split('\n');
    expect(got.length).toBeGreaterThan(5);
    // Whole lines, and exactly the last ones of the file
    expect(got).toEqual(lines.slice(-got.length));
  });

  it('answers the whole file when it is smaller than the tail, and ignores a bad tail', async () => {
    const whole = `${lines.join('\n')}\n`;
    expect(await raw('?tail=10000000')).toBe(whole);
    expect(await raw('?tail=abc')).toBe(whole);
    expect(await raw('?tail=-5')).toBe(whole);
  });

  it('answers nothing when there is no log file', async () => {
    expect((await request(app).get('/api/logs/raw?tail=100')).text).toBe('');
  });
});
