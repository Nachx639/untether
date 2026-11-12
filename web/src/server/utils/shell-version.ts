import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { findLook, lookBoot, ORIGINAL_LOOK_ID } from '../../shared/looks.js';
import {
  buildIdInBundle,
  buildIdInCss,
  buildsDiffer,
  LOOK_VERSIONS_META,
  SHELL_PATHS,
  SHELL_VERSION_PARAM,
  type ShellManifest,
} from '../../shared/shell-version.js';

/**
 * The client's shell on disk as one version (2026-10-04, shared/shell-version.ts): its id, a hash
 * of the four files' contents, whether the bundle and the stylesheet are from one build, the
 * files' digests and the chunks the bundle needs. Recomputed only when a file's size or mtime
 * changes.
 *
 * In dev mode (4020) the bundle is written before the stylesheet; in between the pair is not
 * consistent, and `settled()` waits (up to a few seconds) for the stylesheet before answering,
 * so index.html and /bundle/version.json name a whole build.
 */

const STATIC_IMPORT = /(?:\bfrom|\bimport)\s*["']\.\/((?:chunks\/)?[\w.-]+\.js)["']/g;
const ANY_CHUNK_REF = /["']\.\/((?:chunks\/)?[\w.-]+\.js)["']/g;

function chunkRefs(text: string, pattern: RegExp, fromChunk: boolean): string[] {
  const refs: string[] = [];
  for (const match of text.matchAll(pattern)) {
    const ref = match[1];
    if (fromChunk) {
      if (!ref.includes('/')) refs.push(`/bundle/chunks/${ref}`);
    } else if (ref.startsWith('chunks/')) {
      refs.push(`/bundle/${ref}`);
    }
  }
  return refs;
}

export class ShellVersion {
  private cached: { key: string; manifest: ShellManifest } | null = null;
  private reportedInconsistent: string | null = null;

  /**
   * @param onInconsistent called once per shell id that stays inconsistent: the service worker
   *   won't install it, so phones keep the previous version until the pair is whole again.
   */
  constructor(
    private readonly publicPath: string,
    private readonly onInconsistent?: (manifest: ShellManifest) => void
  ) {}

  private file(urlPath: string): string {
    return path.join(this.publicPath, ...urlPath.split('/').filter(Boolean));
  }

  private statKey(): string | null {
    const parts: string[] = [];
    for (const urlPath of SHELL_PATHS) {
      try {
        const stat = fs.statSync(this.file(urlPath));
        parts.push(`${stat.size}-${stat.mtimeMs}`);
      } catch {
        return null;
      }
    }
    return parts.join(' ');
  }

  /**
   * The chunk files the entry imports statically, theirs included (null when one is missing),
   * and every chunk those files name, lazy ones (views, locales) included.
   */
  private chunksOf(entry: string): { needed: string[] | null; all: string[] } {
    const all = new Set(chunkRefs(entry, ANY_CHUNK_REF, false));
    const needed = new Set<string>();
    const queue = chunkRefs(entry, STATIC_IMPORT, false);
    let missing = false;
    while (queue.length > 0) {
      const chunk = queue.shift() as string;
      if (needed.has(chunk)) continue;
      needed.add(chunk);
      let text: string;
      try {
        text = fs.readFileSync(this.file(chunk), 'utf8');
      } catch {
        missing = true;
        continue;
      }
      queue.push(...chunkRefs(text, STATIC_IMPORT, true));
      for (const ref of chunkRefs(text, ANY_CHUNK_REF, true)) all.add(ref);
    }
    for (const chunk of needed) all.add(chunk);
    return { needed: missing ? null : [...needed].sort(), all: [...all].sort() };
  }

  /** The shell on disk now; null when a file is missing (no build yet). */
  current(): ShellManifest | null {
    const key = this.statKey();
    if (!key) return null;
    // Chunks are checked on every call while the pair is not consistent (one may be on its way).
    if (this.cached?.key === key && this.cached.manifest.consistent) return this.cached.manifest;
    const files: Record<string, string> = {};
    const contents: Record<string, Buffer> = {};
    const id = createHash('sha256');
    for (const urlPath of SHELL_PATHS) {
      let data: Buffer;
      try {
        data = fs.readFileSync(this.file(urlPath));
      } catch {
        return null;
      }
      contents[urlPath] = data;
      files[urlPath] = createHash('sha256').update(data).digest('hex');
      id.update(urlPath).update('\0').update(files[urlPath]).update('\0');
    }
    const entry = contents['/bundle/client-bundle.js'].toString('utf8');
    const js = buildIdInBundle(entry);
    const css = buildIdInCss(contents['/bundle/styles.css'].toString('utf8'));
    const chunks = this.chunksOf(entry);
    const manifest: ShellManifest = {
      id: id.digest('hex').slice(0, 16),
      consistent: chunks.needed !== null && !buildsDiffer(js, css),
      build: { js, css },
      files,
      chunks: chunks.needed ?? [],
      allChunks: chunks.all,
    };
    // A file rewritten while it was read gives another stat next time: read again then.
    if (this.statKey() === key) this.cached = { key, manifest };
    return manifest;
  }

  /** Milliseconds since the newest shell file was written. */
  private age(): number {
    let newest = 0;
    for (const urlPath of SHELL_PATHS) {
      try {
        newest = Math.max(newest, fs.statSync(this.file(urlPath)).mtimeMs);
      } catch {
        // Missing: current() says so.
      }
    }
    return Date.now() - newest;
  }

  /**
   * The shell once it is consistent, or as it is after `timeoutMs`. Only a pair written in the
   * last `freshMs` is waited for: one that stays inconsistent (the stylesheet watcher died, its
   * build fails) is answered at once, and logged once.
   */
  async settled(timeoutMs = 3000, pollMs = 100, freshMs = 10_000): Promise<ShellManifest | null> {
    const deadline = Date.now() + timeoutMs;
    let manifest = this.current();
    while (manifest && !manifest.consistent && Date.now() < deadline && this.age() < freshMs) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      manifest = this.current();
    }
    if (manifest && !manifest.consistent && manifest.id !== this.reportedInconsistent) {
      this.reportedInconsistent = manifest.id;
      this.onInconsistent?.(manifest);
    }
    return manifest;
  }
}

/** index.html with the shell files' URLs naming the version (`?v=<id>`); attributes only. */
export function versionShellUrls(html: string, id: string): string {
  let out = html;
  for (const urlPath of SHELL_PATHS) {
    const escaped = urlPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(
      new RegExp(`(\\s(?:href|src)=")${escaped}(")`, 'g'),
      `$1${urlPath}?${SHELL_VERSION_PARAM}=${id}$2`
    );
  }
  return out;
}

/**
 * index.html with the server's default style in its meta tag, for the inline theme script: a new
 * device has its style in the first frame instead of after /api/config. An unknown id adds nothing.
 */
export function withServerLook(html: string, id: string | undefined): string {
  const look = findLook(id);
  if (!look || look.id === ORIGINAL_LOOK_ID) return html;
  const content = JSON.stringify(lookBoot(look)).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return html.replace(
    '<meta name="ut-server-look" content="" />',
    () => `<meta name="ut-server-look" content="${content}" />`
  );
}

/**
 * The version of each interface style's sheet on disk (public/looks/<id>.css): the first 16 hex
 * characters of its SHA-256 (2026-11-10, shared/shell-version.ts). Recomputed only when a sheet's
 * size or mtime changes, or one comes or goes.
 */
export class LookVersions {
  private cached: { key: string; versions: Record<string, string> } | null = null;

  constructor(private readonly publicPath: string) {}

  private sheets(): { key: string; files: { id: string; file: string }[] } {
    const dir = path.join(this.publicPath, 'looks');
    const files: { id: string; file: string }[] = [];
    const parts: string[] = [];
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir).sort();
    } catch {
      // No build yet: no versions.
    }
    for (const name of names) {
      const id = /^([a-z0-9-]+)\.css$/.exec(name)?.[1];
      if (!id) continue;
      const file = path.join(dir, name);
      try {
        const stat = fs.statSync(file);
        parts.push(`${id}-${stat.size}-${stat.mtimeMs}`);
        files.push({ id, file });
      } catch {
        // Removed meanwhile (the sheets are being rebuilt): not listed this time.
      }
    }
    return { key: parts.join(' '), files };
  }

  current(): Record<string, string> {
    const { key, files } = this.sheets();
    if (this.cached?.key === key) return this.cached.versions;
    const versions: Record<string, string> = {};
    for (const { id, file } of files) {
      try {
        versions[id] = createHash('sha256')
          .update(fs.readFileSync(file))
          .digest('hex')
          .slice(0, 16);
      } catch {
        // Removed meanwhile: asked for without a version, from the network.
      }
    }
    // A sheet rewritten while it was read gives another stat next time: read again then.
    if (this.sheets().key === key) this.cached = { key, versions };
    return versions;
  }
}

/** index.html with the styles' sheet versions in their meta tag, for the look's first <link>. */
export function withLookVersions(html: string, versions: Record<string, string>): string {
  if (Object.keys(versions).length === 0) return html;
  const content = JSON.stringify(versions).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return html.replace(
    `<meta name="${LOOK_VERSIONS_META}" content="" />`,
    () => `<meta name="${LOOK_VERSIONS_META}" content="${content}" />`
  );
}

/** Renders index.html for the current shell; the template is re-read when it changes. */
export class IndexHtml {
  private template: { mtimeMs: number; size: number; text: string } | null = null;

  constructor(
    private readonly indexPath: string,
    private readonly shell: ShellVersion,
    private readonly serverLook: () => string | undefined = () => undefined,
    private readonly looks?: LookVersions
  ) {}

  private readTemplate(): string {
    const stat = fs.statSync(this.indexPath);
    if (this.template?.mtimeMs !== stat.mtimeMs || this.template.size !== stat.size) {
      this.template = {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        text: fs.readFileSync(this.indexPath, 'utf8'),
      };
    }
    return this.template.text;
  }

  async render(): Promise<string> {
    const manifest = await this.shell.settled();
    const html = withLookVersions(
      withServerLook(this.readTemplate(), this.serverLook()),
      this.looks?.current() ?? {}
    );
    return manifest ? versionShellUrls(html, manifest.id) : html;
  }
}
