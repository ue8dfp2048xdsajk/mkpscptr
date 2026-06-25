---
name: Extra design layers — originals & stale index
description: Invariants for extraDesignObjects/extraDesignOriginals undo/redo and the attachClipDrawing stale-index gotcha
---

# extraDesignOriginals must always be a drawable source

`data.extraDesignOriginals[i]` is fed straight into `ctx.drawImage` by the warp
render pipeline (`applyWarpToData` / `_applyWarpToOneObject`, and the per-extra
loops). So every entry MUST be a drawable element: an `Image` or a `canvas`.

**Why:** Restoring an undo state used to push a plain `{ src }` placeholder
object here, which is truthy (so the `|| data.designOriginal` fallback never
fires) but non-drawable — the next render that touched that layer threw/broke.
Fresh add stores a real `Image` (`finalImg`); restore must match that.

**How to apply:** When recreating a layer (e.g. `restoreDuplicatesFromState`),
store the actual loaded `Image`/canvas, never a `{src}` object. When serializing
for undo/save, derive the data URL with `_originalToSrc(orig)` (handles Image
`.src`, canvas `.toDataURL()`, and legacy `{src}`), not `orig?.src` — a bare
`.src` read returns null for canvas originals produced by eraser/invert/warp,
which silently drops the layer on restore.

# attachClipDrawing(index) param is stale

`attachClipDrawing(wrapper, fabricCanvas, data, index)` bakes in the window's
index at creation time, but windows are inserted with `canvasData.unshift(...)`
(and the main creation path passes a hardcoded `0`). So the captured `index`
drifts as more windows are added.

**Why:** The color-paint `mouse:down`/`mouse:move` guards compared the stale
`index` against the live `activeIndices`, so only the window currently at index
0 could ever paint — looked like "brush doesn't work on any window".

**How to apply:** In any event handler inside `attachClipDrawing`, recompute the
live index with `canvasData.indexOf(data)` instead of using the `index` param.
The clip-edit handlers (`activeClipWindowIndex = index`, `canvasData[index]`,
rubber-band guards) still use the stale param and carry the same latent risk.
