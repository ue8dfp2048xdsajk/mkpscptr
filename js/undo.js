'use strict';
// ── Undo / redo engine ────────────────────────────────────────────────────────

// Returns a drawable-source data URL for an extra-layer original, whether it is
// stored as an Image element (has .src), a canvas (toDataURL), or a restored
// { src } placeholder.  Returns null when no usable source exists.
function _originalToSrc(orig){
    if(!orig) return null;
    if(typeof orig.src === 'string' && orig.src) return orig.src;
    if(typeof orig.toDataURL === 'function'){
        try { return orig.toDataURL(); } catch(_e){ return null; }
    }
    return null;
}

function captureWindowState(data){
    // Read live transforms directly from the Fabric object so the snapshot is
    // accurate even when data.x/y/scaleX/scaleY/rotation haven't been flushed
    // back yet (they only sync inside updateFromSliders, not on drag/scale/rotate).
    const _obj = data.designObject;
    const _ps  = data.previewScale || 1;
    return {
        x: _obj ? _obj.left  : data.x,
        y: _obj ? _obj.top   : data.y,
        scale: data.scale,
        scaleX: _obj ? (_obj.scaleX / _ps) : (data.scaleX ?? data.scale),
        scaleY: _obj ? (_obj.scaleY / _ps) : (data.scaleY ?? data.scale),
        skewX: _obj ? (_obj.skewX || 0) : (data.skewX || 0),
        skewY: _obj ? (_obj.skewY || 0) : (data.skewY || 0),
        rotation: _obj ? _obj.angle : data.rotation,
        warpAmount:    data.warpAmount    ?? 0,
        arcAmount:     data.arcAmount     ?? 0,
        arcTilt:       data.arcTilt       ?? 0,
        perspectiveTop:  data.perspectiveTop  ?? 0,
        perspectiveLeft: data.perspectiveLeft ?? 0,
        opacity:    data.opacity    ?? 1,
        blurAmount: data.blurAmount ?? 0,
        noiseAmount: data.noiseAmount ?? 0,
        blendMode:  data.blendMode  ?? 'normal',
        maskEnabled: !!data.maskEnabled,
        maskType:  data.maskType ?? null,
        maskPath:  data.maskPath  ? JSON.parse(JSON.stringify(data.maskPath))  : null,
        maskPaths: JSON.parse(JSON.stringify(data.maskPaths || [])),
        colorLayerImageData: data.colorLayerCtx
            ? data.colorLayerCtx.getImageData(
                0, 0,
                data.colorLayerCanvas.width,
                data.colorLayerCanvas.height)
            : null,
        colorLayerOpacity:   data.colorLayerFabricObj?.opacity ?? 1,
        colorLayerBlendMode: data.colorLayerFabricObj?.globalCompositeOperation ?? 'source-over',
        filename: data.filename || '',
        notes:    data.notes    || '',
        bgAdjust: data.bgAdjust ? { ...data.bgAdjust } : { hue: 0, saturation: 0, brightness: 0, contrast: 0 },
        bgCrop:   data.bgCrop   ? { ...data.bgCrop   } : { x: 0, y: 0, scale: 1, rotation: 0, aspect: 0 },
        patternMode: !!data.patternMode,
        patternSettings: data.patternSettings ? { ...data.patternSettings } : null,
        locked:   !!data.locked,
        flipX:    !!data.flipX,
        flipY:    !!data.flipY,
        meshWarpApplied: !!data.meshWarpApplied,
        invertedMain: !!data.invertedMain,
        invertedExtras: [...(data.invertedExtras || [])],
        designOriginalSrc: data.meshWarpApplied
            ? _originalToSrc(data.designOriginal)
            : null,
        designFx: data.designObject?._fx
            ? JSON.parse(JSON.stringify(data.designObject._fx))
            : null,
        duplicates: (data.extraDesignObjects || []).map((obj, i) => ({
            left: obj.left, top: obj.top,
            scaleX: obj.scaleX, scaleY: obj.scaleY,
            skewX: obj.skewX || 0, skewY: obj.skewY || 0,
            angle: obj.angle,
            src:  _originalToSrc(data.extraDesignOriginals?.[i]),
            name: obj._uploadedDesignName ?? null,
            fx:   obj._fx ? JSON.parse(JSON.stringify(obj._fx)) : null
        }))
    };
}

async function restoreDuplicatesFromState(data, savedDups){
    const targetCount = savedDups.length;

    // Remove extra fabric objects
    while((data.extraDesignObjects || []).length > targetCount){
        const removed = data.extraDesignObjects.pop();
        data.extraDesignOriginals && data.extraDesignOriginals.pop();
        data.fabricCanvas.remove(removed);
    }

    // Update kept objects
    const keepCount = Math.min(targetCount, (data.extraDesignObjects || []).length);
    for(let i = 0; i < keepCount; i++){
        const obj = data.extraDesignObjects[i];
        const s   = savedDups[i];
        obj.set({ left: s.left, top: s.top,
                  scaleX: s.scaleX, scaleY: s.scaleY,
                  skewX: s.skewX || 0, skewY: s.skewY || 0,
                  angle: s.angle });
        if(s.fx) obj._fx = JSON.parse(JSON.stringify(s.fx));
        obj.setCoords();
        _applyExtraLayerHandleStyle(obj, s.src ? 'overlay' : 'clone');
    }

    // Re-create missing objects
    for(let i = (data.extraDesignObjects || []).length; i < targetCount; i++){
        const s = savedDups[i];
        await new Promise(resolve => {
            const build = (imgEl) => {
                const fImg = new fabric.Image(imgEl, {
                    left: s.left, top: s.top,
                    scaleX: s.scaleX, scaleY: s.scaleY,
                    skewX: s.skewX || 0, skewY: s.skewY || 0,
                    angle: s.angle,
                    originX: 'center', originY: 'center',
                    selectable: true, evented: true
                });
                fImg._fx = s.fx ? JSON.parse(JSON.stringify(s.fx)) : _defaultFx(data);
                if(s.name) fImg._uploadedDesignName = s.name;

                data.extraDesignObjects  = data.extraDesignObjects  || [];
                data.extraDesignOriginals = data.extraDesignOriginals || [];
                data.extraDesignObjects.push(fImg);
                // Store the actual drawable element (Image / canvas) so the warp
                // pipeline can use it directly.  Storing a plain { src } object
                // here would break ctx.drawImage during any later render.
                data.extraDesignOriginals.push(imgEl || null);

                _applyExtraLayerHandleStyle(fImg, s.src ? 'overlay' : 'clone');

                data.fabricCanvas.add(fImg);
                attachFabricEvents(data, fImg);
                applyClipMaskToObject(fImg, data);
                resolve();
            };
            if(s.src){
                const img = new Image();
                img.onload  = () => build(img);
                img.onerror = () => build(data.designOriginal);
                img.src = s.src;
            } else if(data.designOriginal){
                build(data.designOriginal);
            } else {
                resolve();
            }
        });
    }
}

// Snapshot of the reset target for one window — same shape as captureWindowState().
function captureWindowBaseline(data) {
    const scale = data.initialScale ?? data.scale ?? 1;
    return {
        x: data.initialX ?? data.x,
        y: data.initialY ?? data.y,
        scale,
        scaleX: scale,
        scaleY: scale,
        skewX: 0,
        skewY: 0,
        rotation: data.initialRotation ?? 0,
        warpAmount: data.initialWarpAmount ?? 0,
        arcAmount: data.initialArcAmount ?? 0,
        arcTilt: data.initialArcTilt ?? 0,
        perspectiveTop: data.initialPerspectiveTop ?? 0,
        perspectiveLeft: data.initialPerspectiveLeft ?? 0,
        opacity: data.initialOpacity ?? 1,
        blurAmount: data.initialBlurAmount ?? 0,
        noiseAmount: data.initialNoiseAmount ?? 0,
        blendMode: data.initialBlendMode ?? 'normal',
        maskEnabled: false,
        maskType: null,
        maskPath: null,
        maskPaths: [],
        colorLayerImageData: null,
        colorLayerOpacity: 1,
        colorLayerBlendMode: 'source-over',
        filename: data.filename || '',
        notes: data.notes || '',
        bgAdjust: { hue: 0, saturation: 0, brightness: 0, contrast: 0 },
        bgCrop: { x: 0, y: 0, scale: 1, rotation: 0, aspect: 0 },
        patternMode: false,
        patternSettings: _defaultPattern(),
        locked: !!data.locked,
        flipX: false,
        flipY: false,
        designFx: {
            warpAmount: data.initialWarpAmount ?? 0,
            arcAmount: data.initialArcAmount ?? 0,
            arcTilt: data.initialArcTilt ?? 0,
            perspectiveTop: data.initialPerspectiveTop ?? 0,
            perspectiveLeft: data.initialPerspectiveLeft ?? 0,
            opacity: data.initialOpacity ?? 1,
            blurAmount: data.initialBlurAmount ?? 0,
            noiseAmount: data.initialNoiseAmount ?? 0,
            blendMode: data.initialBlendMode ?? 'normal',
        },
        duplicates: [],
    };
}

// Restore one window to its upload baseline via the same path as undo/redo.
async function resetWindowToBaseline(data) {
    if (!data || data.locked) return;

    data.meshWarpApplied = false;
    data.invertedMain = false;
    data.invertedExtras = [];

    if (data.initialDesignOriginal) {
        data.designOriginal = data.initialDesignOriginal;
    }

    if (data.patternMode || data.patternFabricObj) {
        _togglePatternMode(data, false);
    }

    if (data.extraDesignObjects?.length) {
        data.extraDesignObjects.forEach(obj => {
            selectedDesigns.delete(obj);
            data.fabricCanvas.remove(obj);
        });
        data.extraDesignObjects = [];
        data.extraDesignOriginals = [];
    }

    if (data.designObject) {
        data.fabricCanvas.remove(data.designObject);
        selectedDesigns.delete(data.designObject);
        data.designObject = null;
    }

    data._flipMap = null;

    await restoreWindowState(data, captureWindowBaseline(data));

    data.clipCurvePoints = [];
    data.clipPolygonClosed = false;

    if (data.designObject && !data.locked) {
        if (!data.designObject._fx) data.designObject._fx = _defaultFx(data);
        selectedDesigns.add(data.designObject);
    }
}

async function restoreWindowState(data, state){
    if (state.meshWarpApplied !== undefined) data.meshWarpApplied = !!state.meshWarpApplied;
    if (state.invertedMain !== undefined) data.invertedMain = !!state.invertedMain;
    if (state.invertedExtras) data.invertedExtras = [...state.invertedExtras];

    if (state.designOriginalSrc) {
        await new Promise(resolve => {
            const img = new Image();
            img.onload = () => { data.designOriginal = img; resolve(); };
            img.onerror = () => resolve();
            img.src = state.designOriginalSrc;
        });
    }

    data.x = state.x;   data.y = state.y;
    data.scale  = state.scale;
    data.scaleX = state.scaleX;  data.scaleY = state.scaleY;
    data.skewX  = state.skewX  ?? 0;
    data.skewY  = state.skewY  ?? 0;
    data.rotation    = state.rotation;
    data.warpAmount  = state.warpAmount  ?? 0;
    data.arcAmount   = state.arcAmount   ?? 0;
    data.arcTilt     = state.arcTilt     ?? 0;
    data.perspectiveTop  = state.perspectiveTop  ?? 0;
    data.perspectiveLeft = state.perspectiveLeft ?? 0;
    data.opacity    = state.opacity    ?? 1;
    data.blurAmount = state.blurAmount ?? 0;
    data.noiseAmount = state.noiseAmount ?? 0;
    data.blendMode  = state.blendMode  ?? 'normal';
    data.bgAdjust   = state.bgAdjust   ? { ...state.bgAdjust } : { hue: 0, saturation: 0, brightness: 0, contrast: 0 };
    data.bgCrop     = state.bgCrop     ? { ...state.bgCrop   } : { x: 0, y: 0, scale: 1, rotation: 0, aspect: 0 };
    _applyBgAdjust(data);
    _updateCropOverlay(data);

    // Pattern mode restore (undo/redo)
    if(data.patternMode || data.patternFabricObj) _togglePatternMode(data, false);
    data.patternMode = !!state.patternMode;
    data.patternSettings = state.patternSettings ? { ...state.patternSettings } : _defaultPattern();
    if(data.patternMode) _togglePatternMode(data, true);

    if(data.designObject){
        data.designObject._fx = state.designFx
            ? JSON.parse(JSON.stringify(state.designFx)) : null;
        data.designObject.set({
            left:  state.x,  top: state.y,
            angle: state.rotation,
            scaleX: (state.scaleX ?? state.scale) * data.previewScale,
            scaleY: (state.scaleY ?? state.scale) * data.previewScale,
            skewX: state.skewX ?? 0,
            skewY: state.skewY ?? 0,
            opacity: state.opacity ?? 1,
            globalCompositeOperation: _blendToGCO(state.blendMode)
        });
    }

    await applyWarpToData(data, false);

    data.maskEnabled = state.maskEnabled;
    data.maskType    = state.maskType;
    data.maskPath    = state.maskPath  ? JSON.parse(JSON.stringify(state.maskPath))  : null;
    data.maskPaths   = JSON.parse(JSON.stringify(state.maskPaths || []));
    getAllDesignObjects(data).forEach(obj => applyClipMaskToObject(obj, data));
    addClipOverlay(data);
    if(data.patternMode) _renderPattern(data, false);

    if(state.colorLayerImageData){
        initColorLayer(data);
        data.colorLayerCtx.clearRect(
            0, 0, data.colorLayerCanvas.width, data.colorLayerCanvas.height);
        data.colorLayerCtx.putImageData(state.colorLayerImageData, 0, 0);
        if(data.colorLayerFabricObj){
            data.colorLayerFabricObj.set({
                opacity: state.colorLayerOpacity ?? 1,
                globalCompositeOperation: state.colorLayerBlendMode ?? 'source-over'
            });
        }
    } else if(data.colorLayerFabricObj){
        data.fabricCanvas.remove(data.colorLayerFabricObj);
        data.colorLayerFabricObj = null;
        data.colorLayerCanvas    = null;
        data.colorLayerCtx       = null;
        data.colorLayerHistory   = [];
    }

    await restoreDuplicatesFromState(data, state.duplicates || []);

    // Restore filename
    if(state.filename !== undefined){
        data.filename = state.filename;
        const inp = data.wrapperEl?.querySelector('.filename-input');
        if(inp) inp.value = state.filename;
    }

    // Restore notes
    if(state.notes !== undefined) data.notes = state.notes;

    // Restore flip — invalidate the flip cache so the pipeline re-flips correctly
    if(state.flipX !== undefined) data.flipX = state.flipX;
    if(state.flipY !== undefined) data.flipY = state.flipY;
    if(state.flipX !== undefined || state.flipY !== undefined) data._flipMap = null;

    // Restore locked state (apply or remove lock without clobbering Fabric events)
    if(state.locked !== undefined){
        const shouldLock = !!state.locked;
        if(shouldLock !== !!data.locked){
            data.locked = shouldLock;
            getAllDesignObjects(data).forEach(o => {
                if(!o) return;
                if(shouldLock){
                    o._lockSelectable = o.selectable;
                    o._lockEvented    = o.evented;
                    o.selectable      = false;
                    o.evented         = false;
                } else {
                    o.selectable = (o._lockSelectable !== undefined) ? o._lockSelectable : true;
                    o.evented    = (o._lockEvented    !== undefined) ? o._lockEvented    : true;
                    delete o._lockSelectable;
                    delete o._lockEvented;
                }
            });
            if(data.wrapperEl){
                data.wrapperEl.classList.toggle('window-locked', shouldLock);
            }
        }
    }

    // Sync filename input disabled state with lock
    const filenameInp = data.wrapperEl?.querySelector('.filename-input');
    if(filenameInp) filenameInp.disabled = !!data.locked;

    // Recompute PRO badge so it reflects the restored state
    _recomputeProEffect(data);

    data.fabricCanvas.discardActiveObject();
    data.fabricCanvas.requestRenderAll();
}

// extraIdx: optional index to always include (e.g. filename/notes edit on a
// window that may not be in activeIndices)
function pushGlobalUndo(extraIdx = null){
    if(!canvasData.length) return;
    const affected = [...activeIndices];
    if(extraIdx !== null && !affected.includes(extraIdx) &&
       extraIdx >= 0 && extraIdx < canvasData.length){
        affected.push(extraIdx);
    }
    if(!affected.length) return;
    globalUndoStack.push({
        affected,
        states: affected.map(i => captureWindowState(canvasData[i]))
    });
    if(globalUndoStack.length > MAX_UNDO_HISTORY) globalUndoStack.shift();
    globalRedoStack = [];
    updateUndoRedoButtons();
    _markDirty();
}

// ── Layout undo/redo (cols, row gap, col gap) ─────────────────────────────────
function captureLayoutState() {
    return { cols: _numColumns, rowGap: _rowGap, colGap: _colGap };
}

function pushLayoutUndo() {
    globalUndoStack.push({ type: 'layout', state: captureLayoutState() });
    if (globalUndoStack.length > MAX_UNDO_HISTORY) globalUndoStack.shift();
    globalRedoStack = [];
    updateUndoRedoButtons();
}

async function applyLayoutState(state) {
    const prevCols = _numColumns;
    _numColumns = state.cols;
    _rowGap     = state.rowGap;
    _colGap     = state.colGap;

    const colsInput = document.getElementById('numColsInput');
    const rowInput  = document.getElementById('rowGapInput');
    const colInput  = document.getElementById('colGapInput');
    if (colsInput) colsInput.value = _numColumns;
    if (rowInput)  rowInput.value  = _rowGap;
    if (colInput)  colInput.value  = _colGap;

    const container = document.getElementById('canvasContainer');
    container.style.gridTemplateColumns = `repeat(${_numColumns}, max-content)`;
    container.style.width = 'max-content';
    container.style.rowGap    = _rowGap + 'px';
    container.style.columnGap = _colGap + 'px';

    if (state.cols !== prevCols && canvasData.length) {
        const snapshot = buildSnapshot();
        await createCanvasPreviewsFromSnapshot(snapshot);
        syncSliders();
        updateWindowBorders();
    }
    updateUndoRedoButtons();
}

function _applySelectionState(indices) {
    activeIndices = [...indices];
    lastSelectedIndex = activeIndices[activeIndices.length - 1] ?? null;
    selectedDesigns.clear();
    activeIndices.forEach(i => {
        const d = canvasData[i];
        if (d?.designObject && !d.locked) selectedDesigns.add(d.designObject);
    });
    refreshFabricHandles();
    updateWindowBorders();
    updateLayerButtons();
    syncSliders();
    updateSelectButtonState();
}

// Re-inserts previously-deleted windows back into canvasData and the DOM.
// `saved` is [{originalIdx, data}] sorted ascending by originalIdx.
function _restoreDeletedWindows(saved){
    const container = document.getElementById('canvasContainer');
    for(const { originalIdx, data } of saved){
        // Splice back into canvasData at the original position; because we
        // process in ascending index order each splice shifts later entries
        // right exactly as needed.
        canvasData.splice(originalIdx, 0, data);

        // Re-insert the cell (grid item) at the correct position.
        // container.children are .window-cell elements, so the index aligns correctly.
        const refChild = container.children[originalIdx] || null;
        const domEl = data.cellEl || data.wrapperEl;
        container.insertBefore(domEl, refChild);

        // Re-start visibility tracking.
        _visibilityObserver.observe(data.wrapperEl);
    }

    // Restore selection to the re-inserted windows.
    activeIndices = saved.map(s => s.originalIdx);
    lastSelectedIndex = activeIndices[activeIndices.length - 1] ?? null;
    selectedDesigns.clear();
    activeIndices.forEach(i => {
        const d = canvasData[i];
        if(d?.designObject && !d.locked) selectedDesigns.add(d.designObject);
    });

    refreshFabricHandles();
    updateWindowBorders();
    updateLayerButtons();
    syncSliders();
    updateSelectButtonState();
    updateDropUI();
}

// Re-removes windows that were restored by a deletion-undo, without disposing
// Fabric (so a subsequent undo can restore them again).
function _reDeleteWindows(saved){
    const toDelete = new Set(saved.map(s => s.originalIdx));
    saved.forEach(({ data }) => {
        if(data.wrapperEl){
            _visibilityObserver.unobserve(data.wrapperEl);
            _visibleWrappers.delete(data.wrapperEl);
        }
        const domEl = data.cellEl || data.wrapperEl;
        if(domEl && domEl.parentNode) domEl.parentNode.removeChild(domEl);
    });
    canvasData = canvasData.filter((_, i) => !toDelete.has(i));
    activeIndices = [];
    lastSelectedIndex = null;
    selectedDesigns.clear();
    refreshFabricHandles();
    updateWindowBorders();
    updateLayerButtons();
    syncSliders();
    updateSelectButtonState();
    updateDropUI();
}

async function performGlobalUndo(){
    if(!globalUndoStack.length) return;
    const entry = globalUndoStack.pop();

    if(entry.type === 'deletion'){
        // Push a matching redo entry so Ctrl+Y can re-delete.
        globalRedoStack.push({ type: 'deletion', saved: entry.saved });
        updateUndoRedoButtons();
        _restoreDeletedWindows(entry.saved);
        return;
    }

    if(entry.type === 'layout'){
        globalRedoStack.push({ type: 'layout', state: captureLayoutState() });
        await applyLayoutState(entry.state);
        return;
    }

    if(entry.type === 'selection'){
        globalRedoStack.push({ type: 'selection', prevActiveIndices: [...activeIndices] });
        _applySelectionState(entry.prevActiveIndices);
        updateUndoRedoButtons();
        return;
    }

    if(entry.type === 'pan'){
        globalRedoStack.push({ type: 'pan', prevX: _vpX, prevY: _vpY, prevScale: _vpScale });
        _vpX = entry.prevX; _vpY = entry.prevY;
        if(entry.prevScale !== undefined) _vpScale = entry.prevScale;
        _applyVP();
        updateUndoRedoButtons();
        return;
    }

    if(entry.type === 'textboxes'){
        globalRedoStack.push({ type: 'textboxes', state: captureTextBoxState() });
        if(window._applyTextBoxState) window._applyTextBoxState(entry.state);
        updateUndoRedoButtons();
        return;
    }

    if(entry.type === 'reorder'){
        globalRedoStack.push({ type: 'reorder', order: [...canvasData] });
        const selDatas = activeIndices.map(i => canvasData[i]).filter(Boolean);
        const lastSel  = lastSelectedIndex !== null ? canvasData[lastSelectedIndex] : null;
        const cont = document.getElementById('canvasContainer');
        entry.order.forEach(d => { if(d.wrapperEl) cont.appendChild(d.wrapperEl); });
        canvasData = [...entry.order];
        activeIndices     = selDatas.map(d => canvasData.indexOf(d)).filter(i => i !== -1);
        lastSelectedIndex = lastSel ? canvasData.indexOf(lastSel) : null;
        updateWindowBorders();
        updateUndoRedoButtons();
        return;
    }

    if(entry.type === 'eraser'){
        // Capture current (post-erase) pixel data so redo can re-apply it.
        const redoEntry = {
            type: 'eraser',
            items: entry.items
                .filter(item => item.idx < canvasData.length)
                .map(item => ({
                    idx:  item.idx,
                    snap: _captureEraserSnapshot(canvasData[item.idx])
                }))
        };
        globalRedoStack.push(redoEntry);
        updateUndoRedoButtons();
        for(const item of entry.items){
            if(item.idx >= canvasData.length) continue;
            const d = canvasData[item.idx];
            _applyEraserSnapshot(d, item.snap);
            await applyWarpToData(d, false);
        }
        syncSliders();
        updateUndoRedoButtons();
        return;
    }

    if(entry.type === 'warp'){
        // Save current (post-warp) state+original so redo can re-apply it.
        const redoEntry = {
            type: 'warp',
            items: entry.items
                .filter(item => item.idx < canvasData.length)
                .map(item => ({
                    idx:      item.idx,
                    state:    captureWindowState(canvasData[item.idx]),
                    original: canvasData[item.idx].designOriginal,
                    baked:    !!canvasData[item.idx].meshWarpApplied,
                    wasMain:  item.wasMain,
                    warpedExtraIdx: item.warpedExtraIdx ?? -1,
                })),
        };
        globalRedoStack.push(redoEntry);
        updateUndoRedoButtons();
        for(const item of entry.items){
            if(item.idx >= canvasData.length) continue;
            const d = canvasData[item.idx];
            d.meshWarpApplied = false;
            d.designOriginal = item.original;
            await restoreWindowState(d, item.state);
        }
        syncSliders();
        updateUndoRedoButtons();
        return;
    }

    globalRedoStack.push({
        affected: entry.affected,
        states: entry.affected
            .filter(i => i < canvasData.length)
            .map(i => captureWindowState(canvasData[i]))
    });
    for(let i = 0; i < entry.affected.length; i++){
        const idx = entry.affected[i];
        if(idx < canvasData.length){
            await restoreWindowState(canvasData[idx], entry.states[i]);
        }
    }
    syncSliders();
    updateUndoRedoButtons();
}

async function performGlobalRedo(){
    if(!globalRedoStack.length) return;
    const entry = globalRedoStack.pop();

    if(entry.type === 'deletion'){
        // Push a matching undo entry so Ctrl+Z can restore again.
        globalUndoStack.push({ type: 'deletion', saved: entry.saved });
        updateUndoRedoButtons();
        _reDeleteWindows(entry.saved);
        return;
    }

    if(entry.type === 'layout'){
        globalUndoStack.push({ type: 'layout', state: captureLayoutState() });
        await applyLayoutState(entry.state);
        return;
    }

    if(entry.type === 'selection'){
        globalUndoStack.push({ type: 'selection', prevActiveIndices: [...activeIndices] });
        _applySelectionState(entry.prevActiveIndices);
        updateUndoRedoButtons();
        return;
    }

    if(entry.type === 'pan'){
        globalUndoStack.push({ type: 'pan', prevX: _vpX, prevY: _vpY, prevScale: _vpScale });
        _vpX = entry.prevX; _vpY = entry.prevY;
        if(entry.prevScale !== undefined) _vpScale = entry.prevScale;
        _applyVP();
        updateUndoRedoButtons();
        return;
    }

    if(entry.type === 'textboxes'){
        globalUndoStack.push({ type: 'textboxes', state: captureTextBoxState() });
        if(window._applyTextBoxState) window._applyTextBoxState(entry.state);
        updateUndoRedoButtons();
        return;
    }

    if(entry.type === 'reorder'){
        globalUndoStack.push({ type: 'reorder', order: [...canvasData] });
        const selDatas = activeIndices.map(i => canvasData[i]).filter(Boolean);
        const lastSel  = lastSelectedIndex !== null ? canvasData[lastSelectedIndex] : null;
        const cont = document.getElementById('canvasContainer');
        entry.order.forEach(d => { if(d.wrapperEl) cont.appendChild(d.wrapperEl); });
        canvasData = [...entry.order];
        activeIndices     = selDatas.map(d => canvasData.indexOf(d)).filter(i => i !== -1);
        lastSelectedIndex = lastSel ? canvasData.indexOf(lastSel) : null;
        updateWindowBorders();
        updateUndoRedoButtons();
        return;
    }

    if(entry.type === 'eraser'){
        // Capture current (pre-restore) pixel data so undo can revert it again.
        const undoEntry = {
            type: 'eraser',
            items: entry.items
                .filter(item => item.idx < canvasData.length)
                .map(item => ({
                    idx:  item.idx,
                    snap: _captureEraserSnapshot(canvasData[item.idx])
                }))
        };
        globalUndoStack.push(undoEntry);
        updateUndoRedoButtons();
        for(const item of entry.items){
            if(item.idx >= canvasData.length) continue;
            const d = canvasData[item.idx];
            _applyEraserSnapshot(d, item.snap);
            await applyWarpToData(d, false);
        }
        syncSliders();
        updateUndoRedoButtons();
        return;
    }

    if(entry.type === 'warp'){
        // Save current (pre-warp) state+original so undo can revert it again.
        const undoEntry = {
            type: 'warp',
            items: entry.items
                .filter(item => item.idx < canvasData.length)
                .map(item => ({
                    idx:      item.idx,
                    state:    captureWindowState(canvasData[item.idx]),
                    original: canvasData[item.idx].designOriginal,
                    baked:    !!canvasData[item.idx].meshWarpApplied,
                    wasMain:  item.wasMain,
                    warpedExtraIdx: item.warpedExtraIdx ?? -1,
                })),
        };
        globalUndoStack.push(undoEntry);
        updateUndoRedoButtons();
        for(const item of entry.items){
            if(item.idx >= canvasData.length) continue;
            const d = canvasData[item.idx];
            d.designOriginal = item.original;
            if (item.baked) {
                _restoreBakedMeshWarpItem(d, item);
            } else {
                await restoreWindowState(d, item.state);
            }
        }
        syncSliders();
        updateUndoRedoButtons();
        return;
    }

    globalUndoStack.push({
        affected: entry.affected,
        states: entry.affected
            .filter(i => i < canvasData.length)
            .map(i => captureWindowState(canvasData[i]))
    });
    for(let i = 0; i < entry.affected.length; i++){
        const idx = entry.affected[i];
        if(idx < canvasData.length){
            await restoreWindowState(canvasData[idx], entry.states[i]);
        }
    }
    syncSliders();
    updateUndoRedoButtons();
}

function updateUndoRedoButtons(){
    const u = document.getElementById('undoBtn');
    const r = document.getElementById('redoBtn');
    if(u) u.disabled = !globalUndoStack.length;
    if(r) r.disabled = !globalRedoStack.length;
}

