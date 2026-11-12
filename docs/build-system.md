<!-- Generated: 2025-06-21 16:24:00 UTC -->
# Build System

Untether uses platform-specific build systems for each component: Xcode for macOS and iOS applications, pnpm for the web frontend, Cargo for the native forwarder, and Node.js SEA for creating standalone executables. The build system supports both development and release builds with comprehensive automation scripts for code signing, notarization, and distribution.

The main build orchestration happens through shell scripts in `mac/scripts/` that coordinate building native applications, bundling the web frontend, and packaging everything together. Release builds include code signing, notarization, DMG creation, and automated GitHub releases.

## Build Workflows

### macOS Application Build

**Development Build with Poltergeist** (Recommended):
```bash
# Start Poltergeist for automatic rebuilds
poltergeist
# Make changes - app rebuilds automatically
```

**Development Build without Poltergeist**:
```bash
cd mac
xcodebuild -project Untether.xcodeproj -scheme Untether -configuration Debug build
```

**Release Build** - Full build with code signing:
```bash
cd mac
./scripts/build.sh --configuration Release   # signs by default; --no-sign to skip
```

**Key Script**: `mac/scripts/build.sh`
- Builds the standalone server executable (Node.js SEA) from the web project
- Compiles macOS app using xcodebuild
- Handles code signing if requested
- Verifies version consistency with `mac/Untether/version.xcconfig`

### Web Frontend Build

**Development Mode** - Watch mode with hot reload:
```bash
cd web
pnpm run dev
```

**Production Build** - Optimized bundles:
```bash
cd web
pnpm run build
```

**Standalone executable (Node.js SEA)** - Standalone binary with native modules:
```bash
cd web
node build-native.js
```

**Key Files**:
- `web/package.json` - Build scripts and dependencies
- `web/build-native.js` - SEA build and native module bundling

### Native Forwarder Build

Rustup selects Rust 1.97.0 from `native/ut-fwd/rust-toolchain.toml`:

```bash
cd native/ut-fwd
cargo build --release --locked
```

The binary is written to `native/ut-fwd/target/release/untether-fwd`. Web and macOS build scripts copy it into their packaged resources.

### iOS Application Build

**Build via Xcode** - Open `ios/Untether-iOS.xcodeproj` (scheme `Untether-iOS`) and build

### Release Workflow

**Complete Release** - Build, sign, notarize, and publish:
```bash
cd mac
./scripts/release.sh stable           # Stable release
./scripts/release.sh beta 1          # Beta release
```

**Key Script**: `mac/scripts/release.sh`
- Validates environment and dependencies
- Builds with appropriate flags
- Signs and notarizes app
- Creates the installer (.pkg), signs and notarizes it
- Publishes the GitHub release in the public repository (by hand only; docs/RELEASE.md)

## Platform Setup

### macOS Requirements

**Development Tools**:
- Xcode 16.0+ with command line tools
- Node.js 22.12 through 24.x and pnpm
- Bun runtime (installed via npm)
- Rustup; the forwarder toolchain is pinned by `native/ut-fwd/rust-toolchain.toml`
- xcbeautify (optional, for cleaner output)

**Release Requirements**:
- Valid Apple Developer certificate
- App Store Connect API keys for notarization

**Configuration Files**:
- `apple/Local.xcconfig` - Local development settings
- `mac/Untether/version.xcconfig` - Version numbers
- `mac/Untether/Shared.xcconfig` - Shared build settings

### Web Frontend Requirements

**Tools**:
- Node.js 22.12 through 24.x with npm
- Bun runtime for standalone builds
- Rustup for native forwarder builds

**Native Modules**:
- `node-pty` (vendored in `web/node-pty`) - Terminal emulation
- Platform-specific binaries in `web/native/`:
  - `pty.node` - Native PTY module
  - `spawn-helper` - Process spawning helper
  - `untether` - standalone executable (Node.js SEA)
  - `untether-fwd` - Rust terminal forwarder

### Linux (Ubuntu) Requirements

**Packages**:
- `curl`, `ca-certificates`, `xz-utils`, `python3`, `make`, `g++`, `git`
- `libpam0g-dev` (authenticate-pam native module)

**Tooling**:
- Node.js 22.12 through 24.x (NodeSource 24.x recommended)
- Rust 1.97.0 (pinned by `native/ut-fwd/rust-toolchain.toml`)

**Bootstrap**:
```bash
web/scripts/linux-bootstrap.sh
```

### iOS Requirements

**Tools**:
- Xcode 16.0+
- XcodeGen (install via Homebrew)
- iOS 18.0+ deployment target

**Dependencies**:
- ghostty-web resources (JS + WASM) bundled in the iOS app

## Reference

### Build Targets

**macOS Xcode project** (`mac/Untether.xcodeproj`, also in the root `Untether.xcworkspace`):
- Untether scheme - Main application
- Debug configuration - Development builds
- Release configuration - Distribution builds

**Web Build Scripts** (`web/package.json`):
- `dev` - Development server with watchers
- `build` - Production TypeScript compilation
- `bundle` - Client-side asset bundling
- `typecheck` - TypeScript validation
- `lint` - Biome code quality checks

### Build Scripts

**Core Build Scripts** (`mac/scripts/`):
- `build.sh` - Main build orchestrator
- `codesign-app.sh` - Code signing
- `notarize-app.sh` - Apple notarization
- `create-pkg.sh` - The release's installer (.pkg)
- `create-dmg.sh` - DMG packaging (not part of a release)

**Helper Scripts**:
- `preflight-check.sh` - Pre-build validation
- `version.sh` - Version management
- `clean.sh` - Build cleanup
- `verify-app.sh` - Post-build verification

### Troubleshooting

**Common Issues**:

1. **Standalone executable build fails** - Check `web/build-native.js` patches
2. **Code signing errors** - Verify `apple/Local.xcconfig` settings
3. **Notarization fails** - Check API keys in environment
4. **Version mismatch** - Update `mac/Untether/version.xcconfig`

**Build Artifacts**:
- macOS app: `mac/build/Build/Products/Release/Untether.app`
- Web bundles: `web/public/bundle/`
- Native executables: `web/native/`
- iOS app: `ios/build/`

**Clean Build**:
```bash
cd mac && ./scripts/clean.sh
cd ../web && npm run clean
```
