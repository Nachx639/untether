#!/bin/bash
#
# Check for Node.js availability for the build process
#
# This script ensures Node.js is available for building Untether
#

set -uo pipefail

# Script directory and paths
if [ -n "${BASH_SOURCE[0]:-}" ]; then
    SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
else
    SCRIPT_DIR="$( cd "$( dirname "$0" )" && pwd )"
fi

echo "Checking for Node.js..."

# Skip Node.js check in CI when web artifacts are pre-built
if [ "${CI:-false}" = "true" ] && [ "${SKIP_NODE_CHECK:-false}" = "true" ]; then
    echo "✓ Skipping Node.js check in CI (web artifacts are pre-built)"
    exit 0
fi

# Load Node.js environment managers and select a supported Node.js for later build phases.
if ! source "${SCRIPT_DIR}/node-path-setup.sh"; then
    echo ""
    echo "Please install Node.js 22.12 through 24.x using one of these methods:"
    echo "  - Homebrew: brew install node"
    echo "  - Download from: https://nodejs.org/"
    echo "  - Using nvm: nvm install 22"
    echo "  - Using volta: volta install node@22"
    echo "  - Using fnm: fnm install 22"
    echo ""
    echo "PATH checked: $PATH"
    exit 1
fi

echo "✓ Node.js found: $(command -v node)"
echo "  Version: $(node --version)"

# Check if pnpm is available
if command -v pnpm &> /dev/null; then
    echo "✓ pnpm found: $(which pnpm)"
    echo "  Version: $(pnpm --version)"
else
    echo "Error: pnpm not found. Please install pnpm."
    echo "  - Install via npm: npm install -g pnpm"
    echo "  - Install via Homebrew: brew install pnpm"
    echo "  - Install via standalone script: curl -fsSL https://get.pnpm.io/install.sh | sh -"
    exit 1
fi

exit 0
