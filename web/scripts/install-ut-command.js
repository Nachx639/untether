#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Helper function to detect global installation
const detectGlobalInstall = () => {
  if (process.env.npm_config_global === 'true') return true;
  if (process.env.npm_config_global === 'false') return false;
  
  try {
    const globalPrefix = execSync('npm config get prefix', { encoding: 'utf8' }).trim();
    const globalModules = path.join(globalPrefix, process.platform === 'win32' ? 'node_modules' : 'lib/node_modules');
    const packagePath = path.resolve(__dirname, '..');
    return packagePath.startsWith(globalModules);
  } catch {
    return false; // Default to local install
  }
};

// Helper function to get npm global bin directory
const getNpmBinDir = () => {
  try {
    // Try npm config first (more reliable)
    const npmPrefix = execSync('npm config get prefix', { encoding: 'utf8' }).trim();
    return path.join(npmPrefix, 'bin');
  } catch (e) {
    console.warn('⚠️  Could not determine npm global bin directory');
    return null;
  }
};

// Helper function to install ut globally
const installGlobalUt = (utSource, npmBinDir) => {
  const utTarget = path.join(npmBinDir, 'ut');
  const isWindows = process.platform === 'win32';
  
  // Check if ut already exists
  if (fs.existsSync(utTarget) || (isWindows && fs.existsSync(utTarget + '.cmd'))) {
    console.log('⚠️  A "ut" command already exists in your system');
    console.log('   Untether\'s ut wrapper was not installed to avoid conflicts');
    console.log('   You can still run it as "untether fwd" or by its full path');
    return true;
  }
  
  try {
    if (isWindows) {
      // On Windows, create a .cmd wrapper
      const cmdContent = `@echo off\r\nnode "%~dp0\\ut" %*\r\n`;
      fs.writeFileSync(utTarget + '.cmd', cmdContent);
      // Also copy the actual script
      fs.copyFileSync(utSource, utTarget);
      console.log('✓ ut command installed globally (Windows)');
    } else {
      // On Unix-like systems, create symlink
      fs.symlinkSync(utSource, utTarget);
      console.log('✓ ut command installed globally');
    }
    console.log('  You can now use "ut" to wrap commands with Untether');
    return true;
  } catch (symlinkError) {
    // If symlink fails on Unix, try copying the file
    if (!isWindows) {
      try {
        fs.copyFileSync(utSource, utTarget);
        fs.chmodSync(utTarget, '755');
        console.log('✓ ut command installed globally (copied)');
        console.log('  You can now use "ut" to wrap commands with Untether');
        return true;
      } catch (copyError) {
        console.warn('⚠️  Could not install ut command globally:', copyError.message);
        console.log('   Use "untether fwd" instead');
        return false;
      }
    } else {
      console.warn('⚠️  Could not install ut command on Windows:', symlinkError.message);
      console.log('   Use "untether fwd" instead');
      return false;
    }
  }
};

// Install ut command handler
const installUtCommand = (utSource, isGlobalInstall) => {
  if (!fs.existsSync(utSource)) {
    console.warn('⚠️  ut command script not found in package');
    console.log('   Use "untether" command instead');
    return false;
  }
  
  try {
    // Make ut script executable (Unix-like systems only)
    if (process.platform !== 'win32') {
      fs.chmodSync(utSource, '755');
    }
    
    if (!isGlobalInstall) {
      console.log('✓ ut command configured for local use');
      console.log('  Use "npx untether fwd" to run the ut wrapper');
      return true;
    }
    
    const npmBinDir = getNpmBinDir();
    if (!npmBinDir) {
      return false;
    }
    
    return installGlobalUt(utSource, npmBinDir);
  } catch (error) {
    console.warn('⚠️  Could not configure ut command:', error.message);
    console.log('   Use "untether" command instead');
    return false;
  }
};

module.exports = {
  detectGlobalInstall,
  getNpmBinDir,
  installGlobalUt,
  installUtCommand
};