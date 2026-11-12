#!/usr/bin/env bash
# codesign-app.sh - Code signing script for Untether (no --deep)

set -euo pipefail

APP_BUNDLE="${1:-build/Build/Products/Release/Untether.app}"
SIGN_IDENTITY="${2:-${SIGN_IDENTITY:-}}"

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

if [[ ! -d "$APP_BUNDLE" ]]; then
  fail "App bundle not found: $APP_BUNDLE"
fi

select_identity() {
  local preferred available first

  preferred="$(security find-identity -p codesigning -v 2>/dev/null \
    | awk -F'\"' '/Developer ID Application/ { print $2; exit }')"
  if [[ -n "$preferred" ]]; then
    printf '%s\n' "$preferred"
    return 0
  fi

  # 2026-11-11: the sed here had its escapes doubled (\\( … \\1), matched nothing and left
  # every identity that is not "Developer ID Application" unfound.
  available="$(security find-identity -p codesigning -v 2>/dev/null | sed -n 's/.*"\(.*\)".*/\1/p')"
  if [[ -n "$available" ]]; then
    first="$(printf '%s\n' "$available" | head -n1)"
    printf '%s\n' "$first"
    return 0
  fi

  return 1
}

if [[ -z "$SIGN_IDENTITY" ]]; then
  if SIGN_IDENTITY="$(select_identity)"; then
    log "Using signing identity: $SIGN_IDENTITY"
  else
    fail "No signing identity found. Set SIGN_IDENTITY to a stable codesigning certificate."
  fi
else
  log "Using signing identity (explicit): $SIGN_IDENTITY"
fi

if [[ "$SIGN_IDENTITY" == "-" ]]; then
  fail "Ad-hoc signing is disabled; use a stable codesigning certificate."
fi

TIMESTAMP_FLAG="--timestamp=none"
if [[ "${CODESIGN_TIMESTAMP:-}" == "1" ]]; then
  TIMESTAMP_FLAG="--timestamp"
fi

KEYCHAIN_OPTS=""
if [[ -n "${KEYCHAIN_NAME:-}" ]]; then
  KEYCHAIN_OPTS="--keychain $KEYCHAIN_NAME"
  log "Using keychain: $KEYCHAIN_NAME"
fi

ENTITLEMENTS_FILE="Untether/Untether.entitlements"
TMP_ENTITLEMENTS="$(mktemp -t untether-entitlements.XXXXXX)"

BUNDLE_ID="$(defaults read "$APP_BUNDLE/Contents/Info.plist" CFBundleIdentifier 2>/dev/null || echo "com.nachx639.untether")"
log "Bundle identifier: $BUNDLE_ID"

if [[ -f "$ENTITLEMENTS_FILE" ]]; then
  sed -e 's/$(PRODUCT_BUNDLE_IDENTIFIER)/'"$BUNDLE_ID"'/g' "$ENTITLEMENTS_FILE" > "$TMP_ENTITLEMENTS"
else
  fail "Entitlements file not found: $ENTITLEMENTS_FILE"
fi

log "Preparing bundle for signing (xattr -cr)"
xattr -cr "$APP_BUNDLE" 2>/dev/null || true

sign_plain() {
  local target="$1"
  codesign --force --options runtime $TIMESTAMP_FLAG --sign "$SIGN_IDENTITY" $KEYCHAIN_OPTS "$target"
}

sign_with_entitlements() {
  local target="$1"
  codesign --force --options runtime $TIMESTAMP_FLAG --entitlements "$TMP_ENTITLEMENTS" --sign "$SIGN_IDENTITY" $KEYCHAIN_OPTS "$target"
}

if [[ -d "$APP_BUNDLE/Contents/Frameworks" ]]; then
  log "Signing embedded frameworks/dylibs"
  find "$APP_BUNDLE/Contents/Frameworks" \( -name "*.framework" -o -name "*.dylib" \) -print0 \
    | while IFS= read -r -d '' item; do
      sign_plain "$item"
    done
fi

if [[ -d "$APP_BUNDLE/Contents/Resources" ]]; then
  UNTETHER_ENTITLEMENTS="$(dirname "$0")/../Untether/untether-binary.entitlements"

  if [[ -f "$APP_BUNDLE/Contents/Resources/untether" ]]; then
    log "Signing embedded untether binary with JIT entitlements"
    codesign --force --options runtime $TIMESTAMP_FLAG --sign "$SIGN_IDENTITY" --entitlements "$UNTETHER_ENTITLEMENTS" $KEYCHAIN_OPTS "$APP_BUNDLE/Contents/Resources/untether"
  fi

  if [[ -f "$APP_BUNDLE/Contents/Resources/untether-fwd" ]]; then
    log "Signing untether-fwd with entitlements"
    codesign --force --options runtime $TIMESTAMP_FLAG --sign "$SIGN_IDENTITY" --entitlements "$UNTETHER_ENTITLEMENTS" $KEYCHAIN_OPTS "$APP_BUNDLE/Contents/Resources/untether-fwd"
  fi
fi

log "Signing main executable"
sign_with_entitlements "$APP_BUNDLE/Contents/MacOS/Untether"

log "Signing app bundle (no --deep)"
sign_with_entitlements "$APP_BUNDLE"

log "Verifying code signature"
codesign --verify --verbose=2 "$APP_BUNDLE" >/dev/null 2>&1 || fail "codesign verify failed"

rm -f "$TMP_ENTITLEMENTS"
log "Codesign complete for $APP_BUNDLE"
