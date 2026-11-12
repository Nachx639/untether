<!-- Updated: 2025-12-19 -->

# Testing

Short, reliable gate + forwarder E2E.

## Full Gate (required before handoff)

```bash
./scripts/validate-docs.sh

(
  cd native/ut-fwd
  cargo fmt --all -- --check
  cargo clippy --all-targets --all-features --locked -- -D warnings
  cargo test --all-targets --all-features --locked
  cargo build --release --locked
  python3 test/e2e.py target/release/untether-fwd
)

(
  cd web
  pnpm run build
  pnpm run check
  pnpm run test:ci
)
```

Notes:
- `web/scripts/check-all.sh` runs format:check, lint, lint:typeaware, typecheck, test:ut in parallel.
- `pnpm run test:ci` runs the Vitest suites once with the verbose reporter.

## Rust Formatting + Linting

Rustup installs the pinned formatter and linter components from `native/ut-fwd/rust-toolchain.toml`.

```bash
cd native/ut-fwd
cargo fmt --all -- --check
cargo clippy --all-targets --all-features --locked -- -D warnings
cargo test --all-targets --all-features --locked
```

## Rust Forwarder E2E (random binary → disk artifacts)

Goal: verify `session.json`, `stdout`, `stdin` FIFO, `ipc.sock` exist; stdout has bytes; session exits cleanly.

```bash
cd native/ut-fwd
cargo build --release --locked
python3 test/e2e.py target/release/untether-fwd
```

The Unix-only Python 3 test covers exit propagation, private artifact permissions, random binary output, valid cast JSON, fragmented and oversized IPC frames, heartbeat, resize, stdin, title updates, malformed signals, and process-group termination.

Manual artifact inspection requires a C compiler:

```bash
cat > /tmp/ut-randout.c <<'EOF'
#include <fcntl.h>
#include <unistd.h>
int main(void){int fd=open("/dev/urandom",O_RDONLY);unsigned char b[256];
ssize_t n=read(fd,b,sizeof(b)); if(n>0) write(1,b,(size_t)n);
write(1,"\nDONE\n",6); sleep(1); return 0;}
EOF
cc /tmp/ut-randout.c -o /tmp/ut-randout

# A control dir of its own, never the real ~/.untether
export UNTETHER_CONTROL_DIR="$(mktemp -d /tmp/ut-fwd-test.XXXXXX)"
SESSION_ID="rusttest_$(date +%s)"
CONTROL_DIR="$UNTETHER_CONTROL_DIR/$SESSION_ID"

native/ut-fwd/target/release/untether-fwd --session-id "$SESSION_ID" /tmp/ut-randout > /dev/null &
FWD_PID=$!

# wait for artifacts
for i in {1..50}; do [ -f "$CONTROL_DIR/session.json" ] && break; sleep 0.1; done

ls -la "$CONTROL_DIR"

# artifact checks
test -f "$CONTROL_DIR/session.json"
test -f "$CONTROL_DIR/stdout"
test -S "$CONTROL_DIR/ipc.sock"

wait $FWD_PID

# post-exit checks
wc -c "$CONTROL_DIR/stdout"
tail -n 1 "$CONTROL_DIR/session.json"
```

Expectations:
- `stdout` > 0 bytes.
- `session.json` ends with `}` and includes `status: "exited"` + `exitCode`.

## Web E2E (Playwright)

```bash
cd web
pnpm run test:e2e            # the whole suite, one pass, 4 workers (PLAYWRIGHT_WORKERS=<n> changes it)
pnpm run test:e2e:headed
pnpm run test:e2e:debug
pnpm run test:e2e:report     # the HTML report of the last run
```

- One configuration (`web/playwright.config.ts`), one browser project (Chromium), files and tests in parallel.
- Each run starts its own server (`web/scripts/test-server.js`: `--no-auth`, a throwaway HOME in `/tmp/ut-pw-*`,
  a free port) and never reuses one that is already running, so two checkouts can run the suite at once. It
  compiles the server and the client first when they are older than the code.
- All tests of a run share that server: a test works with the sessions it created (names starting with
  `test-`) and never assumes it is alone (counts, "the first card", an empty list).
- The client's log lines are not posted to the test server during the run (`fixtures/test.fixture.ts`).
- A full pass is a heavy check: inside an Untether task run it as
  `ut check-slot run -- sh -c 'cd web && pnpm run test:e2e'` (`docs/agent-reference.md`).
- A component that only shows behind the login (the test server has none) is tested as a component, e.g.
  `web/src/client/components/ssh-key-manager.test.ts`.

## macOS Tests

```bash
cd mac
./scripts/lint.sh
xcodebuild test
```

## iOS Tests

```bash
cd ios
./scripts/test-with-coverage.sh
```

## Cleanup

```bash
rm -rf "$UNTETHER_CONTROL_DIR" /tmp/ut-randout /tmp/ut-randout.c
```
