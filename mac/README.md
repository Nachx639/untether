# Untether macOS App

This directory contains the macOS version of Untether.

## Quick Start

### Building
```bash
# Using Xcode
xcodebuild -project Untether.xcodeproj -scheme Untether build

# Using build script
./scripts/build.sh
```

### Running Tests
```bash
xcodebuild test -project Untether.xcodeproj -scheme Untether -destination 'platform=macOS'
```

### Creating Release
```bash
./scripts/release.sh --dry-run stable   # rehearsal: nothing leaves this Mac
```
Publishing is by hand, on the owner's order: see [docs/RELEASE.md](../docs/RELEASE.md).

## Project Structure

```
mac/
├── Untether/           # Source code
│   ├── Core/            # Core services and models
│   ├── Presentation/    # Views and UI components
│   └── Utilities/       # Helper utilities
├── UntetherTests/     # Unit tests
├── scripts/             # Build and release scripts
└── docs/                # macOS-specific documentation
```

## Scripts

- `build.sh` - Build the app with optional signing
- `create-pkg.sh` - The release's installer (.pkg)
- `create-dmg.sh` - A DMG of a local build (not part of a release)
- `release.sh` - The release, by hand only (`--dry-run` to rehearse)
- `sign-and-notarize.sh` - Code signing and notarization

## Documentation

See `docs/` for macOS-specific documentation:
- Code signing setup
- Release process
- Development signing

## Builds and releases

Builds and releases are made locally with the scripts above; `docs/RELEASE.md` has the steps.
