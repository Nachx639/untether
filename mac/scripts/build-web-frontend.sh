#!/bin/zsh
set -e  # Exit on any error
set -o pipefail  # Exit if any command in a pipeline fails

# Preserve the caller's CI state before exporting CI for noninteractive package commands.
RUNNING_IN_CI="${CI:-false}"

# Get the project directory
if [ -z "${SRCROOT}" ]; then
    # If SRCROOT is not set (running outside Xcode), determine it from script location
    SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
    PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
else
    PROJECT_DIR="${SRCROOT}"
fi

WEB_DIR="${PROJECT_DIR}/../web"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR}/custom-node-policy.sh"

FORCE_WEB_BUILD="${UNTETHER_FORCE_WEB_BUILD:-false}"
REQUIRE_CUSTOM_NODE="${UNTETHER_REQUIRE_CUSTOM_NODE:-false}"
HASH_FILE="${BUILT_PRODUCTS_DIR}/.web-content-hash"
PREVIOUS_HASH_FILE="${BUILT_PRODUCTS_DIR}/.web-content-hash.previous"
PUBLIC_DIR="${WEB_DIR}/public"

# Set destination directory
if [ -z "${BUILT_PRODUCTS_DIR}" ]; then
    # Default for testing outside Xcode
    DEST_DIR="/tmp/untether-web-build"
else
    DEST_DIR="${BUILT_PRODUCTS_DIR}/${CONTENTS_FOLDER_PATH}/Resources/web/public"
fi

APP_RESOURCES="${BUILT_PRODUCTS_DIR}/${UNLOCALIZED_RESOURCES_FOLDER_PATH}"

# In ordinary CI with pre-built artifacts, skip the entire build process.
# Release automation forces a fresh build so the embedded runtime is verifiable.
if untether_is_truthy "$RUNNING_IN_CI" &&
    ! untether_is_truthy "$FORCE_WEB_BUILD" &&
    ! untether_is_truthy "$REQUIRE_CUSTOM_NODE" &&
    [ -f "${WEB_DIR}/dist/server/server.js" ]; then
    echo "✓ CI environment detected with pre-built web artifacts"
    echo "✓ Skipping web frontend build entirely"
    
    # Still need to copy the pre-built files to the app bundle
    # Clean and create destination directory
    echo "Cleaning destination directory..."
    rm -rf "${DEST_DIR}"
    mkdir -p "${DEST_DIR}"
    
    # Copy built files to Resources
    echo "Copying pre-built web files to app bundle..."
    if [ -d "${PUBLIC_DIR}" ]; then
        cp -R "${PUBLIC_DIR}/"* "${DEST_DIR}/"
    fi
    
    # Copy native executable and modules to app bundle if they exist
    NATIVE_DIR="${WEB_DIR}/native"
    
    if [ -f "${NATIVE_DIR}/untether" ]; then
        echo "Copying native executable to app bundle..."
        cp "${NATIVE_DIR}/untether" "${APP_RESOURCES}/"
        chmod +x "${APP_RESOURCES}/untether"
    fi

    if [ -f "${NATIVE_DIR}/untether-fwd" ]; then
        echo "Copying Rust forwarder to app bundle..."
        cp "${NATIVE_DIR}/untether-fwd" "${APP_RESOURCES}/"
        chmod +x "${APP_RESOURCES}/untether-fwd"
    else
        echo "error: Rust forwarder not found at ${NATIVE_DIR}/untether-fwd"
        exit 1
    fi
    
    if [ -f "${NATIVE_DIR}/pty.node" ]; then
        cp "${NATIVE_DIR}/pty.node" "${APP_RESOURCES}/"
    fi
    
    if [ -f "${NATIVE_DIR}/spawn-helper" ]; then
        cp "${NATIVE_DIR}/spawn-helper" "${APP_RESOURCES}/"
        chmod +x "${APP_RESOURCES}/spawn-helper"
    fi
    
    # 2026-10-12: PAM is required; a missing module used to be skipped silently.
    if [ -f "${NATIVE_DIR}/authenticate_pam.node" ]; then
        cp "${NATIVE_DIR}/authenticate_pam.node" "${APP_RESOURCES}/"
    else
        echo "error: authenticate_pam.node not found at ${NATIVE_DIR} (pre-built artifacts are incomplete)"
        exit 1
    fi
    
    if [ -f "${WEB_DIR}/bin/ut" ]; then
        cp "${WEB_DIR}/bin/ut" "${APP_RESOURCES}/"
        chmod +x "${APP_RESOURCES}/ut"
    fi
    
    echo "✓ Pre-built web artifacts copied successfully"
    exit 0
fi

# 2026-10-18: Xcode skipped the "Calculate Web Hash" phase (an output and no inputs), so the
# hash stayed the one of a build hours earlier and new server code was never bundled ("Web
# content unchanged"). The hash is recomputed here every time, whatever Xcode ran.
"${SCRIPT_DIR:-$(cd "$(dirname "$0")" && pwd)}/calculate-web-hash.sh" >/dev/null || rm -f "${HASH_FILE}"

# Read the current hash
if [ -f "${HASH_FILE}" ]; then
    CURRENT_HASH=$(cat "${HASH_FILE}")
else
    # If hash file doesn't exist, we need to rebuild
    # Generate a unique hash to force rebuild
    CURRENT_HASH="no-hash-file-$(date +%s)"
    echo "Hash file not found at ${HASH_FILE}. Will rebuild..."
fi

# Check if we need to rebuild
NEED_REBUILD=1

# Check if previous hash exists and matches current
if untether_is_truthy "$FORCE_WEB_BUILD"; then
    echo "Forced web rebuild requested."
elif [ -f "${PREVIOUS_HASH_FILE}" ]; then
    PREVIOUS_HASH=$(cat "${PREVIOUS_HASH_FILE}")
    if [ "${CURRENT_HASH}" = "${PREVIOUS_HASH}" ]; then
        # Also check if the built files actually exist
        if [ -d "${DEST_DIR}" ] && [ -f "${APP_RESOURCES}/untether" ] && [ -f "${APP_RESOURCES}/pty.node" ] && [ -f "${APP_RESOURCES}/spawn-helper" ] && [ -f "${APP_RESOURCES}/untether-fwd" ] && [ -f "${APP_RESOURCES}/authenticate_pam.node" ]; then
            echo "Web content unchanged and build outputs exist. Skipping rebuild."
            NEED_REBUILD=0
        else
            echo "Web content unchanged but build outputs missing. Rebuilding..."
        fi
    else
        echo "Web content changed. Hash: ${PREVIOUS_HASH} -> ${CURRENT_HASH}"
    fi
else
    echo "No previous build hash found. Building web frontend..."
fi

if [ ${NEED_REBUILD} -eq 0 ]; then
    echo "Skipping web frontend build (no changes detected)"
    exit 0
fi

echo "Building web frontend..."

# Setup Node.js PATH (Homebrew, nvm, Volta, fnm)
# Set environment variable to use clean build environment
export UNTETHER_BUILD_CLEAN_ENV=true
source "${SCRIPT_DIR}/node-path-setup.sh"

# Export CI to prevent interactive prompts
export CI=true

# Avoid downloading browsers during Xcode/app builds (CI stability + speed).
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
export PUPPETEER_SKIP_DOWNLOAD=1

# Check if pnpm is available (skip in CI when web artifacts are pre-built)
if [ "${SKIP_NODE_CHECK}" = "true" ] && untether_is_truthy "$RUNNING_IN_CI"; then
    echo "✓ Skipping pnpm check in CI (web artifacts are pre-built)"
    echo "✓ This script should not be running in CI - web build should already be complete"
    exit 0
fi

if ! command -v pnpm &> /dev/null; then
    echo "error: pnpm not found. Please install pnpm"
    exit 1
fi

# Check if web directory exists
if [ ! -d "${WEB_DIR}" ]; then
    echo "error: Web directory not found at ${WEB_DIR}"
    exit 1
fi

# Asked from web/, where pnpm runs and web/package.json pins it (packageManager): pnpm
# answers with the version of the nearest package.json. 2026-11-11: it was asked from mac/,
# whose only reason to have a package.json was this pin.
REQUIRED_PNPM_VERSION="10.15.0"
INSTALLED_PNPM_VERSION="$(cd "${WEB_DIR}" && pnpm --version)"
if [ "$INSTALLED_PNPM_VERSION" != "$REQUIRED_PNPM_VERSION" ]; then
    echo "error: pnpm $REQUIRED_PNPM_VERSION required (found $INSTALLED_PNPM_VERSION)"
    exit 1
fi

echo "Using pnpm version: $INSTALLED_PNPM_VERSION"
NODE_VERSION="$(node --version)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
NODE_MINOR="$(node -p 'process.versions.node.split(".")[1]')"
if [ "$NODE_MAJOR" -lt 22 ] || [ "$NODE_MAJOR" -gt 24 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 12 ]; }; then
    echo "error: Node.js 22.12 through 24.x required (found $NODE_VERSION)"
    exit 1
fi
echo "Using Node.js version: $NODE_VERSION"

# Change to web directory
cd "${WEB_DIR}"

# A mark that an app build is at work in this checkout, for the doctor of a server that runs
# from it (web/src/server/services/doctor-checks-build.ts appBuildRunning): "<pid> <epoch
# seconds>", removed when this script ends however it ends.
# 2026-11-12: the doctor found node-pty's spawn-helper missing in the middle of a release and
# rebuilt it while the build was rebuilding it too. The build no longer writes there (see
# below), and while the mark stands the doctor rebuilds nothing.
APP_BUILD_MARK="${WEB_DIR}/.app-build-running"
echo "$$ $(date +%s)" > "${APP_BUILD_MARK}"
trap 'rm -f "${APP_BUILD_MARK}"' EXIT
trap 'rm -f "${APP_BUILD_MARK}"; exit 130' INT TERM

# Clean build artifacts
echo "Cleaning build artifacts..."
rm -rf dist public/bundle public/output.css native

# Install dependencies
echo "Installing dependencies..."
# For Xcode builds, ensure C++20 standard for native modules
export MACOSX_DEPLOYMENT_TARGET="14.0"
export CXXFLAGS="-std=c++20 -stdlib=libc++ -mmacosx-version-min=14.0"
export CXX="${CXX:-clang++}"
export CC="${CC:-clang}"

# Filter common non-actionable warnings from build output
filter_build_output() {
    # Allow bypassing filter with VERBOSE_BUILD environment variable
    if [ "${VERBOSE_BUILD:-false}" = "true" ]; then
        cat  # Pass through unfiltered
        return
    fi
    
    local patterns=(
        # C++ compiler warnings from node-gyp builds
        'missing field .* initializer'
        'expanded from macro'
        'converts to incompatible function type'
        'instantiation of function template'
        
        # Deprecation warnings
        'is deprecated.*Use.*instead'
        'has been explicitly marked deprecated'
        
        # npm/pnpm configuration warnings
        'npm warn Unknown.*config'
        'deprecated subdependencies found'
        'Issues with peer dependencies found'
        'unmet peer'
        
        # Tailwind CSS content configuration warnings
        'warn - Your.*content.*configuration'
        'warn - Pattern:.*\*\.js'
        'warn - See our documentation'
        
        # Build tool information messages
        'gyp info spawn args'
        '\.\.\.\/node_modules\/.*install:'
        
        # ESBuild bundle size warnings
        'exceeds recommended size limit'
        'This can impact web performance'
    )
    
    # Combine patterns with OR operator
    local pattern=$(IFS='|'; echo "${patterns[*]}")
    grep -v -E "$pattern" || true
}

# Install only when node_modules is not what the lockfile asks for, and never under a running
# server (custom-node-policy.sh untether_prepare_web_deps; 2026-11-12).
untether_prepare_web_deps 2>&1 | filter_build_output

# Determine build configuration
BUILD_CONFIG="${CONFIGURATION:-Debug}"
echo "Build configuration: $BUILD_CONFIG"

# Check for custom Node.js build
echo "Searching for custom Node.js builds..."

# Find all Node build directories
if [ -d "${WEB_DIR}/.node-builds" ]; then
    ALL_NODE_DIRS=$(find "${WEB_DIR}/.node-builds" -name "node-v*-minimal" -type d 2>/dev/null | sort -V)
else
    ALL_NODE_DIRS=""
fi
if [ -n "$ALL_NODE_DIRS" ]; then
    echo "Found Node.js build directories:"
    echo "$ALL_NODE_DIRS" | while read -r dir; do
        if [ -f "$dir/out/Release/node" ]; then
            VERSION=$(basename "$dir" | sed 's/node-v\(.*\)-minimal/\1/')
            echo "  ✓ $VERSION (complete build)"
        else
            VERSION=$(basename "$dir" | sed 's/node-v\(.*\)-minimal/\1/')
            echo "  ✗ $VERSION (incomplete build - missing binary)"
        fi
    done
fi

# Find directories with complete builds (containing the actual node binary)
if [ -d "${WEB_DIR}/.node-builds" ]; then
    CUSTOM_NODE_DIR=$(find "${WEB_DIR}/.node-builds" -name "node-v*-minimal" -type d -exec test -f {}/out/Release/node \; -print 2>/dev/null | sort -V | tail -n1)
else
    CUSTOM_NODE_DIR=""
fi
CUSTOM_NODE_PATH="${CUSTOM_NODE_DIR}/out/Release/node"

if [ -n "$CUSTOM_NODE_DIR" ]; then
    SELECTED_VERSION=$(basename "$CUSTOM_NODE_DIR" | sed 's/node-v\(.*\)-minimal/\1/')
    echo "Selected custom Node.js v$SELECTED_VERSION"
else
    echo "No complete custom Node.js builds found"
fi

# Build the web frontend
if [ "$BUILD_CONFIG" = "Release" ]; then
    echo "Release build - checking for custom Node.js..."

    CUSTOM_NODE_ACTION="$(
        untether_custom_node_action \
            "$BUILD_CONFIG" \
            "$RUNNING_IN_CI" \
            "$REQUIRE_CUSTOM_NODE" \
            "$CUSTOM_NODE_PATH"
    )"

    if [ "$CUSTOM_NODE_ACTION" = "prepare" ]; then
        PINNED_CUSTOM_NODE_VERSION=$(node -e 'process.stdout.write(require("./build-custom-node.js").DEFAULT_NODE_VERSION)')
        echo "Validating the pinned custom Node.js build..."
        echo "A missing or stale build will be rebuilt and cached."
        node build-custom-node.js --version="$PINNED_CUSTOM_NODE_VERSION" 2>&1 | filter_build_output
        CUSTOM_NODE_DIR="${WEB_DIR}/.node-builds/node-v${PINNED_CUSTOM_NODE_VERSION}-minimal"
        CUSTOM_NODE_PATH="${CUSTOM_NODE_DIR}/out/Release/node"
        if [ -f "$CUSTOM_NODE_PATH" ]; then
            CUSTOM_NODE_ACTION="use"
        else
            CUSTOM_NODE_ACTION="system"
        fi
    fi

    if [ "$CUSTOM_NODE_ACTION" = "use" ]; then
        CUSTOM_NODE_VERSION=$("$CUSTOM_NODE_PATH" --version 2>/dev/null || echo "unknown")
        CUSTOM_NODE_SIZE=$(ls -lh "$CUSTOM_NODE_PATH" 2>/dev/null | awk '{print $5}' || echo "unknown")
        echo "Using custom Node.js for release build:"
        echo "  Version: $CUSTOM_NODE_VERSION"
        echo "  Size: $CUSTOM_NODE_SIZE (vs ~110MB for standard Node.js)"
        echo "  Path: $CUSTOM_NODE_PATH"
        pnpm run build -- --custom-node="$CUSTOM_NODE_PATH" 2>&1 | filter_build_output
    elif untether_is_truthy "$REQUIRE_CUSTOM_NODE"; then
        echo "error: Release requires a custom Node.js build, but none is available."
        exit 1
    else
        echo "CI build without cached custom Node.js - using system Node.js."
        echo "Release automation must set UNTETHER_REQUIRE_CUSTOM_NODE=YES."
        pnpm run build 2>&1 | filter_build_output
    fi
else
    # Debug build
    if [ -f "$CUSTOM_NODE_PATH" ]; then
        CUSTOM_NODE_VERSION=$("$CUSTOM_NODE_PATH" --version 2>/dev/null || echo "unknown")
        echo "Debug build - found existing custom Node.js $CUSTOM_NODE_VERSION, using it for consistency"
        pnpm run build -- --custom-node 2>&1 | filter_build_output
    else
        echo "Debug build - using system Node.js for faster builds"
        echo "System Node.js: $(node --version)"
        echo "To use custom Node.js in debug builds, run: cd web && node build-custom-node.js --latest"
        pnpm run build 2>&1 | filter_build_output
    fi
fi

# Clean and create destination directory
echo "Cleaning destination directory..."
rm -rf "${DEST_DIR}"
mkdir -p "${DEST_DIR}"

# Copy built files to Resources
echo "Copying web files to app bundle..."
cp -R "${PUBLIC_DIR}/"* "${DEST_DIR}/"

# Copy native executable and modules to app bundle
NATIVE_DIR="${WEB_DIR}/native"

if [ -f "${NATIVE_DIR}/untether" ]; then
    echo "Copying native executable to app bundle..."
    EXEC_SIZE=$(ls -lh "${NATIVE_DIR}/untether" | awk '{print $5}')
    echo "  Executable size: $EXEC_SIZE"
    cp "${NATIVE_DIR}/untether" "${APP_RESOURCES}/"
    chmod +x "${APP_RESOURCES}/untether"
else
    echo "error: Native executable not found at ${NATIVE_DIR}/untether"
    exit 1
fi

if [ -f "${NATIVE_DIR}/untether-fwd" ]; then
    echo "Copying Rust forwarder..."
    cp "${NATIVE_DIR}/untether-fwd" "${APP_RESOURCES}/"
    chmod +x "${APP_RESOURCES}/untether-fwd"
else
    echo "error: Rust forwarder not found at ${NATIVE_DIR}/untether-fwd"
    exit 1
fi

if [ -f "${NATIVE_DIR}/pty.node" ]; then
    echo "Copying pty.node..."
    cp "${NATIVE_DIR}/pty.node" "${APP_RESOURCES}/"
else
    echo "error: pty.node not found"
    exit 1
fi

if [ -f "${NATIVE_DIR}/spawn-helper" ]; then
    echo "Copying spawn-helper..."
    cp "${NATIVE_DIR}/spawn-helper" "${APP_RESOURCES}/"
    chmod +x "${APP_RESOURCES}/spawn-helper"
else
    echo "error: spawn-helper not found"
    exit 1
fi

# Copy authenticate_pam.node (required).
# 2026-10-12: ignore-scripts=true in ~/.npmrc left authenticate-pam unbuilt and this used to be
# only a warning, so bundles shipped without PAM. web/build-native.js now builds it with node-gyp;
# fail here if it still isn't there.
if [ -f "${NATIVE_DIR}/authenticate_pam.node" ]; then
    echo "Copying authenticate_pam.node..."
    cp "${NATIVE_DIR}/authenticate_pam.node" "${APP_RESOURCES}/"
else
    echo "error: authenticate_pam.node not found at ${NATIVE_DIR}. PAM authentication is required."
    exit 1
fi

# Required release builds must carry an explicit custom-runtime attestation.
if untether_is_truthy "$REQUIRE_CUSTOM_NODE"; then
    BUILD_INFO="${NATIVE_DIR}/untether-build.json"
    if [ ! -f "$BUILD_INFO" ]; then
        echo "error: Missing native build attestation at ${BUILD_INFO}"
        exit 1
    fi
    node -e '
        const fs = require("fs");
        const info = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        if (info.schemaVersion !== 1 || info.customNode !== true) {
            console.error("error: Native server was not built with custom Node.js");
            process.exit(1);
        }
        console.log(`Verified custom Node.js ${info.nodeVersion} build (${info.arch})`);
    ' "$BUILD_INFO"
fi

# Copy unified ut script
if [ -f "${WEB_DIR}/bin/ut" ]; then
    echo "Copying unified ut script..."
    cp "${WEB_DIR}/bin/ut" "${APP_RESOURCES}/"
    chmod +x "${APP_RESOURCES}/ut"
else
    echo "error: Unified ut script not found at ${WEB_DIR}/bin/ut"
    exit 1
fi

echo "✓ Native executable, modules, and ut script copied successfully"

# Sanity check: Verify all required binaries are present in the app bundle
echo "Performing final sanity check..."

MISSING_FILES=()

# Check for untether executable
if [ ! -f "${APP_RESOURCES}/untether" ]; then
    MISSING_FILES+=("untether executable")
fi

# Check for pty.node
if [ ! -f "${APP_RESOURCES}/pty.node" ]; then
    MISSING_FILES+=("pty.node native module")
fi

# Check for spawn-helper (Unix only)
if [ ! -f "${APP_RESOURCES}/spawn-helper" ]; then
    MISSING_FILES+=("spawn-helper")
fi

# Check for Rust forwarder
if [ ! -f "${APP_RESOURCES}/untether-fwd" ]; then
    MISSING_FILES+=("untether-fwd")
fi

# Check for the PAM module (2026-10-12: used to go missing silently, see above)
if [ ! -f "${APP_RESOURCES}/authenticate_pam.node" ]; then
    MISSING_FILES+=("authenticate_pam.node")
fi

# Check if untether is executable
if [ -f "${APP_RESOURCES}/untether" ] && [ ! -x "${APP_RESOURCES}/untether" ]; then
    MISSING_FILES+=("untether is not executable")
fi

# Check if spawn-helper is executable
if [ -f "${APP_RESOURCES}/spawn-helper" ] && [ ! -x "${APP_RESOURCES}/spawn-helper" ]; then
    MISSING_FILES+=("spawn-helper is not executable")
fi

# Check if untether-fwd is executable
if [ -f "${APP_RESOURCES}/untether-fwd" ] && [ ! -x "${APP_RESOURCES}/untether-fwd" ]; then
    MISSING_FILES+=("untether-fwd is not executable")
fi

# Check for ut script
if [ ! -f "${APP_RESOURCES}/ut" ]; then
    MISSING_FILES+=("ut script")
fi

# Check if ut script is executable
if [ -f "${APP_RESOURCES}/ut" ] && [ ! -x "${APP_RESOURCES}/ut" ]; then
    MISSING_FILES+=("ut script is not executable")
fi

# If any files are missing, fail the build
if [ ${#MISSING_FILES[@]} -gt 0 ]; then
    echo "error: Build sanity check failed! Missing required files:"
    for file in "${MISSING_FILES[@]}"; do
        echo "  - $file"
    done
    echo "Build artifacts in ${NATIVE_DIR}:"
    ls -la "${NATIVE_DIR}" || echo "  Directory does not exist"
    echo "App resources in ${APP_RESOURCES}:"
    ls -la "${APP_RESOURCES}/untether" "${APP_RESOURCES}/pty.node" "${APP_RESOURCES}/spawn-helper" "${APP_RESOURCES}/ut" 2>/dev/null || true
    exit 1
fi

# Verify the executable works, and that it opens its native modules with the Node it embeds
# (`untether check-native`). Both are asked of web/native, whose files are the ones just copied
# into the bundle (compared below), never of the bundle.
# 2026-11-12: a module built for another Node was only found out at the first login. And
# running something from inside an unsigned Untether.app makes macOS show the user "Untether
# is damaged and can't be opened": nothing is run from a bundle that is not signed yet.
echo "Verifying untether executable (in ${NATIVE_DIR})..."
for BUNDLED_FILE in untether pty.node spawn-helper authenticate_pam.node; do
    if ! cmp -s "${NATIVE_DIR}/${BUNDLED_FILE}" "${APP_RESOURCES}/${BUNDLED_FILE}"; then
        echo "error: ${BUNDLED_FILE} in the app bundle is not the one in ${NATIVE_DIR}"
        exit 1
    fi
done
if VERSION_OUTPUT="$("${NATIVE_DIR}/untether" version 2>&1)"; then
    echo "✓ Untether executable verified: $(echo "$VERSION_OUTPUT" | head -1)"
else
    echo "error: Untether executable failed verification (version command failed)"
    ls -la "${NATIVE_DIR}/untether" || echo "File not found!"
    echo "$VERSION_OUTPUT"
    exit 1
fi
if NATIVE_CHECK="$("${NATIVE_DIR}/untether" check-native 2>&1)"; then
    echo "$NATIVE_CHECK" | sed 's/^/  /'
    echo "✓ Native modules load with the embedded Node.js"
else
    echo "error: a native module does not load with the Node.js the app embeds:"
    echo "$NATIVE_CHECK"
    exit 1
fi

echo "✓ All sanity checks passed"

# Save the current hash as the previous hash for next build
if [ -f "${HASH_FILE}" ]; then
    cp "${HASH_FILE}" "${PREVIOUS_HASH_FILE}"
else
    # If hash file doesn't exist, create it with the current hash value
    echo "${CURRENT_HASH}" > "${PREVIOUS_HASH_FILE}"
fi

echo "Web frontend build completed successfully"
