# Undo / redo architecture

Mockupscripter uses a **hybrid undo stack**: per-window property snapshots for value changes, typed entries for structural and special operations.

## Buckets - pick one when adding a feature

| Bucket | API | When to use |
|--------|-----|-------------|
| **Property** | `pushPropertyUndo()` / `pushGlobalUndo()` | Same windows exist; only transforms, effects, masks, notes, etc. change |
| **Structural insert** | `pushInsertionUndo()` | Windows added (duplicate, add window) |
| **Structural delete** | `pushDeletionUndo()` | Windows removed |
| **Structural reorder** | `{ type: 'reorder' }` | Drag-reorder grid |
| **Special** | `{ type: 'eraser' }`, `{ type: 'warp' }` | Pixel or baked-geometry mutations |
| **Meta** | `{ type: 'layout' }`, `{ type: 'pan' }`, `{ type: 'selection' }`, `{ type: 'textboxes' }` | UI-only state |

Reorder undo/redo re-appends **`cellEl`** (the grid item), not `wrapperEl`. Matches drag-drop and deletion restore.

**Rule:** If `canvasData.length` or DOM grid order changes, **never** use bare `pushPropertyUndo()`.

## New feature checklist

1. Does it change **which windows exist**? → `pushInsertionUndo` or `pushDeletionUndo`
2. Does it change **pixels / originals**? → `eraser` or `warp` typed entry
3. Otherwise → `pushPropertyUndo` on affected windows
4. Continuous input (slider drag)? → capture once per gesture (`_*UndoLocked` pattern)
5. New persisted fields → add to `captureWindowState` **and** `restoreWindowState` (Phase 2: shared serializer)

## Selection identity

Store **window data object refs** in structural undo entries, not numeric indices. Resolve with `canvasData.indexOf(d)` when applying.

Helpers: `_applySelectionFromDatas(datas, lastData)`, `_remapActiveIndicesByData()`.

## Structural entry shapes

```javascript
// Insert (duplicate, add window)
{ type: 'insertion', saved: [{ originalIdx, data }], prevActiveDatas, prevLastSelected, nextActiveDatas, nextLastSelected }

// Delete
{ type: 'deletion', saved: [{ originalIdx, data }] }
```

Undo for insertion → `_reDeleteWindows(saved)` + restore prior selection.  
Redo for insertion → `_restoreDeletedWindows(saved)` + restore duplicate selection.

Removal uses **data object identity**, not stale `originalIdx` slots.

## Property entry shape (default)

```javascript
{ affected: [indices], states: [captureWindowState(...)] }
```

## Out of scope (Phase 2+)

- Merging `captureWindowState` with `buildSnapshot`
- Generalized `beginUndoTransaction` for all sliders
- Full document snapshots on every undo step
- Persisting structural undo in project save (`buildFullSnapshot` still stores pan/selection only)

## Tests

- `tests/undo-structural.test.js` - insertion/delete helpers and data-ref removal
- Manual: prelaunch checklist undo section
