# Cursor-guided edit preparation

The embedded preview prepares a compiler checkpoint near the source selection
before the next edit. This uses the existing adaptive READ fences and compiler
process history, without changing source contents or starting a second engine.

## Scheduling

The extension observes the active source editor and the start of its selection.
It waits 200 ms after the cursor settles and until the current foreground page
has been decoded. Open-buffer changes still go straight to the engine; they do
not wait for this timer. UTF-16 editor offsets are converted to UTF-8 offsets
only after that idle delay, using an already synchronized logical engine path.
Cursor movement never opens an input or creates an overlay.

Visible-page work, edits, SyncTeX, links, magnification and gestures interrupt
preparation. Hiding, pausing or disposing the preview stops it too. Preparation
precedes speculative neighbor rendering and idle SVG refinement. It has its own
request identity, without taking the image/decode credit. Late acknowledgments
cannot settle newer work. Completed attempts are remembered in a bounded
16-entry cache keyed by source epoch, file and 64-byte bucket. Interrupted work
can be retried when activity settles. Skipped or previously untracked positions
can be retried after foreground source discovery, without an idle retry loop. A host watchdog cancels a missing reply
after five seconds.

## Engine behavior

The optional `prepareEdit` capability enables these commands:

- `preview-prepare id absolutePath byteOffset revision sequence`
- `preview-prepare-cancel id` (zero cancels any request)
- `preview-prepared id revision sequence status`, where status is `ready`,
  `cached`, `skipped` or `cancelled`.

The native engine accepts an already observed source location and reuses a
suitable checkpoint when possible. Otherwise it rolls back unchanged input,
places one READ fence, and replays to the checkpoint immediately before the
aligned target bytes. It stops when the fork is acknowledged, with a 2.5-second
native replay limit and short stepping bursts so incoming commands can preempt
it. Unknown inputs, stale source epochs and unavailable targets are skipped;
preparation does not compile an unread document merely to discover its cursor.
The existing 32-process history bound remains in effect.

The displayed page, image comparison base, source sequence and reported preview
state stay intact during replay. Compiler DVI and SyncTeX buffers can rewind,
so the host forgets its native hit-testing-page assumption. A subsequent
foreground request releases the compiler hold; inverse search waits for its
page and SyncTeX data to be restored. Source edits use the ordinary change and
barrier path. Cancellation preserves the single pending READ fence for foreground
compilation to adopt: an edit ahead of the replay's read cursor would otherwise
miss its adaptive checkpoint and cause a second cold replay. Obsolete retained
fences are discarded when retargeted, outside current input, or at termination.
PNG dirty rectangles and SVG DOM patches retain their acknowledged
browser bases throughout preparation.

The macOS periodic checkpoint guard remains unchanged. Explicit READ fences
use the same fork path as existing adaptive edits. Native regressions exercise
named system fonts first used after the prepared point and a later edit that
introduces a different font, comparing results with a fresh engine.

## Scope and validation

This helps when a cursor rests at an already rendered source location long
enough to finish preparation. Typing before completion cancels speculation and
continues through the normal edit path. Rapid source changes can still trigger
an ordinary root rollback before a useful READ trace exists. A canceled pending
fence now survives that restart when the edit is in the same source at or after
the fence, allowing foreground compilation to create the planned checkpoint.
Earlier edits, changes to another file, shortened input, and termination discard
it. This closes the extra cold replay observed in
[the original measurements](profiling/2026-10-22-prewarm.md); a deterministic
trace-zero regression checks the interrupted preparation case.

A Backspace at an exact 64-byte boundary
can require an earlier checkpoint than insertion at that caret. Preparation
keeps the existing fence alignment rather than unconditionally rewinding an
extra block, which can cross an expensive macro loop.

Unit tests cover idle scheduling, cancellation, byte conversion, stale replies,
cache bounds and retained image bases. Headless engine tests cover visible-state
preservation, actual edits after preparation/cancellation, included UTF-8 input,
inverse SyncTeX restoration, system fonts and process shutdown. The finite demo
sentence benchmark is recorded separately under `docs/profiling/`.
