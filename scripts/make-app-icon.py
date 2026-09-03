#!/usr/bin/env python3
"""
The app icon, from the artwork as it arrives to the file Xcode ships.

    python3 scripts/make-app-icon.py design/app-icon-source.png \
        ios/Basu/Assets.xcassets/AppIcon.appiconset/AppIcon.png \
        --figure 128,242,900,1428

Three things have to be done to artwork that was not drawn to iOS's frame, and
all three are easy to get wrong by eye:

1. **Take off any rounded corners it came with.** iOS masks the icon itself.
   Art that arrives pre-rounded on white gets rounded twice and every corner
   keeps a white crescent. The white frame is cropped away and the ground run
   out to the edges — sideways, because this ground is a photograph in
   horizontal bands: stands over track over grass. A flat radial gradient would
   want the opposite, extended along the radius, or its rays get dragged
   sideways and cut off.

2. **Compose for 60 points, not for 1024.** Nobody sees this at 1024. The
   figure is measured rather than guessed at, and placed to fill most of the
   tile with real room above the head. A crown against the top edge is what
   "the head is cut off" looks like before anybody can say why.

3. **Take that room from the artwork, not from padding.** A tall photograph has
   sky above the figure and grass below it; a square already cropped to the
   figure has neither, and no amount of repeating a row invents it. Feed this
   the tallest version of the art there is.

`--figure x0,y0,x1,y1` gives the figure's bounding box for when the background
defeats the built-in guess — a blurred crowd is full of white shirts, and the
sticker's white outline is not the only pale thing in the frame. Measure it
with Vision rather than by eye; `scripts/lift-subject.swift` uses the same
request and its cut-out's size is the figure's size.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
from PIL import Image

# A white frame is pale and colourless; a photograph's bands are not.
PALE_MIN = 212
PALE_CHROMA = 26

# How far inside its own edge to sample when running the ground outward. The
# artwork draws a lighter rim along that edge, and this steps past it.
INSET = 22

# What the finished tile should look like: the figure this tall, standing this
# far down. Both give way to whatever the picture can actually afford.
FIGURE_SHARE = 0.87
HEADROOM = 0.08


def pale(a: np.ndarray) -> np.ndarray:
    return (a.min(axis=2) > PALE_MIN) & (a.max(axis=2) - a.min(axis=2) < PALE_CHROMA)


def framed(a: np.ndarray) -> bool:
    """A white margin all the way round means the art brought its own frame."""
    edge = pale(a)
    return bool(edge[0].all() and edge[-1].all() and edge[:, 0].all() and edge[:, -1].all())


def unframe(a: np.ndarray) -> np.ndarray:
    """Crop to the artwork, then run each row out over its own rounded corner."""
    ys, xs = np.where(~pale(a))
    out = a[ys.min() : ys.max() + 1, xs.min() : xs.max() + 1].copy()
    blank = pale(out)
    h, w = out.shape[:2]
    for y in range(h):
        inside = np.flatnonzero(~blank[y])
        if inside.size == 0:
            continue
        # Overwrite from *inside* the edge: leaving the rim in place is what
        # puts a ghost rounded rectangle in the middle of the finished tile.
        left = min(inside.min() + INSET, inside.max())
        right = max(inside.max() - INSET, inside.min())
        out[y, : left + 1] = out[y, left]
        out[y, right:] = out[y, right]
    return out


def guess_figure(a: np.ndarray) -> tuple[int, int, int, int]:
    """The sticker's white outline, when nothing else in frame is that pale."""
    h, w = a.shape[:2]
    m = int(w * 0.04)
    ys, xs = np.where(pale(a)[m : h - m, m : w - m])
    if ys.size == 0:
        raise SystemExit("no figure found — pass --figure x0,y0,x1,y1")
    return xs.min() + m, ys.min() + m, xs.max() + m, ys.max() + m


def widen(a: np.ndarray, to: int) -> np.ndarray:
    """
    Pad out to a square from the artwork's own edge columns.

    Only ever blurred stand and grass out here, which is the one thing in a
    photograph that repeats without a seam. Everything the figure needs
    vertically is taken from the picture; only the sides are ever invented.
    """
    w = a.shape[1]
    if w >= to:
        return a
    pad = to - w
    left = np.repeat(a[:, :1], pad // 2, axis=1)
    right = np.repeat(a[:, -1:], pad - pad // 2, axis=1)
    return np.hstack([left, a, right])


def build(source: Path, target: Path, figure: tuple[int, int, int, int] | None, size: int) -> None:
    a = np.asarray(Image.open(source).convert("RGB")).astype(np.int16)
    if framed(a):
        a = unframe(a)
    h, w = a.shape[:2]
    fx0, fy0, fx1, fy1 = figure or guess_figure(a)
    tall = fy1 - fy0

    # Ask for the composition we want, then give way to what the picture has:
    # the crop can start no higher than the top of the image and end no lower
    # than its bottom, and it can never be shorter than the figure itself.
    side = int(tall / FIGURE_SHARE)
    side = min(side, int((h - fy0) / (1 - HEADROOM)), int(fy0 / HEADROOM) + tall)
    side = max(side, tall)
    y0 = min(max(fy0 - int(side * HEADROOM), 0), h - side)
    a = widen(a[y0 : y0 + side], side)

    icon = Image.fromarray(a.astype("uint8")).convert("RGB")
    # No alpha: the App Store refuses a transparent icon and the simulator
    # renders one black.
    icon.resize((size, size), Image.LANCZOS).save(target)
    print(
        f"{target}  {size}×{size}  "
        f"figure {round(100 * tall / side)}% of the tile, "
        f"{round(100 * (fy0 - y0) / side)}% above the head, "
        f"{round(100 * (y0 + side - fy1) / side)}% below the boots, "
        f"{round(100 * max(0, side - w) / 2 / side)}% invented at each side",
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("source", type=Path)
    parser.add_argument("target", type=Path)
    parser.add_argument("--figure", help="x0,y0,x1,y1 of the figure, when the guess fails")
    parser.add_argument("--size", type=int, default=1024)
    args = parser.parse_args()
    box = tuple(int(n) for n in args.figure.split(",")) if args.figure else None
    build(args.source, args.target, box, args.size)  # type: ignore[arg-type]
