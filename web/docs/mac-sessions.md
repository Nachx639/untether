# Sessions on this computer ("On this Mac")

The phone's session list has a section for what runs on the computer outside Untether. On macOS it is called **On this Mac**; elsewhere, **On this computer**. It lists two kinds of thing:

- **tmux sessions** on your own tmux servers: one row per tmux session, with the agents running in its panes, its folder, its window count and the other terminals attached to it.
- **Agents outside Untether and outside those tmux sessions**: Claude Code, Codex and Gemini running in a Terminal tab, iTerm2, an IDE's terminal, over SSH, and so on. Each row names the app it runs in.

Rows are ordered by state (waiting for you, working, idle, then tmux sessions without an agent) and, within a state, newest first. At most 100 rows are listed.

The Agents tab shows the same section below mission control, with only the rows that run an agent. They are rows, not mission cards: a broadcast from mission control never types into them.

## What a tap does

**On a tmux session**, Untether opens it: a new Untether session runs a tmux client attached to that tmux session, so the session view, the chat view, the composer, quick answers and pushes all work on it, exactly as for a session started in Untether. If an Untether session is already attached to that tmux session, that one opens instead.

It opens in one of two modes (Settings → "Opening a tmux session"):

- **Ready to type** (`control`, the default): what you type on the phone reaches the tmux session.
- **Watch only** (`watch`): a read-only tmux client. tmux itself drops what you type; "Take control" switches to control.

The client always attaches with tmux's `ignore-size` flag. While a terminal on the computer is attached to the same tmux session, the window keeps that terminal's size and the phone shows a cropped view that follows the cursor. When nothing else is attached, the window takes the phone's size. "Fit to this screen" (control only) makes the window follow whichever client was used last; your other terminals then resize too.

Closing the Untether session **disconnects**: Untether's tmux client detaches and the tmux session keeps running. Such a session can't be shielded and is never offered for "Resume conversation": its program belongs to tmux. After Untether restarts it shows as exited, and the row on this computer can open the tmux session again.

The row's ⋯ offers "Disconnect Untether" only for such a session, whose own program is the tmux client. A tmux session reached from an Untether shell where `tmux attach` was typed, or from a `ut` in a terminal window, also shows as open in Untether, but its row only offers "Go to the open session": ending that session would end the shell, or what runs in that window.

**On an agent**, Untether shows its live status and opens its conversation read-only, followed live from its transcript. Nothing is attached and nothing is typed into it: only the app it runs in can type into it. To control an agent from the phone, start it inside tmux, or with `ut` (then it is an Untether session).

## Sessions started with `ut` in a terminal window

`ut claude` (or any `ut <command>`) typed in a terminal starts an Untether session whose program runs in that window. It is a full Untether session: the phone opens it in the normal session view, with full control. But it belongs to the window: it keeps running when Untether restarts, and it is never offered for shielding, which would close it there.

The phone shows these sessions at the top of the section, with a 🖥 marker and "On the Mac · Terminal" (the app that window belongs to: Terminal, iTerm, Visual Studio Code, SSH session…; just "On the Mac" when it can't be told), and not among the running sessions. Their programs are never listed a second time as agents outside Untether. In the Agents tab they are in that section too, not among mission control's cards, so a broadcast doesn't reach them. With the section turned off (or where the server doesn't offer it), they are running sessions and mission cards like any other, still marked 🖥.

## Claude history never makes a second writer

History (the phone's list of Claude Code conversations) never resumes a conversation that is running right now outside this Untether's sessions: in a terminal tab, a tmux pane, or a session of another Untether instance (a shielded one, or a `ut` in a terminal window that this Untether doesn't list). `claude --resume` here would make a second writer of the same conversation; one running in a session of this Untether opens that session, as before. Such a conversation shows "Open now", and a tap says where it runs instead of resuming it. While this section lists it, the notice also offers "Read it here" (its conversation, read-only) and, for a tmux pane, "Open and control" (its tmux session, opened in Untether).

The server enforces it for every caller: it refuses to start `claude --resume <id>` (or `-r <id>`) while that conversation runs outside Untether. This protection stays on when the section is turned off: it only reads Claude Code's session files and the process list.

## Share with phone

An idle Claude Code running in a plain Terminal or iTerm2 tab (not in tmux, not under `ut`) can be moved under Untether without leaving its tab: the phone's "Share with phone" closes it there with one SIGTERM and types into that same tab the line that reopens the same conversation through `ut`. It then runs in the tab and on the phone, with full control in both. It is off unless turned on, and only on macOS.

What happens after you confirm on the phone:

1. **Checks, before anything changes.** Claude says it is idle (its own session file), and has been for 3 seconds; its transcript ends in a whole line and is still; no Bash command it started is still running; it is the foreground job of a zsh, bash or fish prompt on its tab; and, when the screen is unlocked, that exact tab answers a read-only AppleScript probe within 5 seconds, with no unsent text in Claude's prompt. Any failure: "Nothing was changed."
2. **Close.** One SIGTERM to that process (pid and start time checked again right before). Never SIGKILL and never a second signal: if it hasn't exited in 10 seconds, nothing else is done. Claude Code 2.1.289 exits in about a second, keeps its transcript whole, restores the tab (alternate screen, cursor, mouse and keyboard modes) and prints "Resume this session with: claude --resume <id>".
3. **Reopen.** The shell has the prompt back; the line `cd <folder> && ut claude --resume <id> <options>` is typed into the same tab (`do script … in` that tab for Terminal, `write text` to that session for iTerm2). If the Mac locked meanwhile and nothing was typed yet, it reopens in a new window instead (below).
4. **Hand over.** When the new `ut` session appears, the phone opens it. Claude's trust dialog is confirmed only when it asks about the very folder the conversation was already running in; any other dialog is left for you to answer on the phone.

If something fails after the close, the conversation is saved, and the phone shows the exact command to run in that tab. From the close until the share ends, the conversation counts as running, so History and resume never open it a second time.

**Options carried over.** `ps` shows a process's arguments joined by spaces, so only options whose values are a single plain word are carried (`--model`, `--permission-mode`, `--dangerously-skip-permissions`…). Free-text options (`--append-system-prompt`, `--settings`, `--add-dir`…), modes (`-p`, `--worktree`, `--tmux`…), unknown options and the message it was started with are not; the confirm sheet lists them. The command shown under "Command on the Mac" is exactly what is typed.

**Which `claude`.** The line names the agent as the process was started: a bare `claude` is typed bare (your shell resolves it, as it did), an absolute path still there is typed as is. Untether never looks agents up itself and never runs an agent binary.

**Reopen with.** `ut` (default) types `ut claude …`, which works without any shell setup. "My shell's own command" (`shell`) reloads the tab's startup file (`~/.zshrc`, `~/.bashrc` or fish's `config.fish`) and types `claude …`, for a shell function that already starts Claude through `ut`; with it, a path to Claude itself is typed as `claude` so your function runs. If the reopened Claude doesn't go through `ut`, it keeps running in the tab and the phone says so.

**Permissions.** macOS asks once whether Untether (the app that started the server) may control Terminal or iTerm2; the phone explains this before the first probe. To change your answer: System Settings → Privacy & Security → Automation; `tccutil reset AppleEvents <bundle id>` makes macOS ask again.

**Locked screen.** While the Mac is locked, every Apple Event to Terminal or iTerm2 hangs without an answer. The screen lock is read (`ioreg`) before every AppleScript call, and every `osascript` is killed after 5 seconds, and any still running when the server stops. A locked Mac doesn't refuse the share: the plan says `mode: "new-window"` and runs no AppleScript at all. Claude is closed the same way (idle, one SIGTERM, the same checks), and reopens in a new Terminal window through LaunchServices: `/usr/bin/open -a Terminal <file>.command`, run with a minimal environment. The file lives in a private `mkdtemp` folder under the per-user temp dir (both 0700), deletes itself as its first line, and runs `cd <folder> && exec <shell> -lic '<the same line>'`; the server also removes it after 5 minutes. The old tab is neither read nor typed into, and stays at its shell prompt. Since the tab can't be read, unsent text in Claude's prompt can't be checked: the confirm sheet warns that it would be lost. An iTerm2 agent also reopens in Terminal: in a test with the Mac locked, iTerm2 3.5.4 launched but never ran the file. A shell with no known path (fish outside its usual places) can't get a new window: the share is refused while locked, as before, and after the close it waits for the unlock (up to 15 minutes).

**Not supported yet.** Codex (its close and resume aren't verified), agents in other apps, tmux panes, and subagents running in the background inside Claude (they stop when it closes; the confirm sheet says so).

## Requirements and platforms

- **macOS and Linux.** Elsewhere (and on an HQ server, which has no sessions of its own) the section is off.
- **tmux 3.2 or newer** to open a tmux session (it brought `attach-session -f`, the `ignore-size` client flag and `-N`). Older tmux servers are listed but can't be opened. Without tmux, only agents are listed.
- **No macOS permission prompt** for the list. ("Share with phone", off by default, asks once to control Terminal or iTerm2.) The list only uses `ps`, `lsof` (`/proc` on Linux), the tmux command line on your own sockets, and files in your Claude Code, Codex and Gemini folders. (A session whose folder is in Documents, Desktop or Downloads can trigger the folder-privacy prompt, as any Untether session there can.)

## Settings

| Setting | Where | Default | What it does |
|---|---|---|---|
| `macSessions` | `~/.untether/config.json`; Settings switch "Show sessions from this Mac" | `true` | Lists sessions on this computer and serves their API. Off, nothing is listed and no scan runs, and sessions started with `ut` in a terminal window are among the running ones. |
| `macSessionsOpenMode` | `config.json`; Settings, "Opening a tmux session" | `"control"` | What a tap on a tmux session opens: `"control"` (ready to type) or `"watch"`. |
| `macSessionsIncludeHeadless` | `config.json` only | `false` | Also lists agents without a terminal, and Claude Code processes not started from its CLI (an SDK-driven bot), read-only. |
| `macSessionsHideIn` | `config.json` only | none | Absolute folders (`~` allowed) whose tmux sessions and agents are not listed, below them included. Example: `["/private/tmp/ut-qa-mac"]`. |
| `macShare` | `config.json`; Settings switch "Share Mac terminals with the phone" | `false` | Offers "Share with phone" on idle Claude Code rows in Terminal and iTerm2 (macOS, with a login, not on an HQ). |
| `macShareLauncher` | `config.json`; Settings, "Reopen with" | `"ut"` | `"ut"` or `"shell"` (see Share with phone). |
| `macShareUtPath` | `config.json` only | — | An absolute path to type instead of `ut`. |
| `macShareAutoTrust` | `config.json` only | `true` | Confirms Claude's trust dialog for the folder the conversation was already running in. |
| `macShareStartTimeoutSec` | `config.json` only | `30` | How long the reopened agent may take to appear (5–300). |

### Overrides when the server starts

| Override | Effect |
|---|---|
| `--no-mac-sessions` | Off, whatever Settings says. |
| `UNTETHER_MAC_SESSIONS=0` or `=1` | Off or on, whatever Settings says (`true`/`false`, `on`/`off` and `yes`/`no` work too). |
| `--no-mac-share` | "Share with phone" off, whatever Settings says. |
| `UNTETHER_MAC_SHARE=0` or `=1` | "Share with phone" off or on, whatever Settings says. |

The order is: command line, then environment, then `config.json`, then the default. While an override is in force, Settings shows the switch locked and names it.

### Environment variables

| Variable | Effect |
|---|---|
| `UNTETHER_MAC_SESSIONS_ONLY_IN=/a,/b` | Lists only what runs in one of these folders (or below). Useful for privacy, and for testing on a machine with sessions you don't want to see. |
| `UNTETHER_MAC_SESSIONS_HIDE_IN=/a,/b` | Adds these folders to `macSessionsHideIn`: what runs in them (or below) is not listed. |
| `UNTETHER_TMUX_BIN` | The tmux binary to use. |
| `TMUX_TMPDIR` | Where tmux keeps its sockets (`<dir>/tmux-<uid>/`), as tmux itself reads it. |
| `CLAUDE_CONFIG_DIR` | Claude Code's folder (default `~/.claude`). |
| `CODEX_HOME`, `GEMINI_CLI_HOME` | Codex's and Gemini's folders. |
| `UNTETHER_CONTROL_DIR` | Untether's control folder; its shield tmux server is never listed. |

An item's folder is its tmux session's current pane folder, or the agent's working folder. Folders are compared with links resolved (`/tmp/x` and `/private/tmp/x` are the same) and whole names only: hiding `/a/b` doesn't hide `/a/bc`. When `UNTETHER_MAC_SESSIONS_ONLY_IN` is set it wins: what runs inside its folders is listed even when hidden. That lets two servers on one Mac share `config.json`: a test server started with `UNTETHER_MAC_SESSIONS_ONLY_IN=/private/tmp/ut-qa-mac` lists its own test sessions, while `macSessionsHideIn: ["/private/tmp/ut-qa-mac"]` keeps them out of the everyday server's list.

## What is never listed

- Sessions Untether runs itself, including shielded ones and their tmux servers: this Untether's are among its own sessions, and another instance's are left out altogether (shield sockets are `.shield-tmux` or `-L untether-<hash>`; their tmux sessions are named `ut-<uuid>`).
- Agents running inside another Untether instance's sessions (their environment has `UNTETHER_SESSION_ID`; only the presence of that name is checked).
- Agents without a terminal, unless `macSessionsIncludeHeadless` is set.
- Plain terminal tabs without an agent or tmux, and zellij or GNU screen sessions.

## Safety

- **Same login as the rest of the API.** There is no bypass; `--no-auth` works as it does everywhere else.
- **Clients only send ids the server made**, such as `t-<server pid>-<server start>-<N>`. The socket, pid or tmux target an id names is looked up on the server, in its latest scan; a request never names a socket or a process.
- **On your tmux servers Untether only reads**, and only changes its own tmux client. Every tmux command runs as `tmux -u -N -S <socket> …` (`-N` never starts a server that is gone). It may run `list-panes`, `list-clients` and `has-session`, and, on its own client only (found again by its pid right before), `switch-client -E -r`, `refresh-client -f ignore-size` and `detach-client`. It never runs `send-keys`, `kill-*`, `new-*`, `set-option`, `rename-*`, `select-*` or `resize-*`, and never changes your tmux options. Its client attaches and switches mode with `-E`, so your tmux session's environment (`SSH_AUTH_SOCK`, `DISPLAY` and the rest of `update-environment`) is never replaced with Untether's.
- **Opening is exact.** The tmux session is opened by its id (`$N`), never by name, window or pane, on the server process the list showed: it is checked again (same socket, pid and start time) right before.
- **Agents outside tmux receive no input at all**, except through "Share with phone", which you confirm for one agent at a time: one SIGTERM to that process, and one typed line into its own tab, both after fresh checks of that exact process and tab (fixed AppleScript, values passed as arguments, never System Events or keystrokes). A tmux session receives input only through the client you opened from the phone; in watch mode not even that (Untether also refuses answers and replies to a session watching).
- Nothing reads `~/.claude/sessions/*.key`, environment values (beyond checking for `UNTETHER_SESSION_ID`) or anything outside the agents' own folders, and nothing logs command lines, environments or transcript text.

## Cost

The computer is scanned only while a phone shows the list, at most once every 3 seconds (a forced refresh at most once a second), and never while the section is off. A scan reuses the process list Untether already reads for its own sessions, plus one tmux call per tmux server; on a typical Mac a scan takes a few milliseconds.

## Warnings in the section

| Warning | Meaning |
|---|---|
| tmux isn't installed | Only agents are listed. Said only above listed agents: with nothing to list, the section stays hidden. |
| A tmux server can't be reached: its socket was removed | The server still runs but its socket file is gone (for example, `/tmp` was cleaned). Its agents are listed on their own, read-only. `kill -USR1 <tmux server pid>` makes tmux create the socket again. |
| A tmux server didn't answer | Often a tmux that was upgraded while an old server kept running. Its agents are listed on their own, read-only. |
| Some sessions couldn't be listed | `ps` or tmux gave less than expected; the list may be partial. |
| There are too many to show them all | More than 100 rows. |

## Known limits

- Menus and quick answers on an opened tmux session read Untether's own copy of its client's screen, which includes tmux's status bar and splits, and is cropped while a larger terminal is attached. A menu can then be missed, and a push arrives without quick answers.
- Host app names for iTerm2, Ghostty and IDEs are best effort.
- A Claude Code started with a different `CLAUDE_CONFIG_DIR` than the server's is not seen.

## API

All answers are JSON with `Cache-Control: no-store`; errors are `{ "error": "<code>", "details"?: "…" }`. Types are in `web/src/shared/mac-sessions.ts` and `web/src/shared/mac-share.ts` (share errors are `{ "error": "<code>" }` only).

| Request | Answer | Errors |
|---|---|---|
| `GET /api/mac-sessions[?force=1]` | `MacSessionsResponse`; `enabled: false` (and a `reason`) while off | — |
| `GET /api/mac-sessions/:id/chat[?have=<fingerprint>]` | The conversation of an agent (`a-…`) or of the agent in a tmux pane (`p-…`), shaped like `GET /api/sessions/:id/claude-chat` | 400 `bad-id`, 404 `gone`, 503 `disabled` |
| `POST /api/mac-sessions/:id/open` `{mode?, cols?, rows?}` | `{sessionId, reused, mode}`; `mode` defaults to the setting, `cols`×`rows` (1–1000) to 80×24 | 400 `bad-id`/`bad-request`, 404 `gone`, 409 `tmux-too-old`, 422 `not-openable`, 503 `disabled`, 500 `open-failed` |
| `POST /api/mac-sessions/attached/:sessionId/mode` `{mode?, sizing?}` | `{mode, sizing}` as tmux reports it; `sizing` is `others` (the other terminals keep the size) or `here` | 400 `not-attached`/`bad-request`, 409 `client-not-found`, 500 `mode-failed` |
| `GET /api/sessions`, `GET /api/sessions/:id` | Sessions started with `ut` in a terminal window carry `macWindow: {app}`: the window's app, or `null` until it is found or when it can't be told. It is looked up in the background; the list never waits for it. | — |
| `GET /api/claude/conversations` | Each conversation running outside Untether right now carries `live: {where: 'tmux'\|'terminal', app?, chatId?, tmuxId?, tmuxName?, windowIndex?}`; the ids are there while this section lists it | — |
| `POST /api/sessions` with `claude --resume <id>` | Refused while that conversation runs outside Untether | 409 `live-elsewhere`, with `live` |
| `POST /api/mac-sessions/:id/share/plan` `{allowPrompt?}` | `MacSharePlan`: the exact command, what is and isn't carried over, and a single-use token valid for 2 minutes. Nothing is changed. Without `allowPrompt`, nothing is scripted until this server has scripted that app once (`automation-ask`). | 400 `bad-id`, 403 `no-auth`, 404 `gone`, 409 `busy`/`waiting`/`background-work`/`draft`/`no-conversation`/`in-progress`/`locked`/`tab-not-found`/`tab-ambiguous`/`unresponsive`/`automation-ask`/`automation-denied`/`automation-pending`, 422 `not-shareable`/`agent-not-supported`/`unsupported-app`/`unsupported-shell`/`not-shell-job`/`unsafe-value`, 503 `disabled` |
| `POST /api/mac-sessions/:id/share` `{token}` | 202 `{jobId}`; the same token, agent or tab again gives the same job | 400 `bad-token`, 409 `plan-expired`/`plan-changed` |
| `GET /api/mac-sessions/share/:jobId` | `MacShareJob`: `state` (`running`, `shared`, `aborted`, `still-running`, `failed-after-close`, `relaunch-unknown`), `step`, `closed`, and `sessionId`, `needs`, `error`, `reason` or `resumeCommand` as they apply. Kept 15 minutes after it ends. | 404 |
