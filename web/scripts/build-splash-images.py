#!/usr/bin/env python3
"""
Launch images for the home-screen app on iPhone and iPad (2026-10-04, docs/cold-start.md).

A cold start of the installed app showed iOS's black launch screen and then about 3 s of
plain white web view while iOS started the standalone WebKit process, before the page was
even requested: the app's own startup line read "html 36 ms, first paint 76 ms" from the
navigation, so nothing in the page could shorten it. iOS shows an `apple-touch-startup-image`
over that time when one matches the screen exactly. These are the boot screen of index.html:
the app icon (icon-512.png at 64 pt, corner radius 15 pt) on the theme's first-frame background (#fafafa
light, #0a0a0a dark, as theme-init.js), placed where #ut-boot draws it (its spinner and gap
below put the icon 21 pt above the centre).

This writes, for every screen in SCREENS, portrait and landscape, light and dark:

  src/client/assets/splash/<width>x<height>-<light|dark>.png    (pixels; copied to public/)

as palette PNGs (flat background, the icon quantized to 255 colours), and rewrites the
<link rel="apple-touch-startup-image"> block of src/client/assets/index.html between its
splash markers. Dark first, with `(prefers-color-scheme: dark)`; light after, without it, so
a dark screen takes the dark one and anything else (or an iOS that ignores the condition)
the light one. The service worker doesn't cache them (sw-shell.ts): iOS reads them itself.

Byte for byte reproducible. Run with the QA venv (Pillow), never the system Python:

  ~/.untether-qa/tools/venv/bin/python scripts/build-splash-images.py          # build
  ~/.untether-qa/tools/venv/bin/python scripts/build-splash-images.py --check  # verify

--check writes nothing: it fails when a committed image or the index.html block differs
from what a build would write, or when splash/ holds a file no screen uses.
"""

from __future__ import annotations

import argparse
import io
import sys
from pathlib import Path

from PIL import Image, ImageDraw

WEB = Path(__file__).resolve().parent.parent
ASSETS = WEB / "src" / "client" / "assets"
OUT_DIR = ASSETS / "splash"
ICON = ASSETS / "icon-512.png"
INDEX = ASSETS / "index.html"
START = "<!-- splash:start (scripts/build-splash-images.py) -->"
END = "<!-- splash:end -->"

ICON_PT = 64
ICON_RADIUS_PT = 15
# #ut-boot: icon 64 + gap 20 + spinner 22, centred as a column -> icon centre 21 pt up.
ICON_RAISE_PT = 21
THEMES = {"light": (0xFA, 0xFA, 0xFA), "dark": (0x0A, 0x0A, 0x0A)}

# Portrait CSS size (pt) and pixel ratio of each screen. iOS picks an image only on an exact
# match of device-width, device-height and ratio; models sharing one are listed together.
SCREENS: list[tuple[int, int, int, str]] = [
    # iPhone
    (375, 667, 2, "iPhone SE 2nd/3rd gen, 8, 7, 6s"),
    (414, 736, 3, "iPhone 8 Plus, 7 Plus"),
    (375, 812, 3, "iPhone X, XS, 11 Pro, 12 mini, 13 mini"),
    (414, 896, 2, "iPhone XR, 11"),
    (414, 896, 3, "iPhone XS Max, 11 Pro Max"),
    (390, 844, 3, "iPhone 12, 12 Pro, 13, 13 Pro, 14, 16e"),
    (428, 926, 3, "iPhone 12 Pro Max, 13 Pro Max, 14 Plus"),
    (393, 852, 3, "iPhone 14 Pro, 15, 15 Pro, 16"),
    (430, 932, 3, "iPhone 14 Pro Max, 15 Plus, 15 Pro Max, 16 Plus"),
    (402, 874, 3, "iPhone 16 Pro, 17, 17 Pro"),
    (440, 956, 3, "iPhone 16 Pro Max, 17 Pro Max"),
    (420, 912, 3, "iPhone Air"),
    # iPad
    (744, 1133, 2, "iPad mini 6th/7th gen"),
    (810, 1080, 2, "iPad 7th-9th gen"),
    (820, 1180, 2, "iPad 10th gen, A16, Air 4th/5th gen, Air 11-inch"),
    (834, 1112, 2, "iPad Air 3rd gen, Pro 10.5-inch"),
    (834, 1194, 2, "iPad Pro 11-inch 1st-4th gen"),
    (834, 1210, 2, "iPad Pro 11-inch M4/M5"),
    (1024, 1366, 2, "iPad Pro 12.9-inch, Air 13-inch"),
    (1032, 1376, 2, "iPad Pro 13-inch M4/M5"),
]


def rounded_icon(source: Image.Image, size: int, radius: int) -> Image.Image:
    """The icon at `size` px with the boot screen's rounded corners (antialiased mask)."""
    icon = source.convert("RGB").resize((size, size), Image.Resampling.LANCZOS)
    scale = 4
    mask = Image.new("L", (size * scale, size * scale), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, size * scale - 1, size * scale - 1), radius=radius * scale, fill=255
    )
    mask = mask.resize((size, size), Image.Resampling.LANCZOS)
    out = icon.convert("RGBA")
    out.putalpha(mask)
    return out


def render(source: Image.Image, width: int, height: int, ratio: int, theme: str) -> bytes:
    background = THEMES[theme]
    size = ICON_PT * ratio
    icon = rounded_icon(source, size, ICON_RADIUS_PT * ratio)
    tile = Image.new("RGB", (size, size), background)
    tile.paste(icon, (0, 0), icon)
    # The icon in 255 colours; index 255 is the background, exactly.
    quantized = tile.quantize(colors=255, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    palette = (quantized.getpalette() or [])[: 255 * 3]
    palette += [0] * (255 * 3 - len(palette)) + list(background)
    image = Image.new("P", (width, height), 255)
    image.putpalette(palette)
    quantized.putpalette(palette)
    left = (width - size) // 2
    top = (height - size) // 2 - ICON_RAISE_PT * ratio
    image.paste(quantized, (left, top))
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    return buffer.getvalue()


def outputs() -> tuple[dict[str, tuple[int, int, int, str]], str]:
    """File name -> (pixel width, pixel height, ratio, theme), and the index.html block."""
    files: dict[str, tuple[int, int, int, str]] = {}
    links: list[str] = []
    for theme in ("dark", "light"):
        for width_pt, height_pt, ratio, models in SCREENS:
            for orientation in ("portrait", "landscape"):
                w, h = width_pt * ratio, height_pt * ratio
                if orientation == "landscape":
                    w, h = h, w
                name = f"{w}x{h}-{theme}.png"
                files[name] = (w, h, ratio, theme)
                media = (
                    f"(device-width: {width_pt}px) and (device-height: {height_pt}px) and "
                    f"(-webkit-device-pixel-ratio: {ratio}) and (orientation: {orientation})"
                )
                if theme == "dark":
                    media += " and (prefers-color-scheme: dark)"
                links.append(
                    f'    <link rel="apple-touch-startup-image" media="{media}" '
                    f'href="/splash/{name}" />'
                )
    block = "\n".join([f"    {START}", *links, f"    {END}"])
    return files, block


def with_block(html: str, block: str) -> str:
    start = html.index(f"    {START}")
    end = html.index(END, start) + len(END)
    return html[:start] + block + html[end:]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--check", action="store_true", help="verify, write nothing")
    args = parser.parse_args()

    source = Image.open(ICON)
    files, block = outputs()
    html = INDEX.read_text(encoding="utf-8")
    new_html = with_block(html, block)
    problems: list[str] = []
    total = 0

    if not args.check:
        OUT_DIR.mkdir(parents=True, exist_ok=True)
    for name, (w, h, ratio, theme) in files.items():
        data = render(source, w, h, ratio, theme)
        total += len(data)
        path = OUT_DIR / name
        if args.check:
            if not path.exists() or path.read_bytes() != data:
                problems.append(f"{name} differs from a fresh build")
        else:
            path.write_bytes(data)
    stray = sorted(p.name for p in OUT_DIR.glob("*") if p.name not in files) if OUT_DIR.exists() else []
    if args.check:
        problems += [f"{name} is used by no screen" for name in stray]
        if new_html != html:
            problems.append("index.html's splash block differs from a fresh build")
    else:
        for name in stray:
            (OUT_DIR / name).unlink()
        INDEX.write_text(new_html, encoding="utf-8")

    for problem in problems:
        print(f"splash: {problem}", file=sys.stderr)
    print(f"splash: {len(files)} images, {total:,} bytes{' (check)' if args.check else ''}")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
