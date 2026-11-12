#!/bin/bash
#
# Functions shared by the build and release scripts. Sourcing this file does nothing but
# define them (no traps, no output), so mac/scripts/test-release-scripts.sh can call each one.
#

# The version a release gets, from the release type, the pre-release number and the
# MARKETING_VERSION of version.xcconfig.
#
# 2026-11-11: the version was taken from MARKETING_VERSION as it was. With
# "1.0.0-beta.18" in version.xcconfig a stable release was tagged v1.0.0-beta.18, and
# the next beta became "1.0.0-beta.18-beta.19" (which the double-suffix check then
# refused). The base version is what comes before the first "-".
untether_release_version() {
    local release_type="$1" prerelease_number="$2" marketing_version="$3"
    local base_version="${marketing_version%%-*}"
    if [[ "$release_type" == "stable" ]]; then
        printf '%s\n' "$base_version"
    else
        printf '%s\n' "$base_version-$release_type.$prerelease_number"
    fi
}

# The DerivedData folders Xcode keeps for one checkout, one per line.
#
# 2026-11-11: release.sh and clean.sh removed ~/Library/Developer/Xcode/DerivedData/Untether-*,
# which is the build of EVERY checkout of the project (each task worktree has one): a
# release or a clean in one of them threw away the builds of all the others. Xcode writes
# the project or workspace a folder belongs to in its info.plist (WorkspacePath).
#
#   untether_own_derived_data <checkout root (the folder that holds mac/)> [DerivedData root]
untether_own_derived_data() {
    local checkout_root derived_data_root dir workspace
    checkout_root="$(cd "$1" && pwd -P)" || return 1
    derived_data_root="${2:-$HOME/Library/Developer/Xcode/DerivedData}"
    [[ -d "$derived_data_root" ]] || return 0
    for dir in "$derived_data_root"/Untether-*; do
        [[ -f "$dir/info.plist" ]] || continue
        workspace="$(/usr/libexec/PlistBuddy -c 'Print :WorkspacePath' "$dir/info.plist" 2>/dev/null)" || continue
        if [[ "$workspace" == "$checkout_root"/* ]]; then
            printf '%s\n' "$dir"
        fi
    done
}

# Where xcodebuild puts this checkout's Untether.app for a configuration (run from mac/).
#
# 2026-11-11: build.sh and release.sh took the first Untether.app that `find` met in all of
# DerivedData, which with several checkouts is as likely another worktree's build as this one.
untether_built_app_path() {
    local configuration="$1" products_dir
    products_dir="$(xcodebuild -project Untether.xcodeproj -scheme Untether -configuration "$configuration" \
        -showBuildSettings 2>/dev/null | awk -F' = ' '/ BUILT_PRODUCTS_DIR = / { print $2; exit }')"
    [[ -n "$products_dir" ]] || return 1
    printf '%s\n' "$products_dir/Untether.app"
}

# The public repository, <owner>/<name>: the "homepage" of web/package.json, the one value
# scripts/repo-url.sh keeps everywhere.
#
#   untether_public_repo <checkout root>
untether_public_repo() {
    local repo
    repo="$(sed -n 's|^[[:space:]]*"homepage":[[:space:]]*"https://github\.com/\([^"]*\)".*|\1|p' "$1/web/package.json" 2>/dev/null | head -1)"
    [[ "$repo" =~ ^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9._-]+$ ]] || return 1
    printf '%s\n' "$repo"
}

# Says, and succeeds, when this process was started by something that is not a person giving
# the order: a CI job, a git hook or alias, an Untether task.
#
# 2026-11-12: a release is published only when the owner orders it (docs/RELEASE.md). The
# other half of the guard is `--confirm <tag>`: a job that carried it would work once, for one
# version, and never again.
untether_release_automation() {
    if [[ -n "${CI:-}" || -n "${GITHUB_ACTIONS:-}" ]]; then
        printf '%s\n' "this is a CI job (CI is set)"
    elif [[ -n "${UNTETHER_TASK_ID:-}" ]]; then
        printf '%s\n' "this is an Untether task (UNTETHER_TASK_ID is set)"
    elif [[ -n "${GIT_EXEC_PATH:-}" || -n "${GIT_INDEX_FILE:-}" ]]; then
        printf '%s\n' "git started this (a hook or an alias: GIT_EXEC_PATH or GIT_INDEX_FILE is set)"
    else
        return 1
    fi
}

# What a release's installer must be: one package that installs Untether.app in /Applications,
# stays there (not relocatable: PackageInfo lists under <relocate> the bundles Installer may
# put elsewhere), installs whatever copy is already there, and runs no script. Prints what is
# wrong and fails.
#
#   untether_check_pkg <file.pkg>
untether_check_pkg() {
    # What a tool prints is read whole before it is searched: under `set -o pipefail` a
    # tool piped into a quiet grep fails when grep leaves at its first match and the tool dies writing.
    local pkg="$1" expanded info component components payload bad=0
    expanded="$(mktemp -d "${TMPDIR:-/tmp}/untether-pkg-check.XXXXXX")"
    if ! pkgutil --expand "$pkg" "$expanded/pkg" 2>/dev/null; then
        printf '%s\n' "it cannot be opened as a package"
        rm -rf "$expanded"
        return 1
    fi
    payload="$(pkgutil --payload-files "$pkg" 2>/dev/null || true)"
    components="$(find "$expanded/pkg" -name PackageInfo | wc -l | tr -d ' ')"
    component="$(dirname "$(find "$expanded/pkg" -name PackageInfo | head -1)")"
    info="$component/PackageInfo"
    if [[ "$components" != 1 ]]; then
        printf '%s\n' "it holds $components packages, not one"
        bad=1
    elif ! grep -q 'install-location="/Applications"' "$info"; then
        printf '%s\n' "it does not install in /Applications"
        bad=1
    elif ! grep -q '<relocate/>' "$info"; then
        printf '%s\n' "it is relocatable: Installer would put the app wherever another copy is"
        bad=1
    elif ! grep -q '<bundle-version/>' "$info"; then
        printf '%s\n' "it is version-checked: over a newer copy Installer would install nothing"
        bad=1
    elif ! grep -q '<bundle path="./Untether.app"' "$info"; then
        printf '%s\n' "its bundle is not Untether.app"
        bad=1
    elif [[ -n "$(find "$expanded/pkg" \( -name Scripts -o -name preinstall -o -name postinstall \) | head -1)" ]] ||
        grep -qE '<scripts>|<(pre|post)install' "$info"; then
        printf '%s\n' "it carries install scripts"
        bad=1
    elif [[ -n "$(grep -v '/\._[^/]*$' <<< "$payload" | grep -v -E '^\.$|^\./Untether\.app(/|$)' || true)" ]]; then
        printf '%s\n' "its payload has more than Untether.app"
        bad=1
    elif ! grep -q -x './Untether.app/Contents/MacOS/Untether' <<< "$payload"; then
        printf '%s\n' "its payload has no Untether.app/Contents/MacOS/Untether"
        bad=1
    fi
    rm -rf "$expanded"
    return "$bad"
}
