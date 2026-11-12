// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readFoundation } from '../test/utils/stylesheets.js';

// The boot screen has to paint from index.html alone: on a cold start of the home-screen app
// every other file of ours comes from the service worker, which boots first (3 s of white on
// the iPhone SE, 2026-10-04; docs/cold-start.md).
const html = readFileSync(join(__dirname, 'assets/index.html'), 'utf8').replace(
  /<!--[\s\S]*?-->/g,
  ''
);
const beforeBoot = html.slice(0, html.indexOf('<div id="ut-boot"'));
const inlineScripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

describe('index.html critical render path', () => {
  it('has nothing render-blocking ahead of the boot screen', () => {
    const sheets = [...beforeBoot.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*>/g)];
    expect(sheets).toHaveLength(1);
    for (const [tag] of sheets) expect(tag).toContain('media="print"');
    for (const [tag] of beforeBoot.matchAll(/<script\b[^>]*\bsrc=[^>]*>/g)) {
      expect(tag).toMatch(/\b(defer|async)\b|type="module"/);
    }
  });

  it('draws the boot screen and its theme colours with inline CSS only', () => {
    const style = beforeBoot.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';
    expect(style).toMatch(/#ut-boot \{[^}]*position: fixed;/);
    expect(style).toMatch(/html \{\s*background-color: #131211;/);
    expect(style).toMatch(/html\[data-theme='light'\] \{\s*background-color: #FAF9F7;/);
    // No fade-in delay: it shows from the first frame.
    expect(style).not.toMatch(/#ut-boot \{[^}]*animation/);
  });

  it('keeps the app hidden and the boot screen up until the styles apply', () => {
    const style = beforeBoot.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';
    expect(style).toMatch(/html:not\(\[data-ut-styles\]\) untether-app \{\s*visibility: hidden;/);
    expect(style).toContain('html[data-ut-styles] untether-app:defined ~ #ut-boot');
  });
});

describe('the script that applies styles.css', () => {
  const applyStyles = inlineScripts.find((script) => script.includes('ut-styles')) ?? '';

  afterEach(() => {
    document.head.innerHTML = '';
    document.documentElement.removeAttribute('data-ut-styles');
  });

  const run = () => {
    document.head.innerHTML = '<link id="ut-styles" rel="stylesheet" media="print">';
    const link = document.getElementById('ut-styles') as HTMLLinkElement;
    Object.defineProperty(link, 'sheet', { value: null, configurable: true });
    new Function(applyStyles)();
    return link;
  };

  it.each(['load', 'error'])('applies them on %s, never leaving the boot screen up', (event) => {
    const link = run();
    expect(link.media).toBe('print');
    expect(document.documentElement.hasAttribute('data-ut-styles')).toBe(false);
    link.dispatchEvent(new Event(event));
    expect(link.media).toBe('all');
    expect(document.documentElement.hasAttribute('data-ut-styles')).toBe(true);
  });
});

// iOS 26+ blurs ~40 pt under the status bar of a home-screen app (utils/edge-fix.ts).
describe('the top of the home-screen app', () => {
  const css = readFoundation();
  const rule = (selector: string) =>
    css.match(
      new RegExp(`^${selector.replace(/[.[\]()>'=:]/g, '\\$&')} \\{([^}]*)\\}`, 'm')
    )?.[1] ?? '';

  it('by default starts the list header below the blurred zone, opaque behind it', () => {
    const pad = rule(
      "html[data-standalone][data-edge-fix='pad'] .main-list-scroll > app-header .app-header"
    );
    expect(pad.replace(/\s+/g, ' ')).toContain(
      'padding-top: calc( env(safe-area-inset-top, 0px) + max(0.75rem, min(40px, calc(env(safe-area-inset-top, 0px) * 100))) ) !important;'
    );
    // The header row paints the opaque background over its padding.
    expect(readFileSync(join(__dirname, 'components/full-header.ts'), 'utf8')).toMatch(
      /class="app-header ut-chrome bg-bg-secondary/
    );
  });

  it('starts the session view header below the zone too, without costing landscape a row', () => {
    const flat = css.replace(/\s+/g, ' ');
    const block =
      flat.match(
        /html\[data-standalone\]\[data-edge-fix='pad'\] body:not\(\.preview-split-open\) session-view \.session-header-area \{([^}]*)\}/
      )?.[1] ?? '';
    // 40 px under the inset where there is one; 0 where there is none (landscape).
    expect(block).toContain(
      'padding-top: calc( env(safe-area-inset-top, 0px) + min(40px, calc(env(safe-area-inset-top, 0px) * 100)) ) !important;'
    );
    // The header area paints its opaque bar over its padding (phone spec 3.4).
    expect(readFileSync(join(__dirname, 'components/session-view.ts'), 'utf8')).toMatch(
      /\.session-header-area \{[^}]*background-color: var\(--ut-session-bar\) !important;/
    );
  });

  it('Clay keeps the native scroll-edge clearance and removes CSS chrome blur', () => {
    const pad = rule(
      `html[data-look="clay"][data-standalone][data-edge-fix='pad'] .main-list-scroll > app-header .app-header`
    );
    expect(pad.replace(/\s+/g, ' ')).toContain(
      'padding-top: calc(env(safe-area-inset-top, 0px) + var(--ut-list-header-clearance)) !important;'
    );
    const band = rule(
      `html[data-look="clay"][data-standalone]:not([data-edge-fix='off']) .ut-status-bar`
    );
    expect(band).toContain('background-color: var(--ut-status-bar-bg);');
    const clay = readFileSync(join(__dirname, 'styles/looks/clay.css'), 'utf8');
    expect(clay).toContain(
      '--ut-list-header-clearance: min(40px, calc(env(safe-area-inset-top, 0px) * 100));'
    );
    expect(clay).toContain('--ut-header-blur: none;');
    expect(clay).toContain('--ut-toolbar-blur: none;');
    const effects = readFileSync(join(__dirname, 'styles/looks/clay.effects.css'), 'utf8');
    expect(effects).toContain('border-image-source: none;');
    expect(clay).toContain('--ut-status-bar-bg: var(--ut-session-bar);');
  });

  it('gives phone chat mode one background, header and composer included', () => {
    // User request, 2026-10-12: in chat mode the header, its safe area, the strips beside the chat and
    // the composer kept the terminal's color. While the chat covers the terminal the grid
    // redefines --ut-terminal-bg and --ut-session-bar (the header rule above reads it) as the
    // chat's --color-bg.
    const sessionCss = readFileSync(join(__dirname, 'styles/session.css'), 'utf8').replace(
      /\s+/g,
      ' '
    );
    const surface =
      sessionCss.match(
        /\.session-view-grid\[data-mobile='true'\]\[data-chat-surface='true'\] \{([^}]*)\}/
      )?.[1] ?? '';
    expect(surface).toContain('--ut-terminal-bg: var(--color-bg);');
    expect(surface).toContain('--ut-session-bar: var(--color-bg);');
    expect(surface).toContain('--ut-chat-surface: var(--color-bg);');
    // The terminal's side inset is a variable the chat overlay reaches back out over.
    expect(sessionCss).toContain('padding-left: var(--ut-term-inset-left);');
    expect(sessionCss).toContain('padding-right: var(--ut-term-inset-right);');
    // The phone composer follows it, and keeps bg-secondary everywhere else.
    const composer = readFileSync(
      join(__dirname, 'components/terminal-chat-view/styles.ts'),
      'utf8'
    );
    expect(composer).toMatch(
      /:host\(\[composerOnly\]\) \{[^}]*background-color: var\(--ut-chat-surface, var\(--color-bg-secondary\)\);/
    );
    // The chat's own background is the same token.
    expect(
      readFileSync(join(__dirname, 'components/claude-chat-view/styles.ts'), 'utf8')
    ).toContain('--chat-bg: var(--color-bg);');
  });

  it("keeps the sticky header for the 'sticky' mode only", () => {
    const sticky = rule(
      "html[data-standalone][data-edge-fix='sticky'] .main-list-scroll > app-header"
    );
    expect(sticky).toMatch(/position: sticky;/);
    expect(sticky).toMatch(/top: 0;/);
  });

  it("covers the status bar with a hit-testable band, except in the 'off' mode", () => {
    expect(html).toContain('<div class="ut-status-bar" aria-hidden="true"></div>');
    const band = rule("html[data-standalone]:not([data-edge-fix='off']) .ut-status-bar");
    expect(band).toMatch(/position: fixed;/);
    expect(band).toMatch(/height: env\(safe-area-inset-top, 0px\);/);
    expect(band).toMatch(/background-color: var\(--color-bg-secondary\);/);
    expect(band).not.toMatch(/pointer-events/);
    expect(rule('.ut-status-bar')).toMatch(/display: none;/);
  });
});

describe('viewport-init.js', () => {
  const script = readFileSync(join(__dirname, 'assets/viewport-init.js'), 'utf8');
  afterEach(() => {
    document.documentElement.removeAttribute('data-standalone');
    Reflect.deleteProperty(navigator, 'standalone');
  });

  it.each([
    [true, false, true],
    [undefined, true, true],
    [undefined, false, false],
  ])('marks the home-screen app (standalone %s, display-mode %s)', (standalone, mode, marked) => {
    Object.defineProperty(navigator, 'standalone', { value: standalone, configurable: true });
    const matchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query === '(display-mode: standalone)' && mode,
    })) as unknown as typeof window.matchMedia;
    try {
      new Function(script)();
    } finally {
      window.matchMedia = matchMedia;
    }
    expect(document.documentElement.hasAttribute('data-standalone')).toBe(marked);
  });
});
