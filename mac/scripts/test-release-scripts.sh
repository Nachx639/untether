#!/bin/bash
#
# Tests of the build and release scripts with doubles: no signing, no notarization, no
# release and no build happen here. `codesign`, `security`, `xcrun`, `xcodebuild`, `ditto`,
# `spctl`, `xattr` and `defaults` are stand-ins on PATH that write down how they were
# called; HOME is a temporary folder. release.sh runs whole in a toy checkout, with stand-ins
# for `git push`, `gh` and Apple's notary; the installers it builds there are real and unsigned.
#
# Usage: mac/scripts/test-release-scripts.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAC_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/untether-release-test.XXXXXX")"
WORK="$(cd "$WORK" && pwd)" # no "//" from a TMPDIR that ends in "/"
# 2026-11-12: the toy bundles here were named Untether.app (the release scripts take no other
# name), carried Untether's bundle identifier and stayed registered in LaunchServices; macOS
# opened one in place of the installed app and told the user "Untether is damaged". They now
# carry an identifier of their own (TOY_BUNDLE_ID), nothing is ever run from inside one, and
# however this ends (a cut run too) they leave LaunchServices before the folder is removed.
TOY_BUNDLE_ID="com.example.untether-test-toy"
leave_nothing() {
    untether_unregister_apps "$WORK" 2> /dev/null || true
    rm -rf "$WORK"
}
trap leave_nothing EXIT
trap 'exit 130' INT TERM

source "$SCRIPT_DIR/release-lib.sh"

FAILED=0
pass() { echo "ok   - $1"; }
fail() { echo "FAIL - $1"; FAILED=1; }
check() {
    local name="$1"
    shift
    if "$@"; then pass "$name"; else fail "$name"; fi
}
equals() { [[ "$1" == "$2" ]] || { echo "       expected '$2', got '$1'"; return 1; }; }

# --- doubles -----------------------------------------------------------------
BIN="$WORK/bin"
export CALLS="$WORK/calls.log"
export SERVER_RUNS="$WORK/server-runs.log"
mkdir -p "$BIN"
for tool in codesign xcrun ditto spctl xattr; do
    cat > "$BIN/$tool" <<DOUBLE
#!/bin/bash
echo "$tool \$*" >> "$CALLS"
exit 0
DOUBLE
done
cat > "$BIN/security" <<'DOUBLE'
#!/bin/bash
[[ -n "${FAKE_IDENTITIES:-}" ]] && printf '%s\n' "$FAKE_IDENTITIES"
exit 0
DOUBLE
cat > "$BIN/defaults" <<'DOUBLE'
#!/bin/bash
echo "com.example.untether-test"
DOUBLE
cat > "$BIN/xcodebuild" <<'DOUBLE'
#!/bin/bash
echo "xcodebuild $*" >> "$CALLS"
echo "    BUILT_PRODUCTS_DIR = ${FAKE_PRODUCTS_DIR:-/nowhere}"
DOUBLE
chmod +x "$BIN"/*

fake_app() {
    local app="$1"
    mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
    for file in MacOS/Untether Resources/untether Resources/untether-fwd Resources/helper-tool; do
        printf '#!/bin/sh\n' > "$app/Contents/$file"
        chmod +x "$app/Contents/$file"
    done
    printf '<plist/>' > "$app/Contents/Info.plist"
}

# A stand-in for a .p8 key: the shape the scripts ask for (a PRIVATE KEY block), no key in it.
# Put together here so that this file holds nothing a secret scanner takes for a key.
TOY_KEY="-----BEGIN $(printf 'PRIV%s' 'ATE') KEY-----
toy
-----END $(printf 'PRIV%s' 'ATE') KEY-----"
TOY_KEY_FILE="$WORK/AuthKey_TOY.p8"
printf '%s\n' "$TOY_KEY" > "$TOY_KEY_FILE"
check "stable from a beta version drops the suffix" \
    equals "$(untether_release_version stable "" 1.0.0-beta.18)" "1.0.0"
check "stable from a plain version stays" \
    equals "$(untether_release_version stable "" 1.2.3)" "1.2.3"
check "the next beta replaces the suffix" \
    equals "$(untether_release_version beta 19 1.0.0-beta.18)" "1.0.0-beta.19"
check "the same beta stays" \
    equals "$(untether_release_version beta 18 1.0.0-beta.18)" "1.0.0-beta.18"
check "rc after a beta" \
    equals "$(untether_release_version rc 1 1.0.0-beta.18)" "1.0.0-rc.1"
check "first alpha of a plain version" \
    equals "$(untether_release_version alpha 1 2.0.0)" "2.0.0-alpha.1"
check "release.sh takes its version from the function" \
    grep -q 'RELEASE_VERSION="$(untether_release_version ' "$SCRIPT_DIR/release.sh"
check "release.sh has no --resume or --status" \
    bash -c "! grep -qE -- '--resume|--status|release-state' '$SCRIPT_DIR/release.sh'"

# --- the branch a release is made from, and the notarization key -----------------
check "the release branch is the working repository's main line" \
    equals "$(untether_release_branch)" "untether"
check "no release script names the branch itself: they ask untether_release_branch" \
    bash -c "! grep -vE '^ *#' '$SCRIPT_DIR/release.sh' '$SCRIPT_DIR/preflight-check.sh' '$SCRIPT_DIR/release-checklist.sh' | grep -nE '(!=|==|=) *\"?main\"? *\]|origin/main|fetch origin'"
notary_check() { # VAR=value... : what untether_check_notary_key says with only those set
    env -u APP_STORE_CONNECT_API_KEY_P8 -u APP_STORE_CONNECT_API_KEY_PATH -u APP_STORE_CONNECT_KEY_ID \
        -u APP_STORE_CONNECT_ISSUER_ID "$@" bash -c "source '$SCRIPT_DIR/release-lib.sh'; untether_check_notary_key" 2>&1
}
check "notarization key: the content of the .p8 is taken" \
    equals "$(notary_check APP_STORE_CONNECT_KEY_ID=k APP_STORE_CONNECT_ISSUER_ID=i APP_STORE_CONNECT_API_KEY_P8="$TOY_KEY")" ""
check "notarization key: the path of the .p8 is taken" \
    equals "$(notary_check APP_STORE_CONNECT_KEY_ID=k APP_STORE_CONNECT_ISSUER_ID=i APP_STORE_CONNECT_API_KEY_PATH="$TOY_KEY_FILE")" ""
check "notarization key: a path in the content variable is named as such" \
    bash -c "grep -q 'APP_STORE_CONNECT_API_KEY_P8 holds a path' <<< \"\$1\"" _ \
    "$(notary_check APP_STORE_CONNECT_KEY_ID=k APP_STORE_CONNECT_ISSUER_ID=i APP_STORE_CONNECT_API_KEY_P8="$TOY_KEY_FILE")"
check "notarization key: a path that is not a file is refused" \
    bash -c "grep -q 'APP_STORE_CONNECT_API_KEY_PATH is not a readable file' <<< \"\$1\"" _ \
    "$(notary_check APP_STORE_CONNECT_KEY_ID=k APP_STORE_CONNECT_ISSUER_ID=i APP_STORE_CONNECT_API_KEY_PATH="$WORK/no-such.p8")"
check "notarization key: a file that is not a key is refused" \
    bash -c "grep -q 'is not a .p8 key' <<< \"\$1\"" _ \
    "$(notary_check APP_STORE_CONNECT_KEY_ID=k APP_STORE_CONNECT_ISSUER_ID=i APP_STORE_CONNECT_API_KEY_PATH="$MAC_DIR/Untether/version.xcconfig")"
check "notarization key: everything missing is named, one thing per line" \
    equals "$(notary_check | wc -l | tr -d ' ')" 3
check "notarization key: a path is handed to notarytool as it is" \
    equals "$(APP_STORE_CONNECT_API_KEY_PATH="$TOY_KEY_FILE" APP_STORE_CONNECT_API_KEY_P8=ignored untether_notary_key_file "$WORK/scratch.p8")" "$TOY_KEY_FILE"
check "... and nothing is written beside it" test ! -e "$WORK/scratch.p8"
KEY_FILE_GIVEN="$(env -u APP_STORE_CONNECT_API_KEY_PATH APP_STORE_CONNECT_API_KEY_P8='-----BEGIN X-----\ntoy\n-----END X-----' \
    bash -c "source '$SCRIPT_DIR/release-lib.sh'; untether_notary_key_file '$WORK/scratch.p8'")"
check "notarization key: content goes to the scratch file, \"\\n\" made line breaks" \
    bash -c "[[ '$KEY_FILE_GIVEN' == '$WORK/scratch.p8' ]] && [[ \$(wc -l < '$WORK/scratch.p8' | tr -d ' ') == 3 ]]"

check "version.sh leaves no backup copy beside version.xcconfig" \
    bash -c "! grep -vE '^ *#' '$SCRIPT_DIR/version.sh' | grep -nE 'xcconfig\.bak|cp .*version\.xcconfig'"

# --- only this checkout's DerivedData -----------------------------------------
DD="$WORK/home/Library/Developer/Xcode/DerivedData"
derived() { # <name> <workspace path>
    mkdir -p "$DD/$1"
    /usr/libexec/PlistBuddy -c "Add :WorkspacePath string $2" "$DD/$1/info.plist" >/dev/null
}
CHECKOUT="$(cd "$MAC_DIR/.." && pwd -P)"
derived Untether-own "$CHECKOUT/mac/Untether.xcodeproj"
derived Untether-ownworkspace "$CHECKOUT/Untether.xcworkspace"
derived Untether-other "/somewhere/else/untether/mac/Untether.xcodeproj"
derived Untether-sibling "$CHECKOUT-sibling/mac/Untether.xcodeproj"
mkdir -p "$DD/Untether-noplist"
check "own DerivedData: this checkout's project and workspace, nothing else" \
    equals "$(untether_own_derived_data "$MAC_DIR/.." "$DD" | sort | tr '\n' ' ')" \
    "$DD/Untether-own $DD/Untether-ownworkspace "
check "release.sh and clean.sh no longer remove every Untether-* DerivedData" \
    bash -c "! grep -nE 'rm -rf .*DerivedData/Untether-\*|DERIVED_DATA\"/Untether-\*' '$SCRIPT_DIR/release.sh' '$SCRIPT_DIR/clean.sh'"
CLEAN_OUT="$(HOME="$WORK/home" PATH="$BIN:$PATH" "$SCRIPT_DIR/clean.sh" --dry-run 2>&1)"
check "clean.sh --dry-run names this checkout's DerivedData" \
    bash -c "grep -q 'Xcode DerivedData for this checkout' <<< \"\$1\"" _ "$CLEAN_OUT"
check "clean.sh leaves the other checkouts' DerivedData" \
    bash -c "[[ \$(grep -c 'Xcode DerivedData' <<< \"\$1\") == 2 ]]" _ "$CLEAN_OUT"
check "clean.sh --dry-run removed nothing" test -d "$DD/Untether-own"

# --- the built app is this checkout's -----------------------------------------
check "built app path comes from xcodebuild's settings" \
    equals "$(cd "$MAC_DIR" && PATH="$BIN:$PATH" FAKE_PRODUCTS_DIR=/dd/Untether-own/Build/Products/Release untether_built_app_path Release)" \
    "/dd/Untether-own/Build/Products/Release/Untether.app"
check "build.sh and release.sh do not search all of DerivedData for an app" \
    bash -c "! grep -n 'find \"\$DEFAULT_DERIVED_DATA\"' '$SCRIPT_DIR/build.sh' '$SCRIPT_DIR/release.sh'"

# --- codesign-app.sh: identity that is not "Developer ID Application" ----------
APP="$WORK/sign/Untether.app"
fake_app "$APP"
: > "$CALLS"
SIGN_OUT="$(cd "$MAC_DIR" && env -u SIGN_IDENTITY PATH="$BIN:$PATH" HOME="$WORK/home" \
    FAKE_IDENTITIES='  1) 0123456789ABCDEF "Apple Development: Test Person (TEAM123456)"
     1 valid identities found' \
    "$SCRIPT_DIR/codesign-app.sh" "$APP" 2>&1)" && SIGN_STATUS=0 || SIGN_STATUS=$?
check "codesign-app.sh finds an identity that is not Developer ID" \
    bash -c "[[ $SIGN_STATUS == 0 ]] && grep -q 'Using signing identity: Apple Development: Test Person (TEAM123456)' <<< \"\$1\"" _ "$SIGN_OUT"
check "codesign-app.sh signs the server with its JIT entitlements" \
    grep -qE "codesign .*untether-binary\.entitlements .*Resources/untether$" "$CALLS"

# --- notarize-app.sh: no Frameworks folder, server keeps allow-jit -------------
APP="$WORK/notarize/Untether.app"
fake_app "$APP"
: > "$CALLS"
NOTARIZE_OUT="$(cd "$MAC_DIR" && PATH="$BIN:$PATH" HOME="$WORK/home" SIGN_IDENTITY="Test Identity" \
    APP_STORE_CONNECT_API_KEY_P8="$TOY_KEY" APP_STORE_CONNECT_KEY_ID=x APP_STORE_CONNECT_ISSUER_ID=x \
    "$SCRIPT_DIR/notarize-app.sh" "$APP" 2>&1)" && NOTARIZE_STATUS=0 || NOTARIZE_STATUS=$?
check "notarize-app.sh goes on without Contents/Frameworks" \
    bash -c "[[ $NOTARIZE_STATUS == 0 ]] && grep -q 'xcrun notarytool submit' '$CALLS'"
[[ "$NOTARIZE_STATUS" == 0 ]] || echo "$NOTARIZE_OUT" | tail -5
for server in untether untether-fwd; do
    check "notarize-app.sh signs $server with allow-jit" \
        bash -c "grep -E 'Resources/$server\$' '$CALLS' | grep -q 'untether-binary.entitlements'"
    check "notarize-app.sh never signs $server with the app's entitlements" \
        bash -c "! grep -E 'Resources/$server\$' '$CALLS' | grep -q 'main_entitlements'"
done
check "notarize-app.sh signs the other helpers with the app's entitlements" \
    bash -c "grep -E 'Resources/helper-tool\$' '$CALLS' | grep -q 'main_entitlements'"
# 2026-11-12: the key can be given as a path; the cleanup removes its own scratch file only.
: > "$CALLS"
(cd "$MAC_DIR" && env -u APP_STORE_CONNECT_API_KEY_P8 PATH="$BIN:$PATH" HOME="$WORK/home" SIGN_IDENTITY="Test Identity" \
    APP_STORE_CONNECT_API_KEY_PATH="$TOY_KEY_FILE" APP_STORE_CONNECT_KEY_ID=x APP_STORE_CONNECT_ISSUER_ID=x \
    "$SCRIPT_DIR/notarize-app.sh" "$APP" > /dev/null 2>&1) || true
check "notarize-app.sh hands notarytool the key file given as a path, and leaves it there" \
    bash -c "grep -q 'notarytool submit .*--key \"*$TOY_KEY_FILE' '$CALLS' && [[ -s '$TOY_KEY_FILE' ]]"
check "untether-binary.entitlements grants allow-jit" \
    bash -c "/usr/libexec/PlistBuddy -c 'Print :com.apple.security.cs.allow-jit' '$MAC_DIR/Untether/untether-binary.entitlements' | grep -q true"

# --- build-web-frontend.sh: pnpm's version is asked where web/package.json pins it ---
check "build-web-frontend.sh asks pnpm for its version from web/" \
    grep -q 'INSTALLED_PNPM_VERSION="$(cd "${WEB_DIR}" && pnpm --version)"' "$SCRIPT_DIR/build-web-frontend.sh"
check "web/package.json pins the pnpm the build asks for" \
    bash -c "grep -q \"\\\"packageManager\\\": \\\"pnpm@\$(sed -n 's/^REQUIRED_PNPM_VERSION=\\\"\\(.*\\)\\\"/\\1/p' '$SCRIPT_DIR/build-web-frontend.sh')+\" '$MAC_DIR/../web/package.json'"

check "preflight-check.sh asks pnpm for its version from web/ too" \
    grep -q 'INSTALLED_PNPM_VERSION=$(cd "$PROJECT_ROOT/../web" && pnpm --version)' "$SCRIPT_DIR/preflight-check.sh"

# --- the app's build writes nothing a running server loads (2026-11-12) -----------
# The cases of the dependencies, with stand-ins for node (deps-in-sync.js) and pnpm, in a
# folder that stands for web/.
DEPS_BIN="$WORK/deps-bin"
DEPS_WEB="$WORK/deps-web"
mkdir -p "$DEPS_BIN" "$DEPS_WEB"
cat > "$DEPS_BIN/node" <<'DOUBLE'
#!/bin/bash
echo "node $*" >> "$CALLS"
if [[ -n "${FAKE_OUT_OF_SYNC:-}" ]]; then echo "$FAKE_OUT_OF_SYNC"; exit 1; fi
echo "node_modules is what the lockfile asks for"
DOUBLE
cat > "$DEPS_BIN/pnpm" <<'DOUBLE'
#!/bin/bash
echo "pnpm $*" >> "$CALLS"
DOUBLE
chmod +x "$DEPS_BIN"/*
web_deps() {
    : > "$CALLS"
    DEPS_STATUS=0
    # PATH is set inside: zsh's startup files put the user's own node first.
    DEPS_OUT="$(cd "$DEPS_WEB" && env -u UNTETHER_BUILD_OWNS_CHECKOUT "$@" zsh -c "PATH='$DEPS_BIN':\$PATH; source '$SCRIPT_DIR/custom-node-policy.sh'; untether_prepare_web_deps" 2>&1)" || DEPS_STATUS=$?
}
web_deps FAKE_OUT_OF_SYNC="node_modules holds no install (no .pnpm/lock.yaml)"
check "dependencies: not even a checkout without node_modules is installed where the build was started" \
    bash -c "[[ $DEPS_STATUS != 0 ]] && ! grep -q '^pnpm' '$CALLS'"
mkdir "$DEPS_WEB/node_modules"
web_deps
check "dependencies in sync: nothing is installed" \
    bash -c "[[ $DEPS_STATUS == 0 ]] && ! grep -q '^pnpm' '$CALLS' && grep -q 'pnpm install skipped' <<< \"\$1\"" _ "$DEPS_OUT"
web_deps FAKE_OUT_OF_SYNC="pnpm-lock.yaml changed since the last install"
check "dependencies out of sync in a checkout that is not the build's own: the build stops and installs nothing" \
    bash -c "[[ $DEPS_STATUS != 0 ]] && ! grep -q '^pnpm' '$CALLS'"
check "... and says why and what to do" \
    bash -c "grep -q 'pnpm-lock.yaml changed since the last install' <<< \"\$1\" && grep -q 'installs nothing in a checkout that is not its own' <<< \"\$1\" && grep -q 'yourself, with the server stopped' <<< \"\$1\" && grep -q 'UNTETHER_BUILD_OWNS_CHECKOUT=1' <<< \"\$1\"" _ "$DEPS_OUT"
web_deps FAKE_OUT_OF_SYNC="pnpm-lock.yaml changed since the last install" UNTETHER_BUILD_OWNS_CHECKOUT=0
check "... whatever is in the variable, unless it says yes" \
    bash -c "[[ $DEPS_STATUS != 0 ]] && ! grep -q '^pnpm' '$CALLS'"
web_deps FAKE_OUT_OF_SYNC="pnpm-lock.yaml changed since the last install" UNTETHER_BUILD_OWNS_CHECKOUT=1
check "dependencies out of sync in the build's own checkout: pnpm install --frozen-lockfile" \
    bash -c "[[ $DEPS_STATUS == 0 ]] && grep -q -x 'pnpm install --frozen-lockfile' '$CALLS'"
check "the build looks at no process to decide: it does not guess what runs from a tree" \
    bash -c "! grep -nE '\\b(ps|lsof|pgrep)\\b' '$SCRIPT_DIR/custom-node-policy.sh' '$MAC_DIR/../web/scripts/deps-in-sync.js' | grep -v '^[^:]*:[0-9]*: *[#*/]' | grep -q ."
check "the installed app's updater, which builds in a worktree of its own, says so" \
    grep -q "UNTETHER_BUILD_OWNS_CHECKOUT=1 ./scripts/build.sh" "$MAC_DIR/../web/src/server/server-app-update.ts"
check "release.sh does not declare the checkout it runs in the build's own" \
    bash -c "! grep -q 'UNTETHER_BUILD_OWNS_CHECKOUT' '$SCRIPT_DIR/release.sh' '$SCRIPT_DIR/build.sh' '$SCRIPT_DIR/build-web-frontend.sh'"
check "build-web-frontend.sh installs through that function only, and compiles nothing in node_modules" \
    bash -c "grep -q '^untether_prepare_web_deps ' '$SCRIPT_DIR/build-web-frontend.sh' && ! grep -nE '^ *pnpm install|ensure-native-modules|(npm|pnpm) rebuild' '$SCRIPT_DIR/build-web-frontend.sh'"
check "build-native.js builds the bundle's native modules out of node_modules, never in it" \
    bash -c "grep -q \"buildNativeAddonIsolated('authenticate-pam'\" '$MAC_DIR/../web/build-native.js' && ! grep -nE 'buildNodePty|buildAuthenticatePam|(npm|pnpm) rebuild|node_modules/(node-pty|authenticate-pam)/build' '$MAC_DIR/../web/build-native.js'"
check "build-native.js opens the modules with the Node it embeds before packing them" \
    grep -q 'assertAddonsLoad(nodeExe' "$MAC_DIR/../web/build-native.js"

# --- i18n-sync.sh: its build needs no signing team ------------------------------
: > "$CALLS"
PATH="$BIN:$PATH" HOME="$WORK/home" "$SCRIPT_DIR/i18n-sync.sh" >/dev/null 2>&1 || true # stops at "no Debug build found"
check "i18n-sync.sh builds with CODE_SIGNING_ALLOWED=NO" \
    grep -qE "^xcodebuild .* build .*CODE_SIGNING_ALLOWED=NO" "$CALLS"

# --- the installer: Untether.app in /Applications and nothing else ---------------
# A bundle Installer takes for an app: a real Info.plist and a real binary.
toy_app() {
    local app="$1" version="$2" build="$3"
    mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources/web/public"
    cp /usr/bin/true "$app/Contents/MacOS/Untether"
    for file in untether-fwd pty.node authenticate_pam.node spawn-helper web/public/ghostty-vt.wasm; do
        printf 'toy\n' > "$app/Contents/Resources/$file"
    done
    # The server's stand-in: `check-native` answers as the real one, or as FAKE_NATIVE says,
    # and writes down where it was run from (never from inside a bundle).
    cat > "$app/Contents/Resources/untether" <<'SERVER'
#!/bin/bash
echo "untether $* (run from $(cd "$(dirname "$0")" && pwd))" >> "${SERVER_RUNS:-/dev/null}"
[[ "$1" == "check-native" ]] || exit 0
if [[ -n "${FAKE_NATIVE:-}" ]]; then
    echo "ok pty.node: loads"
    echo "FAILED authenticate_pam.node: $FAKE_NATIVE"
    exit 1
fi
echo "ok pty.node: loads"
echo "ok authenticate_pam.node: loads"
echo "ok spawn-helper: executable"
SERVER
    chmod +x "$app/Contents/Resources/untether"
    cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>$TOY_BUNDLE_ID</string>
<key>CFBundleExecutable</key><string>Untether</string>
<key>CFBundleShortVersionString</key><string>$version</string>
<key>CFBundleVersion</key><string>$build</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
PLIST
}
PKG_DIR="$WORK/pkg"
toy_app "$PKG_DIR/Untether.app" 1.0.0 300
PKG_OUT="$("$SCRIPT_DIR/create-pkg.sh" --app "$PKG_DIR/Untether.app" --version 1.0.0 --output "$PKG_DIR/Untether-1.0.0.pkg" 2>&1)" || true
check "create-pkg.sh builds an installer and says it is unsigned" \
    bash -c "[[ -f '$PKG_DIR/Untether-1.0.0.pkg' ]] && grep -q 'UNSIGNED' <<< \"\$1\"" _ "$PKG_OUT"
check "the installer is what a release ships (untether_check_pkg)" \
    equals "$(untether_check_pkg "$PKG_DIR/Untether-1.0.0.pkg" 2>&1)" ""
pkgutil --expand "$PKG_DIR/Untether-1.0.0.pkg" "$PKG_DIR/expanded"
check "the installer puts the app in /Applications: not relocatable, not version-checked" \
    bash -c "grep -q 'install-location=\"/Applications\"' \"\$1\" && grep -q '<relocate/>' \"\$1\" && grep -q '<bundle-version/>' \"\$1\"" _ "$PKG_DIR/expanded/Untether-component.pkg/PackageInfo"
check "the installer carries no script" \
    bash -c "! find '$PKG_DIR/expanded' -name Scripts -o -name postinstall -o -name preinstall | grep -q ."
check "the installer is for Apple Silicon and macOS 14 or later" \
    bash -c "grep -q 'hostArchitectures=\"arm64\"' '$PKG_DIR/expanded/Distribution' && grep -q 'os-version min=\"14.0\"' '$PKG_DIR/expanded/Distribution'"
check "the installer's payload is the app" \
    bash -c "pkgutil --payload-files '$PKG_DIR/Untether-1.0.0.pkg' | grep -q -x './Untether.app/Contents/MacOS/Untether'"
# The same app packaged the way pkgbuild does by default, plus a postinstall script.
mkdir -p "$PKG_DIR/root" "$PKG_DIR/scripts"
ditto "$PKG_DIR/Untether.app" "$PKG_DIR/root/Untether.app"
printf '#!/bin/sh\nexit 0\n' > "$PKG_DIR/scripts/postinstall"
chmod +x "$PKG_DIR/scripts/postinstall"
pkgbuild --root "$PKG_DIR/root" --scripts "$PKG_DIR/scripts" --identifier com.example.bad --version 1.0.0 \
    --install-location /Applications "$PKG_DIR/bad.pkg" > /dev/null 2>&1
check "untether_check_pkg refuses what pkgbuild makes by default (version-checked)" \
    equals "$(untether_check_pkg "$PKG_DIR/bad.pkg" 2>&1)" "it is version-checked: over a newer copy Installer would install nothing"
printf '<plist version="1.0"><array><dict><key>BundleIsRelocatable</key><false/><key>BundleIsVersionChecked</key><false/><key>RootRelativeBundlePath</key><string>Untether.app</string></dict></array></plist>' > "$PKG_DIR/stays.plist"
pkgbuild --root "$PKG_DIR/root" --component-plist "$PKG_DIR/stays.plist" --scripts "$PKG_DIR/scripts" --identifier com.example.scripts \
    --version 1.0.0 --install-location /Applications "$PKG_DIR/scripts.pkg" > /dev/null 2>&1
check "untether_check_pkg refuses an installer with scripts" \
    equals "$(untether_check_pkg "$PKG_DIR/scripts.pkg" 2>&1)" "it carries install scripts"
printf '<plist version="1.0"><array><dict><key>BundleIsRelocatable</key><true/><key>BundleIsVersionChecked</key><false/><key>RootRelativeBundlePath</key><string>Untether.app</string></dict></array></plist>' > "$PKG_DIR/relocatable.plist"
pkgbuild --root "$PKG_DIR/root" --component-plist "$PKG_DIR/relocatable.plist" --identifier com.example.moves --version 1.0.0 \
    --install-location /Applications "$PKG_DIR/moves.pkg" > /dev/null 2>&1
check "untether_check_pkg refuses a relocatable installer" \
    equals "$(untether_check_pkg "$PKG_DIR/moves.pkg" 2>&1)" "it is relocatable: Installer would put the app wherever another copy is"
pkgbuild --root "$PKG_DIR/root" --component-plist "$PKG_DIR/stays.plist" --identifier com.example.elsewhere --version 1.0.0 \
    --install-location /Library/Untether "$PKG_DIR/elsewhere.pkg" > /dev/null 2>&1
check "untether_check_pkg refuses an installer for another folder" \
    equals "$(untether_check_pkg "$PKG_DIR/elsewhere.pkg" 2>&1)" "it does not install in /Applications"
check "create-pkg.sh refuses a bundle that is not Untether.app" \
    bash -c "! '$SCRIPT_DIR/create-pkg.sh' --app '$PKG_DIR/root' --version 1.0.0 --output '$PKG_DIR/no.pkg' 2> /dev/null"

# --- release.sh, whole, in a toy checkout ---------------------------------------
# A repository with the real release.sh, create-pkg.sh, notarize-pkg.sh and release-lib.sh,
# and stand-ins for what builds, signs, exports and talks to GitHub or Apple: `git push` is
# written down and not run, `gh` answers from FAKE_* variables.
TOY="$WORK/toy"
RBIN="$WORK/release-bin"
REAL_GIT="$(command -v git)"
mkdir -p "$TOY/mac/Untether" "$TOY/web" "$TOY/scripts" "$RBIN"
cp -R "$SCRIPT_DIR" "$TOY/mac/scripts"
printf 'MARKETING_VERSION = 1.0.0\nCURRENT_PROJECT_VERSION = 300\n' > "$TOY/mac/Untether/version.xcconfig"
printf '{\n  "version": "1.0.0",\n  "homepage": "https://github.com/toy-owner/toy"\n}\n' > "$TOY/web/package.json"
printf '# Changelog\n\n## [1.0.0] - 2026-11-12\n\n### Changed\n\n- A toy change.\n' > "$TOY/CHANGELOG.md"
printf 'mac/build/\nweb/native/\n' > "$TOY/.gitignore"
toy_app "$WORK/toy-built/Untether.app" 1.0.0 300
cat > "$TOY/mac/scripts/build.sh" <<DOUBLE
#!/bin/bash
echo "build.sh \$*" >> "\$CALLS"
mkdir -p "$TOY/mac/build/Build/Products/Release" "$TOY/web/native"
ditto "$WORK/toy-built/Untether.app" "$TOY/mac/build/Build/Products/Release/Untether.app"
echo '{"schemaVersion":1,"customNode":true,"nodeVersion":"v0","arch":"arm64"}' > "$TOY/web/native/untether-build.json"
DOUBLE
cat > "$TOY/mac/scripts/preflight-check.sh" <<'DOUBLE'
#!/bin/bash
echo "preflight-check.sh" >> "$CALLS"
DOUBLE
cat > "$TOY/mac/scripts/sign-and-notarize.sh" <<'DOUBLE'
#!/bin/bash
echo "sign-and-notarize.sh $*" >> "$CALLS"
DOUBLE
cat > "$TOY/scripts/public-export.sh" <<'DOUBLE'
#!/bin/bash
echo "public-export.sh $*" >> "$CALLS"
dest="${!#}"
# As the real one: never inside the repository it exports.
case "$dest/" in
    "$(cd "$(dirname "$0")/.." && pwd)"/*) echo "public-export: the destination must be outside the repository" >&2; exit 2 ;;
esac
[[ -d "$dest/.git" ]] || git init --quiet --initial-branch=main "$dest"
git -C "$dest" -c user.name=toy -c user.email=contributors@untether.invalid commit --quiet --allow-empty -m "Untether copy"
DOUBLE
cat > "$TOY/scripts/public-repo-rules.sh" <<'DOUBLE'
#!/bin/bash
echo "public-repo-rules: ${FAKE_RULES:-in place}"
[[ -z "${FAKE_RULES:-}" ]]
DOUBLE
chmod +x "$TOY/mac/scripts/"*.sh "$TOY/scripts/"*.sh
cat > "$RBIN/git" <<DOUBLE
#!/bin/bash
case " \$* " in
    *" push "*) echo "git \$*" >> "\$CALLS"; exit 0 ;;
    *" tag "* | *" fetch "* | *" clone "*) echo "git \$*" >> "\$CALLS" ;;
esac
exec "$REAL_GIT" "\$@"
DOUBLE
cat > "$RBIN/gh" <<DOUBLE
#!/bin/bash
echo "gh \$*" >> "\$CALLS"
case "\$1 \$2" in
    "auth status") exit 0 ;;
    "repo view") echo "\${FAKE_VISIBILITY:-PUBLIC} true" ;;
    "api repos/toy-owner/toy/git/ref/tags/"*)
        [[ -n "\${FAKE_TAG_EXISTS:-}" ]] && exit 0
        echo "gh: Not Found (HTTP 404)" >&2
        exit 1
        ;;
    "api repos/toy-owner/toy/commits/main") "$REAL_GIT" -C "\$(sed -n 's/^public-export.sh //p' "\$CALLS" | tail -1)" rev-parse HEAD ;;
    "release create") exit 0 ;;
    *) echo "gh double: unexpected call: \$*" >&2; exit 1 ;;
esac
DOUBLE
cat > "$RBIN/security" <<'DOUBLE'
#!/bin/bash
[[ -n "${FAKE_IDENTITIES:-}" ]] && printf '%s\n' "$FAKE_IDENTITIES"
exit 0
DOUBLE
cat > "$RBIN/xcrun" <<'DOUBLE'
#!/bin/bash
echo "xcrun $*" >> "$CALLS"
[[ "$1 $2" == "notarytool submit" ]] && echo "  status: ${FAKE_NOTARY_STATUS:-Accepted}"
exit 0
DOUBLE
cat > "$RBIN/spctl" <<'DOUBLE'
#!/bin/bash
echo "accepted"
echo "source=Notarized Developer ID"
DOUBLE
# Signing needs a certificate: the stand-in builds the same package without one.
cat > "$RBIN/productbuild" <<DOUBLE
#!/bin/bash
echo "productbuild \$*" >> "\$CALLS"
args=()
while [[ \$# -gt 0 ]]; do
    case "\$1" in
        --sign) shift 2 ;;
        --timestamp) shift ;;
        *) args+=("\$1"); shift ;;
    esac
done
exec "$(command -v productbuild)" "\${args[@]}"
DOUBLE
cat > "$RBIN/pkgutil" <<DOUBLE
#!/bin/bash
if [[ "\$1" == "--check-signature" ]]; then
    echo "   1. Developer ID Installer: Toy Person (TEAM123456)"
    exit 0
fi
exec "$(command -v pkgutil)" "\$@"
DOUBLE
chmod +x "$RBIN"/*
# The working repository's main line is not "main" (that is the public copy's branch).
"$REAL_GIT" -C "$TOY" init --quiet --initial-branch="$(untether_release_branch)"
"$REAL_GIT" -C "$TOY" add -A
"$REAL_GIT" -C "$TOY" -c user.name=toy -c user.email=toy@example.invalid commit --quiet -m "toy checkout"

TOY_IDENTITIES='  1) 0123456789ABCDEF "Developer ID Application: Toy Person (TEAM123456)"
  2) 0123456789ABCDE0 "Developer ID Installer: Toy Person (TEAM123456)"
     2 valid identities found'
# release.sh in the toy: FAKE_* and other variables first, then its arguments.
toy_release() {
    local vars=()
    while [[ "${1:-}" == *=* ]]; do
        vars+=("$1")
        shift
    done
    : > "$CALLS"
    RELEASE_STATUS=0
    RELEASE_OUT="$(cd "$TOY" && env -u CI -u GITHUB_ACTIONS -u UNTETHER_TASK_ID -u GIT_EXEC_PATH -u GIT_INDEX_FILE \
        -u GIT_DIR -u GIT_WORK_TREE -u SIGN_IDENTITY \
        PATH="$RBIN:$PATH" HOME="$WORK/home" TMPDIR="$WORK/tmp" GIT_CONFIG_GLOBAL=/dev/null FAKE_IDENTITIES="$TOY_IDENTITIES" \
        APP_STORE_CONNECT_API_KEY_P8="$TOY_KEY" APP_STORE_CONNECT_KEY_ID=x APP_STORE_CONNECT_ISSUER_ID=x \
        ${vars[@]+"${vars[@]}"} "$TOY/mac/scripts/release.sh" "$@" 2>&1)" || RELEASE_STATUS=$?
}
# Nothing left this Mac: no push, no tag, no release, no notarization.
nothing_published() {
    ! grep -qE '^git .*( push | tag )|^gh release|notarytool' "$CALLS"
}
line_of() { grep -n -m1 -E "$1" "$CALLS" | cut -d: -f1; }
# Where the last run put the clean copy.
toy_copy() { sed -n 's/^public-export.sh //p' "$CALLS" | tail -1; }
mkdir -p "$WORK/tmp"
TOY_PKG="$TOY/mac/build/release/Untether-1.0.0.pkg"

toy_release --dry-run stable
check "dry run: ends well and says nothing would stop a real run" \
    bash -c "[[ $RELEASE_STATUS == 0 ]] && grep -q 'Nothing would stop a real run' <<< \"\$1\"" _ "$RELEASE_OUT"
[[ "$RELEASE_STATUS" == 0 ]] || echo "$RELEASE_OUT" | tail -15
check "dry run: no push, no tag, no release, no notarization" nothing_published
check "dry run: builds, signs without notarizing, and builds the installer" \
    bash -c "grep -q '^build.sh ' '$CALLS' && grep -q '^sign-and-notarize.sh --sign-only --no-zip' '$CALLS' && [[ -f '$TOY_PKG' ]]"
check "dry run: makes the clean copy" test -d "$(toy_copy)/.git"
# 2026-11-12: the copy was put in mac/build/release/public and the exporter refuses that.
check "the clean copy is made outside the repository" \
    bash -c "[[ -n \"\$1\" && \"\$1/\" != '$TOY'/* && \"\$(cd \"\$1\" && pwd -P)/\" != \"\$(cd '$TOY' && pwd -P)\"/* ]]" _ "$(toy_copy)"
check "dry run: says what a real run would do" \
    bash -c "grep -q 'gh release create v1.0.0 --repo toy-owner/toy --verify-tag' <<< \"\$1\" && grep -q 'push origin refs/tags/v1.0.0' <<< \"\$1\"" _ "$RELEASE_OUT"
check "dry run: tells how to publish, with the tag written out" \
    bash -c "grep -q 'release.sh stable --confirm v1.0.0' <<< \"\$1\"" _ "$RELEASE_OUT"

check "dry run: says it is on the working repository's main line" \
    bash -c "grep -q 'on untether, the working repository' <<< \"\$1\"" _ "$RELEASE_OUT"

toy_release APP_STORE_CONNECT_API_KEY_P8= APP_STORE_CONNECT_API_KEY_PATH="$TOY_KEY_FILE" --dry-run stable
check "dry run: the notarization key can be the path of the .p8" \
    bash -c "[[ $RELEASE_STATUS == 0 ]] && grep -q 'Nothing would stop a real run' <<< \"\$1\"" _ "$RELEASE_OUT"
toy_release APP_STORE_CONNECT_API_KEY_P8="$TOY_KEY_FILE" --dry-run stable
check "dry run: a path in APP_STORE_CONNECT_API_KEY_P8 would stop a real run, and it says why" \
    bash -c "grep -q 'APP_STORE_CONNECT_API_KEY_P8 holds a path' <<< \"\$1\"" _ "$RELEASE_OUT"

toy_release FAKE_VISIBILITY=PRIVATE FAKE_RULES="not protected yet" FAKE_IDENTITIES= APP_STORE_CONNECT_KEY_ID= --dry-run beta 2
check "dry run: lists everything that would stop a real run, and still ends well" \
    bash -c "[[ $RELEASE_STATUS == 0 ]] && grep -q 'A real run would stop: 8 thing' <<< \"\$1\"" _ "$RELEASE_OUT"
for blocker in "the committed version is not 1.0.0-beta.2" "CHANGELOG.md has no closed section" "toy-owner/toy is PRIVATE" "rulesets are not in place" \
    'no "Developer ID Application" certificate' 'no "Developer ID Installer" certificate' "no notarization key" "the built app says version 1.0.0, not 1.0.0-beta.2"; do
    check "dry run names: $blocker" bash -c "grep -q -- \"\$2\" <<< \"\$1\"" _ "$RELEASE_OUT" "$blocker"
done
[[ "$RELEASE_STATUS" == 0 ]] && grep -q 'A real run would stop: 8 thing' <<< "$RELEASE_OUT" || echo "$RELEASE_OUT" | tail -25
check "dry run with what would stop it: nothing published either" nothing_published
check "dry run without certificates: the installer is marked unsigned" \
    bash -c "grep -q 'UNSIGNED' <<< \"\$1\"" _ "$RELEASE_OUT"

toy_app "$WORK/given/Untether.app" 0.9.0 1
toy_release --dry-run --app "$WORK/given/Untether.app" stable
check "dry run --app: packages the bundle given, builds and signs nothing" \
    bash -c "[[ $RELEASE_STATUS == 0 ]] && ! grep -qE '^(build|sign-and-notarize).sh' '$CALLS' && grep -q 'not building' <<< \"\$1\"" _ "$RELEASE_OUT"
# A path relative to where the person stands (the run starts in the toy's root, the script works in mac/).
mkdir -p "$TOY/mac/build" && ditto "$WORK/given/Untether.app" "$TOY/mac/build/Given/Untether.app"
toy_release --dry-run --app mac/build/Given/Untether.app stable
check "dry run --app takes a path relative to where it was started" \
    bash -c "[[ $RELEASE_STATUS == 0 ]] && grep -q 'packaging a copy of $TOY/mac/build/Given/Untether.app' <<< \"\$1\"" _ "$RELEASE_OUT"
toy_release --app "$WORK/given/Untether.app" stable --confirm v1.0.0
check "--app is refused outside a dry run" \
    bash -c "[[ $RELEASE_STATUS == 2 ]] && grep -q 'dry-run only' <<< \"\$1\" && [[ ! -s '$CALLS' ]]" _ "$RELEASE_OUT"

toy_release stable
check "a real run without --confirm publishes nothing and builds nothing" \
    bash -c "[[ $RELEASE_STATUS == 1 ]] && grep -q 'there is no --confirm' <<< \"\$1\" && [[ ! -s '$CALLS' ]]" _ "$RELEASE_OUT"
toy_release stable --confirm v1.0.1
check "a real run with another tag in --confirm publishes nothing" \
    bash -c "[[ $RELEASE_STATUS == 1 ]] && grep -q 'would publish v1.0.0 and --confirm says v1.0.1' <<< \"\$1\" && [[ ! -s '$CALLS' ]]" _ "$RELEASE_OUT"
for automation in CI=true GITHUB_ACTIONS=true UNTETHER_TASK_ID=abc GIT_EXEC_PATH=/usr/libexec/git-core GIT_INDEX_FILE=.git/index; do
    toy_release "$automation" stable --confirm v1.0.0
    check "a real run started by automation (${automation%%=*}) publishes nothing" \
        bash -c "[[ $RELEASE_STATUS == 1 ]] && grep -q 'Not publishing: ' <<< \"\$1\" && [[ ! -s '$CALLS' ]]" _ "$RELEASE_OUT"
done
toy_release FAKE_TAG_EXISTS=1 stable --confirm v1.0.0
check "a real run stops when the tag is already public, before building" \
    bash -c "[[ $RELEASE_STATUS == 1 ]] && grep -q 'tag v1.0.0 already exists' <<< \"\$1\" && ! grep -q '^build.sh' '$CALLS'" _ "$RELEASE_OUT"
check "... and publishes nothing" nothing_published
toy_release FAKE_VISIBILITY=PRIVATE stable --confirm v1.0.0
check "a real run stops when the public repository is not public" \
    bash -c "[[ $RELEASE_STATUS == 1 ]] && grep -q 'toy-owner/toy is PRIVATE' <<< \"\$1\" && ! grep -q '^build.sh' '$CALLS'" _ "$RELEASE_OUT"
toy_release FAKE_IDENTITIES='  1) 0123456789ABCDEF "Developer ID Application: Toy Person (TEAM123456)"' stable --confirm v1.0.0
check "a real run stops without the Developer ID Installer certificate" \
    bash -c "[[ $RELEASE_STATUS == 1 ]] && grep -q 'no \"Developer ID Installer\" certificate' <<< \"\$1\" && ! grep -q '^build.sh' '$CALLS'" _ "$RELEASE_OUT"

# 2026-11-12: release.sh asked for "main", which the working repository does not have.
"$REAL_GIT" -C "$TOY" checkout --quiet -b main
toy_release stable --confirm v1.0.0
check "a real run stops on a branch that is not the working repository's main line, before building" \
    bash -c "[[ $RELEASE_STATUS == 1 ]] && grep -q 'not on untether (on main)' <<< \"\$1\" && ! grep -q '^build.sh' '$CALLS'" _ "$RELEASE_OUT"
"$REAL_GIT" -C "$TOY" checkout --quiet "$(untether_release_branch)"
"$REAL_GIT" -C "$TOY" branch --quiet -D main

toy_release APP_STORE_CONNECT_API_KEY_P8= APP_STORE_CONNECT_API_KEY_PATH="$TOY_KEY_FILE" stable --confirm v1.0.0
check "a real run with the key given as a path notarizes with that file, and leaves it there" \
    bash -c "[[ $RELEASE_STATUS == 0 ]] && grep -q 'notarytool submit .*--key $TOY_KEY_FILE ' '$CALLS' && [[ -s '$TOY_KEY_FILE' ]]"
[[ "$RELEASE_STATUS" == 0 ]] || echo "$RELEASE_OUT" | tail -15

toy_release FAKE_NOTARY_STATUS=Invalid stable --confirm v1.0.0
check "a real run whose installer Apple does not notarize publishes nothing" \
    bash -c "[[ $RELEASE_STATUS != 0 ]] && grep -q 'notarytool submit' '$CALLS' && ! grep -qE '^git .*( push | tag )|^gh release|^public-export' '$CALLS'"

# 2026-11-12: a module built for another Node than the embedded one must stop the release
# before anything is signed.
toy_release FAKE_NATIVE="was compiled against a different Node.js version using NODE_MODULE_VERSION 147. This version of Node.js requires NODE_MODULE_VERSION 137." stable --confirm v1.0.0
check "a real run whose native module does not load with the embedded Node stops before signing" \
    bash -c "[[ $RELEASE_STATUS != 0 ]] && grep -q '^build.sh ' '$CALLS' && ! grep -qE '^sign-and-notarize|notarytool|^public-export|^git .*( push | tag )|^gh release' '$CALLS'"
check "... and says which module and why" \
    bash -c "grep -q 'FAILED authenticate_pam.node: .*NODE_MODULE_VERSION 147' <<< \"\$1\"" _ "$RELEASE_OUT"
NATIVE_APP="$WORK/native-check/Untether.app"
toy_app "$NATIVE_APP" 1.0.0 300
check "untether_check_native_modules accepts an app whose server loads its modules" \
    bash -c "source '$SCRIPT_DIR/release-lib.sh'; [[ -z \"\$(untether_check_native_modules '$NATIVE_APP')\" ]]"
rm "$NATIVE_APP/Contents/Resources/authenticate_pam.node"
check "untether_check_native_modules refuses an app without authenticate_pam.node" \
    bash -c "source '$SCRIPT_DIR/release-lib.sh'; ! untether_check_native_modules '$NATIVE_APP' | grep -v 'authenticate_pam.node is not in the app' | grep -q . && ! untether_check_native_modules '$NATIVE_APP' >/dev/null"
toy_app "$NATIVE_APP" 1.0.0 300
printf '#!/bin/bash\necho "ok pty.node: loads"\n' > "$NATIVE_APP/Contents/Resources/untether"
check "untether_check_native_modules refuses a server that does not vouch for every module" \
    bash -c "source '$SCRIPT_DIR/release-lib.sh'; ! untether_check_native_modules '$NATIVE_APP' >/dev/null"

# --- nothing of a test or a build stays in LaunchServices as Untether -------------
check "no toy bundle carries Untether's bundle identifier" \
    bash -c "! grep -rl --include=Info.plist 'com.nachx639.untether' '$WORK' | grep -q ."
check "the server's stand-in was never run from inside an app bundle" \
    bash -c "grep -q '^untether check-native' '$WORK/server-runs.log' && ! grep -E '^untether .*\.app(/|\))' '$WORK/server-runs.log' | grep -q ."
LS_CALLS="$WORK/lsregister.log"
printf '#!/bin/bash\necho "lsregister $*" >> "%s"\n' "$LS_CALLS" > "$WORK/lsregister-double"
chmod +x "$WORK/lsregister-double"
mkdir -p "$WORK/ls/build/Products/Untether.app/Contents/Frameworks/Inner.app" "$WORK/ls/other dir/Toy.app" "$WORK/ls/not-an-app"
UNTETHER_LSREGISTER="$WORK/lsregister-double" untether_unregister_apps "$WORK/ls" "$WORK/ls/missing"
check "untether_unregister_apps unregisters every bundle under a folder, outermost only" \
    equals "$(sort "$LS_CALLS")" "$(printf 'lsregister -u %s\nlsregister -u %s' "$WORK/ls/build/Products/Untether.app" "$WORK/ls/other dir/Toy.app")"
check "build.sh and release.sh unregister their build products however they end" \
    bash -c "grep -q '^trap unregister_build_products EXIT' '$SCRIPT_DIR/build.sh' && grep -q '^trap leave_no_app_behind EXIT' '$SCRIPT_DIR/release.sh'"
: > "$LS_CALLS"
toy_release UNTETHER_LSREGISTER="$WORK/lsregister-double" --dry-run --app "$WORK/given/Untether.app" stable
check "dry run --app: its copy of the bundle is unregistered and removed when it ends" \
    bash -c "[[ $RELEASE_STATUS == 0 ]] && grep -q 'lsregister -u .*/untether-release-dry\.[^/]*/app/Untether.app' '$LS_CALLS' && ! find '$WORK/tmp' -path '*untether-release-dry.*' -name '*.app' | grep -q ."
check "... and the build folder's products are unregistered too" \
    grep -q "lsregister -u $TOY/mac/build/" "$LS_CALLS"
check "no script runs anything from inside an app bundle before it is signed" \
    bash -c "! grep -nE 'APP_(RESOURCES|PATH)[^ ]*/untether. (version|check-native)' '$SCRIPT_DIR/build-web-frontend.sh' '$SCRIPT_DIR/release.sh' '$SCRIPT_DIR/release-lib.sh' '$SCRIPT_DIR/build.sh'"

toy_release stable --confirm v1.0.0
check "a real run with everything in place ends well" equals "$RELEASE_STATUS" 0
[[ "$RELEASE_STATUS" == 0 ]] || echo "$RELEASE_OUT" | tail -15
check "a real run signs the installer with the Developer ID Installer identity" \
    grep -q '^productbuild .*--sign Developer ID Installer: Toy Person (TEAM123456) --timestamp' "$CALLS"
ORDER="$(line_of '^sign-and-notarize.sh --sign-and-notarize --no-zip') $(line_of 'notarytool submit .*Untether-1.0.0.pkg') \
$(line_of '^public-export.sh ') $(line_of '^git -C .*/copy push origin main$') $(line_of '^git -C .*/copy tag v1.0.0 [0-9a-f]{40}$') \
$(line_of '^git -C .*/copy push origin refs/tags/v1.0.0$') $(line_of '^gh release create v1.0.0 --repo toy-owner/toy --verify-tag ')"
check "a real run: notarize, then export, push the copy, tag it, create the release (in that order)" \
    equals "$ORDER" "$(tr ' ' '\n' <<< "$ORDER" | sort -n | tr '\n' ' ' | sed 's/ $//')"
check "... and every one of those steps happened" equals "$(wc -w <<< "$ORDER" | tr -d ' ')" 7
check "a real run pushes from the clean copy only, to its origin" \
    bash -c "! grep -E '^git .* push ' '$CALLS' | grep -v -E '^git -C $(toy_copy) push origin (main|refs/tags/v1.0.0)\$' | grep -q ."
check "the copy's origin is the public repository" \
    equals "$("$REAL_GIT" -C "$(toy_copy)" remote get-url origin)" "https://github.com/toy-owner/toy.git"
check "the tag is on the copy's commit, and the working checkout has no tag" \
    bash -c "[[ \$('$REAL_GIT' -C '$(toy_copy)' rev-parse v1.0.0) == \$('$REAL_GIT' -C '$(toy_copy)' rev-parse HEAD) ]] && [[ -z \$('$REAL_GIT' -C '$TOY' tag) ]]"
check "a stable release is not a pre-release, and carries the installer and nothing else" \
    bash -c "grep '^gh release create' '$CALLS' | grep -q -- '--latest $TOY_PKG\$' && ! grep '^gh release create' '$CALLS' | grep -qE 'prerelease|\.dmg|\.zip'"
check "the release notes say how to install and that nothing updates itself" \
    bash -c "grep -q 'A toy change' '$TOY/mac/build/release/release-notes.md' && grep -q 'does not update itself' '$TOY/mac/build/release/release-notes.md'"
check "release.sh neither commits nor pushes in the working repository" \
    bash -c "! grep -nE 'git (add|commit)|git push origin|git tag -a' '$SCRIPT_DIR/release.sh'"
# 2026-11-12: `spctl ... | grep -q accepted` failed one run in three: grep left at its first
# match, spctl died writing its second line, and pipefail made the accepted installer a refused one.
check "release.sh and release-lib.sh search no tool's output through a pipe into grep -q" \
    bash -c "! grep -nE '\| *grep -q' '$SCRIPT_DIR/release.sh' '$SCRIPT_DIR/release-lib.sh' '$SCRIPT_DIR/create-pkg.sh' '$SCRIPT_DIR/notarize-pkg.sh'"
check "release.sh attaches no disk image" \
    bash -c "! grep -nE 'create-dmg|create-zip|\.dmg' '$SCRIPT_DIR/release.sh'"

if [[ "$FAILED" == 0 ]]; then
    echo "Release script tests passed"
else
    echo "Release script tests FAILED"
    exit 1
fi
