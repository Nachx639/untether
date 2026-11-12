/**
 * The project headers that measure themselves (the phone's project-group and the desktop
 * grid's repository-header: both give their room to the project's name before anything else)
 * are measured again when the page's style changes or a font arrives. A style that only moves
 * things (a margin, a gutter) resizes no box, so no ResizeObserver tells (2026-11-10: a header
 * measured before Dark Premium arrived kept "+ Tarea" and pushed its gear out), and neither
 * does a hidden word's face arriving.
 */
export interface FittedHeader {
  fitHeader(): void;
}

const fittedHeaders = new Set<FittedHeader>();
let styleWatch: MutationObserver | undefined;
/** What decides the headers' sizes on <html> (see readStyleSignature). */
const STYLE_WATCH_ATTRIBUTES = [
  'data-look',
  'data-theme',
  'data-accent',
  'data-text-size',
  'lang',
  'dir',
  'style',
];
let styleSignature = '';
let fontWatch: (() => void) | undefined;

/**
 * The style, language and text size the headers' boxes depend on. 2026-11-10: the observer
 * heard every `style` rewrite (lifecycle-event-manager sets --app-height on each viewport
 * resize and scroll) and measured every header with a synchronous layout each time; now only
 * a change of this signature measures. The inline style only matters through the system text
 * size's two variables.
 */
function readStyleSignature(): string {
  const root = document.documentElement;
  return [
    ...STYLE_WATCH_ATTRIBUTES.filter((name) => name !== 'style').map((name) =>
      root.getAttribute(name)
    ),
    root.style.getPropertyValue('--ut-root-text'),
    root.style.getPropertyValue('--ut-chrome-scale'),
  ].join('|');
}

/** From its connectedCallback: the header is measured again on a style change or a new font. */
export function watchHeaderFit(header: FittedHeader) {
  fittedHeaders.add(header);
  if (!styleWatch && typeof MutationObserver !== 'undefined') {
    styleSignature = readStyleSignature();
    styleWatch = new MutationObserver(() => {
      const signature = readStyleSignature();
      if (signature === styleSignature) return;
      styleSignature = signature;
      for (const fitted of fittedHeaders) fitted.fitHeader();
    });
    styleWatch.observe(document.documentElement, {
      attributes: true,
      attributeFilter: STYLE_WATCH_ATTRIBUTES,
    });
  }
  if (!fontWatch && typeof document !== 'undefined' && document.fonts?.addEventListener) {
    fontWatch = () => {
      for (const fitted of fittedHeaders) fitted.fitHeader();
    };
    document.fonts.addEventListener('loadingdone', fontWatch);
  }
}

/** From its disconnectedCallback. */
export function unwatchHeaderFit(header: FittedHeader) {
  fittedHeaders.delete(header);
  if (fittedHeaders.size) return;
  styleWatch?.disconnect();
  styleWatch = undefined;
  if (fontWatch) document.fonts.removeEventListener('loadingdone', fontWatch);
  fontWatch = undefined;
}
