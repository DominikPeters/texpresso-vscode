# Broader damage study: findings

This study deliberately excludes the imported-PDF fingerprint cache. It compares
full PNG surface rendering, general structural damage, and a variant that redraws
changed cells directly into the destination instead of allocating and copying a
temporary pixmap for each cell. It is research code on
`codex/general-damage-study`; the shipping engine and extension are unchanged.

The full [stage tables and replay results](2026-11-17-general-damage.md) and
[hashes/statistics](2026-11-17-general-damage.json) accompany this note.

## What the broader cases show

Median estimated native export times, in milliseconds, including damage analysis
where applicable. These exclude compilation, drawing-list construction, IPC,
webview presentation and verification renders.

| Visible small edit | Full rendering | Damage with direct cell redraw |
| --- | ---: | ---: |
| Real dense one-column mathematics | 1.80 | 2.99 |
| Real two-column mathematics | 2.29 | 2.51 |
| Real slide with direct TikZ | 5.64 | 4.68 |
| Generated dense direct TikZ, 768 overlapping curves | 751.26 | 281.86 |
| Generated direct TikZ, 64 curves, partial clip and nonwhite theme | 64.01 | 29.87 |

The expensive direct-TikZ case demonstrates that the potential saving is **not
specific to imported PDFs**. It comes from avoiding expensive painting outside
changed cells. These generated plots deliberately stress rasterization; they do
not measure how common such costs are in users' documents.

The ordinary papers have cheap painting already. Damage analysis and maintaining
its raster base add work, and redrawing coarse cells may do almost as much
painting as the full surface. The real slide's small saving disappears during
reflow: full export was 18.31 ms versus 19.65 ms for damage. The heavy generated
reflow also regressed (365.38 versus 456.65 ms in the measured runs). Variant
order was fixed and there were only six measured edits per group; timing noise
and CPU/cache effects limit conclusions about small differences.

Avoiding temporary cell pixmaps is correct on these samples, but its performance
is mixed. For the heavy visible typing case, the original damage path was
279.02 ms and the direct variant was 281.86 ms. This does not justify adopting
the extra implementation on allocation-count arguments alone.

## Cost-based bypass

The report replays a gate using only previously observed full-paint cost, at
4/8/16 ms thresholds. It charges calibration, full probes and rebuilding a lost
signature base; it does not use the current frame's oracle cost to choose its
route. The 8 ms gate bypasses damage on both real papers and the real slide,
protecting those cheap cases. After calibration and a cold start, it reduces total
measured typing export cost on the dense generated plot by about 2x.

That is an **offline counterfactual**, not an implemented native controller or a
latency guarantee. Seven-edit sequences do not exercise the periodic 16-frame
probe; unit tests cover that logic, but a longer native workload is still needed.
The gate does not protect expensive pages against reflow regressions. Merely
knowing that a page is expensive is insufficient to decide that its next edit
will benefit from damage reuse.

## Validation and fixture corrections

The included data contains 252 sample frames, including warmups, with **168
candidate frames** checked against both a fresh full render and the unchanged
engine's reconstructed patch output. Every included small edit changes visible
pixels. Partial canonical cells and nonwhite color remapping pass pixel equality.

Two invalid viewport selections were diagnosed and excluded. The two-column
source location initially resolved to a float near the top rather than the edited
paragraph below; the viewport was placed over the visible paragraph and that
case rerun. The generated plots initially centered on the end of a long source
line, leaving subsequent digit edits outside the viewport. Those small-edit groups
were discarded and rerun with the text inside the viewport, with a new assertion
requiring a nonempty pixel update on every typing edit. Valid reflow/figure groups
and the already completed dense-math case were retained independently. Their
recorded viewport rectangles are exposed in the detailed report.

Original manuscripts were not changed. Private copies are disposable and are
removed after summarizing. Public fixtures can be regenerated with
`make-general-fixtures.cjs` under `scripts/profiling/`.

## Direction

Keep full rendering for cheap pages. Treat general damage as an optimization for
measurably expensive painting, with explicit cold-start and reflow behavior. The
included-PDF cache is a separate, narrower acceleration of analysis; it is not
the prerequisite for benefiting direct TikZ.

The present data does not support a universal damage path, a production gate,
or a general byte-diff reuse system. Before further adoption, use longer mixed
workloads and interleaved timing to evaluate the controller and reflow fallback.
Ordinary pages also need end-to-end presentation measurements: shaving painting
that already takes a few milliseconds is unlikely to be the most useful target.
