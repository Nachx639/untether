/**
 * Declares the client build's id in the stylesheet, `:root { --ut-build: "<id>" }`, read from
 * public/bundle/.build-id (written by scripts/client-build-id.js after the bundle). The file is
 * a dependency of the stylesheet, so `postcss --watch` (dev mode, 4020) rebuilds the CSS with
 * the new id once the JS of a change is written. Without the file (a build that never ran the
 * app build) nothing is declared and nothing checks the pair. See src/shared/shell-version.ts.
 */
const fs = require('fs');
const { BUILD_ID_FILE } = require('./client-build-id.js');

const buildIdPlugin = () => ({
  postcssPlugin: 'ut-build-id',
  OnceExit(root, { result, Rule, Declaration }) {
    result.messages.push({
      type: 'dependency',
      plugin: 'ut-build-id',
      file: BUILD_ID_FILE,
      parent: result.opts.from,
    });
    let id = '';
    try {
      id = fs.readFileSync(BUILD_ID_FILE, 'utf8').trim();
    } catch {
      return;
    }
    if (!/^[0-9a-f]{16}$/.test(id)) return;
    const rule = new Rule({ selector: ':root' });
    rule.append(new Declaration({ prop: '--ut-build', value: `"${id}"` }));
    root.append(rule);
  },
});
buildIdPlugin.postcss = true;

module.exports = buildIdPlugin;
