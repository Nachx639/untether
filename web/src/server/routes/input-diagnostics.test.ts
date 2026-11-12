import express from 'express';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { InputDiagStore } from '../services/input-diagnostics.js';
import { createInputDiagnosticsRoutes, DIAG_BATCHES_PER_MINUTE } from './input-diagnostics.js';

describe('/api/diag/input', () => {
  let dir = '';
  const now = { t: 10 * 3_600_000 };
  const lines: string[] = [];
  const build = () => {
    const store = new InputDiagStore({ dir, now: () => now.t, log: (line) => lines.push(line) });
    const app = express();
    app.use(express.json());
    app.use('/api', createInputDiagnosticsRoutes({ store, now: () => now.t }));
    return app;
  };
  const batch = {
    ua: 'Mozilla/5.0 (iPhone) CriOS/142.0 Mobile/15E148 Safari/604.1',
    records: [
      { kind: 'open', at: now.t - 1000, agent: 'codex', net: 'lan', look: 'original', ms: 250 },
    ],
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-diag-route-'));
    lines.length = 0;
  });
  afterEach(() => {
    fs.rmSync(dir, RM_TEST_DIR);
  });

  it('takes a batch, logs it and answers its summary', async () => {
    const app = build();
    expect((await request(app).post('/api/diag/input').send(batch)).status).toBe(204);
    expect(lines).toEqual(['open agent=codex net=lan look=original ms=250 · Chrome iOS']);
    const summary = await request(app).get('/api/diag/input?since=1h');
    expect(summary.status).toBe(200);
    expect(summary.body.byAgent[0]).toMatchObject({ name: 'codex', open: { count: 1, p50: 250 } });
    expect((await request(app).get('/api/diag/input?since=soon')).status).toBe(400);
  });

  it('refuses what is not a measure, and more batches than a device sends', async () => {
    const app = build();
    const typed = { ua: 'x', records: [{ kind: 'keys', at: 1, text: 'ls -la' }] };
    expect((await request(app).post('/api/diag/input').send(typed)).status).toBe(400);
    expect(lines).toEqual([]);
    for (let i = 1; i < DIAG_BATCHES_PER_MINUTE; i++) {
      await request(app).post('/api/diag/input').send(batch);
    }
    expect((await request(app).post('/api/diag/input').send(batch)).status).toBe(429);
  });
});
