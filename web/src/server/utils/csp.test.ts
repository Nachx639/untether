import { createHash } from 'crypto';
import express from 'express';
import { readFileSync } from 'fs';
import path from 'path';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { mainOriginPreviewGuard } from '../services/preview-server';
import {
  APP_CSP,
  CSP_REPORT_PATH,
  createCspReportRoutes,
  cspReportLogLine,
  INDEX_INLINE_SCRIPT_HASHES,
} from './csp';

/** index.html's inline scripts, as the browser hashes them (comments can mention <script>). */
function indexInlineScripts(): string[] {
  const html = readFileSync(
    path.resolve(process.cwd(), 'src/client/assets/index.html'),
    'utf8'
  ).replace(/<!--[\s\S]*?-->/g, '');
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
}

describe('the app pages CSP', () => {
  it('allows exactly the inline scripts of index.html, by hash', () => {
    const hashes = indexInlineScripts().map(
      (script) => `'sha256-${createHash('sha256').update(script).digest('base64')}'`
    );
    expect(hashes).toHaveLength(2);
    expect(INDEX_INLINE_SCRIPT_HASHES).toEqual(hashes);
    expect(APP_CSP).toContain(`script-src 'self' 'wasm-unsafe-eval' ${hashes.join(' ')}`);
  });

  it('allows no other inline script and reports to the server', () => {
    expect(APP_CSP).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(APP_CSP).toContain("worker-src 'self' data: blob:");
    expect(APP_CSP).not.toContain('unsafe-inline');
    expect(APP_CSP).not.toMatch(/'unsafe-eval'/);
    expect(APP_CSP).toContain(`report-uri ${CSP_REPORT_PATH}`);
  });

  it('summarizes a classic report once an hour', () => {
    const report = {
      'csp-report': {
        'violated-directive': 'script-src-attr',
        'blocked-uri': 'inline',
        'source-file': 'http://127.0.0.1:4030/session/1',
        'line-number': 12,
        'script-sample': 'alert(1)',
      },
    };
    expect(cspReportLogLine(report, 1000)).toBe(
      'CSP (report-only) would block inline [script-src-attr] at http://127.0.0.1:4030/session/1:12 sample: alert(1)'
    );
    expect(cspReportLogLine(report, 2000)).toBeNull();
    expect(cspReportLogLine(report, 1000 + 60 * 60 * 1000 + 1)).not.toBeNull();
  });

  it('reads the Reporting API format and clips what it logs', () => {
    const line = cspReportLogLine(
      [
        {
          type: 'csp-violation',
          body: {
            effectiveDirective: 'script-src-elem',
            blockedURL: `https://evil.example/${'x'.repeat(500)}`,
          },
        },
      ],
      5000
    );
    expect(line).toContain('[script-src-elem]');
    expect(line?.length).toBeLessThan(220);
  });

  it('keeps control characters from a report out of the log line', () => {
    const line = cspReportLogLine(
      {
        'csp-report': {
          'violated-directive': 'img-src',
          'blocked-uri': 'https://a.example/\x1b[2J\x07x',
        },
      },
      9000
    );
    expect(line).toContain('https://a.example/[2Jx');
    expect([...(line ?? '')].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)).toBe(
      false
    );
  });

  it('accepts reports without credentials and answers 204', async () => {
    const log = vi.fn();
    const app = express();
    app.use(createCspReportRoutes(log));
    const response = await request(app)
      .post(CSP_REPORT_PATH)
      .set('Content-Type', 'application/csp-report')
      .send(
        JSON.stringify({
          'csp-report': { 'violated-directive': 'script-src', 'blocked-uri': 'eval' },
        })
      );
    expect(response.status).toBe(204);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('would block eval'));
  });

  it('refuses a report over 16 KB of any accepted type, also with the global JSON parser', async () => {
    // server-core.ts must mount the report route before its JSON parsers (middleware/json-body.ts):
    // a parser that runs first consumes the body and the route's limit never applies.
    const server = readFileSync(new URL('../server-core.ts', import.meta.url), 'utf8');
    const reportRoute = server.indexOf('app.use(createCspReportRoutes(');
    const globalJson = server.indexOf('app.use(SMALL_JSON_PATHS, smallJsonParser())');
    expect(reportRoute).toBeGreaterThan(-1);
    expect(globalJson).toBeGreaterThan(-1);
    expect(reportRoute).toBeLessThan(globalJson);

    const log = vi.fn();
    const app = express();
    app.use(createCspReportRoutes(log));
    app.use(express.json({ limit: '10mb' }));
    const big = JSON.stringify({ 'csp-report': { 'blocked-uri': 'x'.repeat(20 * 1024) } });
    for (const type of ['application/json', 'application/csp-report', 'application/reports+json']) {
      const response = await request(app).post(CSP_REPORT_PATH).set('Content-Type', type).send(big);
      expect(response.status).toBe(413);
    }
    expect(log).not.toHaveBeenCalled();
  });

  it("lets WebKit's opaque-origin reports past the origin guard, nothing else", async () => {
    const app = express();
    app.use(mainOriginPreviewGuard(() => null));
    app.use(createCspReportRoutes(vi.fn()));
    app.post('/api/sessions', (_req, res) => res.status(200).end());
    const report = await request(app)
      .post(CSP_REPORT_PATH)
      .set('Origin', 'null')
      .set('Content-Type', 'application/csp-report')
      .send('{"csp-report":{"violated-directive":"script-src"}}');
    expect(report.status).toBe(204);
    expect((await request(app).post('/api/sessions').set('Origin', 'null')).status).toBe(403);
  });

  it('logs at most 50 report lines an hour in all', () => {
    // A fresh hour: earlier tests count toward the current one.
    const at = Date.now() + 2 * 60 * 60 * 1000;
    let lines = 0;
    for (let i = 0; i < 80; i++) {
      if (cspReportLogLine({ 'blocked-uri': `https://spam.example/${i}` }, at + i)) lines++;
    }
    expect(lines).toBe(50);
  });
});
