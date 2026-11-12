#!/bin/bash
#
# The installer of a release: Untether-<version>.pkg, which puts Untether.app in /Applications
# and does nothing else.
#
# 2026-11-12: the public download is a .pkg (docs/RELEASE.md). What it is, on purpose:
#
#   - one component, the app, installed at /Applications/Untether.app;
#   - no preinstall or postinstall script: nothing runs as root, nothing touches the home of
#     whoever installs it. The `ut` command, launch at login and the permissions the app asks
#     for stay what they were: things the person turns on from the app;
#   - not relocatable (BundleIsRelocatable false). Left on, Installer puts the app wherever it
#     finds another copy with the same bundle identifier (a build folder, an old copy on the
#     Desktop) instead of /Applications;
#   - not version-checked (BundleIsVersionChecked false): the .pkg installs the version it
#     carries, also over a newer one. Left on, Installer says "installed" and changes nothing;
#   - Apple Silicon and macOS 14 or later, as the app itself.
#
# Usage: create-pkg.sh --app <Untether.app> --version <version> --output <file.pkg>
#                      [--sign "<Developer ID Installer identity>"]
#
# Without --sign the package is unsigned: for looking at its structure, never for a release
# (release.sh refuses to publish one). It does not notarize: notarize-pkg.sh does.
set -euo pipefail

PKG_IDENTIFIER="com.nachx639.untether.pkg"
MIN_MACOS="14.0"

APP=""
VERSION=""
OUTPUT=""
SIGN=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --app | --version | --output | --sign)
            [[ $# -ge 2 ]] || { echo "create-pkg: $1 needs a value" >&2; exit 2; }
            case "$1" in
                --app) APP="$2" ;;
                --version) VERSION="$2" ;;
                --output) OUTPUT="$2" ;;
                --sign) SIGN="$2" ;;
            esac
            shift 2
            ;;
        -h | --help)
            sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed -e '$d' -e 's/^# \{0,1\}//'
            exit 0
            ;;
        *)
            echo "create-pkg: unknown argument $1" >&2
            exit 2
            ;;
    esac
done
if [[ -z "$APP" || -z "$VERSION" || -z "$OUTPUT" ]]; then
    echo "usage: create-pkg.sh --app <Untether.app> --version <version> --output <file.pkg> [--sign <identity>]" >&2
    exit 2
fi
if [[ "$(basename "$APP")" != "Untether.app" || ! -f "$APP/Contents/Info.plist" ]]; then
    echo "create-pkg: $APP is not an Untether.app bundle" >&2
    exit 1
fi
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-z]+\.[0-9]+)?$ ]]; then
    echo "create-pkg: '$VERSION' is not a version (1.2.3 or 1.2.3-beta.4)" >&2
    exit 1
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/untether-pkg.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# The payload: a folder that holds the app and nothing else. ditto keeps signatures, extended
# attributes and symlinks as they are.
mkdir "$WORK/root"
ditto "$APP" "$WORK/root/Untether.app"

pkgbuild --analyze --root "$WORK/root" "$WORK/component.plist" > /dev/null
# pkgbuild writes one entry per bundle it finds at the top of the payload, and leaves a key out
# when it holds its default: `plutil -replace` sets it either way.
index=0
found_app=false
while bundle="$(/usr/libexec/PlistBuddy -c "Print :$index:RootRelativeBundlePath" "$WORK/component.plist" 2> /dev/null)"; do
    [[ "$bundle" == "Untether.app" ]] && found_app=true
    plutil -replace "$index.BundleIsRelocatable" -bool NO "$WORK/component.plist"
    plutil -replace "$index.BundleIsVersionChecked" -bool NO "$WORK/component.plist"
    index=$((index + 1))
done
if [[ "$found_app" != true || "$index" != 1 ]]; then
    echo "create-pkg: the payload must be one bundle, Untether.app ($index found)" >&2
    exit 1
fi

pkgbuild \
    --root "$WORK/root" \
    --component-plist "$WORK/component.plist" \
    --identifier "$PKG_IDENTIFIER" \
    --version "$VERSION" \
    --install-location /Applications \
    "$WORK/Untether-component.pkg" > /dev/null

cat > "$WORK/distribution.xml" <<XML
<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
    <title>Untether $VERSION</title>
    <options customize="never" require-scripts="false" hostArchitectures="arm64"/>
    <domains enable_localSystem="true" enable_anywhere="false" enable_currentUserHome="false"/>
    <volume-check>
        <allowed-os-versions>
            <os-version min="$MIN_MACOS"/>
        </allowed-os-versions>
    </volume-check>
    <choices-outline>
        <line choice="untether"/>
    </choices-outline>
    <choice id="untether" visible="false" title="Untether">
        <pkg-ref id="$PKG_IDENTIFIER"/>
    </choice>
    <pkg-ref id="$PKG_IDENTIFIER" version="$VERSION" onConclusion="none">Untether-component.pkg</pkg-ref>
</installer-gui-script>
XML

SIGN_ARGS=()
if [[ -n "$SIGN" ]]; then
    SIGN_ARGS=(--sign "$SIGN" --timestamp)
fi
mkdir -p "$(dirname "$OUTPUT")"
rm -f "$OUTPUT"
productbuild \
    --distribution "$WORK/distribution.xml" \
    --package-path "$WORK" \
    ${SIGN_ARGS[@]+"${SIGN_ARGS[@]}"} \
    "$OUTPUT" > /dev/null

if [[ -n "$SIGN" ]]; then
    echo "create-pkg: $OUTPUT (signed: $SIGN)"
else
    echo "create-pkg: $OUTPUT (UNSIGNED: not for a release)"
fi
