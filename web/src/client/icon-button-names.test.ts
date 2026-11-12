import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// Icon-only buttons need a name for VoiceOver (2026-10-04): settings switches, ✕ close
// buttons, the back arrow and the on-screen ↑ ↓ ← → ⇥ ⏎ ⌘ keys were read as "button" or
// as the bare glyph. This scans the Lit templates for a <button>, <a> or role="button"
// whose content is only an icon (svg, or symbols with no letters or digits) and that has
// no aria-label or aria-labelledby.
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [path] : [];
  });
}

/** Index of the `>` that closes the tag opened at `start`, skipping `${…}` expressions. */
function endOfTag(text: string, start: number): number {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text.startsWith('${', i)) {
      depth++;
      i++;
    } else if (text[i] === '{' && depth) depth++;
    else if (text[i] === '}' && depth) depth--;
    else if (text[i] === '>' && !depth) return i;
  }
  return -1;
}

function unnamedIconButtons(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const found: string[] = [];
  const opener = /<(button|a|div|span)\b/g;
  for (let match = opener.exec(text); match; match = opener.exec(text)) {
    const tag = match[1];
    const end = endOfTag(text, match.index + 1);
    if (end < 0) continue;
    const attrs = text.slice(match.index, end);
    if ((tag === 'div' || tag === 'span') && !/role="button"/.test(attrs)) continue;
    if (/aria-label|aria-labelledby|aria-hidden="true"|\stitle=/.test(attrs)) continue;
    const close = text.indexOf(`</${tag}>`, end);
    if (close < 0) continue;
    const content = text
      .slice(end + 1, close)
      .replace(/<svg[\s\S]*?<\/svg>/g, '')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, '');
    if (/\$\{/.test(content) || /[\p{L}\p{N}]/u.test(content)) continue;
    found.push(
      `${relative(join(__dirname), file)}:${text.slice(0, match.index).split('\n').length}`
    );
  }
  return found;
}

describe('icon-only buttons', () => {
  it('all have an accessible name', () => {
    expect(sources(__dirname).flatMap(unnamedIconButtons)).toEqual([]);
  });

  // 2026-10-12: the shared header buttons are borderless .ut-icon-btn with a translated name
  // (settings was a green gear with only a tooltip).
  it('the settings and appearance header buttons are named icon buttons', () => {
    for (const file of ['components/notification-status.ts', 'components/theme-toggle-icon.ts']) {
      const text = readFileSync(join(__dirname, file), 'utf8');
      expect(text, file).toMatch(/class="ut-icon-btn"[\s\S]{0,200}aria-label=\$\{/);
      expect(text, file).not.toMatch(/text-status-success|hover:text-primary/);
    }
  });
});
