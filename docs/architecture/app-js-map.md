# Editor JavaScript map

Quick reference for working on the vanilla-JS editor without breaking init, restore, or plan gating.

## Script load order (`app.html`)

Scripts run in this order (each file adds globals to `window`):

```
image-utils.js
pro-gating.js      ← PRO detection, watermarks, star badges
warp-engine.js
eraser.js
mesh-warp.js
color-layer.js
undo.js
clip.js
pattern.js
background.js
migrations.js
app.js             ← main orchestrator (~9.7k lines)
export-ui.js       ← export popover, pattern PNG, canvas text export
plans-modal.js
clerk-auth.js
```

`export-ui.js` loads after `app.js` (needs `buildFullSnapshot`, `_autosaveDB`, `_textBoxes`).

## Global state (defined in `app.js` unless noted)

| Global | Role |
|--------|------|
| `canvasData[]` | One entry per mockup window (Fabric canvas, effects, flags) |
| `activeIndices[]` | Currently selected window indices |
| `backgrounds[]`, `designs[]` | Source image lists |
| `_userPlan` | `'free'` \| `'starter'` \| `'pro'` — set by `clerk-auth.js` |
| `globalUndoStack`, `globalRedoStack` | Undo/redo history (`undo.js`) |
| `_visibleWrappers` | IntersectionObserver cache for off-screen skip |
| `_markDirty()` | Marks workspace dirty for autosave |

Per-window flags used by PRO gating (in each `canvasData[i]`):

- `hasProEffect` — cached gate result (do not set manually)
- `forceProBadge` — Starter paste policy (cleared when real PRO effects appear)
- `meshWarpApplied`, `invertedMain`, `invertedExtras`, effect sliders, etc.

## Module responsibilities

| File | Responsibility |
|------|----------------|
| `pro-gating.js` | `_windowHasProEffect`, `_syncProEffect`, watermark, ⭐ badges, paste payload check |
| `export-ui.js` | Export popover, `exportDataToBlob`, pattern PNG download, canvas text export |
| `app.js` | Grid, selection, snapshot save/load, drop zone, sidebar wiring |
| `undo.js` | `captureWindowState` / `restoreWindowState`, global undo stacks |
| `mesh-warp.js` | Bicubic mesh warp modal, bake on Apply |
| `warp-engine.js` | Cylinder, arc, perspective sliders |
| `clip.js` | Bezier/polygon clipping masks |
| `pattern.js` | Repeating pattern fills |
| `color-layer.js` | Paint tint layer |
| `eraser.js` | Design-layer eraser |
| `background.js` | Background crop and color adjust |
| `image-utils.js` | Blur, noise, blend modes, mip chains |
| `migrations.js` | Snapshot schema versioning (placeholder for v2) |
| `plans-modal.js` | Pricing modal, Stripe checkout |
| `clerk-auth.js` | Sign-in, plan from Clerk metadata, `_refreshAllProStarBadges` on upgrade |

## PRO gating contract

1. **Never** set `data.hasProEffect` directly — call `_syncProEffect(data)`.
2. **Export filter** uses `_windowIsProGated(data)` (includes `forceProBadge`).
3. **Watermark** (`_drawWatermarkOnCanvas`): Free = all windows; Starter = gated windows only; Pro = none.
4. **Mesh warp** marks PRO only after Apply (`meshWarpApplied`).
5. **Copy alone** never marks PRO; **Starter paste** always sets `forceProBadge`.

Canonical spec: [Plans and gating](../features/plans-and-gating.md).

## Danger zones (high regression risk)

Avoid casual edits to these areas in `app.js`:

1. **Drop zone handlers** — file upload, multi-window creation
2. **`createCanvasPreviewsFromSnapshot`** — restores Fabric canvases from JSON
3. **Autosave `DOMContentLoaded` block** — IndexedDB session flush/restore
4. **Cloud project load/save** — snapshot serialization (`buildSnapshot`, etc.)
5. **`_refreshAllProStarBadges`** — small; safe, but calls into `pro-gating.js`

When changing PRO rules, prefer editing `js/pro-gating.js` and running:

- `tests/pro-effect-gating.test.js`
- `tests/watermark-plan-upgrade.test.js`
- `tests/duplicate-source.test.js`

Duplicate layers always receive an independent `_cloneEraserSource` copy in `extraDesignOriginals`. Watermark drawing is suppressed during active canvas drag/pan (see `_beginWatermarkInteraction` in `pro-gating.js`).

## Tests that load editor code

| Test file | Loads |
|-----------|-------|
| `pro-effect-gating.test.js` | Full `pro-gating.js` |
| `watermark-plan-upgrade.test.js` | `pro-gating.js` + `_refreshAllProStarBadges` from `app.js` |

These no longer slice `app.js` by line number.
