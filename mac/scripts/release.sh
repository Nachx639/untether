#!/bin/bash

# =============================================================================
# Untether release: the one way a version becomes a public download
# =============================================================================
#
# 2026-11-12: the working repository is private and the public one
# (https://github.com/Nachx639/untether) receives a clean copy. A release is a signed and
# notarized installer, Untether-<version>.pkg, attached to a GitHub release of the PUBLIC
# repository, on a tag that points at a commit of the clean copy. Nothing of the working
# history is tagged or published, and nothing is published in the working repository.
#
# ONLY BY HAND. Nothing runs this script for you: no hook, no scheduled job, no workflow, no
# merge, no task (web/src/test/unit/release-entry-point.test.ts keeps it so). A release happens
# when the owner orders it, with the tag written out:
#
#   ./scripts/release.sh stable --confirm v1.0.0
#
# And the app people install never updates itself: a new version is a new .pkg they download.
#
# USAGE:
#   ./scripts/release.sh --dry-run [--app <Untether.app>] <type> [number]
#   ./scripts/release.sh <type> [number] --confirm <tag>
#
#   type        stable, beta, alpha or rc ("stable" is a release without the pre-release mark)
#   number      pre-release number (beta/alpha/rc)
#   --confirm   the tag this run publishes (v1.0.0): a run without it publishes nothing
#   --dry-run   everything that stays on this Mac (checks, build, .pkg, the clean copy in a
#               temporary folder), nothing that leaves it: no notarization, no push, no tag,
#               no release. It goes on past what would stop a real run and lists it at the end.
#   --app       dry run only: package this bundle instead of building one (it is copied,
#               never signed or changed)
#
# THE VERSION is the one committed in Untether/version.xcconfig and web/package.json. The
# script changes neither: it stops when they do not say the version the arguments ask for.
#
# WHAT A REAL RUN DOES, in this order (it stops at the first failure; nothing is published
# before step 6):
#   1. checks: the working repository's main line (untether_release_branch), clean, the version, the certificates, the notarization key, the public
#      repository (visible, its rulesets in place, tag and release not there yet)
#   2. builds the app (Release, Apple Silicon)
#   3. signs it (Developer ID Application, hardened runtime), notarizes and staples it
#   4. builds the .pkg (create-pkg.sh), signs it (Developer ID Installer), notarizes and
#      staples it (notarize-pkg.sh)
#   5. makes the clean copy on top of the public repository (scripts/public-export.sh), in a
#      temporary folder outside this repository
#   6. pushes the copy, tags that commit there, creates the release with the .pkg
#
# ENVIRONMENT (notarization): APP_STORE_CONNECT_KEY_ID, APP_STORE_CONNECT_ISSUER_ID, and the
# key itself as APP_STORE_CONNECT_API_KEY_PATH (the .p8 file) or APP_STORE_CONNECT_API_KEY_P8
# (the content of that file).
#
# It cannot resume. It takes 20-30 minutes (two notarizations): run it in tmux, never under a
# tool's timeout.
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAC_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$MAC_DIR/.." && pwd)"

source "$SCRIPT_DIR/release-lib.sh"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

show_usage() {
    sed -n '/^# USAGE:/,/^# THE VERSION/p' "${BASH_SOURCE[0]}" | sed -e '$d' -e 's/^# \{0,1\}//'
}
usage_error() {
    echo -e "${RED}❌ $1${NC}" >&2
    echo "" >&2
    show_usage >&2
    exit 2
}

DRY_RUN=false
RELEASE_TYPE=""
PRERELEASE_NUMBER=""
CONFIRM_TAG=""
GIVEN_APP=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --confirm | --app)
            [[ $# -ge 2 ]] || usage_error "$1 needs a value"
            if [[ "$1" == "--confirm" ]]; then CONFIRM_TAG="$2"; else GIVEN_APP="$2"; fi
            shift 2
            ;;
        -h | --help)
            show_usage
            exit 0
            ;;
        stable | beta | alpha | rc)
            [[ -z "$RELEASE_TYPE" ]] || usage_error "Release type given twice ($RELEASE_TYPE, $1)"
            RELEASE_TYPE="$1"
            shift
            ;;
        *)
            if [[ -n "$RELEASE_TYPE" && "$RELEASE_TYPE" != "stable" && -z "$PRERELEASE_NUMBER" ]]; then
                PRERELEASE_NUMBER="$1"
                shift
            else
                usage_error "Unknown argument: $1"
            fi
            ;;
    esac
done
[[ -n "$RELEASE_TYPE" ]] || usage_error "Release type is required"
if [[ "$RELEASE_TYPE" != "stable" ]]; then
    [[ "$PRERELEASE_NUMBER" =~ ^[1-9][0-9]*$ ]] ||
        usage_error "A $RELEASE_TYPE release needs its number: $0 $RELEASE_TYPE 1"
fi
if [[ -n "$GIVEN_APP" && "$DRY_RUN" != true ]]; then
    usage_error "--app is for --dry-run only: a release is built by this script, from the committed source"
fi
if [[ -n "$GIVEN_APP" ]]; then
    [[ -f "$GIVEN_APP/Contents/Info.plist" ]] || usage_error "--app: $GIVEN_APP is not an app bundle"
    # Absolute before the `cd` below: a path given from where the person stands would not
    # resolve from mac/.
    GIVEN_APP="$(cd "$GIVEN_APP" && pwd)"
fi

# What would stop a real run. A dry run notes it and goes on, to show everything at once.
BLOCKERS=()
stop() {
    if [[ "$DRY_RUN" == true ]]; then
        BLOCKERS+=("$1")
        echo -e "${YELLOW}✋ a real run stops here:${NC} $1"
    else
        echo -e "${RED}❌ $1${NC}" >&2
        echo "   Nothing was pushed, tagged or published." >&2
        exit 1
    fi
}
ok() { echo -e "${GREEN}✅${NC} $1"; }
step() {
    echo ""
    echo -e "${BLUE}📋 $1${NC}"
}

cd "$MAC_DIR"

echo -e "${BLUE}🚀 Untether release${NC}"
if [[ "$DRY_RUN" == true ]]; then
    echo -e "${YELLOW}🔍 DRY RUN: nothing leaves this Mac (no notarization, no push, no tag, no release)${NC}"
fi

# --- 1. checks ----------------------------------------------------------------
step "1/6 Checks"

VERSION_CONFIG="$MAC_DIR/Untether/version.xcconfig"
MARKETING_VERSION="$(sed -n 's/^MARKETING_VERSION = //p' "$VERSION_CONFIG")"
BUILD_NUMBER="$(sed -n 's/^CURRENT_PROJECT_VERSION = //p' "$VERSION_CONFIG")"
WEB_VERSION="$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$REPO_ROOT/web/package.json" | head -1)"
RELEASE_VERSION="$(untether_release_version "$RELEASE_TYPE" "$PRERELEASE_NUMBER" "$MARKETING_VERSION")"
TAG_NAME="v$RELEASE_VERSION"
PUBLIC_REPO="$(untether_public_repo "$REPO_ROOT")" || {
    echo -e "${RED}❌ web/package.json has no \"homepage\": \"https://github.com/<owner>/<name>\"${NC}" >&2
    exit 1
}

echo "   type      $RELEASE_TYPE"
echo "   version   $RELEASE_VERSION (build $BUILD_NUMBER)"
echo "   tag       $TAG_NAME"
echo "   release   https://github.com/$PUBLIC_REPO/releases/tag/$TAG_NAME"

# By hand only: this is what a job, a hook or a task looks like from here.
if [[ "$DRY_RUN" != true ]]; then
    if AUTOMATION="$(untether_release_automation)"; then
        echo -e "${RED}❌ Not publishing: $AUTOMATION.${NC}" >&2
        echo "   A release is published by hand, on the owner's order. A rehearsal is: $0 --dry-run $RELEASE_TYPE${PRERELEASE_NUMBER:+ $PRERELEASE_NUMBER}" >&2
        exit 1
    fi
    if [[ "$CONFIRM_TAG" != "$TAG_NAME" ]]; then
        echo -e "${RED}❌ Not publishing: this run would publish $TAG_NAME and ${CONFIRM_TAG:+--confirm says $CONFIRM_TAG}${CONFIRM_TAG:-there is no --confirm}.${NC}" >&2
        echo "   To publish:  $0 $RELEASE_TYPE${PRERELEASE_NUMBER:+ $PRERELEASE_NUMBER} --confirm $TAG_NAME" >&2
        echo "   To rehearse: $0 --dry-run $RELEASE_TYPE${PRERELEASE_NUMBER:+ $PRERELEASE_NUMBER}" >&2
        exit 1
    fi
fi

if [[ "$MARKETING_VERSION" != "$RELEASE_VERSION" || "$WEB_VERSION" != "$RELEASE_VERSION" ]]; then
    stop "the committed version is not $RELEASE_VERSION (mac/Untether/version.xcconfig: $MARKETING_VERSION, web/package.json: $WEB_VERSION). Set both to $RELEASE_VERSION, raise CURRENT_PROJECT_VERSION, close its section in CHANGELOG.md, and commit"
else
    ok "version.xcconfig and web/package.json say $RELEASE_VERSION"
fi

# The release notes are that version's section of CHANGELOG.md: without one they would say nothing.
CHANGELOG_SECTION="$(grep -E "^## \[$RELEASE_VERSION\]" "$REPO_ROOT/CHANGELOG.md" 2> /dev/null | head -1 || true)"
if [[ -n "$CHANGELOG_SECTION" ]] && ! grep -q -i "unreleased" <<< "$CHANGELOG_SECTION"; then
    ok "CHANGELOG.md has the section of $RELEASE_VERSION"
else
    stop "CHANGELOG.md has no closed section \"## [$RELEASE_VERSION] - <date>\" (the release notes are taken from it)"
fi

# The working repository's main line, not "main": that is the public repository's branch.
RELEASE_BRANCH="$(untether_release_branch)"
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$CURRENT_BRANCH" != "$RELEASE_BRANCH" ]]; then
    stop "not on $RELEASE_BRANCH (on $CURRENT_BRANCH): a release is made from $RELEASE_BRANCH, the working repository's main line"
else
    ok "on $RELEASE_BRANCH, the working repository's main line"
fi
if [[ -n "$(git status --porcelain)" ]]; then
    stop "uncommitted changes: only what is committed is built and published"
fi

if ! "$SCRIPT_DIR/preflight-check.sh"; then
    stop "the pre-flight check failed (mac/scripts/preflight-check.sh, above)"
fi

IDENTITIES="$(security find-identity -v 2> /dev/null || true)"
APP_IDENTITY="$(sed -n 's/.*"\(Developer ID Application: [^"]*\)".*/\1/p' <<< "$IDENTITIES" | head -1)"
PKG_IDENTITY="$(sed -n 's/.*"\(Developer ID Installer: [^"]*\)".*/\1/p' <<< "$IDENTITIES" | head -1)"
if [[ -n "$APP_IDENTITY" ]]; then
    ok "app signing identity: $APP_IDENTITY"
else
    stop "no \"Developer ID Application\" certificate in the keychain (it signs the app)"
fi
if [[ -n "$PKG_IDENTITY" ]]; then
    ok "installer signing identity: $PKG_IDENTITY"
else
    stop "no \"Developer ID Installer\" certificate in the keychain (it signs the .pkg; it is another certificate than the app's, made in the same Apple developer account)"
fi
if NOTARY_KEY_PROBLEM="$(untether_check_notary_key)"; then
    ok "notarization key in the environment"
else
    stop "no notarization key in the environment: $(paste -sd ';' - <<< "$NOTARY_KEY_PROBLEM" | sed 's/;/; /g')"
fi

# The public repository: visible, protected, and without this tag or release.
PUBLIC_STATE=""
if ! command -v gh > /dev/null 2>&1 || ! gh auth status > /dev/null 2>&1; then
    stop "GitHub CLI (gh) is not installed or not signed in"
elif ! PUBLIC_STATE="$(gh repo view "$PUBLIC_REPO" --json visibility,isEmpty --jq '.visibility + " " + (.isEmpty | tostring)' 2> /dev/null)"; then
    stop "the public repository $PUBLIC_REPO cannot be read"
else
    PUBLIC_VISIBILITY="${PUBLIC_STATE%% *}"
    if [[ "$PUBLIC_VISIBILITY" == "PUBLIC" ]]; then
        ok "$PUBLIC_REPO is public"
    else
        stop "$PUBLIC_REPO is $PUBLIC_VISIBILITY: nobody outside would see the release. Making it public is the owner's decision"
    fi
    # The rulesets let release tags (v*) be created and never moved, and nothing else.
    if RULES_OUT="$("$REPO_ROOT/scripts/public-repo-rules.sh" --check 2>&1)"; then
        ok "the public repository's rulesets are in place"
    else
        stop "the public repository's rulesets are not in place (scripts/public-repo-rules.sh --check: $(tail -1 <<< "$RULES_OUT"))"
    fi
    if TAG_OUT="$(gh api "repos/$PUBLIC_REPO/git/ref/tags/$TAG_NAME" 2>&1)"; then
        stop "the tag $TAG_NAME already exists in $PUBLIC_REPO: a published version is never replaced; release the next one"
    elif ! grep -q 'HTTP 404' <<< "$TAG_OUT"; then
        stop "cannot tell whether the tag $TAG_NAME exists in $PUBLIC_REPO ($(head -1 <<< "$TAG_OUT"))"
    else
        ok "the tag $TAG_NAME is free in $PUBLIC_REPO"
    fi
fi

# --- 2. build -----------------------------------------------------------------
step "2/6 Build"

if [[ -n "$GIVEN_APP" ]]; then
    WORK="$(mktemp -d "${TMPDIR:-/tmp}/untether-release-dry.XXXXXX")"
    WORK="$(cd "$WORK" && pwd)"
    APP_PATH="$WORK/app/Untether.app"
    mkdir -p "$WORK/app"
    ditto "$GIVEN_APP" "$APP_PATH"
    echo "   not building: packaging a copy of $GIVEN_APP"
    echo "   a real run builds: $SCRIPT_DIR/build.sh --configuration Release --arch arm64 --no-sign"
else
    rm -rf "$MAC_DIR/build" "$MAC_DIR/DerivedData"
    # Only this checkout's DerivedData: every other worktree has its own Untether-* there.
    while IFS= read -r own_derived_data; do
        [[ -n "$own_derived_data" ]] && rm -rf "$own_derived_data"
    done < <(untether_own_derived_data "$REPO_ROOT")
    WORK="$MAC_DIR/build/release"

    # Release artifacts must never reuse a system-Node or stale web build.
    export UNTETHER_REQUIRE_CUSTOM_NODE=YES
    export UNTETHER_FORCE_WEB_BUILD=YES
    export UNTETHER_FORCE_NATIVE_BUILD=YES
    if [[ "$RELEASE_TYPE" == "stable" ]]; then
        export IS_PRERELEASE_BUILD=NO
    else
        export IS_PRERELEASE_BUILD=YES
    fi
    "$SCRIPT_DIR/build.sh" --configuration Release --arch arm64 --no-sign

    APP_PATH="$MAC_DIR/build/Build/Products/Release/Untether.app"
    if [[ ! -d "$APP_PATH" ]]; then
        BUILT_APP="$(untether_built_app_path Release)" || BUILT_APP=""
        if [[ ! -d "$BUILT_APP" ]]; then
            echo -e "${RED}❌ Build failed: app not found${NC}" >&2
            exit 1
        fi
        mkdir -p "$(dirname "$APP_PATH")"
        cp -R "$BUILT_APP" "$(dirname "$APP_PATH")/"
    fi
    mkdir -p "$WORK"

    BUILT_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP_PATH/Contents/Info.plist")"
    BUILT_BUILD="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$APP_PATH/Contents/Info.plist")"
    if [[ "$BUILT_BUILD" != "$BUILD_NUMBER" ]]; then
        echo -e "${RED}❌ Build number mismatch: expected $BUILD_NUMBER, built $BUILT_BUILD${NC}" >&2
        exit 1
    fi
    if [[ "$BUILT_VERSION" != "$RELEASE_VERSION" ]]; then
        stop "the built app says version $BUILT_VERSION, not $RELEASE_VERSION"
    fi
    if [[ "$(lipo -archs "$APP_PATH/Contents/MacOS/Untether" 2> /dev/null)" != *arm64* ]]; then
        echo -e "${RED}❌ The app is not an Apple Silicon binary${NC}" >&2
        exit 1
    fi
    for REQUIRED_FILE in \
        Contents/MacOS/Untether \
        Contents/Resources/untether \
        Contents/Resources/untether-fwd \
        Contents/Resources/web/public/ghostty-vt.wasm \
        Contents/Resources/pty.node; do
        if [[ ! -f "$APP_PATH/$REQUIRED_FILE" ]]; then
            echo -e "${RED}❌ Required release component missing: $REQUIRED_FILE${NC}" >&2
            exit 1
        fi
    done
    for DEVELOPMENT_LEFTOVER in node_modules '*.jar'; do
        if [[ -n "$(find "$APP_PATH" -name "$DEVELOPMENT_LEFTOVER" -print -quit)" ]]; then
            echo -e "${RED}❌ Development files in the app bundle ($DEVELOPMENT_LEFTOVER)${NC}" >&2
            exit 1
        fi
    done
    BUILD_INFO="$REPO_ROOT/web/native/untether-build.json"
    if ! node -e '
        const info = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
        if (info.schemaVersion !== 1 || info.customNode !== true) process.exit(1);
        console.log(`   embedded server built with custom Node.js ${info.nodeVersion} (${info.arch})`);
    ' "$BUILD_INFO"; then
        echo -e "${RED}❌ The release server was not built with the custom Node.js ($BUILD_INFO)${NC}" >&2
        exit 1
    fi
    ok "built $APP_PATH"
fi

# --- 3. sign and notarize the app -----------------------------------------------
step "3/6 Sign and notarize the app"

if [[ "$DRY_RUN" == true ]]; then
    if [[ -n "$GIVEN_APP" ]]; then
        echo "   not signing: the bundle given with --app is packaged as it is"
    elif [[ -n "$APP_IDENTITY" ]]; then
        env -u SIGN_IDENTITY "$SCRIPT_DIR/sign-and-notarize.sh" --sign-only --no-zip --identity "$APP_IDENTITY"
        ok "signed with $APP_IDENTITY (hardened runtime)"
    else
        echo "   not signing: no Developer ID Application certificate"
    fi
    echo "   a real run: $SCRIPT_DIR/sign-and-notarize.sh --sign-and-notarize --no-zip"
    echo "               (Developer ID Application, hardened runtime, notarytool, stapler)"
else
    env -u SIGN_IDENTITY "$SCRIPT_DIR/sign-and-notarize.sh" --sign-and-notarize --no-zip --identity "$APP_IDENTITY"
    # Read whole, then searched: piped into a quiet grep it fails under pipefail when grep leaves first.
    GATEKEEPER="$(spctl -a -t exec -vv "$APP_PATH" 2>&1 || true)"
    if ! grep -q "source=Notarized Developer ID" <<< "$GATEKEEPER"; then
        echo -e "${RED}❌ Gatekeeper does not accept the app as notarized${NC}" >&2
        exit 1
    fi
    ok "app signed, notarized and stapled"
fi

# --- 4. the installer -----------------------------------------------------------
step "4/6 Installer (.pkg)"

PKG_PATH="$WORK/Untether-$RELEASE_VERSION.pkg"
if [[ -n "$PKG_IDENTITY" ]]; then
    "$SCRIPT_DIR/create-pkg.sh" --app "$APP_PATH" --version "$RELEASE_VERSION" --output "$PKG_PATH" --sign "$PKG_IDENTITY"
else
    "$SCRIPT_DIR/create-pkg.sh" --app "$APP_PATH" --version "$RELEASE_VERSION" --output "$PKG_PATH"
fi
if ! PKG_PROBLEM="$(untether_check_pkg "$PKG_PATH")"; then
    echo -e "${RED}❌ The installer is not what a release ships: $PKG_PROBLEM${NC}" >&2
    exit 1
fi
ok "installs Untether.app in /Applications and nothing else (no scripts, not relocatable)"

if [[ "$DRY_RUN" == true ]]; then
    echo "   a real run: $SCRIPT_DIR/notarize-pkg.sh $PKG_PATH   (notarytool, stapler)"
else
    "$SCRIPT_DIR/notarize-pkg.sh" "$PKG_PATH"
    PKG_SIGNATURE="$(pkgutil --check-signature "$PKG_PATH" 2>&1 || true)"
    if ! grep -q "Developer ID Installer" <<< "$PKG_SIGNATURE"; then
        echo -e "${RED}❌ The installer is not signed with a Developer ID Installer certificate${NC}" >&2
        exit 1
    fi
    if ! xcrun stapler validate "$PKG_PATH" > /dev/null 2>&1; then
        echo -e "${RED}❌ The notarization ticket is not stapled to the installer${NC}" >&2
        exit 1
    fi
    GATEKEEPER="$(spctl -a -t install -vv "$PKG_PATH" 2>&1 || true)"
    if ! grep -q "accepted" <<< "$GATEKEEPER"; then
        echo -e "${RED}❌ Gatekeeper does not accept the installer${NC}" >&2
        exit 1
    fi
    ok "installer signed, notarized and stapled ($(du -h "$PKG_PATH" | cut -f1 | tr -d ' '))"
fi
PKG_SHA256="$(shasum -a 256 "$PKG_PATH" | cut -d' ' -f1)"

NOTES_PATH="$WORK/release-notes.md"
{
    "$SCRIPT_DIR/generate-release-notes.sh" "$RELEASE_VERSION"
    echo ""
    echo "## Install"
    echo ""
    echo "Download \`Untether-$RELEASE_VERSION.pkg\` and open it: it puts Untether.app in /Applications and nothing else. Apple Silicon, macOS 14 or later."
    echo ""
    echo "Untether does not update itself. A new version is a new \`.pkg\`: quit Untether, open the new installer, open Untether again."
    echo ""
    echo "SHA-256: \`$PKG_SHA256\`"
} > "$NOTES_PATH"

if [[ "$RELEASE_VERSION" =~ ^([0-9.]+)-([a-z]+)\.([0-9]+)$ ]]; then
    case "${BASH_REMATCH[2]}" in
        beta) KIND="Beta" ;;
        alpha) KIND="Alpha" ;;
        *) KIND="RC" ;;
    esac
    RELEASE_TITLE="Untether ${BASH_REMATCH[1]} $KIND ${BASH_REMATCH[3]}"
    RELEASE_FLAGS=(--prerelease)
else
    RELEASE_TITLE="Untether $RELEASE_VERSION"
    RELEASE_FLAGS=(--latest)
fi

# --- 5. the clean copy ----------------------------------------------------------
step "5/6 The clean copy for the public repository"

# Outside the working repository, always: the exporter refuses a destination inside it (and the
# build folder is inside it). 2026-11-12: the copy was put in mac/build/release/public, where
# every run without --app would have failed at the export.
COPY="$(mktemp -d "${TMPDIR:-/tmp}/untether-public-copy.XXXXXX")"
COPY="$(cd "$COPY" && pwd)/copy"
COPY_MODE=new
PUBLIC_BEFORE=""
if [[ "$PUBLIC_STATE" == *" false" ]]; then
    # On top of what is public today: one more commit of the exporter's.
    if gh repo clone "$PUBLIC_REPO" "$COPY" -- --quiet; then
        COPY_MODE=update
        PUBLIC_BEFORE="$(git -C "$COPY" rev-parse HEAD)"
    else
        stop "the public repository $PUBLIC_REPO could not be cloned"
        rm -rf "$COPY"
    fi
fi
"$REPO_ROOT/scripts/public-export.sh" "$COPY"
PUBLIC_SHA="$(git -C "$COPY" rev-parse HEAD)"
if [[ "$COPY_MODE" == new ]]; then
    git -C "$COPY" remote add origin "https://github.com/$PUBLIC_REPO.git"
    echo "   the copy is a new history of one commit (the public repository is empty or was not read)"
elif [[ "$PUBLIC_SHA" == "$PUBLIC_BEFORE" ]]; then
    echo "   the public repository already holds this source: no new commit, the tag goes on $PUBLIC_SHA"
else
    echo "   one new commit on top of the public main:"
    git -C "$COPY" --no-pager diff --stat "$PUBLIC_BEFORE" "$PUBLIC_SHA" | tail -1
fi
ok "tag $TAG_NAME goes on $PUBLIC_SHA ($(git -C "$COPY" log -1 --format=%s "$PUBLIC_SHA"))"

# --- 6. publish -----------------------------------------------------------------
step "6/6 Publish"

if [[ "$DRY_RUN" == true ]]; then
    echo "   a real run would now run, and this one did not:"
    echo "     git -C $COPY push origin main"
    echo "     git -C $COPY tag $TAG_NAME $PUBLIC_SHA"
    echo "     git -C $COPY push origin refs/tags/$TAG_NAME"
    echo "     gh release create $TAG_NAME --repo $PUBLIC_REPO --verify-tag --title \"$RELEASE_TITLE\" --notes-file $NOTES_PATH ${RELEASE_FLAGS[*]} $PKG_PATH"
    echo ""
    echo "📦 Dry run of Untether $RELEASE_VERSION (build $BUILD_NUMBER)"
    echo "   installer   $PKG_PATH$([[ -n "$PKG_IDENTITY" ]] || echo "   (UNSIGNED)")"
    echo "   sha-256     $PKG_SHA256"
    echo "   notes       $NOTES_PATH"
    echo "   clean copy  $COPY"
    echo "   source      $(git rev-parse --short=12 HEAD) of the working repository ($CURRENT_BRANCH)"
    echo ""
    if [[ ${#BLOCKERS[@]} -eq 0 ]]; then
        echo -e "${GREEN}🎉 Nothing would stop a real run.${NC} To publish, on the owner's order:"
        echo "   $0 $RELEASE_TYPE${PRERELEASE_NUMBER:+ $PRERELEASE_NUMBER} --confirm $TAG_NAME"
    else
        echo -e "${YELLOW}✋ A real run would stop: ${#BLOCKERS[@]} thing(s) to settle first${NC}"
        for BLOCKER in "${BLOCKERS[@]}"; do
            echo "   - $BLOCKER"
        done
    fi
    echo ""
    echo "Nothing was pushed, tagged or published. The files above stay for you to look at."
    exit 0
fi

echo "📤 Pushing the clean copy to $PUBLIC_REPO..."
git -C "$COPY" push origin main
REMOTE_MAIN="$(gh api "repos/$PUBLIC_REPO/commits/main" --jq .sha)"
if [[ "$REMOTE_MAIN" != "$PUBLIC_SHA" ]]; then
    echo -e "${RED}❌ The public main is $REMOTE_MAIN, not the copy just pushed ($PUBLIC_SHA): not tagging${NC}" >&2
    exit 1
fi

echo "🏷️  Tagging $PUBLIC_SHA as $TAG_NAME..."
git -C "$COPY" tag "$TAG_NAME" "$PUBLIC_SHA"
git -C "$COPY" push origin "refs/tags/$TAG_NAME"

echo "📦 Creating the release..."
gh release create "$TAG_NAME" \
    --repo "$PUBLIC_REPO" \
    --verify-tag \
    --title "$RELEASE_TITLE" \
    --notes-file "$NOTES_PATH" \
    "${RELEASE_FLAGS[@]}" \
    "$PKG_PATH"

echo ""
echo -e "${GREEN}🎉 Untether $RELEASE_VERSION is published${NC}"
echo "   release     https://github.com/$PUBLIC_REPO/releases/tag/$TAG_NAME"
echo "   installer   $(basename "$PKG_PATH")   sha-256 $PKG_SHA256"
echo "   tag         $TAG_NAME -> $PUBLIC_SHA (public repository)"
echo "   source      $(git rev-parse --short=12 HEAD) of the working repository"
