# Whiteboard POC assets

## What is here

| Dir                                                  | Count           | Source                      | License                            | Notes                                                      |
| ---------------------------------------------------- | --------------- | --------------------------- | ---------------------------------- | ---------------------------------------------------------- |
| `sparkol/matt/` `sparkol/hannah/` `sparkol/suneeta/` | 54 hands x 2    | Sparkol VideoScribe library | Sparkol library terms — see caveat | full-res RGBA PNG, 3 skin tones; 49 usable after filtering |
| `sparkol/pens/`                                      | 24 x 2          | same                        | same                               | pen only, no arm — does not occlude the canvas             |
| `sparkol/thumbs/`                                    | 333             | same                        | same                               | every hand in the library, 160px, for browsing             |
| `sparkol/music/`                                     | 3 of 192        | Hark Music via Sparkol      | same                               | mp3, 1:00–8:36                                             |
| `iconify/tabler/`                                    | 6166            | Tabler Icons                | MIT                                | true open strokes — best for draw-on animation             |
| `heroicons/24-outline/`                              | 324             | Heroicons v2.2.0            | MIT                                | true open strokes, stroke-width 1.5                        |
| `heroicons/24-solid/`, `20-solid/`, `16-solid/`      | 324 / 324 / 316 | Heroicons v2.2.0            | MIT                                | filled, for static accents                                 |
| `iconify/streamline-freehand/`                       | 1000            | Streamline                  | CC BY 4.0                          | hand-drawn look, filled outlines                           |
| `iconify/pepicons-pencil/`                           | 1275            | CyCraft                     | CC BY 4.0                          | pencil look, filled outlines                               |
| `lucide/`                                            | 16              | Lucide                      | ISC                                | true open strokes                                          |
| `manypixels/svg/`                                    | 2362            | ManyPixels gallery          | free, attribution                  | 5 styles x ~473, 500x500 flat illustrations                |
| `pexels/`                                            | 0               | Pexels                      | Pexels License                     | needs a free API key, see below                            |
| `sfx/oneshots/`                                      | 56              | Freesound via Openverse     | CC0 only                           | one-shots, <=2s, loudness matched                          |

## Performance trap: do not pass `resourcesDir` to resvg

Referencing hand PNGs by relative path needs resvg's `resourcesDir`, and that option costs
roughly an order of magnitude per frame. Measured on one 1080x1920 frame, mean of 4:

|                    | disk write off | disk write on |
| ------------------ | -------------- | ------------- |
| no `resourcesDir`  | 75 ms          | 64 ms         |
| `resourcesDir` set | 608 ms         | 1396 ms       |

Reproduced on landscape too. A 20 s portrait clip goes from 45 s to over 6 minutes of
render time. `hand.ts` inlines the hand as a base64 data URI instead, downscaled once at
load time to its on-screen size — inlining the raw 800x1250 original would push every
frame's SVG into the megabytes and force resvg to re-decode a large image 30 times a
second. Measured after the switch: 62 ms/frame portrait, 75 ms/frame landscape.

## Choosing an icon set for the draw-on effect

`tabler`, `heroicons/24-outline` and `lucide` are `fill="none"` + `stroke-width` paths, so a pen can be
animated along them with `stroke-dasharray` / `stroke-dashoffset` and the pen tip
followed with `getPointAtLength()`. This is the cheap, correct path.

`streamline-freehand` and `pepicons-pencil` look far more hand-drawn, but every
glyph is a closed filled outline (`fill-rule="evenodd"`), verified: 1000/1000 and
1274/1275 files contain no stroke attributes. Dashoffset does nothing on those.
To animate them you need a different reveal — an expanding clip mask swept along a
manually authored centerline, or just a wipe.

## ManyPixels illustrations

`manypixels/index.json` holds the full crawl - slug, title, category, style and
keywords for all 2362 items - so the set is searchable offline.

- styles, one subdir each: `Azureline` `Birdview` `Chromablue` `Colossalflat` `Playstroke` (~473 each)
- top categories: Work 480, Technology 393, Job 227, Others 150, Finance 150,
  Geography 150, Food 139, People 128, Sports 107

All are 500x500 flat colour illustrations built from a `<style>` block of fill
classes (`.st0{fill:#68E1FD}`), i.e. filled shapes rather than strokes - same
animation constraint as the freehand icon sets.

Crawled from the public Webflow CMS markup at `?41120650_page=N`, 64 pages.
The gallery page also ships a hardcoded Airtable PAT with write scope (it bumps
their download counters); `fetch_manypixels.py` deliberately does not use it.

## Hand assets

Each hand has two frames plus a preview:

- `<slug>-draw.png` — pen touching the canvas
- `<slug>-move.png` — pen lifted, for travel between strokes (erasers reuse the draw frame)
- `<slug>-thumb.png` — 160px preview

All are transparent RGBA PNG despite the CDN serving `.jpg` / `application/octet-stream`.

`drawOffset` / `moveOffset` come straight from the API metadata and do **not** land on
the pen tip. Confirmed by crosshair render across four hands — the declared point sits
up-left of the real tip by 20-60px in source pixels, and can even fall outside the image
(`suneeta-black-marker` declares `(57,-16)`; the tip is at `(43,114)`).

`hand.ts` therefore measures the tip from the alpha channel and uses the metadata only to
decide **which corner** the pen points at (the library has left-handed sets, where the tip
is up-right rather than up-left). Metadata contributes the orientation it gets right,
pixels contribute the precision. These hand PNGs carry no drop shadow, so the opaque
extreme is the tip; the `pens/` group does have a shadow reaching the image corner, which
is why the same measurement must not be applied to it.

## Re-fetching

```bash
python3 sparkol/fetch_library.py index              # indexes + all 333 thumbnails
python3 sparkol/fetch_library.py full hannah pens   # full-res for named groups
python3 sparkol/fetch_library.py music 10           # n sample tracks
python3 iconify/fetch_iconify.py tabler             # whole Iconify set as SVGs
python3 manypixels/fetch_manypixels.py index        # crawl gallery -> index.json
python3 manypixels/fetch_manypixels.py download     # fetch every SVG (resumable)
```

Hand groups available: `pens` (pen only), `Seasonal` (72 Halloween novelty incl.
board wipers), and 13 human sets — `hannah` `billy` `suneeta` `jacob` `jonny`
`hiswill` `matt` `mike` `daniel` `joe` `sibin` `yasmin` `rosie` — covering a range
of skin tones, adult/child hands, and left/right.

## Raster sizes

Hand PNGs were shrunk in place to 800px max height: 151 files, 67.4MB -> 31.4MB
(53% off). A drawing hand covers about half a 1080p frame, so 800px still leaves
headroom, and alpha is preserved. Rerun or change the ceiling with:

```bash
python3 shrink_rasters.py --dry-run
python3 shrink_rasters.py --max-height 1000
```

Originals are always recoverable via `sparkol/fetch_library.py full <group>`.

Note the real disk hogs are not assets: `frames-landscape/` and `frames-portrait/`
hold 1167 rendered PNG frames at 448MB. Those are regenerable intermediates and
are now covered by `experiments/**/frames-*/` in .gitignore.

## Licensing caveat

The Sparkol endpoints (`services.sparkol.com/library/hands`, `/library/music`) are
unauthenticated, but the assets are Sparkol's licensed library content intended for
use inside VideoScribe. Fine for a local prototype; shipping them in a product is a
licensing question that needs checking, not an engineering one. The image library
(`/api/vsc/image/search`) is bearer-token gated and was deliberately left alone.

CC BY 4.0 sets require visible attribution when shipped. `tabler` (MIT) and
`lucide` (ISC) do not.

## Pexels photos and video

`pexels/fetch_pexels.py` is ready but downloads nothing yet: the API returns 401
without a key, and scraping pexels.com breaches their Terms of Service.

```bash
export PEXELS_API_KEY=...        # free key from https://www.pexels.com/api/
python3 pexels/fetch_pexels.py search "whiteboard" "office meeting" --per 30
python3 pexels/fetch_pexels.py video "presentation" --per 10
```

Free tier is 200 requests/hour. The Pexels License allows commercial use with no
attribution required, but each download still records photographer and source URL
in a `_index.json` sidecar. Note these are raster photos - they cannot be
pen-animated, they are backdrops or insets.

## Sound effects

All 56 clips are CC0 / public domain, so none of them need attribution.

| folder                     | clips | folder                      | clips |
| -------------------------- | ----- | --------------------------- | ----- |
| `oneshots/pen-writing/`    | 9     | `oneshots/whiteboard/`      | 10    |
| `oneshots/drawing-pencil/` | 12    | `oneshots/marker-writing/`  | 8     |
| `oneshots/page-turn/`      | 5     | `oneshots/scribble/`        | 4     |
| `oneshots/chalk-writing/`  | 3     | `oneshots/eraser-wipe/`     | 2     |
| `oneshots/sketch/`         | 2     | `oneshots/felt-tip-marker/` | 1     |

Only `oneshots/` is kept - 56 clips, all <=2s, normalised to -16 LUFS, 2.3MB
total. The 30.5MB of raw downloads was deleted after verifying 56/56 coverage and
that every output decodes.

`cut_sfx.py` slides an RMS window over each source, keeps the loudest position,
then snaps the start back to the nearest onset so the cut never begins mid-stroke.
Each `_index.json` carries licence, creator, Freesound URL, plus `src_duration_s`
and `cut_at_s` so any cut can be re-derived.

```bash
python3 sfx/fetch_sfx.py "chalk squeak"   # re-download raws if a longer bed is needed
python3 sfx/cut_sfx.py --len 1.2          # recut shorter
```

Fetched through the Openverse API (`api.openverse.org/v1/audio/`), which needs no
key and returns an explicit licence per result. `--any` also accepts BY / BY-SA,
which do require credit.

## Lottie

`airbnb/lottie-web` (MIT) is the renderer, not an asset library — the repo carries
only 5 demo and 13 test animation JSONs. Hand-drawn Lottie content lives on
lottiefiles.com, whose GraphQL endpoint (`graphql.lottiefiles.com/2022-08`) does
answer anonymously, but licences there are per-animation (free tier vs paid,
some attribution-required), so nothing is bulk-pulled here. Worth it for
pre-animated flourishes — arrows, checkmarks, underlines — that would be tedious
to hand-animate, but it is a per-asset licence check each time.

## Other sources worth a look

- Excalidraw libraries — `excalidraw/excalidraw-libraries` `libraries.json`, 231
  community libraries of hand-drawn elements (AWS/GCP/K8s architecture icons,
  wireframe kits, simple characters). Closest thing to native whiteboard style.
- Open Doodles (opendoodles.com) — CC0 hand-drawn people, no attribution needed.
  Only distributed as site downloads / JSX wrappers, no clean SVG repo found.
- Humaaans, unDraw — no working public JSON API found; manual download only.
- Iconify has 231 collections total; query
  `api.iconify.design/collection?prefix=<set>&info=true` for names and license
  before pulling a set.
