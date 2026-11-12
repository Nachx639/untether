import { createHash } from 'crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SHELL_PATHS, type ShellManifest } from '../shared/shell-version';
import {
  ASSET_CACHE,
  CHUNK_CACHE,
  LOOK_CACHE,
  ShellCache,
  type ShellRequestContext,
  type ShellRule,
  shellCacheName,
  shellRule,
} from './sw-shell';

const origin = 'https://mac.example.ts.net';

function request(path: string, init: { mode?: string; method?: string; cache?: string } = {}) {
  return {
    url: path.startsWith('http') ? path : `${origin}${path}`,
    mode: init.mode ?? 'cors',
    method: init.method ?? 'GET',
    cache: init.cache ?? 'default',
  } as Request;
}

const keyPath = (key: string | Request) => {
  const url = new URL(typeof key === 'string' ? key : key.url, origin);
  return `${url.pathname}${url.search}`;
};

/** One cache, keyed by path and query. */
class FakeCache {
  entries = new Map<string, Response>();
  async match(key: string | Request) {
    return this.entries.get(keyPath(key))?.clone();
  }
  async put(key: string | Request, response: Response) {
    this.entries.set(keyPath(key), response);
  }
  async keys() {
    return [...this.entries.keys()].map((key) => ({ url: `${origin}${key}` }) as Request);
  }
  async delete(key: string | Request) {
    return this.entries.delete(keyPath(key));
  }
}

class FakeCacheStorage {
  stores = new Map<string, FakeCache>();
  async open(name: string) {
    let cache = this.stores.get(name);
    if (!cache) {
      cache = new FakeCache();
      this.stores.set(name, cache);
    }
    return cache as unknown as Cache;
  }
  async has(name: string) {
    return this.stores.has(name);
  }
  async keys() {
    return [...this.stores.keys()];
  }
  async delete(name: string) {
    return this.stores.delete(name);
  }
}

const sha = (body: string) => createHash('sha256').update(body).digest('hex');

/** The server's disk: shell files, chunks, fonts. */
let disk: Map<string, string>;
let storage: FakeCacheStorage;
let fetchMock: ReturnType<typeof vi.fn<(path: string, init?: RequestInit) => Promise<Response>>>;
let clock: number;
let shell: ShellCache;
let pending: Promise<unknown>[];
let notified: number;
let context: ShellRequestContext;
/** Called after the manifest is served, before the files are (a write landing in between). */
let afterManifest: (() => void) | null;

/** What /bundle/version.json says about the disk now (server/utils/shell-version.ts). */
function manifest(): ShellManifest {
  const files: Record<string, string> = {};
  for (const path of SHELL_PATHS) files[path] = sha(disk.get(path) ?? '');
  const id = sha(SHELL_PATHS.map((path) => files[path]).join(' ')).slice(0, 16);
  const js = /js-build:(\w+)/.exec(disk.get('/bundle/client-bundle.js') ?? '')?.[1] ?? null;
  const css = /css-build:(\w+)/.exec(disk.get('/bundle/styles.css') ?? '')?.[1] ?? null;
  const chunks = [...(disk.get('/bundle/client-bundle.js') ?? '').matchAll(/import (\S+)/g)].map(
    (match) => match[1]
  );
  return {
    id,
    consistent: js === css && chunks.every((chunk) => disk.has(chunk)),
    build: { js, css },
    files,
    chunks,
    allChunks: chunks,
  };
}

/** One build: JS and CSS naming the build, and a chunk the bundle imports. */
function writeJs(build: string) {
  disk.set(`/bundle/chunks/chunk-${build}.js`, `chunk of ${build}`);
  disk.set('/bundle/client-bundle.js', `js-build:${build} import /bundle/chunks/chunk-${build}.js`);
}
function writeCss(build: string) {
  disk.set('/bundle/styles.css', `css-build:${build}`);
}
function deploy(build: string) {
  writeJs(build);
  writeCss(build);
  disk.set('/theme-init.js', 'theme');
  disk.set('/viewport-init.js', 'viewport');
}

/** A page load: every shell file of version `id`, as index.html asks for them. */
async function load(id: string): Promise<Record<string, string>> {
  const bodies: Record<string, string> = {};
  for (const path of SHELL_PATHS) bodies[path] = await get(`${path}?v=${id}`, 'shell');
  return bodies;
}

async function get(path: string, rule: ShellRule) {
  const response = await shell.respond(new URL(path, origin), rule, context);
  const body = await response.text();
  while (pending.length > 0) await Promise.all(pending.splice(0));
  return body;
}

const shellCaches = () =>
  [...storage.stores.keys()].filter((name) => name.startsWith('untether-shell-')).sort();

beforeEach(() => {
  disk = new Map();
  storage = new FakeCacheStorage();
  pending = [];
  notified = 0;
  clock = 1_000_000;
  afterManifest = null;
  fetchMock = vi.fn(async (input: string) => {
    const path = new URL(input, origin).pathname;
    if (path === '/bundle/version.json') {
      const body = JSON.stringify(manifest());
      afterManifest?.();
      afterManifest = null;
      return new Response(body, { status: 200 });
    }
    const body = disk.get(path);
    if (body === undefined) return new Response('missing', { status: 404 });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } });
  });
  shell = new ShellCache({
    caches: storage as unknown as CacheStorage,
    fetch: fetchMock,
    now: () => clock,
  });
  context = {
    waitUntil: (work) => pending.push(work),
    notifyUpdated: async () => {
      notified++;
    },
  };
});

describe('service worker shell: one version, never mixed', () => {
  it('answers versioned shell files, chunks and icons; everything else goes to the network', () => {
    const v = '0123456789abcdef';
    expect(shellRule(request(`/bundle/client-bundle.js?v=${v}`), origin)).toBe('shell');
    expect(shellRule(request(`/bundle/styles.css?v=${v}`), origin)).toBe('shell');
    expect(shellRule(request(`/theme-init.js?v=${v}`), origin)).toBe('shell');
    // The style's sheet must not wait on the network on a cold start: by version.
    expect(shellRule(request(`/looks/cyber-hacker.css?v=${v}`), origin)).toBe('look');
    expect(shellRule(request(`/looks/clay/clay-grano.webp?v=${v}`), origin)).toBe('look');
    expect(shellRule(request(`/looks/nature/nature-papel.webp?v=${v}`), origin)).toBe('look');
    // Without a version nothing says which bytes a copy would be: the network.
    expect(shellRule(request('/looks/cyber-hacker.css'), origin)).toBeNull();
    expect(shellRule(request('/looks/clay/clay-grano.webp'), origin)).toBeNull();
    expect(shellRule(request('/looks/nature/nature-papel.webp'), origin)).toBeNull();
    expect(shellRule(request('/looks/cyber-hacker.css?v=nothex'), origin)).toBeNull();
    expect(
      shellRule(request(`/looks/cyber-hacker.css?v=${v}`, { cache: 'reload' }), origin)
    ).toBeNull();
    expect(shellRule(request(`https://other.example/looks/clay.css?v=${v}`), origin)).toBeNull();
    expect(shellRule(request('/bundle/chunks/deferred-views-CI45QLPT.js'), origin)).toBe('chunk');
    expect(shellRule(request('/fonts/hack-core-regular.woff2'), origin)).toBe('static');
    expect(shellRule(request('/apple-touch-icon.png'), origin)).toBe('static');

    // Unversioned (logs.html, deploy-4020.sh's curl, the version watch): the network.
    expect(shellRule(request('/bundle/client-bundle.js'), origin)).toBeNull();
    expect(shellRule(request('/bundle/client-bundle.js?v=nothex'), origin)).toBeNull();
    expect(shellRule(request(`/bundle/client-bundle.js?v=${v}&x=1`), origin)).toBeNull();
    expect(shellRule(request('/bundle/version.json'), origin)).toBeNull();
    expect(shellRule(request('/api/sessions'), origin)).toBeNull();
    expect(shellRule(request('/', { mode: 'navigate' }), origin)).toBeNull();
    expect(shellRule(request('/sw.js'), origin)).toBeNull();
    expect(shellRule(request('/splash/750x1334-light.png'), origin)).toBeNull();
    expect(shellRule(request('/ghostty-vt.wasm'), origin)).toBeNull();
    expect(shellRule(request('/manifest.json'), origin)).toBeNull();
    expect(
      shellRule(request(`/bundle/client-bundle.js?v=${v}`, { method: 'HEAD' }), origin)
    ).toBeNull();
    expect(
      shellRule(request(`/bundle/client-bundle.js?v=${v}`, { cache: 'no-store' }), origin)
    ).toBeNull();
    expect(
      shellRule(request(`https://cdn.example/bundle/client-bundle.js?v=${v}`), origin)
    ).toBeNull();
  });

  it('installs a version whole before serving it, then serves it with no network', async () => {
    deploy('b1');
    const v1 = manifest().id;
    const page = await load(v1);
    expect(page['/bundle/client-bundle.js']).toContain('js-build:b1');
    expect(page['/bundle/styles.css']).toBe('css-build:b1');
    const cache = storage.stores.get(shellCacheName(v1));
    expect([...(cache?.entries.keys() ?? [])].sort()).toEqual(
      [...SHELL_PATHS, '/__ut-shell-complete.json'].sort()
    );
    // The chunk the bundle imports came with it.
    expect(storage.stores.get(CHUNK_CACHE)?.entries.has('/bundle/chunks/chunk-b1.js')).toBe(true);

    fetchMock.mockClear();
    fetchMock.mockRejectedValue(new TypeError('Load failed')); // Mac unreachable
    expect(await load(v1)).toEqual(page);
    expect(await get('/bundle/chunks/chunk-b1.js', 'chunk')).toBe('chunk of b1');
    expect(notified).toBe(0);
  });

  it('a deploy swaps to the new version for all files at once', async () => {
    deploy('b1');
    const v1 = manifest().id;
    await load(v1);
    deploy('b2');
    const v2 = manifest().id;
    expect(v2).not.toBe(v1);

    const page = await load(v2);
    expect(page['/bundle/client-bundle.js']).toContain('js-build:b2');
    expect(page['/bundle/styles.css']).toBe('css-build:b2');
    // The page still open on b1 keeps its version (two are kept).
    expect((await load(v1))['/bundle/styles.css']).toBe('css-build:b1');
  });

  it('never pairs a new JS with an old CSS while the stylesheet is still being written', async () => {
    deploy('b1');
    const v1 = manifest().id;
    await load(v1);

    // Dev mode: esbuild wrote b2's bundle, postcss hasn't written b2's stylesheet yet.
    writeJs('b2');
    const half = manifest();
    expect(half.consistent).toBe(false);
    const page = await load(half.id);
    // The whole previous version, not new JS with old CSS.
    expect(page['/bundle/client-bundle.js']).toContain('js-build:b1');
    expect(page['/bundle/styles.css']).toBe('css-build:b1');
    expect(storage.stores.has(shellCacheName(half.id))).toBe(false);

    // The stylesheet lands: the next load gets b2 whole, and the page above is told.
    writeCss('b2');
    const v2 = manifest().id;
    clock += 20_000;
    await load(half.id); // a later file request of that page kicks the check behind it
    expect(notified).toBeGreaterThanOrEqual(1);
    const fresh = await load(v2);
    expect(fresh['/bundle/client-bundle.js']).toContain('js-build:b2');
    expect(fresh['/bundle/styles.css']).toBe('css-build:b2');
  });

  it('keeps giving one page the same substitute even when a newer version comes in meanwhile', async () => {
    deploy('b1');
    const v1 = manifest().id;
    await load(v1);
    writeJs('b2');
    const half = manifest().id;
    expect(await get(`/bundle/client-bundle.js?v=${half}`, 'shell')).toContain('js-build:b1');
    // b2's stylesheet lands and b2 is installed before this page's next file is asked for.
    writeCss('b2');
    await load(manifest().id);
    expect(await get(`/bundle/styles.css?v=${half}`, 'shell')).toBe('css-build:b1');
  });

  it('stores nothing of a version whose files change while it is fetched', async () => {
    deploy('b1');
    const v1 = manifest().id;
    await load(v1);
    deploy('b2');
    const v2 = manifest().id;
    afterManifest = () => writeCss('b3'); // the CSS changes under the install
    const page = await load(v2);
    expect(page['/bundle/client-bundle.js']).toContain('js-build:b1');
    expect(page['/bundle/styles.css']).toBe('css-build:b1');
    expect(storage.stores.get(shellCacheName(v2))?.entries.size ?? 0).toBe(0);
  });

  it('a version whose bundle needs a chunk the server lacks is not served', async () => {
    deploy('b1');
    disk.delete('/bundle/chunks/chunk-b1.js');
    const v1 = manifest().id;
    const page = await load(v1);
    // No complete version yet: the network, as before the worker.
    expect(page['/bundle/client-bundle.js']).toContain('js-build:b1');
    expect(await shell.versions()).toEqual([]);
  });

  it('keeps two versions and deletes older ones and their unused chunks', async () => {
    const ids: string[] = [];
    for (const build of ['b1', 'b2', 'b3']) {
      deploy(build);
      ids.push(manifest().id);
      clock += 1000;
      await load(manifest().id);
    }
    expect(shellCaches()).toEqual([shellCacheName(ids[1]), shellCacheName(ids[2])].sort());
    expect([...(storage.stores.get(CHUNK_CACHE)?.entries.keys() ?? [])].sort()).toEqual([
      '/bundle/chunks/chunk-b2.js',
      '/bundle/chunks/chunk-b3.js',
    ]);
  });

  it('prune drops a half-installed version left by a worker that died', async () => {
    const orphan = await storage.open(shellCacheName('feedfacefeedface'));
    await orphan.put('/bundle/client-bundle.js', new Response('half'));
    deploy('b1');
    await load(manifest().id);
    expect(shellCaches()).toEqual([shellCacheName(manifest().id)]);
  });

  it('install event: the current version and the terminal font, so the next cold start is offline-proof', async () => {
    deploy('b1');
    disk.set('/fonts/hack-core-regular.woff2', 'regular');
    disk.set('/fonts/hack-core-bold.woff2', 'bold');
    await shell.precache();
    expect((await shell.versions()).map((v) => v.id)).toEqual([manifest().id]);
    expect([...(storage.stores.get(ASSET_CACHE)?.entries.keys() ?? [])].sort()).toEqual([
      '/fonts/hack-core-bold.woff2',
      '/fonts/hack-core-regular.woff2',
    ]);
    fetchMock.mockRejectedValue(new TypeError('Load failed'));
    expect(await get('/fonts/hack-core-regular.woff2', 'static')).toBe('regular');
    expect((await load(manifest().id))['/bundle/styles.css']).toBe('css-build:b1');
  });

  it('a chunk is fetched once: its name is its content', async () => {
    disk.set('/bundle/chunks/deferred-views-CI45QLPT.js', 'views');
    expect(await get('/bundle/chunks/deferred-views-CI45QLPT.js', 'chunk')).toBe('views');
    expect(await get('/bundle/chunks/deferred-views-CI45QLPT.js', 'chunk')).toBe('views');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('error answers are passed through and never cached', async () => {
    const response = await shell.respond(
      new URL('/bundle/chunks/gone-0000.js', origin),
      'chunk',
      context
    );
    expect(response.status).toBe(404);
    expect(storage.stores.get(CHUNK_CACHE)?.entries.size ?? 0).toBe(0);
  });

  it('a changed font or icon is picked up without telling the page', async () => {
    disk.set('/apple-touch-icon.png', 'icon1');
    await get('/apple-touch-icon.png', 'static');
    disk.set('/apple-touch-icon.png', 'icon2');
    expect(await get('/apple-touch-icon.png', 'static')).toBe('icon1');
    expect(await get('/apple-touch-icon.png', 'static')).toBe('icon2');
    expect(notified).toBe(0);
  });

  describe('interface styles: the first load after a change shows the new sheet', () => {
    /** What index.html (always from the network) names a look file: its content's hash. */
    const versioned = (path: string) => `${path}?v=${sha(disk.get(path) as string).slice(0, 16)}`;
    const lookEntries = () => [...(storage.stores.get(LOOK_CACHE)?.entries.keys() ?? [])].sort();
    const fetched = (path: string) =>
      fetchMock.mock.calls.filter(([input]) => new URL(input, origin).pathname === path).length;

    it('a sheet changed on the server is painted by the very next load, not the one after', async () => {
      const path = '/looks/japandi.css';
      disk.set(path, 'japandi before the merge');
      expect(await get(versioned(path), 'look')).toBe('japandi before the merge');
      // The merge: the server has another sheet, and the next page names it.
      disk.set(path, 'japandi after the merge');
      expect(await get(versioned(path), 'look')).toBe('japandi after the merge');
      // Only the current version is kept.
      expect(lookEntries()).toEqual([versioned(path)]);
    });

    it('a cold start with the version already cached needs no network', async () => {
      const sheet = '/looks/clay.css';
      const texture = '/looks/clay/clay-grano.webp';
      disk.set(sheet, 'clay sheet');
      disk.set(texture, 'clay grain');
      await get(versioned(sheet), 'look');
      await get(versioned(texture), 'look');
      fetchMock.mockClear();
      fetchMock.mockRejectedValue(new TypeError('Offline'));
      expect(await get(versioned(sheet), 'look')).toBe('clay sheet');
      expect(await get(versioned(texture), 'look')).toBe('clay grain');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('an unchanged sheet is never fetched again, load after load', async () => {
      const path = '/looks/japandi.css';
      disk.set(path, 'japandi');
      for (let i = 0; i < 3; i++) expect(await get(versioned(path), 'look')).toBe('japandi');
      expect(fetched(path)).toBe(1);
    });

    it.each([
      'clay-grano.webp',
      'clay-grano-fuerte.webp',
      'clay-huellas.webp',
      'clay-borde-hinchado.png',
    ])('the texture %s changes with the first load that names its new version', async (name) => {
      const path = `/looks/clay/${name}`;
      disk.set(path, 'texture-v1');
      const first = versioned(path);
      expect(await get(first, 'look')).toBe('texture-v1');
      disk.set(path, 'texture-v2');
      // A page still open on the old sheet keeps its texture, with no network.
      expect(await get(first, 'look')).toBe('texture-v1');
      expect(fetched(path)).toBe(1);
      expect(await get(versioned(path), 'look')).toBe('texture-v2');
      fetchMock.mockRejectedValue(new TypeError('Offline'));
      expect(await get(versioned(path), 'look')).toBe('texture-v2');
      expect(lookEntries()).toEqual([versioned(path)]);
    });

    it('a sheet that changed again since the page was served is shown but not kept under the old name', async () => {
      const path = '/looks/japandi.css';
      disk.set(path, 'one');
      const named = versioned(path);
      disk.set(path, 'two');
      expect(await get(named, 'look')).toBe('two');
      expect(lookEntries()).toEqual([]);
      // The next page names the sheet on disk: stored then.
      expect(await get(versioned(path), 'look')).toBe('two');
      expect(lookEntries()).toEqual([versioned(path)]);
    });

    it('without the network a new version falls back to the earlier one, and fails with none', async () => {
      const path = '/looks/japandi.css';
      disk.set(path, 'old');
      await get(versioned(path), 'look');
      disk.set(path, 'new');
      const next = versioned(path);
      fetchMock.mockRejectedValue(new TypeError('Offline'));
      expect(await get(next, 'look')).toBe('old');
      await expect(
        shell.respond(new URL('/looks/never-seen.css?v=0123456789abcdef', origin), 'look', context)
      ).rejects.toThrow('Offline');
    });

    it('a missing sheet is passed through and never cached', async () => {
      const response = await shell.respond(
        new URL('/looks/gone.css?v=0123456789abcdef', origin),
        'look',
        context
      );
      expect(response.status).toBe(404);
      expect(lookEntries()).toEqual([]);
    });
  });
});
