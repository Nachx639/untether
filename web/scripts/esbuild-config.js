/**
 * ESBuild configuration for Untether web client
 */
const { monacoPlugin } = require('./monaco-plugin.js');
const { clientBuildIdPlugin } = require('./client-build-id.js');
const fs = require('fs');
const { version } = require('../package.json');

/**
 * ghostty-web ships its WASM a second time as a ~564 KB base64 data URL inside its JS, only for
 * `Ghostty.load()` without a path. The app always loads `/ghostty-vt.wasm` (copied to public/ by
 * copy-assets.js), so point that fallback at the served file instead of shipping the blob to every
 * phone (2026-10-02). If a ghostty-web update changes the shape, warn rather than fail the build.
 */
const ghosttyWasmDataUrlPlugin = {
  name: 'ghostty-wasm-data-url',
  setup(build) {
    build.onLoad({ filter: /ghostty-web[\\/]dist[\\/]ghostty-web\.js$/ }, async (args) => {
      const source = await fs.promises.readFile(args.path, 'utf8');
      const stripped = source.replace(
        /"data:application\/wasm;base64,[A-Za-z0-9+/=]+"/,
        '"/ghostty-vt.wasm"'
      );
      const warnings =
        stripped === source
          ? [{ text: 'ghostty-web embedded WASM data URL not found; bundle keeps the inline copy' }]
          : [];
      return { contents: stripped, loader: 'js', warnings };
    });
  },
};

const commonOptions = {
  bundle: true,
  format: 'esm',
  target: 'es2020',
  loader: {
    '.ts': 'ts',
    '.tsx': 'tsx',
    '.js': 'js',
    '.jsx': 'jsx',
    '.css': 'css',
    '.ttf': 'file',
    '.woff': 'file',
    '.woff2': 'file',
  },
  define: {
    'process.env.NODE_ENV': '"production"',
    'global': 'globalThis',
    '__APP_VERSION__': JSON.stringify(version),
  },
  external: [],
  plugins: [monacoPlugin, ghosttyWasmDataUrlPlugin],
  // Allow importing from node_modules without issues
  mainFields: ['module', 'main'],
  // Suppress large bundle warnings
  logLimit: 0,
  tsconfigRaw: {
    compilerOptions: {
      experimentalDecorators: true,
      useDefineForClassFields: false,
      sourceMap: true,
      inlineSourceMap: true,
      inlineSources: true,
    }
  }
};

const devOptions = {
  ...commonOptions,
  // Linked (external) maps: an inline map was ~4.7 MB of the 6.9 MB dev bundle that every
  // phone had to download over Tailscale. Browsers only fetch the .map when DevTools is open.
  sourcemap: 'linked',
  sourcesContent: true,
  // Minified in dev too: the everyday server (4020) often runs in dev mode, and every phone
  // cold start parsed 1.84 MB of unminified JS (1.33 MB minified, −28 %; 2026-10-03).
  // keepNames: class/function names survive (logs, custom elements); linked maps keep it
  // debuggable.
  minify: true,
  keepNames: true,
  define: {
    ...commonOptions.define,
    'process.env.NODE_ENV': '"development"',
    '__APP_VERSION__': JSON.stringify(version),
  },
};

const prodOptions = {
  ...commonOptions,
  sourcemap: false,
  minify: true,
};

/**
 * The app bundle is built with code splitting so rarely used code loaded through `import()`
 * (non-English locales, ~474 KB minified) stays out of the bundle every phone downloads first.
 * The entry keeps its old path, public/bundle/client-bundle.js; lazy chunks land in
 * public/bundle/chunks/ (2026-10-02).
 */
const CLIENT_CHUNKS_DIR = 'public/bundle/chunks';
const clientAppBuild = {
  entryPoints: { 'client-bundle': 'src/client/app-entry.ts' },
  outdir: 'public/bundle',
  splitting: true,
  chunkNames: 'chunks/[name]-[hash]',
  // Written by the plugin: the bundle gets its build id, the stylesheet build reads it, and no
  // file is ever half-written (scripts/client-build-id.js, 2026-10-04). Build the stylesheet
  // after this build.
  write: false,
  plugins: [...commonOptions.plugins, clientBuildIdPlugin],
};

/** Chunk names carry a content hash: drop the previous build's before writing new ones. */
function cleanClientChunks() {
  fs.rmSync(CLIENT_CHUNKS_DIR, { recursive: true, force: true });
}

module.exports = {
  commonOptions,
  devOptions,
  prodOptions,
  clientAppBuild,
  cleanClientChunks,
};