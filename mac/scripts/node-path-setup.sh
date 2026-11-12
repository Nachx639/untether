#!/bin/bash

# Load fnm if available
if command -v fnm >/dev/null 2>&1; then
    eval "$(fnm env)" 2>/dev/null || true
fi

# Load NVM if available
if [ -s "$HOME/.nvm/nvm.sh" ]; then
    export NVM_DIR="$HOME/.nvm"
    source "$NVM_DIR/nvm.sh" 2>/dev/null || true
fi

# Check if we're in a build context that needs to avoid Homebrew library contamination
# This is set by build scripts that compile native code
if [ "${UNTETHER_BUILD_CLEAN_ENV:-}" = "true" ]; then
    # For builds, add Homebrew at the END of PATH to avoid library contamination
    # This ensures system libraries are preferred during compilation
    export PATH="$HOME/.volta/bin:$HOME/Library/pnpm:$HOME/.bun/bin:$PATH:/opt/homebrew/bin:/usr/local/bin"
else
    # For normal usage, Homebrew can be at the beginning for convenience
    export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.volta/bin:$HOME/Library/pnpm:$HOME/.bun/bin:$PATH"
fi

# Verify Node.js is available (skip in CI when using pre-built artifacts)
if [ "${SKIP_NODE_CHECK:-false}" = "true" ] && [ "${CI:-false}" = "true" ]; then
    # In CI with pre-built artifacts, Node.js is not required
    return 0 2>/dev/null || exit 0
fi

node_version_supported() {
    local version="$1"
    local major minor
    major=$(echo "$version" | cut -d'.' -f1)
    minor=$(echo "$version" | cut -d'.' -f2)

    case "$major" in ''|*[!0-9]*) return 1 ;; esac
    case "$minor" in ''|*[!0-9]*) return 1 ;; esac
    { [ "$major" -gt 22 ] && [ "$major" -le 24 ]; } ||
        { [ "$major" -eq 22 ] && [ "$minor" -ge 12 ]; }
}

try_node_candidate() {
    local expanded="$1"
    local version

    [ -x "$expanded" ] || return 1
    version=$("$expanded" --version 2>/dev/null | cut -d'v' -f2) || return 1
    if node_version_supported "$version"; then
        UNTETHER_NODE_BIN="$expanded"
        UNTETHER_NODE_VERSION="$version"
        return 0
    fi
    if [ -z "${FIRST_NODE_BIN:-}" ]; then
        FIRST_NODE_BIN="$expanded"
        FIRST_NODE_VERSION="$version"
    fi
    return 1
}

try_node_candidates_under() {
    local root="$1"
    local expanded

    [ -d "$root" ] || return 1
    while IFS= read -r expanded; do
        try_node_candidate "$expanded" && return 0
    done < <(find "$root" -path '*/bin/node' -type f 2>/dev/null)

    return 1
}

try_node_candidates_in_path() {
    local remaining="$PATH"
    local path_dir

    while [ -n "$remaining" ]; do
        path_dir=${remaining%%:*}
        if [ "$remaining" = "$path_dir" ]; then
            remaining=""
        else
            remaining=${remaining#*:}
        fi
        [ -n "$path_dir" ] || path_dir="."
        try_node_candidate "$path_dir/node" && return 0
    done

    return 1
}

find_supported_node() {
    local command_node

    if command -v node >/dev/null 2>&1; then
        command_node=$(command -v node)
        try_node_candidate "$command_node" && return 0
    fi

    try_node_candidate "$HOME/.volta/bin/node" && return 0
    try_node_candidates_under "$HOME/.nvm/versions/node" && return 0
    try_node_candidates_under "$HOME/.fnm/node-versions" && return 0
    try_node_candidate "/opt/homebrew/bin/node" && return 0
    try_node_candidate "/usr/local/bin/node" && return 0
    try_node_candidate "/usr/bin/node" && return 0
    try_node_candidates_in_path && return 0

    return 1
}

FIRST_NODE_BIN=""
FIRST_NODE_VERSION=""
if find_supported_node; then
    export UNTETHER_NODE_BIN
    export UNTETHER_NODE_VERSION
    if [ "${UNTETHER_BUILD_CLEAN_ENV:-}" = "true" ]; then
        UNTETHER_NODE_BIN_DIR=$(dirname "$UNTETHER_NODE_BIN")
        UNTETHER_NODE_SHIM_DIR=$(mktemp -d "${TMPDIR:-/tmp}/untether-node.XXXXXX")
        for tool in node npm npx corepack pnpm; do
            if [ -x "$UNTETHER_NODE_BIN_DIR/$tool" ]; then
                ln -sf "$UNTETHER_NODE_BIN_DIR/$tool" "$UNTETHER_NODE_SHIM_DIR/$tool"
            fi
        done
        export UNTETHER_NODE_BIN_DIR
        export UNTETHER_NODE_SHIM_DIR
        export PATH="$UNTETHER_NODE_SHIM_DIR:$PATH"
    else
        export PATH="$(dirname "$UNTETHER_NODE_BIN"):$PATH"
    fi
elif [ -n "$FIRST_NODE_BIN" ]; then
    echo "error: Node.js 22.12 through 24.x is required (found v$FIRST_NODE_VERSION at $FIRST_NODE_BIN)" >&2
    return 1 2>/dev/null || exit 1
else
    echo "error: Node.js not found. Install via: brew install node" >&2
    return 1 2>/dev/null || exit 1
fi
