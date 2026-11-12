<!-- Generated: 2025-06-21 12:30:00 UTC -->

# Deployment

Untether deployment encompasses macOS app distribution and CLI tool installation. The release process is highly automated with comprehensive signing, notarization, and update feed generation.

## Package Types

**macOS Application Bundle** - Main Untether.app bundle with embedded resources (mac/build/Build/Products/Release/Untether.app)
- Signed with Developer ID Application certificate
- Notarized by Apple for Gatekeeper approval
- Contains embedded Bun server executable and CLI binaries

**Installer** - The download of a release (mac/build/release/Untether-{version}.pkg)
- Created by mac/scripts/create-pkg.sh: Untether.app into /Applications, no install scripts
- Signed with the Developer ID Installer certificate, notarized and stapled by mac/scripts/notarize-pkg.sh
- A disk image (mac/scripts/create-dmg.sh) is not part of a release

**CLI Tools Package** - Command line binaries installed to /usr/local/bin
- untether binary (main CLI tool)
- ut wrapper script (convenience command)
- Installed via mac/Untether/Utilities/CLIInstaller.swift

## Platform Deployment

### Automated Release Process

**Complete Release Workflow** - mac/scripts/release.sh orchestrates the entire process:
```bash
./scripts/release.sh stable         # Stable release
./scripts/release.sh beta 2         # Beta release 2
./scripts/release.sh alpha 1        # Alpha release 1
```

**Pre-flight Checks** - mac/scripts/preflight-check.sh validates:
- Git repository state (clean working tree, on main branch)
- Build environment (Xcode, certificates, tools)
- Version configuration (mac/Untether/version.xcconfig)
- Notarization credentials (environment variables)

**Build and Signing** - mac/scripts/build.sh with mac/scripts/sign-and-notarize.sh:
- Builds ARM64-only binary (Apple Silicon)
- Signs with hardened runtime and entitlements
- Notarizes with Apple using API key authentication
- Staples notarization ticket to app bundle

### Code Signing Configuration

**Signing Script** - mac/scripts/codesign-app.sh handles deep signing:
- Signs all embedded frameworks and binaries
- Preserves existing signatures with timestamps
- Uses Developer ID Application certificate

**Notarization Process** - mac/scripts/notarize-app.sh submits to Apple:
- Creates secure timestamp signatures
- Submits via notarytool with API key (lines 38-72)
- Waits for Apple processing (timeout: 30 minutes)
- Staples ticket on success (lines 104-115)

### CLI Installation

**Installation Manager** - mac/Untether/Utilities/CLIInstaller.swift:
- Checks installation status (lines 41-123)
- Handles version updates (lines 276-341)
- Creates /usr/local/bin if needed (lines 407-411)
- Installs via osascript for sudo privileges (lines 470-484)

**Server Configuration** (lines 398-453):
- Bun server: Creates ut wrapper script that prepends 'fwd' command

### GitHub Release Creation

**Release Publishing** - Handled by mac/scripts/release.sh, by hand and on the owner's order
(docs/RELEASE.md):
- Makes the clean copy of the source, pushes it to the public repository and tags that commit there
- Creates the GitHub release in the public repository with the installer (.pkg)
- Generates release notes from CHANGELOG.md
- Marks pre-releases appropriately

**Release Verification** - Before anything is published:
- The installer's structure (untether_check_pkg), signature, notarization and stapled ticket
- Gatekeeper's verdict on the app and on the installer

## Reference

### Environment Variables
```bash
# Required for notarization
APP_STORE_CONNECT_API_KEY_P8    # App Store Connect API key content (or APP_STORE_CONNECT_API_KEY_PATH: the .p8 file)
APP_STORE_CONNECT_KEY_ID         # API Key ID
APP_STORE_CONNECT_ISSUER_ID      # API Issuer ID

# Optional
DMG_VOLUME_NAME                  # Custom DMG volume name (create-dmg.sh, not used by releases)
SIGN_IDENTITY                    # Override signing identity
```

### Key Scripts and Locations
- **Release orchestration**: mac/scripts/release.sh
- **Build configuration**: mac/scripts/build.sh, mac/scripts/common.sh
- **Signing pipeline**: mac/scripts/sign-and-notarize.sh, mac/scripts/codesign-app.sh
- **Notarization**: mac/scripts/notarize-app.sh, mac/scripts/notarize-pkg.sh
- **Installer creation**: mac/scripts/create-pkg.sh
- **Version management**: mac/Untether/version.xcconfig

### Release Artifacts
- **Application bundle**: mac/build/Build/Products/Release/Untether.app
- **Signed installer**: mac/build/release/Untether-{version}.pkg
- **GitHub releases**: https://github.com/Nachx639/untether/releases

### Common Issues
- **Notarization failures**: Check API credentials, ensure valid Developer ID certificate
- **Build number conflicts**: Increment CURRENT_PROJECT_VERSION in version.xcconfig
- **Double version suffixes**: Ensure version.xcconfig has correct format before release
