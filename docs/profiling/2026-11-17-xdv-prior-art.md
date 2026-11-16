# XDV analysis and retained-rendering prior art

Read-only source review on 2026-11-17. Sources below were fetched from their
primary repositories; no third-party source was copied into this project and no
download, dependency installation, native build, or benchmark was performed.
Links name the inspected branch paths and can change after this review.

There is useful existing code for decoding XDV, producing readable diffs, and
tracking rendering dependencies. This search did **not** identify a ready-made
generic XDV block matcher that proves equal incoming interpreter/resource state
and safely reuses arbitrary rendered substreams. That is a search result, not a
claim that no such implementation exists.

## Ranked findings

### 1. WebRender: strongest model for correctness-aware damage

- [picture.rs](https://github.com/servo/webrender/blob/main/webrender/src/picture.rs):
  `TileDescriptor`, `PrimitiveDependencyInfo`, `PrimitiveComparer`,
  `update_dirty_rects`, and the opening picture-caching documentation.
- [intern.rs](https://github.com/servo/webrender/blob/main/webrender/src/intern.rs):
  stable handles and `ItemUid`; the UID combines an index and an epoch, so reused
  storage slots do not identify different interned content as the same item.
- License verified in both source headers: MPL-2.0.

WebRender compares ordered primitive dependencies, clips, images, opacity and
transforms between frames. Its quadtree combines invalidated leaves into dirty
rectangles; changed backgrounds also invalidate tiles. The useful pattern is to
intern immutable drawing content and track placement and rendering dependencies
separately. This is more directly relevant to conservative damage than a byte
diff of XDV. It is a browser renderer with its own intermediate representation,
not a MuPDF/XDV library that can be dropped into our engine. Its tile dimensions
and GPU decisions are not performance evidence for our workload.

### 2. Tectonic: strongest existing XDV decoding reference

- [crates/xdv/src/lib.rs](https://github.com/tectonic-typesetting/tectonic/blob/master/crates/xdv/src/lib.rs):
  `XdvParser`, `XdvEvents`, `State`, glyph handling and incremental chunk parsing.
- [xdvdump.rs](https://github.com/tectonic-typesetting/tectonic/blob/master/crates/xdv/examples/xdvdump.rs):
  a small consumer showing how to collect information from parser events.
- [Cargo.toml](https://github.com/tectonic-typesetting/tectonic/blob/master/crates/xdv/Cargo.toml)
  and source headers explicitly declare MIT.

The parser tracks the six DVI position registers and stack, selected font,
native font definitions and glyph positions. It exposes stream offsets, supports
chunked input, and resolves native glyph runs into absolute coordinates. These
are useful references for decoder cross-checks and canonical analysis output.
Specials are handed to the caller as bytes: it does not interpret their PDF
graphics state, imported-resource semantics or resource invalidation. It also
does not provide a retained renderer or an unchanged-block reuse proof. Treat
it as a decoder/position interpreter, not a complete replacement for our DVI
interpreter.

### 3. SIL PTXprint: particularly relevant readable XDV diffs

- [xdv.py](https://github.com/sillsdev/ptx2pdf/blob/master/python/lib/ptxprint/xdv/xdv.py):
  `XDViReader`, `XDViPositionedReader`, and `XDViWriter`.
- [xdvtype.py](https://github.com/sillsdev/ptx2pdf/blob/master/python/lib/ptxprint/xdv/xdvtype.py):
  `xdvitype` command, `--diffable`, `--positions`, and `--glyphnames`.
- [getfiles.py](https://github.com/sillsdev/ptx2pdf/blob/master/python/lib/ptxprint/xdv/getfiles.py)
  extracts font and PDF-image references;
  [layout.py](https://github.com/sillsdev/ptx2pdf/blob/master/python/lib/ptxprint/xdv/layout.py)
  interprets explicit layout-tag specials.
- [pyproject.toml](https://github.com/sillsdev/ptx2pdf/blob/master/pyproject.toml)
  declares the Python project MIT and registers `xdvitype`.

This is the closest match to an existing human-readable diff harness. It
provides readable font/glyph records and positioned decoding. Important
limitation: diffable mode strips font directories and excludes preamble comments;
displayed dimensions/positions are rounded. Those choices improve diagnostic
diffs but cannot be used as pixel-identity cache keys. Its file-reference scanner
also recognizes selected specials rather than proving complete dependency
coverage. Reuse its inspection ideas, while retaining exact operands and full
resource identities in any correctness-sensitive representation.

### 4. dvisvgm: mature interpreter and an actual page-hash cache

- [BasicDVIReader.cpp](https://github.com/mgieseki/dvisvgm/blob/master/src/BasicDVIReader.cpp):
  opcode decoding and instruction-size handling.
- [DVIReader.cpp](https://github.com/mgieseki/dvisvgm/blob/master/src/DVIReader.cpp):
  DVI/XDV execution, position state, virtual fonts, and `computePageHash`.
- [DVIToSVG.cpp](https://github.com/mgieseki/dvisvgm/blob/master/src/DVIToSVG.cpp):
  combines page and option hashes and skips conversion when the named output
  already exists.
- License verified in source headers: GPL-3.0-or-later.

`computePageHash` hashes page-body bytes, excluding BOP/EOP. This is concrete
precedent for syntactic page caching, but the inspected hash function does not
add font-file or imported-file content identities, incoming specials state, or
other external rendering dependencies. It therefore does not establish that
equal substream bytes are sufficient for our reuse rules. Its interpreter is a
valuable independent reference for XDV semantics and malformed input. Recent
[NEWS](https://github.com/mgieseki/dvisvgm/blob/master/NEWS) also records fixes
for malformed DVI, deterministic fonts and rendering correctness.

### 5. MuPDF: use its existing retained-list semantics as the boundary

- [source/fitz/list-device.c](https://github.com/ArtifexSoftware/mupdf/blob/master/source/fitz/list-device.c):
  retained drawing records, scissor culling, `fz_run_display_list`, and
  `tile_skip_depth`.
- License verified in source header: AGPL-3.0-or-later; header also identifies
  alternative commercial licensing.

The display list already records graphics state and bounds, and its replay can
suppress callbacks for off-scissor content while maintaining nesting. Cached PDF
pattern tiles also have an explicit begin callback result that suppresses their
contained drawing callbacks. Replay still decodes list records before its tile
skip check: callback suppression is not equivalent to constant-time subtree
skipping. This distinction is directly relevant to measuring our marker proxy.
The implementation is useful guidance for nesting and resource lifetimes; PDF
pattern tiles have drawing semantics and should not be repurposed as arbitrary
nonvisual cache markers.

### 6. Upstream TeXpresso: streaming incrementality, not generic block matching

- [src/frontend/incdvi.c](https://github.com/let-def/texpresso/blob/main/src/frontend/incdvi.c):
  page indexing, rollback of parsed offsets, initialization/font definitions,
  and `incdvi_render_page`.

The inspected upstream implementation incrementally recognizes complete
instructions/pages as the output buffer grows and rolls indexing back when the
buffer shrinks. Rendering replays instructions between page boundaries, with
font/initialization processing before the page. This is the existing foundation,
rather than a newly discovered subpage matching algorithm. Our local engine
already adds further page caching and rendering work beyond this upstream file.
Do not infer licensing for the entire bundled engine from the upstream root
license: bundled components have their own licenses.

## Consequences for this experiment

1. Keep raw instruction equality, normalized diagnostic equality and proven
   rendering equivalence as separate concepts. PTXprint is a useful example of
   why normalization suitable for a diff can intentionally erase distinctions.
2. A canonical trace can resolve relative positioning and font definitions for
   analysis. Specials remain barriers unless their state and resource effects
   are interpreted or the cache boundary is narrowed to known immutable content.
3. WebRender's stable identities plus explicit dependency descriptors are a
   stronger direction for eventual damage tracking than treating a byte-diff
   match as a reusable picture.
4. Measure MuPDF list traversal separately from path hashing and rasterization.
   Reusing per-cell leaves removes hashing work; it does not by itself remove
   retained-list decoding or interpretation of newly generated XDV.

No third-party code adoption or new dependency is proposed by this report.
