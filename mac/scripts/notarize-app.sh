#!/bin/bash

# =============================================================================
# Untether App Notarization Script
# =============================================================================
#
# This script handles complete notarization for Untether including:
# - Hardened runtime signing
# - Proper signing of all components
# - Apple notarization submission and stapling
#
# USAGE:
#   ./scripts/notarize-app.sh <app_path>
#
# ARGUMENTS:
#   app_path    Path to the .app bundle to notarize
#
# ENVIRONMENT VARIABLES:
#   SIGN_IDENTITY                     Developer ID identity (optional)
#   APP_STORE_CONNECT_API_KEY_PATH    App Store Connect API key: its .p8 file, or
#   APP_STORE_CONNECT_API_KEY_P8      the content of that file
#   APP_STORE_CONNECT_KEY_ID          API Key ID
#   APP_STORE_CONNECT_ISSUER_ID       API Issuer ID
#
# =============================================================================

set -eo pipefail

# Source common functions
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ -f "$SCRIPT_DIR/common.sh" ]] && source "$SCRIPT_DIR/common.sh"
source "$SCRIPT_DIR/release-lib.sh"

# ============================================================================
# Configuration
# ============================================================================

# Get the script and project directories
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

log() {
    echo "[$(date "+%Y-%m-%d %H:%M:%S")] $1"
}

error() {
    echo "[$(date "+%Y-%m-%d %H:%M:%S")] ❌ ERROR: $1" >&2
    exit 1
}

success() {
    echo "[$(date "+%Y-%m-%d %H:%M:%S")] ✅ $1"
}

APP_BUNDLE="${1:-build/Build/Products/Release/Untether.app}"
# Use environment variable or detect from keychain
SIGN_IDENTITY="${SIGN_IDENTITY:-$(security find-identity -v -p codesigning | grep "Developer ID Application" | head -1 | awk -F'"' '{print $2}')}"
TIMEOUT_MINUTES=30

# Validate signing identity
if [[ -z "$SIGN_IDENTITY" ]]; then
    error "No signing identity found. Please set SIGN_IDENTITY environment variable."
    echo "Example: export SIGN_IDENTITY=\"Developer ID Application: Your Name (TEAMID)\""
    exit 1
fi

log "Using signing identity: $SIGN_IDENTITY"

# Check if app bundle exists
if [ ! -d "$APP_BUNDLE" ]; then
    error "App bundle not found at $APP_BUNDLE"
fi

log "Starting complete notarization process for $APP_BUNDLE"

# Check required environment variables for notarization
if ! NOTARY_KEY_PROBLEM="$(untether_check_notary_key)"; then
    error "No notarization key in the environment: $(tr '\n' ' ' <<< "$NOTARY_KEY_PROBLEM")"
fi

# A key given as content goes to a temporary file; a key given as a path
# (APP_STORE_CONNECT_API_KEY_PATH) is read where it is and never removed.
API_KEY_SCRATCH=$(mktemp)
API_KEY_FILE="$(untether_notary_key_file "$API_KEY_SCRATCH")"

cleanup() {
    rm -f "$API_KEY_SCRATCH" "/tmp/Untether_notarize.zip"
}
trap cleanup EXIT

# ============================================================================
# Create Entitlements Files
# ============================================================================

create_entitlements() {
    local entitlements_file="$1"
    local is_xpc_service="$2"
    
    cat > "$entitlements_file" << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.cs.allow-jit</key>
    <false/>
    <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
    <false/>
    <key>com.apple.security.cs.disable-executable-page-protection</key>
    <false/>
    <key>com.apple.security.cs.disable-library-validation</key>
    <false/>
    <key>com.apple.security.hardened-runtime</key>
    <true/>
EOF

    if [ "$is_xpc_service" = "true" ]; then
        cat >> "$entitlements_file" << 'EOF'
    <key>com.apple.security.app-sandbox</key>
    <true/>
    <key>com.apple.security.network.client</key>
    <true/>
    <key>com.apple.security.files.user-selected.read-write</key>
    <true/>
    <key>com.apple.security.temporary-exception.mach-lookup.global-name</key>
    <array>
        <string>com.nachx639.untether-spks</string>
        <string>com.nachx639.untether-spkd</string>
    </array>
EOF
    fi

    cat >> "$entitlements_file" << 'EOF'
</dict>
</plist>
EOF
}

# Create entitlements files
MAIN_ENTITLEMENTS="/tmp/main_entitlements.plist"
XPC_ENTITLEMENTS="/tmp/xpc_entitlements.plist"

# Use actual Untether entitlements for the main app
if [ -f "Untether/Untether.entitlements" ]; then
    cp "Untether/Untether.entitlements" "$MAIN_ENTITLEMENTS"
elif [ -f "$PROJECT_ROOT/Untether/Untether.entitlements" ]; then
    cp "$PROJECT_ROOT/Untether/Untether.entitlements" "$MAIN_ENTITLEMENTS"
else
    log "Warning: Untether.entitlements not found, using default entitlements"
    create_entitlements "$MAIN_ENTITLEMENTS" "false"
fi

create_entitlements "$XPC_ENTITLEMENTS" "true"

# The embedded server and its forwarder keep their own entitlements (allow-jit)
SERVER_ENTITLEMENTS="$PROJECT_ROOT/Untether/untether-binary.entitlements"
if [ ! -f "$SERVER_ENTITLEMENTS" ]; then
    error "Server entitlements not found at $SERVER_ENTITLEMENTS"
fi

# ============================================================================
# Signing Functions
# ============================================================================

sign_binary() {
    local binary="$1"
    local entitlements="$2"
    local description="$3"
    
    log "Signing $description: $(basename "$binary")"
    
    # Add keychain option if available
    keychain_opts=""
    if [ -n "${KEYCHAIN_NAME:-}" ]; then
        keychain_opts="--keychain $KEYCHAIN_NAME"
    fi
    
    codesign \
        --force \
        --sign "$SIGN_IDENTITY" \
        --entitlements "$entitlements" \
        --options runtime \
        --timestamp \
        $keychain_opts \
        "$binary"
}

sign_app_bundle() {
    local bundle="$1"
    local entitlements="$2"
    local description="$3"
    
    log "Signing $description: $(basename "$bundle")"
    
    # Add keychain option if available
    keychain_opts=""
    if [ -n "${KEYCHAIN_NAME:-}" ]; then
        keychain_opts="--keychain $KEYCHAIN_NAME"
    fi
    
    codesign \
        --force \
        --sign "$SIGN_IDENTITY" \
        --entitlements "$entitlements" \
        --options runtime \
        --timestamp \
        $keychain_opts \
        "$bundle"
}

# ============================================================================
# Deep Signing Process
# ============================================================================

log "Performing component signing..."

# Add keychain option if available
keychain_opts=""
if [ -n "${KEYCHAIN_NAME:-}" ]; then
    keychain_opts="--keychain $KEYCHAIN_NAME"
fi

# Sign embedded frameworks
# 2026-11-11: without the folder (the app embeds no framework today) `find` failed and,
# under pipefail, ended the notarization here.
if [ -d "$APP_BUNDLE/Contents/Frameworks" ]; then
    log "Signing frameworks..."
    find "$APP_BUNDLE/Contents/Frameworks" -name "*.framework" -type d | while read framework; do
        framework_binary="$framework/$(basename "$framework" .framework)"
        if [ -f "$framework_binary" ]; then
            sign_binary "$framework_binary" "$MAIN_ENTITLEMENTS" "Framework binary"
        fi

        codesign \
            --force \
            --sign "$SIGN_IDENTITY" \
            --options runtime \
            --timestamp \
            $keychain_opts \
            "$framework"
    done
else
    log "No embedded frameworks to sign"
fi

# 4. Sign helper tools and executables
# 2026-11-11: every helper was signed again with the app's entitlements, which took
# allow-jit away from the embedded server (untether) and its forwarder (untether-fwd)
# that codesign-app.sh had signed with untether-binary.entitlements: under the hardened
# runtime the JavaScript engine of the server cannot run without it.
log "Signing helper tools..."
find "$APP_BUNDLE/Contents" -type f -perm +111 -not -path "*/MacOS/*" -not -path "*/Frameworks/*" | while read executable; do
    case "$executable" in
        "$APP_BUNDLE/Contents/Resources/untether"|"$APP_BUNDLE/Contents/Resources/untether-fwd")
            sign_binary "$executable" "$SERVER_ENTITLEMENTS" "Server executable (JIT)"
            ;;
        *)
            sign_binary "$executable" "$MAIN_ENTITLEMENTS" "Helper executable"
            ;;
    esac
done

# 5. Finally, sign the main app bundle
log "Signing main app bundle..."
keychain_opts=""
if [ -n "${KEYCHAIN_NAME:-}" ]; then
    keychain_opts="--keychain $KEYCHAIN_NAME"
fi

codesign \
    --force \
    --sign "$SIGN_IDENTITY" \
    --entitlements "$MAIN_ENTITLEMENTS" \
    --options runtime \
    --timestamp \
    $keychain_opts \
    "$APP_BUNDLE"

# ============================================================================
# Notarization
# ============================================================================

# Check if notarytool is available
if ! xcrun --find notarytool &> /dev/null; then
    error "notarytool not found. Please ensure Xcode 13+ is installed"
fi

log "Using modern notarytool for notarization"

# Create ZIP for notarization
ZIP_PATH="/tmp/Untether_notarize.zip"
log "Creating ZIP archive for notarization..."
if ! ditto -c -k --keepParent "$APP_BUNDLE" "$ZIP_PATH"; then
    error "Failed to create ZIP archive"
fi

# Submit for notarization using notarytool
log "Submitting app for notarization..."
SUBMIT_CMD="xcrun notarytool submit \"$ZIP_PATH\" --key \"$API_KEY_FILE\" --key-id \"$APP_STORE_CONNECT_KEY_ID\" --issuer \"$APP_STORE_CONNECT_ISSUER_ID\" --wait --timeout ${TIMEOUT_MINUTES}m"

# Run submission with timeout
if ! eval "$SUBMIT_CMD"; then
    error "Notarization submission failed"
fi

success "Notarization completed successfully"

# Staple the notarization ticket
log "Stapling notarization ticket to app bundle..."
if ! xcrun stapler staple "$APP_BUNDLE"; then
    error "Failed to staple notarization ticket"
fi

# Verify the stapling
log "Verifying stapled notarization ticket..."
if ! xcrun stapler validate "$APP_BUNDLE"; then
    error "Failed to verify stapled ticket"
fi

# Test with spctl to ensure it passes Gatekeeper
log "Testing with spctl (Gatekeeper)..."
if spctl -a -t exec -vv "$APP_BUNDLE" 2>&1; then
    success "spctl verification passed - app will run without warnings"
else
    log "⚠️ spctl verification failed - app may show security warnings"
fi

success "Notarization and stapling completed successfully"

# Clean up temporary files
rm -f "$MAIN_ENTITLEMENTS" "$XPC_ENTITLEMENTS"