#!/bin/bash
#
# Notarizes a signed installer (.pkg) and staples the ticket to it, so that it opens on a Mac
# that is offline. Apple notarizes what is inside too: the app the installer carries.
#
# Usage: ./scripts/notarize-pkg.sh <file.pkg>
#
# Environment: APP_STORE_CONNECT_KEY_ID, APP_STORE_CONNECT_ISSUER_ID, and the key as
# APP_STORE_CONNECT_API_KEY_PATH (the .p8 file) or APP_STORE_CONNECT_API_KEY_P8 (its content).
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/release-lib.sh"

if [[ $# -ne 1 ]]; then
    echo "Usage: $0 <file.pkg>"
    exit 1
fi

PKG_PATH="$1"

if [[ ! -f "$PKG_PATH" ]]; then
    echo "Error: installer not found at $PKG_PATH"
    exit 1
fi

if ! NOTARY_KEY_PROBLEM="$(untether_check_notary_key)"; then
    echo "Error: no notarization key in the environment:"
    echo "$NOTARY_KEY_PROBLEM"
    exit 1
fi

# A key given as content lives in a file only while notarytool reads it; a key given as a
# path (APP_STORE_CONNECT_API_KEY_PATH) is read where it is and never removed.
TEMP_KEY=$(mktemp)
trap 'rm -f "$TEMP_KEY"' EXIT
NOTARY_KEY_FILE="$(untether_notary_key_file "$TEMP_KEY")"

echo "Submitting $PKG_PATH for notarization..."
SUBMISSION_OUTPUT=$(xcrun notarytool submit "$PKG_PATH" \
    --key "$NOTARY_KEY_FILE" \
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
