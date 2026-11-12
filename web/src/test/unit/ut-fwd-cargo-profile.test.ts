import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// 2026-10-12: with Xcode 27 and MACOSX_DEPLOYMENT_TARGET>=12, cargo's `strip = "symbols"`
// reached host proc-macros (serde_derive) and dyld refused them with "mis-aligned LINKEDIT
// string pool", killing the Mac app build. [profile.release.build-override] strip = false
// keeps host-only artifacts unstripped. This test stops that block from being dropped.
const cargoToml = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../native/ut-fwd/Cargo.toml'
);

function section(toml: string, name: string): string | undefined {
  const lines = toml.split('\n');
  const start = lines.findIndex((line) => line.trim() === `[${name}]`);
  if (start === -1) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^\s*\[/.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

describe('untether-fwd Cargo profile', () => {
  it('keeps host build dependencies (proc-macros) unstripped in release', () => {
    const body = section(fs.readFileSync(cargoToml, 'utf8'), 'profile.release.build-override');
    expect(body, '[profile.release.build-override] is missing').toBeDefined();
    expect(body).toMatch(/^\s*strip\s*=\s*(false|"none")\s*$/m);
  });
});
