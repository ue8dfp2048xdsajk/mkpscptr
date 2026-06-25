---
name: Warp/tilt gates & in-place eraser caching
description: Two recurring traps in the design warp pipeline (js/app.js) — arcTilt gated in two places, and reference-identity caches that break under in-place mutation.
---

## arcTilt must be honored in BOTH warp gates
A warp feature can be silently dropped because it is gated in two independent places. For `arcTilt` specifically:
- `createWarpedImage` has an early-return at the top that returns an unwarped copy when the warp amounts are zero. This condition must include `arcTiltAmount === 0`, otherwise tilt-only never enters the slice loop.
- `_renderPattern` (pattern mode) only calls `createWarpedImage` when its `hasWarp` flag is true. `hasWarp` must include `(data.arcTilt || 0) !== 0`, otherwise tilt-only is ignored in pattern mode even though it works in regular mode.

**Why:** Symptom was "arc tilt does nothing unless cylinder warp or vertical arc is dragged first" — dragging warp/arc flipped both gates true, which then let the tilt path run. Perspective was NOT affected (its own flag/path already included it); the user had simply grouped perspective with the broken tilt. Perspective verified working live in both modes.

**How to apply:** When adding/auditing any warp parameter (cylinder, arc, tilt, perspective), confirm it is represented in (a) `createWarpedImage`'s early-return/short-circuit, (b) `_renderPattern`'s `hasWarp`/`hasPerspective` flags, and (c) the per-object cache key. The slice loop already has explicit `cylinderAmount === 0` branches for `dx` and `projectedSliceW`, so tilt-only flows through without dividing by `sinMax` (no NaN/Infinity).

## Reference-identity caches are unsafe against in-place mutation (eraser)
When zero effects are active, the blur/noise/flip helpers return the SAME source canvas reference (they don't copy). The eraser mutates that source canvas IN PLACE. So any cache/guard keyed on reference identity (e.g. `data._dsSrc === tileEl`) cannot detect that pixels changed.

The concrete bug: `_renderPattern` builds an async HQ mip via `createImageBitmap` whose `.then()` guard was reference-only. A pre-erase bitmap could resolve after mouse:up and repaint un-erased pixels — "I erase, it comes back." Intermittent because the mip is only built when the source is much larger than the display tile.

**Fix pattern:** keep a monotonically-incrementing `data._tileEpoch`, bump it wherever the eraser invalidates caches (`applyDesignEraserAt`), capture it before the async call, and require `data._tileEpoch === capturedEpoch` in the resolve guard. Undefined-vs-undefined (no erase yet) passes, as intended.

**How to apply:** Any time you cache a derived bitmap/canvas off a source that can be mutated in place, guard with an epoch/generation counter, not reference identity. Bump the counter at every in-place mutation site.
