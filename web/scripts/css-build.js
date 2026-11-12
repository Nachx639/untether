const fs = require('node:fs/promises');
const path = require('node:path');
const postcss = require('postcss');

/** Compile the stylesheet for builds and visual tests using the local PostCSS plugins. */
async function buildStyles({
  input = path.resolve(__dirname, '../src/client/styles.css'),
  output = path.resolve(__dirname, '../public/bundle/styles.css'),
  plugins = require('../postcss.config.js').plugins,
  log = (warning) => console.warn(warning),
} = {}) {
  const css = await fs.readFile(input, 'utf8');
  const result = await postcss(plugins).process(css, {
    from: input,
    to: output,
    map: { inline: true },
  });
  for (const warning of result.warnings()) log(warning.toString());
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, result.css);
  return result;
}

module.exports = { buildStyles };
