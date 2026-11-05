# References disappearing during editing

Reproduced on native `3fbbd75`: a two-page document first resolves a forward
reference through automatic auxiliary convergence. Changing an unused preamble
macro, without changing the rendered document, then turns its first-page
reference back into `??`. Its PNG is byte-identical to the cold unresolved pass.

`rollback_processes` discarded every convergence-created auxiliary overlay,
including the copied `.aux` input containing resolved labels. A root replay
therefore started without those labels. Automatic recovery waited for 500 ms of
idle time and completion of the remaining document; continued typing could
postpone it. Cursor preparation also uses this rollback path.

Native `c00fbafe2ba882274602839701460cbb3d0e6a9d` cancels the finishing activity
while retaining the last pass's copied auxiliary input, as ordinary LaTeX keeps
`.aux` files between runs. A later completed convergence pass still replaces
that input. No image holding, rendering debounce, or new idle delay was added.

The new `aux-stability.test.ts` regression fails on the old engine and passes on
the fix. It checks pixel equality across three unused-preamble edits with
automatic reruns disabled, then independently checks actual section renumbering,
retention of the updated result on another edit, and genuine unresolved output
after deleting the label. This distinguishes retaining auxiliary state from
simply preserving an old page image.

Validation: 34 headless engine tests, 142 extension unit tests, TypeScript and
lint pass. An initial engine-suite attempt hit the existing canceled-preparation
fence timing race; that failure also reproduced on the unmodified old engine.
The isolated fixed-engine check and final full 34-test run passed. No preparation
code was changed in this fix. Raw logs and before/after PNGs are under ignored
`artifacts/reference-retention-*`.

The canonical local preview bundle was rebuilt using cached dependencies,
relocated, and signed, preserving the existing XeTeX worker and bundled libraries.
An existing preview process needs a restart to load the updated binary.

The canonical bundle's reference regression and actual VS Code preview acceptance
also pass. The cache-navigation acceptance assertion now counts exports of the
revisited page, allowing unrelated neighboring-page prefetch to continue; the
initial attempt's extra export was for page 3, while page 1 was reused correctly.
