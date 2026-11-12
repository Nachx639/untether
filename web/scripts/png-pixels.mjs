// Decoding of the PNGs Playwright writes, shared by ui-shots.mjs and ui-shots-diff.mjs. No
// dependency: only what those two need (8 bits per channel, not interlaced, RGB or RGBA).
import zlib from 'node:zlib';

/** RGBA pixels of a PNG as Playwright writes it (8 bits, not interlaced). */
export function pngPixels(png) {
  const width = png.readUInt32BE(16);
  const colorType = png[25];
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (png[24] !== 8 || !channels || png[28] !== 0) throw new Error('unexpected PNG format');
  const parts = [];
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at);
    if (png.toString('latin1', at + 4, at + 8) === 'IDAT') parts.push(png.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = zlib.inflateSync(Buffer.concat(parts));
  const stride = width * channels;
  const out = Buffer.alloc((raw.length / (stride + 1)) * stride);
  for (let row = 0; row * (stride + 1) < raw.length; row++) {
    const filter = raw[row * (stride + 1)];
    const line = row * stride;
    for (let x = 0; x < stride; x++) {
      const value = raw[row * (stride + 1) + 1 + x];
      const a = x >= channels ? out[line + x - channels] : 0;
      const b = row ? out[line - stride + x] : 0;
      const c = row && x >= channels ? out[line - stride + x - channels] : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      const paeth = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      const predicted = [0, a, b, (a + b) >> 1, paeth][filter];
      out[line + x] = value + predicted;
    }
  }
  return { pixels: out, channels, width, height: out.length / stride };
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(zlib.crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** A PNG (8 bits, RGB or RGBA, no filter) from raw pixels: the diff's picture of what changed. */
export function encodePng({ pixels, channels, width, height }) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = channels === 4 ? 6 : 2;
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let row = 0; row < height; row++) {
    pixels.copy(raw, row * (stride + 1) + 1, row * stride, (row + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
