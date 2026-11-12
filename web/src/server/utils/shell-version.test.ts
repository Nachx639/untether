import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import {
  IndexHtml,
  LookVersions,
  ShellVersion,
  versionShellUrls,
  withLookVersions,
  withServerLook,
} from './shell-version';

let dir: string;

function write(rel: string, text: string, mtime?: number) {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  if (mtime) fs.utimesSync(file, mtime, mtime);
}

/** One build as the real one lays it out: entry, a shared chunk, a lazy chunk, the CSS. */
function build(id: string, mtime?: number) {
  write(
    `bundle/chunks/chunk-${id}.js`,
    `import{x}from"./chunk-shared.js";export const y=1;`,
    mtime
  );
  write('bundle/chunks/chunk-shared.js', 'export const x=1;import("./es-AAAA.js");', mtime);
  write(
    'bundle/client-bundle.js',
    `import{y}from"./chunks/chunk-${id}.js";const m="ut-build-id:${id}";import("./chunks/deferred-views-${id}.js");`,
    mtime
  );
  write('bundle/styles.css', `.a{color:red}:root{--ut-build:"${id}"}`, mtime);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-shell-'));
  write('theme-init.js', 'theme');
  write('viewport-init.js', 'viewport');
});

afterEach(() => {
  fs.rmSync(dir, RM_TEST_DIR);
});

const A = 'aaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbb';

describe('shell version on disk', () => {
  it('names the four files with one id, their digests and the chunks the bundle needs', () => {
    build(A);
    const manifest = new ShellVersion(dir).current();
    expect(manifest).not.toBeNull();
    expect(manifest?.id).toMatch(/^[0-9a-f]{16}$/);
    expect(manifest?.consistent).toBe(true);
    expect(manifest?.build).toEqual({ js: A, css: A });
    expect(manifest?.files['/bundle/styles.css']).toBe(
      createHash('sha256').update(`.a{color:red}:root{--ut-build:"${A}"}`).digest('hex')
    );
    expect(manifest?.chunks).toEqual([
      `/bundle/chunks/chunk-${A}.js`,
      '/bundle/chunks/chunk-shared.js',
    ]);
    expect(manifest?.allChunks).toEqual([
      `/bundle/chunks/chunk-${A}.js`,
      '/bundle/chunks/chunk-shared.js',
      `/bundle/chunks/deferred-views-${A}.js`,
      '/bundle/chunks/es-AAAA.js',
    ]);
  });

  it('changes the id with any one file, and only then', () => {
    build(A);
    const shell = new ShellVersion(dir);
    const first = shell.current()?.id;
    expect(shell.current()?.id).toBe(first);
    write('viewport-init.js', 'viewport 2');
    expect(shell.current()?.id).not.toBe(first);
  });

  it('a bundle and a stylesheet of two builds are not consistent', () => {
    build(A);
    write(
      'bundle/client-bundle.js',
      `import{y}from"./chunks/chunk-${A}.js";const m="ut-build-id:${B}";`
    );
    const manifest = new ShellVersion(dir).current();
    expect(manifest?.build).toEqual({ js: B, css: A });
    expect(manifest?.consistent).toBe(false);
  });

  it('a bundle whose chunk is not written yet is not consistent', () => {
    build(A);
    fs.rmSync(path.join(dir, 'bundle/chunks/chunk-shared.js'));
    expect(new ShellVersion(dir).current()?.consistent).toBe(false);
  });

  it('builds without ids (build-ci.js, an older build) are taken as they are', () => {
    write('bundle/client-bundle.js', 'const m="ut-build-id:__UT_BUILD_ID__0";');
    write('bundle/styles.css', '.a{}');
    const manifest = new ShellVersion(dir).current();
    expect(manifest?.build).toEqual({ js: null, css: null });
    expect(manifest?.consistent).toBe(true);
  });

  it('no build yet: no version', () => {
    expect(new ShellVersion(dir).current()).toBeNull();
  });

  it('waits for the stylesheet of a half-written dev build before naming a version', async () => {
    build(A, 1_700_000_000);
    const shell = new ShellVersion(dir);
    const before = shell.current()?.id;
    // esbuild has written B; postcss writes B's stylesheet a moment later.
    write('bundle/chunks/chunk-B.js', 'export const y=2;');
    write(
      'bundle/client-bundle.js',
      `import{y}from"./chunks/chunk-B.js";const m="ut-build-id:${B}";`
    );
    setTimeout(() => write('bundle/styles.css', `:root{--ut-build:"${B}"}`), 150);
    const settled = await shell.settled(3000, 20);
    expect(settled?.consistent).toBe(true);
    expect(settled?.build).toEqual({ js: B, css: B });
    expect(settled?.id).not.toBe(before);
  });

  it('gives up waiting after the timeout and says the pair is not consistent', async () => {
    build(A);
    write(
      'bundle/client-bundle.js',
      `import{y}from"./chunks/chunk-${A}.js";const m="ut-build-id:${B}";`
    );
    const settled = await new ShellVersion(dir).settled(60, 20);
    expect(settled?.consistent).toBe(false);
  });
});

describe('index.html with the server default style', () => {
  const template = fs.readFileSync(
    path.resolve(process.cwd(), 'src/client/assets/index.html'),
    'utf8'
  );
  const content = (html: string) =>
    /<meta name="ut-server-look" content="([^"]*)" \/>/.exec(html)?.[1];

  it('writes what the first paint needs into the real page, escaped for the attribute', () => {
    const value = content(withServerLook(template, 'cyber-hacker')) as string;
    expect(value).not.toContain('"');
    expect(JSON.parse(value.replaceAll('&quot;', '"'))).toEqual({
      id: 'cyber-hacker',
      force: 'dark',
      bg: { dark: '#020704' },
    });
  });

  it('leaves the page alone with no default, Original or an unknown id', () => {
    for (const id of [undefined, 'original', 'no-such-style']) {
      expect(withServerLook(template, id)).toBe(template);
    }
  });
});

describe('interface style sheets named by their content', () => {
  const template = fs.readFileSync(
    path.resolve(process.cwd(), 'src/client/assets/index.html'),
    'utf8'
  );
  const versionsIn = (html: string) =>
    JSON.parse(
      (/<meta name="ut-look-versions" content="([^"]*)" \/>/.exec(html)?.[1] ?? '').replaceAll(
        '&quot;',
        '"'
      ) || '{}'
    ) as Record<string, string>;
  const hash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);

  it('gives each sheet the hash of its content, and another one as soon as it changes', () => {
    write('looks/japandi.css', 'before the merge', 1_700_000_000);
    write('looks/clay.css', 'clay', 1_700_000_000);
    write('looks/clay/clay-grano.webp', 'texture');
    const looks = new LookVersions(dir);
    expect(looks.current()).toEqual({ clay: hash('clay'), japandi: hash('before the merge') });
    // Same size, a later mtime: the merge's build.
    write('looks/japandi.css', 'after the merge!', 1_700_000_100);
    expect(looks.current()).toEqual({ clay: hash('clay'), japandi: hash('after the merge!') });
    fs.rmSync(path.join(dir, 'looks/clay.css'));
    expect(looks.current()).toEqual({ japandi: hash('after the merge!') });
  });

  it('has no versions before the first build', () => {
    expect(new LookVersions(dir).current()).toEqual({});
    expect(withLookVersions(template, {})).toBe(template);
  });

  it('the served page names the sheet on disk now, in the real template', async () => {
    build(A);
    write('index.html', template);
    write('looks/japandi.css', 'one');
    const index = new IndexHtml(
      path.join(dir, 'index.html'),
      new ShellVersion(dir),
      () => undefined,
      new LookVersions(dir)
    );
    expect(versionsIn(await index.render())).toEqual({ japandi: hash('one') });
    write('looks/japandi.css', 'two, longer');
    expect(versionsIn(await index.render())).toEqual({ japandi: hash('two, longer') });
  });
});

describe('index.html with versioned shell URLs', () => {
  const template = fs.readFileSync(
    path.resolve(process.cwd(), 'src/client/assets/index.html'),
    'utf8'
  );

  it('asks for every shell file of the real page with ?v=<id>, the same id everywhere', () => {
    const html = versionShellUrls(template, A);
    for (const url of ['/bundle/client-bundle.js', '/bundle/styles.css', '/viewport-init.js']) {
      expect(html).not.toMatch(new RegExp(`(href|src)="${url.replace(/\./g, '\\.')}"`));
      expect(html).toContain(`"${url}?v=${A}"`);
    }
    // The modulepreload and the module script must name the same URL to share one fetch.
    expect(html).toContain(`<link rel="modulepreload" href="/bundle/client-bundle.js?v=${A}" />`);
    expect(html).toContain(`<script type="module" src="/bundle/client-bundle.js?v=${A}"></script>`);
    expect(html).toContain(`<link rel="preload" href="/bundle/styles.css?v=${A}" as="style" />`);
    expect(html).toContain(`<link id="ut-styles" href="/bundle/styles.css?v=${A}"`);
  });

  it('leaves the inline scripts byte for byte (the CSP allows them by hash)', () => {
    // As csp.test.ts reads them: comments can mention <script>.
    const scripts = (html: string) =>
      [...html.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
        (m) => m[1]
      );
    expect(scripts(template)).toHaveLength(2);
    expect(scripts(versionShellUrls(template, A))).toEqual(scripts(template));
  });

  it('renders the template on disk for the shell on disk', async () => {
    build(A);
    write('index.html', '<link href="/bundle/styles.css" rel="stylesheet" />');
    const shell = new ShellVersion(dir);
    const page = new IndexHtml(path.join(dir, 'index.html'), shell);
    const id = shell.current()?.id;
    expect(await page.render()).toBe(`<link href="/bundle/styles.css?v=${id}" rel="stylesheet" />`);
    write('index.html', '<script src="/theme-init.js"></script>', Date.now() / 1000 + 5);
    expect(await page.render()).toBe(`<script src="/theme-init.js?v=${id}"></script>`);
  });
});

describe('a pair that stays inconsistent', () => {
  it('is answered at once and reported once when its files are not fresh', async () => {
    build(A, 1_700_000_000);
    write(
      'bundle/client-bundle.js',
      `import{y}from"./chunks/chunk-${A}.js";const m="ut-build-id:${B}";`,
      1_700_000_000
    );
    write('theme-init.js', 'theme', 1_700_000_000);
    write('viewport-init.js', 'viewport', 1_700_000_000);
    const reported: string[] = [];
    const shell = new ShellVersion(dir, (manifest) => reported.push(manifest.id));
    const started = Date.now();
    const settled = await shell.settled(3000, 20);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(settled?.consistent).toBe(false);
    await shell.settled(3000, 20);
    expect(reported).toEqual([settled?.id]);
  });
});
