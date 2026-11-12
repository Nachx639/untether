/**
 * Checks on ghostty's canvas: that its pixels are the size its cells and the pixel ratio call
 * for, and a one-line report of what it looked like (sizes, ratio, the transforms above it, a
 * measure of how sharp its pixels are) for the log.
 *
 * After a cold start of the iPhone home-screen app the first terminal kept coming up blurry
 * (header sharp, text soft as if stretched from a smaller bitmap) until another session was
 * opened and this one again (user report, 2026-10-12), while the page's pixel ratio was right.
 * ghostty-web 0.4's Terminal.resize and its font change set the canvas's pixels to the CSS
 * size (1x) right after the renderer sized it at the ratio, and count on their own render() to
 * size it back; a render that does not get through (a held paint, a skipped frame) left it at
 * 1x, and nothing checked it again.
 */

export interface CellMetrics {
  width: number;
  height: number;
}

interface CanvasLike {
  width: number;
  height: number;
  style: { width: string; height: string };
}

/**
 * Whether the canvas is not the size ghostty's renderer would give it for `cols` x `rows` cells
 * at `ratio`: its pixels (as a canvas keeps them, truncated to whole ones) or its CSS size.
 */
export function canvasSizeMismatch(
  canvas: CanvasLike,
  cols: number,
  rows: number,
  metrics: CellMetrics,
  ratio: number
): boolean {
  if (!(cols > 0 && rows > 0 && metrics.width > 0 && metrics.height > 0 && ratio > 0)) {
    return false;
  }
  const cssWidth = cols * metrics.width;
  const cssHeight = rows * metrics.height;
  return (
    canvas.width !== Math.trunc(cssWidth * ratio) ||
    canvas.height !== Math.trunc(cssHeight * ratio) ||
    cssSizeDiffers(canvas.style.width, cssWidth) ||
    cssSizeDiffers(canvas.style.height, cssHeight)
  );
}

/**
 * Whether a CSS size as the style gives it back is not `px`. Compared as numbers: the browser
 * gives a fractional size back rounded (586.6666666666666 → "586.667px"), and the touch cells
 * (terminal-touch-cells.ts) are fractional; as strings, the canvas was resized on every frame.
 */
function cssSizeDiffers(value: string, px: number): boolean {
  if (!value.endsWith('px')) return true;
  return !(Math.abs(Number.parseFloat(value) - px) < 0.01);
}

/** Sum of squared differences between neighbouring values. */
function edgeEnergy(values: ArrayLike<number>, width: number, rows: number): number {
  let energy = 0;
  for (let y = 0; y < rows; y++) {
    const row = y * width;
    for (let x = 0; x + 1 < width; x++) {
      const d = values[row + x + 1] - values[row + x];
      energy += d * d;
    }
  }
  return energy;
}

/**
 * How sharp a band of luminance is: its edge energy over that of the same band blurred by two
 * pixels. A hard edge gives about 2; one stretched from a third of the pixels about 1.2; a
 * band with no edges gives null.
 */
export function bandSharpness(luma: ArrayLike<number>, width: number, rows: number): number | null {
  if (width < 3 || rows < 1) return null;
  const blurred = new Float32Array(width * rows);
  for (let y = 0; y < rows; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const next = x + 1 < width ? luma[row + x + 1] : luma[row + x];
      blurred[row + x] = (luma[row + x] + next) / 2;
    }
  }
  const sharp = edgeEnergy(luma, width, rows);
  const soft = edgeEnergy(blurred, width, rows);
  if (soft < 1e-6) return null;
  return sharp / soft;
}

/** Luminance of RGBA pixels. */
function lumaOf(data: ArrayLike<number>, pixels: number): Float32Array {
  const luma = new Float32Array(pixels);
  for (let i = 0; i < pixels; i++) {
    luma[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  }
  return luma;
}

/**
 * The canvas's sharpness (bandSharpness) on the 3-pixel band with the most edges among a few
 * across its height, or null when it cannot be read.
 */
export function canvasSharpness(canvas: HTMLCanvasElement): number | null {
  try {
    const ctx = canvas.getContext('2d');
    const width = Math.min(canvas.width, 2400);
    if (!ctx || width < 3 || canvas.height < 3) return null;
    let best: { energy: number; sharpness: number | null } | null = null;
    const bands = 12;
    for (let i = 1; i <= bands; i++) {
      const y = Math.floor((canvas.height * i) / (bands + 1));
      const image = ctx.getImageData(0, Math.min(y, canvas.height - 3), width, 3);
      const luma = lumaOf(image.data, width * 3);
      const energy = edgeEnergy(luma, width, 3);
      if (!best || energy > best.energy) {
        best = { energy, sharpness: bandSharpness(luma, width, 3) };
      }
    }
    return best?.sharpness ?? null;
  } catch {
    return null;
  }
}

/** The element above, across shadow roots. */
function parentAcross(element: Element): Element | null {
  if (element.parentElement) return element.parentElement;
  const root = element.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

function nameOf(element: Element): string {
  const id = element.id ? `#${element.id}` : '';
  const classes =
    typeof element.className === 'string' && element.className.trim()
      ? `.${element.className.trim().split(/\s+/).slice(0, 2).join('.')}`
      : '';
  return `${element.tagName.toLowerCase()}${id}${classes}`;
}

/**
 * What the canvas and every element above it have that changes how it is composited
 * (transform, opacity, will-change, zoom, filter), or [] when none has any.
 */
export function compositingChain(canvas: Element): string[] {
  const found: string[] = [];
  for (let element: Element | null = canvas; element; element = parentAcross(element)) {
    let style: CSSStyleDeclaration;
    try {
      style = getComputedStyle(element);
    } catch {
      continue;
    }
    const parts: string[] = [];
    if (style.transform && style.transform !== 'none') parts.push(`transform ${style.transform}`);
    if (style.opacity && style.opacity !== '1') parts.push(`opacity ${style.opacity}`);
    if (style.willChange && style.willChange !== 'auto')
      parts.push(`will-change ${style.willChange}`);
    const zoom = style.getPropertyValue('zoom');
    if (zoom && zoom !== '1' && zoom !== 'normal') parts.push(`zoom ${zoom}`);
    if (style.filter && style.filter !== 'none') parts.push(`filter ${style.filter}`);
    if (parts.length > 0) found.push(`${nameOf(element)}{${parts.join('; ')}}`);
  }
  return found;
}

/** The page's running animations and transitions, as name@target (playState). */
export function runningAnimations(): string[] {
  try {
    if (typeof document.getAnimations !== 'function') return [];
    return document.getAnimations().map((animation) => {
      const named = animation as Animation & {
        animationName?: string;
        transitionProperty?: string;
      };
      const name = named.animationName ?? named.transitionProperty ?? animation.id ?? 'animation';
      const target = (animation.effect as KeyframeEffect | null)?.target;
      return `${name}@${target ? nameOf(target) : '?'}(${animation.playState})`;
    });
  } catch {
    return [];
  }
}

export interface CanvasReportInput {
  canvas: HTMLCanvasElement;
  cols: number;
  rows: number;
  metrics: CellMetrics | null;
  rendererRatio: unknown;
  fontSize: number | undefined;
  paintHeld: boolean;
  followingPty: string | null;
}

const round = (value: number) => Math.round(value * 100) / 100;

/** One line on the canvas as it is now (see the module's comment), for the log. */
export function describeCanvas(input: CanvasReportInput): string {
  const { canvas, metrics } = input;
  const rect = canvas.getBoundingClientRect();
  const pageRatio = window.devicePixelRatio;
  const viewport = window.visualViewport;
  const ratioMatches = (ratio: number) => {
    try {
      return window.matchMedia(`(resolution: ${ratio}dppx)`).matches;
    } catch {
      return false;
    }
  };
  const mismatch =
    metrics && typeof input.rendererRatio === 'number'
      ? canvasSizeMismatch(canvas, input.cols, input.rows, metrics, input.rendererRatio)
      : null;
  const sharpness = canvasSharpness(canvas);
  const fields = [
    `canvas ${canvas.width}x${canvas.height}`,
    `css ${canvas.style.width} x ${canvas.style.height}`,
    `rect ${round(rect.width)}x${round(rect.height)}`,
    `backing/rect ${rect.width > 0 ? round(canvas.width / rect.width) : '-'}`,
    `dpr ${pageRatio} renderer ${String(input.rendererRatio)}`,
    `${ratioMatches(pageRatio) ? '' : 'no '}match (resolution: ${pageRatio}dppx)`,
    `size mismatch ${mismatch === null ? '?' : mismatch}`,
    `grid ${input.cols}x${input.rows} font ${input.fontSize ?? '?'} cell ${
      metrics ? `${metrics.width}x${metrics.height}` : '?'
    }`,
    `held ${input.paintHeld} pty ${input.followingPty ?? 'own'}`,
    `sharpness ${sharpness === null ? '-' : round(sharpness)}`,
    `viewport scale ${viewport ? round(viewport.scale) : '-'} ${
      viewport ? `${round(viewport.width)}x${round(viewport.height)}` : ''
    }`,
    `visibility ${document.visibilityState}`,
    `layers [${compositingChain(canvas).join(', ')}]`,
    `animations [${runningAnimations().join(', ')}]`,
  ];
  return fields.join(' | ');
}
