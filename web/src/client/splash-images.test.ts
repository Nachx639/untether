import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Launch images of the home-screen app (scripts/build-splash-images.py; its --check verifies
// the bytes). iOS shows one only on an exact match of the screen, so each link must name a
// file of exactly that size.
const assets = join(__dirname, 'assets');
const html = readFileSync(join(assets, 'index.html'), 'utf8');
const links = [
  ...html.matchAll(
    /<link rel="apple-touch-startup-image" media="([^"]+)" href="\/splash\/([^"]+)" \/>/g
  ),
].map(([, media, file]) => ({ media, file }));

function pngSize(file: string): [number, number] {
  const data = readFileSync(join(assets, 'splash', file));
  return [data.readUInt32BE(16), data.readUInt32BE(20)];
}

describe('launch images', () => {
  it('link every image once, and only images that exist', () => {
    const files = readdirSync(join(assets, 'splash')).sort();
    expect(links.map((link) => link.file).sort()).toEqual(files);
    expect(files.length).toBeGreaterThan(0);
  });

  it('match the screen each one is for, in pixels and orientation', () => {
    for (const { media, file } of links) {
      const width = Number(/device-width: (\d+)px/.exec(media)?.[1]);
      const height = Number(/device-height: (\d+)px/.exec(media)?.[1]);
      const ratio = Number(/-webkit-device-pixel-ratio: (\d)/.exec(media)?.[1]);
      const landscape = media.includes('(orientation: landscape)');
      const expected = landscape
        ? [height * ratio, width * ratio]
        : [width * ratio, height * ratio];
      expect(pngSize(file), file).toEqual(expected);
      expect(file).toBe(
        `${expected[0]}x${expected[1]}-${media.includes('dark') ? 'dark' : 'light'}.png`
      );
    }
  });

  it('cover the iPhone SE and the 440 pt Pro Max, light and dark', () => {
    const media = links.map((link) => link.media);
    for (const [w, h, r] of [
      [375, 667, 2],
      [440, 956, 3],
    ]) {
      const screen = `(device-width: ${w}px) and (device-height: ${h}px) and (-webkit-device-pixel-ratio: ${r}) and (orientation: portrait)`;
      expect(media).toContain(screen);
      expect(media).toContain(`${screen} and (prefers-color-scheme: dark)`);
    }
  });

  it('put the dark ones first, so a dark screen takes them before the unconditional light ones', () => {
    const firstLight = links.findIndex((link) => !link.media.includes('dark'));
    expect(links.slice(firstLight).every((link) => !link.media.includes('dark'))).toBe(true);
  });
});
