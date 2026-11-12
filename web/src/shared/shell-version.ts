/**
 * One version for the client's shell: the bundle, the stylesheet and the two init scripts
 * (2026-10-04). The service worker used to cache and revalidate each of them on its own, so
 * after a deploy a page could run the new JS with the old CSS: on 4020 esbuild writes the bundle
 * before `postcss --watch` writes the stylesheet, and a revalidation in between stored a new JS
 * next to an old CSS (new markup with old styles: the agent picker's icon and name stacked, the
 * landscape grid missing) until a later reload.
 *
 * Now:
 * - each client build has an id (scripts/client-build-id.js): the bundle carries it
 *   (`BUILD_MARK`) and the stylesheet declares it (`--ut-build`); a pair is from one build only
 *   when both name the same id;
 * - the server names the shell on disk with one id, a hash of the four files' contents, and
 *   says whether the pair in it is consistent (`/bundle/version.json`, server/utils/
 *   shell-version.ts); index.html asks for the files with `?v=<id>`;
 * - the service worker keeps each version in a cache of its own, fills it with every file
 *   (checked against the manifest's digests) before serving any, and never mixes two versions
 *   (client/sw-shell.ts);
 * - the page compares the two ids and reloads once, at most once a minute, when they differ
 *   (client/utils/shell-build-check.ts).
 */

/** The shell's fixed-name files: one version, cached and served together. */
export const SHELL_PATHS = [
  '/bundle/client-bundle.js',
  '/bundle/styles.css',
  '/theme-init.js',
  '/viewport-init.js',
] as const;

/** The server's description of the shell on disk now (no-cache). */
export const SHELL_VERSION_URL = '/bundle/version.json';

/** Query parameter naming the shell version in index.html's asset URLs. */
export const SHELL_VERSION_PARAM = 'v';

export interface ShellManifest {
  /** Hash of the four files' contents: changes with any of them. */
  id: string;
  /** The bundle and the stylesheet name the same build, and every chunk the bundle needs exists. */
  consistent: boolean;
  /** Build ids found in the bundle and the stylesheet (null: a build without them). */
  build: { js: string | null; css: string | null };
  /** SHA-256 (hex) of each shell file, by path. */
  files: Record<string, string>;
  /** Chunks the bundle imports statically (and theirs): needed before the first screen. */
  chunks: string[];
  /** Every chunk this build can load (lazy ones included), to keep in the cache. */
  allChunks: string[];
}

/**
 * The interface styles' sheets and textures (public/looks/*) are named by their content
 * (2026-11-10): `?v=<first 16 hex of the file's SHA-256>`. index.html (always from the network)
 * carries the sheets' versions in this meta tag, as JSON `{ "<look id>": "<version>" }`
 * (server/utils/shell-version.ts), and each sheet names its textures' versions in its `url()`s
 * (scripts/copy-assets.js). The service worker caches a versioned URL for good (client/
 * sw-shell.ts), so a changed sheet is a new URL: the first load after a change shows it.
 */
export const LOOK_VERSIONS_META = 'ut-look-versions';

/** A build id: 16 hex characters. */
const BUILD_ID = /^[0-9a-f]{16}$/;

export function isBuildId(value: unknown): value is string {
  return typeof value === 'string' && BUILD_ID.test(value);
}

/** The custom property the stylesheet declares its build id in. */
export const CSS_BUILD_PROPERTY = '--ut-build';

/**
 * The build id in a bundle's text, or null. The bundle holds it as the string literal
 * `ut-build-id:<id>` (client/utils/shell-build-check.ts); the build writes the id over a
 * placeholder of the same length (scripts/client-build-id.js).
 */
export function buildIdInBundle(text: string): string | null {
  const match = /ut-build-id:([0-9a-f]{16})/.exec(text);
  return match ? match[1] : null;
}

/** The build id a stylesheet's text (or the property's computed value) declares, or null. */
export function buildIdInCss(text: string): string | null {
  const match = /--ut-build\s*:\s*["']([0-9a-f]{16})["']/.exec(text);
  if (match) return match[1];
  const value = /^\s*["']?([0-9a-f]{16})["']?\s*$/.exec(text);
  return value ? value[1] : null;
}

/** Two build ids that are both known and differ: a JS and a CSS of different builds. */
export function buildsDiffer(js: string | null, css: string | null): boolean {
  return js !== null && css !== null && js !== css;
}
