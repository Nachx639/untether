// What a run was asked for: its options, and the captures (style, theme, accent) they mean.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AUDIT_VIEWS, BASE_VIEWS, VIEWS } from './views/index.mjs';

export const WEB_DIR = path.resolve(import.meta.dirname, '../..');
export const REPO_ROOT = path.dirname(WEB_DIR);
const THEMES = ['light', 'dark', 'system'];
const BROWSERS = ['webkit', 'chromium'];
/** --locale: the browser's language (the interface follows it) and the language of the twin's data. */
export const LOCALES = { es: 'es-ES', en: 'en-US' };

export function fail(message) {
  console.error(`ui-shots: ${message}`);
  process.exit(2);
}

export function parseArgs(argv) {
  const options = {
    browsers: BROWSERS,
    views: BASE_VIEWS,
    out: path.join(process.env.TMPDIR || os.tmpdir(), 'ut-shots'),
  };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const value = () => {
      const next = argv[++index];
      if (next === undefined) fail(`${flag} needs a value`);
      return next;
    };
    if (flag === '--style') options.style = value();
    else if (flag === '--theme') options.theme = value();
    else if (flag === '--accent') options.accent = value();
    else if (flag === '--look') options.look = value();
    else if (flag === '--locale') options.locale = value();
    else if (flag === '--gallery') options.gallery = true;
    else if (flag === '--check-untouchables') options.checkUntouchables = true;
    else if (flag === '--measure-scroll') options.measureScroll = true;
    else if (flag === '--audit-layout') options.auditLayout = true;
    else if (flag === '--safe-area') options.safeArea = true;
    else if (flag === '--coverage') options.coverage = true;
    else if (flag === '--built') options.built = true;
    else if (flag === '--assets') options.assets = path.resolve(value());
    else if (flag === '--out') options.out = path.resolve(value());
    else if (flag === '--browsers') options.browsers = value().split(',');
    else if (flag === '--views') options.views = value().split(',');
    else if (flag === '--inner') options.inner = true;
    else fail(`unknown option ${flag}`);
  }
  if (options.coverage && !argv.includes('--views')) options.views = Object.keys(VIEWS);
  else if (options.auditLayout && !argv.includes('--views')) options.views = [...BASE_VIEWS, ...AUDIT_VIEWS];
  for (const browser of options.browsers) {
    if (!BROWSERS.includes(browser)) fail(`unknown browser ${browser} (${BROWSERS.join(', ')})`);
  }
  options.locale ??= 'es';
  if (!LOCALES[options.locale]) fail(`unknown locale ${options.locale} (${Object.keys(LOCALES).join(', ')})`);
  for (const view of options.views) {
    if (!VIEWS[view]) fail(`unknown view ${view} (${Object.keys(VIEWS).join(', ')})`);
  }
  return options;
}

function accentIds() {
  const source = fs.readFileSync(path.join(WEB_DIR, 'src/client/utils/accent-themes.ts'), 'utf8');
  return [...source.matchAll(/\{ id: '([a-z0-9-]+)'/g)].map((match) => match[1]);
}

/** Each registered style with the modes it admits (src/shared/looks.ts). */
function lookList() {
  const source = fs.readFileSync(path.join(WEB_DIR, 'src/shared/looks.ts'), 'utf8');
  return [
    { id: 'original', modes: 'both' },
    ...[...source.matchAll(/id: '([a-z0-9-]+)',\s*modes: '(both|light|dark)'/g)].map((match) => ({
      id: match[1],
      modes: match[2],
    })),
  ];
}

/** The captures of this run: what goes in localStorage and the name of its files, one per mode. */
export function captures(options) {
  const accents = accentIds();
  let { theme, accent } = options;
  if (options.style) {
    if (THEMES.includes(options.style)) theme = options.style;
    else if (accents.includes(options.style)) accent = options.style;
    else fail(`unknown style ${options.style} (known: ${[...THEMES, ...accents].join(', ')})`);
  }
  if (theme && !THEMES.includes(theme)) fail(`unknown theme ${theme} (${THEMES.join(', ')})`);
  if (accent && !accents.includes(accent)) fail(`unknown accent ${accent} (${accents.join(', ')})`);
  const plain = options.style || [theme, accent].filter(Boolean).join('-') || 'default';
  const looks = lookList();
  const expand = (look) => {
    const modes = look.modes === 'both' ? (theme ? [theme] : ['light', 'dark']) : [look.modes];
    return modes.map((mode) => ({
      look: look.id,
      theme: mode,
      accent,
      label: [look.id, mode, accent].filter(Boolean).join('-'),
    }));
  };
  if (options.gallery) return looks.flatMap(expand);
  if (options.look) {
    const look = looks.find((entry) => entry.id === options.look);
    if (!look) fail(`unknown look ${options.look} (known: ${looks.map((entry) => entry.id).join(', ')})`);
    return expand(look);
  }
  return [{ theme, accent, label: plain }];
}
