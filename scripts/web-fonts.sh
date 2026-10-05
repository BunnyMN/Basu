#!/usr/bin/env bash
#
# The web's six font files, cut from the ones the iOS app bundles.
#
# Since 2026-10-05 («Тансаг хар») Basu speaks in two faces: Manrope for
# reading (400/500/600/700) and Noto Sans Display Condensed for headings,
# prices and big numbers (700/800). ios/Fonts/*.ttf are static instances of
# Google's variable fonts (Manrope[wght], NotoSansDisplay[wdth,wght] at wdth
# 62.5), already cut to the characters below, with their family and style
# names set so iOS finds them by PostScript name. A page only ever prints
# Mongolian, Russian and English words, digits, ₮ and some punctuation; the
# web gets the same faces with every OpenType feature kept (tabular digits,
# kerning). A character outside the list is drawn by the next font in the
# stack (--display/--sans in app.css): Noto Sans Display has no «≈», which
# Manrope draws.
#
# The files are served for a year and never asked about again (see
# cacheControl in src/api/webFiles.ts), so a cut is never changed under its
# name: change UNICODES, raise VERSION, run this, point the @font-face rules
# in src/web/app.css at the new names and delete the old files.
#
#   python3 -m pip install fonttools brotli    # once
#   scripts/web-fonts.sh
#
# The glyph names stay (--glyph-names, about a kilobyte a file): a cut
# without them draws 12–16px text on a Mac a hair differently at 1x — the
# same outlines, rasterized a fraction of a pixel apart — and with them it
# is the same image, pixel for pixel.
#
# PYTHON names another interpreter, a virtualenv's for one.
set -euo pipefail

VERSION=v3
FACES="Manrope-Regular Manrope-Medium Manrope-SemiBold Manrope-Bold NotoSansDisplay-CondensedBold NotoSansDisplay-CondensedExtraBold"
# Basic Latin, Latin-1 (« » × · ° and the like), Cyrillic with Mongolian's
# Ө Ү, the Kazakh and Buryat letters a supplier from the west may sign
# with (Ғ Қ Ң Ұ Һ Ә), general punctuation (– — … “ ” „ thin and narrow
# spaces), € ₮ № ™, the four arrows, the minus sign, ≈ ≤ ≥, and the ● ✓ ✗
# the pages and letters print.
UNICODES="U+0020-007E,U+00A0-00FF,U+0400-045F,U+0490-0493,U+049A-049B,U+04A2-04A3,U+04AE-04B1,U+04BA-04BB,U+04D8-04D9,U+04E8-04E9,U+2000-206F,U+20AC,U+20AE,U+2116,U+2122,U+2190-2193,U+2212,U+2248,U+2264-2265,U+25CF,U+2713,U+2717"

PYTHON=${PYTHON:-python3}
cd "$(dirname "$0")/.."
if ! "$PYTHON" -c 'import fontTools.subset, brotli' 2>/dev/null; then
  echo "✗ $PYTHON has no fontTools or brotli: python3 -m pip install fonttools brotli" >&2
  exit 1
fi

for face in $FACES; do
  out="src/web/fonts/$face.$VERSION.woff2"
  "$PYTHON" -m fontTools.subset "ios/Fonts/$face.ttf" \
    --unicodes="$UNICODES" \
    --layout-features='*' \
    --name-IDs='*' --name-languages='*' --name-legacy \
    --notdef-outline \
    --glyph-names \
    --flavor=woff2 \
    --output-file="$out"
  echo "$out $(wc -c < "$out" | tr -d ' ') bytes (from $(wc -c < "ios/Fonts/$face.ttf" | tr -d ' ') in ios/Fonts)"
done
