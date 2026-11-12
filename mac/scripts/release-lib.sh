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

# The branch of the WORKING repository a release is made from: its main line, where every task
# is merged. The one place that names it (release.sh, preflight-check.sh and
# release-checklist.sh ask here).
#
# 2026-11-12: the three of them asked for "main". The working repository's main line is
# `untether`: it has no local `main`, and its origin/main is a backup hundreds of commits
# behind, so the first stable release could not have been made. The PUBLIC repository's branch
# is another matter and stays `main`: the clean copy is one commit on top of it.
untether_release_branch() {
    printf '%s\n' "untether"
}

# The notarization key (App Store Connect API key): what is missing or wrong with it, one
# thing per line, and a failure; nothing and success when it can be handed to notarytool.
#
#   APP_STORE_CONNECT_KEY_ID        the key's ID (10 characters)
#   APP_STORE_CONNECT_ISSUER_ID     the issuer ID (a UUID)
#   APP_STORE_CONNECT_API_KEY_PATH  the path of the AuthKey_<id>.p8 file, or
#   APP_STORE_CONNECT_API_KEY_P8    the CONTENT of that file (with real line breaks or "\n")
#
# 2026-11-12: only the content was taken, so the secret had to sit in a shell variable, and a
# path put in APP_STORE_CONNECT_API_KEY_P8 was written to a file as if it were the key:
# notarytool refused it after the 15-minute build. The path wins when both are set.
untether_check_notary_key() {
    local bad=0 key_path="${APP_STORE_CONNECT_API_KEY_PATH:-}" key="${APP_STORE_CONNECT_API_KEY_P8:-}"
    key_path="${key_path/#\~/$HOME}"
    if [[ -z "${APP_STORE_CONNECT_KEY_ID:-}" ]]; then
        printf '%s\n' "APP_STORE_CONNECT_KEY_ID is not set (the key's ID)"
        bad=1
    fi
    if [[ -z "${APP_STORE_CONNECT_ISSUER_ID:-}" ]]; then
        printf '%s\n' "APP_STORE_CONNECT_ISSUER_ID is not set (the issuer ID)"
        bad=1
    fi
    if [[ -n "$key_path" ]]; then
        if [[ ! -r "$key_path" || ! -f "$key_path" ]]; then
            printf '%s\n' "APP_STORE_CONNECT_API_KEY_PATH is not a readable file ($key_path)"
            bad=1
        elif [[ "$(< "$key_path")" != *"PRIVATE KEY-----"* ]]; then
            printf '%s\n' "APP_STORE_CONNECT_API_KEY_PATH is not a .p8 key ($key_path has no PRIVATE KEY block)"
            bad=1
        fi
    elif [[ -z "$key" ]]; then
        printf '%s\n' "neither APP_STORE_CONNECT_API_KEY_PATH (the .p8 file) nor APP_STORE_CONNECT_API_KEY_P8 (its content) is set"
        bad=1
    elif [[ "$key" != *"PRIVATE KEY-----"* ]]; then
        if [[ "$key" != *$'\n'* && -f "${key/#\~/$HOME}" ]]; then
            printf '%s\n' "APP_STORE_CONNECT_API_KEY_P8 holds a path: it takes the content of the .p8; a path goes in APP_STORE_CONNECT_API_KEY_PATH"
        else
            printf '%s\n' "APP_STORE_CONNECT_API_KEY_P8 is not the content of a .p8 key (no PRIVATE KEY block); a path goes in APP_STORE_CONNECT_API_KEY_PATH"
        fi
        bad=1
    fi
    return "$bad"
}

# The file to hand to `notarytool --key`: the .p8 itself when its path was given, otherwise
# the content written to <scratch file> (the caller made it with mktemp and removes it).
#
#   untether_notary_key_file <scratch file>
untether_notary_key_file() {
    local key_path="${APP_STORE_CONNECT_API_KEY_PATH:-}" key="${APP_STORE_CONNECT_API_KEY_P8:-}"
    if [[ -n "$key_path" ]]; then
        printf '%s\n' "${key_path/#\~/$HOME}"
    else
        printf '%s\n' "${key//\\n/$'\n'}" > "$1"
        printf '%s\n' "$1"
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
