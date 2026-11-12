import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

function repoRoot(): string {
  return path.resolve(process.cwd(), '..');
}

describe('macOS codesign config', () => {
  it('embedded binary entitlements include JIT + disable library validation', () => {
    const entitlementsPath = path.join(
      repoRoot(),
      'mac',
      'Untether',
      'untether-binary.entitlements'
    );

    expect(existsSync(entitlementsPath)).toBe(true);
    const entitlements = readFileSync(entitlementsPath, 'utf-8');

    expect(entitlements).toContain('com.apple.security.cs.allow-jit');
    expect(entitlements).toContain('com.apple.security.cs.disable-library-validation');
  });

  it('codesign script applies untether-binary.entitlements to embedded binaries', () => {
    const scriptPath = path.join(repoRoot(), 'mac', 'scripts', 'codesign-app.sh');

    expect(existsSync(scriptPath)).toBe(true);
    const script = readFileSync(scriptPath, 'utf-8');

    expect(script).toContain('untether-binary.entitlements');
    expect(script).toContain('/Contents/Resources/untether"');
    expect(script).toContain('/Contents/Resources/untether-fwd"');
    expect(script).toContain('--entitlements "$UNTETHER_ENTITLEMENTS"');
  });
});
