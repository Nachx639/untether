# Cold start of the phone app

How long the installed web app (PWA) takes from launch to a usable session list, what it
downloads, and what was done about it (2026-10-04). Baseline: commit `901dfb0c`; after: the
`perf(...)` commits that follow it on `agent/coldstart`.

## How it was measured

- **Sizes** come from esbuild metafiles of the real build config (`scripts/esbuild-config.js`,
  `prodOptions` as `build-client.js` / `build.js` use, and `devOptions` as `dev.js` uses on
  4020). Compressed sizes: gzip level 6, brotli quality 4 and 11 (Node's zlib).
- **What the server sends** was read with curl from a throwaway server of this tree
  (`tsx src/cli.ts --no-auth --port 47101`, empty `HOME`, dev mode like 4020), with
  `Accept-Encoding: br, gzip`: status, `Content-Encoding`, `Cache-Control`, bytes on the
  wire and the answer to `If-None-Match`.
- **The startup sequence** (which requests, in which order) was read from the code:
  `index.html`, `app-entry.ts`, `app.ts` (`connectedCallback`, `initializeApp`,
  `checkAuthenticationStatus`, `initializeServices`, `performLoadSessions`) and the services
  they call.
- **Time to a usable list** was then replayed with a small Node client against the two real
  servers (baseline on :47103, this branch on :47101) through an emulated link: one RTT before
  each response, response bodies sharing one bandwidth budget, 6 connections. It counts the
  network only, not parsing or rendering on the phone, and assumes a Spanish UI (the `es`
  chunk) and a password user (no Tailscale token request). It is a model: the numbers to keep
  are the differences, not the absolute times.

No browser was driven; the iPhone checks are listed at the end.

## Before

### What the first screen downloaded

| File | Raw | Brotli as served | Notes |
| --- | ---: | ---: | --- |
| `/` (index.html) | 4.7 KB | 1.8 KB | |
| `/bundle/client-bundle.js` (prod build) | 1,531 KB | 362 KB | br11 would be 282 KB |
| `/bundle/client-bundle.js` (dev build, 4020) | 1,561 KB | 365 KB | minified + `keepNames` + linked map |
| its 3 static chunks | 20 KB | 7 KB | shared with the locale chunks |
| `/bundle/chunks/es-*.js` | 87 KB | 25 KB | only for non-English, fetched after the bundle ran |
| `/bundle/styles.css` | 228 KB | 30 KB | Tailwind output, not minified (minified: 28 KB br, not worth the risk) |
| `/theme-init.js`, `/viewport-init.js` | 2 KB | 1.4 KB | |
| `/apple-touch-icon.png` | 195 KB | 195 KB | the boot screen's 64 pt icon |
| `/favicon.ico`, `/favicon-32.png`, `/manifest.json` | 35 KB | 18 KB | |
| fonts (`.font-mono` is used on the list) | 2.6 MB per Hack TTF | 1.5 MB | lazy, `font-display: swap`; not on the critical path but competes for bandwidth when not cached |

Total before the list could show: **14 requests, 634 KB on the wire** with an empty cache.

The "1.56 MB unminified" bundle was in fact the dev build, already minified (since
2026-10-03); the prod build was 1.53 MB minified. Monaco (4.4 MB) and the ghostty WASM's
inline copy were already out of the bundle; the non-English locales were already split.

### Biggest modules in the bundle (prod, minified bytes in output)

A snapshot from the investigation, not kept up to date: `claude-chat-view.ts` and
`terminal-chat-view.ts` have since been split into the `claude-chat-view/` and
`terminal-chat-view/` folders, and every module has moved on. To measure the current sizes
per output file and module, run from `web/` (builds in memory, writes nothing):

```bash
node -e "
const esbuild = require('esbuild');
const { prodOptions, clientAppBuild } = require('./scripts/esbuild-config.js');
esbuild.build({ ...prodOptions, ...clientAppBuild, plugins: prodOptions.plugins, write: false, metafile: true })
  .then((r) => console.log(esbuild.analyzeMetafileSync(r.metafile)));
"
```

| Module | Bytes | Needed by the list? |
| --- | ---: | --- |
| `i18n/locales/en.ts` | 78.9 K | yes |
| `ghostty-web` | 73.4 K | no (terminal) |
| `claude-chat-view.ts`, then one file (+ voice mode, mode picker, lightbox ~25 K) | 62.4 K | no |
| `session-list.ts` | 59.4 K | yes |
| `session-view.ts` | 58.8 K | no |
| `app.ts` | 57.1 K | yes |
| `terminal-chat-view.ts`, then one file | 56.1 K | no |
| `settings.ts` | 38.3 K | no |
| `session-create-form.ts` | 36.2 K | no |
| `terminal.ts` | 34.9 K | no |
| `file-browser.ts` | 30.5 K | no |
| `session-view/session-header.ts`, `compact-menu.ts`, `direct-keyboard-manager.ts` | 74.2 K | no |
| `task-sheet.ts`, `multiplexer-modal.ts`, `ssh-key-manager.ts` | 56.9 K | no |
| `ship-sheet.ts`, `changes-sheet.ts`, `worktree-manager.ts` (git sheets) | 49.8 K | no |
| `mac-share-sheet.ts`, `mac-session-view.ts`, `claude-history-view.ts`, `answer-sheet.ts` | 42.7 K | no |
| `preview-view.ts`, `preview-panel.ts` | 17.9 K | no |

About two thirds of the bundle was code for screens other than the list. Two small helpers
(`modeSwitchBlocked`, `composerHeightFor`) pulled both chat views into the list's code.

### What the server did

- Compression: `compression` 1.8 with brotli (quality 4, on the fly) and gzip; JS, CSS, HTML,
  JSON, TTF and WASM are compressed, PNG/WOFF2 are not. Nothing was missing.
- Cache headers in dev mode (4020): `no-cache` + weak ETag (size-mtime) for **every** static
  file, so each cold start revalidated every file (14 conditional requests, all 304 when
  nothing changed). In production builds fonts and images are `immutable` for a year, JS/CSS
  `no-cache`, HTML one hour.
- The service worker cached nothing but the offline page; every client file went to the
  network (or the HTTP cache, which iOS drops for home-screen apps at will).

### The startup waterfall

```
GET /                                       1 RTT
  ├─ styles.css, theme-init.js, viewport-init.js, client-bundle.js (1.53 MB), icons   1 RTT + download
  └─ (bundle runs)
       ├─ chunks/es-*.js                    1 RTT (parallel with the API chain)
       └─ GET /api/auth/config              1 RTT
          GET /api/auth/config  (again)     1 RTT   terminal socket's no-auth check
          GET /api/sessions                 1 RTT
          GET /api/previews                 1 RTT   started only after /api/sessions, waited up to 1.5 s
          → list
```

Six round trips in a row plus the 1.5 MB download. `/api/config` (session list, settings and
create form, all at startup) and `/api/mac-sessions` (first poll) come after the list.

## What changed

1. **Code split** (`perf(client): load the views the session list doesn't show after it`).
   The session view (terminal, ghostty, chats, voice, git sheets), previews, the file
   browser, settings, the create form, the tmux/ssh modals and the sheets are one chunk,
   `deferred-views.ts`, loaded through `utils/lazy-views.ts`:
   - fetched in idle time as soon as the list is on screen, so opening a view is normally
     instant; a view opened earlier shows a spinner until it arrives;
   - a lazy element is rendered only once defined, and the hidden modals appear once the
     chunk is in;
   - a chunk the user is waiting for that fails twice (an older build's file, removed by a
     later build) reloads the page, at most once a minute;
   - one chunk rather than one per view: one chunk per view gave 33 files for the first
     screen (esbuild splits shared code per combination of entry points).
   esbuild `splitting` was already on (for the locales), so the build needed no change; the
   prod build is minified, and so is the dev build 4020 uses.
2. **Parallel startup** (`perf(client): ask for the list's data in parallel at startup`):
   one shared `/api/auth/config` request (`utils/auth-config.ts`), and `/api/previews` asked
   alongside `/api/sessions`.
3. **Immutable chunks** (`perf(server): ...`): `public/bundle/chunks/*.js` are named by their
   content hash and now served `public, max-age=31536000, immutable`, dev mode included
   (`src/server/utils/static-cache.ts`). Everything else keeps its old header.
4. **Service-worker shell cache** (`perf(sw): ...`, `src/client/sw-shell.ts`): see below.
5. **HTML** (`perf(html): ...`): `<link rel="modulepreload">` for the bundle, and the boot
   screen's icon from `icon-192.png` (43 KB) instead of the 512 px `apple-touch-icon.png`
   (195 KB).

### Updates stay correct

- `/bundle/client-bundle.js` keeps its name, its `no-cache` + ETag, and changes whenever any
  chunk changes: chunk names are content hashes and the bundle imports them by name (checked:
  changing a logger name in `terminal.ts`, which is in the deferred chunk, changes the entry
  file). `deploy-4020.sh` and the in-app version watch keep working unchanged.
- The shell is one version (2026-10-04, see "One shell version" below): `index.html` asks for
  `client-bundle.js?v=<id>`, `styles.css?v=<id>` and the init scripts with the same id, and
  the service worker serves a version only once it holds all of it. **After a deploy the first
  load already runs the new build** (its files come from the network once, then from the
  worker's cache). A page open from before still learns of the new build from the version
  watch (`utils/app-version.ts`): it reloads when it comes back to the foreground, or offers
  "New version — Reload".
- Page loads are not cached by the worker: `index.html` is always fetched (network first,
  offline page when the Mac is unreachable, as before). API calls, `sw.js`, the WASM,
  `manifest.json` (the offline page's probe) and requests with `cache: 'no-store'` or
  `'reload'` always go to the network.

## After

### Sizes

| | Before | After |
| --- | ---: | ---: |
| JS the list needs (prod build): files | 4 | 6 (entry + 5 shared chunks) |
| raw | 1,552 KB | **542 KB (−65 %)** |
| brotli q4 (as served) | 362 KB | **151 KB (−58 %)** |
| gzip 6 | 381 KB | 150 KB |
| same, dev build (4020): raw / brotli | 1,582 KB / 373 KB | 555 KB / 157 KB |
| `client-bundle.js` alone (prod): raw / brotli | 1,531 KB / 362 KB | 277 KB / 69 KB |
| deferred views chunk, fetched after the list | in the bundle | 1,002 KB / 230 KB |
| boot icon | 195 KB | 43 KB |
| V8 pre-parse of the list's JS on the Mac (median of 7) | 13.1 ms | 5.3 ms |

### Time to a usable list (network model, Spanish UI)

| Link | Before, empty cache | Before, HTTP cache (all 304) | After, empty cache | After, HTTP cache | After, service-worker cache |
| --- | ---: | ---: | ---: | ---: | ---: |
| RTT 30 ms, 10 Mbit/s | 690 ms | 201 ms | 361 ms | 131 ms | 104 ms |
| RTT 60 ms, 10 Mbit/s | 866 ms | 379 ms | 537 ms | 253 ms | 191 ms |
| RTT 150 ms, 10 Mbit/s | 1,404 ms | 921 ms | 983 ms | 613 ms | 461 ms |
| RTT 30 ms, 2 Mbit/s | 2,701 ms | 199 ms | 1,192 ms | 131 ms | 112 ms |
| RTT 60 ms, 2 Mbit/s | 2,850 ms | 377 ms | 1,336 ms | 253 ms | 200 ms |
| RTT 150 ms, 2 Mbit/s | 3,453 ms | 923 ms | 1,605 ms | 612 ms | 471 ms |

Bytes before the list with an empty cache: 634 KB → 271 KB. With the worker's cache only the
page and the API go to the network (3 KB, three round trips: page, auth config, sessions with
previews). On the phone the parse and run time of the JS that is no longer loaded up front
(about 1 MB) comes on top of these savings; it now happens in idle time after the list.

### Startup waterfall now

```
GET /                                       1 RTT
  ├─ client-bundle.js (277 KB) → 5 chunks  service-worker cache, else 1 RTT + 1 RTT
  └─ (bundle runs)
       ├─ chunks/es-*.js                    service-worker / HTTP cache, else 1 RTT
       └─ GET /api/auth/config              1 RTT  (shared with the terminal socket)
          GET /api/sessions ∥ /api/previews 1 RTT
          → list
          … idle: chunks/deferred-views-*.js (230 KB br)
```

### Terminal font (Hack Nerd Font Mono)

The two TTFs (2.6 MB each, 1.57 MB as served with brotli q4) were mostly Nerd icons in Private
Use code points. `scripts/build-terminal-fonts.py` (fonttools in the QA venv, reproducible,
`--check` verifies the result) cuts each weight into three WOFF2 files, and `styles.css`
declares them under one family with `unicode-range`, so a browser fetches the icon files only
when a page draws one of their characters:

| File (per weight) | Code points | Regular | Bold |
| --- | --- | ---: | ---: |
| `hack-core-*.woff2` (preloaded) | all but Private Use, plus Powerline U+E0A0-E0D7 | 108,832 B | 110,144 B |
| `hack-pua-*.woff2` | rest of U+E000-F8FF (devicons, Font Awesome, codicons…) | 591,268 B | 591,184 B |
| `hack-spua-*.woff2` | U+F0000-10FFFF (Material Design, nf-md) | 456,056 B | 455,608 B |
| before: `HackNerdFontMono-*.ttf` | everything | 2,666,460 B (1,566,670 br) | 2,674,696 B (1,570,674 br) |

Font bytes on a cold start with an empty cache (WOFF2 is not compressed again by the server):

| | Before (raw / on the wire) | After |
| --- | ---: | ---: |
| list (`.font-mono` previews; regular, and bold when a preview has bold text) | 2.67 MB / 1.57 MB, up to 5.34 MB / 3.14 MB | **219 KB** (both cores, preloaded) |
| session view, plain text, box drawing, Powerline | same files (cached by then) | same 219 KB, nothing more |
| first Nerd icon such as U+F07B | in the TTF | + 591 KB per weight drawn |
| first nf-md icon such as U+F0219 | in the TTF | + 456 KB per weight drawn |

Raw: 5.34 MB → 219 KB, 24.4× smaller; on the wire 3.14 MB → 219 KB, 14.3×. Checked in WebKit
(Playwright, deviceScaleFactor 2): the split files draw ASCII, Latin, box drawing, Powerline,
Nerd and nf-md icons and the `.notdef` box pixel for pixel like the TTFs, regular and bold, with
the same advances; a page with only text and Powerline fetched just the two core files, one
with U+F07B (in the DOM or on a canvas) added `hack-pua-regular`, one with U+F0219
`hack-spua-regular`. Hinting is kept: `--no-hinting` would save 40 KB per core file, but
Windows and Linux browsers use the hints and that was not checked.

The canvas terminal named only the system fonts until now (`TERMINAL_FONT_FAMILY`), none of
them has the Nerd icons; Hack is now first. A canvas does not wait for a web font, and ghostty
measures its cells once, when it opens: the terminal now waits for both core faces
(`document.fonts.load`, at most 1.5 s, in parallel with its WASM) before it opens, and on
`loadingdone` measures again (resizing the canvas if the cells changed) and redraws every row
(`utils/terminal-fonts.ts`). The service worker caches the two core files on install with the
shell.

Icons: on the iPhone SE simulator (iOS 27 Safari) U+F07B and U+F0219 stayed tofu, and the phone
never requested `hack-pua-regular.woff2`: a canvas drawing the character does not fetch its
unicode-range face there, and asking `document.fonts.load(font, text)` did not either. All text
reaches the terminal through its `write()` (the stream, the snapshot replayed while it opens,
cast playback); each write is scanned for Private Use characters, the face whose
`unicode-range` holds one is found in `document.fonts` and loaded directly (`FontFace.load()`,
both weights), and the terminal redraws every row when that promise resolves, not only on
`loadingdone`.

### First paint of the home-screen app

QA on the iPhone SE simulator (iOS 27, standalone, light theme), times from the tap on the icon:
0–2.4 s black (iOS launching), 2.4–5.4 s plain white (mean luma 254: the web view's own white,
not the page's `#fafafa`), the header at 5.9 s, the list at 6.1 s. The boot screen never
showed, while in a Safari tab it does at once.

What held the first paint, all of it served by the service worker, which a cold launch has to
start before it can answer anything:

- `<link rel="stylesheet" href="/bundle/styles.css">` in `<head>`: render-blocking, and the
  boot screen's look (body background `bg-bg`) depended on it;
- `<script src="/theme-init.js">` after it: a parser-blocking script, which also waits for the
  stylesheet above it before running, so `<body>` was not even parsed until both arrived;
- `<script src="/viewport-init.js">` in `<body>`: parser-blocking, from the worker too;
- the boot screen itself faded in 0.4 s after that first paint, and hid as soon as
  `<untether-app>` was defined. Its first paint and the bundle (also from the worker cache)
  came within a few hundred ms of each other, so it was never seen.

Not blocking: the two font preloads (`crossorigin` is required for fonts; a preload never
blocks rendering), the `modulepreload`, and the module script (deferred).

Now the boot screen needs nothing but `index.html`: its CSS and the theme's first-frame
colours are inline; the theme script is an inline copy of `theme-init.js` (`logs.html` still
loads the file), allowed by its hash in the CSP like the other inline script
(`server/utils/csp.ts`, the test recomputes both); `styles.css` is a `media="print"` sheet, so
it is fetched (and preloaded) without blocking, and an inline script applies it on `load` (or
`error`) and sets `data-ut-styles`; `<untether-app>` stays `visibility: hidden` and the boot
screen up until then, so the app never shows unstyled; `viewport-init.js` is `defer` (still
before the bundle). The boot screen shows from the first frame, no fade-in delay.

Each load logs one line to the FE log (`utils/startup-timing.ts`). After the change, on the
same SE: `startup: no worker on the page load, html 36 ms, first paint 76 ms, styles 51 ms
(worker), app code 88 ms`, while the frames still showed black to 1.7 s and the web view's
white from 1.7 to 4.8 s. So that white is iOS starting the home-screen app's WebKit process
before the page is even requested; nothing in the page can shorten it.

What covers it is a launch image: iOS shows an `apple-touch-startup-image` that matches the
screen exactly (device width, height, pixel ratio and orientation) from the tap until the
page paints. `scripts/build-splash-images.py` (Pillow, in the QA venv; `--check` verifies)
draws the boot screen, the icon at 64 pt where `#ut-boot` puts it on the light or dark
first-frame background, for 12 iPhone and 8 iPad screens, portrait and landscape: 80 palette
PNGs, 1.4 MB in all, 7-22 KB each; a device fetches only its own. The links (dark first, with
`prefers-color-scheme: dark`, then light without it) add 23 KB to `index.html`, 5 KB gzipped.
The worker doesn't cache them. iOS reads launch images when the app is added to the home
screen: an installed app shows them only after it is removed and added again. The dark ones
follow the system appearance, not the theme picked in the app.

After a deploy the first launch runs the new build: `index.html` (always from the network)
names the shell version in its file URLs and the worker fetches that version whole before
serving it (next section). That launch waits on the network for the new files once.

## One shell version (2026-10-04)

QA found new markup with old CSS: the Ask box's Claude/Codex picker with icon and name stacked,
the landscape grid not applied, until a later reload. The worker cached the bundle, the
stylesheet and the init scripts as separate entries and revalidated each by its ETag on its
own; on 4020 esbuild writes the JS before `postcss --watch` writes the CSS, and a revalidation
in between stored the new JS next to the old CSS. On a live server the same could happen after
any deploy. Now the shell is versioned as one unit (`src/shared/shell-version.ts`):

- **Build id.** The app build runs with `write: false`; `scripts/client-build-id.js` hashes its
  output (16 hex), writes the id over the placeholder in the entry's `ut-build-id:` literal
  (same length, the source map stays exact; a chunk holding it fails the build, since its name
  would no longer match its bytes), writes the files by rename, chunks first and the entry
  last, unchanged files not at all, and then `public/bundle/.build-id`.
  `scripts/postcss-build-id.js` declares that id in the stylesheet, `:root { --ut-build:
  "<id>" }`, and makes the id file a dependency, so `postcss --watch` rebuilds the CSS after
  each JS build. The prod builds (`build-client.js`, `build.js`) now build the CSS after the
  JS; `dev.js` builds the app, then the CSS, then starts watching. `build-ci.js` (esbuild CLI)
  leaves the placeholder: no id, no check.
- **Server** (`src/server/utils/shell-version.ts`). The shell version id is a hash of the four
  files' contents; `GET /bundle/version.json` (`no-cache`) gives it with each file's SHA-256,
  the build ids found in the bundle and the stylesheet, the chunks the bundle imports
  (recursively) and every chunk it can load. The version is *consistent* when the two build
  ids agree (or neither has one) and every imported chunk exists. While a pair written in the
  last 10 s is not consistent (dev mode, between the JS and the CSS), the server waits up to
  3 s for it before answering `version.json` or `index.html`; one that stays inconsistent is
  answered at once and logged once ("is the CSS watcher running?"). `index.html` is now
  rendered by the server (re-read when it changes) with `?v=<id>` on the shell URLs (`href` and
  `src` attributes only: the inline scripts keep their CSP hashes), `no-cache` in every mode.
  `/bundle/client-bundle.js` keeps its name and `no-cache` + ETag, so `deploy-4020.sh`'s wait
  and the version watch work as before; the query string is ignored by the static handler.
- **Service worker** (`src/client/sw-shell.ts`). Each version has its own cache,
  `untether-shell-v2-<id>`. On a request for `?v=<id>` not cached yet it fetches the manifest
  (it must name that id and be consistent), every shell file (each checked against its
  digest) and the chunks the bundle imports, and only then stores them, a completion marker
  last; a cache without the marker is never served. When the version can't be had whole (the
  server moved on, or its pair is inconsistent), the page gets the newest complete version
  for all its files (pinned for that request id, so a version installed meanwhile can't
  slip in between two files of one page), and is told (`ut-shell-updated`) once a newer
  version is in; with none, the network. The two newest versions are kept; older ones,
  half-installed ones, the old `untether-shell-v1` and chunks no kept version names are
  deleted. Chunks live in `untether-chunks-v1` (cache first; their names are their
  content), fonts and icons in `untether-assets-v1` (stale-while-revalidate). Unversioned
  shell URLs (`logs.html`, curl) go to the network.
- **Page** (`src/client/utils/shell-build-check.ts`, from `app-entry.ts` only). Once the
  stylesheet applies, the bundle's build id is compared with the computed `--ut-build`; when
  both are known and differ it logs `bundle build X runs with stylesheet build Y: reloading`
  to the FE log and reloads, at most once a minute (sessionStorage; no reload when storage is
  blocked).

Checked against a throwaway server of this tree: `version.json`, `/` and the files' digests
agree (brotli on the wire, digests of the decoded bodies); and with `dev.js`'s two watchers
and an edit adding a Tailwind class to `session-list.ts`, 212 samples of `version.json` and `/`
over 12 s named only consistent versions (old, then new 1.1 s after the edit), and reverting
the edit gave back the first id (the build id is a pure function of the output).

## Not done, and why

- **Precompressed brotli 11** for the bundle (−20 % on the wire versus on-the-fly quality 4):
  needs a build step in both the watch and the prod build plus a static handler; small gain
  now that the entry is 69 KB.
- **CSS minification** (`@tailwindcss/postcss` `optimize.minify`): 30 → 28 KB on the wire,
  and lightningcss rewrites the CSS; not worth the risk.
- **modulepreload for the shared chunks**: their names are content hashes, unknown to the
  static `index.html`; the server would have to inject them. The worker and the immutable
  header make them free after the first load.
- **Starting `/api/sessions` before `/api/auth/config` answers**: would save one more round
  trip, but a stale token would go through the 401 path; left as it is.
