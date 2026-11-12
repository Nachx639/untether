/**
 * Gives each client build one id, shared by the bundle and the stylesheet, and writes the
 * build's files so the server never sees half of one (2026-10-04, src/shared/shell-version.ts).
 *
 * - The app build runs with `write: false`; this plugin writes its output on `onEnd`: the id is a
 *   hash of the output, written over the placeholder in the entry's `ut-build-id:` literal
 *   (same length: the source map stays exact). Only the entry may hold it: a chunk's name is a
 *   hash of its content, so an id inside one would change its bytes under the same name.
 * - Files are written by rename (never half-written), chunks first, the entry last, unchanged
 *   files not at all (their ETag stays).
 * - Then the id goes to public/bundle/.build-id, which the stylesheet build reads
 *   (scripts/postcss-build-id.js) and watches: `postcss --watch` rebuilds the CSS with the new
 *   id after the JS is written. A failed build writes nothing, so the id never moves ahead of
 *   the bundle.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PLACEHOLDER_MARK = 'ut-build-id:__UT_BUILD_ID__0';
const ENTRY_NAME = 'client-bundle.js';
const BUILD_ID_FILE = path.resolve(__dirname, '../public/bundle/.build-id');

function writeIfChanged(file, contents) {
  try {
    if (Buffer.compare(fs.readFileSync(file), Buffer.from(contents)) === 0) return false;
  } catch {
    // Not there yet.
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, file);
  return true;
}

function countOf(text, needle) {
  return text.split(needle).length - 1;
}

/**
 * Stamps and writes one build's output files; returns the build id.
 * @param {{ path: string; contents: Uint8Array }[]} outputFiles
 * @param {{ idFile?: string }} [options]
 */
function writeClientBuild(outputFiles, options = {}) {
  const idFile = options.idFile ?? BUILD_ID_FILE;
  const entry = outputFiles.find(
    (file) => path.basename(file.path) === ENTRY_NAME && !file.path.includes(`${path.sep}chunks${path.sep}`)
  );
  if (!entry) throw new Error(`client build: no ${ENTRY_NAME} in the output`);

  const hash = crypto.createHash('sha256');
  for (const file of [...outputFiles].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(path.basename(file.path)).update('\0').update(file.contents).update('\0');
  }
  const id = hash.digest('hex').slice(0, 16);

  const entryText = Buffer.from(entry.contents).toString('utf8');
  if (countOf(entryText, PLACEHOLDER_MARK) === 0) {
    throw new Error(`client build: the entry has no ${PLACEHOLDER_MARK} (utils/shell-build-check.ts)`);
  }
  for (const file of outputFiles) {
    if (file === entry || !file.path.endsWith('.js')) continue;
    if (Buffer.from(file.contents).includes(PLACEHOLDER_MARK)) {
      throw new Error(
        `client build: ${path.basename(file.path)} holds the build id; only the entry may (import utils/shell-build-check.ts from app-entry.ts only)`
      );
    }
  }
  const stamped = entryText.split(PLACEHOLDER_MARK).join(`ut-build-id:${id}`);

  for (const file of outputFiles) {
    if (file !== entry) writeIfChanged(file.path, file.contents);
  }
  writeIfChanged(entry.path, stamped);
  writeIfChanged(idFile, `${id}\n`);
  return id;
}

/** esbuild plugin for the app build (with `write: false`). */
const clientBuildIdPlugin = {
  name: 'ut-client-build-id',
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length > 0 || !result.outputFiles) return;
      // Throws on a stamping error: esbuild reports it and a one-shot build fails.
      const id = writeClientBuild(result.outputFiles);
      if (build.initialOptions.logLevel !== 'silent') console.log(`client build ${id}`);
    });
  },
};

module.exports = { BUILD_ID_FILE, PLACEHOLDER_MARK, writeClientBuild, clientBuildIdPlugin };
