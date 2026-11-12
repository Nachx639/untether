#!/usr/bin/env bash
# Gemelo: a throwaway Untether server for security and robustness testing.
#
# 2026-11-08: a security review ran against the real server and left traces there: 7 failed
# logins (429 and a temporary account lockout), 200 requests to the avatar endpoint and a test
# session. All the state (jwt-secret, sessions, tmux socket) lives in ~/.untether, so any test
# wrote into the real install. Security/robustness tests run against this twin, never against
# the real install.
#
# Usage: scripts/gemelo.sh start|seed|reset|stop|status|env|run [--rich] -- <command…>
#   start   server from THIS checkout's source (web/src/cli.ts via tsx: always the code you
#           have now, no build) on 127.0.0.1:$UTT_GEMELO_PORT (4100) with
#           HOME=$UTT_GEMELO_HOME (/tmp/utt-gemelo): own state, jwt-secret, tmux sockets and
#           sessions. Then seeds. It only runs while you use it: nothing is installed.
#   seed    fictitious data: a fake project folder and ONE session named zz-gemelo.
#           --rich (also on start, reset and run): projects with generated logos, orchestrators,
#           Claude/Codex/shell sessions and tasks in every state, previews and an external
#           provider (scripts/gemelo-rich-seed.mjs, its data in scripts/gemelo-seed/, one file
#           per fictitious project). The server loads them when it starts, so
#           `seed --rich` replaces the twin with a fresh rich one. It runs on a fixed clock
#           (scripts/gemelo-clock.cjs) and with stubs of claude/codex/gemini first on PATH: no
#           agent runs and no token is spent. UTT_GEMELO_LOCALE=en writes that data in English
#           (scripts/gemelo-seed/locales/en.mjs) instead of Spanish.
#   reset   stop + remove the temporary HOME + start + seed: always the same known state.
#   stop    kills every process of the twin (server, its tmux servers, zz- sessions) and
#           removes the temporary HOME. Leaves nothing.
#   status  whether it runs, its pid, port and HOME.
#   env     prints `export GEMELO_URL=… GEMELO_TOKEN=… GEMELO_HOME=…` for a running twin.
#   run     start + seed, run the command with GEMELO_URL / GEMELO_TOKEN / GEMELO_HOME set,
#           stop on any exit (trap): scripts/gemelo.sh run -- sh -c 'curl "$GEMELO_URL/api/health"'
# UTT_GEMELO_PARENT=<pid> on start, reset, seed --rich or run: the twin is stopped and removed
# when that process ends, however it ends (see "It dies with whoever started it" below).
#
# UTT_GEMELO_BIND=0.0.0.0 on start, reset or run: the twin listens on the network, for a phone or
# a tablet on the same Wi-Fi (http://<this Mac's address>:$UTT_GEMELO_PORT; the address:
# `ipconfig getifaddr en0`). The device logs in with this Mac's user and password, as on the real
# server: the bypass token never leaves the twin's HOME (0600). Refused with --rich, which has no login.
# 2026-11-11: the documented way to try a change on a device was `pnpm run dev --bind 0.0.0.0`,
# a development server with the real HOME, writing into ~/.untether.
#
# Local bypass: the server gets --allow-local-bypass and a random token (UNTETHER_LOCAL_AUTH_TOKEN,
# kept 0600 in the twin's HOME); send it as the X-Untether-Local header. Without it every request
# goes through the normal login, which is what auth tests want. A --rich twin is for looking at
# the interface: it runs with --no-auth, so the browser needs no login.
#
# Isolation (it never touches ~/.untether, the Mac app's server or the user's sessions):
# - the server starts with `env -i`: nothing from the calling shell leaks in (inside an Untether
#   session that would be UNTETHER_SESSION_ID, the real UNTETHER_LOCAL_AUTH_TOKEN, TMUX,
#   CLAUDE_CONFIG_DIR…). HOME, TMPDIR, TMUX_TMPDIR and UNTETHER_CONTROL_DIR all point inside the
#   twin's HOME, so the default tmux socket and the shield tmux socket are its own;
# - every tmux command of this script names the twin's socket with -S and runs without TMUX
#   (inside a tmux session TMUX would select the user's server whatever TMUX_TMPDIR says);
# - no Tailscale (UNTETHER_SKIP_TAILSCALE=1, no --enable-tailscale-*), no mDNS, no connector
#   (4023) or preview port, no launchd job for the shield tmux (UNTETHER_SHIELD_LAUNCHD=0);
# - the HOME must be /tmp/utt-gemelo* (physical path, symlinked parents refused), owned by this
#   user and carry the twin's ownership mark before anything in it is removed; ports 4020-4023
#   (the real server's) are refused;
# - a pid is only signalled after checking it is the twin's server (HOME=<twin> in its
#   environment, web/src/cli.ts in its arguments): a reused pid is never touched;
# - the HOME carries the test-run marker (.untether-test-run) and UNTETHER_TEST_RUN_DIR, so if a
#   twin is ever left behind (kill -9 of this script, a reboot mid-test), the real server's
#   doctor (stray-shield-tmux, stale-test-dirs) closes its tmux server and removes the dir.
#
# It dies with whoever started it (2026-11-10: the doctor removed /tmp/utt-gemelo-shots-<pid> and
# /tmp/utt-gemelo-t<hash> dirs every day). Two causes, both reproduced:
# - a `kill -9` of the whole process tree (a tool's timeout, a check that is stopped) also killed
#   the watchdog, a child of this script, so nobody was left to remove the twin. The watchdog is
#   now a process of its own, away from the tree (parent 1, own group, `watch` below);
# - on every ordinary stop the HOME stood 1-2.5 s with the mark of a pid that had ended (the
#   server is stopped first, the dir removed last), which is exactly what the doctor sweeps.
#   Whoever tears it down now puts its own pid in the mark first.
# `run` is watched always. Any other start is watched when UTT_GEMELO_PARENT=<pid> is set: the
# twin is removed when that process ends (the tests set it, and ui-shots.mjs). What is left for
# the doctor: a kill -9 that names the watchdog too, and a reboot.
#
# The server needs nothing from the Mac app (it runs from source with tmux from PATH), so no
# container is needed. The script is macOS only: it reads processes' environments with `ps -E`.
#
# 2026-11-08, while this script was written, the real shield tmux server died three times. Once
# was this script: its first version ran `tmux kill-server` with TMUX inherited from the Untether
# session it ran in, and TMUX selects the user's server whatever TMUX_TMPDIR says. The other two
# were deliberate `launchctl kickstart -k` restarts by the orchestrator (Full Disk Access for
# the signed tmux). Guard: twin_tmux below, tested with a fake tmux in
# web/src/test/unit/gemelo-script.test.ts.
set -euo pipefail
# Inside a tmux session TMUX selects the user's tmux server: never here (see above).
unset TMUX TMUX_PANE TMUX_TMPDIR

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB_DIR="$REPO_ROOT/web"
G_HOME="${UTT_GEMELO_HOME:-/tmp/utt-gemelo}"
G_PORT="${UTT_GEMELO_PORT:-4100}"
G_BIND="${UTT_GEMELO_BIND:-127.0.0.1}"
G_SESSION="zz-gemelo"
RICH=""
G_UID="$(id -u)"
OWNER_MARK="untether-gemelo"
# Which start made the twin in G_HOME (.gemelo/instance): a watchdog only touches its own.
G_INSTANCE="$$-$RANDOM$RANDOM"

die() {
  echo "gemelo: $*" >&2
  exit 1
}

# The guards that keep it off the real install. Checked before anything is written or removed.
# G_HOME becomes its physical path (/tmp is /private/tmp on macOS).
guard() {
  [[ "$G_PORT" =~ ^[0-9]+$ ]] || die "UTT_GEMELO_PORT must be a number"
  if ((G_PORT >= 4020 && G_PORT <= 4023)); then die "port $G_PORT belongs to the real server"; fi
  [[ "$G_BIND" == 127.0.0.1 || "$G_BIND" == 0.0.0.0 ]] || die "UTT_GEMELO_BIND must be 127.0.0.1 or 0.0.0.0 (got $G_BIND)"
  local name parent
  name="$(basename -- "$G_HOME")"
  [[ "$name" =~ ^utt-gemelo[A-Za-z0-9._-]*$ ]] || die "UTT_GEMELO_HOME must be named utt-gemelo* (got $G_HOME)"
  parent="$(cd "$(dirname -- "$G_HOME")" 2>/dev/null && pwd -P)" || die "parent of $G_HOME missing"
  [[ "$parent" == /private/tmp || "$parent" == /tmp ]] || die "UTT_GEMELO_HOME must be directly in /tmp (its parent resolves to $parent)"
  G_HOME="$parent/$name"
  if [[ -L "$G_HOME" ]]; then die "$G_HOME is a symlink: refused"; fi
  G_META="$G_HOME/.gemelo"
  G_CONTROL="$G_HOME/.untether/control"
  G_TMUX_DEFAULT="$G_HOME/tmux/tmux-$G_UID/default"
}

# Whether no component of a path inside G_HOME is a symlink: a text prefix proves nothing when
# .untether/control is a link to the real control dir (2026-11-08 review).
no_links() {
  local p="$1"
  while [[ "$p" != "$G_HOME" ]]; do
    [[ ! -L "$p" ]] || return 1
    p="$(dirname -- "$p")"
    [[ "$p" == "$G_HOME"* ]] || return 1
  done
}

# The only way this script runs tmux: on a socket inside the twin's HOME, named with -S, and
# without the variables that select another server.
twin_tmux() {
  if [[ "${1:-}" != "-S" || "${2:-}" != "$G_HOME/"* || "${2:-}" == *..* ]] || ! no_links "$2"; then
    die "refused: tmux $* (only -S <socket inside $G_HOME>, no symlinks on the way)"
  fi
  env -u TMUX -u TMUX_TMPDIR tmux "$@" 2>/dev/null
}

# Whether G_HOME is a twin's HOME this user made: a real dir owned by us with the mark inside.
owned_home() {
  [[ -d "$G_HOME" && ! -L "$G_HOME" && -O "$G_HOME" && ! -L "$G_META" ]] || return 1
  [[ -f "$G_META/owner" && ! -L "$G_META/owner" && -O "$G_META/owner" ]] || return 1
  [[ "$(cat "$G_META/owner")" == "$OWNER_MARK $G_HOME" ]]
}

# Whether HOME=<twin HOME> is in pid's ENVIRONMENT. `ps -E` prints the arguments and then the
# environment on one line: only what follows the plain command line counts. 2026-11-08, reading
# the whole line, `stop` killed the shell of whoever had " HOME=<twin> " in a command (a grep).
has_twin_home() {
  local pid="$1" plain full
  plain="$(ps -ww -o command= -p "$pid" 2>/dev/null)" || return 1
  full="$(ps -wwE -o command= -p "$pid" 2>/dev/null)" || return 1
  [[ -n "$plain" && "$full" == "$plain"* ]] || return 1
  [[ "${full#"$plain"} " == *" HOME=$G_HOME "* ]]
}

# Whether pid is this twin's server: HOME=<twin HOME> in its environment and web/src/cli.ts in
# its arguments (a pid reused by another process, the real server included, is not).
is_twin_server() {
  local pid="$1"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  has_twin_home "$pid" && [[ "$(ps -ww -o command= -p "$pid" 2>/dev/null)" == *"src/cli.ts"* ]]
}

server_pid() {
  local pid
  pid="$(cat "$G_META/pid" 2>/dev/null)" || return 1
  is_twin_server "$pid" || return 1
  echo "$pid"
}

# Every process of the twin: HOME=<its HOME> in its environment (the server, tsx, the sessions'
# shells, its tmux servers) or a tmux started on a socket inside it (-S <HOME>/…). Never a
# process that merely names the twin: 2026-11-08, matching text anywhere in the line killed the
# shell that ran `stop` (its command held the path), and would kill an editor or a `tail` of the
# twin's log. Not a shell with UTT_GEMELO_HOME=… exported either, nor this script.
twin_pids() {
  local out pid ppid line
  out="$(ps -wwE -U "$G_UID" -o pid=,ppid=,command= 2>/dev/null)" || true
  while read -r pid ppid line; do
    [[ -n "$pid" ]] || continue
    [[ "$pid" == "$$" || "$ppid" == "$$" || "$pid" == "${BASHPID:-}" ]] && continue
    [[ "$line" == *"$G_HOME"* ]] || continue
    if has_twin_home "$pid"; then
      echo "$pid"
    elif [[ "$(ps -ww -o command= -p "$pid" 2>/dev/null)" =~ ^[^[:space:]]*tmux[[:space:]]+-S[[:space:]]+"$G_HOME"/ ]]; then
      echo "$pid"
    fi
  done <<<"$out"
}

health() {
  curl -fsS --max-time 2 "http://127.0.0.1:$G_PORT/api/health" 2>/dev/null
}

teardown() {
  local pid pids
  # Before any signal, tmux or launchctl: everything below acts on what this dir says (its pid
  # file, its sockets), so a dir that is not a twin's HOME gets nothing done at all.
  if [[ -e "$G_HOME" ]] && ! owned_home; then
    die "$G_HOME exists but is not a twin's HOME (no ownership mark): nothing done"
  fi
  # The mark names a live process until the dir is gone: with the server's pid in it, every stop
  # left a dir "marked by a pid that has ended" for as long as the rest takes (2026-11-10).
  if [[ -e "$G_HOME" && ! -L "$G_HOME/.untether-test-run" ]]; then mark_run "$$"; fi
  if pid="$(server_pid)"; then
    # Started as its own process group leader (set -m): TERM the group, else the pid.
    if [[ "$(ps -o pgid= -p "$pid" | tr -d ' ')" == "$pid" ]]; then
      kill -TERM -- "-$pid" 2>/dev/null || true
    else
      kill -TERM "$pid" 2>/dev/null || true
    fi
    for _ in $(seq 1 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
  fi
  # Its tmux servers, always by their socket path inside the twin's HOME (never the default
  # selection), and with them every zz- session.
  if command -v tmux >/dev/null; then
    local socket
    for socket in "$G_CONTROL/.shield-tmux" "$G_TMUX_DEFAULT"; do
      # A socket whose server already ended makes kill-server fail: that is not a failed stop.
      if [[ -S "$socket" ]]; then twin_tmux -S "$socket" kill-server || true; fi
    done
  fi
  if [[ "$(uname)" == Darwin ]]; then
    # Never started (UNTETHER_SHIELD_LAUNCHD=0); unloaded anyway, only this control dir's label.
    local hash
    hash="$(printf '%s' "$G_CONTROL" | shasum -a 1 | cut -c1-12)"
    launchctl bootout "gui/$G_UID/com.nachx639.untether.shield-tmux.$hash" 2>/dev/null || true
  fi
  pids="$(twin_pids)"
  if [[ -n "$pids" ]]; then
    # shellcheck disable=SC2086
    kill -TERM $pids 2>/dev/null || true
    sleep 1
    pids="$(twin_pids)"
    # shellcheck disable=SC2086
    [[ -z "$pids" ]] || kill -KILL $pids 2>/dev/null || true
  fi
  # The rich seed's fake sessions, if its keeper could not end them (killed with -9). Platform
  # binaries: `ps -E` shows no environment, so twin_pids cannot see them.
  local fake
  while read -r fake; do
    if [[ "$fake" =~ ^[0-9]+$ && "$(ps -o command= -p "$fake" 2>/dev/null)" == "/bin/sleep 21600" ]]; then
      kill -TERM "$fake" 2>/dev/null || true
    fi
  done < <(cat "$G_META/fake-pids" 2>/dev/null || true)
  rm -rf -- "$G_HOME"
  pids="$(twin_pids)"
  [[ -z "$pids" ]] || die "processes left after stop: $pids"
  [[ ! -e "$G_HOME" ]] || die "$G_HOME left after stop"
}

mark_run() {
  printf '{"pid":%s,"at":%s,"runDir":"%s"}' "$1" "$(($(date +%s) * 1000))" "$G_HOME" >"$G_HOME/.untether-test-run"
}

start() {
  [[ -x "$WEB_DIR/node_modules/.bin/tsx" ]] || die "web/node_modules missing: run pnpm install in web/"
  command -v tmux >/dev/null || die "tmux not on PATH"
  # 2026-11-09: a `pnpm up` re-linked node_modules without node-pty's build and the server died
  # at start with "Cannot find module '../build/Release/pty.node'".
  if [[ -f "$WEB_DIR/scripts/ensure-native-modules.js" ]] \
    && ! compgen -G "$WEB_DIR/node_modules/.pnpm/node-pty@*/node_modules/node-pty/build/Release/pty.node" >/dev/null; then
    echo "gemelo: building the native modules (node-pty)"
    (cd "$WEB_DIR" && node scripts/ensure-native-modules.js >/dev/null) || die "could not build node-pty"
  fi
  if lsof -nP -iTCP:"$G_PORT" -sTCP:LISTEN >/dev/null 2>&1; then die "port $G_PORT is taken"; fi
  # Leftovers of an earlier twin (a kill -9): start from nothing.
  teardown

  mkdir -m 700 "$G_HOME"
  mkdir -p -m 700 "$G_META" "$G_HOME/tmux"
  mkdir -p "$G_HOME/tmp" "$G_CONTROL"
  printf '%s %s' "$OWNER_MARK" "$G_HOME" >"$G_META/owner"
  printf '%s\n' "$G_INSTANCE" >"$G_META/instance"
  # From the first moment, whoever made it: the doctor's stale-test-dirs removes a marked dir
  # whose pid has ended (2026-11-09: a run cut short left /tmp/utt-gemelo-shots-40684 behind).
  mark_run "$$"
  local token
  token="$(openssl rand -hex 32)"
  (umask 077 && printf '%s' "$token" >"$G_META/token")

  # Written before the server starts: it loads tasks, sessions and settings once, at start.
  local server_path="$PATH"
  local -a rich_env=()
  if [[ -n "$RICH" ]]; then
    node "$REPO_ROOT/scripts/gemelo-rich-seed.mjs" "$G_HOME" "$G_CONTROL"
    server_path="$G_HOME/fake-bin:$PATH"
    # Quoted inside NODE_OPTIONS, which node splits on spaces (a checkout path may hold them).
    local clock_module="$REPO_ROOT/scripts/gemelo-clock.cjs"
    clock_module="${clock_module//\\/\\\\}"
    clock_module="${clock_module//\"/\\\"}"
    # The server's clock starts at the seed's fixed "now" (rich.json holds it).
    rich_env=(UTT_GEMELO_CLOCK="$(sed -n 's/.*"now": \([0-9]*\).*/\1/p' "$G_META/rich.json")" NODE_OPTIONS="--require=\"$clock_module\"")
  fi

  set -m # the server gets its own process group, which stop kills as a whole
  (
    cd "$WEB_DIR"
    exec env -i \
      ${rich_env[@]+"${rich_env[@]}"} \
      PATH="$server_path" HOME="$G_HOME" USER="${USER:-$(id -un)}" LOGNAME="${LOGNAME:-$(id -un)}" \
      SHELL=/bin/bash TERM=xterm-256color LANG="${LANG:-en_US.UTF-8}" \
      TMPDIR="$G_HOME/tmp" TMUX_TMPDIR="$G_HOME/tmux" \
      UNTETHER_CONTROL_DIR="$G_CONTROL" \
      UNTETHER_LOCAL_AUTH_TOKEN="$token" \
      UNTETHER_SKIP_TAILSCALE=1 UNTETHER_SHIELD_LAUNCHD=0 \
      UNTETHER_CONNECTOR_PORT=off UNTETHER_PREVIEW_PORT=off \
      UNTETHER_TEST_RUN_DIR="$G_HOME" UNTETHER_SEA= FORCE_COLOR=0 \
      "$WEB_DIR/node_modules/.bin/tsx" src/cli.ts \
      --port "$G_PORT" --bind "$G_BIND" --allow-local-bypass --no-mdns \
      ${RICH:+--no-auth}
  ) </dev/null >"$G_META/server.log" 2>&1 &
  local pid=$!
  set +m
  echo "$pid" >"$G_META/pid"
  # Now the server's: the real server's doctor removes this dir (and closes its tmux) if a twin
  # is ever left behind once this pid is gone.
  mark_run "$pid"

  local up=""
  for _ in $(seq 1 300); do
    kill -0 "$pid" 2>/dev/null || break
    if health >/dev/null; then up=1; break; fi
    sleep 0.2
  done
  if [[ -z "$up" ]]; then
    echo "gemelo: the server did not answer /api/health; its log:" >&2
    tail -40 "$G_META/server.log" >&2 || true
    return 1
  fi
  echo "gemelo: up on http://$G_BIND:$G_PORT (pid $pid, HOME $G_HOME)"
  if [[ "$G_BIND" != 127.0.0.1 ]]; then
    echo "gemelo: on the network: a device on the same Wi-Fi opens http://<this Mac's address>:$G_PORT and logs in with this Mac's user and password"
  fi
}

api() {
  local method="$1" path="$2" body="${3:-}"
  # The token goes to curl on stdin (printf is a builtin): in its arguments any user of this Mac
  # could read it with ps while the request lasted.
  printf 'X-Untether-Local: %s\n' "$(cat "$G_META/token")" |
    curl -fsS --max-time 15 -X "$method" -H @- \
      -H 'Content-Type: application/json' ${body:+--data "$body"} "http://127.0.0.1:$G_PORT$path"
}

seed() {
  server_pid >/dev/null || die "not running (scripts/gemelo.sh start)"
  # The rich state went in before the server started (start).
  if [[ -n "$RICH" ]]; then return 0; fi
  # Fictitious data only: a fake project and one session that runs `cat` in it.
  local project="$G_HOME/proyecto-ficticio"
  mkdir -p "$project"
  printf '# Proyecto ficticio del gemelo\n\nDatos de prueba, sin valor.\n' >"$project/README.md"
  if api GET /api/sessions | grep -q "\"name\":\"$G_SESSION\""; then
    echo "gemelo: $G_SESSION already there"
    return 0
  fi
  api POST /api/sessions "{\"name\":\"$G_SESSION\",\"command\":[\"/bin/cat\"],\"workingDir\":\"$project\",\"titleMode\":\"none\"}" >/dev/null
  echo "gemelo: seeded $project and session $G_SESSION"
}

status() {
  local pid
  if pid="$(server_pid)"; then
    echo "gemelo: running, pid $pid, http://$G_BIND:$G_PORT, HOME $G_HOME"
    if health >/dev/null; then echo "gemelo: /api/health answers"; else echo "gemelo: /api/health does not answer"; fi
  else
    echo "gemelo: not running"
    if [[ -e "$G_HOME" ]]; then echo "gemelo: $G_HOME exists (leftover: scripts/gemelo.sh stop)"; fi
  fi
}

print_env() {
  server_pid >/dev/null || die "not running"
  echo "export GEMELO_URL=http://127.0.0.1:$G_PORT GEMELO_TOKEN=$(cat "$G_META/token") GEMELO_HOME=$G_HOME"
}

# Any failure, Ctrl-C or kill between the first write and a finished start + seed tears the
# twin down (EXIT trap with a done flag: errexit and ERR traps are off inside `a && b`).
UP_DONE=""
KEEP_RUNNING=""
on_exit() {
  local rc=$?
  # A reader that went away (`| head`) or a second signal (TERM after HUP, Ctrl-C twice) must
  # not cut the cleanup short.
  trap '' PIPE HUP INT TERM
  if [[ -z "$UP_DONE" || -z "$KEEP_RUNNING" ]]; then
    trap - EXIT
    teardown || rc=1
  fi
  exit "$rc"
}

bring_up() {
  trap on_exit EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  # 2026-11-09: only EXIT, INT and TERM were handled, so a closed pipe or a closed terminal
  # ended the script with the twin still up.
  trap 'exit 129' HUP
  trap 'exit 141' PIPE
  start
  seed
  UP_DONE=1
}

# The instance of the twin now in G_HOME, empty when there is none.
current_instance() {
  local found=""
  { read -r found <"$G_META/instance"; } 2>/dev/null || true
  echo "$found"
}

# Removes the twin of one start when a process it depends on ends without having done it: this
# script killed with -9 (run), or the process UTT_GEMELO_PARENT names. A process of its own, not
# a subshell: started through a subshell that ends at once, so its parent is 1 and killing the
# tree of this script does not reach it, and in its own group, so a signal to the group does not
# either.
start_watchdog() {
  (
    set -m
    bash "${BASH_SOURCE[0]}" watch "$G_INSTANCE" "$$" "$@" </dev/null >/dev/null 2>&1 &
  )
}

# watch <instance> <launcher pid> <owner pid…>: the watchdog itself.
watch() {
  local instance="$1" launcher="$2" seen="" owner
  shift 2
  trap '' HUP PIPE INT TERM
  while :; do
    if [[ "$(current_instance)" == "$instance" ]]; then
      # From inside the HOME: a dir some process has as its cwd is in use, so neither the doctor
      # nor a test run's sweep of dead runs removes it under a watchdog that is about to.
      if [[ -z "$seen" ]]; then cd "$G_HOME" 2>/dev/null || true; fi
      seen=1
    elif [[ -n "$seen" ]] || ! kill -0 "$launcher" 2>/dev/null; then
      return 0 # stopped by someone else, replaced by a newer twin, or it never came up
    fi
    for owner in "$@"; do
      kill -0 "$owner" 2>/dev/null || break 2
    done
    sleep 1
  done
  if [[ "$(current_instance)" == "$instance" ]]; then
    cd /
    teardown
  fi
}

# The processes whose end takes the twin with it.
watched_parent() {
  [[ -z "${UTT_GEMELO_PARENT:-}" ]] && return 0
  [[ "$UTT_GEMELO_PARENT" =~ ^[0-9]+$ ]] || die "UTT_GEMELO_PARENT must be a pid"
  echo "$UTT_GEMELO_PARENT"
}

# A twin that stays up after this script ends is watched only when it was given a parent.
watch_parent() {
  local parent
  parent="$(watched_parent)"
  if [[ -n "$parent" ]]; then start_watchdog "$parent"; fi
}

# Sourced (the tests call twin_tmux directly), it only defines the functions.
if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then return 0; fi

[[ "$(uname)" == Darwin ]] || die "macOS only (it reads processes' environments with ps -E)"
guard
if [[ "${2:-}" == "--rich" ]]; then
  RICH=1
  set -- "$1" "${@:3}"
fi
# A rich twin runs with --no-auth: anyone on the network would get a shell on this Mac.
if [[ -n "$RICH" && "$G_BIND" != 127.0.0.1 ]]; then
  die "a --rich twin has no login: it only listens on 127.0.0.1 (unset UTT_GEMELO_BIND)"
fi
case "${1:-}" in
  start)
    if server_pid >/dev/null; then die "already running (scripts/gemelo.sh status); reset or stop first"; fi
    KEEP_RUNNING=1
    watch_parent
    bring_up
    ;;
  reset)
    teardown # stop + remove the HOME, then a fresh twin from nothing
    KEEP_RUNNING=1
    watch_parent
    bring_up
    ;;
  seed)
    if [[ -n "$RICH" ]]; then
      teardown # it is loaded at start: a fresh twin that holds it
      KEEP_RUNNING=1
      watch_parent
      bring_up
    else
      seed
    fi
    ;;
  stop)
    teardown
    echo "gemelo: stopped, nothing left"
    ;;
  status) status ;;
  watch)
    shift
    watch "$@"
    ;;
  env) print_env ;;
  run)
    shift
    [[ "${1:-}" == "--" ]] && shift
    (($#)) || die "run needs a command: scripts/gemelo.sh run -- <command…>"
    # shellcheck disable=SC2046
    start_watchdog "$$" $(watched_parent)
    bring_up # KEEP_RUNNING stays empty: on_exit tears down when the command ends
    GEMELO_URL="http://127.0.0.1:$G_PORT" GEMELO_TOKEN="$(cat "$G_META/token")" GEMELO_HOME="$G_HOME" "$@"
    ;;
  *)
    sed -n '2,31p' "$0" | sed 's/^# \{0,1\}//' >&2
    exit 2
    ;;
esac
