# UT Command Installation Guide

The `ut` command is Untether's convenient wrapper that allows you to run any command with terminal sharing enabled. This guide explains how the installation works and how to manage it.

## Installation Behavior

When you install Untether via npm, the `ut` command installation follows these rules:

### Global Installation (`npm install -g untether`)
- **Checks for existing `ut` command** to avoid conflicts with other tools
- If no `ut` command exists, creates it globally
- If `ut` already exists, skips installation and shows a warning
- You can still use `untether fwd` as an alternative

### Local Installation (`npm install untether`)
- Configures `ut` for local use only
- Access via `npx untether fwd` within your project

## Platform Support

### macOS and Linux
- Creates a symlink to the `ut` script
- Falls back to copying if symlink creation fails
- Script is made executable automatically

### Windows
- Creates a `.cmd` wrapper for proper command execution
- Copies the actual script alongside the wrapper
- Works with Command Prompt, PowerShell, and Git Bash

## Common Scenarios

### Existing UT Command
If you already have a `ut` command from another tool:
```bash
# You'll see this warning during installation:
⚠️  A "ut" command already exists in your system
   Untether's ut wrapper was not installed to avoid conflicts
   You can still run it as "untether fwd" or by its full path
```

**Alternatives:**
- Use `untether fwd` (works globally if installed with -g)
- Use `untether fwd` directly
- Manually install to a different name (see below)

### Manual Installation
If automatic installation fails or you want to customize:

```bash
# Find where npm installs global packages
npm config get prefix

# On macOS/Linux, create symlink manually
ln -s $(npm root -g)/untether/bin/ut /usr/local/bin/ut

# Or copy and rename to avoid conflicts
cp $(npm root -g)/untether/bin/ut /usr/local/bin/untether-ut
chmod +x /usr/local/bin/untether-ut
```

### Force Reinstallation
To force Untether to overwrite an existing `ut` command:

```bash
# Remove existing ut first
rm -f $(which ut)

# Then reinstall Untether
npm install -g untether
```

## Troubleshooting

### Permission Denied
If you get permission errors during global installation:
```bash
# Option 1: Use a Node version manager (recommended)
# With nvm: https://github.com/nvm-sh/nvm
# With fnm: https://github.com/Schniz/fnm

# Option 2: Change npm's default directory
# See: https://docs.npmjs.com/resolving-eacces-permissions-errors
```

### Command Not Found
If `ut` is installed but not found:
```bash
# Check if npm bin directory is in PATH
echo $PATH
npm config get prefix

# Add to your shell profile (.bashrc, .zshrc, etc.)
export PATH="$(npm config get prefix)/bin:$PATH"
```

### Windows Specific Issues
- Ensure Node.js is in your system PATH
- Restart your terminal after installation
- Try using `ut.cmd` explicitly if `ut` doesn't work

## Uninstallation

The `ut` command is removed automatically when you uninstall Untether:
```bash
npm uninstall -g untether
```

If it persists, remove manually:
```bash
rm -f $(which ut)
# On Windows: del "%APPDATA%\npm\ut.cmd"
```