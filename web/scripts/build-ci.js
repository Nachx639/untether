const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

console.log('Starting CI build process...');

// The client, as every other build makes it (scripts/build-client.js: directories, assets, the
// app bundle with its plugins and defines, then the stylesheet, the test bundle and the service
// worker). 2026-11-10: this file called the bare esbuild CLI instead, with no __APP_VERSION__
// define (src/client/version.ts reads it, so that bundle threw at load), no build id and no Monaco.
console.log('Building client...');
execSync('node scripts/build-client.js', { stdio: 'inherit' });

// Build server TypeScript
console.log('Building server...');
// Force clean builds in CI. The CommonJS server stays on TypeScript 6 while
// browser targets exercise TypeScript 7's native compiler.
execSync('pnpm exec tsc6 --build tsconfig.server.json --force', { stdio: 'inherit' });
execSync('pnpm exec tsc --build tsconfig.client.json tsconfig.sw.json --force', { stdio: 'inherit' });

// Verify dist directory exists
if (fs.existsSync(path.join(__dirname, '../dist'))) {
  const files = fs.readdirSync(path.join(__dirname, '../dist'));
  console.log(`Server build created ${files.length} files in dist/`);
  console.log('Files in dist:', files.join(', '));
  
  // Check for the essential server.js file
  if (!fs.existsSync(path.join(__dirname, '../dist/server/server.js'))) {
    console.error('ERROR: dist/server/server.js not found after tsc build!');
    console.log('Contents of dist directory:');
    execSync('find dist -type f | head -20', { stdio: 'inherit', cwd: path.join(__dirname, '..') });
    process.exit(1);
  }
} else {
  console.error('ERROR: dist directory does not exist after tsc build!');
  process.exit(1);
}

// Build Rust forwarder first.
// build-native.js verifies the forwarder in CI.
console.log('Building Rust forwarder...');
execSync('node scripts/build-fwd-rust.js', { stdio: 'inherit' });

// Build native executable in CI
console.log('Building native executable for CI...');
execSync('node build-native.js', { stdio: 'inherit' });

console.log('CI build completed successfully!');
