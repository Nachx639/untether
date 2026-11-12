/**
 * How an avatar's own image or emoji sits on it, in a real Chromium with the app's CSS.
 * Run with: pnpm exec tsx src/test/avatar-icon-fit.browser.ts (AVATAR_FIT_ENGINE=webkit for Safari)
 *
 * 2026-11-09: a provider's emoji showed small in the middle of a dark rounded square. The icon
 * has to be the whole avatar, no tile behind it, centred, whole, with the state dot on top; a
 * project's logo keeps its tile and its small marks. Sizes and centring can't be read in a DOM
 * without layout, hence a browser.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page, webkit } from '@playwright/test';
import { RM_TEST_DIR } from './helpers/rm-test-dir.js';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const { buildStyles } = require('../../scripts/css-build.js');

async function build(dir: string): Promise<{ script: string; css: string }> {
  const esbuild = require(path.join(webRoot, 'node_modules/esbuild'));
  const { commonOptions } = require(path.join(webRoot, 'scripts/esbuild-config.js'));
  const entry = path.join(dir, 'entry.ts');
  const src = (file: string) => JSON.stringify(path.join(webRoot, 'src', file));
  fs.writeFileSync(
    entry,
    `import { render } from ${JSON.stringify(path.join(webRoot, 'node_modules/lit/index.js'))};\n` +
      `import { agentAvatar } from ${src('client/components/agent-avatar.ts')};\n` +
      'Object.assign(window, { render, agentAvatar });\n'
  );
  const result = await esbuild.build({
    ...commonOptions,
    entryPoints: [entry],
    write: false,
    outfile: path.join(dir, 'bundle.js'),
    sourcemap: false,
    nodePaths: [path.join(webRoot, 'node_modules')],
    logLevel: 'error',
  });
  const js = result.outputFiles.find((file: { path: string }) => file.path.endsWith('.js'));
  const cssFile = path.join(dir, 'styles.css');
  await buildStyles({ output: cssFile });
  return { script: js.text, css: fs.readFileSync(cssFile, 'utf8') };
}

// The server, in the page: a config and an image with transparent margins, built by a canvas.
const PAGE = `<!doctype html><html lang="en"><head><link rel="stylesheet" href="/styles.css"></head>
<body style="margin:40px;background:var(--color-bg)"><div id="stage"></div>
<script>
  window.__name = (fn) => fn;
  const picture = () => new Promise((resolve) => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 256;
    const context = canvas.getContext('2d');
    context.fillStyle = '#d7d2f0';
    context.beginPath();
    context.arc(128, 128, 108, 0, 7);
    context.fill();
    canvas.toBlob(resolve, 'image/png');
  });
  window.__config = JSON.parse(new URLSearchParams(location.search).get('config'));
  window.fetch = async (input) => {
    const url = String(input);
    if (url.includes('/api/model-providers/icon/')) return new Response(await picture());
    return new Response(JSON.stringify(window.__config), {
      headers: { 'Content-Type': 'application/json' },
    });
  };
</script>
<script type="module" src="/bundle.js"></script></body></html>`;

const DRAWN = [
  { name: 'image', config: { avatarIcons: { claude: 'one.png' } }, part: 'img' },
  { name: 'emoji', config: { avatarIcons: { claude: '🦊' } }, part: '.ut-provider-emoji' },
] as const;

const TILES = {
  row: {
    options: { variant: 'row', kind: 'claude', state: 'idle' },
    tile: '.psr-avatar',
    dot: '.psr-dot',
  },
  side: {
    options: { variant: 'side', kind: 'claude', status: 'running' },
    tile: '.ut-side-avatar',
    dot: '.ut-side-dot',
  },
  card: {
    options: { variant: 'card', kind: 'claude' },
    tile: '.ut-card-avatar',
    dot: '.ut-card-dot',
  },
} as const;

interface Measured {
  background: string;
  shadow: string;
  side: number;
  width: number;
  height: number;
  dx: number;
  dy: number;
  clipped: string[];
  dotOnTop: boolean;
}

/** A fresh page each time: the client keeps a config for a minute. */
async function draw(page: Page, url: string, theme: string, options: object, config: object) {
  const query = encodeURIComponent(JSON.stringify({ modelProviders: [], ...config }));
  await page.goto(`${url}?config=${query}`);
  await page.waitForFunction(() => 'agentAvatar' in window);
  await page.evaluate(
    ({ options, theme }) => {
      const win = window as unknown as Record<string, (...args: unknown[]) => unknown>;
      document.documentElement.dataset.theme = theme;
      win.render(win.agentAvatar(options), document.getElementById('stage'));
      // What loads the config once the avatars are on screen, as the app coming to the front.
      document.dispatchEvent(new Event('visibilitychange'));
    },
    { options, theme }
  );
}

function measure(page: Page, tile: string, part: string, dot: string, side: number) {
  return page.evaluate(
    ({ tile, part, dot, side }) => {
      const box = document.querySelector(`#stage ${tile}`) as HTMLElement;
      box.style.width = `${side}px`;
      box.style.height = `${side}px`;
      const inner = box.querySelector(`.ut-logo-full > ${part}`) as HTMLElement;
      const outer = box.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(inner);
      const drawn = part === 'img' ? inner.getBoundingClientRect() : range.getBoundingClientRect();
      const clipped: string[] = [];
      for (
        let node: HTMLElement | null = box;
        node && node !== document.body;
        node = node.parentElement
      ) {
        if (getComputedStyle(node).overflow !== 'visible') clipped.push(node.className);
      }
      const dotBox = (box.querySelector(dot) as HTMLElement).getBoundingClientRect();
      const top = document.elementFromPoint(
        dotBox.left + dotBox.width / 2,
        dotBox.top + dotBox.height / 2
      );
      const style = getComputedStyle(box);
      return {
        background:
          style.backgroundImage === 'none' ? style.backgroundColor : style.backgroundImage,
        shadow: style.boxShadow,
        side: outer.width,
        width: drawn.width,
        height: drawn.height,
        dx: drawn.left + drawn.width / 2 - (outer.left + outer.width / 2),
        dy: drawn.top + drawn.height / 2 - (outer.top + outer.height / 2),
        clipped,
        dotOnTop: top?.closest(dot) !== null && top?.closest(dot) !== undefined,
      };
    },
    { tile, part, dot, side }
  );
}

async function run(url: string) {
  const browser = await (process.env.AVATAR_FIT_ENGINE === 'webkit' ? webkit : chromium).launch();
  let checks = 0;
  try {
    const page = await browser.newPage({ viewport: { width: 400, height: 400 } });
    page.on('pageerror', (error) => console.error('page error:', error));

    for (const theme of ['light', 'dark']) {
      for (const drawn of DRAWN) {
        for (const [name, tile] of Object.entries(TILES)) {
          await draw(page, url, theme, tile.options, drawn.config);
          await page.waitForSelector(`#stage ${tile.tile} > .ut-logo-full > ${drawn.part}`);
          for (const side of [24, 28, 40, 96]) {
            const got: Measured = await measure(page, tile.tile, drawn.part, tile.dot, side);
            const where = `${theme} ${drawn.name} ${name} ${side}px`;
            assert.equal(got.side, side, `${where}: tile side`);
            assert.equal(got.background, 'rgba(0, 0, 0, 0)', `${where}: no tile behind`);
            assert.equal(got.shadow, 'none', `${where}: no edge`);
            assert.ok(got.width >= side * 0.95, `${where}: covers the side (${got.width})`);
            assert.ok(got.width <= side * 1.3, `${where}: not huge (${got.width})`);
            assert.ok(Math.abs(got.dx) <= 1, `${where}: centred across (${got.dx})`);
            assert.ok(
              Math.abs(got.dy) <= Math.max(1, side * 0.08),
              `${where}: centred down (${got.dy})`
            );
            assert.deepEqual(got.clipped, [], `${where}: nothing clips it`);
            assert.ok(got.dotOnTop, `${where}: the state dot stays on top`);
            checks += 1;
          }
        }
      }

      // A line icon needs its tile; a project's logo keeps its own.
      await draw(page, url, theme, TILES.side.options, { avatarIcons: { claude: 'zap' } });
      await page.waitForSelector(
        '#stage .ut-side-avatar > [data-testid="avatar-logo"]:not(.ut-logo-full)'
      );
      const lineTile = await page.evaluate(
        () =>
          getComputedStyle(document.querySelector('#stage .ut-side-avatar') as Element)
            .backgroundColor
      );
      assert.notEqual(lineTile, 'rgba(0, 0, 0, 0)', `${theme}: a line icon keeps its tile`);

      await draw(
        page,
        url,
        theme,
        { ...TILES.side.options, projectIcon: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' },
        {
          avatarIcons: { claude: '🦊' },
        }
      );
      await page.waitForSelector(
        '#stage .ut-side-avatar[data-icon="project"] > [data-testid="avatar-logo"]'
      );
      const project = await page.evaluate(() => {
        const box = document.querySelector('#stage .ut-side-avatar') as HTMLElement;
        const mark = box.querySelector('[data-testid="avatar-logo"]') as HTMLElement;
        return {
          background: getComputedStyle(box).backgroundColor,
          mark: mark.getBoundingClientRect().width,
        };
      });
      assert.notEqual(project.background, 'rgba(0, 0, 0, 0)', `${theme}: project tile unchanged`);
      // 10 px of mark plus the corner chip's padding and ring, on a 28 px tile.
      assert.ok(project.mark <= 18, `${theme}: the project's mark stays small (${project.mark})`);
      checks += 2;
    }
    console.log(`avatar icon fit: ${checks} checks passed`);
  } finally {
    await browser.close();
  }
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-avatar-fit-'));
  const { script, css } = await build(dir);
  const server = http.createServer((req, res) => {
    if (req.url === '/bundle.js') {
      res.setHeader('Content-Type', 'text/javascript');
      return res.end(script);
    }
    if (req.url === '/styles.css') {
      res.setHeader('Content-Type', 'text/css');
      return res.end(css);
    }
    res.setHeader('Content-Type', 'text/html');
    res.end(PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
  } finally {
    server.close();
    fs.rmSync(dir, RM_TEST_DIR);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
