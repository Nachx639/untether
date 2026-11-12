# Changelog

## [1.0.0] - 2026-11-12

The first stable version of Untether, and the first public download: a signed and notarized
installer for Apple Silicon Macs with macOS 14 or later.

### What it is

- **Your Mac's sessions, on your phone.** A menu bar app runs a local server whose web interface lists every Claude Code, Codex or shell session by project, puts on top the ones that need you, and opens each as a terminal or as a chat.
- **Tasks with review, checks and merge.** `ut task new` starts an agent in its own git worktree and branch; when it reports done, an AI reviewer reads the diff and the project's check command runs, and the branch is merged or waits for your OK.
- **Interface styles.** 25 of them, picked per device in Settings.
- **No automatic updates.** The app does not look for new versions and never updates itself: a new version is a new `.pkg` to download and open.

### Changed

- Rebranded the project as Untether: app, bundle identifiers (`com.nachx639.untether`), state directory (`~/.untether`), environment variables (`UNTETHER_*`), the `ut` command, the `untether` server binary and the `untether-fwd` forwarder.
- Removed the Sparkle auto-updater and its appcast/update-channel machinery.
- The download is a `.pkg` that puts `Untether.app` in `/Applications` and runs no script; there is no disk image.

### Not in this version

- The iOS app (`ios/`) is not published: it is built from source and still work in progress.
