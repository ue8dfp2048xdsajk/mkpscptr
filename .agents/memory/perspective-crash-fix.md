---
name: Perspective/arcTilt silent crash fix
description: Root cause and fix for perspective/arcTilt "does nothing" bug when warp=0 and arc=0.
---

## The bug
Arc tilt, horizontal/vertical perspective appeared to "do nothing" unless warp or arc was dragged first.

## Root cause
`trimTransparentBorders(srcOriginal)` is called inside the position-adjustment block of both `_applyWarpToOneObject` and `applyWarpToData` when `arcAmount===0 && warpAmount===0`.

`data.designOriginal` (and therefore `srcOriginal`) is sometimes an **HTMLImageElement** (when loaded via `new Image()` + `URL.createObjectURL`). HTMLImageElement has no `.getContext` method, so the call throws a `TypeError` synchronously.

This crash aborts the function **before** `requestRenderAll()` fires in the caller. `setElement` had already been called with the correct perspective canvas, but without `requestRenderAll()` Fabric.js never repaints — so the visual appears unchanged.

When warp or arc is non-zero, `_noArcWarp = false` so the position-adjustment block is skipped → no crash → perspective works fine.

## Fixes applied
1. **Guard `trimTransparentBorders`**: added `if(!canvas || !canvas.getContext) return canvas;` at the top. Returns the input unchanged (no `_trimX0` property) so callers treat it as "no trim needed".

2. **Include arcTilt in `_noArcWarp`**: changed both occurrences from
   `!(arcAmount) && !(warpAmount)` → `!(arcAmount) && !(warpAmount) && !(arcTilt)`
   because arcTilt also produces asymmetric transparent borders that must NOT be position-compensated.

**Why:** Arc tilt with warp=0,arc=0 entered the position-adjustment block and crashed identically to the perspective case. Both sliders now work correctly without needing warp/arc dragged first.
