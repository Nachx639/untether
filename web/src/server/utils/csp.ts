/**
 * Content-Security-Policy for the app's own pages, in REPORT-ONLY mode for now (2026-10-03).
 * The chat renders untrusted markdown through unsafeHTML and the pages had no CSP at all: an
 * injected on* handler ran (XSS found in review, fixed in 739b5c6a). Without inline scripts
 * a policy can stop that whole class (index.html's own two inline scripts are allowed by hash). Report-only first: browsers send what it WOULD block
 * to /api/csp-report, logged once an hour per kind; once the app runs clean it can enforce.
 */
import express, { type Router } from 'express';

export const CSP_REPORT_PATH = '/api/csp-report';
export const CSP_HEADER = 'Content-Security-Policy-Report-Only';
/**
 * The two inline scripts of index.html, allowed by hash and nothing else inline: the theme
 * (a copy of assets/theme-init.js) and the one that applies styles.css once loaded. They are
 * inline so the first paint waits on no file (2026-10-04, docs/cold-start.md). A hash allows
 * only that exact text; csp.test.ts recomputes them from index.html and says which changed.
 */
export const INDEX_INLINE_SCRIPT_HASHES = [
  "'sha256-WHV7tyVgTu3NNHb5gIb8Kg90c7n0yklYcK6C+sZ+Ugw='",
  "'sha256-WvY6VqpzSYTSpBJEKSzho6DOCjiK7SejZXVkcYA/K/k='",
];

export const APP_CSP = [
  // The terminal compiles WebAssembly (ghostty-vt.wasm). Without 'wasm-unsafe-eval' every
  // terminal page reports, and enforcing would break the terminal. It allows WebAssembly
  // compilation only, not eval() or string timers.
  `script-src 'self' 'wasm-unsafe-eval' ${INDEX_INLINE_SCRIPT_HASHES.join(' ')}`,
  // Monaco's worker stub is `new Worker('data:,')` (utils/monaco-loader.ts): reported when a
  // .ts file opened (2026-10-03). Making a worker already takes script, which stays 'self'.
  "worker-src 'self' data: blob:",
  "object-src 'none'",
  "base-uri 'self'",
  `report-uri ${CSP_REPORT_PATH}`,
].join('; ');

const REPORT_LOG_WINDOW_MS = 60 * 60 * 1000;
/** At most this many report lines an hour in all: the endpoint is open to any page. */
const MAX_REPORT_LINES_PER_HOUR = 50;
const reported = new Map<string, number>();
let hourStartedAt = 0;
let linesThisHour = 0;

type Report = Record<string, unknown>;

/** The violation inside either report format (classic `csp-report`, or the Reporting API). */
function violationOf(body: unknown): Report | null {
  if (Array.isArray(body)) return violationOf(body[0]);
  if (!body || typeof body !== 'object') return null;
  const record = body as Report;
  if (record['csp-report'] && typeof record['csp-report'] === 'object') {
    return record['csp-report'] as Report;
  }
  if (record.body && typeof record.body === 'object') return record.body as Report;
  return record;
}

const field = (report: Report, ...names: string[]) => {
  for (const name of names) {
    const value = report[name];
    if (typeof value === 'string' || typeof value === 'number') return String(value);
  }
  return '';
};

/**
 * One log line for a CSP report, or null for one already logged within the hour (exported
 * for tests). Only a summary is logged, clipped: the report is untrusted input.
 */
export function cspReportLogLine(body: unknown, now = Date.now()): string | null {
  const report = violationOf(body);
  if (!report) return null;
  const directive = field(
    report,
    'effective-directive',
    'effectiveDirective',
    'violated-directive'
  );
  const blocked = field(report, 'blocked-uri', 'blockedURL') || 'inline';
  const source = field(report, 'source-file', 'sourceFile');
  const line = field(report, 'line-number', 'lineNumber');
  const sample = field(report, 'script-sample', 'sample');
  const key = `${directive} ${blocked} ${source}:${line}`;
  const last = reported.get(key);
  if (last !== undefined && now - last < REPORT_LOG_WINDOW_MS) return null;
  if (now - hourStartedAt >= REPORT_LOG_WINDOW_MS) {
    hourStartedAt = now;
    linesThisHour = 0;
  }
  if (linesThisHour >= MAX_REPORT_LINES_PER_HOUR) return null;
  linesThisHour++;
  if (reported.size >= 200) reported.clear();
  reported.set(key, now);
  // Control characters (ESC included) never reach the log: a report could carry terminal
  // escape sequences that rewrite what someone reading the log in a terminal sees.
  const clip = (text: string, max: number) =>
    text
      .replace(/\s+/g, ' ')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
      .replace(/[\x00-\x1f\x7f]/g, '')
      .slice(0, max);
  return `CSP (report-only) would block ${clip(blocked, 120)} [${clip(directive, 40)}]${
    source ? ` at ${clip(source, 120)}:${line || '?'}` : ''
  }${sample ? ` sample: ${clip(sample, 80)}` : ''}`;
}

/** POST /api/csp-report: mounted before the auth middleware (browsers send no credentials). */
export function createCspReportRoutes(log: (line: string) => void): Router {
  const router = express.Router();
  router.post(
    CSP_REPORT_PATH,
    express.json({
      type: ['application/csp-report', 'application/reports+json', 'application/json'],
      limit: '16kb',
    }),
    (req, res) => {
      const line = cspReportLogLine(req.body);
      if (line) log(line);
      res.status(204).end();
    }
  );
  return router;
}
