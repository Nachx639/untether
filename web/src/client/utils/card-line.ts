/**
 * The one line a home card shows under its title (2026-11-08, «las tarjetas de inicio son muy
 * verbosas»): what the session or task is doing or what it needs, never a paragraph. Cards
 * show the title, the state, this line and the time; everything else waits behind «Más» or in
 * the session itself.
 */
import { html, type TemplateResult } from 'lit';
import type { Session } from '../../shared/types.js';

/** The longest line a card shows (the server's agent-explain.ts writes at most this). */
export const CARD_LINE_MAX = 80;

/** One line: breaks and runs of spaces folded, cut to `max` characters with «…». */
export function clipLine(text: string | undefined | null, max = CARD_LINE_MAX): string {
  const line = (text ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = [...line];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : line;
}

/** The first non-empty line of a text, clipped (a summary's or a blocker's opening line). */
export function firstLine(text: string | undefined | null, max = CARD_LINE_MAX): string {
  const first = (text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);
  return clipLine(first, max);
}

/** The model's line about what the session's agent does (GET /sessions `explain`), if any. */
export function explainLine(session: Pick<Session, 'explain' | 'status'> | undefined): string {
  if (!session?.explain?.text || session.status !== 'running') return '';
  return clipLine(session.explain.text);
}

/** The longest end a one-line title keeps when it is cut in the middle. */
export const TITLE_END_MAX = 18;
/** The shortest start worth cutting: under it the title is one piece, cut at its end. */
export const TITLE_START_MIN = 4;
/** A start under this many characters keeps less room when cut (styles/list.css `data-keep`). */
const TITLE_START_SHORT = 8;
/**
 * A start this many characters longer than the end's widest word is cut whenever that word has
 * no room beside it: then the end may leave the line whole (styles/list.css `data-leave`).
 */
const TITLE_START_OVER_WORD = 6;

/**
 * A title in two parts for a row with room for one line only (2026-11-10: three queued tasks
 * read «Revisión 2ª vuelta: arreglos claros de…» three times; what told them apart was the
 * end): the end is its last whole words up to `max` characters (the last `max` characters of
 * a longer word), the start is the rest. `.ut-mid` cuts the start and keeps the end:
 * «Revisión 2ª vuelta: arr… del servidor». A title no longer than `max`, or whose start
 * would be under TITLE_START_MIN characters, has no end apart.
 */
export function splitTitleEnd(title: string, max = TITLE_END_MAX): { start: string; end: string } {
  const chars = [...title.trim()];
  if (chars.length <= max) return { start: chars.join(''), end: '' };
  let at = chars.length - max;
  // Forward to the next word's space, so the end starts with whole words.
  const space = chars.indexOf(' ', at);
  if (space !== -1 && space < chars.length - 1) at = space;
  if (at < TITLE_START_MIN) return { start: chars.join(''), end: '' };
  return { start: chars.slice(0, at).join(''), end: chars.slice(at).join('') };
}

/**
 * The two parts of a title, to go inside the element that carries `.ut-mid` or
 * `.ut-title-lines` (with `dir="auto"`: an RTL title puts its start on the right).
 * The end goes word by word, each with the space before it, numbered from the last one
 * (2026-11-10: an end wider than its share of the line was clipped from its left with no
 * «…», «Tokenh examples»): where the whole end has no room the styles drop its first words,
 * whole, and the start keeps room for its «…» (`data-keep`). With no room even for a word,
 * the end leaves the line (`data-leave`) or, beside a short start, its last word is cut.
 */
export function midCutTitle(title: string): TemplateResult {
  const { start, end } = splitTitleEnd(title);
  if (!end) return html`<span class="ut-mid-start">${start}</span>`;
  const words = end.match(/\s*\S+/gu) ?? [end];
  const length = [...start].length;
  const keep = length < TITLE_START_SHORT ? 'short' : 'long';
  const widest = Math.max(...words.map((word) => [...word].length));
  return html`<span class="ut-mid-start" data-keep=${keep}>${start}</span
    ><span class="ut-mid-end" ?data-leave=${length >= widest + TITLE_START_OVER_WORD}
      >${words.map(
        (word, index) =>
          html`<span class="ut-mid-word" style="order:${words.length - 1 - index}">${word}</span>`
      )}</span
    >`;
}

/**
 * Whether the two lines of a `.ut-title-lines` title (without `data-cut`) hide a further one.
 * A hidden line adds a whole line to what the box holds; less than half of one is the glyphs'
 * own reach below a tight line (2026-11-11: WebKit counts it, so with the interlines of Comic
 * and Cosmos, 1.16-1.17, titles of one line passed a fixed 1px margin and were split in two).
 */
export function titleLinesCut(el: Element): boolean {
  const style = getComputedStyle(el);
  const line = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.2 || 2;
  return el.scrollHeight - el.clientHeight > line / 2;
}

const measureTitleLines = (el: Element) => {
  el.removeAttribute('data-cut');
  if (titleLinesCut(el)) el.setAttribute('data-cut', '');
};
let titleWidths: ResizeObserver | undefined;

/**
 * Keeps `data-cut` on a `.ut-title-lines` title while its two lines cut it (then the styles
 * give the second line to its end), now and whenever its width changes. `null` forgets `was`.
 */
export function fitTitleLines(el: Element | null, was?: Element | null): void {
  if (was && was !== el) titleWidths?.unobserve(was);
  if (!el) return;
  titleWidths ??= new ResizeObserver((entries) => {
    for (const entry of entries) measureTitleLines(entry.target);
  });
  titleWidths.observe(el);
  measureTitleLines(el);
}
