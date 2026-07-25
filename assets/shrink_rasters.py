"""Shrink the raster assets in place.

The Sparkol hand PNGs ship at ~1200px tall, which is more than a 1080p canvas
ever needs - a drawing hand occupies roughly half the frame height, so ~800px
leaves plenty of headroom while cutting the set by about 60%.

Resampling is LANCZOS and the alpha channel is preserved, so the transparent
cutout still composites cleanly. Originals are re-downloadable with
`sparkol/fetch_library.py full <group>`, so this rewrites files in place rather
than keeping a second copy.

Usage:
  python3 shrink_rasters.py --dry-run           # report only
  python3 shrink_rasters.py                     # apply, default max height 800
  python3 shrink_rasters.py --max-height 1000
"""
import glob
import io
import os
import sys

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))


def targets() -> list:
    hands = [f for f in glob.glob(os.path.join(HERE, "sparkol", "*", "*.png"))
             if os.sep + "thumbs" + os.sep not in f]
    # assets/hand/ is the set hand.ts actually loads
    hands += glob.glob(os.path.join(HERE, "hand", "*.png"))
    return sorted(hands)


def shrink(path: str, max_h: int, dry: bool) -> tuple:
    before = os.path.getsize(path)
    im = Image.open(path)
    w, h = im.size
    if h > max_h:
        im = im.resize((max(1, round(w * max_h / h)), max_h), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, "PNG", optimize=True)
    after = buf.tell()
    if after >= before:
        return before, before  # already smaller than what we'd write
    if not dry:
        with open(path, "wb") as fh:
            fh.write(buf.getvalue())
    return before, after


def main() -> None:
    dry = "--dry-run" in sys.argv
    max_h = 800
    if "--max-height" in sys.argv:
        max_h = int(sys.argv[sys.argv.index("--max-height") + 1])

    files = targets()
    tb = ta = 0
    for f in files:
        b, a = shrink(f, max_h, dry)
        tb += b
        ta += a
    verb = "would save" if dry else "saved"
    print(f"{len(files)} PNGs  {tb/1e6:.1f}MB -> {ta/1e6:.1f}MB  "
          f"({verb} {(tb-ta)/1e6:.1f}MB, {(1-ta/tb)*100:.0f}%)  max height {max_h}")


if __name__ == "__main__":
    main()
