import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readFoundation } from '../test/utils/stylesheets.js';
import { a11yBaseStyles } from './utils/a11y-base-styles.js';

// Keyboard focus was a 30% accent glow, 1.2:1 on the light theme, and Tailwind's
// focus:outline-none took the browser ring away (2026-10-04). The ring's 3:1 against every
// surface is checked in theme-contrast.test.ts (--color-focus-ring).
const css = readFoundation();
// 2026-10-12: one ring for every control, a box-shadow (--focus-ring: 2 px gap + 2 px ring);
// checkboxes, radios, ranges and file pickers get it too, text fields keep border + halo.
const RING =
  /:where\(:focus-visible\):where\(\s*:not\(\s*\[tabindex='-1'\],\s*input:not\(\[type='checkbox'\], \[type='radio'\], \[type='range'\], \[type='file'\]\),\s*textarea,\s*select,\s*\[contenteditable\]\s*\)\s*\)\s*\{\s*box-shadow: var\(--focus-ring/;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [path] : [];
  });
}

describe('keyboard focus ring', () => {
  it('the page draws it on controls, outside any cascade layer so focus:outline-none loses', () => {
    const match = RING.exec(css);
    expect(match).not.toBeNull();
    const before = css.slice(0, match?.index ?? 0).replace(/\/\*[\s\S]*?\*\//g, '');
    const depth = (before.match(/\{/g) ?? []).length - (before.match(/\}/g) ?? []).length;
    expect(depth).toBe(0);
  });

  it('defines the ring once, with a gap in the page color, and no base :focus glow', () => {
    expect(css).toMatch(
      /--focus-ring: 0 0 0 2px var\(--color-bg\), 0 0 0 4px var\(--color-focus-ring\);/
    );
    // The old base rule gave every focused element (mouse clicks too) a 30% accent glow.
    expect(css).not.toMatch(/:focus:where\(:not\(\[tabindex='-1'\]\)\)\s*\{\s*box-shadow/);
    // Form controls no longer draw Tailwind focus rings of their own.
    expect(css).not.toMatch(/focus:ring-/);
    // Forced colors drop box-shadows: an outline there.
    expect(css).toMatch(
      /@media \(forced-colors: active\)\s*\{\s*:where\(:focus-visible\)\s*\{\s*outline/
    );
  });

  it('shadow-DOM components with controls include the same rule', () => {
    expect(RING.test(a11yBaseStyles.cssText)).toBe(true);
    const missing = sources(__dirname).filter((file) => {
      const text = readFileSync(file, 'utf8');
      if (/createRenderRoot\s*\(/.test(text) || !/static (?:override )?styles\s*=/.test(text)) {
        return false;
      }
      if (!/<(button|input|textarea|select|a)\b|tabindex=/.test(text)) return false;
      return !text.includes('a11yBaseStyles');
    });
    expect(missing.map((file) => relative(__dirname, file))).toEqual([]);
  });
});
