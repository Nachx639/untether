/**
 * Dragging in the session list in a real Chromium (Chrome on the Mac), with the app's own CSS.
 * Run with: pnpm exec tsx src/test/session-list-drag.browser.ts
 *
 * 2026-11-07, first use of the list drag in Chrome on the Mac (user report): dragging a row from
 * its title selected text instead, rows could not be put in order inside their group, the
 * orchestrator «Bakery» ended up anchored to "Otras" without the user wanting it, and the
 * sidebar's «⌘2» was painted over the title.
 * Each check below failed before.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from '@playwright/test';
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
    `import ${src('client/components/session-list.ts')};\n` +
      `import ${src('client/components/session-card.ts')};\n` +
      `import { createTestSession } from ${src('test/utils/test-factories.ts')};\n` +
      'Object.assign(window, { createTestSession });\n'
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

const ALPHA = '/Users/me/Projects/alpha';
const BETA = '/Users/me/Projects/beta';

// The server the list talks to, in the page: every call recorded, saves echoed back.
const PAGE = `<!doctype html><html lang="en"><head><link rel="stylesheet" href="/styles.css"></head>
<body style="margin:0">
<div id="side" style="width:300px;height:700px;overflow:auto"></div>
<div id="home" style="width:1100px"></div>
<script>
  // tsx names the functions this file hands to page.evaluate with a helper of its own.
  window.__name = (fn) => fn;
  window.__calls = [];
  window.fetch = async (input, init = {}) => {
    const url = String(input);
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    window.__calls.push({ url, method, body });
    const json = (data) => new Response(JSON.stringify(data), {
      headers: { 'Content-Type': 'application/json' },
    });
    if (url.includes('/group-pin')) return json({ success: true, groupPin: body.groupPin });
    if (url.includes('/session-order') || url.includes('/group-order')) return json({ order: body.order });
    if (url.includes('/api/sessions')) return json([]);
    return json({});
  };
</script>
<script type="module" src="/bundle.js"></script></body></html>`;

type Call = { url: string; method: string; body: unknown };

async function mount(page: Page, where: 'side' | 'home') {
  await page.evaluate(
    ({ where, ALPHA, BETA }) => {
      const make = (window as unknown as { createTestSession: (o: object) => object })
        .createTestSession;
      const inRepo = (id: string, name: string, repo: string) => ({
        ...make({ id, name, status: 'running', command: ['claude'], workingDir: repo }),
        gitRepoPath: repo,
        gitMainRepoPath: repo,
        gitBranch: 'main',
        startedAt: '2026-11-07T10:00:00.000Z',
        lastModified: '2026-11-07T10:00:00.000Z',
      });
      const list = document.createElement('session-list') as HTMLElement & Record<string, unknown>;
      list.authClient = { getAuthHeader: () => ({}) };
      list.compactMode = where === 'side';
      list.sessions = [
        inRepo('a1', 'Insights del canal StarterStoryBuild con un título muy largo', ALPHA),
        inRepo('a2', 'Bakery orquestador con otro título bastante largo', ALPHA),
        inRepo('b1', 'Beta uno', BETA),
      ];
      document.getElementById(where)?.appendChild(list);
    },
    { where, ALPHA, BETA }
  );
  await page.waitForSelector(
    `#${where} ${where === 'side' ? 'compact-session-card' : 'session-card'}[data-drag-session]`
  );
}

const calls = (page: Page, part: string): Promise<Call[]> =>
  page.evaluate(
    (part) =>
      (window as unknown as { __calls: Call[] }).__calls.filter((c) => c.url.includes(part)),
    part
  );

const rowOrder = (page: Page, key: string): Promise<string[]> =>
  page.evaluate(
    (key) =>
      [...document.querySelectorAll(`#side [data-group-key="${key}"] compact-session-card`)].map(
        (el) => el.getAttribute('data-drag-session') ?? ''
      ),
    key
  );

async function center(page: Page, selector: string, dy = 0): Promise<[number, number]> {
  const box = await page.locator(selector).first().boundingBox();
  assert(box, `${selector} is on screen`);
  return [box.x + Math.min(box.width / 2, 60), box.y + box.height / 2 + dy];
}

/** Press on `from`, move like a hand to `to`, check nothing got selected, let go. */
async function drag(page: Page, from: [number, number], to: [number, number], release = true) {
  await page.mouse.move(...from);
  await page.mouse.down();
  await page.mouse.move(to[0], to[1], { steps: 15 });
  await page.waitForTimeout(80);
  const selected = await page.evaluate(() => window.getSelection()?.toString() ?? '');
  assert.equal(selected, '', 'dragging selects no text');
  if (!release) return;
  await page.mouse.up();
  await page.waitForTimeout(150);
}

const until = async (check: () => Promise<boolean>, what: string) => {
  for (let i = 0; i < 40; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`timed out waiting for ${what}`);
};

const toastText = (page: Page) =>
  page.evaluate(
    () =>
      document.querySelector('.ut-toast:not([data-state="exit"]) .ut-toast-text')?.textContent ??
      null
  );

async function run(url: string) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'en-US' });
    page.on('pageerror', (error) => console.error('page error:', error));
    await page.goto(url);
    await mount(page, 'side');
    const name = (id: string) =>
      `#side compact-session-card[data-drag-session="${id}"] .ut-side-name`;

    // Every draggable element is unselectable, its title too, by one CSS rule.
    const selectable = await page.evaluate(() =>
      [...document.querySelectorAll('[data-drag-session] .ut-side-name, [data-drag-group]')]
        .map((el) => getComputedStyle(el).userSelect)
        .filter((value) => value !== 'none')
    );
    assert.deepEqual(selectable, [], 'titles and headers are user-select: none');

    // 1. A row dragged from its title, up above the other: reordered, nothing selected.
    const first = await rowOrder(page, ALPHA);
    assert.equal(first.length, 2);
    const [upper, lower] = first;
    const top = await center(page, name(upper), -6);
    await drag(page, await center(page, name(lower)), top);
    await until(
      async () => (await rowOrder(page, ALPHA)).join() === `${lower},${upper}`,
      'the new order'
    );
    assert.deepEqual(
      (await calls(page, '/session-order')).map((c) => c.body),
      [{ order: [lower, upper] }]
    );
    assert.equal((await calls(page, '/group-pin')).length, 0, 'a reorder anchors nothing');
    assert.equal(await toastText(page), 'Order changed');
    // Undo with the toast's button.
    await page.locator('.ut-toast:not([data-state="exit"]) .ut-toast-action').click();
    await until(
      async () => (await rowOrder(page, ALPHA)).join() === first.join(),
      'the order undone'
    );

    // 2. Between groups: a1 onto beta, then Cmd+Z puts it back.
    await drag(page, await center(page, name('a1')), await center(page, name('b1'), 8));
    await until(async () => (await rowOrder(page, BETA)).includes('a1'), 'a1 in beta');
    assert.deepEqual(
      (await calls(page, '/group-pin')).map((c) => c.body),
      [{ groupPin: { repoPath: BETA } }]
    );
    assert.equal(await toastText(page), 'Moved to beta');
    await page.keyboard.press('Meta+z');
    await until(async () => (await rowOrder(page, ALPHA)).includes('a1'), 'a1 back in alpha');
    assert.deepEqual(
      (await calls(page, '/group-pin')).map((c) => c.body),
      [{ groupPin: { repoPath: BETA } }, { groupPin: null }]
    );

    // 3. Escape while dragging: nothing moves, the release opens nothing.
    const saves = async () =>
      (await calls(page, '')).filter((c) => c.method !== 'GET' && /group-pin|-order/.test(c.url));
    const before = await saves();
    await drag(page, await center(page, name(lower)), await center(page, name('b1')), false);
    assert.equal(await page.locator('[data-testid="list-drag-ghost"]').count(), 1);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await page.waitForTimeout(150);
    assert.equal(await page.locator('[data-testid="list-drag-ghost"]').count(), 0);
    assert.deepEqual(await saves(), before, 'Escape saved nothing');
    assert.deepEqual(await rowOrder(page, ALPHA), first);

    // 4. The sidebar row on hover: «⌘1» and the buttons after the title, which is cut in the
    // middle (.ut-mid, 2026-11-11): its start ends in "…" and its end stays whole.
    await page.mouse.move(...(await center(page, name('a1'))));
    await page.waitForTimeout(100);
    const side = await page.evaluate(() => {
      const row = document.querySelector('#side compact-session-card .ut-side-row') as HTMLElement;
      const title = row.querySelector('.ut-side-name') as HTMLElement;
      const parts = [...row.querySelectorAll('.ut-side-hover > *')] as HTMLElement[];
      const start = title.querySelector('.ut-mid-start') as HTMLElement;
      const end = title.querySelector('.ut-mid-end') as HTMLElement | null;
      return {
        ellipsis: getComputedStyle(start).textOverflow,
        clipped: start.scrollWidth > start.clientWidth,
        endWhole: !end || end.scrollWidth <= end.clientWidth + 1,
        whole: title.textContent ?? '',
        titleRight: title.getBoundingClientRect().right,
        actionsLeft: Math.min(...parts.map((el) => el.getBoundingClientRect().left)),
        shown: parts.filter((el) => el.getBoundingClientRect().width > 0).length,
        kbd: row.querySelector('.ut-side-hover .ut-kbd')?.textContent ?? '',
      };
    });
    assert.equal(side.ellipsis, 'ellipsis', 'the start of the sidebar title ends in …');
    assert.ok(side.clipped, `the long title is cut in its start (${side.whole})`);
    assert.ok(side.endWhole, `the end of the title stays whole (${side.whole})`);
    assert.ok(side.kbd, 'the shortcut shows on hover');
    assert.ok(side.shown >= 2, 'the shortcut and the buttons show on hover');
    assert.ok(
      side.titleRight <= side.actionsLeft,
      `sidebar title (right ${side.titleRight}) ends before its actions (left ${side.actionsLeft})`
    );

    // 5. The home's cards and rows: the actions never over the title either.
    await mount(page, 'home');
    for (const layout of ['card', 'list']) {
      await page.evaluate((layout) => {
        const list = document.querySelector('#home session-list') as HTMLElement &
          Record<string, unknown>;
        list.listView = layout;
      }, layout);
      await page.waitForTimeout(150);
      const target = '#home session-card[data-drag-session="a1"] .ut-card-name';
      await page.mouse.move(...(await center(page, target)));
      await page.waitForTimeout(100);
      const card = await page.evaluate((target) => {
        const title = document.querySelector(target) as HTMLElement;
        const host = title.closest('session-card') as HTMLElement;
        const actions = host.querySelector('.ut-card-actions') as HTMLElement;
        return {
          ellipsis: getComputedStyle(title).textOverflow,
          titleRight: title.getBoundingClientRect().right,
          actionsLeft: actions.getBoundingClientRect().left,
          actionsWidth: actions.getBoundingClientRect().width,
        };
      }, target);
      assert.equal(card.ellipsis, 'ellipsis', `${layout}: the title ends in …`);
      assert.ok(card.actionsWidth > 0, `${layout}: the actions show on hover`);
      assert.ok(
        card.titleRight <= card.actionsLeft,
        `${layout}: title (right ${card.titleRight}) ends before the actions (left ${card.actionsLeft})`
      );
    }
    console.log('chromium: session list drag ok');
  } finally {
    await browser.close();
  }
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-list-drag-'));
  let built: { script: string; css: string };
  try {
    built = await build(dir);
  } finally {
    fs.rmSync(dir, RM_TEST_DIR);
  }
  const server = http.createServer((req, res) => {
    if (req.url === '/bundle.js') {
      res.setHeader('Content-Type', 'text/javascript');
      res.end(built.script);
    } else if (req.url === '/styles.css') {
      res.setHeader('Content-Type', 'text/css');
      res.end(built.css);
    } else if (req.url === '/' || req.url === '/index.html') {
      res.setHeader('Content-Type', 'text/html');
      res.end(PAGE);
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
