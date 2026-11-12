import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { reducedMotionStyles } from './reduced-motion.js';

const clientDir = join(__dirname, '..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [path] : [];
  });
}

describe('Reduce Motion', () => {
  it('the shadow-DOM fragment stops transitions, animations and smooth scrolling', () => {
    const text = reducedMotionStyles.cssText;
    expect(text).toContain('prefers-reduced-motion: reduce');
    for (const rule of [
      'transition-duration: 0.01ms !important',
      'animation-duration: 0.01ms !important',
      'scroll-behavior: auto !important',
    ]) {
      expect(text).toContain(rule);
    }
  });

  // styles.css's page-wide rule does not reach inside shadow roots (2026-10-04).
  it('every shadow-DOM component that animates includes reducedMotionStyles', () => {
    const missing = sources(clientDir).filter((file) => {
      const text = readFileSync(file, 'utf8');
      if (/createRenderRoot\s*\(/.test(text)) return false;
      const styles = text.match(/static (?:override )?styles\s*=[\s\S]*?\n {2}\S/)?.[0] ?? '';
      if (!/\b(animation|transition)\s*:|scroll-behavior:\s*smooth/.test(styles)) return false;
      return !styles.includes('reducedMotionStyles');
    });
    expect(missing.map((file) => relative(clientDir, file))).toEqual([]);
  });

  // An explicit behavior: 'smooth' ignores the CSS rule (scroll-behavior), so code checks.
  it('no script asks for a smooth scroll unconditionally', () => {
    const offenders = sources(clientDir).filter((file) =>
      /behavior:\s*'smooth'/.test(readFileSync(file, 'utf8'))
    );
    expect(offenders.map((file) => relative(clientDir, file))).toEqual([]);
  });
});
