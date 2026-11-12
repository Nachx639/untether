#!/bin/zsh

untether_is_truthy() {
    case "${1:l}" in
        1|true|yes|on)
            return 0
            ;;
    esac
    return 1
}

untether_custom_node_action() {
    local build_config="$1"
    local running_in_ci="$2"
    local require_custom_node="$3"
    local custom_node_path="$4"

    if [[ "$build_config" == "Release" ]] && untether_is_truthy "$require_custom_node"; then
        echo "prepare"
    elif [[ -f "$custom_node_path" ]]; then
        echo "use"
    elif [[ "$build_config" != "Release" ]]; then
        echo "system"
    elif ! untether_is_truthy "$running_in_ci"; then
        echo "prepare"
    else
        echo "system"
    fi
}

# The dependencies of the web build, without ever writing in a node_modules that is not the
# build's own. Run from web/; `node` and `pnpm` are the ones on PATH.
#
#   in sync (scripts/deps-in-sync.js)                 nothing is installed, nothing is written
#   out of sync, and the caller says the checkout is
#   the build's own (UNTETHER_BUILD_OWNS_CHECKOUT)    pnpm install --frozen-lockfile
#   out of sync, anything else                        the build stops and says what to do
#
# The app build and the release NEVER run pnpm install in the tree they are started from,
# whatever its state: only in a worktree made for the build.
#
# 2026-11-12: node-pty is a `file:` dependency and pnpm puts it in place again on every
# install, without its build/: each app build removed pty.node and spawn-helper from the tree
# the development server runs from ("no new session can start"). Whether something runs from
# a tree cannot be known for sure from outside (ps and lsof see only part of it), so the
# build does not guess: it installs only where the tree is declared its own. The installed
# app's updater builds in a worktree of its own and says so (server-app-update.ts); in any
# other checkout, whoever owns it installs when it suits them.
# Nothing is compiled in node_modules either: the bundle's native modules are built apart
# (web/build-native.js).
untether_prepare_web_deps() {
    local state
    if state="$(node scripts/deps-in-sync.js 2>&1)"; then
        echo "Dependencies: ${state}; pnpm install skipped."
        return 0
    fi
    if untether_is_truthy "${UNTETHER_BUILD_OWNS_CHECKOUT:-}"; then
        echo "Dependencies: ${state}; this checkout is the build's own, installing..."
        pnpm install --frozen-lockfile
        return $?
    fi
    echo "error: web/node_modules is not what the lockfile asks for: ${state}."
    echo "error: the app build installs nothing in a checkout that is not its own (pnpm install removes node-pty's build: a server running from here could start no new session)."
    echo "error: the dependencies are not up to date: run 'pnpm install --frozen-lockfile' in web/ yourself, with the server stopped, and build again; or build from a worktree of the build's own (UNTETHER_BUILD_OWNS_CHECKOUT=1)."
    return 1
}
