#!/bin/bash
# Updates mac/Untether/Localizable.xcstrings from the strings the code uses.
#
# xcodebuild extracts localizable strings (SWIFT_EMIT_LOC_STRINGS) into .stringsdata files
# but, unlike the Xcode app, never merges them into the source catalog. This script does:
#   1. build the app (skip with --no-build to reuse the last Debug build),
#   2. `xcstringstool sync` the catalog with the build's .stringsdata (new keys are added
#      with their English value and comment; keys the code no longer uses become stale),
#   3. give keys without a code comment one naming where they are used, and mark
#      preview-only keys as not translatable (scripts/i18n.py annotate),
#   4. add English plural variations for count keys (scripts/i18n.py plurals),
#   5. check comments, placeholders and plural forms (scripts/i18n.py check).
#
# Translations: see the docstring of scripts/i18n.py (export / merge).
set -euo pipefail

MAC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CATALOG="$MAC_DIR/Untether/Localizable.xcstrings"
BUILD=1
for arg in "$@"; do
    case "$arg" in
        --no-build) BUILD=0 ;;
        *) echo "usage: $0 [--no-build]" >&2; exit 2 ;;
    esac
done

cd "$MAC_DIR"
if [ "$BUILD" = 1 ]; then
    # CODE_SIGNING_ALLOWED=NO: only the .stringsdata of the compile are wanted, and a task
    # worktree has no Local.xcconfig with a signing team (2026-11-11: the build stopped at
    # "requires a development team" there and the catalog could not be synced).
    PATH="$HOME/.cargo/bin:$PATH" xcodebuild -project Untether.xcodeproj -scheme Untether -configuration Debug build -quiet \
        CODE_SIGNING_ALLOWED=NO
fi

OBJECTS_DIR="$(xcodebuild -project Untether.xcodeproj -scheme Untether -configuration Debug -showBuildSettings 2>/dev/null \
    | awk -F' = ' '/ OBJECT_FILE_DIR_normal = / { print $2; exit }')"
if [ -z "$OBJECTS_DIR" ] || [ ! -d "$OBJECTS_DIR" ]; then
    echo "i18n-sync: no Debug build found (expected Objects-normal at '$OBJECTS_DIR')" >&2
    exit 1
fi

STRINGSDATA=()
while IFS= read -r -d '' file; do STRINGSDATA+=("$file"); done \
    < <(find "$OBJECTS_DIR" -name '*.stringsdata' -print0)
if [ "${#STRINGSDATA[@]}" -eq 0 ]; then
    echo "i18n-sync: no .stringsdata in $OBJECTS_DIR (is SWIFT_EMIT_LOC_STRINGS on?)" >&2
    exit 1
fi

if [ ! -f "$CATALOG" ]; then
    printf '{\n  "sourceLanguage" : "en",\n  "strings" : {\n\n  },\n  "version" : "1.0"\n}\n' > "$CATALOG"
fi

xcrun xcstringstool sync "$CATALOG" --stringsdata "${STRINGSDATA[@]}"
python3 "$MAC_DIR/scripts/i18n.py" annotate "$OBJECTS_DIR"
python3 "$MAC_DIR/scripts/i18n.py" plurals
python3 "$MAC_DIR/scripts/i18n.py" check
