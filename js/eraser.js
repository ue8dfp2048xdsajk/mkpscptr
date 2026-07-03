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

// Returns a (cached) flipped version of src for explicit flip flags.
// cacheHolder is per-window (main) or per-object (extras) so clone layers
// sharing the same source can cache independently.
function _cachedFlipFromFlags(flipFlags, cacheHolder, src) {
    const flipX = !!flipFlags.flipX;
    const flipY = !!flipFlags.flipY;
    if(!flipX && !flipY) return src;
    if(!cacheHolder._flipMap) cacheHolder._flipMap = new WeakMap();
    const hit = cacheHolder._flipMap.get(src);
    if(hit && hit.fX === flipX && hit.fY === flipY) return hit.canvas;
    const canvas = _flipImageSource(src, flipX, flipY);
    cacheHolder._flipMap.set(src, { fX: flipX, fY: flipY, canvas });
    return canvas;
}

// Window-level flip (main design) — backward-compatible entry point.
function _cachedFlip(data, src) {
    return _cachedFlipFromFlags(data, data, src);
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
        : (data.extraDesignOriginals?.[extraIdx] ?? null);
    if (!src && !isMain) {
        const el = obj.getElement() || obj._originalElement;
        if (!el) return null;
        const c = document.createElement('canvas');
        c.width  = el.naturalWidth  || el.width  || obj.width;
        c.height = el.naturalHeight || el.height || obj.height;
        c.getContext('2d').drawImage(el, 0, 0, c.width, c.height);
        if (!data.extraDesignOriginals) data.extraDesignOriginals = [];
        data.extraDesignOriginals[extraIdx] = c;
        return c;
    }
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

// Pipeline source for one design object (no display-element fallback for extras).
function _eraserPipelineSource(data, obj) {
    const isMain   = obj === data.designObject;
    const extraIdx = isMain ? -1 : (data.extraDesignObjects || []).indexOf(obj);
    if (!isMain && extraIdx < 0) return null;
    return isMain
        ? data.designOriginal
        : (data.extraDesignOriginals?.[extraIdx] ?? null);
}

// CSS-pixel eraser radius → Fabric logical canvas units.
function _eraserFabricRadius(data) {
    const cvEl        = data.fabricCanvas.upperCanvasEl;
    const rect        = cvEl.getBoundingClientRect();
    const cssToFabric = (rect.width > 0) ? (data.fabricCanvas.width / rect.width) : 1;
    return designEraserSize * cssToFabric;
}

// Map a Fabric canvas-space pointer to source-image pixel coordinates + brush radius.
function _pointerToSourcePixel(obj, data, pointer) {
    const fabricRadius = _eraserFabricRadius(data);
    const inv          = fabric.util.invertTransform(obj.calcTransformMatrix());
    const local        = fabric.util.transformPoint(pointer, inv);
    const srcEl        = _ensureErasableOriginal(data, obj);
    if (!srcEl) return null;

    const objW   = obj.width  || srcEl.width;
    const objH   = obj.height || srcEl.height;
    const srcSX  = srcEl.width  / objW;
    const srcSY  = srcEl.height / objH;
    const px     = (local.x + objW / 2) * srcSX;
    const py     = (local.y + objH / 2) * srcSY;
    const scl    = Math.min(obj.scaleX || 1, obj.scaleY || 1);
    const radius = Math.max(0.5, fabricRadius / scl * Math.min(srcSX, srcSY));
    return { srcEl, px, py, radius };
}

// Draw a soft erase circle onto a canvas context.
function _drawEraseOnContext(ctx, px, py, radius) {
    const softFrac = designEraserSoftness / 100;
    const innerR   = Math.max(0, radius * (1 - softFrac) - 0.5);
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

// Invalidate pipeline caches after an in-place source erase.
function _invalidateEraserPipelineCaches(data, obj) {
    data._dsSrc     = null;
    data._hqCanvas  = null;
    data._flipMap   = null;
    if (obj) obj._flipMap = null;
    data._tileEpoch = (data._tileEpoch || 0) + 1;
    obj._c_src      = null;
    obj._c_warpOk   = false;
}

// Rebuild display from erased source for one target layer only.
function _rebuildEraserTarget(data, obj, lowQuality) {
    const src = _eraserPipelineSource(data, obj);
    if (!src) return;
    _applyWarpToOneObject(obj, data, _cachedFlipForLayer(data, src, obj), lowQuality, { skipTrimComp: true });
    data.fabricCanvas.requestRenderAll();
}

function _previewEraserTarget(data, obj) {
    _rebuildEraserTarget(data, obj, true);
}

// Erase a soft circle from obj at a Fabric canvas-space point (source pixels only).
function eraseFromObject(obj, data, pointer) {
    const hit = _pointerToSourcePixel(obj, data, pointer);
    if (!hit) return;
    _drawEraseOnContext(hit.srcEl.getContext('2d'), hit.px, hit.py, hit.radius);
}

// Apply the eraser at a canvas-space point to the single locked target layer.
function applyDesignEraserAt(data, pointer) {
    const obj = eraserTargetObject;
    if (!obj || obj._ownerData !== data) return;

    eraseFromObject(obj, data, pointer);
    _invalidateEraserPipelineCaches(data, obj);
    _previewEraserTarget(data, obj);
    data._erasePendingRebuild = true;
}

function _flushEraserPendingRebuild() {
    const obj  = eraserTargetObject;
    const data = obj?._ownerData;
    if (data && data._erasePendingRebuild) {
        data._erasePendingRebuild = false;
        _rebuildEraserTarget(data, obj, false);
        if (obj) _markObjectBakedPro(obj);
    }
    canvasData.forEach(d => { if (d) d._erasePendingRebuild = false; });
}

function _canEnterDesignEraserMode() {
    if (selectedDesigns.size !== 1) {
        return { ok: false, message: 'Select exactly one design layer, then enter eraser mode.' };
    }
    const obj  = [...selectedDesigns][0];
    const data = obj?._ownerData;
    if (!data || data.locked) {
        return { ok: false, message: 'Cannot erase on a locked window.' };
    }
    if (!data.designObject && !(data.extraDesignObjects && data.extraDesignObjects.length)) {
        return { ok: false, message: 'No design layer to erase.' };
    }
    return { ok: true, target: obj };
}

function tryEnterDesignEraserMode() {
    const gate = _canEnterDesignEraserMode();
    if (!gate.ok) {
        alert(gate.message);
        return false;
    }
    enterDesignEraserMode();
    return true;
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
    const gate = _canEnterDesignEraserMode();
    if (!gate.ok) return;

    designEraserMode = true;
    eraserTargetObject = gate.target;
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
    _flushEraserPendingRebuild();

    const restoreTarget = eraserTargetObject;
    designEraserMode = false;
    designEraserDown = false;
    eraserTargetObject = null;
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
    if (restoreTarget) {
        selectedDesigns.clear();
        selectedDesigns.add(restoreTarget);
    }
    refreshFabricHandles();
    updateWindowBorders();
    updateLayerButtons();
    document.querySelectorAll('.canvas-wrapper').forEach(w => w.style.cursor = '');
    const cursor = document.getElementById('designEraserCursor');
    if (cursor) cursor.style.display = 'none';
}

// Release eraser stroke if mouse is lifted anywhere in the window
window.addEventListener('mouseup', () => {
    if (!designEraserMode) return;
    designEraserDown = false;
    _flushEraserPendingRebuild();
});

