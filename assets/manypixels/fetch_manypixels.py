"""Crawl the ManyPixels free illustration gallery.

https://www.manypixels.co/gallery is a Webflow CMS list paginated with
`?41120650_page=N`. Each list item carries everything we need in the markup:

  itemID="coding-29"                 slug
  imageName="Coding"                 title
  imageCategory="Illustration"
  fs-cmsfilter-field="category"      Technology / Business / ...
  fs-cmsfilter-field="styles"        Azureline / Playstroke / Birdview / ...
  fs-cmsfilter-field="keywords"      comma separated tags
  src=".../<hash>.svg"               the actual 500x500 SVG on the Webflow CDN

The page also embeds an Airtable PAT with write scope (it bumps download
counters). It is deliberately not used here - the CMS markup is public and
enough, and that token can mutate their base.

Illustrations are free for personal and commercial use with attribution to
ManyPixels; check https://www.manypixels.co/terms before shipping.

Usage:
  python3 fetch_manypixels.py index          # crawl pages -> index.json
  python3 fetch_manypixels.py download       # download every SVG in index.json
"""
import html
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

GALLERY = "https://www.manypixels.co/gallery"
PAGE_PARAM = "41120650_page"
OUT = os.path.dirname(os.path.abspath(__file__))
INDEX = os.path.join(OUT, "index.json")

ITEM_RE = re.compile(
    r'<div itemID="(?P<slug>[^"]+)" class="illustration_item[^"]*">.*?'
    r'imageCategory="(?P<kind>[^"]*)"\s+imageName="(?P<name>[^"]*)"\s+'
    r'src="(?P<url>[^"]+)".*?'
    r'fs-cmsfilter-field="category"[^>]*>(?P<category>[^<]*)<.*?'
    r'fs-cmsfilter-field="styles"[^>]*>(?P<style>[^<]*)<.*?'
    r'fs-cmsfilter-field="keywords"[^>]*>(?P<keywords>[^<]*)<',
    re.S,
)


def get(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode("utf-8", "replace")


def parse_page(markup: str) -> list:
    out = []
    for m in ITEM_RE.finditer(markup):
        d = m.groupdict()
        out.append(
            {
                "slug": d["slug"],
                "name": html.unescape(d["name"]),
                "category": html.unescape(d["category"]).strip(),
                "style": html.unescape(d["style"]).strip(),
                "keywords": [k.strip() for k in html.unescape(d["keywords"]).split(",") if k.strip()],
                "url": d["url"],
            }
        )
    return out


def cmd_index() -> None:
    items, seen, page, empty = [], set(), 1, 0
    while empty < 2:
        markup = get(f"{GALLERY}?{PAGE_PARAM}={page}")
        found = parse_page(markup)
        new = [i for i in found if i["slug"] not in seen]
        for i in new:
            seen.add(i["slug"])
        items += new
        print(f"  page {page:3d}: {len(found):3d} parsed, {len(new):3d} new, {len(items):5d} total", flush=True)
        empty = empty + 1 if not new else 0
        page += 1
        time.sleep(0.2)

    with open(INDEX, "w") as fh:
        json.dump(items, fh, indent=2)
    print(f"\n{len(items)} illustrations -> index.json")


def cmd_download() -> None:
    items = json.load(open(INDEX))
    ok = skip = fail = 0
    for it in items:
        d = os.path.join(OUT, "svg", it["style"] or "unknown")
        os.makedirs(d, exist_ok=True)
        path = os.path.join(d, f"{it['slug']}.svg")
        if os.path.exists(path) and os.path.getsize(path) > 0:
            skip += 1
            continue
        try:
            url = urllib.parse.quote(it["url"], safe=":/?&=%")
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=60) as r:
                blob = r.read()
            with open(path, "wb") as fh:
                fh.write(blob)
            ok += 1
        except Exception as e:
            fail += 1
            print(f"  FAIL {it['slug']}: {e}")
        if (ok + skip) % 100 == 0:
            print(f"  {ok} new / {skip} cached / {fail} failed", end="\r", flush=True)
    print(f"\ndownloaded {ok}, cached {skip}, failed {fail}")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "index"
    {"index": cmd_index, "download": cmd_download}[cmd]()
