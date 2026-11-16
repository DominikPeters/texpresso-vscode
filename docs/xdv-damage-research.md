# XDV-assisted damage research

This experiment lives on `codex/xdv-block-reuse`. It does not modify the shipping
engine, its protocol, or the extension. Scratch builders compile a few frontend
translation units against an existing local build; they do not build the worker
or dependencies.

The question is whether a compact XDV instruction can identify an unchanged,
expensive set of drawing operations before those operations are fingerprinted.
An imported vector PDF is the first useful boundary: one `pdf:image` special can
expand into tens of thousands of MuPDF operations.

## Approaches compared

1. The unchanged engine renders the complete held sharp surface.
2. Flat structural damage fingerprints every drawing operation into canonical
   512-pixel cells, then redraws changed cells.
3. Hierarchical analysis fingerprints PDF imports separately and inserts their
   per-cell digests into the parent stream, without retaining those digests.
4. Cached hierarchical analysis reuses those digests for unchanged PDF imports.

The uncached hierarchical variant separates the cost of the hierarchy from the
benefit of reuse. Cache hits still traverse the display list; they skip path,
text and state serialization and hashing. They do not avoid interpreting the PDF
when a new page display list is built, and they do not cache rasterized figures.

## Identity and correctness boundary

The scratch PDF interpreter emits nonvisual layer markers around precisely
`pdf_run_page`. It does not flush pending DVI text or change paint order. Only
registry-issued markers with a process-random nonce are recognized, so an
ordinary PDF layer with a similar name is not a cache boundary.

Identity includes the resolved PDF document, its resource generation, resolved
page and bit-exact final transform. Every resource invalidation and manager
release advances the generation. Grid width, page bounds and held rectangle
also enter the fingerprint-cache key. A cache entry holds ordered per-cell
SHA-256 digests and supported/unsupported flags. Its provenance token enters
parent digests too, preventing pointer-derived hashes from matching across
resource destruction and address reuse. There are at most 16 fingerprint-cache
entries and 128 registered identities; eviction causes a miss.

Outer clip, group and painting-state events remain in the parent streams.
Changed cells replay all contributing content. Unsupported images, shades,
masks and patterns propagate through cached leaves and force full drawing.
Moved or replaced imports conservatively invalidate every cell through the
changed provenance token. More selective invalidation is future work.

Every candidate export is compared byte-for-byte with a fresh full sharp render.
The harness separately reconstructs the delivered patch chain and compares it
with the unchanged engine for the same source revision. Oracle rendering is
reported separately and excluded from estimated export cost. This finite test
corpus is not a proof for arbitrary PDF content.

## Syntactic XDV analysis

`xdv-stability.cjs` measures bounded raw-byte and instruction diffs, unchanged
balanced PUSH/POP subtrees, and stable PDF-image specials. It accepts complete
and incrementally emitted XDV streams and reports only hashes, counts and times.
Matched bytes do not justify skipping interpretation: PUSH/POP restores position
registers but not the selected font or arbitrary graphics/resource state.

The comparison includes ordinary text edits, reflow, direct TikZ edits, imported
PDF movement, scaling, replacement and repeated imports. Generated public PDFs
also contain an optional-content layer with a marker-like name; an image-bearing
PDF checks unsupported-operation fallback. The registry tests separately check
invalidation, aborts, transform changes, forged labels and eviction.

## Reproduction and scope

Use `build-damage-engine.cjs`, `build-xdv-engine.cjs`,
`make-xdv-fixture.cjs`, `xdv-block-benchmark.cjs` and
`summarize-xdv-blocks.cjs` under `scripts/profiling/`. The dated reports in
`docs/profiling/` preserve source and binary hashes, stage timings and commands.
Private source copies and XDV dumps stay in ignored `artifacts/` and are removed
after summarizing.

Native stage timings exclude browser presentation, scheduling and revision age.
Reference checks perturb CPU/cache behavior. These results do not decide tiles
versus a rolling surface, and they do not establish peak-memory behavior or a
production policy for enabling damage analysis on cheap pages.
