# Untether Technical Specification

Untether gives access to terminal sessions on a computer from any web browser. A server on the
computer runs the sessions and serves the web interface; a macOS app and an iOS app sit around it.

## Parts

| Path | What it is |
|------|------------|
| `mac/` | macOS menu bar app (Swift/SwiftUI). Starts and stops the server |
| `ios/` | iOS companion app (Swift/SwiftUI). Talks to a server over the same HTTP API and WebSocket |
| `web/src/server/` | The server: Express 5 HTTP API, WebSocket hub, PTY management (TypeScript, Node.js/Bun) |
| `web/src/client/` | The web interface: Lit components, terminal rendered with `ghostty-web` |
| `web/src/shared/` | Types and protocol code used by server and client (`types.ts`, `ws-v3.ts`) |
| `web/bin/ut` | The `ut` command: runs a command inside an Untether session from any terminal |
| `native/ut-fwd/` | `untether-fwd`, the Rust forwarder `ut` launches around a command ([forwarder.md](forwarder.md)) |

### macOS app

`mac/Untether/Core/Services/ServerManager.swift` owns the server's lifecycle and
`BunServer.swift` launches it: the `untether` executable inside the app bundle, or the development
server (`pnpm run dev`, `DevServerManager.swift`) when "Use Development Server" is on. The app passes `--port`, `--bind` and the sign-in
flags that match its settings, and hands the server the local bypass token in the environment
(see [security.md](security.md)).

### Server

`web/src/cli.ts` is the entry point of the `untether` command. Without a subcommand it starts the
server (`startUntetherServer`, `web/src/server/server-start.ts`); the subcommands `fwd`, `status`,
`follow`, `unfollow`, `open`, `git-event`, `task`, `project`, `events`, `check-slot`
and `version` are clients of a running server or one-shot tools.

`web/src/server/server.ts` only re-exports; the server is assembled in `server-app.ts`
(`createApp`) from the setup steps in `server-core.ts`, `server-routes.ts`, `server-static.ts`,
`server-websocket.ts` and `server-listen.ts`. Command-line options are parsed in
`server-config.ts` (`untether --help` prints them). Defaults: port 4020 (or `PORT`), bind address
`0.0.0.0`.

Main pieces:

- `pty/pty-manager.ts` (layers under `pty/pty-manager/`): creates sessions with `node-pty`,
  input, resize, kill, titles, and shielded sessions that run inside tmux so they survive a
  server restart.
- `pty/session-manager.ts`: the session directories on disk.
- `pty/asciinema-writer.ts`: records a session's output as an asciinema v2 file.
- `services/cast-output-hub.ts`: follows those recordings and fans the output out to subscribers.
- `services/terminal-manager.ts`: a server-side Ghostty terminal per session, used for
  snapshots and text.
- `services/ws-v3-hub.ts`: the `/ws` WebSocket hub.
- `services/control-dir-watcher.ts`: notices sessions created outside the server (by `ut`).
- `api-socket-server.ts`: the Unix socket `~/.untether/api.sock` the command-line clients use.
- `middleware/auth.ts`, `routes/auth.ts`, `services/auth-service.ts`: sign-in ([security.md](security.md)).

### Web client

`web/src/client/app-entry.ts` loads the app; `app.ts` is the root component. The terminal is
`components/terminal.ts` (`ghostty-web`); `services/terminal-socket-client.ts` holds the single
WebSocket to `/ws`, and `services/auth-client.ts` the sign-in state. Styling rules:
[ui-tokens.md](ui-tokens.md). Keyboard: [keyboard-shortcuts.md](keyboard-shortcuts.md).

### iOS app

`ios/Untether/App/UntetherApp.swift` is the entry point. `Services/APIClient.swift` calls the
HTTP API and `Services/BufferWebSocketClient.swift` connects to `/ws`.

## Sessions

### Where a session lives

Each session has a directory `~/.untether/control/<session-id>/` (`UNTETHER_CONTROL_DIR`
overrides the root):

- `session.json`: the session's state (`SessionInfo` in `web/src/shared/types.ts`)
- `stdout`: the recording, asciinema v2 (output, input, resize and exit records)
- `ipc.sock`: Unix socket for live input and control commands
  ([socket-protocol.md](../web/docs/socket-protocol.md))

The same layout is written by the server for the sessions it creates and by `untether-fwd` for
the sessions `ut` creates, so the server treats both alike.

### Creating a session

1. A client sends `POST /api/sessions` with `command` (an array), `workingDir` and optionally
   `name`, `cols`, `rows`, `titleMode`, `gitBranch`, `shielded`, `spawn_terminal`, `remoteId`.
2. `PtyManager.createSession` starts the command in a PTY (inside tmux when the session is
   shielded), creates the session directory and begins the recording. With `remoteId` on an HQ
   server the request is forwarded to that remote instead ([hq.md](hq.md)).
3. The response carries the `sessionId`.

From a terminal, `ut <command>` starts `untether-fwd`, which creates the session directory itself;
the server finds it through the control directory watcher.

### Streaming a session

1. The client opens one WebSocket to `/ws` and sends `SUBSCRIBE` for each session it shows.
2. Output goes PTY → `stdout` recording → `CastOutputHub` → `WsV3Hub` → `STDOUT` frames.
3. Previews and resynchronisation use `SNAPSHOT_VT` frames produced by the server-side terminal.
4. Input and resize travel on the same socket (`INPUT_TEXT`, `INPUT_KEY`, `RESIZE`), or over HTTP
   (`POST /api/sessions/:id/input`, `/resize`).

Framing, message types and flags: [websocket.md](websocket.md). The source of truth is
`web/src/shared/ws-v3.ts`.

## State on disk

Everything lives under `~/.untether/`:

| Path | Content |
|------|---------|
| `control/` | One directory per session (above) |
| `config.json` | Settings |
| `jwt-secret` | Key that signs the sign-in tokens (mode 0600) |
| `revoked-tokens.json` | Tokens ended by a logout, until they expire |
| `log.txt` | Server log (`./scripts/utlog.sh` reads it) |
| `api.sock` | Unix socket for the command-line clients |
| `bin/` | The signed tmux copy shielded sessions use |

The browser keeps its sign-in token and interface preferences in `localStorage`.

## HTTP API

All routes are under `/api` and need a sign-in except the ones [security.md](security.md) lists.
The route files in `web/src/server/routes/` are the reference; the main ones:

| Route | Purpose |
|-------|---------|
| `GET /api/health` | Liveness; details only for a signed-in caller |
| `POST /api/auth/password`, `/auth/challenge`, `/auth/ssh-key` | Sign in |
| `GET /api/auth/config`, `/auth/verify`, `POST /api/auth/logout` | Sign-in configuration, token check, logout |
| `GET /api/sessions` | List sessions |
| `POST /api/sessions` | Create a session |
| `GET /api/sessions/:id` | One session |
| `PATCH /api/sessions/:id` | Change a session (for example its name) |
| `DELETE /api/sessions/:id` | Kill a session |
| `DELETE /api/sessions/:id/cleanup`, `POST /api/cleanup-exited` | Remove exited sessions |
| `POST /api/sessions/:id/input` | Send text or a key |
| `POST /api/sessions/:id/resize`, `/reset-size` | Terminal size |
| `GET /api/sessions/:id/text` | The screen as text |
| `POST /api/sessions/:id/suspend`, `/wake`, `/shield` | Suspend, wake, shield |
| `GET /api/fs/browse`, `/fs/preview`, `/fs/raw`, `/fs/diff` | File browser |
| `GET /api/git/repo-info`, `GET/POST/DELETE /api/worktrees` | Git and worktrees |
| `GET/POST /api/tasks`, `GET /api/projects` | Tasks and projects |
| `GET/PUT /api/config` | Settings |
| `GET /api/events`, `/events/stream` | Event log ([events.md](events.md)) |
| `GET /api/push/vapid-public-key`, `POST /api/push/subscribe` | Web push ([push-notification.md](push-notification.md)) |
| `GET /api/remotes`, `POST /api/remotes/register` | HQ mode ([hq.md](hq.md)) |

## WebSocket

One endpoint, `/ws`, binary frames (`"VT"` magic, version 3), every session multiplexed on a
single connection; the web client and the iOS app use the same protocol. A browser passes its
token as `?token=`; a token the server refuses closes the socket with code 4401 so the client
signs in again. See [websocket.md](websocket.md).

## Other listeners

- Dev-server previews are served from a separate listener, the main port + 1 by default
  (`--preview-port`, `off` disables it).
- The project connector listens on `127.0.0.1` at the main port + 3 ([connector.md](connector.md)).

## Related documents

- [security.md](security.md): sign-in modes, flags and limits
- [forwarder.md](forwarder.md), [websocket.md](websocket.md), [socket-protocol.md](../web/docs/socket-protocol.md): protocols
- [build-system.md](build-system.md), [testing.md](testing.md), [RELEASE.md](RELEASE.md): building, testing, releasing
- [agent-reference.md](agent-reference.md): commands, logs, development and production modes
