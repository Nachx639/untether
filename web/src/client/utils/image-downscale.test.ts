// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareImageForUpload } from './image-downscale';

const MB = 1024 * 1024;

function fakeFile(name: string, type: string, size: number): File {
  return new File([new Uint8Array(size)], name, { type, lastModified: 1234 });
}

interface FakeCanvas {
  width: number;
  height: number;
  getContext: () => unknown;
  toBlob: (cb: (b: Blob | null) => void, type: string, quality: number) => void;
}

let canvases: FakeCanvas[];
let drawn: Array<{ width: number; height: number }>;
let exported: Array<{ type: string; quality: number }>;
let alpha: number;
let outputSize: number;
let bitmapSize: { width: number; height: number };
let bitmapOptions: unknown[];

beforeEach(() => {
  canvases = [];
  drawn = [];
  exported = [];
  alpha = 255;
  outputSize = 300 * 1024;
  bitmapSize = { width: 4032, height: 3024 };
  bitmapOptions = [];

  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async (_blob: Blob, options?: unknown) => {
      bitmapOptions.push(options);
      return { ...bitmapSize, close: vi.fn() };
    })
  );

  const realCreate = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
    if (tag !== 'canvas') return realCreate(tag);
    const canvas: FakeCanvas = {
      width: 0,
      height: 0,
      getContext: () => ({
        imageSmoothingQuality: 'low',
        drawImage: (_src: unknown, _x: number, _y: number, width: number, height: number) =>
          drawn.push({ width, height }),
        getImageData: (_x: number, _y: number, w: number, h: number) => {
          const data = new Uint8ClampedArray(w * h * 4).fill(255);
          data[3] = alpha;
          return { data };
        },
      }),
      toBlob: (cb, type, quality) => {
        exported.push({ type, quality });
        cb(new Blob([new Uint8Array(outputSize)], { type }));
      },
    };
    canvases.push(canvas);
    return canvas as unknown as HTMLElement;
  }) as typeof document.createElement);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('prepareImageForUpload', () => {
  it('scales a 12 MP phone photo to 2000px and re-encodes it as JPEG 0.85', async () => {
    const original = fakeFile('IMG_0001.HEIC', 'image/heic', 6 * MB);

    const result = await prepareImageForUpload(original);

    expect(bitmapOptions[0]).toEqual({ imageOrientation: 'from-image' });
    expect(drawn).toEqual([{ width: 2000, height: 1500 }]);
    expect(exported).toEqual([{ type: 'image/jpeg', quality: 0.85 }]);
    expect(result).not.toBe(original);
    expect(result.name).toBe('IMG_0001.jpg');
    expect(result.type).toBe('image/jpeg');
    expect(result.size).toBe(outputSize);
  });

  it('re-encodes an oversized file without upscaling it', async () => {
    bitmapSize = { width: 1200, height: 800 };
    const original = fakeFile('scan.jpg', 'image/jpeg', 3 * MB);

    const result = await prepareImageForUpload(original);

    expect(drawn).toEqual([{ width: 1200, height: 800 }]);
    expect(result.size).toBe(outputSize);
  });

  it('leaves small images alone', async () => {
    bitmapSize = { width: 800, height: 600 };
    const original = fakeFile('shot.png', 'image/png', 400 * 1024);

    expect(await prepareImageForUpload(original)).toBe(original);
    expect(canvases).toHaveLength(0);
  });

  it('keeps PNG for screenshots with transparency', async () => {
    bitmapSize = { width: 2532, height: 1170 };
    alpha = 0;
    const original = fakeFile('Screenshot.png', 'image/png', 2 * MB);

    const result = await prepareImageForUpload(original);

    expect(exported[0].type).toBe('image/png');
    expect(result.name).toBe('Screenshot.png');
  });

  it('turns an opaque large PNG into JPEG', async () => {
    bitmapSize = { width: 2532, height: 1170 };
    const original = fakeFile('Screenshot.png', 'image/png', 2 * MB);

    const result = await prepareImageForUpload(original);

    expect(exported[0].type).toBe('image/jpeg');
    expect(result.name).toBe('Screenshot.jpg');
  });

  it('falls back to the original when the browser cannot decode it', async () => {
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => {
        throw new Error('unsupported');
      })
    );
    vi.stubGlobal('Image', undefined);
    const original = fakeFile('IMG.HEIC', 'image/heic', 6 * MB);

    expect(await prepareImageForUpload(original)).toBe(original);
  });

  it('keeps the original if the re-encode is not smaller', async () => {
    outputSize = 7 * MB;
    const original = fakeFile('IMG.jpg', 'image/jpeg', 6 * MB);

    expect(await prepareImageForUpload(original)).toBe(original);
  });

  it('passes GIFs and non-images through untouched', async () => {
    const gif = fakeFile('anim.gif', 'image/gif', 5 * MB);
    const pdf = fakeFile('doc.pdf', 'application/pdf', 5 * MB);

    expect(await prepareImageForUpload(gif)).toBe(gif);
    expect(await prepareImageForUpload(pdf)).toBe(pdf);
    expect(bitmapOptions).toHaveLength(0);
  });
});
