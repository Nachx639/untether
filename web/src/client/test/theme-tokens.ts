/**
 * Reads the theme tokens out of styles/tokens.css and computes WCAG contrast between them, for
 * theme-contrast.test.ts. Pure functions over the stylesheet's text: no browser needed.
 *
 * A theme is the merge of the blocks that apply to <html> for one data-theme and data-accent,
 * in cascade order: `:root`, `[data-theme="dark"]`, `[data-accent="…"]`, then for a style
 * `[data-look="id"]`, `[data-theme="dark"][data-accent="…"]` (0,2,0 beats a style's one
 * attribute) and `[data-look="id"][data-theme="…"]` (0,2,0 and later) from styles/looks/<id>.css;
 * the `--text-color-*` entries of `@theme` (what Tailwind's text-* utilities read before `--color-*`).
 */

export const ACCENTS = [
  'untether',
  'emerald',
  'ocean',
  'violet',
  'sunset',
  'rose',
  'cyber',
  'gold',
  'clay',
];
export type Mode = 'light' | 'dark';
export type Vars = Map<string, string>;

/** The declarations of the first rule whose selector is exactly `selector`. */
export function block(css: string, selector: string): Vars {
  const vars: Vars = new Map();
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(^|\\n)\\s*${escaped}\\s*\\{`).exec(css);
  if (!match) return vars;
  const start = match.index + match[0].length;
  const body = css.slice(start, css.indexOf('}', start)).replace(/\/\*[\s\S]*?\*\//g, '');
  for (const decl of body.split(';')) {
    const colon = decl.indexOf(':');
    if (colon < 0) continue;
    const name = decl.slice(0, colon).trim();
    if (name.startsWith('--')) vars.set(name, decl.slice(colon + 1).trim());
  }
  return vars;
}

/** One style: its id in the registry and the text of styles/looks/<id>.css. */
export interface StyleFile {
  id: string;
  css: string;
}

/** The variables of `:root` that hold the light palette (the first `:root` with --color-bg). */
function rootPalette(css: string): Vars {
  const re = /(^|\n):root\s*\{/g;
  for (let m = re.exec(css); m; m = re.exec(css)) {
    const vars = block(css.slice(m.index), ':root');
    if (vars.has('--color-bg')) return vars;
  }
  throw new Error('no :root palette in styles/tokens.css');
}

export function themeVars(css: string, mode: Mode, accent: string, style?: StyleFile): Vars {
  const layers = [rootPalette(css)];
  if (mode === 'dark') layers.push(block(css, '[data-theme="dark"]'));
  layers.push(block(css, `[data-accent="${accent}"]`));
  if (style) layers.push(block(style.css, `[data-look="${style.id}"]`));
  if (mode === 'dark') layers.push(block(css, `[data-theme="dark"][data-accent="${accent}"]`));
  if (style) layers.push(block(style.css, `[data-look="${style.id}"][data-theme="${mode}"]`));
  const vars: Vars = new Map();
  for (const layer of layers) for (const [name, value] of layer) vars.set(name, value);
  for (const [name, value] of block(css, '@theme')) {
    if (name.startsWith('--text-color-')) vars.set(name, value);
  }
  return vars;
}

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const NAMED: Record<string, Rgba> = {
  white: { r: 255, g: 255, b: 255, a: 1 },
  black: { r: 0, g: 0, b: 0, a: 1 },
  transparent: { r: 0, g: 0, b: 0, a: 0 },
};

/** Splits `a, b, c` at top-level commas. */
function args(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of text) {
    if (char === '(') depth++;
    if (char === ')') depth--;
    if (char === ',' && depth === 0) {
      out.push(current.trim());
      current = '';
    } else current += char;
  }
  out.push(current.trim());
  return out;
}

/** A color expression (hex, rgb(), color-mix(in srgb …), var(), named) in a theme. */
export function color(expr: string, vars: Vars, seen: string[] = []): Rgba {
  const text = expr.trim();
  const named = NAMED[text.toLowerCase()];
  if (named) return named;
  const varMatch = /^var\(\s*(--[\w-]+)\s*(?:,\s*([\s\S]+))?\)$/.exec(text);
  if (varMatch) {
    const [, name, fallback] = varMatch;
    if (seen.includes(name)) throw new Error(`cycle: ${[...seen, name].join(' → ')}`);
    const value = vars.get(name) ?? fallback;
    if (value === undefined) throw new Error(`undefined token ${name}`);
    return color(value, vars, [...seen, name]);
  }
  const hex = /^#([0-9a-f]{3,8})$/i.exec(text);
  if (hex) {
    let digits = hex[1];
    if (digits.length <= 4) digits = [...digits].map((d) => d + d).join('');
    const n = (i: number) => Number.parseInt(digits.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: digits.length === 8 ? n(6) / 255 : 1 };
  }
  const rgb = /^rgba?\(([^)]*)\)$/.exec(text);
  if (rgb) {
    const parts = rgb[1].replace(/[,/]/g, ' ').trim().split(/\s+/).map(Number);
    return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1 };
  }
  const mix = /^color-mix\(\s*in srgb\s*,([\s\S]*)\)$/.exec(text);
  if (mix) {
    const [first, second] = args(mix[1]);
    const split = (part: string) => {
      const m = /^([\s\S]*?)\s+(var\([\w-]+\)|\d+(?:\.\d+)?%)$/.exec(part);
      if (!m) return { expr: part, pct: null };
      const pct = m[2].startsWith('var(') ? (vars.get(m[2].slice(4, -1)) ?? '') : m[2];
      return { expr: m[1], pct: Number.parseFloat(pct) / 100 };
    };
    const a = split(first);
    const b = split(second);
    const pa = a.pct ?? (b.pct === null ? 0.5 : 1 - b.pct);
    const pb = b.pct ?? 1 - pa;
    const ca = color(a.expr, vars, seen);
    const cb = color(b.expr, vars, seen);
    // Premultiplied mix, as CSS Color 5 specifies.
    const alpha = ca.a * pa + cb.a * pb;
    const channel = (key: 'r' | 'g' | 'b') =>
      alpha === 0 ? 0 : (ca[key] * ca.a * pa + cb[key] * cb.a * pb) / alpha;
    return { r: channel('r'), g: channel('g'), b: channel('b'), a: alpha };
  }
  throw new Error(`can't read color ${text}`);
}

/** `top` painted over an opaque `bottom`. */
export function over(top: Rgba, bottom: Rgba): Rgba {
  const a = top.a;
  return {
    r: top.r * a + bottom.r * (1 - a),
    g: top.g * a + bottom.g * (1 - a),
    b: top.b * a + bottom.b * (1 - a),
    a: 1,
  };
}

function luminance({ r, g, b }: Rgba): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Vars entry with the backdrop color a contrast is measured over: its presence turns it on. */
export const BACKDROP_STOP = '--test-backdrop-stop';

/**
 * Every color of the style's backdrop, plus the plain app background under it: overlapping
 * gradients only blend between these, so they are the worst cases for what sits on top.
 */
export function backdropStops(vars: Vars): string[] {
  const backdrop = vars.get('--ut-backdrop');
  if (!backdrop || backdrop === 'none') return [];
  const found = backdrop.match(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/gi) ?? [];
  return [...new Set([...found, vars.get('--ut-bg-app') ?? '#000000'])];
}

/**
 * WCAG contrast of `fg` on a background stack (bottom first; translucent layers are painted
 * over the ones below, and a translucent `fg` over the result).
 */
export function contrast(fg: string, bg: string | string[], vars: Vars): number {
  const stack = Array.isArray(bg) ? bg : [bg];
  const stop = vars.get(BACKDROP_STOP);
  let base: Rgba;
  if (stop) {
    // A style with a backdrop: the stop, the page's tint over it, then the surface on top.
    const app = color('var(--ut-bg-app)', vars);
    base = over(color('var(--color-page)', vars), over(color(stop, vars), app));
    if (stack[0] !== 'var(--color-page)') base = over(color(stack[0], vars), base);
  } else {
    base = color(stack[0], vars);
    if (base.a < 1) base = over(base, color('white', vars));
  }
  for (const layer of stack.slice(1)) base = over(color(layer, vars), base);
  const text = over(color(fg, vars), base);
  const [hi, lo] = [luminance(text), luminance(base)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
