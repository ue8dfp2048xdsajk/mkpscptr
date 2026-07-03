'use strict';
// ── Design-layer eraser ──────────────────────────────────────────────────────

// Ensure a fabric.Image's underlying element is a writable canvas so we can
// draw destination-out circles directly onto the pixel data.
// Invert RGB pixels of a canvas in-place, preserving alpha.
function invertCanvasInPlace(canvas) {
    const ctx  = canvas.getContext('2d');
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const px   = imageData.data;
    for (let i = 0; i < px.length; i += 4) {
        px[i]     = 255 - px[i];
        px[i + 1] = 255 - px[i + 1];
        px[i + 2] = 255 - px[i + 2];
        // px[i + 3] = alpha — left unchanged
    }
    ctx.putImageData(imageData, 0, 0);
}

// Draw src (HTMLImageElement or canvas) to a new canvas with RGB inverted,
// alpha channel preserved.
function invertImageSource(src) {
    const w = src.naturalWidth  || src.width;
    const h = src.naturalHeight || src.height;
    const c = document.createElement('canvas');
    c.width  = w;
    c.height = h;
    c.getContext('2d').drawImage(src, 0, 0, w, h);
    invertCanvasInPlace(c);
    return c;
}

// Returns a new canvas with src flipped horizontally, vertically, or both.
function _flipImageSource(src, flipX, flipY) {
    const w = src.naturalWidth  || src.width;
    const h = src.naturalHeight || src.height;
    const c = document.createElement('canvas');
    c.width  = w;
    c.height = h;
    const ctx = c.getContext('2d');
    ctx.save();
    ctx.translate(flipX ? w : 0, flipY ? h : 0);
    ctx.scale(flipX ? -1 : 1, flipY ? -1 : 1);
    ctx.drawImage(src, 0, 0, w, h);
    ctx.restore();
    return c;
}

// Returns a (cached) flipped version of src using data.flipX / data.flipY.
// Cache is keyed on the source object so each unique source gets its own entry.
function _cachedFlip(data, src) {
    if(!data.flipX && !data.flipY) return src;
    if(!data._flipMap) data._flipMap = new WeakMap();
    const hit = data._flipMap.get(src);
    if(hit && hit.fX === !!data.flipX && hit.fY === !!data.flipY) return hit.canvas;
    const canvas = _flipImageSource(src, !!data.flipX, !!data.flipY);
    data._flipMap.set(src, { fX: !!data.flipX, fY: !!data.flipY, canvas });
    return canvas;
}

function ensureErasableCanvas(obj) {
    const el = obj.getElement();
    if (el && el.tagName === 'CANVAS') return el;
    const src  = el || obj._originalElement;
    const c    = document.createElement('canvas');
    c.width    = (src && (src.naturalWidth || src.width))  || obj.width;
    c.height   = (src && (src.naturalHeight || src.height)) || obj.height;
    if (src) c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    obj.setElement(c);
    obj.dirty = true;
    return c;
}

// ── Eraser undo helpers ───────────────────────────────────────────────────────
// Clone a canvas/image source for eraser undo.
// HTMLCanvasElement → fresh canvas with same pixels (mutable, must copy).
// HTMLImageElement / null → returned as-is (immutable, safe to reuse as reference).
function _cloneEraserSource(src){
    if(!src) return null;
    if(!(src instanceof HTMLCanvasElement)) return src;
    const copy = document.createElement('canvas');
    copy.width  = src.width;
    copy.height = src.height;
    copy.getContext('2d').drawImage(src, 0, 0);
    return copy;
}

// Own pipeline source for a duplicated layer (never shares canvas references).
function _sourceForDuplicateLayer(data, sourceObj) {
    const srcExtraIdx = (data.extraDesignObjects || []).indexOf(sourceObj);
    if (srcExtraIdx !== -1) {
        return _cloneEraserSource(data.extraDesignOriginals?.[srcExtraIdx] ?? data.designOriginal);
    }
    return _cloneEraserSource(data.designOriginal);
}

// Snapshot the designOriginal + every extraDesignOriginal for one window.
function _captureEraserSnapshot(data){
    return {
        original:       _cloneEraserSource(data.designOriginal),
        extraOriginals: (data.extraDesignOriginals || []).map(_cloneEraserSource)
    };
}

// Restore a previously captured eraser snapshot into a window's data.
function _applyEraserSnapshot(data, snap){
    data.designOriginal       = snap.original;
    data.extraDesignOriginals = snap.extraOriginals.slice();
    data.warpCanvas           = null; // invalidate warp cache so next applyWarpToData rerenders
}

// Convert the pipeline SOURCE (data.designOriginal or extraDesignOriginals[i])
// to a writable canvas so the eraser can modify it in-place.  Erasing the
// source rather than the post-warp display element means any subsequent
// blur/noise/warp/perspective re-run will start from the already-erased image.
function _ensureErasableOriginal(data, obj) {
    const isMain   = obj === data.designObject;
    const extraIdx = isMain ? -1 : (data.extraDesignObjects || []).indexOf(obj);
    if (!isMain && extraIdx < 0) return null;

    let src = isMain
        ? data.designOriginal
        : (data.extraDesignOriginals?.[extraIdx] ?? data.designOriginal);
    if (!src) return null;

    if (src instanceof HTMLCanvasElement) return src;

    // Convert HTMLImageElement (or other drawable) → canvas at natural resolution.
    const c = document.createElement('canvas');
    c.width  = src.naturalWidth  || src.width  || obj.width;
    c.height = src.naturalHeight || src.height || obj.height;
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);

    if (isMain) {
        data.designOriginal = c;
        data.warpCanvas     = null; // invalidate warp cache
    } else {
        if (!data.extraDesignOriginals) data.extraDesignOriginals = [];
        data.extraDesignOriginals[extraIdx] = c;
    }
    return c;
}

// Erase a soft circle from obj at a Fabric canvas-space point.
// data is the owning canvasData entry, used to convert CSS px → Fabric units.
function eraseFromObject(obj, data, pointer) {
    // ── Shared radius calculation ──────────────────────────────────────────────
    // CSS-pixel radius → Fabric logical canvas units.
    const cvEl         = data.fabricCanvas.upperCanvasEl;
    const rect         = cvEl.getBoundingClientRect();
    const cssToFabric  = (rect.width > 0) ? (data.fabricCanvas.width / rect.width) : 1;
    const fabricRadius = designEraserSize * cssToFabric;

    // Fabric canvas-space → object-local space (origin = object centre)
    const inv   = fabric.util.invertTransform(obj.calcTransformMatrix());
    const local = fabric.util.transformPoint(pointer, inv);

    const softFrac = designEraserSoftness / 100;

    // ── Helper: draw an erase circle onto a canvas context ────────────────────
    function _drawErase(ctx, px, py, radius) {
        const innerR = Math.max(0, radius * (1 - softFrac) - 0.5);
        ctx.save();
        ctx.globalCompositeOperation = 'destination-out';
        if (softFrac < 0.02) {
            ctx.beginPath();
            ctx.arc(px, py, radius, 0, Math.PI * 2);
            ctx.fill();
        } else {
            const grad = ctx.createRadialGradient(px, py, innerR, px, py, radius);
            grad.addColorStop(0, 'rgba(0,0,0,1)');
            grad.addColorStop(1, 'rgba(0,0,0,0)');
            ctx.fillStyle = grad;
            ctx.beginPath();
            ctx.arc(px, py, radius, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.restore();
    }

    // ── Step 1: Erase the PIPELINE SOURCE (designOriginal / extraDesignOriginals)
    // This is the key fix: modifying the source means every subsequent
    // applyWarpToData call (blur, noise, warp, perspective) will start from
    // the already-erased image and cannot accidentally restore erased pixels.
    const srcEl = _ensureErasableOriginal(data, obj);
    if (srcEl) {
        // Object-local → source-canvas pixel coordinates.
        // obj.width reflects the current Fabric element width (post-warp if warp
        // is active), which may differ from srcEl.width; we use srcEl dimensions
        // directly so the mapping is always in source-image pixel space.
        const srcHW  = srcEl.width  / 2;
        const srcHH  = srcEl.height / 2;
        // Fabric local coords are in "Fabric units" = source-image pixels when
        // scaleX == (1/dpr)/previewScale.  Dividing by that gives source pixels.
        // Simpler equivalent: same (local.x / scaleX * srcSX) formula collapses
        // to (local.x + srcHW) when sx = 1, which is the no-warp case.
        // For warp (obj.width ≠ srcEl.width) we scale proportionally.
        const srcSX  = srcEl.width  / (obj.width  || srcEl.width);
        const srcSY  = srcEl.height / (obj.height || srcEl.height);
        const spx    = (local.x + (obj.width  || srcEl.width)  / 2) * srcSX;
        const spy    = (local.y + (obj.height || srcEl.height) / 2) * srcSY;
        const scl    = Math.min(obj.scaleX || 1, obj.scaleY || 1);
        const srcRad = Math.max(0.5, fabricRadius / scl * Math.min(srcSX, srcSY));
        _drawErase(srcEl.getContext('2d'), spx, spy, srcRad);
    }

    // ── Step 2: Also erase the live DISPLAY ELEMENT for immediate visual feedback
    // When warp/perspective is active, applyWarpToData is only called on mouse:up
    // (for performance), so we update what the user sees here during the stroke.
    const dispEl = ensureErasableCanvas(obj);
    const dsx    = dispEl.width  / obj.width;
    const dsy    = dispEl.height / obj.height;
    const dpx    = (local.x + obj.width  / 2) * dsx;
    const dpy    = (local.y + obj.height / 2) * dsy;
    const scl2   = Math.min(obj.scaleX || 1, obj.scaleY || 1);
    const dRad   = Math.max(0.5, fabricRadius / scl2 * Math.min(dsx, dsy));
    _drawErase(dispEl.getContext('2d'), dpx, dpy, dRad);
}

// Apply the eraser at a canvas-space point to design objects in one window.
// If specific layers were selected when eraser mode was entered those are the
// only ones touched; otherwise all design layers in the window are erased.
// For windows the user wasn't on at entry time the restriction is dropped so
// they don't have to exit and re-enter just to switch windows.
function applyDesignEraserAt(data, pointer) {
    let targets = [];
    if (data.designObject)       targets.push(data.designObject);
    if (data.extraDesignObjects) targets.push(...data.extraDesignObjects);
    if (eraserTargetObjects.size > 0) {
        const filtered = targets.filter(obj => eraserTargetObjects.has(obj));
        if (filtered.length > 0) targets = filtered;
    }
    if (!targets.length) return;

    const hasWarp = (data.warpAmount || 0) || (data.arcAmount    || 0) ||
                    (data.perspectiveTop || 0) || (data.perspectiveLeft || 0);

    targets.forEach(obj => eraseFromObject(obj, data, pointer));

    // The eraser modifies source canvases IN-PLACE (same JS reference, different pixels).
    // Several pipeline caches use reference equality to detect source changes, so they
    // would serve stale results after an in-place modification.  Invalidate them all:
    //   • data._dsSrc / _hqCanvas  — pattern tile mipmap cache in _renderPattern
    //   • data._flipMap            — flip cache keyed by source canvas reference
    //   • obj._c_src / _c_warpOk  — per-object blur/noise/warp cache in _applyWarpToOneObject
    data._dsSrc    = null;
    data._hqCanvas = null;
    data._flipMap = null;
    // Bump the tile epoch so any in-flight async HQ-mip (createImageBitmap) that
    // snapshotted the pre-erase pixels is rejected on resolve. The mip guard
    // relies on reference identity, but the eraser mutates the source canvas
    // IN PLACE (same reference), so without an epoch a stale un-erased bitmap
    // would pass the guard and visibly restore the erased pixels in pattern mode.
    data._tileEpoch = (data._tileEpoch || 0) + 1;
    targets.forEach(obj => {
        obj._c_src    = null;
        obj._c_warpOk = false;
    });

    // Always defer the full pipeline rebuild until mouse:up.
    //
    // Previously the no-warp path called applyWarpToData() inline (per stroke
    // point) so that blur/noise would show during the stroke.  That caused a
    // subtle cursor-displacement bug: applyWarpToData → _applyWarpToOneObject
    // → trimTransparentBorders repositions the Fabric object mid-stroke, which
    // changes obj.calcTransformMatrix().  The next mouse:move then computes the
    // object-local erase point from the shifted matrix, so subsequent erase
    // marks land at a different canvas-space location than the visible preview
    // circle, making the eraser appear offset.
    //
    // Deferring via _erasePendingRebuild (same path as the warp case) keeps the
    // Fabric object's position stable for the entire stroke so getPointer() →
    // calcTransformMatrix() stays consistent with the cursor circle.
    // Blur/noise are applied correctly on mouse:up when the rebuild runs.
    data._erasePendingRebuild = true;
    data.fabricCanvas.requestRenderAll();
}

// Mirror the current eraser stroke from `primaryData`'s canvas space to every
// other currently-selected window at the same proportional position.
// Called immediately after applyDesignEraserAt for the primary canvas so that
// all selected windows are erased simultaneously in one gesture.
function _applyEraserSync(primaryData, pointer) {
    const W = primaryData.fabricCanvas.width;
    const H = primaryData.fabricCanvas.height;
    activeIndices.forEach(i => {
        const d = canvasData[i];
        if (!d || d === primaryData || d.locked) return;
        if (!d.designObject && !(d.extraDesignObjects && d.extraDesignObjects.length)) return;
        // Scale pointer proportionally to the target canvas dimensions
        const syncPointer = {
            x: pointer.x / W * d.fabricCanvas.width,
            y: pointer.y / H * d.fabricCanvas.height,
        };
        applyDesignEraserAt(d, syncPointer);
    });
}

function updateEraserCursor(e) {
    if (typeof designEraserMode === 'undefined' || !designEraserMode) return;
    const cursor = document.getElementById('designEraserCursor');
    const inner  = document.getElementById('designEraserInner');
    if (!cursor) return;
    const d = designEraserSize * 2;
    cursor.style.left   = e.clientX + 'px';
    cursor.style.top    = e.clientY + 'px';
    cursor.style.width  = d + 'px';
    cursor.style.height = d + 'px';
    // Inner dashed ring marks where the hard core ends and soft falloff begins
    const hardFrac = 1 - designEraserSoftness / 100;
    const innerD   = d * hardFrac;
    const inset    = (d - innerD) / 2;
    inner.style.width  = innerD + 'px';
    inner.style.height = innerD + 'px';
    inner.style.left   = inset + 'px';
    inner.style.top    = inset + 'px';
    inner.style.display = (designEraserSoftness > 2 && designEraserSoftness < 98) ? 'block' : 'none';
}
document.addEventListener('mousemove', updateEraserCursor);

function enterDesignEraserMode() {
    designEraserMode = true;
    // Snapshot which designs are selected so the eraser only touches those layers
    eraserTargetObjects = new Set(selectedDesigns);
    document.getElementById('designEraserBtn').textContent = 'Exit Eraser Mode';
    document.getElementById('designEraserControls').style.display = 'inline-flex';
    // Disable object selection on every canvas so mouse events reach the eraser handler
    canvasData.forEach(d => {
        d.fabricCanvas.selection = false;
        d.fabricCanvas.forEachObject(o => {
            o._prevSelectable     = o.selectable;
            o._prevEvented        = o.evented;
            o.selectable          = false;
            o.evented             = false;
            o.lockMovementX       = true;
            o.lockMovementY       = true;
            o.lockRotation        = true;
            o.lockScalingX        = true;
            o.lockScalingY        = true;
            o.lockSkewingX        = true;
            o.lockSkewingY        = true;
        });
        d.fabricCanvas.discardActiveObject();
        d.fabricCanvas.requestRenderAll();
    });
    selectedDesigns.clear();
    refreshFabricHandles();
    updateWindowBorders();
    updateLayerButtons();
    // Hide system cursor on canvas wrappers; show ring cursor instead
    document.querySelectorAll('.canvas-wrapper').forEach(w => w.style.cursor = 'none');
    const cursor = document.getElementById('designEraserCursor');
    if (cursor) cursor.style.display = 'block';
}

function exitDesignEraserMode() {
    designEraserMode = false;
    designEraserDown = false;
    document.getElementById('designEraserBtn').textContent = 'Eraser';
    document.getElementById('designEraserControls').style.display = 'none';
    canvasData.forEach(d => {
        d.fabricCanvas.selection = true;
        d.fabricCanvas.forEachObject(o => {
            o.selectable    = (o._prevSelectable !== undefined) ? o._prevSelectable : true;
            o.evented       = (o._prevEvented    !== undefined) ? o._prevEvented    : true;
            o.lockMovementX = false;
            o.lockMovementY = false;
            o.lockRotation  = false;
            o.lockScalingX  = false;
            o.lockScalingY  = false;
            o.lockSkewingX  = false;
            o.lockSkewingY  = false;
            delete o._prevSelectable;
            delete o._prevEvented;
        });
        d.fabricCanvas.requestRenderAll();
    });
    document.querySelectorAll('.canvas-wrapper').forEach(w => w.style.cursor = '');
    const cursor = document.getElementById('designEraserCursor');
    if (cursor) cursor.style.display = 'none';
}

// Release eraser stroke if mouse is lifted anywhere in the window
window.addEventListener('mouseup', () => {
    if (!designEraserMode) return;
    designEraserDown = false;
    // Flush any pending pipeline rebuild (e.g. warp+erase) even if mouseup
    // happened outside a Fabric canvas (which wouldn't fire the per-canvas handler).
    canvasData.forEach(d => {
        if (d && d._erasePendingRebuild) {
            d._erasePendingRebuild = false;
            applyWarpToData(d, false);
        }
    });
});

