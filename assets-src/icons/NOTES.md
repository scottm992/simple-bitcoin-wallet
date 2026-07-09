# App icon — notes for PWA packaging

Two hand-authored SVGs, both `viewBox 0 0 512 512`, full-bleed, opaque, no
filters, no `<text>`, no fonts. The design is the app's own `.logo-mark`
(src/theme.css) blown up to icon size: flat brand orange `#F7931A` with the
white extra-bold bitcoin sign (U+20BF) as the app actually renders it.

The letterform was hand-traced against a ground-truth raster of the app's own
glyph rendering (`reference-glyph.png`, canvas fillText, 800 weight, system
font stack): heavy straight spine, full round bowls that pinch sharply at the
midline, small D-shaped counters (holes via `fill-rule="evenodd"`), and four
slim square stubs. Pixel-diff against the reference at 512: IoU 0.976 — the
remaining difference is anti-aliasing fringe on curves.

Positioning: the glyph is OPTICALLY CENTRED (final variant chosen by Scott,
2026-07-09, over a plain bounding-box-centred candidate). Net transform:
`translate(0 17.5)` on the traced footprint. Why not bbox-centred: this glyph
has a solid straight spine on the left (hard visual edge) and a curve apex on
the right (soft edge that perceptually "ends" early), so at true bbox centre it
reads shifted left. Measured on the 512 render: ink bbox centre (259.5, 254.5),
ink centroid (252.3, 253.0); the shipped position puts the half-way blend of
those at (255.9, 253.75) — horizontally on target, plus a deliberate ~2px
vertical lift (the perceived centre of a square tile sits slightly above its
geometric centre). For history: the original tracing reference itself sat
~20px high of centre — a text-rendering artifact (canvas `textBaseline:
middle` centres on font metrics, whose ascent exceeds the glyph's descent —
correct for a text line, wrong for an app icon).

- `icon.svg` — master. Rasterize to the 512 and 192 manifest PNGs (`purpose:
  "any"`) and to the 180×180 `apple-touch-icon`.
- `icon-maskable.svg` — same design, mark scaled 0.9 about centre; its farthest
  ink point is then ~126px from centre, well inside the maskable safe circle
  (r = 40% = 205px). Rasterize to 512 and 192 PNGs (`purpose: "maskable"`).

## Manifest colors

```json
"background_color": "#FFFFFF",
"theme_color": "#F7931A"
```

- **`background_color`: `#FFFFFF`** — this paints the PWA splash/launch screen
  before the app renders. The app's own background is white (`--bg #FFFFFF`), so
  white means no color flash between splash and first paint.
- **`theme_color`: `#F7931A`** — brand bitcoin orange (`--accent`), and also
  the icon's exact background, so the launch chrome matches the icon. Tints the
  Android status/toolbar strip on launch.
  Alternative if you'd rather the status strip blend into the app's white top
  bar: use `#FFFFFF` instead — purely cosmetic, both are correct.

Note: `theme_color` is static, so it stays brand orange even in Practice mode
(where the in-app accent swaps to violet). That's intended — orange is the
default/Live identity.

## Rasterization guidance

- Render at exact pixel sizes: **512, 192** (both purposes) and **180**
  (apple-touch-icon). 16/32 favicons optional from the same master.
- Everything is flat fills and cubic/line path segments — any standards-
  compliant renderer works (resvg / `sharp` / Inkscape / rsvg-convert).
- Export **opaque** (flatten, no alpha). iOS ignores transparency on
  apple-touch-icon and applies its own ~22% corner mask — the full-bleed opaque
  background is exactly what it wants, so **do not pre-round the corners**.
- Nothing touches the viewBox edge (master glyph max extent ~140px from centre;
  maskable ~126px), so no clipping at any size.
- 48×48 check (done with resvg during design): the counters are small — true to
  the app's glyph — but each keeps a ~4px core of clearly-orange open pixels,
  and the stubs stay visible. Below 48px (e.g. 16px favicon) the counters will
  close up; that is expected and matches how the real glyph renders that small.
  If a target platform wants a 1024 store icon, the master scales up cleanly
  (pure vectors).

## Shipped rasters

The rendered PNGs live in `public/icons/` (`icon-192.png`, `icon-512.png`,
`icon-maskable-512.png`) and `public/apple-touch-icon.png` (180). They were
rendered from these SVGs with resvg. If the SVGs ever change, re-render all
four at those exact sizes and replace them together.
