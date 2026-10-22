# Continuous preview scrolling and bounded prefetch

Implementation notes and design, 22 October 2026. The preview now uses continuous
scrolling with bounded mounted surfaces and shared rendering credit. The implementation should remain
inside the existing session, headless engine, stdio transport and webview.

The intended experience is a vertically scrolling document with adjacent pages
visible together, immediate reuse when scrolling back, and enough preparation
in the direction of travel to avoid waiting at every boundary. Typing, source
navigation and magnification retain priority. Opening a long document must not
compile, export or mount all its pages.

## Current implementation

`media/preview.js` owns a virtual page stack and per-page views; the pure
`PageLayout` geometry model lives in `preview-viewport.js`. At most twelve shells
are mounted. The shared decoded cache is limited to eight entries and 32 MiB
of estimated cost, with a 40,000-node aggregate SVG limit. Visible raster pages
share a four-megapixel base-image allowance, with more density for the active
page; speculative neighbors use smaller images. Oversized SVGs use PNG.

The host receives bounded visible/nearby demands and resident-page inventory.
It updates the active page first, keeps one render/decode credit, and starts
speculation after 150 ms. Each neighbor is attempted once per scroll epoch,
and the unknown frontier has two initial speculative advances, then one per
user scroll epoch. Page arrival and geometry corrections cannot replenish that
budget. Active images and metadata are separate from the engine's current page.
Identical content has separately owned mutable browser surfaces on each page.

The `backgroundRendering` engine capability enables full-frame neighbor exports
that preserve the foreground PNG comparison buffer and display list. Export uses one
temporary background display list, released before returning to foreground work. The
`preview-cancel` command stops speculative demand on edits, hiding and pause.
Older engines can display continuous pages. Speculative preparation requires the
new capability so cancellation and foreground comparison-base preservation are
both available.

Open-buffer changes have no debounce: VS Code changes are sent immediately,
with a source barrier that flushes native buffered changes. The remaining
100 ms zoom request, 120 ms detail request, 150 ms prefetch, 200 ms disk-watcher,
350 ms Auto refinement, and 500 ms native auxiliary-rerun delays serve separate
purposes. None holds the first updated page for an ordinary editor change.

The sections below record the broader design and the rationale for these bounds.

## What can be reused

The current implementation already provides:

- Revision and source-sequence barriers, request IDs, one frame/decode credit,
  a replaceable native pending request, and late-response rejection.
- Lazy native compilation up to a requested page, availability notifications
  with an incomplete page count, and named-destination lookup.
- Encoded-page reuse, bounded decoded content identities, transactional SVG DOM
  patches, acknowledged PNG dirty rectangles, and page-space annotations.
- DPR-aware raster widths, clipped detail/magnifier requests, fit/zoom geometry,
  conservative Auto selection, and hidden-panel suspension.

The limitation is the single-page ownership model. `PreviewController` has one
`page`, `shown`, `dirty`, SVG base, PNG base and region request. `preview.js` has
one sheet, header, surface and global generation counter. A neighboring image
currently becomes the selected page, and another page's decode can supersede
the displayed page. Repeating this code once per page would create competing
native schedulers, unbounded caches and ambiguous interactions.

Split responsibilities into a panel-wide scheduler and resource budget, a page
store, and a browser viewport/layout controller. Each mounted page owns its
surface, metadata and interactions; every page shares the scheduler and budget.
Do not create additional engine sessions or compiler workers for prefetch.

## Page model and layout

Use zero-based physical page indices throughout. A page record separates:

1. **Geometry:** known or estimated page bounds, width/height and vertical offset.
2. **Current snapshot:** revision, source sequence, annotations and content ID.
3. **Presentation:** renderer, requested density, mounted surface and decode state.
4. **Scheduling:** wanted priority, queued/in-flight request and request generation.

Content identity is not snapshot validity. Two pages may share identical image
bytes while their links and SyncTeX data differ. Metadata remains associated
with the page and snapshot; a shared mutable canvas/SVG root must not be mounted
into two sheets. If identical pages need simultaneous presentation, share
immutable bytes or an image source and account for separate mutable surfaces.

Use a single scroll container, a vertical page stack and a small theme-colored
inter-page gap, initially 8 CSS pixels. Keep paper flush with the horizontal
viewport at fit width. Each page has a white paper background and its own
raster/vector, detail, link and highlight layers. CSS IDs become classes or
references held by the page view; overlay event handling is delegated by page.

Mount page shells only for the viewport plus one viewport of overscan, subject
to a hard shell-count limit, initially 12. Represent the remaining known pages
with top/bottom spacers. Keep compact geometry separately; do not create a DOM
placeholder for every page. A prefix-height index supports offset lookup and
jump-to-page without scanning rendered DOM. The existing supported navigation
range should also bound the catalogue; an unexpectedly larger native count must
not allocate an array directly from untrusted protocol input.

Page size comes from image `bounds`, not a fixed A4 ratio or raster dimensions.
An unknown page initially uses the nearest known page size, then the default
paper estimate before any size is known. Treat estimates explicitly; mounting
an image replaces its estimate atomically and preserves the scroll anchor.
For a first implementation, retain learned compact geometry for the document's
supported page range even after surfaces are evicted. Evicting a height estimate
above the viewport would otherwise alter scroll position on a cache eviction.

No new geometry protocol is necessary for the first milestone. Later, if mixed
page sizes cause visible corrections, add an optional bounded metadata request
for already available pages. It must not compile or interpret all pages simply
to discover dimensions; the current image header is the authoritative fallback.

### Zoom, resizing and anchoring

Numerical zoom uses one physical scale across pages (`zoom * 96 / 72`). Fit width
fits each page independently to the available viewport width. Fit page fits each
page to the viewport in both dimensions. These modes preserve the existing
one-page meaning; different paper widths can therefore have different scales in
fit modes. The toolbar shows the mode, rather than implying one percentage for
all pages when those scales differ.

Represent an anchor as `(page, local x/y in page points, viewport x/y in CSS
pixels)`. Pinch uses the point under the fingers and keeps that anchor for the
whole gesture. Toolbar zoom uses the viewport center, projected onto the nearest
page if it falls in a gap. Geometry replacement, page insertion, resize and
remount preserve the topmost visible page point. An explicit link/source jump
supplies its own target anchor and takes precedence over passive preservation.

Apply layout changes in one animation-frame transaction: read the old anchor,
update geometry/spacers/sheets, restore its screen position, then compute demand.
Continue disabling browser overflow anchoring so it cannot apply a second
correction. Preserve fractional offsets; rebase only when scrolling clamps at a
real document boundary. Save logical page/point and zoom in webview state rather
than only absolute `scrollTop`, which cannot survive changed estimates.

The page-number field follows the page containing the viewport's vertical center
(or the nearest page in a gap), with a small hysteresis around boundaries. This
is a browser observation, not an instruction to scroll. Previous/next buttons
jump to the previous/next page top; Page Up/Down should scroll by a viewport in
continuous mode. Page-number input, links and forward SyncTeX are explicit jumps.

## Lazy compilation and an unknown end

`preview-state` contains the number of pages produced so far and a `complete`
flag. Its last page field is the native viewer's current page, which changes on
prefetch. It must no longer control the toolbar's selected page or scroll.
Native `need_advance` uses that page as compiler demand. Requesting page N can
compile every missing page through N; it is not merely an image-cache lookup.

When incomplete, lay out the known prefix and one estimated next-page sentinel.
Show `page / …`. Do not invent hundreds of pages or request the end to obtain a
final total. Previously observed page-count/geometry information may remain as
stale layout hints after an edit, but cannot authorize speculative compilation
through an invalidated suffix.

Distinguish two types of preparation:

- **Already available page:** may be exported opportunistically within the
  nearby window; it requires no intentional compiler advance.
- **Frontier page:** may advance compilation by one page. Permit this near the
  visible frontier, with no active editing/gesture and no foreground demand.
  An initial budget of one speculative frontier advance per user scroll epoch
  prevents an endless chain. Allow at most two advances when initially filling
  a tall viewport. Programmatic layout, intersection callbacks, response arrival
  and appending a sentinel do not create another user scroll epoch.

Once the frontier is visibly needed, it is foreground work and can progress
normally. Explicit page input, a link or forward SyncTeX may demand a distant
page and advance compilation to it. A footer can show “Preparing the next page…”
while that demand runs. On compiler failure retain successful pages and show the
failure at the frontier/status area; do not repeatedly retry on every observer
callback. Pause, source edit or hiding the panel cancels speculative demand. Clearing the
host queue alone is insufficient if the native current page still demands an
uncompiled frontier: cancellation must retarget native demand to the last
foreground page (or use an explicit capability-gated demand-cancel operation).
This preparation-only retarget must not move the browser or force a duplicate
visible image; prefer a small native cancel/retarget command if a normal render
would otherwise block hiding. Test that compiler stepping stops at its next safe
boundary rather than merely suppressing the resulting image.

If an out-of-range request reaches the real end, the current engine clamps its
page. Resolve/remove the sentinel using the complete count and accept the final
page only in its actual slot; do not duplicate the last page as the next page.
The zero-page document path needs the same explicit terminal handling.

## Scheduler and cancellation

The extension host owns one bounded demand queue and one native/decode credit.
The browser reports a replaceable viewport snapshot containing a viewport epoch,
anchor/active page, visible page IDs, overscan candidates, desired raster widths
and scroll direction. Validate and cap every list, size and index. Coalesce
scroll observations once per animation frame and send only changed demand.
An explicit jump is a separate event; a background decode never implies a jump.

Recommended priority order:

1. Explicit source/link/page navigation and the active page's source update.
2. Inverse SyncTeX preparation and the active magnifier region.
3. Missing or stale visible pages, ordered by visible area and anchor distance.
4. Visible high-zoom detail, then the nearest already available neighbor in the
   direction of travel, then the opposite neighbor.
5. Active/visible page idle Auto refinement; speculative frontier advance last.

A page can have only one pending desired main surface. A newer source barrier,
width or renderer replaces its older queued version. Keep at most the mounted
window plus two neighbor candidates in the queue, and recompute priorities from
current demand rather than allowing an accumulated scroll backlog. Debounce
speculative work initially by 100–150 ms after scrolling; foreground demand
starts immediately. Disable prefetch while a text burst, held pointer, zoom
transaction or compiler error is active.

A request has `(instance, request ID, revision, sequence, page, role, viewport
epoch)`. Main-page, detail, magnifier, prefetch and refinement results route to
their own slots. Decode acknowledgement returns credit for that request only.
Use a separate generation for each page view and its details; a global image
generation would incorrectly cancel valid concurrent page decodes. A valid result
from an obsolete viewport may enter the bounded cache, but must
not scroll, select a page, change another sheet or resurrect an evicted slot.
Always drain the complete native body, including stale/discarded results.

Continue allowing a foreground request to supersede background native pending
work using request IDs. This does not interrupt a synchronous export, a pipe
write already in progress, or arbitrary compiler work halfway through. At most
one obsolete background operation can remain executing; account for that cost
in acceptance tests. Do not submit a second stream of speculative exports while
an earlier browser decode is still running. Hidden/disposed webviews clear the
queue, release credit, close transient surfaces and resume only after ready.

## Bounded caches and patch ownership

Retain existing encoded/prepared budgets first; add global accounting across
all page views rather than multiplying today's budgets per page.

| Resource | Starting policy |
| --- | --- |
| Encoded host images | 8 MiB / 8 entries, with visible/current work ahead of neighbor LRU entries. |
| Prepared host SVG documents | 8 MiB / 2 entries, concentrating on the actively edited page. |
| Browser resident surfaces | 32 MiB estimated decoded cost, up to 8 identities; all mounted and cached surfaces count. |
| Mounted SVG complexity | At most 40,000 aggregate nodes, in addition to current per-page validation limits. |
| Raster | Preserve the current 4 megapixel per-frame limit; allocate a smaller density when several visible pages compete. |
| Transient decode/detail | One main candidate and one clipped detail/magnifier candidate, each under existing pixel limits; no speculative duplicate while these are occupied. |
| Native | One foreground display list, one temporary background display list during export, and one retained PNG comparison raster; no per-page native raster cache. |

The host and browser must agree on the cache inventory limit: today the host
accepts only four decoded IDs, so raising the browser entry limit alone would
lose correct reuse. Cache acknowledgement lists and disposal notifications stay
bounded and identify the exact roots/canvases still available for patches.

The 32 MiB number is an accounting target, not a promise about browser RSS or
GPU allocation. A maximum-size RGBA candidate adds about 16 MiB during a swap;
a detail/magnifier candidate can add another 16 MiB. Explicitly account for that
transient overlap and measure it. SVG also needs a node/string estimate; viewport
pixel area alone substantially understates a large vector tree's cost.

Visible pages are preferred over offscreen caches, but are not exempt from
limits. When many pages fit onscreen, lower the background pages' raster density
and promote the active/closest pages first. If an SVG would exhaust the shared
node budget, use a bounded raster representation for that page. Do not retain
unbounded full SVG trees behind placeholders. Keep the layout shell while
releasing a distant surface: revoke Blob URLs, zero canvas dimensions, remove
SVG roots/overlays and drop prepared/diff references. Maintain cheap geometry.

Reuse SVG/PNG decoded content IDs across revisions only after fresh metadata
confirms the content. Preserve conservative whole-snapshot invalidation at first:
all old pages may remain visually present, but stale links and inverse SyncTeX
are disabled until their current frames arrive. Refresh the active page first,
then other visible pages; a new source barrier never triggers a whole-document
rerender. Prefix-validity optimization needs a real native affected-page contract
and is a separate change.

### The PNG comparison-base trap

The engine retains one PNG comparison raster. A full neighbor export currently
replaces it for PNG or drops it for SVG; even a non-patch PNG request drops it.
Simply adding prefetch would therefore turn the next active-page edit into a
full PNG more often. Moving the native current display list also affects inverse
search and creates work to return to the active page. Cache hits alone do not
solve either issue.

Recommended small native addition: an optional capability-gated background
export policy that emits a full keyframe while leaving the retained comparison
raster and its identity unchanged. No extra raster is retained. The background
frame must not claim to become a usable native patch base; its browser content
can still be cached. Old engines can show continuous pages, but suppress neighbor
prefetch while protecting an active PNG editing base, accepting full keyframes
on actual navigation. A clipped-region request happens to preserve today's base,
but must not be used as an accidental full-page/annotation workaround.

Keep the native patch base global, and the browser's acknowledged base identities
per page. The host passes a raster base only when it knows the native ID is
still retained and the exact page/geometry/density canvas exists. If another
foreground page or Auto SVG export replaces it, clear that global knowledge;
a miss requests a full frame. Per-page SVG diff bases likewise require a matching
acknowledged page root; retain prepared trees only within the shared budget.

Speculative pages use one representation: PNG for Auto's speculative preparation,
with no idle conversion until visible. Explicit PNG/SVG continues to honor the
selected renderer and established fidelity fallbacks; an explicit SVG page may
still need raster presentation when browser complexity limits are exceeded.
Do not let prefetch/full-mount timing samples teach the active page's warm-edit
Auto policy. The currently edited page's renderer/refinement may retain its
existing policy after foreground demand has settled.

## Links, SyncTeX and magnifier routing

Every interaction carries the owning page's revision, sequence and page index.
Convert browser coordinates using that sheet's surface rectangle and its own
page bounds; never the toolbar's active page or a global last image header.
Validate link indices against the host's fresh metadata for that page. Preserve
plain-click links, modified-click inverse SyncTeX, and link cursors while the
magnifier is enabled. A shared magnifier locks onto the page where its pointer
gesture began; crossing a page boundary or gap closes it, avoiding ambiguous
coordinate changes and cross-page pointer-capture races.

Forward SyncTeX and internal destinations reveal the target page/point once its
slot geometry is known. They can use an already current cached image without
compiler work. An inverse request on a browser-cached page may still need native
page preparation because only one hit-testing display list is current. Schedule
that as foreground work, leave the other pages visible and retain the coordinate
snapshot until the matching native page is ready. A newer edit/jump cancels it.
Do not resolve all offscreen named links eagerly; only explicit navigation can
demand an as-yet uncompiled target.

## Delivery plan and acceptance

1. **Page-view extraction, with existing UI.** Replace global browser surface
   state with one `PageView`, extract a tested geometry model and separate host
   page state from native-current-page state. Keep one-page presentation while
   proving existing decode, patch, link and SyncTeX tests unchanged.
2. **Continuous viewport without speculation.** Multiple page slots, virtual
   shells/spacers, per-page interaction routing, saved logical anchors and
   foreground visible-page scheduling. Keep a temporary single-page setting for
   comparison. Existing engines can run this milestone unchanged.
3. **Bounded preparation.** Add available-neighbor LRU preparation, frontier
   budgets and priority cancellation. Add/test the preserve-PNG-base capability
   before enabling speculative exports during active PNG use. Tune resource
   budgets from actual VS Code traces, not only the browser harness.
4. **Default and refinement.** Enable continuous mode after correctness and
   responsiveness checks; retain manual renderer controls. Consider lightweight
   geometry metadata, prefix validity and a tiny display-list cache only if
   traces justify them. None is a prerequisite for continuous scrolling.

Tests must cover mixed paper sizes/origins, inserting/removing pages above the
anchor, shrinking to zero pages, unknown-end growth without runaway compilation,
far explicit jumps, rapid reversal, zoom at a page boundary, DPR changes, source
edits during prefetch/decode, hidden-panel restoration and failed decodes.
Exercise two identical pages with different annotations, distant native inverse
search, stale-page interactions, SVG patch bases after eviction, and PNG typing
before/after neighbor preparation. Assert budgets and release callbacks as well
as visible results; count native render/advance requests to detect hidden work.

Extend the real-webview harness with 1/10/100-page sparse, dense and TikZ cases;
include long mixed-size documents and rapid scroll/edit traces. Record:

- Initial/active edit-to-paint and final-input-to-paint p50/p95, compared with
  prefetch disabled. Provisional acceptance: no more than 10% or 5 ms (whichever
  is larger) p95 regression for warm text edits under the same workload.
- Time from a new page entering the viewport to its first useful paint; warmed
  return navigation should need no compiler command or image body transfer.
- Mounted sheets, decoded pixels/estimated bytes, SVG nodes, host buffers,
  transient candidates, native viewer/worker memory and whole-webview memory
  where available. Long forward/back loops must reach a plateau.
- Foreground wait attributable to one obsolete speculative operation, cache
  hit/miss rates, dropped work, compiled frontier distance and exported bytes.

Adjacent pages must be visible together at arbitrary scroll positions, forward
search must preserve its target through geometry changes, and prefetch must stop
at its configured frontier budget with no further user movement. Existing error,
renderer fallback and single-page render tests remain necessary. Responsiveness
and correctness take priority over a higher prefetch hit rate.
