#!/usr/bin/env python3
"""
Splits Hack Nerd Font Mono into WOFF2 files a browser fetches only when it draws their
characters (2026-10-04, docs/cold-start.md).

The source fonts (fonts-src/HackNerdFontMono-{Regular,Bold}.ttf, Nerd Fonts' Hack, 2.6 MB
each) are mostly icons in Private Use code points. Per weight this writes, into
src/client/assets/fonts/ (copied to public/fonts/ by the build):

  hack-core-<weight>.woff2   everything outside Private Use, plus Powerline U+E0A0-E0D7
                             (prompts draw those all the time): ~100 KB
  hack-pua-<weight>.woff2    the rest of U+E000-F8FF (devicons, Font Awesome, codicons...)
  hack-spua-<weight>.woff2   U+F0000-10FFFF (Material Design, nf-md-*)

styles.css declares the three under one family with the matching `unicode-range` (CSS_RANGES
below; src/client/terminal-fonts.test.ts holds the two in step). Layout features, hinting,
metrics, the whole name table and the .notdef outline are kept; the output is byte for byte
reproducible (no timestamp is rewritten).

Run with the QA venv (fonttools 4.60 + brotli), never the system Python:

  ~/.untether-qa/tools/venv/bin/python scripts/build-terminal-fonts.py          # build
  ~/.untether-qa/tools/venv/bin/python scripts/build-terminal-fonts.py --check  # verify

--check rebuilds nothing: it reads the committed WOFF2 files back and checks that each one's
cmap stays inside its range, that together they map every code point of the source exactly
once, and that every glyph keeps the source's advance width.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont

WEB = Path(__file__).resolve().parent.parent
SOURCE_DIR = WEB / "fonts-src"
OUT_DIR = WEB / "src" / "client" / "assets" / "fonts"
WEIGHTS = {"regular": "HackNerdFontMono-Regular.ttf", "bold": "HackNerdFontMono-Bold.ttf"}

# Inclusive code point ranges per part; together they cover U+0000-10FFFF once.
PARTS: dict[str, list[tuple[int, int]]] = {
    "core": [(0x0000, 0xDFFF), (0xE0A0, 0xE0D7), (0xF900, 0xEFFFF)],
    "pua": [(0xE000, 0xE09F), (0xE0D8, 0xF8FF)],
    "spua": [(0xF0000, 0x10FFFF)],
}


def css_range(ranges: list[tuple[int, int]]) -> str:
    return ", ".join(f"U+{a:X}-{b:X}" for a, b in ranges)


def in_part(cp: int, part: str) -> bool:
    return any(a <= cp <= b for a, b in PARTS[part])


def options() -> subset.Options:
    o = subset.Options()
    o.flavor = "woff2"
    o.layout_features = ["*"]
    o.name_IDs = ["*"]
    o.name_languages = ["*"]
    o.name_legacy = True
    o.notdef_outline = True
    o.hinting = True
    o.recalc_timestamp = False
    return o


def build() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for weight, filename in WEIGHTS.items():
        source = TTFont(SOURCE_DIR / filename)
        cmap = source.getBestCmap()
        for part in PARTS:
            unicodes = [cp for cp in cmap if in_part(cp, part)]
            o = options()
            font = subset.load_font(str(SOURCE_DIR / filename), o)
            subsetter = subset.Subsetter(options=o)
            subsetter.populate(unicodes=unicodes)
            subsetter.subset(font)
            out = OUT_DIR / f"hack-{part}-{weight}.woff2"
            subset.save_font(font, str(out), o)
            print(f"{out.relative_to(WEB)}: {len(unicodes)} code points, {out.stat().st_size} bytes")
    print()
    for part, ranges in PARTS.items():
        print(f"unicode-range {part}: {css_range(ranges)}")


def check() -> int:
    errors: list[str] = []
    for weight, filename in WEIGHTS.items():
        source = TTFont(SOURCE_DIR / filename)
        source_cmap = source.getBestCmap()
        source_hmtx = source["hmtx"].metrics
        seen: dict[int, str] = {}
        for part in PARTS:
            path = OUT_DIR / f"hack-{part}-{weight}.woff2"
            font = TTFont(path)
            cmap = font.getBestCmap()
            hmtx = font["hmtx"].metrics
            if font.getGlyphOrder()[0] != ".notdef":
                errors.append(f"{path.name}: no .notdef first")
            for cp, glyph in cmap.items():
                if not in_part(cp, part):
                    errors.append(f"{path.name}: U+{cp:04X} outside its range")
                if cp in seen:
                    errors.append(f"{path.name}: U+{cp:04X} also in {seen[cp]}")
                seen[cp] = path.name
                if cp not in source_cmap:
                    errors.append(f"{path.name}: U+{cp:04X} not in the source")
                elif hmtx[glyph][0] != source_hmtx[source_cmap[cp]][0]:
                    errors.append(f"{path.name}: U+{cp:04X} advance changed")
            for feature_table in ("GSUB", "GPOS"):
                if feature_table in source and feature_table not in font and part == "core":
                    errors.append(f"{path.name}: {feature_table} dropped")
        missing = sorted(set(source_cmap) - set(seen))
        if missing:
            errors.append(f"{weight}: {len(missing)} code points lost, first U+{missing[0]:04X}")
        print(f"{weight}: {len(seen)} of {len(source_cmap)} code points, each in one file")
    for error in errors[:50]:
        print(f"ERROR {error}", file=sys.stderr)
    return 1 if errors else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--check", action="store_true", help="verify the committed files")
    args = parser.parse_args()
    if args.check:
        return check()
    build()
    return check()


if __name__ == "__main__":
    sys.exit(main())
