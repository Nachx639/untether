/**
 * Loading the terminal's font, Hack Nerd Font Mono (2026-10-04, docs/cold-start.md).
 *
 * styles.css splits it per weight into a core file (text, box drawing, Powerline; preloaded by
 * index.html) and two icon files (Private Use code points) that only load when drawn. ghostty
 * paints on a canvas, and canvas text never waits for a web font: it measures its cells once,
 * when it opens, and draws each row with whatever font is ready at that moment. So:
 *
 * - before opening, the terminal waits for both core weights, at most TERMINAL_FONT_TIMEOUT_MS:
 *   a font that fails or is slow must never keep the terminal from showing;
 * - output with Nerd icons loads the icon file it needs (a canvas does not ask by itself on
 *   iOS), and the terminal repaints when that load resolves;
 * - when any of the family's files arrives, the terminal measures again and repaints every row,
 *   so no fallback glyph or tofu stays on screen (ghostty keeps no glyph atlas: a full render
 *   redraws every cell with the font as it is now).
 */

export const TERMINAL_FONT_NAME = 'Hack Nerd Font Mono';
/** How long a new terminal waits for the font before drawing with a fallback. */
export const TERMINAL_FONT_TIMEOUT_MS = 1500;

/** The two core faces; the default sample text (a space) selects the core file of each. */
export const TERMINAL_FONT_SPECS = [
  `16px "${TERMINAL_FONT_NAME}"`,
  `bold 16px "${TERMINAL_FONT_NAME}"`,
] as const;

/** The icon files by their unicode-range in styles.css, with a character from each. */
const ICON_PARTS = [
  { part: 'pua', pattern: /[\uE000-\uE09F\uE0D8-\uF8FF]/, sample: '\uF07B' },
  { part: 'spua', pattern: /[\u{F0000}-\u{10FFFF}]/u, sample: '\u{F0219}' },
] as const;

export type TerminalFontSet = Pick<
  FontFaceSet,
  'load' | 'addEventListener' | 'removeEventListener'
> &
  Partial<Pick<FontFaceSet, 'forEach'>>;

function documentFonts(): TerminalFontSet | null {
  return typeof document !== 'undefined' && document.fonts ? document.fonts : null;
}

/**
 * Resolves once both core weights are loaded (true), or with false when they fail, when the
 * browser has no font loading API, or after `timeoutMs`. Never rejects.
 */
export function waitForTerminalFonts(
  timeoutMs = TERMINAL_FONT_TIMEOUT_MS,
  fonts: TerminalFontSet | null = documentFonts()
): Promise<boolean> {
  if (!fonts) return Promise.resolve(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const loaded = Promise.all(TERMINAL_FONT_SPECS.map((spec) => fonts.load(spec))).then(
    (faces) => faces.every((list) => list.length > 0),
    () => false
  );
  const timedOut = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  return Promise.race([loaded, timedOut]).finally(() => clearTimeout(timer));
}

const isTerminalFace = (face: FontFace) => face.family.replace(/["']/g, '') === TERMINAL_FONT_NAME;

/** One fetch per icon file and page, shared by every terminal; dropped when it fails. */
const iconLoads = new Map<string, Promise<boolean>>();

/** The code point ranges of a FontFace's unicodeRange ("U+E000-E09F, U+E0D8-F8FF"). */
function faceRanges(face: FontFace): Array<[number, number]> {
  return [...face.unicodeRange.matchAll(/U\+([0-9a-f]+)(?:-([0-9a-f]+))?/gi)].map(([, a, b]) => [
    Number.parseInt(a, 16),
    Number.parseInt(b ?? a, 16),
  ]);
}

/**
 * Loads the icon file holding `sample`, both weights. QA on iOS 27 (2026-10-04): a canvas
 * drawing U+F07B never fetched it, so the faces are found in document.fonts by their
 * unicode-range and loaded directly; `fonts.load(spec, text)` only where the set can't be
 * listed. Resolves true once loaded, false when it failed.
 */
function loadIconPart(fonts: TerminalFontSet, sample: string): Promise<boolean> {
  const codePoint = sample.codePointAt(0) ?? 0;
  const faces: FontFace[] = [];
  fonts.forEach?.((face) => {
    if (isTerminalFace(face) && faceRanges(face).some(([a, b]) => a <= codePoint && codePoint <= b))
      faces.push(face);
  });
  if (faces.length > 0) {
    return Promise.all(faces.map((face) => face.load())).then(
      () => true,
      () => false
    );
  }
  return Promise.all(TERMINAL_FONT_SPECS.map((spec) => fonts.load(spec, sample))).then(
    (lists) => lists.some((list) => list.length > 0),
    () => false
  );
}

/**
 * Starts loading the icon files `text` draws from and that `seen` (the caller's own record) has
 * not asked for yet. Returns a promise that resolves true when what was asked for has loaded
 * (the caller then repaints), or null when there was nothing new to ask for. A file that fails
 * is forgotten, in `seen` too, so the next text with one of its characters asks again.
 */
export function loadTerminalIconFonts(
  text: string,
  seen: Set<string>,
  fonts: TerminalFontSet | null = documentFonts()
): Promise<boolean> | null {
  if (!fonts || seen.size === ICON_PARTS.length) return null;
  const loads: Promise<boolean>[] = [];
  for (const { part, pattern, sample } of ICON_PARTS) {
    if (seen.has(part) || !pattern.test(text)) continue;
    seen.add(part);
    let load = iconLoads.get(part);
    if (!load) {
      load = loadIconPart(fonts, sample);
      iconLoads.set(part, load);
    }
    loads.push(
      load.then((loaded) => {
        if (!loaded) {
          iconLoads.delete(part);
          seen.delete(part);
        }
        return loaded;
      })
    );
  }
  if (loads.length === 0) return null;
  return Promise.all(loads).then((results) => results.some(Boolean));
}

/** For tests: forget which icon files were loaded. */
export function resetTerminalIconFonts(): void {
  iconLoads.clear();
}

/** Calls `onLoaded` whenever files of the terminal's font finish loading; returns the unsubscribe. */
export function onTerminalFontsLoaded(
  onLoaded: () => void,
  fonts: TerminalFontSet | null = documentFonts()
): () => void {
  if (!fonts) return () => {};
  const listener = (event: Event) => {
    const faces = (event as FontFaceSetLoadEvent).fontfaces ?? [];
    if (faces.some(isTerminalFace)) onLoaded();
  };
  fonts.addEventListener('loadingdone', listener);
  return () => fonts.removeEventListener('loadingdone', listener);
}
