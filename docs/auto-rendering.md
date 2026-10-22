# Automatic preview rendering

Auto is the toolbar default for fresh previews. Existing explicit PNG/SVG choices
remain saved in the webview state. The Auto label stays fixed while its chosen
codec changes. Normal updates have no status banner; actionable failures still
appear, and explicit SVG fallback details are available in the format tooltip.

## First frame and updates

The optional `adaptiveRendering` engine capability enables `preview-auto`.
Its preflight walks the existing MuPDF display list without outlining fonts,
decoding images or rasterizing a second representation. A weighted glyph/path
score selects a single export: initially SVG below 16000 units, otherwise PNG.
Unsupported graphics, raster images and pages above 200000 units stay PNG.
Older engines receive the existing PNG command; explicit SVG remains available
when advertised independently.

After a PNG is acknowledged, an eligible page can receive an SVG upgrade after
350 ms without preview interaction. Page edits/navigation, source synchronization,
magnification and zoom/scroll gestures have priority. A held pointer prevents
upgrades. New work cancels pending upgrades and may supersede an in-flight one;
late frames and acknowledgments are ignored by request ID and source revision.
The native exporter is synchronous, so an export already executing is not
preemptible halfway through; eligibility and existing output limits bound it.

An upgrade reuses the current compiled snapshot and display list. It does not
request another compiler pass. Existing SVG bytes are reused where cached.
PNG viewport-detail renders are deferred while an SVG upgrade is pending;
interactive magnification still works immediately. If SVG preparation fails or
its markup cannot use the bounded static DOM renderer, the PNG remains displayed
and normal detail rendering resumes. PNG-to-SVG swaps keep page geometry, zoom,
scroll and source/link coordinates.

## Learning and bounds

New engines report `exportMs`, measured after compilation/display-list creation
and before pipe writing. The controller adds its preparation/diff work and the
webview's image/DOM-update elapsed time. These render-work timings exclude
compiler rollback, pipe/IPC delivery and GPU completion. Older engines can omit
the field and retain the earlier host/browser safety budgets. A first SVG
mount may take up to an 80 ms policy budget; subsequent DOM patches have a tighter
24 ms budget. Distinguishing those cases avoids abandoning fast incremental SVG
updates because the initial mount was expensive.

A successful SVG page gets a higher direct-render complexity allowance (its
previous score plus 30%, capped at 200000), so later edits keep using SVG and DOM
patches without an intervening PNG. If SVG proves slow or unusable, the next edit
starts as PNG. Another idle SVG attempt requires at least a 25% reduction in
complexity. The learned page table holds at most 32 entries. Existing encoded,
decoded and prepared-SVG cache budgets remain in force; SVG cache keys are
independent of raster width. These are starting policy thresholds, not universal
performance guarantees.

Comparative learning also retains up to eight recent observations per codec and
phase in at most 64 page/viewport/complexity contexts. Full mounts and incremental
patches are never compared against one another; decoded-cache hits and detail
regions are excluded. PNG observations come from natural Auto frames or manual
PNG edits, without speculative rendering probes. Five observations of each codec
within 30 seconds are required before speed can select PNG. Its upper quartile
must beat SVG's lower quartile by both 3 ms and 25%; reversal requires similarly
strong evidence. Small differences and single stalls do not change the choice.
An established PNG speed preference also suppresses idle SVG conversion so the
native comparison raster remains available for subsequent crops. Absent
comparable warm PNG observations, warm SVG retains its existing policy.
This makes calibration conservative; a PNG-first/SVG-idle pair alone cannot
establish which incremental path is faster.

Auto currently prioritizes responsiveness without gating work on battery state.
Energy preferences can be added separately from format selection.

## Verification

Unit tests cover acknowledgment-gated upgrades, pointer holds, interactive
preemption, source barriers, slow/unsupported SVG and reduced-complexity retries.
Real-engine tests compare Auto PNG/SVG bytes with their explicit counterparts,
check fidelity fallbacks, and exercise cached navigation and inverse SyncTeX.
The VS Code integration suite runs with Auto as its fresh-webview default.

For a manual browser check using the production controller and webview scripts:

```sh
npm run compile-tests
TEXPRESSO_PROFILE_CODECS=auto TEXPRESSO_PROFILE_KINDS=sparse,dense \
TEXPRESSO_PROFILE_REPEATS=1 TEXPRESSO_PROFILE_MANUAL=1 \
node scripts/profiling/browser.cjs artifacts/profile-auto-new
```

Open `http://127.0.0.1:9383/preview?index=1` for the dense fixture (index 0 is
sparse). Harness-only buttons insert/backspace a letter in page 1; the frame
trace distinguishes full-page renders and PNG detail regions. The manual check
observed `PNG → SVG → SVG` for initial display, idle promotion and a text edit,
with scroll/zoom preserved; revisiting the page reused its SVG. No native windows
or network downloads are needed.
