import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

// 2026-11-11 (server audit, decisions): /api/tmux/*, /api/git/status, /api/fs/content,
// /api/sessions/:id/suspend-status and the previews "by session and port" had no caller left
// (web app, Mac app, iOS app, `ut`, scripts), some for months: every one was code to keep
// safe for nobody. This reads the routes the server registers and the sources of everything
// that can call them: a route nobody names fails here, so it is either wired or deleted.

const WEB = path.resolve(import.meta.dirname, '../..');
const REPO = path.resolve(WEB, '..');
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '.build',
  'public',
  'DerivedData',
  'target',
  'node-pty',
]);

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const isTest = (file: string) => /\.test\.|\.spec\.|\/Tests\/|\/test\//.test(file);

/** Routers mounted somewhere other than /api (server-routes.ts). */
const MOUNTS: Record<string, string> = { 'routes/multiplexer.ts': '/multiplexer' };

interface Route {
  verb: string;
  /** Its path under /api (or the whole path, for the ones the app registers itself). */
  path: string;
  file: string;
}

function serverRoutes(): Route[] {
  const serverDir = path.join(WEB, 'src/server');
  const routes: Route[] = [];
  for (const file of walk(serverDir)) {
    if (!file.endsWith('.ts') || isTest(file)) continue;
    const relative = path.relative(serverDir, file);
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(
      /\b(?:router|app)\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/g
    )) {
      routes.push({
        verb: match[1].toUpperCase(),
        path: `${MOUNTS[relative] ?? ''}${match[2]}`,
        file: relative,
      });
    }
  }
  return routes;
}

/** Everything that can call the server, as one text. The route files themselves are left out. */
function callers(): string {
  const files = [
    ...walk(path.join(WEB, 'src/client')),
    ...walk(path.join(WEB, 'src/shared')),
    ...walk(path.join(WEB, 'src/server')).filter((file) => !file.includes('/routes/')),
    ...walk(path.join(WEB, 'scripts')),
    ...walk(path.join(REPO, 'scripts')),
    ...walk(path.join(REPO, 'mac')),
    ...walk(path.join(REPO, 'ios')),
    path.join(WEB, 'src/cli.ts'),
  ].filter((file) => /\.(ts|js|mjs|swift|sh|rs)$/.test(file) && !isTest(file));
  return files.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
}

/** The route as a caller writes it: `:id` is whatever the caller puts there. */
function asWritten(route: string): RegExp {
  const segments = route
    .split('/')
    .filter(Boolean)
    .map((segment) =>
      segment.startsWith(':') || segment.includes('*')
        ? '[^/\\s]+'
        : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    );
  return new RegExp(`${segments.join('/')}(?![\\w-])`);
}

/**
 * Routes whose caller does not write the path in one piece, each with where the caller is.
 * A route goes here only with a caller that exists; "it may be useful" is not one.
 */
const CALLED_IN_PIECES: Record<string, string> = {
  // web/src/client/services/task-store.ts: `/api/tasks/${id}/${op}`
  'POST /tasks/:id/send': 'task-store.ts',
  'POST /tasks/:id/hold': 'task-store.ts',
  'POST /tasks/:id/priority': 'task-store.ts',
  'POST /tasks/:id/budget': 'task-store.ts',
  'POST /tasks/:id/discard': 'task-store.ts',
  'POST /tasks/:id/move': 'task-store.ts',
  'POST /tasks/:id/merge': 'task-store.ts',
  'POST /tasks/:id/verify': 'task-store.ts',
  'POST /tasks/:id/fix': 'task-store.ts',
  'POST /tasks/:id/keep': 'task-store.ts',
  'POST /tasks/:id/revert': 'task-store.ts',
  'POST /tasks/:id/retry': 'task-store.ts',
  'POST /tasks/:id/answer': 'task-store.ts',
  // web/src/client/components/session-view/ship-sheet.ts: `${base}/ship-status`, `${base}/${path}`
  'GET /sessions/:sessionId/git/ship-status': 'ship-sheet.ts',
  'POST /sessions/:sessionId/git/commit': 'ship-sheet.ts',
  'POST /sessions/:sessionId/git/push': 'ship-sheet.ts',
  'POST /sessions/:sessionId/git/pr': 'ship-sheet.ts',
  // The share page itself (routes/share.ts): location.pathname + '/screen'
  'GET /share/:token/screen': 'the page GET /share/:token serves',
  // Public API for outside tools: docs/events.md
  'GET /events/stream': 'docs/events.md',
};

/**
 * No caller found on 2026-11-11 and not among the decisions taken that day: left as they
 * were, named here so the list cannot grow unnoticed. Delete the route or wire it, then
 * delete its line.
 */
const UNDECIDED = new Set([
  'GET /copilot/status',
  'GET /multiplexer/context',
  'POST /logs/flush',
  'GET /sessions/tailscale/test',
]);

describe('every route the server registers has a caller', () => {
  const routes = serverRoutes();
  const text = callers();
  const key = (route: Route) => `${route.verb} ${route.path}`;
  const uncalled = routes.filter((route) => !asWritten(route.path).test(text));

  it('reads the routes (a regex that matched nothing would pass everything)', () => {
    expect(routes.length).toBeGreaterThan(150);
    expect(routes.map(key)).toContain('GET /sessions');
    expect(routes.map(key)).toContain('GET /multiplexer/status');
    // A route that does not exist has no caller, whatever is around it in the sources.
    expect(asWritten('/sessions/:id/never-registered').test(text)).toBe(false);
  });

  it('no route is left without one', () => {
    const unexplained = uncalled
      .filter((route) => !(key(route) in CALLED_IN_PIECES) && !UNDECIDED.has(key(route)))
      .map((route) => `${key(route)} (${route.file})`);
    expect(unexplained).toEqual([]);
  });

  it('the exceptions are still exceptions: each names a registered route nobody writes whole', () => {
    const uncalledKeys = new Set(uncalled.map(key));
    const stale = [...Object.keys(CALLED_IN_PIECES), ...UNDECIDED].filter(
      (entry) => !uncalledKeys.has(entry)
    );
    expect(stale).toEqual([]);
  });

  it('the endpoints deleted on 2026-11-11 are gone', () => {
    const registered = new Set(routes.map(key));
    for (const gone of [
      'GET /git/status',
      'GET /git/notifications',
      'GET /fs/content',
      'GET /sessions/:sessionId/suspend-status',
      'GET /sessions/:sessionId/preview',
      'POST /sessions/:sessionId/preview/open',
      'POST /previews/:sessionId/:port/close',
      'POST /previews/:sessionId/:port/check',
    ]) {
      expect(registered.has(gone), gone).toBe(false);
    }
    expect(fs.existsSync(path.join(WEB, 'src/server/routes/tmux.ts'))).toBe(false);
    expect(fs.readFileSync(path.join(WEB, 'src/server/server-routes.ts'), 'utf8')).not.toContain(
      '/api/tmux'
    );
  });
});
