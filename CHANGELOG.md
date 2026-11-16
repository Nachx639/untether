# Changelog

## [1.0.2] - 2026-11-16

Qoder joins Claude Code and Codex, and the project's orchestrator runs on the agent you choose.

### Added

- **Qoder.** Qoder is an agent of Untether next to Claude Code and Codex, with its own icon: its sessions appear in the list, and it can be given tasks and review them.
- **Orchestrator on any agent.** A project's orchestrator runs on Claude, Codex or Qoder, and moves to another one without stopping: in Settings, with «Change agent», or from the offer it makes when the agent reaches its usage limit.

### Fixed

- **Qoder tasks.** A Qoder task session no longer stops at the project's MCP approval dialog, and the end of a turn is not taken as the end of the task: a task is never closed or merged while its agent is still working.
- **Tasks.** `ut task answer deny` rejects the dialog of any agent.
- **Tasks.** A task can no longer install dependencies or rebuild native modules in the main checkout.
- **Doctor.** No more false warnings for tasks that wait for other tasks, for a model put in a task's command, or for native modules that are right for the Node that loads them.
- **Command guard.** A failed check of Codex is no longer remembered: it is asked again, on the session's own PATH.

## [1.0.1] - 2026-11-12

Fixes to the first stable version.

### Fixed

- **Session header in a task.** The path, the branch and the controls no longer paint over each other when the window is narrow: what does not fit moves to the ⋯ menu.
- **App build.** Building the app no longer installs dependencies or writes files under a server that is running; it builds its native modules apart and checks that they load with the embedded Node before signing, and stops, saying what is running, when it cannot be sure.
- **Tasks.** The forwarder's source stamp no longer blocks a task's merge.
- **Doctor.** It now detects an Untether registered with macOS outside `/Applications` and unregisters it or tells you.

### Internal

- Tests for the isolated native build and the release scripts.

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
