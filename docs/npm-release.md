# NPM Release Checklist

This checklist ensures a smooth and error-free npm release process for Untether.

## Pre-Release Checklist

### 1. Code Quality
- [ ] Run all tests: `pnpm test`
- [ ] Run linting: `pnpm run lint`
- [ ] Run type checking: `pnpm run typecheck`
- [ ] Run format check: `pnpm run format:check`
- [ ] Fix any issues found: `pnpm run check:fix`

### 2. Dependency Updates
- [ ] Update all dependencies to latest versions
- [ ] Run `pnpm update --interactive --latest`
- [ ] Test thoroughly after updates
- [ ] Check for security vulnerabilities: `pnpm audit`

### 3. Version Updates (CRITICAL - Must be synchronized!)
- [ ] Update version in `web/package.json`
- [ ] Update version in `web/package.npm.json` (must match!)
- [ ] Update version in `mac/Untether/version.xcconfig` (MARKETING_VERSION)
- [ ] Update version in `ios/Untether/version.xcconfig` (if applicable)
- [ ] Ensure all versions match exactly

### 4. Changelog
- [ ] Update CHANGELOG.md with new features, fixes, and breaking changes
- [ ] Include migration guide for breaking changes
- [ ] Credit contributors

## Build Process

### 5. Clean Build
- [ ] Clean previous builds: `rm -rf dist-npm/ untether-*.tgz`
- [ ] Run the complete build on an Apple Silicon Mac with Docker available
- [ ] Run build: `pnpm run build:npm`
- [ ] Verify build output shows all platforms built successfully
- [ ] Check for "✅ authenticate-pam listed as optional dependency" in output

### 6. Package Verification (CRITICAL)
- [ ] Verify tarball exists: `ls -la untether-*.tgz`
- [ ] Extract package.json: `tar -xf untether-*.tgz package/package.json`
- [ ] Verify authenticate-pam is OPTIONAL:
  ```bash
  grep -A5 -B5 authenticate-pam package/package.json
  # Must show under "optionalDependencies", NOT "dependencies"
  ```
- [ ] Clean up: `rm -rf package/`
- [ ] Check package size is reasonable (~8-15 MB)

### 7. Package Contents Verification
- [ ] List package contents: `tar -tzf untether-*.tgz | head -50`
- [ ] Verify critical files are included:
  - [ ] `package/lib/untether-cli`
  - [ ] `package/lib/cli.js`
  - [ ] `package/bin/untether`
  - [ ] `package/bin/ut`
  - [ ] `package/scripts/postinstall.js`
  - [ ] `package/scripts/install-ut-command.js`
  - [ ] `package/node-pty/` directory
  - [ ] `package/prebuilds/` directory with .tar.gz files
  - [ ] `package/public/` directory

## Testing

### 8. Local Installation Test
- [ ] Test installation: `npm install -g ./untether-*.tgz`
- [ ] Verify version: `untether --version`
- [ ] Start server: `untether`
- [ ] Access web UI: http://localhost:4020
- [ ] Test ut command: `ut echo "test"`
- [ ] Uninstall: `npm uninstall -g untether`

### 9. Docker Test (Linux Compatibility)
- [ ] Create test Dockerfile:
  ```dockerfile
  FROM node:22-slim
  COPY untether-*.tgz /tmp/
  RUN npm install -g /tmp/untether-*.tgz
  CMD ["untether", "--version"]
  ```
- [ ] Build: `docker build -t ut-test .`
- [ ] Run: `docker run --rm ut-test`
- [ ] Test without PAM headers (should succeed)
- [ ] Test with PAM: Add `RUN apt-get update && apt-get install -y libpam0g-dev` before install

### 10. Cross-Platform Testing
- [ ] Test on macOS (if available)
- [ ] Test on Linux x64
- [ ] Test on Linux ARM64 (if available)
- [ ] Verify prebuilds are used (no compilation during install)

## Publishing

### 11. Pre-Publish Checks
- [ ] Ensure you're logged in to npm: `npm whoami`
- [ ] Check current tags: `npm dist-tag ls untether`
- [ ] Verify no uncommitted changes: `git status`
- [ ] Create git tag: `git tag v1.0.0-beta.X`

### 12. Publish (CRITICAL - Use tarball filename!)
- [ ] Publish beta: `npm publish untether-*.tgz --tag beta`
- [ ] Verify on npm: https://www.npmjs.com/package/untether
- [ ] Test installation from npm: `npm install -g untether@beta`

### 13. Post-Publish Verification
- [ ] Check package page shows correct version
- [ ] Verify optional dependencies are displayed correctly
- [ ] Test installation on clean system
- [ ] Monitor npm downloads and issues

### 14. Promotion to Latest (if stable)
- [ ] Wait for user feedback (at least 24 hours)
- [ ] If stable, promote: `npm dist-tag add untether@VERSION latest`
- [ ] Update documentation to reference new version

## Post-Release

### 15. Documentation Updates
- [ ] Update README.md with new version info
- [ ] Update installation instructions if needed
- [ ] Create GitHub release with changelog

### 16. Communication
- [ ] Announce release on relevant channels
- [ ] Notify users of breaking changes
- [ ] Thank contributors

## Emergency Procedures

### If Wrong package.json Was Used
1. **DO NOT PANIC**
2. Check if authenticate-pam is a regular dependency (bad) or optional (good)
3. If bad, deprecate immediately:
   ```bash
   npm deprecate untether@VERSION "Installation issues on Linux. Use next version."
   ```
4. Increment version and republish following this checklist

### If Build Failed to Include Files
1. Check build logs for errors
2. Verify all copy operations in build-npm.js succeeded
3. Ensure no .gitignore or .npmignore is excluding files
4. Rebuild with verbose logging if needed

## Common Issues to Avoid

1. **NEVER use `npm publish` without tarball filename** - it may rebuild with wrong config
2. **ALWAYS verify authenticate-pam is optional** before publishing
3. **ALWAYS sync versions** across all config files
4. **NEVER skip the Docker test** - it catches Linux issues
5. **ALWAYS use beta tag first** - easier to fix issues before promoting to latest

## Version Numbering

- Beta releases: `1.0.0-beta.X` where X increments
- Patch releases: `1.0.0-beta.X.Y` where Y is patch number
- Stable releases: `1.0.0` (no beta suffix)

## Quick Commands Reference

```bash
# Update dependencies
pnpm update --interactive --latest

# Complete multi-platform build (macOS only)
pnpm run build:npm

# Verify
tar -xf untether-*.tgz package/package.json && \
grep -A5 optionalDependencies package/package.json && \
rm -rf package/

# Publish
npm publish untether-*.tgz --tag beta

# Promote to latest
npm dist-tag add untether@VERSION latest

# Check tags
npm dist-tag ls untether
```

## Release Frequency

- Beta releases: As needed for testing new features
- Stable releases: After thorough testing and user feedback
- Security patches: ASAP after discovery

Remember: It's better to delay a release than to publish a broken package!
