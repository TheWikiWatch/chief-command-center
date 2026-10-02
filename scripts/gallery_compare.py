"""Compare a capture gallery with a baseline: how much of each scene changed, with side-by-side sheets of the changes.

    python scripts/gallery_compare.py <baseline dir> <current dir> <sheets dir> [--threshold 1.0]

A pixel counts as changed when any channel moved by more than 40 (anti-aliasing and font hinting stay quiet).
Exits 1 when a scene changed by more than the threshold (percent of its pixels), is missing, or changed size, so
a step that should look the same can be checked; a deliberate visual change is reviewed in the sheets, then made
the new baseline. Galleries are local and never committed (they show the throwaway home, not real data).
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from PIL import Image, ImageChops


def compare(baseline: Path, current: Path, sheets: Path, threshold: float) -> int:
    sheets.mkdir(parents=True, exist_ok=True)
    rows: list[tuple[str, float | None, str]] = []
    for before_file in sorted(baseline.glob("*.png")):
        after_file = current / before_file.name
        if not after_file.exists():
            rows.append((before_file.stem, None, "missing"))
            continue
        before, after = Image.open(before_file).convert("RGB"), Image.open(after_file).convert("RGB")
        if before.size != after.size:
            rows.append((before_file.stem, 100.0, f"size {before.size} -> {after.size}"))
            continue
        mask = ImageChops.difference(before, after).convert("L").point(lambda v: 255 if v > 40 else 0)
        pct = 100.0 * mask.histogram()[255] / (before.size[0] * before.size[1])
        rows.append((before_file.stem, pct, ""))
        if pct > threshold:
            w, h = before.size
            sheet = Image.new("RGB", (w * 3, h))
            sheet.paste(before, (0, 0))
            sheet.paste(after, (w, 0))
            sheet.paste(Image.merge("RGB", (mask, mask.point(lambda v: 0), mask.point(lambda v: 0))), (w * 2, 0))
            scale = 1600 / sheet.size[0]
            sheet.resize((1600, int(sheet.size[1] * scale))).save(sheets / f"{before_file.stem}.png")
    new = sorted(p.stem for p in current.glob("*.png") if not (baseline / p.name).exists())
    failed = 0
    for name, pct, note in sorted(rows, key=lambda r: -(r[1] if r[1] is not None else 101)):
        bad = pct is None or pct > threshold
        failed += bad
        shown = "missing" if pct is None else f"{pct:6.2f}%"
        print(f"{'CHANGED' if bad else 'same   '} {name:40s} {shown} {note}".rstrip())
    for name in new:
        print(f"new     {name}")
    print(f"\n{failed} of {len(rows)} scenes changed beyond {threshold}% (sheets in {sheets})" if failed else f"\nall {len(rows)} scenes look the same")
    return 1 if failed else 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("baseline", type=Path)
    parser.add_argument("current", type=Path)
    parser.add_argument("sheets", type=Path)
    parser.add_argument("--threshold", type=float, default=1.0)
    a = parser.parse_args()
    sys.exit(compare(a.baseline, a.current, a.sheets, a.threshold))
