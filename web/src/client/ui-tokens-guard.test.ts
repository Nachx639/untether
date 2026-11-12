import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readFoundation } from '../test/utils/stylesheets.js';

/**
 * Everything the interface looks like comes from the tokens of styles/tokens.css (2026-11-09,
 * docs/ui-tokens.md): a style is then one small file of values. A hand-written color, radius or
 * shadow anywhere else is a screen that won't follow the styles, so it fails here.
 *
 * Fix it with a token or a shared piece. Only what styles must never touch goes in the lists
 * below (terminal contents, brand marks), each entry with its reason, and an entry that no
 * longer matches anything fails too, so the list can only shrink.
 */

/** Whole files outside the rule: they are the token layer or draw what styles leave alone. */
const EXEMPT_FILES: Record<string, string> = {
  'styles/tokens.css': 'the token layer: values live here',
  'utils/terminal-themes.ts': 'terminal palettes (xterm contents)',
  'utils/terminal-renderer.ts': 'draws terminal contents on a canvas',
  'utils/monaco-loader.ts': "the code editor's own theme",
  'utils/accent-themes.ts': 'swatches of the accent picker (data)',
  'components/terminal-icon.ts': 'the Untether logo',
  'components/terminal-peek-row.ts': 'paints terminal cells on a canvas',
  'components/terminal.ts': 'terminal contents',
  'components/terminal-theme-picker.ts': "previews of the terminal's palettes",
  'sw-offline.ts': 'standalone offline page: no stylesheet to read tokens from',
  'services/ssh-agent.ts': 'fatal crypto banner, built to show without the stylesheet',
};

/** Single literals that stay: `file` + text of the offending value, with the reason. */
const EXCEPTIONS: { file: string; match: RegExp; why: string }[] = [
  {
    file: 'styles/foundation/terminal.css',
    match: /^(?:background-color: #23d18b|color: #000000|color: #4fc3f7|background-color: rgba\()$/,
    why: 'terminal cursor and links (xterm contents)',
  },
  {
    file: 'styles/foundation/terminal-exited.css',
    match: /^background: rgba\($/,
    why: 'CRT scanlines over the exited terminal (terminal contents)',
  },
  {
    file: 'styles/foundation/phone-rows.css',
    match: /^(?:background: #e58a68|color: #fff7f2|background: #1f2430)$/,
    why: 'agent tiles (Claude, shell): avatars never change with the style',
  },
  {
    file: 'styles/foundation/start-screen.css',
    match:
      /^(?:background: #e58a68|color: #fff7f2|background: hsl\(|box-shadow: rgb\(|box-shadow: 0 12px 30px rgb\(201 100 66 \/ 0\.35\))$/,
    why: 'agent tiles (Claude, tool hue) of the start screen: avatars never change with the style',
  },
  {
    file: 'components/ime-input.ts',
    match: /^(?:color: )?#e2e8f0$/,
    why: 'the text typed into the terminal, over it (terminal contents)',
  },
];

/** Dev-only pages (test-entry.ts); never shipped in the app. */
const IGNORED_DIRS = ['test'];

const CLIENT = __dirname;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      return IGNORED_DIRS.includes(relative(CLIENT, full)) ? [] : sources(full);
    }
    return /\.(ts|css)$/.test(name) && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')
      ? [full]
      : [];
  });
}

/** Hides comments keeping every newline, so line numbers stay right. */
function stripComments(text: string, isCss: boolean): string {
  const blank = (match: string) => match.replace(/[^\n]/g, ' ');
  let out = text.replace(/\/\*[\s\S]*?\*\//g, blank);
  if (!isCss) out = out.replace(/(^|[\s;])\/\/[^\n]*/g, blank);
  return out;
}

const HEX = /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})\b/i;
const FUNC = /\b(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch)\(/i;
/** Every named color of CSS; `transparent` and `currentColor` are not a color of their own. */
const NAMED = new RegExp(
  `\\b(?:${`
  aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue 
  blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk 
  crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki 
  darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen 
  darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue 
  dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite 
  gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki 
  lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan 
  lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen 
  lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen 
  magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen 
  mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream 
  mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid 
  palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum 
  powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown 
  seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen 
  steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen
`
    .trim()
    .split(/\s+/)
    .join('|')})\\b`,
  'i'
);
/** Declarations a named color would be a value of. */
const COLOR_PROP =
  /^(?:color|background(?:-color|-image)?|border(?:-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?)?(?:-color)?|outline(?:-color)?|fill|stroke|caret-color|accent-color|text-decoration(?:-color)?|box-shadow|text-shadow|--[\w-]*color[\w-]*)$/;
const RADIUS = /^border(?:-(?:top|bottom|start|end)-(?:left|right|start|end))?-radius$/;
const SHADOW = /^(?:box-shadow|text-shadow)$/;
/** Tailwind classes that bypass the tokens. */
const TAILWIND = new RegExp(
  [
    String.raw`(?:^|[\s"'\`:])!?(?:hover:|focus:|active:)*`,
    '(',
    [
      String.raw`(?:bg|text|border|ring|fill|stroke|from|to|via|divide|outline|shadow|accent|caret|decoration)-(?:white|black|red|green|blue|yellow|orange|amber|emerald|gray|slate|zinc|neutral|stone|purple|violet|indigo|sky|cyan|teal|lime|pink|rose|fuchsia)(?:-\d+)?(?:/\d+)?`,
      String.raw`rounded(?:-[a-z]+)?-\[[^\]]*\]`,
      String.raw`rounded`,
      String.raw`rounded-(?:full|xs|sm|3xl)`,
      String.raw`shadow-\[[^\]]*\]`,
      String.raw`shadow-(?:xs|sm|md|lg|xl|2xl)`,
      String.raw`(?:bg|text|border|ring|fill|stroke|from|to|via)-\[(?:#|rgb|hsl)[^\]]*\]`,
    ].join('|'),
    String.raw`)(?=$|[\s"'\`])`,
  ].join(''),
  'g'
);

interface Finding {
  file: string;
  line: number;
  what: string;
}

const lineOf = (text: string, index: number) => text.slice(0, index).split('\n').length;

/** `var(...)` removed, so what is left of a value is hand-written. */
function withoutVars(value: string): string {
  let out = '';
  let index = 0;
  while (index < value.length) {
    if (value.startsWith('var(', index)) {
      let depth = 0;
      for (; index < value.length; index++) {
        if (value[index] === '(') depth++;
        if (value[index] === ')' && --depth === 0) break;
      }
      index++;
    } else {
      out += value[index++];
    }
  }
  return out;
}

function literalColor(value: string, prop: string): string | undefined {
  const hex = HEX.exec(value);
  if (hex) return hex[0];
  const func = FUNC.exec(value);
  if (func) return func[0];
  if (COLOR_PROP.test(prop)) {
    const named = NAMED.exec(withoutVars(value));
    if (named) return named[0];
  }
  return undefined;
}

/** Splits at top-level commas. */
function shadowParts(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of value) {
    if (char === '(') depth++;
    if (char === ')') depth--;
    if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else current += char;
  }
  parts.push(current);
  return parts;
}

/**
 * Whether a shadow has a hand-written shape. A token's var() brings its own geometry; what is
 * left may be a ring or a stripe (no blur, offsets up to 6 px) in a token's color: a blurred or
 * far-offset shadow needs an --ut-elev-*, --ut-drop-* or --ut-glow-* token.
 */
function fixedShadowGeometry(value: string): boolean {
  return shadowParts(value).some((part) => {
    const lengths = [
      ...withoutVars(part)
        .replace(/color-mix\((?:[^()]|\([^()]*\))*\)/g, ' ')
        .matchAll(/(-?\d*\.?\d+)(px|r?em)?/g),
    ].map(([, number, unit]) => Number(number) * (unit && unit !== 'px' ? 16 : 1));
    return (lengths[2] ?? 0) > 0 || lengths.some((length) => Math.abs(length) > 6);
  });
}

/** Checks one chunk of CSS (a stylesheet, or the inside of css`` / <style>). */
function checkCss(css: string, file: string, offset: string, findings: Finding[]) {
  const report = (index: number, what: string) =>
    findings.push({ file, line: lineOf(offset + css, offset.length + index), what });
  const declaration = /([-\w]+)\s*:\s*((?:[^;{}()]|\((?:[^()]|\([^()]*\))*\))+)(?=;|\s*\})/g;
  for (let m = declaration.exec(css); m; m = declaration.exec(css)) {
    const [, rawProp, value] = m;
    const prop = rawProp.toLowerCase();
    // A value with ${…} is computed: only what is literally written counts.
    const written = value.replace(/\$\{[^}]*\}/g, '');
    const color = literalColor(written, prop);
    if (color) report(m.index, `${prop}: ${color}`);
    // A number outside var() or a calc() over tokens is a hand-written radius (0 is no radius).
    if (RADIUS.test(prop) && !/\bcalc\(.*var\(/.test(written)) {
      if (/\d*\.?[1-9]\d*(?:px|r?em|%)/.test(withoutVars(written))) {
        report(m.index, `${prop}: ${written.trim()}`);
      }
    }
    if (SHADOW.test(prop)) {
      if (
        !/var\(/.test(written) &&
        !/^\s*(?:none|inherit|unset|0)(?:\s*!important)?\s*$/.test(written) &&
        !/^[^#]*\btransparent\s*$/.test(written)
      ) {
        report(m.index, `${prop}: ${written.trim()}`);
      } else if (fixedShadowGeometry(written)) {
        report(m.index, `${prop}: ${written.trim()}`);
      }
    }
  }
  const apply = /@apply\s+([^;]+);/g;
  for (let m = apply.exec(css); m; m = apply.exec(css))
    checkClasses(m[1], m.index, css, file, offset, findings);
}

function checkClasses(
  classes: string,
  index: number,
  context: string,
  file: string,
  offset: string,
  findings: Finding[],
  bareRounded = true
) {
  TAILWIND.lastIndex = 0;
  for (let m = TAILWIND.exec(classes); m; m = TAILWIND.exec(classes)) {
    // "rounded" alone is an English word in any other string (not a class list).
    if (m[1] === 'rounded' && !bareRounded) continue;
    findings.push({
      file,
      line: lineOf(offset + context, offset.length + index),
      what: `class ${m[1]}`,
    });
  }
}

/** The CSS inside a TypeScript file, and the literals in its strings. */
function checkTs(text: string, file: string, findings: Finding[]) {
  const css = /\bcss`([\s\S]*?)`|<style>([\s\S]*?)<\/style>/g;
  let rest = text;
  for (let m = css.exec(text); m; m = css.exec(text)) {
    const body = m[1] ?? m[2];
    const at = m.index + m[0].indexOf(body);
    checkCss(body, file, text.slice(0, at), findings);
    rest = rest.slice(0, at) + body.replace(/[^\n]/g, ' ') + rest.slice(at + body.length);
  }
  // style="…" attributes and .style.x = '…' assignments.
  const attr = /\bstyle="([^"]*)"/g;
  for (let m = attr.exec(rest); m; m = attr.exec(rest)) {
    checkCss(`${m[1]};`, file, rest.slice(0, m.index), findings);
  }
  const classAttr = /\bclass="([^"]*)"/g;
  for (let m = classAttr.exec(rest); m; m = classAttr.exec(rest)) {
    checkClasses(m[1], 0, rest.slice(m.index), file, rest.slice(0, m.index), findings);
  }
  const assign = /\.style\.(\w+)\s*=\s*['"`]([^'"`]*)['"`]/g;
  for (let m = assign.exec(rest); m; m = assign.exec(rest)) {
    const prop = m[1].replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
    checkCss(`${prop}: ${m[2]};`, file, rest.slice(0, m.index), findings);
  }
  // CSS written in plain strings, and any other color. By lines, not by tokenizing strings:
  // a quote inside a regular expression would throw a string scanner off.
  const cssInString =
    /(?:^|[\s;{`'"])((?:[-a-z]*color|background(?:-[a-z]+)?|border(?:-[a-z]+)*|outline(?:-[a-z]+)?|box-shadow|text-shadow|fill|stroke)\s*:\s*[^;`'"{}]+;)/gi;
  const lines = rest.split('\n');
  lines.forEach((text, index) => {
    const before = lines.slice(0, index).join('\n');
    const prefix = index ? `${before}\n` : '';
    for (let m = cssInString.exec(text); m; m = cssInString.exec(text)) {
      checkCss(m[1], file, prefix, findings);
    }
    const hex = /(['"`])#[0-9a-f]{3,8}\1/i.exec(text);
    if (hex) findings.push({ file, line: index + 1, what: hex[0].slice(1, -1) });
    const func = FUNC.exec(text);
    if (func && /\d/.test(text.slice(func.index).split(')')[0])) {
      findings.push({ file, line: index + 1, what: func[0] });
    }
  });
  // Class lists in strings (classMap keys, ternaries).
  const string = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.|\$\{[^}]*\})*`/g;
  for (let m = string.exec(rest); m; m = string.exec(rest)) {
    checkClasses(m[0], 0, rest.slice(m.index), file, rest.slice(0, m.index), findings, false);
  }
}

function findingsOf(file: string, text: string): Finding[] {
  const isCss = file.endsWith('.css');
  const clean = stripComments(text, isCss);
  const findings: Finding[] = [];
  if (isCss) checkCss(clean, file, '', findings);
  else checkTs(clean, file, findings);
  // A value inside a class list or a style attribute can be seen twice.
  const seen = new Set<string>();
  return findings.filter(({ line, what }) => {
    const key = `${line} ${what}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function allFindings(): Finding[] {
  return sources(CLIENT).flatMap((path) => {
    const file = relative(CLIENT, path);
    // A style's values file is a token layer too; its effects layer is held to the rule.
    return EXEMPT_FILES[file] ||
      (file.startsWith('styles/looks/') && !file.endsWith('.effects.css'))
      ? []
      : findingsOf(file, readFileSync(path, 'utf8'));
  });
}

function excepted(finding: Finding): boolean {
  return EXCEPTIONS.some((entry) => entry.file === finding.file && entry.match.test(finding.what));
}

describe('ui tokens guard', () => {
  it('finds no hand-written color, radius or shadow outside the token layer', () => {
    const offenders = allFindings()
      .filter((finding) => !excepted(finding))
      .map(({ file, line, what }) => `${file}:${line}  ${what}`);
    expect(offenders).toEqual([]);
  });

  it('keeps the exception lists honest: every entry still applies', () => {
    const findings = allFindings();
    for (const entry of EXCEPTIONS) {
      const used = findings.some((f) => f.file === entry.file && entry.match.test(f.what));
      expect(used, `stale exception: ${entry.file} ${entry.match} (${entry.why})`).toBe(true);
    }
    for (const file of Object.keys(EXEMPT_FILES)) {
      expect(statSync(join(CLIENT, file)).isFile(), `stale exempt file ${file}`).toBe(true);
    }
  });

  // 2026-11-09: the session's top bar read --ut-terminal-bg, the terminal theme's color, so it
  // stayed black or cream under all 25 styles while everything around it changed.
  describe('the session top bar follows the interface style', () => {
    const FILES = ['styles.css', 'styles/session.css', 'components/session-view.ts'];
    const textOf = (file: string) =>
      file === 'styles.css' ? readFoundation() : readFileSync(join(CLIENT, file), 'utf8');
    const BAR = /\.ut-session-header|\.ut-ph-|\.session-header-area/;
    /** Every `selector { body }` that styles the top bar (nested @layer/@media are skipped into). */
    const barRules = FILES.flatMap((file) => {
      const text = stripComments(textOf(file), file.endsWith('.css'));
      return [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
        .filter(([, selector]) => BAR.test(selector))
        .map(([, selector, body]) => ({ file, selector: selector.trim(), body }));
    });

    it('finds the rules of the bar', () => {
      for (const needed of ['.ut-session-header', '.ut-ph-header', '.session-header-area']) {
        expect(
          barRules.some((rule) => rule.selector.endsWith(needed)),
          needed
        ).toBe(true);
      }
    });

    it('writes no fixed color and never reads the terminal theme', () => {
      const offenders = barRules.flatMap(({ file, selector, body }) => {
        const findings: Finding[] = [];
        checkCss(`.x {${body}}`, file, '', findings);
        const literals = findings.map(({ what }) => `${selector}: ${what}`);
        return /--ut-terminal-bg/.test(body)
          ? [...literals, `${selector}: reads --ut-terminal-bg`]
          : literals;
      });
      expect(offenders).toEqual([]);
    });

    it('paints the bar and its area with --ut-session-bar', () => {
      const backgrounds = barRules.filter(
        ({ selector, body }) =>
          /(?:\.ut-session-header|\.ut-ph-header|\.session-header-area)$/.test(selector) &&
          /(?:^|[\s;])background(?:-color)?\s*:/.test(body)
      );
      expect(backgrounds.length).toBeGreaterThanOrEqual(4);
      for (const { selector, body } of backgrounds) {
        expect(body, selector).toMatch(
          /(?:^|[\s;])background(?:-color)?\s*:\s*var\(--ut-session-bar\)/
        );
      }
    });

    it('gives every style a solid bar of its own, and leaves Original as it was', () => {
      const tokens = stripComments(readFileSync(join(CLIENT, 'styles/tokens.css'), 'utf8'), true);
      expect(tokens).toMatch(/--ut-session-bar:\s*var\(--ut-terminal-bg\);/);
      expect(tokens).toMatch(
        /:root\[data-look\]\s*\{\s*--ut-session-bar:\s*var\(--ut-surface-1\);/
      );
    });

    // A custom property resolves its var() where it is declared. The bar's is declared on <html>,
    // so it follows the terminal only if the color changes there; anything lower must set both.
    it('follows the terminal: its color is written on <html>, or a subtree sets the bar too', () => {
      const manager = readFileSync(
        join(CLIENT, 'components/session-view/terminal-settings-manager.ts'),
        'utf8'
      );
      expect(manager).toMatch(
        /const root = document\.documentElement;\s*if \(background\) root\.style\.setProperty\(TERMINAL_BG_VAR/
      );
      const redefinitions = sources(CLIENT).flatMap((path) => {
        const file = relative(CLIENT, path);
        if (file === 'styles/tokens.css') return [];
        const text = stripComments(readFileSync(path, 'utf8'), file.endsWith('.css'));
        if (!/--ut-terminal-bg\s*:/.test(text)) return [];
        return [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
          .filter(([, , body]) => /--ut-terminal-bg\s*:/.test(body))
          .map(([, selector, body]) => ({ file, selector: selector.trim(), body }));
      });
      expect(redefinitions.length).toBeGreaterThan(0);
      for (const { file, selector, body } of redefinitions) {
        expect(body, `${file} ${selector}`).toMatch(/--ut-session-bar\s*:/);
      }
    });
  });

  // 2026-11-11: styles.css and styles/list.css were two files of 5,900 and 4,700 lines that
  // every interface task edited, and their merges collided. They are lists of parts now: a rule
  // written in a list again, or a part no list imports (never shipped), fails here.
  describe('the stylesheets that only list their parts', () => {
    const LISTS: Record<string, string> = {
      'styles.css': 'styles/foundation',
      'styles/list.css': 'styles/list',
    };
    for (const [list, folder] of Object.entries(LISTS)) {
      it(`${list} holds imports only, and every file of ${folder}/ once`, () => {
        const lines = stripComments(readFileSync(join(CLIENT, list), 'utf8'), true)
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean);
        expect(lines.filter((line) => !/^@import "[^"]+";$/.test(line))).toEqual([]);
        const imported = lines
          .map((line) => /^@import "(\.[^"]+)";$/.exec(line)?.[1])
          .filter((target): target is string => !!target)
          .map((target) => relative(CLIENT, join(CLIENT, list, '..', target)));
        expect(new Set(imported).size).toBe(imported.length);
        for (const file of imported) {
          expect(statSync(join(CLIENT, file)).isFile(), file).toBe(true);
        }
        const parts = readdirSync(join(CLIENT, folder)).map((name) => `${folder}/${name}`);
        expect(parts.filter((file) => !imported.includes(file))).toEqual([]);
      });
    }
  });

  // 2026-11-11 (client audit): three tokens every style defined and nothing read. A token
  // written in a style's file and read nowhere is a value someone tunes for nothing.
  it('has no token left from the ones nothing read', () => {
    const gone = /--ut-(effect-text-glow|hot|material-edge-width)\b/;
    const found = sources(CLIENT)
      .filter((path) => gone.test(readFileSync(path, 'utf8')))
      .map((path) => relative(CLIENT, path));
    expect(found).toEqual([]);
  });

  // var() is invalid in @font-face: the browser drops the descriptor and the face falls back
  // to another font (2026-11-09: a weight token here changed every terminal's text).
  it('leaves @font-face without tokens', () => {
    const offenders = sources(CLIENT).flatMap((path) => {
      if (!path.endsWith('.css')) return [];
      const css = stripComments(readFileSync(path, 'utf8'), true);
      return [...css.matchAll(/@font-face\s*\{[^}]*\}/g)]
        .filter((face) => face[0].includes('var('))
        .map((face) => `${relative(CLIENT, path)}: ${face[0].slice(0, 80)}`);
    });
    expect(offenders).toEqual([]);
  });

  it('catches each kind of literal, in CSS and in templates', () => {
    const cases: [string, string][] = [
      ['a.css', '.x { color: #ff0000; }'],
      ['a.css', '.x { background: rgba(1, 2, 3, 0.5); }'],
      ['a.css', '.x { color: hsl(10 20% 30%); }'],
      ['a.css', '.x { border-color: red; }'],
      ['a.css', '.x { color: var(--c, #fff); }'],
      ['a.css', '.x { border-radius: 12px; }'],
      ['a.css', '.x { border-top-left-radius: 8px; }'],
      ['a.css', '.x { box-shadow: 0 1px 2px currentColor; }'],
      ['a.css', '.x { box-shadow: 0 100px 200px var(--ut-text); }'],
      [
        'a.css',
        '.x { box-shadow: 0 4px 12px color-mix(in srgb, var(--ut-accent) 20%, transparent); }',
      ],
      ['a.css', '.x { box-shadow: 0 40px 0 var(--ut-text); }'],
      ['a.css', '.x { box-shadow: var(--ut-elev-1), 0 8px 24px var(--ut-text); }'],
      ['a.css', '.x { color: rebeccapurple; }'],
      ['a.css', '.x { background: whitesmoke; }'],
      ['a.css', '.x { border-color: lightsteelblue; }'],
      ['a.css', '.x { @apply rounded; }'],
      ['a.css', '.x { @apply bg-red-500; }'],
      ['a.ts', 'const s = css`:host { color: #123456; }`;'],
      ['a.ts', 'const t = html`<style>.x { border-radius: 4px; }</style>`;'],
      ['a.ts', 'const t = html`<div style="color: #abc"></div>`;'],
      ['a.ts', "el.style.borderRadius = '6px';"],
      ['a.ts', "const c = '#0a84ff';"],
      ['a.ts', `const t = html\`<div class="p-2 rounded-[${12}px]"></div>\`;`],
      ['a.ts', 'const t = html`<div class="p-2 text-white"></div>`;'],
      ['a.ts', 'const t = html`<div class="shadow-2xl"></div>`;'],
      ['a.ts', "const W = /['`]/; const s = `.x { border-radius: 10px; }`;"],
      ['a.ts', 'const s = `.x { background: rgba(0, 0, 0, 0.3); }`;'],
    ];
    for (const [file, text] of cases) {
      expect(findingsOf(file, text).length, text).toBeGreaterThan(0);
    }
  });

  it('accepts tokens, keywords and what only looks like a color', () => {
    const cases: [string, string][] = [
      ['a.css', '.x { color: var(--ut-text); }'],
      ['a.css', '.x { background: color-mix(in srgb, var(--ut-accent) 20%, transparent); }'],
      ['a.css', '.x { color: currentColor; border-color: transparent; }'],
      ['a.css', '.x { border-radius: var(--ut-r-md); }'],
      ['a.css', '.x { border-radius: 0; }'],
      ['a.css', '.x { border-radius: calc(var(--ut-r-lg) + 2px); }'],
      ['a.css', '.x { box-shadow: var(--ut-elev-2); }'],
      ['a.css', '.x { box-shadow: 0 0 0 2px var(--ut-accent); }'],
      ['a.css', '.x { box-shadow: inset 3px 0 0 var(--ut-accent); }'],
      [
        'a.css',
        '.x { box-shadow: var(--ut-glow-0-8) color-mix(in srgb, var(--ut-accent) 30%, transparent); }',
      ],
      ['a.css', '.x { box-shadow: var(--ut-elev-2), inset 0 1px 0 var(--ut-edge-light); }'],
      ['a.css', '/* #ff0000 rgb(1,2,3) */ .x { display: block; }'],
      ['a.css', '#add .x { display: block; }'],
      ['a.ts', "const q = document.querySelector('#fade .row');"],
      ['a.ts', 'const t = html`<div class="p-2 rounded-card text-text-muted"></div>`;'],
      ['a.ts', 'const shadowRoot = this.shadowRoot; const r = "rounded corners";'],
    ];
    for (const [file, text] of cases) {
      expect(findingsOf(file, text), text).toEqual([]);
    }
  });
});
