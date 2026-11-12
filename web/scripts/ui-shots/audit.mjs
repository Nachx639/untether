// What a run checks besides taking pictures: the layout audit (--audit-layout, with what the
// screen really paints of the avatars), what no style may change (--check-untouchables) and how
// the list scrolls (--measure-scroll).
import fs from 'node:fs';
import { pngPixels } from '../png-pixels.mjs';

export const NOISE_PIXELS = 4;
const SAFE_AREA = { top: 59, bottom: 34 };

/**
 * What the screen shows, not what the DOM says: with the avatars' marks hidden, the picture may
 * change inside the avatars only, and inside every one in view. A mark painted anywhere else
 * (2026-11-09, a real iPhone: loose over other rows after scrolling) or an empty avatar fails.
 */
async function avatarPaintFailures(page, picture, checks) {
  const marks = '.psr-avatar .ut-provider-logo, .psr-avatar > svg, .psr-avatar img, .psr-avatar-glyph';
  const avatars = await page.evaluate(marks => [...document.querySelectorAll('.psr-avatar')].flatMap(el => {
    const r = el.getBoundingClientRect();
    if (!r.width || !el.querySelector(marks)) return [];
    const inView = [[0.5, 0.5], [0.3, 0.3], [0.7, 0.3], [0.3, 0.7], [0.7, 0.7]].map(([fx, fy]) => [r.left + r.width * fx, r.top + r.height * fy]).every(([x, y]) => el.contains(document.elementFromPoint(x, y)));
    const row = el.closest('.tsk,.psr,.pvr,[role="row"]');
    return [{ left: r.left, top: r.top, right: r.right, bottom: r.bottom, inView, row: (row?.getAttribute('aria-label') || row?.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60) }];
  }), marks);
  checks.avatarPaint = avatars.filter(a => a.inView).length;
  if (!avatars.length) return [];
  const hide = await page.addStyleTag({ content: `:is(${marks}){visibility:hidden!important}` });
  const bare = await page.screenshot({ animations: 'disabled', caret: 'hide' });
  await hide.evaluate(el => el.remove());
  const [a, b] = [pngPixels(picture), pngPixels(bare)];
  const scale = a.width / page.viewportSize().width;
  const changed = avatars.map(() => 0);
  let outside = 0;
  let first;
  for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) {
    const at = (y * a.width + x) * a.channels;
    if (Math.abs(a.pixels[at] - b.pixels[at]) + Math.abs(a.pixels[at + 1] - b.pixels[at + 1]) + Math.abs(a.pixels[at + 2] - b.pixels[at + 2]) < 24) continue;
    // 5 px around: an image avatar is drawn a little past its side, with a soft shadow.
    const owner = avatars.findIndex(r => x / scale >= r.left - 5 && x / scale <= r.right + 5 && y / scale >= r.top - 5 && y / scale <= r.bottom + 5);
    if (owner >= 0) changed[owner]++;
    else { outside++; first ??= { x: Math.round(x / scale), y: Math.round(y / scale) }; }
  }
  const failures = [];
  if (outside > NOISE_PIXELS) failures.push({ kind: 'avatar-painted-outside', pixels: outside, first });
  avatars.forEach((avatar, index) => {
    if (avatar.inView && changed[index] <= NOISE_PIXELS) failures.push({ kind: 'avatar-not-painted', row: avatar.row, rect: avatar });
  });
  return failures;
}

/** The layout audit of the view on the page: its JSON beside the picture, and the run fails if anything does. */
export async function auditLayout(page, { view, shotFile, picture, browserName, safeArea }) {
  const { inspectUILayout } = await import('../ui-layout-audit.mjs');
  const layout = await page.evaluate(inspectUILayout, { safeArea: safeArea ? SAFE_AREA : null });
  layout.failures.push(...await avatarPaintFailures(page, picture, layout.checks));
  if (view.folded && !layout.checks.foldedProjects) layout.failures.push({ kind: 'folded-view-without-folded-project' });
  layout.safeArea = safeArea ? { ...SAFE_AREA, method: 'env substitution in WebKit/Chromium; native iOS compositing not emulated' } : null;
  fs.writeFileSync(shotFile.replace(/\.png$/, '-layout-audit.json'), JSON.stringify(layout, null, 2));
  console.log(`ui-shots: layout ${browserName}/${view.name}: ${JSON.stringify(layout.checks)}, ${layout.failures.length} failures`);
  if (layout.failures.length) {
    console.error(`Layout audit failed: ${shotFile.replace(/\.png$/, '-layout-audit.json')}`);
    process.exitCode = 1;
  }
}

/** Logos, 3D icons and the terminal's text: what a style must never change. Runs in the page. */
export function untouchablesOf() {
  const picked = [
    ...document.querySelectorAll('img, ut-terminal canvas, ut-terminal .xterm-rows, ut-terminal'),
  ];
  // What a style could change about them, as a set: images load at their own pace, so which
  // element comes when (and its blob: URL, or the terminal's measured columns) is no difference.
  return [
    ...new Set(
      picked.map((element) => {
        const style = getComputedStyle(element);
        const parent = element.parentElement ? getComputedStyle(element.parentElement) : null;
        return JSON.stringify({
          tag: element.tagName,
          filter: style.filter,
          mixBlend: style.mixBlendMode,
          opacity: style.opacity,
          objectFit: style.objectFit,
          radius: style.borderRadius,
          parentRadius: element.tagName === 'IMG' ? parent?.borderRadius : '',
          fontFamily: element.tagName === 'IMG' ? '' : style.fontFamily,
        });
      })
    ),
  ];
}

/**
 * Real rAF frames while the twin's list scrolls, after textures have decoded. Only Date is frozen
 * for fixture labels; no frame-clock mocking or CPU throttling: report the device/browser with
 * these numbers, never phone FPS.
 */
export async function measureScroll(page, { view, shotFile, browserName }) {
  const samples = await page.evaluate(async () => {
    const scroller = document.querySelector('.main-list-scroll');
    if (!scroller || scroller.scrollHeight <= scroller.clientHeight) throw new Error('No scrolling list');
    const runs = [];
    for (let run = 0; run < 3; run++) {
      const deltas = [];
      const start = scroller.scrollTop;
      let previous = await new Promise(requestAnimationFrame);
      for (let frame = 0; frame < 180; frame++) {
        scroller.scrollTop = (frame % 90) / 89 * (scroller.scrollHeight - scroller.clientHeight);
        const now = await new Promise(requestAnimationFrame);
        deltas.push(now - previous);
        previous = now;
      }
      scroller.scrollTop = start;
      deltas.sort((a, b) => a - b);
      runs.push({ p50: deltas[90], p95: deltas[171], max: deltas[179], over25ms: deltas.filter(ms => ms > 25).length, frames: deltas.length });
    }
    return runs;
  });
  const report = { browser: browserName, view: view.name, viewport: view.viewport, deviceScaleFactor: 2, samples };
  fs.writeFileSync(shotFile.replace(/\.png$/, '-scroll.json'), JSON.stringify(report, null, 2));
  console.log(`ui-shots: scroll ${JSON.stringify(report)}`);
}
