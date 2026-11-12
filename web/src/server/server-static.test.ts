import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { RM_TEST_DIR } from '../test/helpers/rm-test-dir.js';
import type { AuthenticatedRequest } from './middleware/auth.js';
import type { AppContext } from './server-context.js';
import { mountHealthRoute, tailnetDnsName } from './server-static.js';

vi.mock('./utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    log: vi.fn(),
  }),
}));

// 2026-11-08 (audit): health used to hand its version/build/uptime/mode fingerprint to anyone.
describe('GET /api/health', () => {
  const FINGERPRINT = ['version', 'buildDate', 'uptime', 'pid', 'mode'];

  const healthApp = (authed: boolean) => {
    const app = express();
    // Stand in for the auth middleware, which annotates health with any provable identity.
    app.use((req: AuthenticatedRequest, _res, next) => {
      if (authed) {
        req.userId = 'owner';
        req.authMethod = 'tailscale';
      }
      next();
    });
    const ctx = {
      app,
      config: { port: 4020, enableTailscaleServe: false, isHQMode: false },
    } as unknown as AppContext;
    mountHealthRoute(ctx);
    return app;
  };

  it('exposes exactly status + discovery topology without a session, no fingerprint', async () => {
    const res = await request(healthApp(false)).get('/api/health');
    expect(res.status).toBe(200);
    // Exactly these top-level fields without a session. `tailscaleUrl` only appears when Funnel
    // is actually running; Tailscale is off in this test, so it is absent here.
    expect(Object.keys(res.body).sort()).toEqual(['connections', 'status']);
    expect(res.body.status).toBe('healthy');
    // The connection topology discovery needs stays public (ports + the HTTPS/Funnel flags iOS
    // reads from connections.tailscale / connections.sslAvailable). See the route comment.
    // 2026-11-11: the port was also given a second time "for older clients"; there are none.
    expect(res.body.connections).not.toHaveProperty('port');
    expect(res.body.connections.http.port).toBe(4020);
    expect(res.body.connections).toHaveProperty('sslAvailable');
    expect(res.body.connections).toHaveProperty('isPublic');
    // No fingerprint without a session.
    for (const field of [...FINGERPRINT, 'timestamp']) {
      expect(res.body, field).not.toHaveProperty(field);
    }
  });

  it('adds the version/build/uptime/mode fingerprint for a signed-in caller', async () => {
    const res = await request(healthApp(true)).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.connections).toBeDefined();
    expect(res.body.status).toBe('healthy');
    for (const field of [...FINGERPRINT, 'timestamp']) {
      expect(res.body, field).toHaveProperty(field);
    }
  });
});

describe('tailnetDnsName (2026-11-10)', () => {
  it('asks tailscale without blocking, gives up on one that hangs, and remembers the answer', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-tailnet-'));
    try {
      const fake = path.join(dir, 'tailscale');
      const calls = path.join(dir, 'calls');
      fs.writeFileSync(
        fake,
        `#!/bin/sh\necho x >> ${calls}\necho '{"Self":{"DNSName":"mac.tail1234.ts.net."}}'\n`,
        { mode: 0o755 }
      );
      let now = 1_000_000;
      expect(await tailnetDnsName(fake, () => now)).toBe('mac.tail1234.ts.net');
      expect(await tailnetDnsName(fake, () => now)).toBe('mac.tail1234.ts.net');
      expect(fs.readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(1);
      // A minute later it is asked again; a tailscale that never answers is cut at 2 s.
      now += 61_000;
      fs.writeFileSync(fake, '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
      const started = Date.now();
      expect(await tailnetDnsName(fake, () => now)).toBeUndefined();
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      fs.rmSync(dir, RM_TEST_DIR);
    }
  }, 20_000);
});

// 2026-11-11: the app's routes still included /preview/<session>/<port>, a form the client has
// not read since previews have ids (routes/preview-rows.test.ts holds what is served).
describe('the client routes the server serves', () => {
  it('serve a preview by its id only', () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, 'server-static.ts'), 'utf8');
    expect(source).toContain("app.get('/preview/:id',");
    expect(source).not.toContain('/preview/:sessionId/:port');
  });
});
