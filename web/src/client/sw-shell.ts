/**
 * App shell cache for the installed web app (docs/cold-start.md). The service worker answers the
 * client's files from its own cache, so a cold start doesn't wait on the network for them.
 *
 * The shell (client-bundle.js, styles.css, the two init scripts) is one version, never mixed
 * (2026-10-04, shared/shell-version.ts). Each file used to be cached and revalidated on its own,
 * so after a deploy a page could run the new JS with the old CSS (a new picker's markup with the
 * old styles, until a later reload). Now:
 *
 * - index.html (always from the network) asks for the shell as `<file>?v=<id>`;
 * - each version has a cache of its own, `untether-shell-v2-<id>`, filled whole before any of
 *   it is served: the server's manifest (/bundle/version.json) must name that id and a
 *   consistent pair, every file must match the manifest's digest and every chunk the bundle
 *   imports must load; only then are they stored, and a marker last (`install`). A cache
 *   without the marker is never served;
 * - when a version can't be had whole (the server moved on meanwhile, or its bundle and
 *   stylesheet were from two builds) the page gets the newest complete version instead, the
 *   same one for all its files, and is told when a newer one is in (`SHELL_UPDATED_MESSAGE`);
 *   with none, the network as before;
 * - the two newest versions are kept, older ones deleted with the chunks only they used.
 *
 * Lazy chunks (bundle/chunks/*.js, named by a hash of their content): cache first, in a cache of
 * their own. A name always stands for the same bytes; the version's manifest lists the chunks its
 * bundle imports, and the server only calls a version consistent when they all exist.
 *
 * The interface styles' sheets and textures (looks/*, 2026-11-10): cache first, by version. They
 * were stale-while-revalidate with no message, so the first load after a style changed on the
 * server painted the OLD sheet and only the second the new one (on the iPhone: close and open
 * the app twice; Japandi, and Clay three times). Now each is asked for as `<file>?v=<hash of its
 * content>`: index.html (always from the network) names the sheets' versions and each sheet its
 * textures' (shared/shell-version.ts LOOK_VERSIONS_META). A version in the cache is served with
 * no network; one that isn't is fetched, checked against the hash it is named by and stored in
 * place of the file's earlier version, so a changed sheet shows on the first load. Without the
 * network an earlier version of the file is better than none. Unversioned looks/* URLs go to
 * the network.
 *
 * Fonts and icons: stale-while-revalidate, no message. The terminal font's two core files are
 * cached on install (PRECACHED_STATIC): the terminal waits for them before it draws
 * (utils/terminal-fonts.ts), so they must not need the network on a cold start either.
 *
 * Page loads (navigations) are untouched: network first with the offline page (sw-offline.ts).
 * API calls, sw.js, the WASM, unversioned shell URLs (logs.html) and everything else go to the
 * network. Requests made with `cache: 'no-store'` or `'reload'` always do.
 */
import {
  SHELL_PATHS,
  SHELL_VERSION_PARAM,
  SHELL_VERSION_URL,
  type ShellManifest,
} from '../shared/shell-version.js';

export const SHELL_CACHE_PREFIX = 'untether-shell-v2-';
export const CHUNK_CACHE = 'untether-chunks-v1';
export const ASSET_CACHE = 'untether-assets-v1';
export const LOOK_CACHE = 'untether-looks-v1';
/** Stored last in a version's cache: the version is whole. */
const COMPLETE_MARKER = '/__ut-shell-complete.json';
/** Versions kept: the current one and the one before (pages still open on it). */
const KEEP_VERSIONS = 2;
/** A version that couldn't be installed isn't tried again this soon (one page load's files). */
const RETRY_AFTER_MS = 10_000;

/** Posted to a page that got an older version than it asked for, once a newer one is in. */
export const SHELL_UPDATED_MESSAGE = 'ut-shell-updated';

/** Fonts the first screen needs, cached on install (not part of a version). */
export const PRECACHED_STATIC = ['/fonts/hack-core-regular.woff2', '/fonts/hack-core-bold.woff2'];

const STATIC_PATTERN =
  /^\/(fonts\/[^/]+\.(woff2?|ttf)|apple-touch-icon\.png|icon-(192|512|maskable-512)\.png|favicon(-\d+)?\.(png|ico|svg))$/;
const LOOK_PATTERN = /^\/looks\/([a-z0-9-]+\.css|[a-z0-9-]+\/[a-z0-9-]+\.(webp|png))$/;
const CHUNK_PATTERN = /^\/bundle\/chunks\/[^/]+\.js$/;
const VERSION_ID = /^[0-9a-f]{16}$/;

export type ShellRule = 'shell' | 'chunk' | 'look' | 'static';

export function shellCacheName(id: string): string {
  return `${SHELL_CACHE_PREFIX}${id}`;
}

/** The shell version a URL asks for (`?v=<id>` and nothing else), or null. */
export function requestedVersion(url: URL): string | null {
  const keys = [...url.searchParams.keys()];
  if (keys.length !== 1 || keys[0] !== SHELL_VERSION_PARAM) return null;
  const id = url.searchParams.get(SHELL_VERSION_PARAM) ?? '';
  return VERSION_ID.test(id) ? id : null;
}

/** How the worker answers a request, or null for "straight to the network". */
export function shellRule(request: Request, origin: string): ShellRule | null {
  if (request.method !== 'GET' || request.mode === 'navigate') return null;
  if (request.cache === 'no-store' || request.cache === 'reload') return null;
  const url = new URL(request.url);
  if (url.origin !== origin) return null;
  if ((SHELL_PATHS as readonly string[]).includes(url.pathname)) {
    return requestedVersion(url) ? 'shell' : null;
  }
  if (LOOK_PATTERN.test(url.pathname)) return requestedVersion(url) ? 'look' : null;
  if (url.search) return null;
  if (CHUNK_PATTERN.test(url.pathname)) return 'chunk';
  if (STATIC_PATTERN.test(url.pathname)) return 'static';
  return null;
}

export interface ShellEnv {
  caches: Pick<CacheStorage, 'open' | 'has' | 'keys' | 'delete'>;
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  now?: () => number;
}

/** Per request: keep the worker alive for work after the response, tell the page. */
export interface ShellRequestContext {
  waitUntil: (work: Promise<unknown>) => void;
  /** Tells the page that a newer version than the one it got is in. */
  notifyUpdated: () => Promise<void>;
}

interface CompleteMarker {
  id: string;
  installedAt: number;
  manifest: ShellManifest;
}

const cacheable = (response: Response) => response.ok && response.type !== 'opaque';

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Headers worth keeping on a stored copy (the body is stored decoded). */
function storedHeaders(response: Response): Headers {
  const headers = new Headers();
  for (const name of ['content-type', 'etag', 'last-modified']) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

function isManifest(value: unknown): value is ShellManifest {
  const manifest = value as ShellManifest | null;
  return (
    !!manifest &&
    typeof manifest.id === 'string' &&
    VERSION_ID.test(manifest.id) &&
    typeof manifest.consistent === 'boolean' &&
    !!manifest.files &&
    SHELL_PATHS.every((path) => typeof manifest.files[path] === 'string') &&
    Array.isArray(manifest.chunks) &&
    Array.isArray(manifest.allChunks)
  );
}

export class ShellCache {
  private readonly installing = new Map<string, Promise<string | null>>();
  private readonly failedAt = new Map<string, number>();
  /** The version each requested-but-unavailable version is answered with (null: the network). */
  private readonly substitutes = new Map<string, { id: string | null; at: number }>();

  constructor(private readonly env: ShellEnv) {}

  private now(): number {
    return this.env.now?.() ?? Date.now();
  }

  private async marker(id: string): Promise<CompleteMarker | null> {
    const name = shellCacheName(id);
    if (!(await this.env.caches.has(name))) return null;
    const response = await (await this.env.caches.open(name)).match(COMPLETE_MARKER);
    return response ? ((await response.json()) as CompleteMarker) : null;
  }

  /** A file of a complete version, or undefined. */
  private async match(id: string, path: string): Promise<Response | undefined> {
    if (!(await this.marker(id))) return undefined;
    return (await this.env.caches.open(shellCacheName(id))).match(path);
  }

  /** The complete versions, newest first. */
  async versions(): Promise<CompleteMarker[]> {
    const names = (await this.env.caches.keys()).filter((name) =>
      name.startsWith(SHELL_CACHE_PREFIX)
    );
    const markers = await Promise.all(
      names.map((name) => this.marker(name.slice(SHELL_CACHE_PREFIX.length)).catch(() => null))
    );
    return markers
      .filter((marker): marker is CompleteMarker => marker !== null)
      .sort((a, b) => b.installedAt - a.installedAt);
  }

  private async fetchManifest(): Promise<ShellManifest | null> {
    const response = await this.env.fetch(SHELL_VERSION_URL, { cache: 'no-store' });
    if (!response.ok) return null;
    const manifest: unknown = await response.json();
    return isManifest(manifest) ? manifest : null;
  }

  /**
   * Installs the server's current version, or `expected` only if that is the current one.
   * Everything is fetched and checked first, then stored, the marker last. Returns the
   * installed id, or null.
   */
  async install(expected?: string): Promise<string | null> {
    const manifest = await this.fetchManifest();
    if (!manifest?.consistent) return null;
    if (expected && manifest.id !== expected) return null;
    const running = this.installing.get(manifest.id);
    if (running) return running;
    const work = this.installManifest(manifest).finally(() => this.installing.delete(manifest.id));
    this.installing.set(manifest.id, work);
    return work;
  }

  private async installManifest(manifest: ShellManifest): Promise<string | null> {
    if (await this.marker(manifest.id)) return manifest.id;
    const files = await Promise.all(
      SHELL_PATHS.map(async (path) => {
        const response = await this.env.fetch(`${path}?${SHELL_VERSION_PARAM}=${manifest.id}`, {
          cache: 'no-cache',
        });
        if (!cacheable(response)) throw new Error(`${path}: ${response.status}`);
        const body = await response.arrayBuffer();
        // Another build on disk since the manifest: this version is gone.
        if ((await sha256Hex(body)) !== manifest.files[path]) throw new Error(`${path} changed`);
        return { path, body, headers: storedHeaders(response) };
      })
    );
    const chunkCache = await this.env.caches.open(CHUNK_CACHE);
    const chunks = await Promise.all(
      manifest.chunks.map(async (path) => {
        if (await chunkCache.match(path)) return null;
        const response = await this.env.fetch(path);
        if (!cacheable(response)) throw new Error(`${path}: ${response.status}`);
        return { path, response };
      })
    );
    const cache = await this.env.caches.open(shellCacheName(manifest.id));
    await Promise.all(
      files.map(({ path, body, headers }) =>
        cache.put(path, new Response(body, { status: 200, headers }))
      )
    );
    await Promise.all(
      chunks.map((chunk) => (chunk ? chunkCache.put(chunk.path, chunk.response) : null))
    );
    const marker: CompleteMarker = { id: manifest.id, installedAt: this.now(), manifest };
    await cache.put(
      COMPLETE_MARKER,
      new Response(JSON.stringify(marker), { headers: { 'content-type': 'application/json' } })
    );
    await this.prune().catch(() => {});
    return manifest.id;
  }

  /** Whether version `id` is (now) complete; one attempt per RETRY_AFTER_MS. */
  private async ensure(id: string): Promise<boolean> {
    if (await this.marker(id)) return true;
    const failed = this.failedAt.get(id);
    if (failed !== undefined && this.now() - failed < RETRY_AFTER_MS) return false;
    const installed = (await this.install(id).catch(() => null)) === id;
    if (!installed) this.failedAt.set(id, this.now());
    return installed;
  }

  /** Keeps the newest complete versions and the chunks they use; deletes the rest. */
  async prune(): Promise<void> {
    const kept = (await this.versions()).slice(0, KEEP_VERSIONS);
    const keep = new Set(kept.map((v) => shellCacheName(v.id)));
    for (const id of this.installing.keys()) keep.add(shellCacheName(id));
    const names = await this.env.caches.keys();
    await Promise.all(
      names
        .filter((name) => name.startsWith(SHELL_CACHE_PREFIX) && !keep.has(name))
        .map((name) => this.env.caches.delete(name))
    );
    // Chunks: only when no other version is half-way in (its chunks have no marker yet).
    const keptIds = new Set(kept.map((v) => v.id));
    if (kept.length === 0 || [...this.installing.keys()].some((id) => !keptIds.has(id))) return;
    const used = new Set(kept.flatMap((v) => [...v.manifest.chunks, ...v.manifest.allChunks]));
    const chunkCache = await this.env.caches.open(CHUNK_CACHE);
    const keys = await chunkCache.keys();
    await Promise.all(
      keys
        .filter((key) => !used.has(new URL(key.url).pathname))
        .map((key) => chunkCache.delete(key))
    );
  }

  /** The version a page asking for unavailable `id` gets: the same for all its files. */
  private async substitute(id: string): Promise<string | null> {
    const pinned = this.substitutes.get(id);
    if (pinned && this.now() - pinned.at < RETRY_AFTER_MS) return pinned.id;
    const newest = (await this.versions())[0]?.id ?? null;
    this.substitutes.set(id, { id: newest, at: this.now() });
    return newest;
  }

  /** The worker's answer for a request `shellRule` gave a rule for. */
  async respond(url: URL, rule: ShellRule, context: ShellRequestContext): Promise<Response> {
    const path = url.pathname;
    try {
      if (rule === 'shell') return await this.respondShell(url, context);
      if (rule === 'chunk') return await this.respondChunk(path, context);
      if (rule === 'look') return await this.respondLook(url, context);
      return await this.respondStatic(path, context);
    } catch {
      // Cache Storage unavailable (private mode, quota): the network as before.
      return this.env.fetch(rule === 'look' ? `${path}${url.search}` : path);
    }
  }

  private async respondShell(url: URL, context: ShellRequestContext): Promise<Response> {
    const path = url.pathname;
    const id = requestedVersion(url) as string;
    const cached = await this.match(id, path);
    if (cached) return cached;
    if (await this.ensure(id)) {
      const installed = await this.match(id, path);
      if (installed) return installed;
    }
    const other = await this.substitute(id);
    const substitute = other ? await this.match(other, path) : undefined;
    if (other && substitute) {
      context.waitUntil(
        this.install()
          .then((installed) => (installed && installed !== other ? context.notifyUpdated() : null))
          .catch(() => {})
      );
      return substitute;
    }
    return this.env.fetch(path);
  }

  private async respondChunk(path: string, context: ShellRequestContext): Promise<Response> {
    const cache = await this.env.caches.open(CHUNK_CACHE);
    const cached = await cache.match(path);
    if (cached) return cached;
    const response = await this.env.fetch(path);
    if (cacheable(response)) context.waitUntil(cache.put(path, response.clone()).catch(() => {}));
    return response;
  }

  /**
   * A style's sheet or texture by version (`?v=<hash of its content>`): the cache's copy with no
   * network; otherwise the server's, stored in place of the file's earlier versions when it is
   * what its name says (the file changed again since the page was served otherwise: the next
   * page names that one). Without the network, an earlier version of the file.
   */
  private async respondLook(url: URL, context: ShellRequestContext): Promise<Response> {
    const key = `${url.pathname}${url.search}`;
    const cache = await this.env.caches.open(LOOK_CACHE);
    const cached = await cache.match(key);
    if (cached) return cached;
    const earlier = async () => {
      const keys = await cache.keys();
      const other = keys.find((request) => new URL(request.url).pathname === url.pathname);
      return other ? cache.match(other) : undefined;
    };
    let response: Response;
    try {
      response = await this.env.fetch(key, { cache: 'no-cache' });
    } catch (error) {
      const fallback = await earlier();
      if (fallback) return fallback;
      throw error;
    }
    if (!cacheable(response)) return (response.status >= 500 && (await earlier())) || response;
    const body = await response.clone().arrayBuffer();
    if ((await sha256Hex(body)).startsWith(requestedVersion(url) as string)) {
      const stored = new Response(body, { status: 200, headers: storedHeaders(response) });
      context.waitUntil(
        (async () => {
          await cache.put(key, stored);
          const keys = await cache.keys();
          await Promise.all(
            keys
              .filter((request) => {
                const other = new URL(request.url);
                return other.pathname === url.pathname && other.search !== url.search;
              })
              .map((request) => cache.delete(request))
          );
        })().catch(() => {})
      );
    }
    return response;
  }

  private async respondStatic(path: string, context: ShellRequestContext): Promise<Response> {
    const cache = await this.env.caches.open(ASSET_CACHE);
    const cached = await cache.match(path);
    if (cached) {
      context.waitUntil(
        this.env
          .fetch(path, { cache: 'no-cache' })
          .then((fresh) => (cacheable(fresh) ? cache.put(path, fresh) : undefined))
          .catch(() => {})
      );
      return cached;
    }
    const response = await this.env.fetch(path);
    if (cacheable(response)) context.waitUntil(cache.put(path, response.clone()).catch(() => {}));
    return response;
  }

  /**
   * On install: the server's current version and the terminal's core font, so the next cold
   * start needs no network for them. Best effort.
   */
  async precache(): Promise<void> {
    const assets = await this.env.caches.open(ASSET_CACHE);
    await Promise.all([
      this.install().catch(() => null),
      ...PRECACHED_STATIC.map(async (path) => {
        try {
          const response = await this.env.fetch(path, { cache: 'no-cache' });
          if (cacheable(response)) await assets.put(path, response);
        } catch {
          // Offline: fetched on first use.
        }
      }),
    ]);
  }
}
