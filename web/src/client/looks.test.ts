import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findLook, LOOK_IDS, LOOKS, ORIGINAL_LOOK_ID } from '../shared/looks.js';
import { readFoundation, readStylesheet } from '../test/utils/stylesheets.js';
import { SUPPORTED_LOCALES } from './i18n/index.js';
import { en } from './i18n/locales/en.js';
import { block } from './test/theme-tokens.js';

/**
 * The interface styles (shared/looks.ts, docs/ui-tokens.md). Every test walks the registry: a
 * style added there is held to all of this without touching the tests.
 */
const LOOKS_DIR = join(__dirname, 'styles/looks');
const REGISTERED = LOOKS.filter((look) => look.id !== ORIGINAL_LOOK_ID);
const read = (name: string) => readFileSync(join(LOOKS_DIR, name), 'utf8');
const LOCALE_FILES: Record<string, string> = { 'pt-BR': 'pt-BR', 'zh-CN': 'zh-CN' };

/** What a style's values may never touch: logos, 3D icons, the terminal (docs/ui-tokens.md). */
const UNTOUCHABLE =
  /^--(?:terminal|ut-terminal|ut-logo|ut-avatar|ut-r-avatar|ut-r-logo|ut-surface-preview|ut-float|ut-bubble|ut-selection-handle)/;

/** The surfaces and text of `[data-theme="dark"]`: a style sets them per mode, never in its base. */
const MODE_TOKENS = [...block(read('../tokens.css'), '[data-theme="dark"]').keys()];

/** Every rule of a stylesheet: its selector text and its body. */
function rules(css: string): { selector: string; body: string }[] {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((rule) => ({
    selector: rule[1].trim(),
    body: rule[2],
  }));
}

const PIECES =
  'ut-surface|ut-card|ut-group|ut-row|ut-btn|ut-icon-btn|ut-chip|ut-field|ut-select|ut-switch|ut-segmented|ut-dialog|ut-menu|ut-menu-item|ut-toast|ut-tooltip|ut-badge|ut-status|ut-kbd|ut-label|ut-section-label|ut-divider';
const EFFECT_PROPERTIES =
  /^(?:background(?:-[a-z]+)*|border(?:-[a-z]+)*|box-shadow|text-shadow|outline(?:-[a-z]+)*|backdrop-filter|-webkit-backdrop-filter|color)$/;

describe('interface styles registry', () => {
  it('has unique ids that are safe in a selector and in a URL', () => {
    expect(new Set(LOOK_IDS).size).toBe(LOOK_IDS.length);
    for (const id of LOOK_IDS) expect(id).toMatch(/^[a-z0-9-]+$/);
    expect(LOOK_IDS).toContain(ORIGINAL_LOOK_ID);
  });

  it('every style has its texts in every language', () => {
    const keys = LOOK_IDS.flatMap((id) => [`look.${id}.name`, `look.${id}.desc`]);
    for (const key of keys) expect(en).toHaveProperty([key]);
    for (const locale of SUPPORTED_LOCALES) {
      if (locale === 'en') continue;
      const text = readFileSync(
        join(__dirname, `i18n/locales/${LOCALE_FILES[locale] ?? locale}.ts`),
        'utf8'
      );
      for (const key of keys) expect(text, `${locale} lacks ${key}`).toContain(`'${key}':`);
    }
  });

  it.each(LOOKS.map((look) => [look.id, look] as const))('%s: well-formed entry', (_id, look) => {
    expect(look.swatches).toHaveLength(3);
    for (const swatch of look.swatches) expect(swatch).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(['both', 'light', 'dark']).toContain(look.modes);
    expect(['base', 'easy', 'effects']).toContain(look.group);
  });

  it('every style file is registered and every registered style has its file', () => {
    const files = readdirSync(LOOKS_DIR).filter((name) => !name.endsWith('.effects.css'));
    expect(files.sort()).toEqual(REGISTERED.map((look) => `${look.id}.css`).sort());
    for (const look of REGISTERED) {
      expect(existsSync(join(LOOKS_DIR, `${look.id}.effects.css`))).toBe(look.effects);
    }
    for (const name of readdirSync(LOOKS_DIR).filter((n) => n.endsWith('.effects.css'))) {
      expect(findLook(name.replace(/\.effects\.css$/, ''))).toBeDefined();
    }
  });

  it('Original has no file and changes nothing', () => {
    const original = findLook(ORIGINAL_LOOK_ID);
    expect(original?.fixedAccent).toBe(false);
    expect(original?.effects).toBe(false);
    expect(existsSync(join(LOOKS_DIR, `${ORIGINAL_LOOK_ID}.css`))).toBe(false);
  });
});

describe.each(REGISTERED.map((look) => [look.id, look] as const))('style %s', (id, look) => {
  const css = read(`${id}.css`);
  const modes = look.modes === 'both' ? (['light', 'dark'] as const) : ([look.modes] as const);

  it('values file: only --ut-* tokens, in its own selectors', () => {
    const allowed = [
      `[data-look="${id}"]`,
      ...modes.map((mode) => `[data-look="${id}"][data-theme="${mode}"]`),
    ];
    for (const { selector, body } of rules(css)) {
      expect(allowed, `selector ${selector}`).toContain(selector);
      for (const decl of body.split(';').filter((text) => text.trim())) {
        const name = decl.slice(0, decl.indexOf(':')).trim();
        expect(name, decl).toMatch(/^--ut-/);
        expect(name, `${id} touches ${name}`).not.toMatch(UNTOUCHABLE);
      }
    }
  });

  it('values file: surfaces and text per mode, and the background of the registry', () => {
    expect(new Set(block(css, `[data-look="${id}"]`).keys()).size).toBeGreaterThan(0);
    for (const name of block(css, `[data-look="${id}"]`).keys()) {
      expect(MODE_TOKENS, `${name} must go per mode`).not.toContain(name);
    }
    for (const mode of modes) {
      const values = block(css, `[data-look="${id}"][data-theme="${mode}"]`);
      for (const token of [
        '--ut-bg-app',
        '--ut-surface-1',
        '--ut-surface-2',
        '--ut-surface-raised',
        '--ut-surface-hover',
        '--ut-border',
        '--ut-text',
        '--ut-text-muted',
        '--ut-text-dim',
      ]) {
        expect(values.has(token), `${mode} lacks ${token}`).toBe(true);
      }
      expect(values.get('--ut-bg-app')).toBe(look.backgrounds[mode]);
    }
  });

  it('declares whether it fixes the accent', () => {
    const allDecls = modes.flatMap((mode) => [
      ...block(css, `[data-look="${id}"][data-theme="${mode}"]`).keys(),
    ]);
    expect(
      allDecls.includes('--ut-accent') || block(css, `[data-look="${id}"]`).has('--ut-accent')
    ).toBe(look.fixedAccent);
  });

  it.runIf(look.effects)(
    'effects layer: only the shared pieces, nothing that repaints what is inside',
    () => {
      const shape = new RegExp(
        `^html\\[data-look="${id}"\\] \\.(?:${PIECES})(?:--[\\w-]+)?(?:::?[\\w-]+(?:\\([^)]*\\))?)*$`
      );
      const found = rules(read(`${id}.effects.css`));
      expect(found.length).toBeGreaterThan(0);
      for (const { selector, body } of found) {
        for (const part of selector.split(',')) expect(part.trim()).toMatch(shape);
        for (const decl of body.split(';').filter((text) => text.trim())) {
          expect(decl.slice(0, decl.indexOf(':')).trim()).toMatch(EFFECT_PROPERTIES);
        }
      }
    }
  );
});

describe('what no style may change', () => {
  it('material geometry cannot override positioning or stacking outside Clay', () => {
    const foundation = readFoundation().replace(/@import[^;]+;/g, '');
    const material = rules(foundation).filter((rule) =>
      rule.selector.includes('.ut-surface--material')
    );
    expect(material.length).toBeGreaterThan(0);
    for (const { selector } of material) {
      for (const part of selector.split(',')) {
        expect(part.trim()).toMatch(/^html\[data-look="clay"\] /);
      }
    }
  });

  it('the tokens of logos and avatars do not move with a style', () => {
    const tokens = read('../tokens.css');
    // Fixed values: a style's corners never reach them (they used to be offsets of --ut-r-lg).
    expect(tokens).toMatch(/--ut-r-avatar: 12px;/);
    expect(tokens).toMatch(/--ut-r-avatar-sm: 8px;/);
  });

  it('logo and avatar images only take radii no style can reach', () => {
    const FIXED = /var\(--ut-r-(?:avatar|logo|circle)[\w-]*\)|inherit/;
    const sheets = ['styles/list.css', 'styles/session.css'].map(readStylesheet);
    const cases = [
      '.ut-repo-icon {',
      "[data-icon='project'] > .ut-tile-icon + *,",
      ".psr-avatar[data-icon='project'] .psr-avatar-glyph,",
      '.pvr-compact .psr-avatar {',
      "An orchestrator's project icon before its title",
    ];
    for (const anchor of cases) {
      const sheet = sheets.find((text) => text.includes(anchor)) as string;
      const start = sheet.indexOf(anchor);
      const radius = sheet.slice(start).match(/border-radius:\s*([^;]+);/)?.[1];
      expect(radius, anchor).toMatch(FIXED);
    }
  });

  it('less transparency and no backdrop-filter both fall back to solid surfaces', () => {
    const tokens = read('../tokens.css');
    const transparency = tokens.match(
      /@media \(prefers-reduced-transparency: reduce\) \{([\s\S]*?)\n\}/
    );
    const unsupported = tokens.match(/@supports not \(\(backdrop-filter[^{]*\{([\s\S]*?)\n\}/);
    for (const token of [
      'backdrop',
      'page-alpha',
      'surface-alpha',
      'panel-alpha',
      'blur-surface',
    ]) {
      const want = token === 'backdrop' || token === 'blur-surface' ? 'none' : '100%';
      expect(transparency?.[1]).toContain(`--ut-${token}: ${want} !important`);
    }
    expect(unsupported?.[1]).toContain('--ut-panel-alpha: 100% !important');
    expect(unsupported?.[1]).toContain('--ut-blur-surface: none !important');
  });

  // 2026-11-09: neobrutalism and retro pixel showed their rows through the header, which read
  // --ut-surface-alpha through bg-bg-secondary/90.
  it('the phone header has a solid surface of its own, not the translucent one of rows', () => {
    const header = rules(readStylesheet('styles/list.css')).find(
      (rule) => rule.selector === '.ut-phone-header'
    );
    expect(header?.body).toMatch(
      /background: color-mix\(in oklab, var\(--ut-surface-1\) var\(--ut-chrome-alpha\)/
    );
  });

  it('no effects layer names images, canvases or the terminal', () => {
    for (const name of readdirSync(LOOKS_DIR).filter((n) => n.endsWith('.effects.css'))) {
      const code = read(name).replace(/\/\*[\s\S]*?\*\//g, '');
      expect(code, name).not.toMatch(
        /\b(?:img|canvas|svg|video|xterm|ut-terminal|terminal|avatar|logo)\b/i
      );
    }
  });
});
