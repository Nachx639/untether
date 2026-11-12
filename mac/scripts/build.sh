#!/bin/bash

# =============================================================================
# Untether Build Script
# =============================================================================
# 
# This script builds the Untether application using xcodebuild and produces a
# code-signed app bundle (ad-hoc or certificate-based, depending on environment).
# It includes comprehensive error checking and reports
# build details including the IS_PRERELEASE_BUILD flag status.
#
# USAGE:
#   ./scripts/build.sh [--configuration Debug|Release] [--no-sign] [--arch arm64]
#
# ARGUMENTS:
#   --configuration <Debug|Release>  Build configuration (default: Release)
#   --no-sign                        Disable code signing (not recommended)
#   --arch <arm64>                   Architecture to build (default: arm64)
#
# ENVIRONMENT VARIABLES:
#   IS_PRERELEASE_BUILD=YES|NO      Sets pre-release flag in Info.plist
#   MACOS_SIGNING_CERTIFICATE_P12_BASE64  CI certificate for signing
#   USE_CUSTOM_DERIVED_DATA=YES     Force custom derived data (default: NO)
#                                   When NO, uses Xcode's default to preserve
#                                   Swift package resolution
#
# OUTPUTS:
#   - Built app at: build/Build/Products/<Configuration>/Untether.app
#   - Version and build number information
#   - IS_PRERELEASE_BUILD flag status verification
#
# DEPENDENCIES:
#   - Xcode and command line tools
#   - xcbeautify (optional, for prettier output)
#
# EXAMPLES:
#   ./scripts/build.sh                           # Release build (Apple Silicon)
#   ./scripts/build.sh --configuration Debug     # Debug build (Apple Silicon)
#   ./scripts/build.sh --no-sign                 # Release build without signing (not recommended)
#   IS_PRERELEASE_BUILD=YES ./scripts/build.sh   # Beta build (Apple Silicon)
#
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAC_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_DIR="$(dirname "$MAC_DIR")"
BUILD_DIR="$MAC_DIR/build"
source "$SCRIPT_DIR/release-lib.sh"

# However this script ends, its build products leave LaunchServices: the only Untether macOS
# knows is the installed one (release-lib.sh untether_unregister_apps, 2026-11-12).
unregister_build_products() {
    local own_derived_data
    untether_unregister_apps "$BUILD_DIR"
    while IFS= read -r own_derived_data; do
        [[ -n "$own_derived_data" ]] && untether_unregister_apps "$own_derived_data"
    done < <(untether_own_derived_data "$PROJECT_DIR" 2> /dev/null || true)
    return 0
}
trap unregister_build_products EXIT

# Default values
CONFIGURATION="Release"
SIGN_APP=true
ARCH="arm64"

usage() {
    echo "Usage: $0 [--configuration Debug|Release] [--no-sign] [--arch arm64]"
}

require_arg() {
    if [[ -z "${2:-}" ]]; then
        echo "Missing value for $1"
        usage
        exit 1
    fi
}

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --configuration)
            require_arg "$1" "${2:-}"
            CONFIGURATION="$2"
            shift 2
            ;;
        --no-sign)
            SIGN_APP=false
            shift
            ;;
        --arch)
            require_arg "$1" "${2:-}"
            ARCH="$2"
            shift 2
            ;;
        *)
            echo "Unknown option: $1"
            usage
            exit 1
            ;;
    esac
done

case "$ARCH" in
    arm64)
        DESTINATION="platform=macOS,arch=$ARCH"
        ARCHS="$ARCH"
        ;;
    *)
        echo "Unsupported architecture: $ARCH (the macOS app requires Apple Silicon)"
        usage
        exit 1
        ;;
esac

if [[ "$(uname -m)" != "arm64" ]]; then
    echo "Apple Silicon host required to build matching embedded server resources"
    exit 1
fi

echo "Building Untether..."
echo "Configuration: $CONFIGURATION"
echo "Code signing: $SIGN_APP"
echo "Architecture: $ARCH"

# Clean build directory only if it doesn't exist
mkdir -p "$BUILD_DIR"


# Bun server is built by Xcode build phase

# Build the app
cd "$MAC_DIR"

# Use CI-specific configuration if in CI environment
XCCONFIG_ARG=""
if [[ "${CI:-false}" == "true" ]] && [[ -f "$PROJECT_DIR/.xcode-ci-config.xcconfig" ]]; then
    echo "Using CI-specific build configuration"
    XCCONFIG_ARG="-xcconfig $PROJECT_DIR/.xcode-ci-config.xcconfig"
fi

# Build the app for the specified architecture

# Use Xcode's default derived data path to preserve Swift package resolution
# Only use custom path if explicitly requested or in CI
if [[ "${CI:-false}" == "true" ]] || [[ "${USE_CUSTOM_DERIVED_DATA:-false}" == "true" ]]; then
    DERIVED_DATA_ARG="-derivedDataPath $BUILD_DIR"
    echo "Using custom derived data path: $BUILD_DIR"
else
    # Use default derived data, but still put build products in our build dir
    DERIVED_DATA_ARG=""
    echo "Using Xcode's default derived data path (preserves Swift packages)"
fi

# Prepare code signing arguments
CODE_SIGN_ARGS=""
if [[ "$SIGN_APP" == false ]]; then
    # Explicitly disable code signing
    CODE_SIGN_ARGS="CODE_SIGN_IDENTITY=\"\" CODE_SIGNING_REQUIRED=NO CODE_SIGNING_ALLOWED=NO CODE_SIGN_ENTITLEMENTS=\"\" ENABLE_HARDENED_RUNTIME=NO PROVISIONING_PROFILE_SPECIFIER=\"\" DEVELOPMENT_TEAM=\"\""
fi

# Check if xcbeautify is available
if command -v xcbeautify &> /dev/null; then
    echo "🔨 Building $ARCH binary with xcbeautify..."
    xcodebuild \
        -project Untether.xcodeproj \
        -scheme Untether \
        -configuration "$CONFIGURATION" \
        $DERIVED_DATA_ARG \
        -destination "$DESTINATION" \
        $XCCONFIG_ARG \
        ARCHS="$ARCHS" \
        ONLY_ACTIVE_ARCH=NO \
        $CODE_SIGN_ARGS \
        build | xcbeautify
else
    echo "🔨 Building $ARCH binary (install xcbeautify for cleaner output)..."
    xcodebuild \
        -project Untether.xcodeproj \
        -scheme Untether \
        -configuration "$CONFIGURATION" \
        $DERIVED_DATA_ARG \
        -destination "$DESTINATION" \
        $XCCONFIG_ARG \
        ARCHS="$ARCHS" \
        ONLY_ACTIVE_ARCH=NO \
        $CODE_SIGN_ARGS \
        build
fi

# Find the app in the appropriate location
if [[ "${CI:-false}" == "true" ]] || [[ "${USE_CUSTOM_DERIVED_DATA:-false}" == "true" ]]; then
    APP_PATH="$BUILD_DIR/Build/Products/$CONFIGURATION/Untether.app"
else
    # Default derived data: this checkout's own build products, as xcodebuild names them
    APP_PATH="$(untether_built_app_path "$CONFIGURATION")" || APP_PATH=""
fi

if [[ ! -d "$APP_PATH" ]]; then
    echo "Error: Build failed - app not found"
    echo "Searched in: ${APP_PATH:-various locations}"
    exit 1
fi

echo "Found app at: $APP_PATH"

# Clean up unwanted files from the bundle
echo "Cleaning up unwanted files from bundle..."
rm -f "$APP_PATH/Contents/Resources/Local.xcconfig"
rm -rf "$APP_PATH/Contents/Resources/web/public/tests"
echo "✓ Removed development files from bundle"

# What this bundle was built from, for Untether's doctor (app-build) and its automatic update
# of the installed app (web/src/server/services/installed-app.ts).
# 2026-11-11: the installed app stayed nine days behind the checkout its development server ran
# from, and nothing in the bundle said which commit it was: the CLI it packs carries one, but
# that CLI is not rebuilt when only mac/ changed.
if BUILD_COMMIT="$(git -C "$PROJECT_DIR" rev-parse --short=9 HEAD 2>/dev/null)"; then
    BUILD_COMMIT_DATE="$(git -C "$PROJECT_DIR" log -1 --format=%cI 2>/dev/null || true)"
    printf '{\n  "commit": "%s",\n  "date": "%s"\n}\n' "$BUILD_COMMIT" "$BUILD_COMMIT_DATE" \
        > "$APP_PATH/Contents/Resources/untether-build.json"
    echo "✓ Stamped the bundle with its commit: $BUILD_COMMIT"
else
    echo "⚠️  WARNING: not a git checkout - the bundle does not say which commit it is"
fi

# Re-sign after cleanup (removing resources invalidates the build-time signature).
if [[ "$SIGN_APP" == true ]]; then
    echo "Re-signing app bundle after cleanup..."
    "$SCRIPT_DIR/codesign-app.sh" "$APP_PATH"
fi

# Verify the signature (we always expect a code signature unless explicitly disabled)
if [[ "$SIGN_APP" == true ]]; then
    echo "Verifying code signature..."
    if codesign --verify --verbose=2 "$APP_PATH" 2>&1; then
        echo "✓ Code signature verification passed"
    else
        echo "Error: Code signature verification failed"
        exit 1
    fi
fi

echo "Build complete: $APP_PATH"

# Print version info
VERSION=$(/usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" "$APP_PATH/Contents/Info.plist")
BUILD=$(/usr/libexec/PlistBuddy -c "Print CFBundleVersion" "$APP_PATH/Contents/Info.plist")
echo "Version: $VERSION ($BUILD)"

# Verify version matches xcconfig
if [[ -f "$MAC_DIR/Untether/version.xcconfig" ]]; then
    EXPECTED_VERSION=$(grep 'MARKETING_VERSION' "$MAC_DIR/Untether/version.xcconfig" | sed 's/.*MARKETING_VERSION = //')
    EXPECTED_BUILD=$(grep 'CURRENT_PROJECT_VERSION' "$MAC_DIR/Untether/version.xcconfig" | sed 's/.*CURRENT_PROJECT_VERSION = //')
    
    if [[ "$VERSION" != "$EXPECTED_VERSION" ]]; then
        echo "⚠️  WARNING: Built version ($VERSION) doesn't match version.xcconfig ($EXPECTED_VERSION)"
        echo "   This may indicate the Xcode project is not properly configured to use version.xcconfig"
    else
        echo "✓ Version matches version.xcconfig"
    fi
    
    if [[ "$BUILD" != "$EXPECTED_BUILD" ]]; then
        echo "⚠️  WARNING: Built build number ($BUILD) doesn't match version.xcconfig ($EXPECTED_BUILD)"
        echo "   This may indicate the Xcode project is not properly configured to use version.xcconfig"
    else
        echo "✓ Build number matches version.xcconfig"
    fi
else
    echo "⚠️  WARNING: version.xcconfig not found - cannot verify version consistency"
fi

# Verify IS_PRERELEASE_BUILD flag
PRERELEASE_FLAG=$(/usr/libexec/PlistBuddy -c "Print IS_PRERELEASE_BUILD" "$APP_PATH/Contents/Info.plist" 2>/dev/null || echo "not found")
if [[ "$PRERELEASE_FLAG" != "not found" ]]; then
    if [[ "$PRERELEASE_FLAG" == "YES" ]]; then
        echo "✓ IS_PRERELEASE_BUILD: YES (pre-release build)"
    elif [[ "$PRERELEASE_FLAG" == "NO" ]]; then
        echo "✓ IS_PRERELEASE_BUILD: NO (stable build)"
    else
        echo "⚠ IS_PRERELEASE_BUILD: '$PRERELEASE_FLAG' (unexpected value)"
    fi
elif [[ "${VERBOSE_BUILD:-false}" == "true" ]]; then
    echo "IS_PRERELEASE_BUILD not set (Info.plist key missing)"
fi
