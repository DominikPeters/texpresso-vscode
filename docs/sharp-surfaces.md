# Sharp surfaces

PNG pages are shown at display density at all times, including while typing.
This replaces the earlier arrangement of a whole-page base image capped at four
megapixels with a sharper "detail crop" requested 120 ms after things settled:
every edit replaced the base and discarded the crop, so the page went soft on
each keystroke and sharpened again only after a pause.

The engine side is specified in
[Page grids and surfaces](../native/texpresso/PREVIEW-PROTOCOL.md#page-grids-and-surfaces).
Engines without the `surfaces` capability keep the earlier behaviour unchanged.

## Model

* **Page geometry and interaction metadata** (bounds, text extent, links,
  SyncTeX) describe the complete page and do not depend on what is rasterized.
* **The surface** is the authoritative raster of a page: an integer rectangle
  of the page's device grid, at one raster pixel per screen pixel. Edits are
  compared and patched on this raster. SVG pages are sharp by construction and
  need no surface.
* **The placeholder** is a coarse whole page (about 0.75 megapixels) shown only
  where a surface does not reach: around a rectangle that covers part of a
  page. It is refreshed after the visible surfaces are sharp and nothing else
  is waiting, so it may be one edit behind. It never replaces sharp pixels.

## Device grid

A page laid out `cssWidth` wide has the grid width `round(cssWidth × dpr)`.
The webview lays the page out at exactly that many device pixels, places it on
whole device pixels (a transform-centred sheet of odd width would sit half a
pixel off and resample its entire raster), and positions a surface's canvas by
its rectangle. See `PageLayout.grid`, `planSurface` and `surfacePlacement` in
[preview-viewport.js](../media/preview-viewport.js).

The engine rasterizes every pixel in its cell of a fixed 512-pixel lattice, so
any rectangle of a grid has exactly the pixels of any other. A shared transform
alone does not give this: MuPDF re-interpolates an edge where it crosses the
clip, changing antialiased coverage along that edge. Rectangles are therefore
aligned outward to the lattice.

## Which rectangle

The pixels available to sharp surfaces follow the viewport:
`max(2 MP, 1.5 × viewport pixels)`, at most the engine's session budget (16 MP
in current builds, set at launch with `-preview-max-pixels`).

* A page whose whole grid fits is held whole. Its rectangle never moves, so
  scrolling costs nothing. This is the usual case for fit-width in a pane that
  is not much wider than it is tall.
* A larger page holds the visible part, aligned to the lattice, plus as many
  further lattice rows as its share of the budget allows. What is on screen is
  always covered, even where alignment costs more than the share; only the
  engine ceiling can cut into it, in which case the middle of the view stays
  sharp.
* A held rectangle is kept for as long as it still covers what is visible.
  Small scrolls and in-flight requests do not move it.

## Edits

An edit re-renders each visible page's rectangle and compares it, at display
density, with the raster the client already shows. The response is a patch
applied in place on the same canvas, in the same task that installs the new
revision's links and SyncTeX state. Until then the previous sharp frame stays on
screen and is marked stale for interaction. An edit outside a page's rectangle
transfers no pixels for it.

Every visible page keeps its own patch base, so an edit that reflows a
neighbouring page patches that page too.

## Memory

For a viewport budget `B` pixels:

| Where | Bound |
| --- | --- |
| Webview decoded surfaces | `max(32 MiB, 8·B bytes + 8 MiB)`: RGBA for one budget of surfaces, the outgoing and incoming rasters of a replacement, and retained neighbours |
| Placeholder | about 3 MiB per page showing a partial rectangle |
| Engine retained rasters | at most four, and at most three bytes per pixel of the session budget in total; in practice the rasters the client holds |
| Engine export cache | unchanged, 32 MiB |
| One frame on the wire | up to 64 MiB of PNG once the session budget exceeds four megapixels |

Peak process memory has not been measured yet.

The viewport budget is a planning target, not an allocation cap for the whole
application: lattice alignment and retaining a complete page can exceed a
page's current share. The decoded cache and native retained/export caches have
separate bounds; in-flight decode and GPU allocations are additional. Peak
memory and multi-page cache pressure must be measured before release.

## Shared-engine compatibility

The lattice is opt-in through `preview-surface`. Legacy whole-page commands and
`preview-region` retain their existing single-pass rasterization and dimension
rounding. TeXstudio currently uses those commands, so adopting the shared engine
does not implicitly change its rendering path. A future TeXstudio surface port
must negotiate the capability and use `grid` and `clip` to position pixels and
identify patch bases.

## Not done

* Damage is still found by comparing two complete rasters of the rectangle, so
  an edit costs a full draw of the visible rectangle. Finding damage before
  rasterizing is being investigated separately.
* Whether a scrolled rectangle should reuse overlapping pixels (retained tiles
  or a rolling surface) is undecided; today a rectangle that moves is rendered
  completely, with the placeholder showing meanwhile.
* The magnifier still uses `preview-region`, which is not a grid rectangle.
* Pages just outside the viewport are prefetched whole at a capped width and
  become surfaces when they scroll in.
