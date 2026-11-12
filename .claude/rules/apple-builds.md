---
paths:
  - "mac/**"
  - "ios/**"
  - "poltergeist.config.json"
---

# macOS / iOS builds, tests and lint

Never start the Mac app or the server yourself; verify Mac changes with `xcodebuild` only.

## Poltergeist (preferred when installed)

Poltergeist is a file watcher and auto-builder that rebuilds Untether when you make changes.
Check whether it is available and use it for automatic builds.

```bash
which poltergeist                               # installed?
ps aux | grep poltergeist | grep -v grep        # already running for this project?
poltergeist haunt                               # start it in the project root (cd /path/to/untether)
poltergeist status                              # build status (or the Poltergeist menu bar app)
polter untether                                 # waits for the build to finish, then runs (only if the user asks)
```

It rebuilds on changes to Swift files in `mac/`, Xcode project files and configuration files.
`poltergeist.config.json` configures:
- **untether** target: builds the macOS app using the workspace
- **untether-ios** target: builds the iOS app (disabled by default; set `"enabled": true` to turn it on)
- intelligent debouncing to prevent excessive rebuilds
- build notifications via macOS notification center

## Without Poltergeist (fallback)

```bash
cd mac
xcodebuild -project Untether.xcodeproj -scheme Untether -configuration Debug build   # debug build
./scripts/build.sh                              # release build (signed by default)
./scripts/build.sh --no-sign                    # release build without code signing
./scripts/lint.sh                               # SwiftFormat
xcodebuild test -project Untether.xcodeproj -scheme Untether -destination 'platform=macOS'  # MUST use xcodebuild, NOT swift test
```

```bash
cd ios
xcodebuild -project Untether-iOS.xcodeproj -scheme Untether-iOS -sdk iphonesimulator
./scripts/test-with-coverage.sh                 # tests with coverage (75% threshold), automatic simulator selection
./scripts/lint.sh                               # SwiftFormat
```

## /fixmac

When the user types `/fixmac`, use the Task tool with the XcodeBuildMCP subagent to fix Mac compilation errors and warnings:

```
Task(description="Fix Mac build errors", prompt="/fixmac", subagent_type="general-purpose")
```

The agent will: 1. use XcodeBuildMCP tools to identify build errors and warnings; 2. fix compilation issues in the
Mac codebase; 3. address SwiftFormat violations; 4. resolve any warning messages; 5. verify the build succeeds after fixes.
