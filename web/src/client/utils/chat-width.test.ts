// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { restoreLocalStorage, setupLocalStorageMock } from '../../test/utils/component-helpers.js';
import { readStylesheet } from '../../test/utils/stylesheets.js';
import { applyChatWidth, CHAT_WIDTH_KEY, readChatWidth, writeChatWidth } from './chat-width.js';

// 2026-11-11: the desktop chat was a fixed 720 px column (then a 1200 px ceiling); on an ultrawide
// monitor half the window was empty. The default column is now the whole chat area less a margin.
const root = document.documentElement;
const clientDir = join(__dirname, '..');

/** The width of the column in px for a chat area, as the tokens of tokens.css compute it. */
function columnPx(expression: string, vars: Record<string, string>, area: number): number {
  let css = expression;
  for (let pass = 0; pass < 4; pass++) {
    css = css.replace(/var\((--[\w-]+)\)/g, (_m, name: string) => vars[name]);
  }
  const js = css
    .replace(/(\d+(?:\.\d+)?)%/g, (_m, n: string) => `(${Number(n) / 100} * ${area})`)
    .replace(/(\d+(?:\.\d+)?)px/g, '$1')
    .replace(/\bclamp\(/g, 'clamp(')
    .replace(/\bcalc\(/g, '(')
    .replace(/\b(min|max)\(/g, 'Math.$1(');
  const clamp = (low: number, value: number, high: number) => Math.min(Math.max(value, low), high);
  return new Function('clamp', `return ${js}`)(clamp) as number;
}

describe('chat width', () => {
  beforeEach(() => {
    setupLocalStorageMock();
  });

  afterEach(() => {
    restoreLocalStorage();
    root.removeAttribute('data-chat-width');
  });

  it('is full by default, with no attribute; comfortable is saved and set on <html>', () => {
    expect(readChatWidth()).toBe('full');
    writeChatWidth('comfortable');
    expect(root.getAttribute('data-chat-width')).toBe('comfortable');
    expect(localStorage.getItem(CHAT_WIDTH_KEY)).toBe('comfortable');
    expect(readChatWidth()).toBe('comfortable');
    writeChatWidth('full');
    expect(root.hasAttribute('data-chat-width')).toBe(false);
    expect(localStorage.getItem(CHAT_WIDTH_KEY)).toBeNull();
  });

  it('reads anything else in storage, the removed "wide" included, as the default', () => {
    for (const saved of ['enormous', 'wide']) {
      localStorage.setItem(CHAT_WIDTH_KEY, saved);
      expect(readChatWidth()).toBe('full');
    }
  });

  it.each(['assets/theme-init.js', 'assets/index.html'])(
    'the saved choice is applied before the first paint (%s)',
    (file) => {
      const source = readFileSync(join(clientDir, file), 'utf8');
      const block = source.match(/try \{\s*const chatWidth = [\s\S]*?\} catch \(_\) \{\}/)?.[0];
      expect(block).toBeDefined();
      root.removeAttribute('data-chat-width');
      localStorage.setItem(CHAT_WIDTH_KEY, 'comfortable');
      new Function(block as string)();
      const early = root.getAttribute('data-chat-width');
      applyChatWidth(readChatWidth());
      expect(early).toBe('comfortable');
      expect(root.getAttribute('data-chat-width')).toBe(early);
      // Full is no attribute; a saved "wide" (removed) is the default too.
      for (const saved of ['full', 'wide']) {
        root.removeAttribute('data-chat-width');
        localStorage.setItem(CHAT_WIDTH_KEY, saved);
        new Function(block as string)();
        expect(root.hasAttribute('data-chat-width')).toBe(false);
      }
    }
  );

  describe('the column tokens (styles/tokens.css)', () => {
    const tokens = readStylesheet('styles/tokens.css');
    const declared = (block: string) =>
      Object.fromEntries(
        [...block.matchAll(/(--ut-chat-[\w-]+):\s*([^;]+);/g)].map((match) => [match[1], match[2]])
      );
    // The defaults: what is declared outside the comfortable override.
    const base = declared(tokens.replace(/:root\[data-chat-width="comfortable"\] \{[^}]*\}/, ''));
    const rule = (width: string) =>
      declared(
        tokens.match(new RegExp(`:root\\[data-chat-width="${width}"\\] \\{[^}]*\\}`))?.[0] ?? ''
      )['--ut-chat-column'];
    const widths = {
      comfortable: rule('comfortable'),
      full: base['--ut-chat-column'],
    };
    const margin = 32;

    it.each([400, 752, 900, 1000])(
      'a chat area of %i px has the 720 px column of before in both widths',
      (area) => {
        for (const expression of Object.values(widths)) {
          expect(columnPx(expression, base, area)).toBe(720);
        }
      }
    );

    it.each([1280, 1440, 2000, 2560, 3440])(
      'a chat area of %i px: full takes it all less the margin, no ceiling; comfortable stays 720',
      (area) => {
        expect(columnPx(widths.full, base, area)).toBe(area - 2 * margin);
        expect(columnPx(widths.comfortable, base, area)).toBe(720);
      }
    );

    it('has no ceiling or fluid tokens left, and no measure', () => {
      expect(Object.keys(base)).not.toContain('--ut-chat-column-ceiling');
      expect(Object.keys(base)).not.toContain('--ut-chat-column-fluid');
      expect(Object.keys(base)).not.toContain('--ut-chat-measure');
      expect(base['--ut-chat-margin']).toBe('32px');
    });

    it('grows without a jump: a window dragged wider never snaps', () => {
      for (let area = 1000; area < 3500; area++) {
        const step = columnPx(widths.full, base, area + 1) - columnPx(widths.full, base, area);
        expect(step).toBeGreaterThanOrEqual(0);
        expect(step).toBeLessThanOrEqual(4.001);
      }
    });

    it('a bubble takes 82 % of a 720 px column and 90 % of a wide one, comfortable always 82 %', () => {
      const bubble = (column: number) =>
        columnPx(
          base['--ut-chat-bubble-max'],
          { ...base, '--ut-chat-column-floor': '720px' },
          column
        );
      expect(bubble(720)).toBeCloseTo(0.82 * 720);
      expect(bubble(3376)).toBeCloseTo(0.9 * 3376);
      const comfortable = tokens.match(
        /data-chat-width="comfortable"\] \{[^}]*--ut-chat-bubble-max:\s*([^;]+);/
      )?.[1];
      expect(comfortable).toBe('82%');
    });
  });
});
