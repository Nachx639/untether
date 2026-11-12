// Inside the twin: one browser context per picture, opened by its view (views/), settled, saved,
// and checked when the run asks for it (audit.mjs).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pngPixels } from '../png-pixels.mjs';
import { captureCoverageDetails } from '../ui-shots-coverage.mjs';
import { NOISE_PIXELS, auditLayout, measureScroll, untouchablesOf } from './audit.mjs';
import { writeGallery } from './gallery.mjs';
import { LOCALES, WEB_DIR, captures, fail } from './options.mjs';
import { stopWithTheTwin } from './twin.mjs';
import { projectCrops } from './views/helpers.mjs';
import { VIEWS } from './views/index.mjs';

const THEME_KEY = 'untether-theme';
const ACCENT_KEY = 'untether-accent';
const LOOK_KEY = 'untether-look';
const STABLE_TIMEOUT_MS = 20_000;
const STABLE_SHOTS = 3;
const FIXED_PREVIEW_PORT = 4110;
const WHATS_NEW_VERSION = /WHATS_NEW_VERSION = '([^']+)'/.exec(fs.readFileSync(path.join(WEB_DIR, 'src/client/components/whats-new-sheet.ts'), 'utf8'))[1];
const PER_RUN_ENDPOINTS = /^\/api\/(sessions(\/[0-9a-f-]+)?|tasks|previews|config)$/;

/** How many pixels differ between two screenshots of the same size. */
function differingPixels(first, second) {
  if (first.equals(second)) return 0;
  const a = pngPixels(first);
  const b = pngPixels(second);
  if (a.pixels.length !== b.pixels.length) return Number.POSITIVE_INFINITY;
  let count = 0;
  for (let at = 0; at < a.pixels.length; at += a.channels) {
    if (a.pixels.compare(b.pixels, at, at + a.channels, at, at + a.channels) !== 0) count++;
  }
  return count;
}

/**
 * A screenshot once STABLE_SHOTS in a row match: everything has settled. WebKit re-rasterizes a
 * few antialiased pixels of the logo between frames (2026-11-09, one pixel, never the layout):
 * up to NOISE_PIXELS of difference is the same picture.
 */
async function stableShot(page, unsettledPrefix) {
  const deadline = Date.now() + STABLE_TIMEOUT_MS;
  let previous;
  let same = 0;
  for (;;) {
    const shot = await page.screenshot({ animations: 'disabled', caret: 'hide' });
    same = previous && differingPixels(previous, shot) <= NOISE_PIXELS ? same + 1 : 1;
    if (same >= STABLE_SHOTS) return shot;
    if (Date.now() > deadline) {
      // Both frames, to see what keeps moving.
      fs.writeFileSync(`${unsettledPrefix}-A.png`, previous ?? shot);
      fs.writeFileSync(`${unsettledPrefix}-B.png`, shot);
      throw new Error(`the page did not settle in ${STABLE_TIMEOUT_MS} ms: ${unsettledPrefix}-A/B.png`);
    }
    previous = shot;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}

export async function inside(options) {
  const url = process.env.GEMELO_URL;
  const home = process.env.GEMELO_HOME;
  if (!url || !home) fail('--inner runs under scripts/gemelo.sh run');
  // The browsers' profiles go in the twin's HOME, removed with it however the run ends.
  process.env.TMPDIR = path.join(home, 'tmp');
  // Vitest and shields give another HOME: the browsers stay in the user's own cache.
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.join(
    os.userInfo().homedir,
    'Library/Caches/ms-playwright'
  );
  stopWithTheTwin(home);
  const runs = captures(options);
  const rich = JSON.parse(fs.readFileSync(path.join(home, '.gemelo/rich.json'), 'utf8'));
  const playwright = await import('@playwright/test');
  fs.mkdirSync(options.out, { recursive: true });
  const views = options.gallery ? ['mobile'] : options.views;
  const galleryShots = [];
  const baselines = new Map();

  for (const browserName of options.browsers) {
    const browser = await playwright[browserName].launch({ headless: true });
    try {
      const shoot = async (run, name, shotFile) => {
        const view = VIEWS[name];
        const { viewport, phone } = view;
        const ctx = { url, rich, look: run.look, options, name };
        const context = await browser.newContext({
          viewport,
          deviceScaleFactor: 2,
          isMobile: phone,
          hasTouch: phone,
          locale: LOCALES[options.locale],
          timezoneId: 'Europe/Madrid',
          colorScheme: run.theme === 'dark' ? 'dark' : 'light',
          reducedMotion: 'reduce',
          serviceWorkers: 'block',
        });
        // Nothing outside the twin: the page depends on no outside server. Its own blob: images
        // (icon files, as providers and avatarIcons load them) are not outside: aborted, every
        // image avatar fell back to the app's mark and no view ever showed one (2026-11-09).
        await context.route(
          (target) => /^https?:$/.test(target.protocol) && target.hostname !== '127.0.0.1',
          (route) => route.abort()
        );
        // A frozen public/ snapshot for before/after inventories: only local static assets,
        // never API responses or files outside that snapshot. The / route remains the twin shell.
        if (options.assets) {
          const assetPath = (target) => path.resolve(options.assets, `.${target.pathname}`);
          await context.route(target => {
            const file = assetPath(target);
            return target.hostname === '127.0.0.1' && file.startsWith(`${options.assets}${path.sep}`)
              && fs.existsSync(file) && fs.statSync(file).isFile();
          }, route => route.fulfill({ path: assetPath(new URL(route.request().url())) }));
        }
        // WebKit has no CDP safe-area override. Substitute only env() values in the twin's
        // static CSS/JS (including Lit styles), exercising every real safe-area declaration.
        // This emulates layout insets, not iOS native scroll-edge compositing.
        if (options.safeArea && phone) {
          await context.route(target => target.hostname === '127.0.0.1' && /\.(css|js)$/.test(target.pathname), async route => {
            const target = new URL(route.request().url());
            const file = options.assets && path.resolve(options.assets, `.${target.pathname}`);
            const snapshot = file && file.startsWith(`${options.assets}${path.sep}`) && fs.existsSync(file);
            const response = snapshot ? null : await route.fetch();
            const source = snapshot ? fs.readFileSync(file, 'utf8') : await response.text();
            const body = source.replace(/env\(safe-area-inset-(top|bottom|left|right)(?:,\s*[^)]+)?\)/g,
              (_, edge) => `${({ top: 59, bottom: 34, left: 0, right: 0 })[edge]}px`);
            await route.fulfill({ ...(response ? { response } : { contentType: target.pathname.endsWith('.css') ? 'text/css' : 'text/javascript' }), body });
          });
        }
        // Each run has its own HOME and free ports, and the interface shows them: what the
        // browser receives is the same every time. Only the list endpoints, never a stream.
        await context.route(
          (target) => PER_RUN_ENDPOINTS.test(target.pathname),
          async (route) => {
            const response = await route.fetch();
            const body = JSON.parse((await response.text()).replaceAll(home, '~'));
            view.patch?.(body, { ...ctx, pathname: new URL(route.request().url()).pathname });
            body.previews?.forEach((preview, index) => {
              preview.port = FIXED_PREVIEW_PORT + index;
            });
            const sessions = Array.isArray(body) ? body : body.sessions ?? [body];
            for (const session of sessions) session.previewPorts?.forEach((preview, index) => {
              preview.port = FIXED_PREVIEW_PORT + index;
              if (preview.url) preview.url = `http://localhost:${preview.port}`;
            });
            await route.fulfill({ response, json: body });
          }
        );
        await context.addInitScript(
          ({ theme, accent, look, themeKey, accentKey, lookKey, whatsNewVersion }) => {
            // Capture the notice explicitly, never let its delayed auto-open obscure another scene.
            localStorage.setItem('ut-whats-new-seen', whatsNewVersion);
            if (theme) localStorage.setItem(themeKey, theme);
            if (accent) localStorage.setItem(accentKey, accent);
            if (look) localStorage.setItem(lookKey, look);
            document.addEventListener('DOMContentLoaded', () => {
              const css = document.createElement('style');
              css.textContent =
                '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}';
              document.head.appendChild(css);
            });
          },
          {
            theme: run.theme,
            accent: run.accent,
            look: run.look,
            themeKey: THEME_KEY,
            accentKey: ACCENT_KEY,
            lookKey: LOOK_KEY,
            whatsNewVersion: WHATS_NEW_VERSION,
          }
        );
        const page = await context.newPage();
        page.setDefaultTimeout(30_000);
        await page.clock.setFixedTime(new Date(rich.now));
        try {
          await view.open(page, ctx);
        } catch (error) {
          const debug = path.join(options.out, `${browserName}-${name}-${run.label}-FAILED.png`);
          await page.screenshot({ path: debug }).catch(() => {});
          console.error(`ui-shots: ${name} did not open; what the page showed: ${debug}`);
          await context.unrouteAll({ behavior: 'ignoreErrors' });
          await context.close();
          throw error;
        }
        if (options.safeArea && phone) {
          await page.evaluate(() => {
            document.documentElement.setAttribute('data-standalone', '');
            document.documentElement.setAttribute('data-edge-fix', 'pad');
          });
        }
        await page.evaluate(() => document.fonts.ready.then(() => true));
        // The style comes from localStorage after the app starts: its attribute settles it.
        if (run.look && run.look !== 'original') {
          await page.waitForFunction(
            (look) => document.documentElement.getAttribute('data-look') === look,
            run.look
          );
        }
        if (options.checkUntouchables && view.terminal) {
          await page.locator('ut-terminal canvas').first().waitFor({ state: 'visible' });
        }
        await view.frame?.(page, ctx);
        const unsettled = shotFile.replace(/\.png$/, '-UNSETTLED');
        const picture = await stableShot(page, unsettled);
        // After the page settles (2026-11-09): measured before, a logo still loading in the
        // baseline read as a logo the style had changed (aero, cyber-hacker in WebKit).
        const untouchables = options.checkUntouchables ? await page.evaluate(untouchablesOf) : undefined;
        fs.writeFileSync(shotFile, picture);
        console.log(`ui-shots: ${shotFile}`);
        if (options.auditLayout) await auditLayout(page, { view, shotFile, picture, browserName, safeArea: options.safeArea && phone });
        if (view.crops) await projectCrops(page, shotFile, phone);
        if (options.coverage) {
          await captureCoverageDetails(page, shotFile, stableShot);
        }
        if (options.measureScroll && view.scroll) await measureScroll(page, { view, shotFile, browserName });
        await context.unrouteAll({ behavior: 'ignoreErrors' });
        await context.close();
        return { picture, untouchables };
      };

      // Against Original in the same mode: a logo's own shadow differs between light and dark.
      if (options.checkUntouchables) {
        for (const name of views) {
          for (const theme of new Set(runs.map((run) => run.theme))) {
            const { untouchables } = await shoot(
              { look: 'original', theme, label: `baseline-${theme}` },
              name,
              path.join(options.out, `${browserName}-${name}-baseline-${theme}.png`)
            );
            baselines.set(`${name}-${theme}`, untouchables);
          }
        }
      }
      for (const run of runs) {
        for (const name of views) {
          const file = path.join(options.out, `${browserName}-${name}-${run.label}.png`);
          let captured;
          try { captured = await shoot(run, name, file); }
          catch (error) {
            if (!options.coverage) throw error;
            console.error(`ui-shots: FAILED ${name}: ${error.stack}`);
            process.exitCode = 1;
            continue;
          }
          const { picture, untouchables } = captured;
          if (options.gallery) galleryShots.push({ label: run.label, picture });
          if (options.checkUntouchables) {
            let baseline = new Set(baselines.get(`${name}-${run.theme}`));
            let changed = untouchables.filter((fact) => !baseline.has(fact));
            if (changed.length) {
              // An image or the terminal that reached only one of the two passes reads as a
              // change (2026-11-10: two false alarms under load, clean on every rerun). Both
              // passes are taken once more, and only a difference that is still there counts.
              const again = await shoot(
                { look: 'original', theme: run.theme, label: `baseline-${run.theme}` },
                name,
                path.join(options.out, `${browserName}-${name}-baseline-${run.theme}.png`)
              );
              const retaken = await shoot(run, name, file);
              baseline = new Set([...baseline, ...again.untouchables]);
              changed = retaken.untouchables.filter((fact) => !baseline.has(fact));
              if (!changed.length) console.log(`ui-shots: untouchables in ${name} differed once and matched on a second take`);
            }
            if (changed.length) {
              console.error(`ui-shots: ${run.label} changed an untouchable in ${name}:\n${changed.join('\n')}`);
              process.exitCode = 1;
            } else {
              console.log(`ui-shots: untouchables intact in ${name} (${untouchables.length} kinds checked)`);
            }
          }
        }
      }
      if (options.gallery) {
        await writeGallery(browser, galleryShots, path.join(options.out, 'gallery.png'));
      }
    } finally {
      await browser.close();
    }
  }
}
