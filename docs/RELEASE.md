# Untether Release Documentation

How a version of Untether becomes a public download: a signed and notarized installer,
`Untether-<version>.pkg`, attached to a GitHub release of the public repository,
https://github.com/Nachx639/untether/releases.

Two rules, decided by the owner on 2026-11-12:

- **A release is published only when the owner orders it.** One command does it,
  `mac/scripts/release.sh`, run by hand with the tag written out (`--confirm v1.0.0`). No hook,
  scheduled job, workflow, merge or task runs it or creates a release
  (`web/src/test/unit/release-entry-point.test.ts`); the script refuses to publish from a CI job,
  a git hook or an Untether task, and the task guard stops a task's agent from running it or
  `gh release`.
- **Nothing updates itself.** The app has no updater and does not look for new versions: people
  get a new version by downloading its `.pkg`. (`autoUpdateInstalledApp` is something else: the
  owner's Mac rebuilding the app from its own checkout.)

All commands run from `mac/` unless stated otherwise.

## Release flow

1. **Version + changelog**, committed on the working repository's main line before anything else
   (the script changes neither). That line is the branch `untether`, where every task is merged,
   and a release is made from it: the script stops on any other branch. One place names it,
   `untether_release_branch` in `scripts/release-lib.sh`. The working repository has no `main`,
   and its `origin` is a private backup that plays no part in a release. `main` is the PUBLIC
   repository's branch: the clean copy is one commit on top of it.
   - `Untether/version.xcconfig`: `MARKETING_VERSION` is the version to publish, and
     `CURRENT_PROJECT_VERSION` goes up.
   - `../web/package.json` `version` is the same.
   - The top section of `../CHANGELOG.md` is that version's, with its date (no "Unreleased").

2. **Rehearse**: everything that stays on this Mac, nothing that leaves it.
   ```bash
   ./scripts/release.sh --dry-run stable
   ```
   It checks, builds, signs if the certificates are there, builds the `.pkg`, makes the clean copy
   in a temporary folder outside the repository (it says where), and prints the commands a real run would add. It does not stop at
   what would stop a real run: it lists all of it at the end. `--app <Untether.app>` packages an
   existing bundle instead of building (for looking at the installer without a 15-minute build).

3. **Publish**, on the owner's order, in tmux (two notarizations: 20-30 minutes):
   ```bash
   ./scripts/release.sh stable --confirm v1.0.0        # stable: no pre-release mark
   ./scripts/release.sh beta 19 --confirm v1.0.0-beta.19
   ```
   The arguments must match the committed version (`stable` with `1.0.0`, `beta 19` with
   `1.0.0-beta.19`), and `--confirm` the tag: a run without it publishes nothing.

   In this order, stopping at the first failure, with nothing published before the last step:
   checks → build (Apple Silicon, Release) → sign the app (Developer ID Application, hardened
   runtime), notarize, staple → build the `.pkg`, sign it (Developer ID Installer), notarize,
   staple → clean copy on top of the public repository (`scripts/public-export.sh`) → push the
   copy, tag that commit there, `gh release create --repo` with the `.pkg` and its notes.

   The tag belongs to the public history (one commit per publication), never to the working
   one; the script makes no commit, tag or push in the working repository. A published tag is
   never replaced: a mistake is fixed by the next version.

## The installer

`scripts/create-pkg.sh` builds it and `untether_check_pkg` (`scripts/release-lib.sh`) refuses
anything else:

- one component: `Untether.app`, installed in `/Applications`;
- no preinstall or postinstall script. Nothing runs as root and nothing touches the home folder.
  What the app sets up stays what it was, each thing asked for from the app: the `ut` command
  (`/usr/local/bin/ut`, with the administrator password), launch at login, Accessibility,
  Automation and notification permissions, and `~/.untether` on first start;
- not relocatable (Installer would otherwise put the app wherever it finds another copy with
  the same bundle identifier, a build folder for one) and not version-checked (it installs the
  version it carries, also over a newer one);
- Apple Silicon, macOS 14 or later.

There is no disk image in a release. `scripts/create-dmg.sh` and `scripts/create-zip.sh` remain
for an unsigned build to hand around (the `Release Build Verification` workflow uses them).

## Publishing the source

The working repository is private; the public one receives a clean copy, one commit per
publication. `scripts/public-export.sh <folder>` makes it from `HEAD` and checks it (personal
traces, secrets, media nobody looked at, large files, LICENSE); what it leaves out and what it
accepts is in `scripts/public-export.rules`. It never pushes.

No GitHub workflow travels (`.github/workflows` and what only they use stay in the working
repository), and anything new under `.github` fails the export until a rule says it was read.
The public repository's address is one value, `"homepage"` in `web/package.json`:
`scripts/repo-url.sh` lists the files that hold it and `scripts/repo-url.sh <owner>/<name>`
changes it in all of them.

```bash
scripts/public-export.sh ../untether-public   # first time: a new repository, one commit, no remotes
# later: the same command on a clone of the public repository adds one commit on top
git -C ../untether-public push                # by hand, when the copy is the one to publish
```

### What keeps the working history out of the public repository

Three layers (2026-11-12), each of them independent of the other two:

- **A push guard in every clone of the working repository.** `scripts/git-hooks/pre-push` lets
  a push go to the private working repository only, by https or ssh. `pnpm install` in `web/`
  installs it (`scripts/git-hooks/install.sh` copies it to `.git/hooks`, shared by every
  worktree), and the doctor's `publish-guard` check puts it back when it is missing or differs.
  The public copy does not carry it: the exporter writes the copy's own hook
  (`scripts/public-export.pre-push`) on every export, which lets out only the exporter's commits,
  only towards the public repository.
- **Rulesets in the public repository**, which hold from any computer:
  `scripts/public-repo-rules.sh --check` says whether they are in place and `--apply` writes
  them. No branch but `main` can be created, updated or deleted; `main` takes no force-push and
  cannot be deleted; no tag but a release's (`v*`) can be created, and a release tag is never
  moved or deleted. Nobody is on a bypass list. On GitHub's free plan rulesets exist for public
  repositories only, so `--apply` is run right after the repository is made public.
- **The doctor** warns when the guard is not installed, when a remote of the working repository
  points at the public one, and when the public repository is visible without its rulesets.

What none of them stops: `git push --no-verify` towards a third repository (the hook is skipped
and the rulesets are the public repository's only), and the account's owner editing or deleting
the rulesets.

## Requirements

- Xcode 16.4+, Node.js 24, Bun, pnpm
- Rustup (`native/ut-fwd/rust-toolchain.toml` pins the forwarder toolchain)
- GitHub CLI authenticated (`gh auth status`)
- Two certificates in the keychain, from the same Apple developer account: **Developer ID
  Application** (signs the app) and **Developer ID Installer** (signs the `.pkg`).
  `security find-identity -v` lists both.
- The public repository is public, with its rulesets (`../scripts/public-repo-rules.sh --check`)
- Notarization credentials (an App Store Connect API key, from Users and Access → Integrations),
  in the environment of the shell that runs the release:
  ```bash
  export APP_STORE_CONNECT_KEY_ID="YOUR_KEY_ID"            # the key's ID, 10 characters
  export APP_STORE_CONNECT_ISSUER_ID="YOUR_ISSUER_ID"      # the issuer ID, a UUID
  export APP_STORE_CONNECT_API_KEY_PATH="$HOME/keys/AuthKey_YOUR_KEY_ID.p8"   # the .p8 file
  ```
  The key itself is given one of two ways, and the path wins when both are set:
  - `APP_STORE_CONNECT_API_KEY_PATH`: the **path** of the `.p8` file Apple gave. Preferred: the
    secret stays in its file, which is read where it is and never copied or removed.
  - `APP_STORE_CONNECT_API_KEY_P8`: the **content** of that file, the whole
    `-----BEGIN PRIVATE KEY-----` block (real line breaks or `\n`), not a path. It is written
    to a temporary file for as long as `notarytool` reads it.

  Note the names: the ID is `APP_STORE_CONNECT_KEY_ID`, without `API`. The checks of a dry run
  say which of them is missing or not what it should be (a path in the content variable, a file
  that is not a key); whether Apple accepts the key is known at the first notarization only.

## Version Rules

- `version.xcconfig` holds the version being released, suffix included (`1.0.0-beta.5`), the same as
  `web/package.json`. The release script publishes that version and no other: its arguments
  (`stable`, `beta 5`) say it again, and it stops when they do not match.
- `CURRENT_PROJECT_VERSION` must increase for every release.
- The web package version must match the app version.

## Verification

```bash
# The installer: signature, notarization, and what it installs
pkgutil --check-signature build/release/Untether-$VERSION.pkg     # Developer ID Installer
xcrun stapler validate build/release/Untether-$VERSION.pkg
spctl -a -t install -vv build/release/Untether-$VERSION.pkg        # accepted, Notarized Developer ID
pkgutil --payload-files build/release/Untether-$VERSION.pkg | head # ./Untether.app/...

# The release exists, in the public repository
gh release view "v$VERSION" --repo Nachx639/untether
```

## Troubleshooting

- **It stopped**: it cannot resume and does not need to. Nothing is public before the last step
  (push the copy, tag, release). Fix the cause and run it again: a copy already pushed gives no
  new commit and the tag goes on it. The one exception is a run that died after pushing the tag
  and before creating the release: the next run stops at "the tag already exists", and the
  release is finished by hand, from the files of that run:
  `gh release create "v$VERSION" --repo Nachx639/untether --verify-tag --notes-file build/release/release-notes.md build/release/Untether-$VERSION.pkg`
- **Script timeouts**: run it from tmux/screen, never under a tool's timeout.
- **Notarization failures**: `xcrun notarytool log <submission-id> --key ... --key-id ... --issuer ...`
  shows the rejection reasons (usually an unsigned nested binary or missing hardened runtime).
- **The tag is refused by GitHub**: the public repository's rulesets are the old ones or were
  edited: `../scripts/public-repo-rules.sh --check`, then `--apply`.
