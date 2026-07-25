"""Fetch VideoScribe / Sparkol library assets.

Public, unauthenticated endpoints:
  https://services.sparkol.com/library/hands?results=1000   (336 items)
  https://services.sparkol.com/library/music?results=1000   (192 tracks)

The image library (/api/vsc/image/search) requires a logged-in bearer token
and is licensed stock content, so it is deliberately not touched here.

Hand resources:
  hand1 - drawing hand (pen on canvas)     -> <slug>-draw.png
  hand2 - moving hand (pen lifted)         -> <slug>-move.png
  thumbnail - 160px preview                -> <slug>-thumb.png
All are transparent RGBA PNGs regardless of the .jpg / octet-stream headers.

Usage:
  python3 fetch_library.py index            # indexes + every hand thumbnail
  python3 fetch_library.py full <group>...  # full-res hands for those groups
  python3 fetch_library.py music <n>        # download n sample tracks
"""
import json
import os
import re
import sys
import urllib.parse
import urllib.request

BASE = "https://services.sparkol.com/library"
OUT = os.path.dirname(os.path.abspath(__file__))


def slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def fetch(url: str) -> bytes:
    # music filenames contain spaces, which urllib rejects unencoded
    url = urllib.parse.quote(url, safe=":/?&=%")
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=90) as r:
        return r.read()


def get_index(kind: str) -> list:
    return json.loads(fetch(f"{BASE}/{kind}?results=1000"))["items"]


def hand_entry(it: dict) -> dict:
    meta = it.get("metadata", "") or ""

    def attr(k):
        m = re.search(rf"{k}='([^']*)'", meta)
        return m.group(1) if m else None

    return {
        "id": it["id"],
        "name": it["name"],
        "group": it.get("group"),
        "slug": slug(it["name"]),
        "handBehind": attr("handBehind") == "yes",
        "drawOffset": [int(attr("offset1X") or 0), int(attr("offset1Y") or 0)],
        "moveOffset": [int(attr("offset2X") or 0), int(attr("offset2Y") or 0)],
        "urls": {k: v["url"] for k, v in it["resources"].items()},
    }


def cmd_index() -> None:
    hands = [hand_entry(i) for i in get_index("hands")]
    with open(os.path.join(OUT, "hands-index.json"), "w") as fh:
        json.dump(hands, fh, indent=2)

    thumbs = os.path.join(OUT, "thumbs")
    os.makedirs(thumbs, exist_ok=True)
    for h in hands:
        url = h["urls"].get("thumbnail")
        if not url:
            continue
        path = os.path.join(thumbs, f"{h['group']}--{h['slug']}.png")
        if os.path.exists(path):
            continue
        with open(path, "wb") as fh:
            fh.write(fetch(url))
    print(f"hands-index.json + {len(os.listdir(thumbs))} thumbnails")

    music = get_index("music")
    with open(os.path.join(OUT, "music-index.json"), "w") as fh:
        json.dump(music, fh, indent=2)
    print(f"music-index.json ({len(music)} tracks)")


def cmd_full(groups: list) -> None:
    hands = json.load(open(os.path.join(OUT, "hands-index.json")))
    for g in groups:
        d = os.path.join(OUT, g)
        os.makedirs(d, exist_ok=True)
        picked = [h for h in hands if h["group"] == g]
        for h in picked:
            for key, suffix in (("hand1", "draw"), ("hand2", "move")):
                url = h["urls"].get(key)
                if not url:
                    continue
                path = os.path.join(d, f"{h['slug']}-{suffix}.png")
                if os.path.exists(path):
                    continue
                with open(path, "wb") as fh:
                    fh.write(fetch(url))
        print(f"{g}: {len(picked)} hands -> {d}")


def cmd_music(n: int) -> None:
    tracks = json.load(open(os.path.join(OUT, "music-index.json")))
    d = os.path.join(OUT, "music")
    os.makedirs(d, exist_ok=True)
    for t in tracks[:n]:
        url = t["resources"]["full"]["url"]
        path = os.path.join(d, f"{slug(t['name'])}.mp3")
        if os.path.exists(path):
            continue
        with open(path, "wb") as fh:
            fh.write(fetch(url))
        print(f"OK {t['name']} ({t['time']})")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "index"
    if cmd == "index":
        cmd_index()
    elif cmd == "full":
        cmd_full(sys.argv[2:])
    elif cmd == "music":
        cmd_music(int(sys.argv[2]) if len(sys.argv) > 2 else 5)
