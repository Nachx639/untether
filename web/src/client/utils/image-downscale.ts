/**
 * Client-side downscale + re-encode for image attachments.
 *
 * Phone photos are 3–12 MB and 4000+ px on the long side; Claude Code never needs
 * that much, and uploading them over a phone link is slow. Large images are drawn
 * to a canvas at most `maxDimension` px on the long side and exported as JPEG.
 * PNGs with real transparency stay PNG. Anything we cannot decode (or that would
 * not get smaller) is returned untouched, so the upload always proceeds.
 */

export interface DownscaleOptions {
  /** Longest side in px after scaling (never upscales). */
  maxDimension?: number;
  /** Files at or below this size whose long side already fits are left alone. */
  maxBytes?: number;
  /** JPEG quality 0–1. */
  quality?: number;
}

export const DEFAULT_MAX_DIMENSION = 2000;
export const DEFAULT_MAX_BYTES = 1.5 * 1024 * 1024;
export const DEFAULT_JPEG_QUALITY = 0.85;

/** Formats we must not flatten: animation would be lost, vectors are already small. */
const PASSTHROUGH_TYPES = new Set(['image/gif', 'image/svg+xml']);

interface DecodedImage {
  source: CanvasImageSource;
  width: number;
  height: number;
  close: () => void;
}

async function decodeImage(file: Blob): Promise<DecodedImage | null> {
  if (typeof createImageBitmap === 'function') {
    try {
      // Bake the EXIF rotation in so portrait phone photos don't arrive sideways.
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        close: () => bitmap.close(),
      };
    } catch {
      // Older engines reject the options bag or the format; try an <img> below.
    }
  }

  if (typeof Image === 'undefined' || typeof URL?.createObjectURL !== 'function') return null;
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const width = img.naturalWidth;
    const height = img.naturalHeight;
    if (!width || !height) return null;
    return { source: img, width, height, close: () => {} };
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function hasTransparency(ctx: CanvasRenderingContext2D, width: number, height: number): boolean {
  const { data } = ctx.getImageData(0, 0, width, height);
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 255) return true;
  }
  return false;
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number) {
  return new Promise<Blob | null>((resolve) => {
    try {
      canvas.toBlob(resolve, type, quality);
    } catch {
      resolve(null);
    }
  });
}

function renamed(name: string, type: string): string {
  const ext = type === 'image/png' ? 'png' : 'jpg';
  const base = name.replace(/\.[^./\\]+$/, '') || 'image';
  return `${base}.${ext}`;
}

/**
 * Returns a smaller copy of `file` when it is a large raster image, otherwise `file` itself.
 * Never throws.
 */
export async function prepareImageForUpload(
  file: File,
  options: DownscaleOptions = {}
): Promise<File> {
  const maxDimension = options.maxDimension ?? DEFAULT_MAX_DIMENSION;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const quality = options.quality ?? DEFAULT_JPEG_QUALITY;

  if (!file.type.startsWith('image/') || PASSTHROUGH_TYPES.has(file.type)) return file;

  const decoded = await decodeImage(file);
  if (!decoded) return file;

  try {
    const longSide = Math.max(decoded.width, decoded.height);
    if (longSide <= maxDimension && file.size <= maxBytes) return file;

    const scale = Math.min(1, maxDimension / longSide);
    const width = Math.max(1, Math.round(decoded.width * scale));
    const height = Math.max(1, Math.round(decoded.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(decoded.source, 0, 0, width, height);

    const keepPng = file.type === 'image/png' && hasTransparency(ctx, width, height);
    const type = keepPng ? 'image/png' : 'image/jpeg';
    const blob = await canvasToBlob(canvas, type, quality);
    if (!blob || blob.size === 0 || blob.size >= file.size) return file;

    return new File([blob], renamed(file.name, type), {
      type,
      lastModified: file.lastModified,
    });
  } catch {
    return file;
  } finally {
    decoded.close();
  }
}
