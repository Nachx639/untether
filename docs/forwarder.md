# Native Forwarder

`untether-fwd` is Untether's per-session native process. The `ut` wrapper launches it around a command; the web server watches the resulting session artifacts and sends control messages over a Unix socket.

```text
ut -> untether-fwd -> PTY -> child command
                    -> session files and ipc.sock <- web server
```

The implementation is a Rust crate in `native/ut-fwd`. It supports macOS and Linux; Windows is not supported.

## Session Contract

Each session uses `~/.untether/control/<session-id>/` by default. `UNTETHER_CONTROL_DIR` overrides the control root.

- `session.json` contains the current `SessionInfo` state.
- `stdout` is an asciinema v2 stream with output, input, resize, and exit records.
- `ipc.sock` accepts live input and control commands and is removed when the forwarder exits.

The session JSON schema is defined in `web/src/shared/types.ts`. The forwarder creates private directories and artifacts so session contents are not readable by other local users.

## Local Window

The forwarder also copies output to its own stdout, the terminal window `ut` ran in. That copy goes through a 2 MiB queue drained by a dedicated thread (`native/ut-fwd/src/local_output.rs`), so a window that stops draining (a frozen terminal, or Terminal.app with the screen locked) cannot stall the PTY read loop, input, or control commands. A full queue waits up to 250 ms; after that the oldest local output is dropped, one warning goes to the log file, and the child gets `SIGWINCH` to repaint once the window drains again. The `stdout` recording and Untether clients always get everything.

## IPC Contract

Frames use one byte for the message type, a four-byte big-endian payload length, and the payload. `STDIN_DATA` payloads are raw bytes; `CONTROL_CMD` payloads are JSON. The command set includes resize, kill, reset-size, and update-title. Heartbeat frames are echoed.

The server-side framing helpers are in `web/src/server/pty/socket-protocol.ts`. The forwarder independently enforces a 1 MiB inbound payload limit in `native/ut-fwd/src/control_socket.rs`; an oversized frame closes only the offending connection. Unknown message types are ignored.

## CLI Contract

The forwarder accepts a command after its options:

```text
untether-fwd [--session-id <id>] [--title-mode <mode>] [--verbosity <level>] <command> [args...]
```

`--update-title` updates an existing session and exits. Title modes are `none`, `filter`, and `static`. `UNTETHER_TITLE_MODE`, `UNTETHER_LOG_LEVEL`, `UNTETHER_DEBUG`, and `UNTETHER_CONTROL_DIR` are accepted as inherited overrides; explicit CLI options take precedence. The `ut` and web wrappers normally pass title mode and verbosity as CLI options. For the child command, the forwarder exports the active `UNTETHER_SESSION_ID` and `TERM=xterm-256color`.

## Build and Test

Install rustup; `native/ut-fwd/rust-toolchain.toml` selects Rust 1.97.0 and the required rustfmt and Clippy components. `native/ut-fwd/Cargo.lock` pins crate dependencies.

```bash
cd native/ut-fwd
cargo fmt --all -- --check
cargo clippy --all-targets --all-features --locked -- -D warnings
cargo test --all-targets --locked
cargo build --release --locked
python3 test/e2e.py target/release/untether-fwd
```

The release binary is `native/ut-fwd/target/release/untether-fwd`. `node web/scripts/build-fwd-rust.js` builds and installs the host binary for web and macOS packaging; the npm build creates platform-specific forwarder directories.
