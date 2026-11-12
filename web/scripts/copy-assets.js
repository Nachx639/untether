const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Ensure public directory exists
fs.mkdirSync('public', { recursive: true });

// Copy assets
const srcDir = 'src/client/assets';
const destDir = 'public';

/**
 * IMPORTANT: Node.js v24.3.0 Crash Workaround
 * 
 * We use fs.copyFileSync instead of fs.cpSync due to a critical bug in Node.js v24.3.0
 * that causes SIGABRT crashes when fs.cpSync checks path equivalence.
 * 
 * The crash occurs in node::fs::CpSyncCheckPaths when std::__fs::filesystem::__equivalent
 * throws an exception that Node doesn't handle properly, resulting in:
 * - Signal: SIGABRT (Abort trap: 6)
 * - Random session exits when the asset watcher triggers
 * - Complete process termination affecting all Untether sessions
 * 
 * This implementation manually handles directory recursion to avoid the buggy fs.cpSync.
 * 
 * Related crash signature:
 * - node::fs::CpSyncCheckPaths(v8::FunctionCallbackInfo<v8::Value> const&)
 * - std::__fs::filesystem::__throw_filesystem_error
 * 
 * TODO: Revert to fs.cpSync when Node.js fixes this issue in a future version
 */

/**
 * A sheet's textures, named by their content (2026-11-10, src/shared/shell-version.ts):
 * `url("/looks/<id>/<file>")` becomes `url("/looks/<id>/<file>?v=<hash of the file>")`. A changed
 * texture is then another URL (and another sheet), so no cache shows the old one: the service
 * worker kept them stale-while-revalidate and the server tells browsers PNGs never change.
 */
function versionTextureUrls(css) {
  return css.replace(
    /url\((["']?)(\/looks\/[a-z0-9-]+\/[a-z0-9-]+\.(?:webp|png))\1\)/g,
    (whole, quote, urlPath) => {
      const file = path.join(srcDir, ...urlPath.split('/').filter(Boolean));
      if (!fs.existsSync(file)) return whole;
      const version = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16);
      return `url(${quote}${urlPath}?v=${version}${quote})`;
    }
  );
}

/**
 * The interface styles (src/client/styles/looks): one public/looks/<id>.css per style, its token
 * values plus its effects layer if it has one, loaded only when that style is used.
 */
function copyLooks() {
  const looksDir = 'src/client/styles/looks';
  const out = path.join(destDir, 'looks');
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  for (const name of fs.readdirSync(looksDir)) {
    if (!name.endsWith('.css') || name.endsWith('.effects.css')) continue;
    const effects = path.join(looksDir, name.replace(/\.css$/, '.effects.css'));
    const values = fs.readFileSync(path.join(looksDir, name), 'utf8');
    fs.writeFileSync(
      path.join(out, name),
      versionTextureUrls(
        values + (fs.existsSync(effects) ? `\n${fs.readFileSync(effects, 'utf8')}` : '')
      )
    );
  }
}

// Clean generated sheets first; copying assets afterwards preserves looks/<id>/ textures.
copyLooks();

if (fs.existsSync(srcDir)) {
  fs.readdirSync(srcDir).forEach(file => {
    const srcPath = path.join(srcDir, file);
    const destPath = path.join(destDir, file);
    
    // Use copyFileSync instead of cpSync to avoid Node v24 bug
    const stats = fs.statSync(srcPath);
    if (stats.isDirectory()) {
      // For directories, create and copy contents recursively
      fs.mkdirSync(destPath, { recursive: true });
      const copyDir = (src, dest) => {
        fs.readdirSync(src).forEach(item => {
          const srcItem = path.join(src, item);
          const destItem = path.join(dest, item);
          if (fs.statSync(srcItem).isDirectory()) {
            fs.mkdirSync(destItem, { recursive: true });
            copyDir(srcItem, destItem);
          } else {
            fs.copyFileSync(srcItem, destItem);
          }
        });
      };
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  });
  console.log('Assets copied successfully');
} else {
  console.log('No assets directory found, skipping copy');
}

// ghostty-web WASM (required at runtime via fetch)
try {
  const wasmSrc = path.join(__dirname, '..', 'node_modules', 'ghostty-web', 'dist', 'ghostty-vt.wasm');
  const wasmDest = path.join(__dirname, '..', 'public', 'ghostty-vt.wasm');
  if (fs.existsSync(wasmSrc)) {
    fs.copyFileSync(wasmSrc, wasmDest);
    console.log('ghostty-web WASM copied successfully');
  }
} catch (error) {
  console.warn('Failed to copy ghostty-web WASM:', error);
}
