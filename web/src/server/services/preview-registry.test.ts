import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import {
  detectedPagePath,
  detectPreviewPorts,
  isPreviewId,
  MAX_PREVIEWS,
  PREVIEW_DISMISS_MS,
  PREVIEW_STALE_MS,
  PreviewRegistry,
  parseOpenTarget,
  previewReadyPush,
  previewsFileFor,
} from './preview-registry.js';

const VITE = [
  '\r\n  \x1b[32m\x1b[1mVITE\x1b[22m v7.1.4\x1b[39m  \x1b[2mready in \x1b[0m\x1b[1m312\x1b[22m\x1b[2m\x1b[0m ms\x1b[22m\r\n',
  '\r\n  \x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m\r\n',
  '\x1b[2m  \x1b[32m➜\x1b[39m  \x1b[1mNetwork\x1b[22m\x1b[2m: use \x1b[22m\x1b[1m--host\x1b[22m\x1b[2m to expose\x1b[22m\r\n',
].join('');
const NEXT =
  '   ▲ Next.js 15.5.0\r\n   - Local:        http://localhost:3000\r\n   - Network:      http://192.168.1.20:3000\r\n\r\n ✓ Starting...\r\n';
const NEXT_OLD = 'ready - started server on 0.0.0.0:3001, url: http://localhost:3001\r\n';
const UVICORN = 'INFO:     Uvicorn running on http://127.0.0.1:8000 (Press CTRL+C to quit)\r\n';
const NODE = 'Listening on http://127.0.0.1:8080\n';

describe('dev-server port detection', () => {
  it('finds vite, next, uvicorn and plain node URLs', () => {
    expect(detectPreviewPorts(VITE)).toEqual([{ port: 5173, url: 'http://localhost:5173/' }]);
    expect(detectPreviewPorts(NEXT)).toEqual([{ port: 3000, url: 'http://localhost:3000' }]);
    expect(detectPreviewPorts(NEXT_OLD)).toEqual([{ port: 3001, url: 'http://localhost:3001' }]);
    expect(detectPreviewPorts(UVICORN)).toEqual([{ port: 8000, url: 'http://127.0.0.1:8000' }]);
    expect(detectPreviewPorts(NODE)).toEqual([{ port: 8080, url: 'http://127.0.0.1:8080' }]);
  });

  it('ignores LAN addresses, privileged ports and URLs merely mentioned', () => {
    expect(detectPreviewPorts('   - Network:      http://192.168.1.20:3000\r\n')).toEqual([]);
    expect(detectPreviewPorts('Local: http://localhost:80/')).toEqual([]);
    expect(detectPreviewPorts('see http://localhost:5173 in the docs')).toEqual([]);
  });

  it('only counts a URL announced as a dev server, not one in a command or in prose', () => {
    const found = (text: string) => detectPreviewPorts(text).map((entry) => entry.port);
    // What dev servers print right before their URL.
    expect(found('Starting development server at http://127.0.0.1:8000/')).toEqual([8000]);
    expect(found(' * Running on http://127.0.0.1:5000')).toEqual([5000]);
    expect(
      found('Web Server is available at http://localhost:1313/ (bind address 127.0.0.1)')
    ).toEqual([1313]);
    expect(found('    Server address: http://127.0.0.1:4000/')).toEqual([4000]);
    expect(found('Serving HTTP on 127.0.0.1 port 8002 (http://127.0.0.1:8002/) ...')).toEqual([
      8002,
    ]);
    expect(found('<i> [webpack-dev-server] Loopback: http://localhost:8081/')).toEqual([8081]);
    expect(found('Started development server: http://localhost:3005')).toEqual([3005]);
    expect(found('  Local URL: http://localhost:8501')).toEqual([8501]);
    expect(found('[wrangler:inf] Ready on http://localhost:8787')).toEqual([8787]);
    expect(found(' ┃ Local    http://localhost:4321/')).toEqual([4321]);
    expect(found('   INFO  Server running on [http://127.0.0.1:8001].')).toEqual([8001]);
    expect(
      found(
        '** Angular Live Development Server is listening on localhost:4200, open your browser on http://localhost:4200/ **'
      )
    ).toEqual([4200]);
    // A line that is just the URL (Gatsby, Jupyter).
    expect(found('  http://localhost:8003/')).toEqual([8003]);
    expect(found('    http://localhost:8888/tree?token=abc')).toEqual([8888]);
    // 2026-10-03: a curl in a Claude session (a TUI) became a preview of Untether itself.
    expect(found('⏺ Bash(curl -s http://127.0.0.1:4020/api/previews | jq .) Ready')).toEqual([]);
    expect(found('curl http://127.0.0.1:4020/api/previews')).toEqual([]);
    expect(found('$ wget http://localhost:3000/file.zip')).toEqual([]);
    expect(found('GET http://localhost:3000/api/users 200 12ms')).toEqual([]);
    expect(found('open http://localhost:3000 in your browser')).toEqual([]);
    expect(found('  ⎿  {"url":"http://127.0.0.1:4020/x","status":"ready"}')).toEqual([]);
  });

  it('never registers a refused port (Untether, denied), and drops ones kept from before', () => {
    const registry = new PreviewRegistry();
    const kept = registry.upsert(4020, { source: 'detected' }).entry;
    registry.upsert(5173, { source: 'detected' });
    registry.setPortFilter((port) =>
      port === 4020 || port === 4021 ? "Untether's own port" : null
    );
    expect(registry.removeRefused()).toEqual([
      { id: kept.id, port: 4020, reason: "Untether's own port" },
    ]);
    expect(registry.ports()).toEqual([5173]);
    registry.trackOutput('s1', 'Untether Server running on http://localhost:4021\r\n');
    expect(registry.ports()).toEqual([5173]);
    expect(() => registry.open('s1', 4020)).toThrow(/can't be a preview/);
  });

  it('checks a newly announced port before listing it; listed ones skip the check', async () => {
    const registry = new PreviewRegistry();
    const vet = vi.fn(async (port: number) => port !== 4030);
    registry.setNewPortVetter(vet);
    registry.trackOutput('s1', 'Untether Server running on http://localhost:4030\r\n');
    registry.trackOutput('s1', '  ➜  Local:   http://localhost:5173/\r\n');
    expect(registry.ports()).toEqual([]);
    await vi.waitFor(() => expect(registry.ports()).toEqual([5173]));
    expect(vet.mock.calls.map(([port]) => port).sort()).toEqual([4030, 5173]);
    registry.trackOutput('s2', '  ➜  Local:   http://localhost:5173/\r\n');
    expect(vet).toHaveBeenCalledTimes(2);
    expect(registry.forSession('s2').map((entry) => entry.port)).toEqual([5173]);
  });

  it('a detected API or data URL never becomes the page a preview opens', () => {
    expect(detectedPagePath('/api/calendario')).toBeUndefined();
    expect(detectedPagePath('/feed.ics?x=1')).toBeUndefined();
    expect(detectedPagePath('/_next/static/app.js')).toBeUndefined();
    expect(detectedPagePath('/graphql')).toBeUndefined();
    expect(detectedPagePath('/apis-overview')).toBe('/apis-overview');
    expect(detectedPagePath('/about?tab=1')).toBe('/about?tab=1');
    expect(detectedPagePath('/index.html')).toBe('/index.html');
    const registry = new PreviewRegistry();
    registry.trackOutput('s1', '  ➜  Local:   http://localhost:5173/settings\r\n');
    // A URL alone on its line counts as announced, an API one included.
    registry.trackOutput('s1', '  http://localhost:5173/api/items\r\n');
    registry.trackOutput('s2', '  ⎿  https://localhost:5174/api/feed.ics\r\n');
    expect(registry.byPort(5173)?.path).toBe('/settings');
    expect(registry.byPort(5174)?.path).toBe('/');
  });

  it('records announced ports across split writes, once per port', () => {
    const registry = new PreviewRegistry();
    const changed = vi.fn();
    registry.on('changed', changed);
    registry.trackOutput('s1', '  ➜  Local:   http://local');
    registry.trackOutput('s1', 'host:5173/\r\n');
    expect(registry.forSession('s1').map((p) => p.port)).toEqual([5173]);
    expect(registry.forSession('s2')).toEqual([]);
    registry.trackOutput('s1', '  ➜  Local:   http://localhost:5173/\r\n');
    expect(changed).toHaveBeenCalledTimes(1);
    expect(registry.all()).toHaveLength(1);
  });
});

describe('ut open', () => {
  it('accepts a port or a localhost URL only', () => {
    expect(parseOpenTarget('5173')).toEqual({ port: 5173, path: '/' });
    expect(parseOpenTarget(':3000/about')).toEqual({ port: 3000, path: '/about' });
    expect(parseOpenTarget('localhost:3000/a?b=1')).toEqual({ port: 3000, path: '/a?b=1' });
    expect(parseOpenTarget('http://127.0.0.1:8000/docs')).toEqual({ port: 8000, path: '/docs' });
    expect(parseOpenTarget('https://example.com:5173/')).toBeNull();
    expect(parseOpenTarget('file:///etc/passwd')).toBeNull();
    expect(parseOpenTarget('nope')).toBeNull();
  });

  it('emits an open event with the preview id and builds the preview-ready deep link', () => {
    const registry = new PreviewRegistry();
    const open = vi.fn();
    registry.on('open', open);
    const event = registry.open('s1', 5173, 'about');
    expect(isPreviewId(event.id)).toBe(true);
    expect(event).toEqual({ id: event.id, sessionId: 's1', port: 5173, path: '/about' });
    expect(open).toHaveBeenCalledWith(event);
    expect(registry.forSession('s1')[0]).toMatchObject({
      id: event.id,
      port: 5173,
      source: 'ut-open',
    });
    const push = previewReadyPush(event, 'web app');
    expect(push.type).toBe('preview-ready');
    expect(push.title).toContain('web app');
    expect(push.data).toEqual({
      type: 'preview-ready',
      id: event.id,
      sessionId: 's1',
      port: 5173,
      path: '/about',
      where: 'web app',
      url: `/preview/${event.id}?path=%2Fabout`,
    });
  });

  it('ids never look like the old numeric /preview/<port> paths', () => {
    for (let i = 0; i < 50; i++) {
      const { id } = new PreviewRegistry().open('s', 5173);
      expect(id).toMatch(/^p[a-z0-9]+$/);
    }
  });
});

describe('one preview per port', () => {
  it('`ut open` and announcements upsert by port, bringing it to the top with its new session', () => {
    let now = 1000;
    const registry = new PreviewRegistry({ now: () => now });
    registry.setSessionNames((id) => `name-${id}`);
    const first = registry.open('s1', 5173, '/a');
    now = 2000;
    registry.open('s1', 3000);
    expect(registry.all().map((e) => e.port)).toEqual([3000, 5173]);

    now = 3000;
    registry.setHealth(5173, true, 'Shop');
    const again = registry.open('s2', 5173, '/cart');
    expect(again.id).toBe(first.id);
    expect(registry.all()).toHaveLength(2);
    expect(registry.all()[0]).toMatchObject({
      id: first.id,
      port: 5173,
      path: '/cart',
      sessionId: 's2',
      sessionName: 'name-s2',
      lastOpenedAt: 3000,
      createdAt: 1000,
      // Another session's server on that port: its title is read again.
      title: undefined,
    });
    expect(registry.forSession('s1').map((p) => p.port)).toEqual([3000]);
  });

  it('keeps at most MAX_PREVIEWS, dropping the oldest unpinned one', () => {
    let now = 0;
    const registry = new PreviewRegistry({ now: () => ++now });
    const oldest = registry.addManual(2000);
    registry.update(oldest.id, { pinned: true });
    const second = registry.addManual(2001);
    for (let port = 2002; port < 2000 + MAX_PREVIEWS + 1; port++) registry.addManual(port);
    expect(registry.all()).toHaveLength(MAX_PREVIEWS);
    expect(registry.get(oldest.id)).toBeDefined();
    expect(registry.get(second.id)).toBeUndefined();
  });
});

describe('previews.json', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-previews-'));
    file = path.join(dir, 'previews.json');
  });
  afterEach(() => {
    fs.rmSync(dir, RM_TEST_DIR);
  });

  it('lives next to the control dir, so a QA server keeps its own', () => {
    expect(previewsFileFor('/Users/n/.untether/control')).toBe('/Users/n/.untether/previews.json');
    expect(previewsFileFor('/Users/n/.untether-qa/control/')).toBe(
      '/Users/n/.untether-qa/previews.json'
    );
    // A throwaway control dir keeps its own file instead of a shared /tmp/previews.json.
    expect(previewsFileFor('/tmp/vtg.Ab12')).toBe('/tmp/vtg.Ab12/previews.json');
  });

  it('survives a restart: entries, pins and names come back', () => {
    const registry = new PreviewRegistry({ file, saveDelayMs: 0 });
    registry.setSessionNames(() => 'tienda');
    const { id } = registry.open('s1', 5173, '/cart');
    registry.update(id, { pinned: true, customName: '  Mi tienda  ' });
    registry.setHealth(5173, true, 'Shop');

    const reloaded = new PreviewRegistry({ file });
    expect(reloaded.load()).toEqual({ loaded: 1, corrupt: false });
    expect(reloaded.get(id)).toMatchObject({
      id,
      port: 5173,
      path: '/cart',
      pinned: true,
      customName: 'Mi tienda',
      title: 'Shop',
      sessionId: 's1',
      sessionName: 'tienda',
      source: 'ut-open',
    });
    expect(reloaded.get(id)?.lastSeenAt).toBeTypeOf('number');
  });

  it('writes atomically: a temp file renamed over the old one, nothing left behind', () => {
    const registry = new PreviewRegistry({ file, saveDelayMs: 0 });
    fs.writeFileSync(file, '{"previews":[]}');
    // A rename puts a new file (inode) in place; writing in place would keep the old one.
    const before = fs.statSync(file).ino;
    registry.addManual(5173);
    expect(fs.statSync(file).ino).not.toBe(before);
    expect(fs.readdirSync(dir)).toEqual(['previews.json']);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).previews[0].port).toBe(5173);
  });

  it('debounces writes and flushes them on shutdown', () => {
    const registry = new PreviewRegistry({ file, saveDelayMs: 60_000 });
    registry.addManual(5173);
    expect(fs.existsSync(file)).toBe(false);
    registry.flush();
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).previews).toHaveLength(1);
  });

  it('a corrupt file is kept aside and the registry starts empty', () => {
    fs.writeFileSync(file, '{"previews": [ {"id": "pabc1234", "port": 51');
    const registry = new PreviewRegistry({ file, saveDelayMs: 0, now: () => 42 });
    expect(registry.load()).toEqual({ loaded: 0, corrupt: true });
    expect(registry.all()).toEqual([]);
    expect(fs.readFileSync(path.join(dir, 'previews.json.corrupt-42'), 'utf8')).toContain('pabc');
    registry.addManual(3000);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).previews).toHaveLength(1);
  });

  it('skips entries it does not understand', () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        previews: [
          { id: 'pgood123', port: 5173, lastOpenedAt: 5 },
          { id: '5173', port: 5174 },
          { id: 'pbadport1', port: 'x' },
          { id: 'pdupe1234', port: 5173 },
        ],
      })
    );
    const registry = new PreviewRegistry({ file });
    expect(registry.load().loaded).toBe(1);
    expect(registry.get('pgood123')).toMatchObject({ port: 5173, path: '/', pinned: false });
  });
});

describe('auto-cleanup', () => {
  it('removes unpinned previews down for more than 7 days; pinned and live ones stay', () => {
    let now = 1_000_000;
    const registry = new PreviewRegistry({ now: () => now });
    const old = registry.addManual(5001);
    const pinned = registry.addManual(5002);
    registry.update(pinned.id, { pinned: true });
    const live = registry.addManual(5003);
    const recent = registry.addManual(5004);
    const unchecked = registry.addManual(5005);

    now += PREVIEW_STALE_MS - 1000;
    registry.setHealth(5004, true); // answered a moment ago
    now += 2000;
    registry.setHealth(5001, false);
    registry.setHealth(5002, false);
    registry.setHealth(5003, true);
    registry.setHealth(5004, false);

    expect(registry.cleanup()).toEqual([old.id]);
    expect(registry.get(pinned.id)).toBeDefined();
    expect(registry.get(live.id)).toBeDefined();
    expect(registry.get(recent.id)).toBeDefined();
    // Never checked since the start (Untether was off): not judged yet.
    expect(registry.get(unchecked.id)).toBeDefined();
  });
});

describe('deleting a preview', () => {
  const ANNOUNCE = (port: number) => `  ➜  Local:   http://localhost:${port}/\r\n`;

  it('stays deleted when its session prints the URL again (tmux redraw, Claude re-render)', () => {
    const registry = new PreviewRegistry();
    registry.trackOutput('s1', ANNOUNCE(5173));
    const id = registry.byPort(5173)?.id as string;
    expect(registry.dismiss(id)).toBe(true);
    registry.forgetSessionOutput('s1');
    registry.trackOutput('s1', ANNOUNCE(5173));
    expect(registry.ports()).toEqual([]);
    // Another session's dev server on that port is a new announcement.
    registry.trackOutput('s2', ANNOUNCE(5173));
    expect(registry.ports()).toEqual([5173]);
  });

  it('`ut open` and "+ Añadir" bring it back on purpose', () => {
    const registry = new PreviewRegistry();
    registry.trackOutput('s1', ANNOUNCE(5173));
    registry.dismiss(registry.byPort(5173)?.id as string);
    registry.open('s1', 5173);
    expect(registry.ports()).toEqual([5173]);
    registry.dismiss(registry.byPort(5173)?.id as string);
    registry.addManual(5173);
    registry.forgetSessionOutput('s1');
    registry.trackOutput('s1', ANNOUNCE(5173));
    expect(registry.ports()).toEqual([5173]);
  });

  it('is remembered across restarts and forgotten after a week', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-dismiss-'));
    try {
      const file = path.join(dir, 'previews.json');
      let now = 1_000_000;
      const first = new PreviewRegistry({ file, now: () => now, saveDelayMs: 0 });
      first.trackOutput('s1', ANNOUNCE(5173));
      first.dismiss(first.byPort(5173)?.id as string);
      first.save();

      const second = new PreviewRegistry({ file, now: () => now });
      second.load();
      second.trackOutput('s1', ANNOUNCE(5173));
      expect(second.ports()).toEqual([]);

      now += PREVIEW_DISMISS_MS + 1;
      const third = new PreviewRegistry({ file, now: () => now });
      third.load();
      third.trackOutput('s1', ANNOUNCE(5173));
      expect(third.ports()).toEqual([5173]);
    } finally {
      fs.rmSync(dir, RM_TEST_DIR);
    }
  });

  it('the same session announcing again does not move it to the top; another session does', () => {
    let now = 1000;
    const registry = new PreviewRegistry({ now: () => now });
    registry.trackOutput('s1', ANNOUNCE(3000));
    now = 2000;
    registry.trackOutput('s2', ANNOUNCE(5173));
    expect(registry.all().map((entry) => entry.port)).toEqual([5173, 3000]);
    now = 3000;
    registry.forgetSessionOutput('s1');
    registry.trackOutput('s1', ANNOUNCE(3000));
    expect(registry.all().map((entry) => entry.port)).toEqual([5173, 3000]);
    now = 4000;
    registry.trackOutput('s3', ANNOUNCE(3000));
    expect(registry.all().map((entry) => entry.port)).toEqual([3000, 5173]);
  });
});
