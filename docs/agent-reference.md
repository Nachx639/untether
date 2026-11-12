# Agent reference

Reference material for coding agents working in this repository, moved out of the root `CLAUDE.md`
(which keeps only the hard rules and one-line pointers here). Read the section you need on demand.
macOS/iOS build, Poltergeist and `/fixmac` details live in `.claude/rules/apple-builds.md`;
Tailscale CLI syntax in `.claude/rules/tailscale.md` (both load automatically for matching paths).

## Commands

Web (`cd web`):
```bash
pnpm install                 # install dependencies (only with the user's OK, see the package policy)
pnpm run build               # production build
pnpm run dev                 # development server with hot reload
pnpm run check               # all checks in parallel (format, lint, typecheck) - MUST pass before committing
pnpm run check:fix           # auto-fix formatting and linting issues
pnpm run test                # all tests
pnpm run test:coverage       # with coverage report (no threshold enforced)
pnpm run test:e2e            # Playwright E2E tests
pnpm run test:e2e:debug      # debug E2E tests
```

Logs (from the project root):
```bash
./scripts/utlog.sh -n 100            # last 100 lines
./scripts/utlog.sh -e                # errors only
./scripts/utlog.sh -c ServerManager  # specific component
./scripts/utlog.sh -s "error"        # search for text
# NEVER use -f (follow mode) in Claude Code - it will time out!
```

## Input diagnostics: what a phone measures about its keyboard and terminal

Untether is used in Chrome on iOS, which no simulator has, so the device itself reports what it measures. Off by
default; while on, it sends numbers and fixed words only (never what was typed or what the screen shows).

Turning it on, on the device:
- **Settings → Advanced → Input diagnostics**, or add `?kbdebug=1` to the address: paints one small line at the top
  of the screen and sends every 3 seconds. It ends with the next reload (unless the address still says `?kbdebug=1`).
- **Settings → Advanced → Keep on**: remembered on that device, no line on screen, one batch a minute. It can stay on
  for days; turn it off in the same place.

The line on screen: `ih 327 vv 327+0 max 664 | s 0 b 337 = 337` is innerHeight, the visual viewport's height + its
offsetTop, the tallest viewport seen at this width, then the soft keyboard's height by `innerHeight - viewport` (`s`),
by the tallest viewport (`b`), and the one the layout applied. In Chrome on iOS `s` stays near 0 with the keyboard up
(innerHeight shrinks too): `=` must follow `b`.

Reading it on the Mac:
```bash
ut diag input --since 24h            # summary by agent (Claude, Codex, shell), by network and by interface style
ut diag input --since 30m --json     # the same as JSON
./scripts/utlog.sh -s "input-diag" -l 10m   # every measure as a log line (also in /logs)
```
Log lines (`[FE] input-diag`), one per measure:
- `kbd src=vv-resize ih=… vvh=… vvt=… w=… base=… safari=… baseline=… applied=… edit=… · Chrome iOS`: a keyboard
  sample (`src`: start, vv-resize, vv-scroll, resize, focusin, focusout, orientation; `edit`: 1 when a field or a frame
  had the focus).
- `gap id=… agent=… net=… look=… ms=… px=… open=…`: the keyboard's height applied with nothing editable focused, how long
  and how tall (`open=1`: still there when the batch left, the next one carries the rest under the same `id`). A keyboard closing leaves
  short ones; over 1.5 s is the gap with no keyboard, and `ut diag input` counts those apart.
- `keys agent=… net=… look=… n=… p50=… p95=… max=…`: a minute of key presses, ms from a key leaving to the first frame
  after its echo arrived (pastes and keys with no echo within 5 s are not counted; output that is not the echo, such
  as an agent streaming, shortens it).
- `scroll … where=terminal|list frames=… p50=… p95=… slow=…`: frame durations during scroll gestures (`slow`: over 50 ms).
- `open … ms=…`: opening a session until the first frame after its terminal got output.
- `ws … ms=…`: a WebSocket reconnection and how long it was down.

`net` is how the device reaches the Mac (`local`, `lan`, `tailscale`, `internet`) plus the connection type when the
browser tells it (`lan/wifi`; iOS never does). The records are kept in `<control dir>/diag/input.jsonl` (4 MB, one
older file). Code: `web/src/client/utils/input-diagnostics.ts`, `web/src/server/services/input-diagnostics.ts`.

## Web development: development vs production mode

- **Production mode**: the Mac app embeds a pre-built web server during the Xcode build. Every web change
  requires clean → build → run (rebuilds the embedded server); simply restarting serves a STALE, CACHED version.
- **Development mode** (recommended for web development): enable "Use Development Server" in
  Untether Settings → Debug. The Mac app runs `pnpm run dev` instead of the embedded server, with hot reload:
  web changes rebuild without a Mac app rebuild. Restart the Untether server (not a full rebuild) to pick up web changes.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        macOS Menu Bar App                    │
│  (Swift/SwiftUI - mac/Untether/)                         │
│  - ServerManager: Manages server lifecycle                   │
│  - SessionMonitor: Tracks active sessions                    │
└─────────────────────┬───────────────────────────────────────┘
                      │ Spawns & Manages
                      ▼
┌─────────────────────────────────────────────────────────────┐
│                    Node.js/Bun Server                        │
│  (TypeScript - web/src/server/)                             │
│  - server.ts: HTTP server & WebSocket handling              │
│  - pty-manager.ts: Native PTY process management            │
│  - session-manager.ts: Terminal session lifecycle           │
└─────────────────────┬───────────────────────────────────────┘
                      │ WebSocket/HTTP
                      ▼
┌─────────────────────────────────────────────────────────────┐
│                      Web Frontend                            │
│  (TypeScript/LitElement - web/src/client/)                  │
│  - Terminal rendering with ghostty-web                      │
│  - Real-time updates via WebSocket                          │
└─────────────────────────────────────────────────────────────┘
```

Key communication flows:
1. **Session creation**: Client → POST /api/sessions → Server spawns PTY → Returns session ID
2. **Terminal I/O**: one multiplexed WebSocket at `/ws` for every session (v3 framing, `docs/websocket.md`)
3. **Buffer protocol**: binary v3 frames, magic `0x5654` ("VT"), defined in `web/src/shared/ws-v3.ts`
4. **Log aggregation**: Frontend logs → Server → Mac app → macOS unified logging

Critical file locations:
- Entry points: Mac app `mac/Untether/UntetherApp.swift`, server `web/src/server/server.ts`,
  web UI `web/src/client/app.ts`, iOS app `ios/Untether/App/UntetherApp.swift`
- Configuration: Mac version `mac/Untether/version.xcconfig`, web version `web/package.json`,
  build settings `mac/Untether/Shared.xcconfig`
- Terminal management: PTY spawning `web/src/server/pty/pty-manager.ts`, session handling
  `web/src/server/services/terminal-manager.ts`, WebSocket hub `web/src/server/services/ws-v3-hub.ts`, output streaming `web/src/server/services/cast-output-hub.ts`

Key files quick reference:
- What the system is, its parts, routes and where its state lives: `docs/spec.md`
- Sign-in modes, tokens and network exposure: `docs/security.md`
- Build configuration: `web/package.json`, `mac/Untether.xcodeproj`
- External device testing: `docs/TESTING_EXTERNAL_DEVICES.md`
- Gemini CLI instructions: `docs/gemini.md`
- Release process: `docs/RELEASE.md`
- Server measurement (CPU, event loop lag, child processes per minute): `web/scripts/measure-server.mjs`. It signals
  the server it measures (SIGUSR1, inspector on 127.0.0.1:9229), so on the real server it is for the user to run

## `ut` inside an Untether session

Terminal title, when creating pull requests:
- Run `ut title "Brief summary - github.com/owner/repo/pull/123"`
- Keep the title concise (a few words) followed by the PR URL, in github.com format (not https://)
- Update the title periodically as work progresses
- If `ut` fails (it only works inside Untether), ignore the error and continue

Showing a dev server on the phone, after a visual change to a web app whose dev server runs in this
session (vite, next, any `localhost:<port>`):
- `ut open 5173` (a port) or `ut open localhost:3000/settings` (a URL with a path)
- The user's phone opens the "Preview" panel on that session and gets a "Preview ready" notification;
  the page is served through Untether at `/preview/<port>/` (login required)
- Dev servers that print `Local: http://localhost:<port>` are also detected automatically
- Only works inside an Untether session and needs an `untether` build that knows `open`;
  if `ut open` fails, mention the URL instead and continue

## Heavy checks take a check slot: `ut check-slot`

The Mac runs at most `checkLoad.maxConcurrent` heavy checks at once (`~/.untether/config.json`; unset: one per 6
cores, and up to one per 3 while the ones running leave the load a check's worth under the threshold and the Mac has
room for a task) and starts none while its 1-minute load is over `checkLoad.maxLoadPerCore` × cores or memory is short (up to
`checkLoad.maxWaitSec`, then anyway). The checks Untether runs before a merge always took such a slot; since
2026-11-10 (several tasks of one project ran `scripts/check.sh` at once, load 250 on 12 cores, time-limited blocks
failing by load) the runs a task's agent starts take the same ones:

- **Task agents**: nothing to do. The task guard's PreToolUse hook recognises a heavy run (the project's
  `checkCommand`, its `relatedTestCommand` over more than 3 files, `pnpm run test`, `vitest run` without a filter,
  `scripts/check.sh`, also behind a pipe) and makes its shell take a slot first. The agent reads
  `[untether] waiting for a check slot: 2 ahead (2 of 2 running)` and the run starts at its turn. That wait is
  neither agent time nor a "no progress" stall. A run focused on a few files (`vitest run src/a.test.ts`) does not
  wait; neither does a background `… &` (nothing would hold the slot). If the Bash call times out while waiting, run
  the same command again: it keeps its place in line for 15 minutes. Codex cannot have its command rewritten: its
  heavy run is refused once with the `check-slot run` line to use instead.
- **A project's own scripts** (a pre-push hook, a CI-like script, an orchestrator's loop) take one by hand:

```bash
ut check-slot run -- pnpm run test            # waits its turn, runs it, frees the slot; exit code = the command's
ut check-slot run -- 'cd web && pnpm test'    # one argument is run with sh -c
ut check-slot run --max-wait 600 -- scripts/check.sh   # run without a slot after 10 min (default: checkLoad.maxSlotWaitSec, 1800)
ut check-slot status                           # what runs and what waits
```

  For a shell that must run the command itself: `slot=$(ut check-slot acquire --pid $$)`, the command, then
  `ut check-slot release "$slot"` (the slot is also freed when that shell ends).
- **A check that passed on the very same files is not run again** (2026-11-11, `web/src/server/services/check-results.ts`).
  A run that passes is kept under the git tree it ran on (the folder's files as they were, uncommitted and new ones
  included; for a merge, the tree of the commit that enters the base), the exact command, the folder, the lockfiles
  on disk and who ran it. Before a run starts, a kept pass for the same five stands for it and that is said:
  `check: reused, same tree as <when>` (merge.log, `ut task status`, stderr of `ut check-slot`). One byte of
  difference is another tree and it runs; a failed, timed out or stopped run is never kept; a pass on files that
  changed while it ran is not kept; a pass is used for 7 days at most. It applies to the verification runs of the
  merge pipeline (each round, its turn in the merge queue, a merge batch), to `ut check-slot run -- <test or check
  command>` and to the agents' wrapped runs when the command is a check and nothing else (`cd … &&`, `&&` and
  parentheses at most: no pipe, no `;`, no output to a file). A verification never stands on a run made in an
  agent's or a script's shell (other conditions, and the checked party's own word); a shell run does stand on
  Untether's. `ut task verify` and `ut check-slot run --fresh -- …` run whatever was kept. The kept passes live in
  `~/.untether/control/check-results.json`.
- **Task agents run focused tests while they work** (their brief says so, `web/src/shared/task-prompt.ts`): the
  whole check is Untether's, once, when they report done. A whole run of their own is not refused: it takes a slot
  and may be reused as above.
- **Numbers**: `ut task status` (line `time:`) and `ut project stats` (line `checks:`) count each task's check runs
  (and how many its agent started), the ones reused with the time they saved, and the ones that failed with the Mac
  over its load threshold.
- It never keeps a run from happening: without a server (or with an older one), or past the wait limit, the command
  runs without a slot and says so on stderr. Inside a run that already holds a slot (`UNTETHER_CHECK_SLOT` set: a
  wrapped agent command, one of Untether's own verification runs) nothing more is asked for, so a `checkCommand`
  may call `ut check-slot run` itself.
- It needs an `ut` that knows it: `ut check-slot --help` prints its usage. The `ut` of an installed app built
  before 2026-11-10 takes `check-slot` for a command to open a session with; until the app is rebuilt, scripts use
  the checkout's CLI, `web/bin/untether-dev check-slot run -- …` (the agents' hook always uses the running server's
  own CLI, so it is not affected).
- Code: `web/src/server/services/check-slots.ts` (the tickets, on the checks' limiter of `task-verify.ts`),
  `check-slot-wrap.ts` (what is heavy, the rewrite), `web/src/server/check-slot-cli.ts`.

## Tasks that change the same files: overlap and `baseSync`

Each task used to learn what the project's other tasks had merged only at its own merge, all of it at once
(10/11 Nov 2026: four bakery tasks on the same core, two of them 1 h 28 min and 1 h 53 min of "agent on a
conflict" with their work already done and reviewed; three collisions in a day in Untether's own tasks). Since
2026-11-11 (`web/src/server/services/task-scheduler-overlap.ts`, words in `web/src/shared/task-overlap.ts`):

- **The overlap is seen while they work.** Two unfinished worktree tasks of one project that change the same file
  show it on both: `ut task list` (`⇄ touches too: <id> · <file> (+N more)`) and `ut task status` (`overlap:`
  lines, one per other task). The project's orchestrator gets one note per pair ("Tasks … and … both change …"),
  not one per file and never again for that pair; with no orchestrator running, when one starts. It stays in the
  task's metrics (`TaskRecord.metrics.conflicts`, the `shared:` line of `ut task status`, and the project's
  ledger): the tasks it overlapped, base merges made while it worked, conflicts told early, and the conflict
  rounds its merge still needed. Tasks of one parallel group and a task stacked on another's branch are no pair.
- **Cheap.** A working task's folder is looked at with two git commands (`worktreeTouched`: committed, uncommitted
  and untracked files against its base) at most every 2 minutes (`OVERLAP_LOOK_MS`), and only if its agent made
  progress since the last look; a task that is not working is known by the files of its last finish. The 5-second
  tick itself runs no git.
- **A working task is brought up to date when another merges** (`ut project set baseSync=false` turns it off; on by
  default). A task whose files a later merge changed too has a merge pending (`base:` line of `ut task status`).
  At a gap of its agent (its own events: in a turn with no tool call open, nothing waiting to be typed into it,
  not in the merge pipeline) Untether runs `syncWithBase` (`task-worktree.ts`):
  - tracked files with uncommitted changes, or a merge of the agent's own under way: nothing is done; tried again
    at a later gap (every 30 s at most);
  - the merge is computed first without the worktree (`git merge-tree`); clean: the agent's tool calls are held
    back (the task guard's PreToolUse hook waits while `tools-hold.json` in the task's guard folder lasts, 8 s at
    most, and the file ends by itself), then the gap, the clean folder and the commit are checked once more and
    `git merge` runs inside the hold (5 s at most, else it is undone). A session without its guard hook cannot be
    held: nothing is merged for it. Git itself still refuses to overwrite a changed or untracked file. The agent
    is then typed what changed under it, to re-read those files;
  - a conflict: nothing is touched; the agent is typed its files once per base commit, to commit, `git merge
    <base>` and resolve it then, with its context fresh. Left alone it comes back at the merge as before.
  A task that touches nothing of what merged is not disturbed. A task whose agent reports no events (a Claude
  without its hooks, a Codex without a rollout) never has a gap: it meets the base at its merge, as before. The
  merge pipeline and the merge train are not involved.
- **Measured** (`task-scheduler-overlap.test.ts`, real git): two tasks on one file, the first merges while the
  second works and the second then edits the line the first changed: 1 conflict round at its merge with `baseSync`
  off, 0 with it on.

## Tasks started in series: `--after`, zones, and the warning of `ut task new`

Part 2 of the above (2026-11-11; `web/src/shared/task-serial.ts` for the words and the path matching, the waits in
`web/src/server/services/task-scheduler-queue.ts`, tests in `task-scheduler-serial.test.ts`). Starting the second
task after the first merged used to depend on the orchestrator remembering it.

- **`ut task new --after <id>[,<id>…]`** (id, its first characters, or branch). The task goes into its project's
  line in state `queued` with `TaskRecord.after`, without worktree or session, until each named task is `merged`
  or `done`; its worktree is made then, from a base that holds their work. `ut task list` shows `waits for <id>`,
  `ut task status` a `queue:` line with the names and states (`TaskQueued.waitsFor`), the phone «espera a <id>».
  It keeps its place in the line and holds no slot (`maxActiveTasks`): the entries behind it go past it. A named
  task that is `ready` is not merged yet: it still waits.
- **A waited-for task that stops** (`failed`, `discarded`, `missed`, or dropped from the list): the waiting task
  does not start. Whoever it reports to hears it once per stopped task (push `task-queued` with `waitStopped`; for
  an orchestrator an urgent `queued` event whose "Next:" asks for the decision): retry the failed one (the waiting
  one then starts by itself when it merges), `ut task retry <id> --force` (start without that work) or
  `ut task discard <id>`. `ut task new --after` refuses a task that is already discarded and leaves out one
  already merged (it says so).
- **No cycles by construction.** `--after` only names tasks that exist, so every wait points to an older task;
  within a zone a task waits for the ones that started and for the older ones due (queued, or failed and to be
  tried again), one order for all. A started task waits for nobody.
- **Zones.** `ut task new --zone <name>[,<name>…]`, or the project's rules `ut project set
  zones=web/src/client/**=client,mac=mac` ("path pattern=zone": `**` any folders, `*` within a name, a plain
  folder covers what is in it) matched on the paths the prompt names (words with a `/`, file names with an
  extension). Two tasks of one project that share a zone never work at once: the later one waits for the earlier
  until it is merged or closed, exactly like `--after` (`why: 'zone'` in `waitsFor`). A zone is held from
  `preparing` to `ready`; a task still `scheduled` for later holds none. Nothing is guessed: a prompt that names
  no path under a rule gets no zone, with or without `modelRouting`.
- **The warning.** `ut task new` answers `Touches the same as <id> «name» (files): use --after <id> … or leave it
  running` (stderr; `touches` in its JSON) when its prompt names files or folders that an open worktree task of
  the project already changes (part 1's known files: its last finish's and its folder's last look). Nothing is
  held back; tasks it already waits for are not named.

## Tests never beep

A test must never make the Mac play a sound (2026-11-03: WebKit's alert sound woke the user at night on every
task check). WebKit (Playwright's `Playwright.app`) and Chrome play NSBeep when an editing command has nothing to
act on: Cmd+C or Cmd+X with nothing selected, an editing shortcut with no editable element focused. Before such a
key, select something (`getSelection().selectAllChildren(el)`) or focus a field; when the test is about the app's
reaction, dispatch the `copy`/`keydown` event from the page instead of pressing the key. Escape, Enter, Tab,
arrows, Cmd+A, clicks and screenshots don't beep.

Guard: `web/src/test/helpers/system-sound-guard.ts` reads `/usr/bin/log stream` (systemsoundserverd's
"Incoming Request … inClientPID N(Process)" and the client's SystemSoundServer connection) and climbs each
process's parents to the run. Every vitest run watches (`global-setup.ts`; workers mark their test in `setup.ts`)
and fails naming the test and the process chain; the Playwright suite fails through `system-sound-reporter.ts`;
`terminal-copy.browser.ts` names the step. Real check: `UNTETHER_TEST_REAL_BEEP=1 pnpm exec vitest run
src/test/helpers/system-sound-guard.test.ts` (plays one beep).

## Security and robustness tests: the twin

**Security and robustness tests run against the twin (`scripts/gemelo.sh`), never against the real install**
(login attempts, rate limits, request floods, test sessions). 2026-11-08: a review against the real server left 7
failed logins (429 and a temporary account lockout), 200 avatar requests and a test session behind.

```bash
bash scripts/gemelo.sh start   # server from this checkout on 127.0.0.1:4100, HOME=/tmp/utt-gemelo, session zz-gemelo
bash scripts/gemelo.sh reset   # stop, remove the temporary HOME, start and seed again: known state
bash scripts/gemelo.sh stop    # no process, file or zz- session left
bash scripts/gemelo.sh status
eval "$(bash scripts/gemelo.sh env)"                     # GEMELO_URL, GEMELO_TOKEN, GEMELO_HOME
bash scripts/gemelo.sh run -- sh -c 'curl "$GEMELO_URL/api/health"'   # start, command, stop on any exit
```

Send `X-Untether-Local: $GEMELO_TOKEN` to skip the login; without it requests go through the normal login. It only
runs while used (nothing installed) and never touches `~/.untether`, the Mac app's server or the user's sessions.
Never run `tmux kill-server` or any tmux command that closes something without `-S <socket>` inside an Untether
session: `TMUX` selects the real shield server even with another `TMUX_TMPDIR` (it took all sessions down once).

### Rich fictitious data and screenshots

The twin is the only server an agent may start: never the real server, the Mac app, or anything in `~/.untether`.
`--rich` (on `start`, `seed`, `reset` and `run`) fills it with made-up data: three projects with generated logos,
orchestrators, Claude/Codex/shell sessions (working, waiting, finished, suspended), tasks in every state, active and
paused previews and an external provider. It is written before the server starts (`scripts/gemelo-rich-seed.mjs`; its data is one file per fictitious
project in `scripts/gemelo-seed/`, and a new file there is a new project), so
`seed --rich` replaces the twin with a fresh one. No agent runs and no token is spent: "running" sessions are `sleep`
processes, and stubs of `claude`, `codex` and `gemini` come first on the server's PATH. It has no login (`--no-auth`,
127.0.0.1 only), its clock starts at a fixed date (`scripts/gemelo-clock.cjs`), and `stop` removes everything.

```bash
node web/scripts/ui-shots.mjs                               # every view, both browsers, to $TMPDIR/ut-shots
node web/scripts/ui-shots.mjs --style dark                  # a theme (light, dark, system) or an accent id
node web/scripts/ui-shots.mjs --theme dark --accent ocean   # both at once
node web/scripts/ui-shots.mjs --look cyber-hacker           # an interface style (docs/ui-tokens.md); also --views appearance, --gallery, --check-untouchables
node web/scripts/ui-shots.mjs --browsers chromium --views task --out /some/dir
node web/scripts/ui-shots.mjs --locale en --views chat,desktop   # interface and twin data in English (the README's desktop captures, docs/readme/)
node web/scripts/readme-media.mjs                           # the README's GIF (light and dark page) and its strip of styles, see below
node web/scripts/ui-shots-diff.mjs /before /after --out /diff    # compares two folders per view; docs/ui-tokens.md
```

`readme-media.mjs` records the README's GIF on the twin, in English, and writes `docs/readme/untether-light.gif`,
`untether-dark.gif` and `looks.png` (needs ffmpeg). One take of a phone-sized page driven by Playwright (touch taps, a
touch scroll, typing), framed and captioned by ffmpeg; the frames and the master `.mp4` go to `--work` (default
`$TMPDIR/ut-readme-media`), never into the repository. `--only gif|looks` makes one of the two, `--stills` also saves a
picture of each beat. The script's header says what in the take is staged (the agent's answer, the task's states). It
fails if a GIF is over 4 MB or the take over 18 s: shorten the waits, not the size. After regenerating, look at the frames
(`ffmpeg -i docs/readme/untether-light.gif -vf fps=1 /tmp/f-%02d.png`) before committing.

Views: `mobile` (390x844, session list), `desktop` (1440x900, compact sidebar next to a session), `task` (390x844, a
task's sheet), `session` (390x844, a session), `chat` (1440x900, a session in chat mode), `settings` and `create` (390x844)
and `settings-desktop` and `create-desktop` (1440x900). Files are `<browser>-<view>-<style>.png`. `ui-shots.mjs` is only the entry: the views are in
`web/scripts/ui-shots/views/` (one file per group of views; a new view is one entry in its group's file), the twin's
start in `ui-shots/twin.mjs`, the captures in `capture.mjs`, the audits in `audit.mjs` and the gallery in `gallery.mjs`. Each run takes its own HOME and a free port, so runs and tasks
never collide, and the twin is gone when it exits (any exit, Ctrl-C too). Date, time, locale, ports and paths are fixed
and animations off: repeated runs match, except for up to 4 pixels of WebKit antialiasing. A page that does not settle
leaves `*-UNSETTLED-A/B.png`; a view that does not open leaves `*-FAILED.png`. Interface styles come from the registry
(`web/src/shared/looks.ts`). Killed halfway (SIGINT, SIGTERM, SIGHUP or SIGKILL) it leaves no process or folder:
`UNTETHER_TEST_UI_SHOTS=1 pnpm exec vitest run --mode=server src/test/unit/ui-shots-cleanup.test.ts`.

The twin cleans up after itself whatever ends it: traps on EXIT, INT, TERM, HUP and PIPE, a watchdog that takes over when
`gemelo.sh` is killed with -9, and the run stopping if the tool's process or the server dies. The folder carries the
`.untether-test-run` mark from the moment it exists, so the doctor's `stale-test-dirs` removes whatever is still left.

Playwright and its browsers must stay current and free of known CVEs: check `npm view playwright version` and compare
`pnpm exec playwright install --dry-run` with Chrome's stable version before relying on them.

## Testing on external devices (iPad, Safari, etc.)

On the twin, never on a development server with the real HOME (it writes into `~/.untether`: cardinal rule).
`UTT_GEMELO_BIND=0.0.0.0` makes the twin listen on the network, with its login:

```bash
UTT_GEMELO_BIND=0.0.0.0 bash scripts/gemelo.sh start    # or reset, to load changed server code
ipconfig getifaddr en0                                  # this Mac's address on the Wi-Fi
bash scripts/gemelo.sh stop                             # when done: nothing is left listening
```

The device opens `http://<mac-address>:4100` and logs in with the Mac's user and password. `--rich` is refused
on the network (it has no login). The twin serves the client built in `web/public`, without hot reload: after a
client change, `node web/scripts/build-client.js` (what `ui-shots.mjs` runs) and reload the page. What does not need the real device, check
with Playwright's device emulation (`web/scripts/ui-shots.mjs`). Full guide: `docs/TESTING_EXTERNAL_DEVICES.md`.

## Mintlify

The Mintlify configuration file is `docs.json` (never `mint.json`). Mintlify reference: https://mintlify.com/docs/llms.txt
