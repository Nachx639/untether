import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOOKS, ORIGINAL_LOOK_ID } from '../shared/looks.js';
import {
  ACCENTS,
  BACKDROP_STOP,
  backdropStops,
  block,
  contrast,
  type Mode,
  type StyleFile,
  themeVars,
  type Vars,
} from './test/theme-tokens.js';

/**
 * WCAG contrast of the theme's text/background token pairs, in both themes and every accent
 * (2026-10-04: emerald, amber and gold text on white were 1.6–2.5:1, white labels on the
 * accent 1.8–4.2:1, placeholders 3.3:1). Body text needs 4.5:1; icons, focus rings and UI
 * borders 3:1. A token change that drops a pair under its minimum fails here.
 *
 * Every registered style (shared/looks.ts) goes through the same pairs, in the modes it
 * supports and with every accent unless it fixes its own: registering it is all it takes.
 */
const css = readFileSync(join(__dirname, 'styles/tokens.css'), 'utf8');

/** Every style the app can show, from the registry. */
function styleFiles(): (StyleFile & { modes: Mode[]; accents: string[] })[] {
  return LOOKS.filter((look) => look.id !== ORIGINAL_LOOK_ID).map((look) => ({
    id: look.id,
    css: readFileSync(join(__dirname, `styles/looks/${look.id}.css`), 'utf8'),
    modes: look.modes === 'both' ? ['light', 'dark'] : [look.modes],
    accents: look.fixedAccent ? ['untether'] : ACCENTS,
  }));
}

/** The paper scopes of tokens.css: `[data-look="id"] :where(pieces) { --ut-x: var(--ut-paper-x) … }`. */
function paperScopes(tokens: string): [string, { pieces: string; vars: Vars }][] {
  return [...tokens.matchAll(/\n(\[data-look="([a-z0-9-]+)"\] :where\(([^)]*)\)) \{/g)].map(
    (match) => [match[2], { pieces: match[3], vars: block(tokens, match[1]) }]
  );
}

const SURFACES = [
  'bg',
  'bg-secondary',
  'bg-tertiary',
  'bg-elevated',
  'surface',
  'surface-hover',
  'card',
  'float',
  'page',
].map((name) => `var(--color-${name})`);

const v = (name: string) => `var(--color-${name})`;
const tint = (fill: string, pct: number) => `color-mix(in srgb, ${fill} ${pct}%, transparent)`;
const BUBBLE_OUT = `color-mix(in srgb, ${v('primary')} 30%, ${v('bg-elevated')})`;

interface Pair {
  what: string;
  fg: string;
  bg: string | string[];
  min: number;
}

/** `fg` on every plain surface. */
const onSurfaces = (what: string, fg: string, min = 4.5): Pair[] =>
  SURFACES.map((bg) => ({ what: `${what} on ${bg}`, fg, bg, min }));

const PAIRS: Pair[] = [
  // Body text and its greys: titles, "clasico-qa", "14 min", "18 terminadas", preview names.
  ...onSurfaces('text', v('text')),
  ...onSurfaces('text-muted', v('text-muted')),
  ...onSurfaces('text-dim', v('text-dim')),
  ...onSurfaces('placeholder', v('placeholder')),
  // Accent and status words as text: Tailwind's text-primary / text-status-* read these.
  ...onSurfaces('text-primary', 'var(--text-color-primary)'),
  ...onSurfaces(
    'text-status-warning ("Te necesita", "Borrar todas")',
    'var(--text-color-status-warning)'
  ),
  ...onSurfaces(
    'text-status-error ("Cerrar todas", "Terminar sesión")',
    'var(--text-color-status-error)'
  ),
  ...onSurfaces('text-status-success ("4 activas", "activa")', 'var(--text-color-status-success)'),
  ...onSurfaces('text-status-info', 'var(--text-color-status-info)'),
  // The selected row (--color-selected, 2026-10-12): every text grey on it.
  ...['text', 'text-bright', 'text-muted', 'text-dim'].map((fg) => ({
    what: `${fg} on the selected row`,
    fg: v(fg),
    bg: v('selected'),
    min: 4.5,
  })),
  // "Needs you" labels (amber, --color-attention-text) on the page, cards and their own tint.
  ...['bg', 'bg-secondary', 'bg-elevated'].flatMap((base) => [
    { what: `attention text on ${base}`, fg: v('attention-text'), bg: v(base), min: 4.5 },
    {
      what: `attention text on ${base} + attention tint`,
      fg: v('attention-text'),
      bg: [v(base), v('attention-muted')],
      min: 4.5,
    },
  ]),
  // Icons and the keyboard focus ring.
  ...onSurfaces('focus ring', v('focus-ring'), 3),
  // On the accent tint: selected row (dim becomes muted there), "In Untether" badge,
  // answer option numbers, notifications banner and its status line.
  ...['bg', 'bg-secondary'].flatMap((base) => [
    {
      what: `text-muted on ${base} + accent tint`,
      fg: v('text-muted'),
      bg: [v(base), v('primary-muted')],
      min: 4.5,
    },
    {
      what: `text-primary on ${base} + accent tint`,
      fg: v('primary-text'),
      bg: [v(base), v('primary-muted')],
      min: 4.5,
    },
    {
      what: `success text on ${base} + accent tint`,
      fg: v('status-success-text'),
      bg: [v(base), v('primary-muted')],
      min: 4.5,
    },
    {
      what: `error text on ${base} + accent tint`,
      fg: v('status-error-text'),
      bg: [v(base), v('primary-muted')],
      min: 4.5,
    },
  ]),
  // The preview chip "Vista previa :5173".
  {
    what: 'text-primary on the preview chip',
    fg: v('primary-text'),
    bg: `color-mix(in srgb, ${v('primary')} 14%, ${v('bg')})`,
    min: 4.5,
  },
  // Warning boxes (Settings, watch banner) and the red tints ("Cerrar todas", dictation).
  ...[v('primary-text'), v('status-warning-text'), v('status-info-text'), v('text')].map((fg) => ({
    what: `${fg} on a warning tint`,
    fg,
    bg: [v('bg-secondary'), tint(v('status-warning'), 10)],
    min: 4.5,
  })),
  ...[v('bg-secondary'), v('bg-tertiary'), v('bg-elevated')].map((base) => ({
    what: `error text on ${base} + red tint`,
    fg: v('status-error-text'),
    bg: [base, tint(v('status-error'), 10)],
    min: 4.5,
  })),
  // Chat bubbles: text, and the time / action icons / links on the user's accent bubble.
  { what: 'text on the user bubble', fg: v('text'), bg: BUBBLE_OUT, min: 4.5 },
  {
    what: 'time and icons on the user bubble',
    fg: `color-mix(in srgb, ${v('text')} 82%, ${BUBBLE_OUT})`,
    bg: BUBBLE_OUT,
    min: 4.5,
  },
  // Labels and icons on fills: accent buttons (FAB, "Cómo", Codex chip, send), its hover,
  // success and warning toasts and badges; white on the red fill (error toast, swipe).
  ...['primary', 'primary-light', 'status-success', 'status-warning', 'status-info'].map(
    (fill) => ({ what: `on-fill ink on ${fill}`, fg: v('on-fill'), bg: v(fill), min: 4.5 })
  ),
  { what: 'white on the red fill', fg: 'white', bg: v('status-error'), min: 4.5 },
  // «Conversar» (copilot-sheet.ts, 2026-10-14): a pressed toggle cell (accent tint on the
  // sheet), its label, icon and state; the speaking indicator's glyph on the live tint.
  ...[v('text'), v('primary-text')].map((fg) => ({
    what: `${fg} on a pressed Conversar toggle`,
    fg,
    bg: `color-mix(in srgb, ${v('primary')} 15%, ${v('bg-elevated')})`,
    min: 4.5,
  })),
  {
    what: 'speaking glyph on the Conversar indicator',
    fg: v('primary-text'),
    bg: v('avatar-live-bg'),
    min: 3,
  },
  {
    what: 'listening glyph on the Conversar indicator',
    fg: v('attention-text'),
    bg: [v('bg-elevated'), v('attention-muted')],
    min: 3,
  },
  // Session avatars, live in colour and finished in grey (2026-10-12): the glyph is an icon
  // (3:1) on its tint, and the green "alive" dot reads against the page and the cards.
  { what: 'live glyph on the live tile', fg: v('avatar-live-fg'), bg: v('avatar-live-bg'), min: 3 },
  { what: 'needs-you glyph on its tile', fg: v('avatar-attn-fg'), bg: v('avatar-attn-bg'), min: 3 },
  { what: 'finished glyph on its tile', fg: v('avatar-off-fg'), bg: v('avatar-off-bg'), min: 3 },
  ...['bg', 'bg-secondary', 'surface'].map((base) => ({
    what: `alive dot on ${base}`,
    fg: v('alive'),
    bg: v(base),
    min: 3,
  })),
];

const THEMES: [Mode, string][] = (['light', 'dark'] as Mode[]).flatMap((mode) =>
  ACCENTS.map((accent): [Mode, string] => [mode, accent])
);

function failures(vars: Vars): string[] {
  const check = (where: string, theme: Vars) =>
    PAIRS.flatMap(({ what, fg, bg, min }) => {
      const ratio = contrast(fg, bg, theme);
      return ratio + 1e-9 >= min ? [] : [`${what}${where}: ${ratio.toFixed(2)} < ${min}`];
    });
  const stops = backdropStops(vars);
  // Translucent surfaces of a backdrop style are read over every color of its gradient.
  if (stops.length === 0) return check('', vars);
  return stops.flatMap((stop) => check(` over ${stop}`, new Map(vars).set(BACKDROP_STOP, stop)));
}

const STYLES = styleFiles();
const STYLE_THEMES: [string, Mode, string, StyleFile][] = STYLES.flatMap((style) =>
  style.modes.flatMap((mode) =>
    style.accents.map((accent): [string, Mode, string, StyleFile] => [
      style.id,
      mode,
      accent,
      style,
    ])
  )
);

describe('theme contrast (WCAG)', () => {
  it.each(THEMES)('%s theme, %s accent: every pair reaches its minimum', (mode, accent) => {
    expect(failures(themeVars(css, mode, accent))).toEqual([]);
  });

  it.each(STYLE_THEMES)(
    'style %s, %s theme, %s accent: every pair reaches its minimum',
    (_id, mode, accent, style) => {
      expect(failures(themeVars(css, mode, accent, style))).toEqual([]);
    }
  );

  it('a style that breaks a pair is caught, and one that only restates values passes', () => {
    const broken: StyleFile = {
      id: 'broken',
      css: '[data-look="broken"] { --ut-text-muted: #FAF9F7; }',
    };
    const lightBroken = failures(themeVars(css, 'light', 'untether', broken));
    expect(lightBroken.some((failure) => failure.startsWith('text-muted on'))).toBe(true);
    const darkOnly: StyleFile = {
      id: 'night',
      css: '[data-look="night"][data-theme="dark"] { --ut-text-muted: #131211; }',
    };
    expect(failures(themeVars(css, 'light', 'untether', darkOnly))).toEqual([]);
    expect(failures(themeVars(css, 'dark', 'untether', darkOnly)).length).toBeGreaterThan(0);
    const same: StyleFile = {
      id: 'same',
      css: '[data-look="same"] { --ut-text-muted: #4F4C48; }',
    };
    expect(failures(themeVars(css, 'light', 'untether', same))).toEqual([]);
  });

  // 2026-11-09, Clay: rows and bars a style paints in its own colors (tokens neutral elsewhere).
  it.each(STYLE_THEMES)(
    'style %s, %s theme, %s accent: text reads on its colored rows and top bar',
    (_id, mode, accent, style) => {
      const vars = themeVars(css, mode, accent, style);
      const fills = [
        '--ut-needs-fill-1',
        '--ut-needs-fill-2',
        '--ut-needs-fill-3',
        '--ut-row-working-bg',
        '--ut-row-needs-bg',
        '--ut-row-ready-bg',
        '--ut-row-failed-bg',
        '--ut-session-bar',
      ].filter((name) => vars.get(name)?.startsWith('#'));
      const inks = [
        '--color-text',
        '--color-text-muted',
        '--color-text-dim',
        '--color-attention-text',
      ];
      const low = fills.flatMap((fill) =>
        inks.flatMap((ink) => {
          const ratio = contrast(`var(${ink})`, `var(${fill})`, vars);
          return ratio >= 4.5 ? [] : [`${ink} on ${fill}: ${ratio.toFixed(2)}`];
        })
      );
      expect(low).toEqual([]);
    }
  );

  // 2026-11-10, Editorial: a dark ground whose cards and sheets are paper. Those pieces take the
  // style's --ut-paper-* palette through the paper scope of tokens.css; text inside them is
  // measured here with that palette, which the pairs above (the ground's) never see.
  describe.each(paperScopes(css))('paper scope of %s', (id, scope) => {
    const style = STYLES.find((candidate) => candidate.id === id) as (typeof STYLES)[number];
    const lookNames = new Set(
      [...style.css.matchAll(/(^|[\s;{])(--[\w-]+)\s*:/g)].map((match) => match[2])
    );
    const remapped = [...scope.vars].filter(([, value]) =>
      /^var\(--ut-paper-[\w-]+\)$/.test(value)
    );

    it('names a real style and only palette values that style defines', () => {
      expect(style).toBeDefined();
      expect(remapped.length).toBeGreaterThan(0);
      for (const [name, value] of remapped) {
        expect(value, name).toBe(`var(--ut-paper-${name.slice('--ut-'.length)})`);
        expect(lookNames, `${id} lacks ${value}`).toContain(value.slice(4, -1));
      }
    });

    it('gives the same pieces their text color', () => {
      expect(css).toContain(
        `\n  [data-look="${id}"] :where(${scope.pieces}) {\n    color: var(--color-text);`
      );
    });

    it.each(style.modes)('%s theme: every pair reaches its minimum on paper', (mode) => {
      const vars = themeVars(css, mode, 'untether', style);
      for (const [name, value] of scope.vars) vars.set(name, value);
      expect(failures(vars)).toEqual([]);
      const fills = [
        '--ut-needs-fill-1',
        '--ut-needs-fill-2',
        '--ut-needs-fill-3',
        '--ut-row-working-bg',
        '--ut-row-needs-bg',
        '--ut-row-ready-bg',
        '--ut-row-failed-bg',
        '--ut-rows-bg',
        '--ut-composer-bg',
        '--ut-banner-bg',
      ].filter((name) => /^(#|var\(--ut-paper-)/.test(vars.get(name) ?? ''));
      const inks = [
        '--color-text',
        '--color-text-muted',
        '--color-text-dim',
        '--color-attention-text',
      ];
      const low = fills.flatMap((fill) =>
        inks.flatMap((ink) => {
          const ratio = contrast(`var(${ink})`, `var(${fill})`, vars);
          return ratio >= 4.5 ? [] : [`${ink} on ${fill}: ${ratio.toFixed(2)}`];
        })
      );
      expect(low).toEqual([]);
    });

    // A var() is resolved where it is declared: a token of the first block that depends on a
    // remapped one keeps the ground's value inside a paper piece unless the scope repeats it.
    it('evaluates again every token and alias that depends on the palette it changes', () => {
      const flat = (value: string) => value.replace(/\s+/g, ' ').trim();
      const declared = [
        ...block(css, ':root'),
        ...[...block(css, '@theme')].filter(([name, value]) => value !== `var(${name})`),
      ];
      const dependent = new Set(remapped.map(([name]) => name));
      for (let grew = true; grew; ) {
        grew = false;
        for (const [name, value] of declared) {
          if (dependent.has(name)) continue;
          const reads = [...value.matchAll(/var\(\s*(--[\w-]+)/g)].map((match) => match[1]);
          if (reads.some((read) => dependent.has(read))) {
            dependent.add(name);
            grew = true;
          }
        }
      }
      // Never the terminal, the logos or the session bar; and not what the style sets itself.
      const kept =
        /^--(?:terminal|ut-terminal|ut-logo|ut-r-avatar|ut-r-logo|ut-surface-preview|ut-float|ut-bubble|ut-selection-handle|ut-session-bar)/;
      const missing = declared
        .filter(([name]) => dependent.has(name) && !kept.test(name) && !lookNames.has(name))
        .filter(([name]) => !remapped.some(([own]) => own === name))
        .filter(([name, value]) => flat(scope.vars.get(name) ?? '') !== flat(value))
        .map(([name]) => name);
      expect(missing).toEqual([]);
      for (const name of scope.vars.keys()) expect(name, name).not.toMatch(kept);
    });
  });

  it('a backdrop style is measured over every color of its gradient', () => {
    const glass: StyleFile = {
      id: 'glass',
      css: `[data-look="glass"] { --ut-surface-alpha: 30%; --ut-page-alpha: 0%; }
[data-look="glass"][data-theme="dark"] {
  --ut-backdrop: linear-gradient(#000000, #FFFFFF);
  --ut-surface-1: #000000;
}`,
    };
    const vars = themeVars(css, 'dark', 'untether', glass);
    expect(backdropStops(vars)).toEqual(['#000000', '#FFFFFF', vars.get('--ut-bg-app')]);
    const found = failures(vars);
    // Light text on a surface 70% see-through to the white stop can't be read.
    expect(found.some((failure) => failure.includes('over #FFFFFF'))).toBe(true);
    expect(found.some((failure) => failure.includes('over #000000'))).toBe(false);
  });

  it('text-primary and text-status-* read the text shades, not the fills', () => {
    const theme = block(css, '@theme');
    expect(theme.get('--text-color-primary')).toBe('var(--color-primary-text)');
    for (const status of ['warning', 'error', 'success', 'info']) {
      expect(theme.get(`--text-color-status-${status}`)).toBe(`var(--color-status-${status}-text)`);
    }
  });

  // The system-dark block repeats [data-theme="dark"]; the two drifting apart would give
  // "Sistema" users other colors than "Oscuro" ones.
  it('the system-dark palette matches the dark one', () => {
    const dark = block(css, '[data-theme="dark"]');
    const media = css.match(
      /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\) \{([^}]*)\}/
    );
    expect(media).not.toBeNull();
    const system = block(`x {${media?.[1]}}`, 'x');
    expect(Object.fromEntries(system)).toEqual(
      Object.fromEntries([...dark].filter(([name]) => system.has(name)))
    );
    expect([...dark.keys()].filter((name) => !system.has(name))).toEqual([]);
  });
});
