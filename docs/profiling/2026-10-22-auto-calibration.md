# Auto render-cost calibration — 22 October 2026

The native image header now reports optional `exportMs` without enabling verbose
profiling. Two monotonic clock reads surround only preflight/export/encoding,
after the compiler and display-list construction have finished. The field is
validated as a finite nonnegative number. Existing engines remain compatible.

Auto's SVG safety budgets now include native export, host preparation/diff and
webview decode/DOM work. They remain 80 ms for mounts and 24 ms for patches.
These are rendering work, not input-to-visible latency: compiler rollback,
pipe/IPC delivery, animation-frame scheduling and GPU completion are excluded.
The end-to-end rapid-input harness measures a separate paint opportunity.

For comparative selection, the controller keeps bounded recent full/patch
samples, split by codec, page, requested physical raster width, page bounds and
25%-wide logarithmic vector-complexity class. Manual PNG edits can contribute
once Auto has established the page's complexity. Cache references, regions,
failed decodes and engines without export timing cannot teach comparisons.

Five observations of each codec in 30 seconds are required. PNG is preferred
only when its upper quartile beats SVG's lower quartile by more than both 3 ms
and 25%; reversal needs equally clear evidence. There are at most 64 contexts
and eight samples per codec/context. This avoids changing policy on the earlier
1–3 ms Auto/SVG ordering differences, and separates slow initial mounting from
warm patch work. No additional render probes are introduced. A natural first
PNG and idle SVG are useful full-render observations, but do not supply a warm
PNG crop comparison. Missing comparative evidence keeps the existing SVG policy.

The final twelve-session rapid-input matrix uses native revision `140b9ca`,
including export timing, compiler-fence coverage and dead-root recovery fixes.
Earlier runs with `0868436` exposed the worker-recovery failure; an unflagged
rerun on the repaired engine completed but contained invalid timer-throttled
schedules and is retained only for diagnosis. Compiler-fence improvements have
their own focused before/after measurements. This calibration change supplies
render-only feedback and guards; it is not evidence of a new general end-to-end
Auto speedup.
