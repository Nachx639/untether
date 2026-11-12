/**
 * ESBuild plugin for Monaco Editor
 *
 * This plugin builds Monaco as a standalone ESM bundle with the lockfile's
 * patched DOMPurify version instead of Monaco's vendored sanitizer snapshot.
 */
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

let monacoBuildPromise;
const domPurifyEntry = require.resolve('dompurify');
const domPurifyVersion = JSON.parse(
  fs.readFileSync(path.join(path.dirname(domPurifyEntry), '..', 'package.json'), 'utf8')
).version;

function domPurifyPlugin() {
  return {
    name: 'monaco-dompurify',
    setup(build) {
      build.onResolve({ filter: /^\.\/dompurify\/dompurify\.js$/ }, (args) => {
        const normalizedImporter = args.importer.split(path.sep).join('/');
        if (!normalizedImporter.endsWith('/monaco-editor/esm/vs/base/browser/domSanitize.js')) {
          return undefined;
        }
        return { path: domPurifyEntry };
      });
    },
  };
}

/**
 * Puts a finished build in place. Another build may place its own (the same files) between the
 * removal and the rename: whichever lands last is fine.
 */
function publishBuild(buildPath, targetPath) {
  for (let attempt = 0; ; attempt++) {
    fs.rmSync(targetPath, { recursive: true, force: true });
    try {
      fs.renameSync(buildPath, targetPath);
      return;
    } catch (error) {
      if (!['ENOTEMPTY', 'EEXIST'].includes(error.code) || attempt >= 5) throw error;
    }
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/**
 * The build folders of processes that are gone. A build killed in the middle (SIGKILL, a test
 * that stops the tool mid-run) never reaches its own cleanup, so its folder stayed for good
 * (2026-11-11: public/monaco-editor.34695.tmp failed the whole check). A live process's folder
 * is a build going on: left alone.
 */
function sweepDeadBuilds(targetPath) {
  const dir = path.dirname(targetPath);
  const prefix = `${path.basename(targetPath)}.`;
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue;
    const pid = Number(name.slice(prefix.length, -'.tmp'.length));
    if (!Number.isInteger(pid) || pid <= 0 || alive(pid)) continue;
    fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  }
}

async function buildMonacoBundle() {
  const targetPath = path.join(__dirname, '../public/monaco-editor');
  // Its own folder until it is whole and checked. 2026-11-09: two builds at once (the test suite
  // and web/scripts/ui-shots.mjs) removed and wrote the same folder, and one checked the other's
  // half-written file: "Monaco bundle does not contain the patched DOMPurify version".
  const buildPath = `${targetPath}.${process.pid}.tmp`;
  sweepDeadBuilds(targetPath);
  fs.rmSync(buildPath, { recursive: true, force: true });
  fs.mkdirSync(buildPath, { recursive: true });

  try {
    await compileMonaco(buildPath);
    publishBuild(buildPath, targetPath);
  } finally {
    fs.rmSync(buildPath, { recursive: true, force: true });
  }
  console.log(`Monaco Editor bundle built with DOMPurify ${domPurifyVersion}`);
}

async function compileMonaco(buildPath) {
  await esbuild.build({
    stdin: {
      contents: "import * as monaco from 'monaco-editor'; globalThis.monaco = monaco;",
      resolveDir: path.join(__dirname, '..'),
      sourcefile: 'monaco-entry.js',
    },
    bundle: true,
    define: {
      global: 'globalThis',
      'process.env.NODE_ENV': '"production"',
    },
    format: 'esm',
    legalComments: 'inline',
    loader: {
      '.css': 'css',
      '.ttf': 'file',
    },
    minify: true,
    outfile: path.join(buildPath, 'monaco.js'),
    platform: 'browser',
    plugins: [domPurifyPlugin()],
    target: 'es2020',
  });

  const bundle = fs.readFileSync(path.join(buildPath, 'monaco.js'), 'utf8');
  if (!bundle.includes(`DOMPurify ${domPurifyVersion}`) || bundle.includes('DOMPurify 3.2.7')) {
    throw new Error('Monaco bundle does not contain the patched DOMPurify version');
  }
}

module.exports = {
  monacoPlugin: {
    name: 'monaco-editor',
    setup(build) {
      build.onStart(() => {
        monacoBuildPromise ??= buildMonacoBundle();
        return monacoBuildPromise;
      });

      // Handle monaco-editor imports - use the full main entry
      build.onResolve({ filter: /^monaco-editor$/ }, (args) => {
        return {
          path: require.resolve('monaco-editor/esm/vs/editor/editor.main.js'),
          external: false,
        };
      });
    },
  },
};
