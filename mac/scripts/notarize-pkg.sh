#!/bin/bash
#
# Notarizes a signed installer (.pkg) and staples the ticket to it, so that it opens on a Mac
# that is offline. Apple notarizes what is inside too: the app the installer carries.
#
# Usage: ./scripts/notarize-pkg.sh <file.pkg>
#
# Environment: APP_STORE_CONNECT_API_KEY_P8, APP_STORE_CONNECT_KEY_ID, APP_STORE_CONNECT_ISSUER_ID.
set -euo pipefail

if [[ $# -ne 1 ]]; then
    echo "Usage: $0 <file.pkg>"
    exit 1
fi

PKG_PATH="$1"

if [[ ! -f "$PKG_PATH" ]]; then
    echo "Error: installer not found at $PKG_PATH"
    exit 1
fi

if [[ -z "${APP_STORE_CONNECT_API_KEY_P8:-}" ]] ||
    [[ -z "${APP_STORE_CONNECT_KEY_ID:-}" ]] ||
    [[ -z "${APP_STORE_CONNECT_ISSUER_ID:-}" ]]; then
    echo "Error: Missing required environment variables for notarization"
    echo "Please set: APP_STORE_CONNECT_API_KEY_P8, APP_STORE_CONNECT_KEY_ID, APP_STORE_CONNECT_ISSUER_ID"
    exit 1
fi

# The key lives in a file only while notarytool reads it.
TEMP_KEY=$(mktemp)
trap 'rm -f "$TEMP_KEY"' EXIT
echo "$APP_STORE_CONNECT_API_KEY_P8" | sed 's/\\n/\n/g' > "$TEMP_KEY"

echo "Submitting $PKG_PATH for notarization..."
SUBMISSION_OUTPUT=$(xcrun notarytool submit "$PKG_PATH" \
    --key "$TEMP_KEY" \
    --key-id "$APP_STORE_CONNECT_KEY_ID" \
    --issuer "$APP_STORE_CONNECT_ISSUER_ID" \
    --wait \
    --timeout 30m)
echo "$SUBMISSION_OUTPUT"

if ! grep -q "status: Accepted" <<< "$SUBMISSION_OUTPUT"; then
    echo "❌ Notarization failed!"
    exit 1
fi

echo "Stapling the notarization ticket..."
if ! xcrun stapler staple "$PKG_PATH"; then
    echo "❌ Failed to staple the notarization ticket"
    exit 1
fi

echo "✅ Installer notarized and stapled: $PKG_PATH"
