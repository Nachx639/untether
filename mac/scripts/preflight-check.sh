#!/bin/bash

# =============================================================================
# Untether Pre-flight Check Script
# =============================================================================
#
# This script validates that everything is ready for an Untether release by
# performing comprehensive checks on git status, build configuration, tools,
# certificates, and the IS_PRERELEASE_BUILD system.
#
# USAGE:
#   ./scripts/preflight-check.sh
#
# VALIDATION CHECKS:
#   - Git repository status (clean working tree, the working repository's main line)
#   - Version information and build number validation
#   - Required development tools (Rust, Node.js, pnpm, GitHub CLI)
#   - Code signing certificates and notarization credentials
#
# EXIT CODES:
#   0  All checks passed - ready to release
#   1  Some checks failed - fix issues before releasing
#
# DEPENDENCIES:
#   - git (repository management)
#   - rustup with Rust 1.97.0 (native forwarder)
#   - node/pnpm (web frontend build)
#   - gh (GitHub CLI)
#   - xcbeautify (optional, build output formatting)
#   - security (keychain access for certificates)
#
# ENVIRONMENT VARIABLES:
#   APP_STORE_CONNECT_KEY_ID        API Key ID (for notarization)
#   APP_STORE_CONNECT_ISSUER_ID     API Key Issuer ID
#   APP_STORE_CONNECT_API_KEY_PATH  the key's .p8 file, or
#   APP_STORE_CONNECT_API_KEY_P8    the content of that file
#
# EXAMPLES:
#   ./scripts/preflight-check.sh
#
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

source "$SCRIPT_DIR/release-lib.sh"

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Track if any checks fail
CHECKS_PASSED=true

echo "🔍 Untether Release Pre-flight Check"
echo "===================================="
echo ""

# Function to print check results
check_pass() {
    echo -e "${GREEN}✅ PASS${NC}: $1"
}

check_fail() {
    echo -e "${RED}❌ FAIL${NC}: $1"
    CHECKS_PASSED=false
}

check_warn() {
    echo -e "${YELLOW}⚠️  WARN${NC}: $1"
}

# 1. Check Git status
echo "📌 Git Status:"
# Refresh the index to avoid false positives
git update-index --refresh >/dev/null 2>&1 || true
if git diff-index --quiet HEAD -- 2>/dev/null; then
    check_pass "Working directory is clean"
else
    check_fail "Uncommitted changes detected"
    git status --short
fi

# The working repository's main line (untether_release_branch), where every task is merged.
# 2026-11-12: this asked for "main" and for HEAD to be origin/main. The working repository has
# no local main, and its origin is a private backup that plays no part in a release: what is
# published is the clean copy of HEAD, pushed to the public repository by release.sh. With
# origin/main hundreds of commits behind, the check failed every release.
RELEASE_BRANCH="$(untether_release_branch)"
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ "$CURRENT_BRANCH" == "$RELEASE_BRANCH" ]]; then
    check_pass "On $RELEASE_BRANCH, the working repository's main line"
else
    check_warn "Not on $RELEASE_BRANCH, the working repository's main line (current: $CURRENT_BRANCH)"
fi

echo ""

# 2. Check version information
echo "📌 Release Host:"
if [[ "$(uname -m)" == "arm64" ]]; then
    check_pass "Running on Apple Silicon"
else
    check_fail "macOS releases require an Apple Silicon host"
fi

echo ""

echo "📌 Version Information:"
VERSION_CONFIG="$PROJECT_ROOT/Untether/version.xcconfig"
if [[ -f "$VERSION_CONFIG" ]]; then
    MARKETING_VERSION=$(grep 'MARKETING_VERSION' "$VERSION_CONFIG" | sed 's/.*MARKETING_VERSION = //')
    BUILD_NUMBER=$(grep 'CURRENT_PROJECT_VERSION' "$VERSION_CONFIG" | sed 's/.*CURRENT_PROJECT_VERSION = //')
    
    echo "   Marketing Version: $MARKETING_VERSION"
    echo "   Build Number: $BUILD_NUMBER"
    
    check_pass "Version configuration found in version.xcconfig"
else
    check_fail "Version configuration file not found at $VERSION_CONFIG"
    MARKETING_VERSION=""
    BUILD_NUMBER=""
fi

# Check for existing pre-release suffix in version
if [[ -n "$MARKETING_VERSION" ]] && [[ "$MARKETING_VERSION" =~ -([a-zA-Z]+)\.([0-9]+)$ ]]; then
    SUFFIX_TYPE="${BASH_REMATCH[1]}"
    SUFFIX_NUMBER="${BASH_REMATCH[2]}"
    check_warn "Version already contains pre-release suffix: $MARKETING_VERSION"
    echo "   Pre-release type: $SUFFIX_TYPE"
    echo "   Pre-release number: $SUFFIX_NUMBER"
    echo "   release.sh publishes the committed version: these arguments match it"
    echo "   Example: ./scripts/release.sh --dry-run $SUFFIX_TYPE $SUFFIX_NUMBER"
fi

echo ""

# Check if Xcode project uses version.xcconfig
echo "📌 Xcode Project Configuration:"
XCODEPROJ="$PROJECT_ROOT/Untether.xcodeproj/project.pbxproj"
if [[ -f "$XCODEPROJ" ]]; then
    if grep -q "version.xcconfig" "$XCODEPROJ"; then
        check_pass "Xcode project references version.xcconfig"
        
        # Check if MARKETING_VERSION uses variable expansion
        if grep -q 'MARKETING_VERSION = "$(inherited)"' "$XCODEPROJ"; then
            check_pass "MARKETING_VERSION uses version.xcconfig value"
        else
            check_warn "MARKETING_VERSION may not use version.xcconfig value"
            echo "   Consider updating to: MARKETING_VERSION = \"\$(inherited)\""
        fi
        
        # Check if CURRENT_PROJECT_VERSION uses variable expansion  
        if grep -q 'CURRENT_PROJECT_VERSION = "$(inherited)"' "$XCODEPROJ"; then
            check_pass "CURRENT_PROJECT_VERSION uses version.xcconfig value"
        else
            check_warn "CURRENT_PROJECT_VERSION may not use version.xcconfig value"
            echo "   Consider updating to use version.xcconfig"
        fi
    else
        check_fail "Xcode project doesn't reference version.xcconfig - versions may not match!"
    fi
else
    check_fail "Xcode project file not found"
fi

echo ""

# 4. Check required tools
echo "📌 Required Tools:"

# Rust toolchain
REQUIRED_RUST_VERSION="1.97.0"
if command -v rustup &> /dev/null; then
    if RUSTC_VERSION=$(rustup run "$REQUIRED_RUST_VERSION" rustc --version 2>/dev/null) &&
        CARGO_VERSION=$(rustup run "$REQUIRED_RUST_VERSION" cargo --version 2>/dev/null); then
        if [[ "$RUSTC_VERSION" == "rustc $REQUIRED_RUST_VERSION "* ]] &&
            [[ "$CARGO_VERSION" == "cargo $REQUIRED_RUST_VERSION "* ]]; then
            check_pass "Rust $REQUIRED_RUST_VERSION toolchain installed"
        else
            check_fail "Rust $REQUIRED_RUST_VERSION required (found $RUSTC_VERSION; $CARGO_VERSION)"
        fi
    else
        check_fail "Rust $REQUIRED_RUST_VERSION toolchain not installed - run: rustup toolchain install $REQUIRED_RUST_VERSION"
    fi
else
    check_fail "rustup not installed - required for Rust $REQUIRED_RUST_VERSION"
fi

# Node.js
if command -v node &> /dev/null; then
    NODE_VERSION="$(node --version)"
    NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
    NODE_MINOR="$(node -p 'process.versions.node.split(".")[1]')"
    if [ "$NODE_MAJOR" -lt 22 ] || [ "$NODE_MAJOR" -gt 24 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 12 ]; }; then
        check_fail "Node.js 22.12 through 24.x required (found $NODE_VERSION)"
    else
        check_pass "Node.js $NODE_VERSION"
    fi
else
    check_fail "Node.js not installed - required for web frontend build"
fi

# pnpm
REQUIRED_PNPM_VERSION="10.15.0"
if command -v pnpm &> /dev/null; then
    # Asked from web/, where package.json pins it ("packageManager"): from mac/ corepack answers
    # with its default, another version (2026-11-12: "pnpm 10.15.0 required (found 12.15.0)").
    INSTALLED_PNPM_VERSION=$(cd "$PROJECT_ROOT/../web" && pnpm --version)
    if [[ "$INSTALLED_PNPM_VERSION" == "$REQUIRED_PNPM_VERSION" ]]; then
        check_pass "pnpm $REQUIRED_PNPM_VERSION installed"
    else
        check_fail "pnpm $REQUIRED_PNPM_VERSION required (found $INSTALLED_PNPM_VERSION)"
    fi
else
    check_fail "pnpm $REQUIRED_PNPM_VERSION not installed"
fi

# GitHub CLI
if command -v gh &> /dev/null; then
    check_pass "GitHub CLI (gh) installed"
    if gh auth status &> /dev/null; then
        check_pass "GitHub CLI authenticated"
    else
        check_fail "GitHub CLI not authenticated - run: gh auth login"
    fi
else
    check_fail "GitHub CLI not installed - run: brew install gh"
fi


# xcbeautify (optional but recommended)
if command -v xcbeautify &> /dev/null; then
    check_pass "xcbeautify installed"
else
    check_warn "xcbeautify not installed (optional) - run: brew install xcbeautify"
fi

echo ""

# 5. Check signing configuration
echo "📌 Signing Configuration:"

# The app is signed with Developer ID Application, its installer (.pkg) with Developer ID
# Installer: two certificates of the same Apple developer account.
if security find-identity -v -p codesigning | grep -q "Developer ID Application"; then
    check_pass "Developer ID Application certificate found"
else
    check_fail "No Developer ID Application certificate found"
fi
if security find-identity -v | grep -q "Developer ID Installer"; then
    check_pass "Developer ID Installer certificate found"
else
    check_fail "No Developer ID Installer certificate found (it signs the .pkg)"
fi

# Check for notarization credentials
if NOTARY_KEY_PROBLEM="$(untether_check_notary_key)"; then
    check_pass "Notarization API key configured"
else
    check_warn "Notarization API key not in environment:"
    sed 's/^/   /' <<< "$NOTARY_KEY_PROBLEM"
fi

echo ""

# Summary
# Summary
echo "📊 Pre-flight Summary:"
echo "===================="

if [[ "$CHECKS_PASSED" == true ]]; then
    echo -e "${GREEN}✅ All critical checks passed!${NC}"
    echo ""
    echo "Ready to release:"
    echo "  Version: $MARKETING_VERSION"
    echo "  Build: $BUILD_NUMBER"
    echo ""
    echo "Next steps (a release is published by hand, on the owner's order):"
    echo "  - Rehearse: ./scripts/release.sh --dry-run stable"
    echo "  - Publish:  ./scripts/release.sh stable --confirm v<version>"
    exit 0
else
    echo -e "${RED}❌ Some checks failed. Please fix the issues above.${NC}"
    exit 1
fi
