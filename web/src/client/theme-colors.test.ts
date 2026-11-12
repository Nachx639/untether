import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { block } from './test/theme-tokens.js';

// The --color-* variables hold full colors, so rgb(var(--color-x)) is invalid CSS and the
// browser drops the declaration (2026-10-02: quick keys lost their background in dark mode).
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|css)$/.test(name) && !name.endsWith('.test.ts') ? [path] : [];
  });
}

describe('theme colors', () => {
  it('never wraps a --color-* variable in rgb()', () => {
    const offenders = sources(__dirname).filter((file) =>
      /rgba?\(\s*var\(--color-/.test(readFileSync(file, 'utf8'))
    );
    expect(offenders).toEqual([]);
  });

  // The first frame (index.html, before styles.css) paints the same background as the app:
  // the warm "Calm control" canvas, not the old #0a0a0a / #fafafa (2026-10-12).
  it('index.html paints the --color-bg tokens before styles.css loads', () => {
    const css = readFileSync(join(__dirname, 'styles/tokens.css'), 'utf8');
    const html = readFileSync(join(__dirname, 'assets/index.html'), 'utf8');
    const light = block(css, ':root').get('--ut-bg-app');
    const dark = block(css, '[data-theme="dark"]').get('--ut-bg-app');
    expect(light).toBeDefined();
    expect(dark).toBeDefined();
    const initial = /initialBg = effectiveTheme === 'dark' \? '(#\w+)' : '(#\w+)'/.exec(html);
    expect(initial?.[1].toLowerCase()).toBe(dark?.toLowerCase());
    expect(initial?.[2].toLowerCase()).toBe(light?.toLowerCase());
    const meta = /<meta name="theme-color" content="(#\w+)"/.exec(html);
    expect(meta?.[1].toLowerCase()).toBe(dark?.toLowerCase());
    const style = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';
    expect(/html \{\s*background-color: (#\w+);/.exec(style)?.[1].toLowerCase()).toBe(
      dark?.toLowerCase()
    );
    expect(
      /html\[data-theme='light'\] \{\s*background-color: (#\w+);/.exec(style)?.[1].toLowerCase()
    ).toBe(light?.toLowerCase());
  });
});
