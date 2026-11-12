#!/usr/bin/env node
// The README's moving picture and its strip of interface styles, recorded from the real interface
// on the twin (scripts/gemelo.sh run --rich, data in English): never the real server, the Mac app
// or ~/.untether, and no personal data (the twin's projects are made up).
//
//   node web/scripts/readme-media.mjs [--only gif|looks] [--work <dir>] [--stills]
//
// It writes docs/readme/untether-light.gif, untether-dark.gif (the same take on GitHub's light and
// dark page) and docs/readme/looks.png. Everything else (the frames, the
// master .mp4 the GIF is made from, --stills' pictures of each beat) goes to --work, by default
// $TMPDIR/ut-readme-media: outside the repository, so nothing heavy is ever committed.
// Needs ffmpeg on PATH and Playwright's Chromium (the same one ui-shots.mjs uses).
//
// The GIF is one take of a phone-sized page (390x800) that Playwright drives: taps (drawn as a
// dot, the page gets real touch events), a real touch scroll, real typing. Chromium's screencast
// gives the frames as PNGs; ffmpeg puts them in a phone frame with a caption and makes the GIF
// with its own palette (palettegen / paletteuse, sierra2_4a). What it shows (recordGif):
//
//   1. the list of a project → a working agent's session → its chat, where a line is typed and sent;
//   2. one task through the states the board shows: queued, working, checking, merging, merged;
//   3. the same list in other interface styles; the loop's start, Original again, is one more change.
//
// What is real and what is staged, so nobody takes the GIF for more than it is:
//   - the interface is the app's own, unpatched, served by the twin's server;
//   - the twin runs no agent (its `claude` is a stub), so the session's new terminal lines and
//     the agent's answer are lines this script appends to the files the server already reads for
//     that session (its cast, its Claude transcript): they reach the page the way real ones do;
//   - the task's walk through its states is what the page RECEIVES from GET /api/tasks, changed on
//     the way (as ui-shots' `patch` does); each state is one the server has and the page draws it
//     as it would. The twin's own task never moves;
//   - a style is set as the picker in Settings sets it (utils/look.ts `show`): its sheet, then
//     `data-look` and the mode it forces, then the app's own event.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, WEB_DIR, fail } from './ui-shots/options.mjs';
import { outside, stopWithTheTwin } from './ui-shots/twin.mjs';

const VIEWPORT = { width: 390, height: 800 };
/** The GIF: the screen's width in pixels inside the frame, frames per second. */
const SCREEN_WIDTH = 390;
const GIF_FPS = 15;
const BEZEL = 10;
const MARGIN = 6;
const CAPTION_HEIGHT = 46;
/** scripts/public-export.rules fails a file above 5 MB; the README's GIF stays well under. */
const GIF_MAX_BYTES = 4 * 1024 * 1024;
const LOCALE = 'en';
/** GitHub's page behind the README, light and dark: what shows around the phone. */
const PAGE_BACKGROUNDS = { light: '0xffffff', dark: '0x0d1117' };

/** The styles the GIF walks through after Original, and the ones of the strip, by id (shared/looks.ts). */
const GIF_LOOKS = ['clay', 'cyber-hacker', 'neobrutalism'];
const STRIP_LOOKS = ['original', 'clay', 'cyber-hacker', 'editorial', 'nature', 'neobrutalism', 'aurora', 'retro-pixel'];

/** The session of the take: the one whose agent asks (scripts/gemelo-seed/faro.mjs, «turnos»). */
const ASKING_SESSION = 3;
const ASKING_TITLE_END = 'dinner sittings';
const TERMINAL_LINES = [
  '\u001b[2m●\u001b[0m Read src/diary/sittings.ts',
  '\u001b[2m●\u001b[0m 38 bookings have no sitting yet',
  '\u001b[33m?\u001b[0m Move them to dinner, or leave them without one?',
];
const TYPED = 'Move them to dinner';
const ANSWER = 'Done: 38 bookings moved to the dinner sitting. Tests pass.';
function parseArgs(argv) {
  const options = { work: path.join(process.env.TMPDIR || os.tmpdir(), 'ut-readme-media'), locale: LOCALE };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--only') options.only = argv[++index];
    else if (flag === '--work') options.work = path.resolve(argv[++index] ?? fail('--work needs a folder'));
    else if (flag === '--stills') options.stills = true;
    else if (flag === '--inner') options.inner = true;
    else fail(`unknown option ${flag}`);
  }
  if (options.only && !['gif', 'looks'].includes(options.only)) fail('--only takes gif or looks');
  return options;
}

function ffmpeg(args) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
  if (result.error) fail(`ffmpeg did not start (${result.error.message}): it must be on PATH`);
  if (result.status !== 0) fail(`ffmpeg failed:\n${result.stderr}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- The page ----

/** A phone's page on the twin, as ui-shots opens it, with motion left on. */
async function phonePage(browser, { url, home, rich, look, viewport = VIEWPORT, patchTasks }) {
  const whatsNew = /WHATS_NEW_VERSION = '([^']+)'/.exec(
    fs.readFileSync(path.join(WEB_DIR, 'src/client/components/whats-new-sheet.ts'), 'utf8')
  )[1];
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    locale: 'en-US',
    timezoneId: 'Europe/Madrid',
    colorScheme: 'light',
    serviceWorkers: 'block',
  });
  // Nothing outside the twin.
  await context.route(
    (target) => /^https?:$/.test(target.protocol) && target.hostname !== '127.0.0.1',
    (route) => route.abort()
  );
  // The twin's HOME and its free ports differ in every run and the interface shows them. An
  // absolute path, or the board takes every task for one of no project.
  await context.route(
    (target) => /^\/api\/(sessions(\/[0-9a-f-]+)?|tasks|previews|config)$/.test(target.pathname),
    async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      // A request still on its way when the take ends has nobody to answer to.
      const response = await route.fetch().catch(() => null);
      if (!response) return;
      const body = JSON.parse((await response.text()).replaceAll(home, '/Users/twin'));
      body.previews?.forEach((preview, index) => {
        preview.port = 4110 + index;
      });
      if (new URL(route.request().url()).pathname === '/api/tasks') patchTasks?.(body);
      await route.fulfill({ response, json: body });
    }
  );
  await context.addInitScript(
    ({ whatsNew, look }) => {
      localStorage.setItem('ut-whats-new-seen', whatsNew);
      localStorage.setItem('untether-theme', 'light');
      if (look) localStorage.setItem('untether-look', look);
    },
    { whatsNew, look }
  );
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  // The twin's server runs on a fixed clock: the page's "3 min" must not depend on the day.
  await page.clock.setFixedTime(new Date(rich.now));
  return { context, page };
}

/** The list, up, in the style given, without the notice about unshielded conversations. */
async function openList(page, { url, rich }, look) {
  await page.goto(`${url}/`);
  await page.getByText(rich.sessionTitles[0]).first().waitFor({ state: 'visible' });
  if (look && look !== 'original') {
    await page.waitForFunction((id) => document.documentElement.getAttribute('data-look') === id, look);
  }
  await page.evaluate(() => document.fonts.ready.then(() => true));
  // Closed as its own button closes it: it is about the Mac it runs on, not about what Untether is.
  const notice = page.getByText(/aren’t shielded/).locator('xpath=ancestor::*[.//button][1]//button').last();
  if (await notice.isVisible().catch(() => false)) await notice.click();
  // The click may have scrolled the list to reach the button.
  await page.evaluate(() => document.querySelector('.main-list-scroll').scrollTo(0, 0));
  await sleep(600);
}

/** What utils/look.ts `show` does when the picker in Settings is tapped. */
function setLook(page, id) {
  return page.evaluate(
    async ({ id, forced }) => {
      const root = document.documentElement;
      if (id !== 'original' && !document.getElementById(`ut-look-${id}`)) {
        await new Promise((resolve, reject) => {
          const link = document.createElement('link');
          link.id = `ut-look-${id}`;
          link.rel = 'stylesheet';
          link.href = `/looks/${id}.css`;
          link.onload = resolve;
          link.onerror = () => reject(new Error(`no sheet for ${id}`));
          document.head.appendChild(link);
        });
      }
      if (id === 'original') root.removeAttribute('data-look');
      else root.setAttribute('data-look', id);
      root.setAttribute('data-theme', forced ?? 'light');
      window.dispatchEvent(new CustomEvent('untether-look-changed', { detail: { look: root.getAttribute('data-look') } }));
    },
    { id, forced: lookModes()[id] === 'both' ? null : lookModes()[id] }
  );
}

let modes;
function lookModes() {
  if (!modes) {
    const source = fs.readFileSync(path.join(WEB_DIR, 'src/shared/looks.ts'), 'utf8');
    modes = Object.fromEntries([...source.matchAll(/id: '([a-z0-9-]+)',\s*modes: '(both|light|dark)'/g)].map((m) => [m[1], m[2]]));
    modes.original ??= 'both';
  }
  return modes;
}

/** The styles' names as the interface gives them in English. */
function lookNames() {
  const source = fs.readFileSync(path.join(WEB_DIR, 'src/client/i18n/locales/en.ts'), 'utf8');
  return Object.fromEntries([...source.matchAll(/'look\.([a-z0-9-]+)\.name': '([^']+)'/g)].map((m) => [m[1], m[2]]));
}

// ---- The take ----

/** Chromium's screencast of a page: every frame it paints, as a PNG with its time. */
async function startScreencast(page) {
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    frames.push({ at: metadata.timestamp, data });
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
  return {
    cdp,
    frames,
    now: () => Date.now() / 1000,
    stop: () => cdp.send('Page.stopScreencast'),
  };
}

/** Where a finger lands: drawn in the page, above everything, and gone in 450 ms. */
const TAP_DOT = `(() => {
  const css = document.createElement('style');
  css.textContent = '.readme-tap{position:fixed;z-index:2147483647;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;pointer-events:none;background:rgba(120,120,120,.35);box-shadow:0 0 0 2px rgba(255,255,255,.75),0 0 0 3px rgba(0,0,0,.25);animation:readme-tap .45s ease-out forwards}@keyframes readme-tap{0%{transform:scale(.55);opacity:0}25%{transform:scale(1);opacity:1}70%{transform:scale(1);opacity:1}100%{transform:scale(1.35);opacity:0}}';
  window.__readmeTap = (x, y) => {
    if (!css.isConnected) document.head.appendChild(css);
    const dot = document.createElement('div');
    dot.className = 'readme-tap';
    dot.style.left = x + 'px';
    dot.style.top = y + 'px';
    document.body.appendChild(dot);
    setTimeout(() => dot.remove(), 500);
  };
})()`;

async function tap(page, locator, position) {
  const target = locator.first();
  await target.waitFor({ state: 'visible' });
  const box = await target.boundingBox();
  const x = Math.round(box.x + (position?.x ?? box.width / 2));
  const y = Math.round(box.y + (position?.y ?? box.height / 2));
  await page.evaluate(([x, y]) => window.__readmeTap(x, y), [x, y]);
  await sleep(150);
  await page.touchscreen.tap(x, y);
}

/** A finger's scroll of the list by `distance` px (down when positive). */
async function swipe(cdp, distance) {
  await cdp.send('Input.synthesizeScrollGesture', {
    x: 195,
    y: 520,
    yDistance: -distance,
    // A flick: under half a second whatever the distance.
    speed: Math.round(Math.abs(distance) / 0.4),
    gestureSourceType: 'touch',
  });
}

async function recordGif(browser, twin, options) {
  const { home, rich } = twin;
  const uuid = (n) => `7e57da7a-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const taskId = uuid(101); // the first of the project's queue
  const stills = path.join(options.work, 'stills');
  if (options.stills) fs.mkdirSync(stills, { recursive: true });

  // The task's state as the page receives it (see the header): null is the twin's own.
  let stage = null;
  const at = (minutes) => new Date(rich.now - minutes * 60_000).toISOString();
  const patchTasks = (body) => {
    if (!stage) return;
    const list = body.tasks ?? body;
    const task = list.find((entry) => entry.id === taskId);
    if (!task) throw new Error('the task of the GIF is not in the twin');
    const line = list.filter((entry) => entry.state === 'queued' && entry.repoPath === task.repoPath && entry.id !== taskId);
    for (const [index, entry] of line.sort((a, b) => a.queued.position - b.queued.position).entries()) Object.assign(entry.queued, { position: index + 1, of: line.length });
    delete task.queued;
    Object.assign(task, { state: stage, stateSince: at(0), startedAt: at(0), branch: 'ut/clear-fixes-in-the-server' });
    if (stage !== 'working') task.verify = { command: 'pnpm test', cwd: task.workingDir, startedAt: at(0) };
    if (stage === 'merging' || stage === 'merged') Object.assign(task.verify, { finishedAt: at(0), exitCode: 0, tail: 'Tests  41 passed (41)' });
    if (stage === 'merged') Object.assign(task, { finishedAt: at(0), stats: { commits: 2, files: 5, insertions: 64, deletions: 18 } });
  };

  const { context, page } = await phonePage(browser, { ...twin, patchTasks });
  await page.addInitScript(TAP_DOT);
  await openList(page, twin);

  const marks = [];
  let started;
  const cast = await startScreencast(page);
  let stillCount = 0;
  const scene = (caption) => marks.push({ at: cast.now(), caption });
  const beat = async (name, ms) => {
    await sleep(ms);
    if (options.stills) await page.screenshot({ path: path.join(stills, `${String(++stillCount).padStart(2, '0')}-${name}.png`) });
  };
  const refreshTasks = () => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  const setStage = async (next) => {
    stage = next;
    await refreshTasks();
  };

  try {
    // 1. An agent that waits for an answer, answered from the phone.
    await sleep(300);
    started = cast.now();
    scene('Your Mac’s coding agents, on your phone');
    await beat('list', 1200);
    const asking = page.locator('[data-testid="needs-you-list"] li').filter({ hasText: ASKING_TITLE_END });
    await tap(page, asking.getByTestId('needs-you-action'));
    await page.getByTestId('chat-mode-toggle-button-compact').first().waitFor({ state: 'visible' });
    await page.locator('ut-terminal canvas').first().waitFor({ state: 'visible' });
    // The terminal gets its 1.2 s, with output coming in: what the agent's screen would say.
    const castFile = path.join(home, '.untether/control', uuid(ASKING_SESSION), 'stdout');
    for (const [index, line] of TERMINAL_LINES.entries()) {
      await sleep(250);
      fs.appendFileSync(castFile, `${JSON.stringify([1 + index, 'o', `${line}\r\n`])}\n`);
    }
    await beat('terminal', 1200 - 250 * TERMINAL_LINES.length + 250);
    await tap(page, page.getByTestId('chat-mode-toggle-button-compact'));
    await page.locator('claude-chat-view .bubble').first().waitFor({ state: 'visible' });
    await beat('chat', 400);
    await tap(page, page.locator('terminal-chat-view textarea, terminal-chat-view [contenteditable="true"]'));
    await page.keyboard.type(TYPED, { delay: 35 });
    await beat('typed', 250);
    await tap(page, page.getByTestId('chat-send-button'));
    // What Claude Code writes when it gets the line and answers.
    const conversation = uuid(1000 + ASKING_SESSION);
    const transcript = fs
      .readdirSync(path.join(home, '.claude/projects'), { recursive: true })
      .map((name) => path.join(home, '.claude/projects', String(name)))
      .find((file) => file.endsWith(`${conversation}.jsonl`));
    const say = (role, text, n) =>
      fs.appendFileSync(
        transcript,
        `${JSON.stringify({
          type: role,
          message: { role, content: role === 'user' ? text : [{ type: 'text', text }], ...(role === 'assistant' ? { model: 'claude-falso', stop_reason: 'end_turn' } : {}) },
          uuid: `${conversation}-${n}`,
          sessionId: conversation,
          version: '2.9.0',
          userType: 'external',
          timestamp: new Date(rich.now).toISOString(),
        })}\n`
      );
    say('user', TYPED, 3);
    await beat('sent', 400);
    say('assistant', ANSWER, 4);
    await page.locator('claude-chat-view .bubble').filter({ hasText: ANSWER }).first().waitFor({ state: 'visible' });
    await beat('answered', 1200);
    await tap(page, page.getByTestId('session-back-button'));
    await page.getByTestId('needs-you-strip').waitFor({ state: 'visible' });
    await sleep(150);

    // 2. A task. The notice that the agent answered is closed by its own button.
    scene('A task: queued → working → checks → merged');
    const close = page.getByText(/Claude replied/).locator('xpath=ancestor::*[.//button][1]//button').first();
    if (await close.isVisible().catch(() => false)) await tap(page, close);
    const queued = page.locator(`[data-testid="task-row"][data-task-id="${taskId}"]`).first();
    const distance = await queued.evaluate((el) => Math.round(el.getBoundingClientRect().top - 250));
    await swipe(cast.cdp, distance);
    await beat('queued', 800);
    // Merged, the task leaves the project for «Done»: the row closes the walk by going.
    for (const [state, ms] of [['working', 1200], ['verifying', 1200], ['merging', 1200], ['merged', 500]]) {
      await setStage(state);
      await beat(state, ms);
    }
    await swipe(cast.cdp, -distance - 200);
    await sleep(200);

    // 3. The styles. The task goes back to the twin's own state under the first change.
    const names = lookNames();
    for (const id of GIF_LOOKS) {
      stage = null;
      scene(`Pick a look: ${names[id]}`);
      await setLook(page, id);
      if (id === GIF_LOOKS[0]) await refreshTasks();
      await beat(`look-${id}`, 1200);
    }
    // It ends on the last style: the loop's first frame, Original on the same list, is one more change.
  } catch (error) {
    const debug = path.join(options.work, 'FAILED.png');
    await page.screenshot({ path: debug }).catch(() => {});
    console.error(`readme-media: the take stopped; what the page showed: ${debug}`);
    throw error;
  }
  const ended = cast.now();
  await cast.stop();
  await context.unrouteAll({ behavior: 'ignoreErrors' });
  await context.close();
  return { frames: cast.frames, marks, started, ended };
}

// ---- From frames to the GIF ----

/** A transparent PNG drawn by the browser from a piece of HTML. */
async function drawPng(browser, file, { width, height }, body) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.setContent(`<!doctype html><style>html,body{margin:0;background:transparent;font:600 15px -apple-system,system-ui,sans-serif}</style>${body}`);
  await page.screenshot({ path: file, omitBackground: true });
  await context.close();
}

async function buildGif(browser, take, options) {
  const { frames, marks, started, ended } = take;
  const dir = path.join(options.work, 'frames');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  // The screencast stamps each frame with the wall clock, in seconds.
  const length = ended - started;
  const used = [];
  for (const [index, frame] of frames.entries()) {
    const t = frame.at - started;
    const next = frames[index + 1] ? frames[index + 1].at - started : length;
    if (next <= 0 || t >= length) continue;
    used.push({ data: frame.data, from: Math.max(0, t), to: Math.min(length, next) });
  }
  const list = ['ffconcat version 1.0'];
  for (const [index, frame] of used.entries()) {
    const name = `${String(index).padStart(5, '0')}.png`;
    fs.writeFileSync(path.join(dir, name), Buffer.from(frame.data, 'base64'));
    list.push(`file ${name}`, `duration ${(frame.to - frame.from).toFixed(4)}`);
  }
  list.push(`file ${String(used.length - 1).padStart(5, '0')}.png`);
  fs.writeFileSync(path.join(dir, 'frames.txt'), `${list.join('\n')}\n`);

  const screenHeight = Math.round((SCREEN_WIDTH * VIEWPORT.height) / VIEWPORT.width);
  const width = SCREEN_WIDTH + 2 * (BEZEL + MARGIN);
  const phoneHeight = screenHeight + 2 * BEZEL;
  const height = phoneHeight + 2 * MARGIN + CAPTION_HEIGHT;
  const even = (n) => n + (n % 2);
  const canvas = { width: even(width), height: even(height) };
  const frameFile = path.join(options.work, 'phone-frame.png');
  await drawPng(
    browser,
    frameFile,
    canvas,
    `<div style="position:absolute;left:${MARGIN}px;top:${MARGIN}px;width:${SCREEN_WIDTH}px;height:${screenHeight}px;border:${BEZEL}px solid #16161a;border-radius:${BEZEL + 34}px;box-shadow:0 0 0 1px #3a3a42"></div>`
  );
  const captions = [...new Set(marks.map((mark) => mark.caption))];
  for (const [index, caption] of captions.entries()) {
    await drawPng(
      browser,
      path.join(options.work, `caption-${index}.png`),
      { width: canvas.width, height: CAPTION_HEIGHT },
      `<div style="display:flex;justify-content:center;padding-top:10px"><span style="background:#16161a;color:#f5f5f4;padding:6px 14px;border-radius:999px;box-shadow:0 0 0 1px #3a3a42;white-space:nowrap;letter-spacing:.1px">${caption}</span></div>`
    );
  }

  // The master: the take as it was, at 30 fps. Outside the repository.
  const master = path.join(options.work, 'untether.mp4');
  ffmpeg(['-f', 'concat', '-i', path.join(dir, 'frames.txt'), '-vf', 'fps=30,format=yuv420p', '-c:v', 'libx264', '-crf', '14', '-movflags', '+faststart', master]);

  const inputs = ['-f', 'concat', '-i', path.join(dir, 'frames.txt'), '-i', frameFile];
  for (const index of captions.keys()) inputs.push('-i', path.join(options.work, `caption-${index}.png`));
  const x = MARGIN + BEZEL;
  let graph = `[0:v]fps=${GIF_FPS},scale=${SCREEN_WIDTH}:${screenHeight}:flags=lanczos,format=rgba,pad=${canvas.width}:${canvas.height}:${x}:${x}:color=black@0[screen];[screen][1:v]overlay=0:0:format=auto[v0]`;
  let last = 'v0';
  for (const [index, mark] of marks.entries()) {
    const from = Math.max(0, mark.at - started);
    const to = marks[index + 1] ? marks[index + 1].at - started : length + 1;
    graph += `;[${last}][${2 + captions.indexOf(mark.caption)}:v]overlay=0:${phoneHeight + 2 * MARGIN}:enable='between(t,${from.toFixed(3)},${(to - 0.001).toFixed(3)})'[c${index}]`;
    last = `c${index}`;
  }
  // In two steps: the palette filters, fed straight from the frames' uneven times, wrote a GIF of
  // one frame. First the composed take without loss, at the GIF's rate; then its palette.
  const composed = path.join(options.work, 'composed.mkv');
  ffmpeg([...inputs, '-filter_complex', graph, '-map', `[${last}]`, '-t', length.toFixed(3), '-c:v', 'ffv1', '-pix_fmt', 'bgra', composed]);
  // One GIF per page colour of GitHub (README: <picture>, prefers-color-scheme). A GIF with real
  // transparency was 12.8 MB instead of 2.6: ffmpeg's encoder then stores every frame whole.
  console.log(`readme-media: the take is ${length.toFixed(1)} s, ${used.length} frames; master ${master}`);
  for (const [index, mark] of marks.entries()) {
    console.log(`  ${(mark.at - started).toFixed(1).padStart(5)} s  ${mark.caption}${index ? '' : '  (captions)'}`);
  }
  for (const [theme, background] of Object.entries(PAGE_BACKGROUNDS)) {
    const gif = path.join(REPO_ROOT, `docs/readme/untether-${theme}.gif`);
    ffmpeg([
      // format=rgba at the source: drawn as video (YUV) and converted, GitHub's white came out
      // #fdfdfd, a faint box around the phone.
      '-f', 'lavfi', '-i', `color=${background}:s=${canvas.width}x${canvas.height}:r=${GIF_FPS},format=rgba`,
      '-i', composed,
      '-filter_complex', '[0:v][1:v]overlay=shortest=1:format=rgb,split[a][b];[a]palettegen=max_colors=256:stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle',
      '-loop', '0', gif,
    ]);
    const bytes = fs.statSync(gif).size;
    console.log(`readme-media: ${gif} (${(bytes / 1024 / 1024).toFixed(2)} MB, ${canvas.width}x${canvas.height}, ${GIF_FPS} fps)`);
    if (bytes > GIF_MAX_BYTES) fail(`the GIF is over ${GIF_MAX_BYTES / 1024 / 1024} MB: shorten the take (the waits in recordGif) before touching its size`);
  }
  if (length > 18) fail(`the take is ${length.toFixed(1)} s, over the 18 s a README's GIF should last: shorten the waits in recordGif`);
}

// ---- The strip of styles ----

async function buildLooks(browser, twin, options) {
  const names = lookNames();
  const shot = { width: 390, height: 560 };
  const cells = [];
  for (const id of STRIP_LOOKS) {
    if (!lookModes()[id] || !names[id]) fail(`unknown style ${id} (shared/looks.ts)`);
    const { context, page } = await phonePage(browser, { ...twin, look: id, viewport: shot });
    await context.addInitScript(() => {
      document.addEventListener('DOMContentLoaded', () => {
        const css = document.createElement('style');
        css.textContent = '*,*::before,*::after{animation:none!important;transition:none!important}';
        document.head.appendChild(css);
      });
    });
    await openList(page, twin, id);
    const picture = await page.screenshot({ animations: 'disabled', caret: 'hide' });
    if (options.stills) fs.writeFileSync(path.join(options.work, `look-${id}.png`), picture);
    cells.push({ name: names[id], picture });
    await context.unrouteAll({ behavior: 'ignoreErrors' });
    await context.close();
  }
  // Two rows of four, each picture with its name; transparent around, grey that reads on
  // GitHub's light and dark pages.
  const columns = 4;
  const cellWidth = 300;
  const gap = 28;
  const cellHeight = Math.round((cellWidth * shot.height) / shot.width) + 40;
  const rows = Math.ceil(cells.length / columns);
  const size = { width: columns * cellWidth + (columns - 1) * gap, height: rows * cellHeight + (rows - 1) * gap };
  const context = await browser.newContext({ viewport: size, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.setContent(`<!doctype html><style>
    html,body{margin:0;background:transparent}
    body{display:grid;grid-template-columns:repeat(${columns},${cellWidth}px);gap:${gap}px;font:600 19px -apple-system,system-ui,sans-serif;color:#7d8590}
    figure{margin:0;height:${cellHeight}px}
    img{display:block;width:${cellWidth}px;border-radius:22px;box-shadow:0 0 0 1.5px rgba(125,133,144,.55)}
    figcaption{height:40px;line-height:44px;text-align:center}
  </style>${cells.map((cell) => `<figure><img src="data:image/png;base64,${cell.picture.toString('base64')}"><figcaption>${cell.name}</figcaption></figure>`).join('')}`);
  await page.evaluate(() => Promise.all([...document.images].map((image) => image.decode())));
  const file = path.join(REPO_ROOT, 'docs/readme/looks.png');
  await page.screenshot({ path: file, omitBackground: true });
  await context.close();
  console.log(`readme-media: ${file} (${(fs.statSync(file).size / 1024).toFixed(0)} KB, ${size.width}x${size.height})`);
}

// ---- The run ----

async function inside(options) {
  const url = process.env.GEMELO_URL;
  const home = process.env.GEMELO_HOME;
  if (!url || !home) fail('--inner runs under scripts/gemelo.sh run');
  process.env.TMPDIR = path.join(home, 'tmp');
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.join(os.userInfo().homedir, 'Library/Caches/ms-playwright');
  stopWithTheTwin(home);
  fs.mkdirSync(options.work, { recursive: true });
  const twin = { url, home, rich: JSON.parse(fs.readFileSync(path.join(home, '.gemelo/rich.json'), 'utf8')) };
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch({ headless: true });
  try {
    // The strip first: the take changes the twin's session (its cast, its transcript).
    if (options.only !== 'gif') await buildLooks(browser, twin, options);
    if (options.only !== 'looks') {
      await buildGif(browser, await recordGif(browser, twin, options), options);
    }
  } finally {
    await browser.close();
  }
}

const argv = process.argv.slice(2);
const options = parseArgs(argv);
if (options.inner) await inside(options);
else {
  if (spawnSync('ffmpeg', ['-version']).status !== 0) fail('ffmpeg must be on PATH');
  await outside(fileURLToPath(import.meta.url), argv, options);
}
