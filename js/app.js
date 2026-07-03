var backgrounds = [];
var designs = [];
var canvasData = [];
var activeIndices = [];
var _numColumns = 4;
var _rowGap = 20;
var _colGap = 20;

// ── Visibility cache (IntersectionObserver) ───────────────────────────────────
// Tracks which canvas wrapper divs are currently scrolled into the viewport
// (+ 300 px buffer). Replaces per-frame getBoundingClientRect() calls with an
// O(1) Set.has() lookup so iterating hundreds of windows costs nothing.
var _visibleWrappers = new Set();
var _visibilityObserver = new IntersectionObserver(entries => {
    entries.forEach(e => {
        if(e.isIntersecting) _visibleWrappers.add(e.target);
        else                 _visibleWrappers.delete(e.target);
    });
}, { rootMargin: '300px 0px' });
var clipCopySelectMode = false;   // true while user is picking copy targets
var clipCopySourceIndex = null;   // which window the clipping will be copied FROM
var colorCopySelectMode  = false; // true while user is picking color-copy targets
var colorCopySourceIndex = null;  // which window the color layer will be copied FROM

// ── Color layer state ────────────────────────────────────────────────────────
// ── Global undo / redo ───────────────────────────────────────────────────────
var globalUndoStack = [];
var globalRedoStack = [];
var MAX_UNDO_HISTORY = 50;
var _sliderUndoLocked = false;   // one push per slider drag gesture

// ── Plan + Watermark System ───────────────────────────────────────────────────
// 'free' | 'starter' | 'pro'  — overwritten by clerk-auth.js on session refresh
var _userPlan = 'free';
// PRO detection, watermark drawing, star badges: js/pro-gating.js

// Refresh all star badges (called when _userPlan changes)
function _refreshAllProStarBadges() {
    canvasData.forEach(function(d) {
        _syncProEffect(d);
        if (d && d.fabricCanvas) d.fabricCanvas.requestRenderAll();
    });
    // Sidebar PRO labels: green for Pro users, yellow for everyone else
    var isPro = _userPlan === 'pro';
    document.querySelectorAll('.pro-badge').forEach(function(el) {
        el.classList.toggle('pro-badge--green', isPro);
    });
    // Hide the upgrade prompt bar immediately when the user has a paid plan
    if (_userPlan !== 'free') {
        var upgradePrompt = document.getElementById('upgradePrompt');
        if (upgradePrompt) upgradePrompt.style.display = 'none';
    }
    // Update Save as New button lock state
    _updateSaveNewBtn();
}

// Measure the sticky-header and keep #contextPanel's padding-top in sync so the
// panel is never covered by the header (whose height grows when the upgrade
// banner is visible).
function _syncContextPanelTop() {
    var header = document.querySelector('.sticky-header');
    var panel  = document.getElementById('contextPanel');
    if (!header || !panel) return;
    var h = header.getBoundingClientRect().height;
    // Position the panel to START below the header and fill the rest of the
    // viewport.  Using top+height (not padding-top) means the content area is
    // always the full remaining height — padding-top on a box-sizing:border-box
    // element with height:100vh eats into the scrollable area.
    panel.style.top    = h + 'px';
    panel.style.height = 'calc(100vh - ' + h + 'px)';
}

// Keep the panel top in sync whenever the sticky-header changes height
// (banner appears/dismisses, window resizes, text wraps, etc.).
// A ResizeObserver fires after layout — unlike requestAnimationFrame which
// can fire before the browser has reflowed the newly-visible banner.
(function _installHeaderResizeObserver() {
    var header = document.querySelector('.sticky-header');
    if (!header) return;
    if (typeof ResizeObserver === 'undefined') {
        // Fallback for very old browsers
        window.addEventListener('resize', _syncContextPanelTop);
        return;
    }
    new ResizeObserver(_syncContextPanelTop).observe(header);
}());

// Show the top upgrade prompt bar (once per session, dismissible)
function _showUpgradePromptIfNeeded() {
    if (_userPlan !== 'free') return;
    var el = document.getElementById('upgradePrompt');
    if (el) {
        el.style.display = 'flex';
        // ResizeObserver handles the panel-top update automatically;
        // no manual rAF needed here.
    }
}

var designEraserMode     = false;  // true while design-layer eraser is active
var designEraserDown     = false;  // true while mouse button held in eraser mode
var designEraserSize     = 30;     // eraser radius in CSS pixels (visual size on screen)
var designEraserSoftness = 0;      // 0 = hard edge, 100 = fully soft
var eraserTargetObject   = null;   // single design layer locked at eraser-entry time

var designWarpMode   = false;      // true while free-form mesh warp is active
var warpActiveData   = null;       // canvasData entry that owns the warp session
var warpTargetObjs   = [];         // fabric objects being warped
var warpPoints       = [];         // 4×4 array of {x,y} in Fabric canvas coordinates
var warpSourceCanvas = null;       // rasterised source image for the warp target(s)
var warpSourceBounds = null;       // {left,top,width,height} of source in Fabric coords
var warpDragRC       = null;       // {r,c} of control point being dragged, or null
var warpDPR          = 1;          // device pixel ratio at capture time
var warpAllGroups    = [];         // [{ownerData, targets, sourceCanvas, sourceBounds, dpr}] for every canvas involved

var colorLayerMode  = false;
var brushTool       = 'brush'; // 'brush' | 'eraser'
var brushColor      = '#ff0000';
var brushSize       = 20;
var brushSoftness   = 30;
var colorLayerOpacity    = 1;
var colorLayerBlendMode  = 'source-over';
var isColorPainting = false;
var lastPaintNorm   = null;   // last painted point in bg-image-pixel space
var selectedDesigns = new Set();  // design objects directly clicked (main or extra, any window)
var lastSelectedIndex = null;

var clipEditMode = false;
var clipLayersHidden = false;  // true while design layers are visually hidden in clip mode
var clipCurvePoints = [];
var activeCurvePreview = null;
var currentCurveHandle = null;
var isDraggingCurveHandle = false;

var activeBezierHelpers = [];

var clipPolygonClosed = false;
var currentMaskIndex = 0;

var activeClipWindowIndex = null;

var suppressNextWrapperClick = false;

// stores clipping masks per background type
var backgroundMaskTemplates = {};

function showClipModeNotice(){
    alert("Please exit clipping mode");
}

document.addEventListener('click', function(e){

    if(!clipEditMode){
        return;
    }

    // In copy-select mode we lift all restrictions so the user can click
    // other windows normally to build their selection.
    if(clipCopySelectMode){
        return;
    }

    const insideSelectedWindow =
        e.target.closest('.canvas-wrapper.active');

    // Before the user has clicked on any canvas (activeClipWindowIndex is null),
    // no window has been locked yet.  Allow clicks into ANY canvas-wrapper so the
    // first mouse:down can set the lock normally.
    const insideAnyWindow =
        activeClipWindowIndex === null &&
        e.target.closest('.canvas-wrapper');

    const exitButton =
        e.target.id === 'editClipBtn';

    const deleteClipButton =
        e.target.id === 'deleteClipBtn';

    const addClipAreaButton =
        e.target.id === 'addClipAreaBtn';

    const copyClipButton =
        e.target.id === 'copyClipBtn';

    const hideLayersButton =
        e.target.id === 'hideClipLayersBtn';

    if(
        insideSelectedWindow ||
        insideAnyWindow ||
        exitButton ||
        deleteClipButton ||
        addClipAreaButton ||
        copyClipButton ||
        hideLayersButton
    ){
        return;
    }

    e.preventDefault();
    e.stopPropagation();

    showClipModeNotice();

}, true);

// ── Filter-by-filename selection ──────────────────────────────────────────────
(function(){
    const input = document.getElementById('filterByNameInput');
    let timer = null;

    input.addEventListener('input', function(){
        clearTimeout(timer);
        timer = setTimeout(applyNameFilter, 200);
    });

    // Clear filter & selection on Escape
    input.addEventListener('keydown', function(e){
        if(e.key === 'Escape'){
            input.value = '';
            _deselectAll();
        }
    });

    function applyNameFilter(){
        const keyword = input.value.trim().toLowerCase();

        // Empty input → clear selection
        if(!keyword){ _deselectAll(); return; }

        activeIndices = [];
        selectedDesigns.clear();
        lastSelectedIndex = null;

        canvasData.forEach((d, i) => {
            if(!d) return;
            const name = (d.bgName || '').toLowerCase();
            if(name.includes(keyword)){
                activeIndices.push(i);
                if(d.designObject){
                    if(!d.designObject._fx) d.designObject._fx = _defaultFx(d);
                    if(!d.locked) selectedDesigns.add(d.designObject);
                }
            }
        });

        refreshFabricHandles();
        updateWindowBorders();
        updateLayerButtons();
        syncSliders();
        updateSelectButtonState();
    }
})();

// Shared deselect logic — called by both click handlers below
function _deselectAll(){
    if(!activeIndices.length && !selectedDesigns.size) return;
    activeIndices = [];
    selectedDesigns.clear();
    lastSelectedIndex = null;
    refreshFabricHandles();
    updateWindowBorders();
    updateLayerButtons();
    syncSliders();
    updateSelectButtonState();
}

// Track whether the most recent mousedown started on a form control (input,
// select, textarea, button).  When the user drags a number input so fast that
// the mouse leaves the browser window, the browser may synthesise a click on
// document — we must not deselect windows in that case.
var _mouseDownOnControl = false;
document.addEventListener('mousedown', e => {
    const tag = e.target.tagName;
    _mouseDownOnControl = (tag === 'INPUT' || tag === 'SELECT' ||
                           tag === 'TEXTAREA' || tag === 'BUTTON');
});

// Clicking empty space in the canvas container deselects everything
document.getElementById('canvasContainer').addEventListener('click', function(e){
    if(suppressNextWrapperClick) return;
    if(_mouseDownOnControl) return;   // drag started on a control — ignore
    if(clipEditMode || colorLayerMode || designEraserMode) return;
    // Only act when the click landed outside every canvas-wrapper
    if(e.target.closest('.canvas-wrapper')) return;
    _deselectAll();
});

// Clicking the white surrounding area (outside #canvasContainer) also deselects
document.addEventListener('click', function(e){
    if(suppressNextWrapperClick) return;
    if(_mouseDownOnControl) return;   // drag started on a control — ignore
    if(clipEditMode || colorLayerMode || designEraserMode) return;
    // Ignore clicks that are inside the canvas container (handled above)
    if(e.target.closest('#canvasContainer')) return;
    // Ignore clicks on the sticky toolbar (buttons, sliders, inputs, etc.)
    if(e.target.closest('.sticky-header')) return;
    // Ignore clicks inside the notes drawer/tab so editing notes doesn't deselect
    if(e.target.closest('#notesDrawer') || e.target.closest('#notesTab')) return;
    // Ignore clicks inside the context panel so adjusting controls doesn't deselect
    if(e.target.closest('#contextPanel')) return;
    // Ignore clicks on the minimap (panning shouldn't deselect windows)
    if(e.target.closest('#minimap')) return;
    _deselectAll();
});

document.addEventListener('mouseup', ()=>{
    // Clear after click has had a chance to fire (click fires synchronously
    // before setTimeout callbacks, so the flag is still true during click).
    setTimeout(()=>{
        suppressNextWrapperClick = false;
        _mouseDownOnControl = false;
    }, 0);
});



var warpAmount = document.getElementById("warpAmount");
var arcAmount = document.getElementById("arcAmount");
var arcTilt = document.getElementById("arcTilt");
var perspectiveTop = document.getElementById("perspectiveTop");
var perspectiveLeft = document.getElementById("perspectiveLeft");
var opacityAmount = document.getElementById("opacityAmount");
var blurAmount = document.getElementById("blurAmount");
var noiseAmount = document.getElementById("noiseAmount");
var blendMode = document.getElementById("blendMode");
var bgHue        = document.getElementById('bgHue');
var bgSaturation = document.getElementById('bgSaturation');
var bgBrightness = document.getElementById('bgBrightness');
var bgContrast   = document.getElementById('bgContrast');


// performance throttling
var warpFramePending = false;
var pendingWarpUpdate = false;
var globalHQTimer = null;
var activeSliderType = null;

// marching ants animation
var _marchingAntsTimer  = null;
var _marchingAntsOffset = 0;







// Layer handle colors: main = solid blue; clone = blue outline; overlay = orange.
function _extraLayerKind(data, index) {
    const obj = data.extraDesignObjects?.[index];
    if (_extraObjectIsOverlay(obj)) return 'overlay';
    return 'clone';
}

function _applyExtraLayerHandleStyle(obj, kind) {
    if (kind === 'overlay') {
        obj.set({
            transparentCorners: false,
            cornerColor: '#ff6600',
            cornerStyle: 'circle',
        });
        obj._isOverlay = true;
    } else {
        obj.set({
            transparentCorners: true,
            cornerColor: 'blue',
            borderColor: 'blue',
            cornerStyle: 'circle',
        });
        delete obj._isOverlay;
    }
}

// ── Cross-window geometry sync (one selected layer per active window) ─────────
function _selectedLayersForWindow(data) {
    if (!data) return [];
    return [...selectedDesigns].filter(obj =>
        obj === data.designObject ||
        (data.extraDesignObjects || []).includes(obj)
    );
}

function _windowHasAnyLayerSelected(data) {
    if (!data) return false;
    if (data.designObject && selectedDesigns.has(data.designObject)) return true;
    return (data.extraDesignObjects || []).some(o => selectedDesigns.has(o));
}

// Drop layer selections that no longer belong to any window (after delete/splice).
function _pruneOrphanSelectedDesigns() {
    const live = new Set();
    canvasData.forEach(d => {
        if (!d) return;
        if (d.designObject) live.add(d.designObject);
        (d.extraDesignObjects || []).forEach(o => live.add(o));
    });
    [...selectedDesigns].forEach(obj => {
        if (!live.has(obj)) selectedDesigns.delete(obj);
    });
}

// Remap numeric activeIndices after canvasData insert/delete/reorder (by data ref).
// Pass dataRefs when callers captured window data objects before a splice/reorder.
function _remapActiveIndicesByData(dataRefs) {
    const datas = (dataRefs != null
        ? dataRefs
        : activeIndices.map(i => canvasData[i])
    ).filter(Boolean);
    const seen = new Set();
    activeIndices = [];
    datas.forEach(d => {
        const i = canvasData.indexOf(d);
        if (i !== -1 && !seen.has(d)) {
            seen.add(d);
            activeIndices.push(i);
        }
    });
    if (lastSelectedIndex !== null && !canvasData.includes(lastSelectedIndex)) {
        lastSelectedIndex = null;
    }
    _pruneOrphanSelectedDesigns();
}

// Resolve export indices to live canvasData positions (guards stale slots after duplicate).
function _resolveExportIndices(indices) {
    if (indices == null) {
        _remapActiveIndicesByData();
        return [...activeIndices];
    }
    return indices
        .map(i => canvasData[i])
        .filter(Boolean)
        .map(d => canvasData.indexOf(d))
        .filter(i => i !== -1);
}

// Keep Fabric's .canvas-container clipped to the visible mockup card (prevents
// upper-canvas pointer bleed onto neighbouring windows in the grid).
function _syncFabricDisplaySize(data, targetColumnWidth = 300) {
    const fc = data?.fabricCanvas;
    if (!fc) return;
    const previewW = fc.getWidth();
    const previewH = fc.getHeight();
    if (!previewW || !previewH) return;
    const displayW = Math.round(
        parseFloat(data.wrapperEl?.style.width) || targetColumnWidth
    );
    const displayH = Math.round(previewH * displayW / previewW);
    fc.wrapperEl.style.width  = displayW + 'px';
    fc.wrapperEl.style.height = displayH + 'px';
    if (data.wrapperEl) data.wrapperEl.style.width = displayW + 'px';
}

// Shared window-selection logic for wrapper clicks and canvas background hits.
function _applyWindowClickSelection(index, e) {
    if (index < 0 || index >= canvasData.length) return;

    if (designEraserMode) return;

    if (clipEditMode && !clipCopySelectMode) return;

    if (colorLayerMode && !colorCopySelectMode) {
        if (!activeIndices.includes(index)) {
            alert('Exit Color Layer mode to interact with other windows.');
        }
        return;
    }

    if (colorCopySelectMode) {
        const pos = activeIndices.indexOf(index);
        if (pos === -1) activeIndices.push(index);
        else           activeIndices.splice(pos, 1);
        updateWindowBorders();
        return;
    }

    const isModifierMultiSelect = e.metaKey || e.ctrlKey;

    if (e.shiftKey) {
        const prevIndices = [...activeIndices];
        if (lastSelectedIndex === null) {
            activeIndices = [index];
        } else {
            const lastAnchorIdx = canvasData.indexOf(lastSelectedIndex);
            const start = Math.min(lastAnchorIdx, index);
            const end   = Math.max(lastAnchorIdx, index);
            const range = [];
            for (let i = start; i <= end; i++) range.push(i);
            activeIndices = [...new Set([...activeIndices, ...range])];
        }
        activeIndices.forEach(i => {
            const d = canvasData[i];
            if (d?.designObject && !d.locked && !selectedDesigns.has(d.designObject)) {
                if (!d.designObject._fx) d.designObject._fx = _defaultFx(d);
                selectedDesigns.add(d.designObject);
            }
        });
        prevIndices.filter(i => !activeIndices.includes(i)).forEach(i => {
            const d = canvasData[i];
            if (d) {
                selectedDesigns.delete(d.designObject);
                (d.extraDesignObjects || []).forEach(obj => selectedDesigns.delete(obj));
            }
        });
        lastSelectedIndex = canvasData[index];
    } else if (isModifierMultiSelect) {
        if (activeIndices.includes(index)) {
            activeIndices = activeIndices.filter(i => i !== index);
            const d = canvasData[index];
            if (d) {
                selectedDesigns.delete(d.designObject);
                (d.extraDesignObjects || []).forEach(obj => selectedDesigns.delete(obj));
            }
        } else {
            activeIndices.push(index);
            const d = canvasData[index];
            if (d?.designObject && !d.locked) {
                if (!d.designObject._fx) d.designObject._fx = _defaultFx(d);
                selectedDesigns.add(d.designObject);
            }
        }
        lastSelectedIndex = canvasData[index];
    } else {
        lastSelectedIndex = canvasData[index];
        if (!activeIndices.includes(index)) {
            activeIndices = [index];
            selectedDesigns.clear();
            const d = canvasData[index];
            if (d?.designObject && !d.locked) {
                if (!d.designObject._fx) d.designObject._fx = _defaultFx(d);
                selectedDesigns.add(d.designObject);
            }
        } else {
            const d = canvasData[index];
            if (d?.designObject && !d.locked && !_windowHasAnyLayerSelected(d)) {
                if (!d.designObject._fx) d.designObject._fx = _defaultFx(d);
                selectedDesigns.add(d.designObject);
            }
        }
    }

    if (e.shiftKey) lastSelectedIndex = canvasData[index];

    refreshFabricHandles();
    updateWindowBorders();
    updateLayerButtons();
    syncSliders();
    updateSelectButtonState();
}

function _attachWrapperClickListener(wrapper, data) {
    wrapper.addEventListener('click', function(e) {
        const index = canvasData.indexOf(data);
        if (index === -1) return;
        if (suppressNextWrapperClick && !e.shiftKey) return;
        if (data._windowCanvasSelectionAttached &&
            e.target.closest('.canvas-container')) return;
        _applyWindowClickSelection(index, e);
    });
}

// One-time Fabric canvas handlers: background window select, design-layer select,
// watermark/eraser/warp overlays, and custom multi-select handles.
function _attachWindowCanvasSelection(data) {
    if (data._windowCanvasSelectionAttached) return;
    data._windowCanvasSelectionAttached = true;

    data.fabricCanvas.on('mouse:down', (opt) => {
        const target = opt.target;
        const index  = canvasData.indexOf(data);
        if (index === -1) return;

        if (!target && !designEraserMode && !designWarpMode) {
            data._watermarkMarqueeActive = true;
            _beginWatermarkInteraction();
        }

        if (!target) {
            _applyWindowClickSelection(index, opt.e);
            return;
        }

        const isDesign = target === data.designObject ||
                         (data.extraDesignObjects || []).includes(target);
        if (!isDesign) return;

        suppressNextWrapperClick = true;

        const isCmd   = opt.e?.metaKey || opt.e?.ctrlKey;
        const isShift = opt.e?.shiftKey;
        const winIdx  = index;

        if (isCmd) {
            if (selectedDesigns.has(target)) {
                selectedDesigns.delete(target);
                const anyLeft = [...selectedDesigns].some(obj =>
                    obj === data.designObject ||
                    (data.extraDesignObjects || []).includes(obj)
                );
                if (!anyLeft && winIdx !== -1) {
                    activeIndices = activeIndices.filter(i => i !== winIdx);
                }
            } else {
                if (!target._fx) target._fx = _defaultFx(data);
                selectedDesigns.add(target);
                if (winIdx !== -1 && !activeIndices.includes(winIdx)) {
                    activeIndices.push(winIdx);
                }
            }
            lastSelectedIndex = data;
        } else if (isShift) {
            if (!data.designObject._fx) data.designObject._fx = _defaultFx(data);
            selectedDesigns.add(data.designObject);
            if (winIdx !== -1 && !activeIndices.includes(winIdx)) {
                activeIndices.push(winIdx);
            }
        } else {
            if (!selectedDesigns.has(target)) {
                selectedDesigns.clear();
                if (winIdx !== -1) activeIndices = [winIdx];
                if (!target._fx) target._fx = _defaultFx(data);
                selectedDesigns.add(target);
                refreshFabricHandles();
                updateWindowBorders();
                updateLayerButtons();
                syncSliders();
            }
            if (winIdx !== -1) lastSelectedIndex = data;
            return;
        }

        refreshFabricHandles();
        updateWindowBorders();
        updateLayerButtons();
        syncSliders();
    });

    data.fabricCanvas.on('after:render', () => {
        const canvas = data.fabricCanvas;
        const ctx    = canvas.contextContainer;
        const active = canvas.getActiveObject();

        [...selectedDesigns].forEach(obj => {
            const isOwn =
                obj === data.designObject ||
                (data.extraDesignObjects || []).includes(obj);
            if (!isOwn) return;
            if (obj === active) return;

            ctx.save();
            try {
                obj._renderControls(ctx, { hasBorders: true, hasControls: true });
            } catch (_) {
                const br = obj.getBoundingRect(true, true);
                ctx.strokeStyle = '#2196F3';
                ctx.lineWidth   = 2;
                ctx.setLineDash([5, 3]);
                ctx.strokeRect(br.left, br.top, br.width, br.height);
            }
            ctx.restore();
        });

        if (designWarpMode && data === warpActiveData) {
            _drawWarpOverlay(ctx);
        }
        if (designWarpMode && data !== warpActiveData) {
            const secGroup = warpAllGroups.find((g, i) => i > 0 && g.ownerData === data);
            if (secGroup) {
                _drawWarpPreview(ctx, secGroup.sourceCanvas, _scaledWarpPointsForGroup(secGroup));
            }
        }
        _drawWatermarkOnCanvas(data);
    });

    data.fabricCanvas.on('mouse:up', () => {
        if (data._watermarkMarqueeActive) {
            data._watermarkMarqueeActive = false;
            _endWatermarkInteraction();
        }
    });

    data.fabricCanvas.on('mouse:down', (opt) => {
        if (!designEraserMode) return;
        const targetData = eraserTargetObject?._ownerData;
        if (!targetData || targetData !== data) return;

        if (!designEraserDown) {
            const index = canvasData.indexOf(data);
            const items = [{ idx: index, snap: _captureEraserSnapshot(data) }];
            if (items.length) {
                globalUndoStack.push({ type: 'eraser', items });
                if (globalUndoStack.length > MAX_UNDO_HISTORY) globalUndoStack.shift();
                globalRedoStack = [];
                updateUndoRedoButtons();
            }
        }

        designEraserDown = true;
        applyDesignEraserAt(data, data.fabricCanvas.getPointer(opt.e));
    });
    data.fabricCanvas.on('mouse:move', (opt) => {
        if (!designEraserMode || !designEraserDown) return;
        applyDesignEraserAt(data, data.fabricCanvas.getPointer(opt.e));
    });
    data.fabricCanvas.on('mouse:up', () => {
        if (designEraserMode) {
            designEraserDown = false;
            _syncProEffect(data);
            _flushEraserPendingRebuild();
        }
    });

    data.fabricCanvas.on('mouse:down', (opt) => {
        if (!designWarpMode || data !== warpActiveData) return;
        const pointer = data.fabricCanvas.getPointer(opt.e);
        let bestDist2 = 18 * 18;
        let bestRC    = null;
        for (let r = 0; r < 4; r++) {
            for (let c = 0; c < 4; c++) {
                const p  = warpPoints[r][c];
                const dx = p.x - pointer.x, dy = p.y - pointer.y;
                const d2 = dx * dx + dy * dy;
                if (d2 < bestDist2) { bestDist2 = d2; bestRC = { r, c }; }
            }
        }
        warpDragRC = bestRC;
    });
    data.fabricCanvas.on('mouse:move', (opt) => {
        if (!designWarpMode || !warpDragRC || data !== warpActiveData) return;
        const pointer = data.fabricCanvas.getPointer(opt.e);
        warpPoints[warpDragRC.r][warpDragRC.c] = { x: pointer.x, y: pointer.y };
        data.fabricCanvas.requestRenderAll();
        warpAllGroups.forEach((g, i) => {
            if (i > 0) g.ownerData.fabricCanvas.requestRenderAll();
        });
    });
    data.fabricCanvas.on('mouse:up', () => {
        if (designWarpMode) warpDragRC = null;
    });
}

function _canCrossWindowSync() {
    if (activeIndices.length < 2) return false;
    for (const i of activeIndices) {
        const d = canvasData[i];
        if (!d || d.locked) return false;
        if (_selectedLayersForWindow(d).length !== 1) return false;
    }
    return true;
}

function _captureFabricGeometry(obj) {
    return {
        left:   obj.left,
        top:    obj.top,
        scaleX: obj.scaleX,
        scaleY: obj.scaleY,
        angle:  obj.angle ?? 0,
        skewX:  obj.skewX  || 0,
        skewY:  obj.skewY  || 0,
    };
}

function _applyFabricGeometry(obj, geo) {
    obj.set({
        left:   geo.left,
        top:    geo.top,
        scaleX: geo.scaleX,
        scaleY: geo.scaleY,
        angle:  geo.angle,
        skewX:  geo.skewX,
        skewY:  geo.skewY,
    });
    obj.setCoords();
}

function _syncMainDesignDataFromFabric(data) {
    if (!data?.designObject) return;
    const ps = data.previewScale || 1;
    const obj = data.designObject;
    data.x        = obj.left;
    data.y        = obj.top;
    data.scaleX   = obj.scaleX / ps;
    data.scaleY   = obj.scaleY / ps;
    data.rotation = obj.angle ?? 0;
    data.skewX    = obj.skewX || 0;
    data.skewY    = obj.skewY || 0;
}

function _syncAttachedLayersInDriverWindow(data, driverObj) {
    if (driverObj !== data.designObject) return;
    const geo = _captureFabricGeometry(driverObj);
    getAllDesignObjects(data).forEach(obj => {
        if (obj === driverObj) return;
        if ((data.extraDesignObjects || []).includes(obj) && !selectedDesigns.has(obj)) return;
        _applyFabricGeometry(obj, geo);
    });
}

function _applyCrossWindowGeometrySync(driverObj, driverData) {
    if (!_canCrossWindowSync()) return;
    const geo = _captureFabricGeometry(driverObj);
    const driverIdx = canvasData.indexOf(driverData);
    activeIndices.forEach(i => {
        if (i === driverIdx) return;
        const d = canvasData[i];
        if (!d || d.locked) return;
        const peer = _selectedLayersForWindow(d)[0];
        if (!peer || peer === driverObj) return;
        _applyFabricGeometry(peer, geo);
        if (d.patternMode && peer === d.designObject) _renderPattern(d, true);
        d.fabricCanvas.requestRenderAll();
    });
}

function _persistSelectedLayerDataForActiveWindows() {
    activeIndices.forEach(i => {
        const d = canvasData[i];
        if (!d || d.locked) return;
        const layers = _selectedLayersForWindow(d);
        if (layers.length !== 1) return;
        if (layers[0] !== d.designObject) return;
        _syncMainDesignDataFromFabric(d);
    });
}

function _getPrimarySelectedLayer(data) {
    const layers = _selectedLayersForWindow(data);
    if (layers.length === 1) return layers[0];
    return data.designObject || null;
}

// Show Fabric handles on all selected designs; hide on all others.
function refreshFabricHandles(){
    canvasData.forEach(d => {
        if(!d.fabricCanvas) return;
        (d.extraDesignObjects || []).forEach((obj, i) => {
            _applyExtraLayerHandleStyle(obj, _extraLayerKind(d, i));
        });
        // Locked windows never show transform handles
        if(d.locked){
            if(d.fabricCanvas.getActiveObject()){
                d.fabricCanvas.discardActiveObject();
                d.fabricCanvas.requestRenderAll();
            }
            return;
        }
        const ownSelected = [...selectedDesigns].filter(obj =>
            obj === d.designObject ||
            (d.extraDesignObjects||[]).includes(obj)
        );
        if(ownSelected.length > 0){
            const current = d.fabricCanvas.getActiveObject();
            const toActivate = (current && ownSelected.includes(current))
                ? current
                : ownSelected[ownSelected.length - 1];
            if(d.fabricCanvas.getActiveObject() !== toActivate){
                d.fabricCanvas.setActiveObject(toActivate);
            }
        } else {
            if(d.fabricCanvas.getActiveObject()){
                d.fabricCanvas.discardActiveObject();
            }
        }
        d.fabricCanvas.requestRenderAll();
    });
}

function updateWindowBorders(){
    canvasData.forEach((d, i) => {
        const w = d?.wrapperEl;
        if (!w) return;
        w.classList.remove('active', 'design-active');
        if (selectedDesigns.size > 0) {
            const hasSelected = (
                (d.designObject && selectedDesigns.has(d.designObject)) ||
                (d.extraDesignObjects || []).some(obj => selectedDesigns.has(obj))
            );
            if (hasSelected || activeIndices.includes(i)) w.classList.add('active');
        } else if (activeIndices.includes(i)) {
            w.classList.add('active');
        }
    });

    // Update Change Design button label: "Add Design" if any selected window
    // has no design, "Change Design" if all selected windows have designs.
    const changeDesignBtn = document.getElementById('changeDesignBtn');
    if(changeDesignBtn && activeIndices.length > 0){
        const anyNoDesign = activeIndices.some(i => !canvasData[i]?.designOriginal);
        changeDesignBtn.textContent = anyNoDesign ? 'Add Design' : 'Change Design';
    } else if(changeDesignBtn){
        changeDesignBtn.textContent = 'Change Design';
    }
    _scheduleMinimapUpdate();
    _updateWindowCountBadge();
}

function _updateWindowCountBadge(){
    const badge = document.getElementById('windowCountBadge');
    if(!badge) return;
    const total = canvasData.length;
    if(!total){ badge.hidden = true; return; }
    badge.hidden = false;
    const sel = activeIndices.length;
    badge.textContent = sel > 0
        ? `${total} window${total !== 1 ? 's' : ''} · ${sel} selected`
        : `${total} window${total !== 1 ? 's' : ''}`;
}

// Reset all left-panel controls to upload defaults (no canvas selection required).
function _resetLeftPanelToDefaults() {
    warpAmount.valueAsNumber    = 0;
    arcAmount.valueAsNumber     = 0;
    arcTilt.valueAsNumber       = 0;
    perspectiveTop.valueAsNumber  = 0;
    perspectiveLeft.valueAsNumber = 0;
    opacityAmount.valueAsNumber = 100;
    blurAmount.valueAsNumber    = 0;
    noiseAmount.valueAsNumber   = 0;
    blendMode.value             = 'normal';

    bgHue.valueAsNumber        = 0;
    bgSaturation.valueAsNumber = 0;
    bgBrightness.valueAsNumber = 0;
    bgContrast.valueAsNumber   = 0;
    document.getElementById('bgHueVal')        && (document.getElementById('bgHueVal').textContent        = '0');
    document.getElementById('bgSaturationVal') && (document.getElementById('bgSaturationVal').textContent = '0');
    document.getElementById('bgBrightnessVal') && (document.getElementById('bgBrightnessVal').textContent = '0');
    document.getElementById('bgContrastVal')   && (document.getElementById('bgContrastVal').textContent   = '0');

    const bgCropRotEl = document.getElementById('bgCropRotation');
    const bgCropScaleEl = document.getElementById('bgCropScale');
    const bgCropXEl = document.getElementById('bgCropX');
    const bgCropYEl = document.getElementById('bgCropY');
    if (bgCropRotEl) bgCropRotEl.valueAsNumber = 0;
    if (bgCropScaleEl) bgCropScaleEl.valueAsNumber = 100;
    if (bgCropXEl) bgCropXEl.valueAsNumber = 0;
    if (bgCropYEl) bgCropYEl.valueAsNumber = 0;
    document.getElementById('bgCropRotationVal') && (document.getElementById('bgCropRotationVal').textContent = '0');
    document.getElementById('bgCropScaleVal')    && (document.getElementById('bgCropScaleVal').textContent    = '100');
    document.getElementById('bgCropXVal')        && (document.getElementById('bgCropXVal').textContent        = '0');
    document.getElementById('bgCropYVal')        && (document.getElementById('bgCropYVal').textContent        = '0');
    document.getElementById('bgCropCustomW')     && (document.getElementById('bgCropCustomW').value = '');
    document.getElementById('bgCropCustomH')     && (document.getElementById('bgCropCustomH').value = '');
    document.querySelectorAll('.bg-aspect-btn').forEach(b => b.classList.remove('active'));

    const patternToggle = document.getElementById('patternModeToggle');
    if (patternToggle) patternToggle.checked = false;
    const patternControls = document.getElementById('patternControls');
    if (patternControls) patternControls.style.display = 'none';
    document.querySelectorAll('.pattern-type-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.type === 'grid'));
    if (typeof _patternSliderDefs !== 'undefined') {
        _patternSliderDefs.forEach(([id]) => {
            const el = document.getElementById(id);
            const valEl = document.getElementById(id + 'Val');
            if (el) el.valueAsNumber = 0;
            if (valEl) valEl.value = 0;
        });
    }

    colorLayerOpacity   = 1;
    colorLayerBlendMode = 'source-over';
    const clOpacityInput = document.getElementById('colorLayerOpacityInput');
    const clModeSelect   = document.getElementById('colorLayerModeSelect');
    if (clOpacityInput) clOpacityInput.value = 100;
    if (clModeSelect) clModeSelect.value = 'source-over';
    const brushSizeEl = document.getElementById('brushSizeSlider');
    const brushSoftEl = document.getElementById('brushSoftnessSlider');
    if (brushSizeEl) brushSizeEl.valueAsNumber = 20;
    if (brushSoftEl) brushSoftEl.valueAsNumber = 30;
    brushSize = 20;
}

function _exitAllEditModes() {
    if (designWarpMode && typeof exitDesignWarpMode === 'function') {
        exitDesignWarpMode(false);
    }
    if (designEraserMode && typeof exitDesignEraserMode === 'function') {
        exitDesignEraserMode();
    }
    if (clipEditMode) {
        if (typeof _restoreClipLayersVisibility === 'function') {
            _restoreClipLayersVisibility();
        }
        clipEditMode = false;
        clipCopySelectMode = false;
        clipCopySourceIndex = null;
        if (typeof stopMarchingAnts === 'function') stopMarchingAnts();
        activeClipWindowIndex = null;
        const editClipBtn = document.getElementById('editClipBtn');
        if (editClipBtn) editClipBtn.innerText = 'Edit Clipping';
        ['addClipAreaBtn', 'deleteClipBtn', 'copyClipBtn', 'hideClipLayersBtn', 'copyClipToSelectedBtn'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = 'none';
        });
    }
    if (colorLayerMode) {
        colorLayerMode = false;
        colorCopySelectMode = false;
        colorCopySourceIndex = null;
        brushTool = 'brush';
        isColorPainting = false;
        lastPaintNorm = null;
        if (typeof _stopColorLayerCursorTracking === 'function') {
            _stopColorLayerCursorTracking();
        }
        canvasData.forEach(data => {
            getAllDesignObjects(data).forEach(o => {
                if (!o) return;
                o.selectable = (o._prevSelectable !== undefined) ? o._prevSelectable : true;
                o.evented    = (o._prevEvented    !== undefined) ? o._prevEvented    : true;
                delete o._prevSelectable;
                delete o._prevEvented;
            });
            if (data.fabricCanvas) {
                data.fabricCanvas.selection = true;
            }
        });
        document.querySelectorAll('.canvas-wrapper').forEach(w => w.classList.remove('color-layer-mode'));
        const addBtn = document.getElementById('addColorLayerBtn');
        if (addBtn) addBtn.innerText = 'Paint Overlay';
        const clControls = document.getElementById('colorLayerControls');
        if (clControls) clControls.style.display = 'none';
        ['copyColorBtn', 'copyColorToSelectedBtn', 'deleteColorBtn'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = 'none';
        });
        document.getElementById('brushToolBtn')?.classList.add('active');
        document.getElementById('eraserToolBtn')?.classList.remove('active');
        const picker = document.getElementById('brushColorPicker');
        if (picker) picker.style.visibility = '';
    }
}

function _resetLayoutToDefaults() {
    _numColumns = 4;
    _rowGap     = 20;
    _colGap     = 20;
    const colsInput = document.getElementById('numColsInput');
    const rowInput  = document.getElementById('rowGapInput');
    const colInput  = document.getElementById('colGapInput');
    if (colsInput) colsInput.value = _numColumns;
    if (rowInput)  rowInput.value  = _rowGap;
    if (colInput)  colInput.value  = _colGap;
    const container = document.getElementById('canvasContainer');
    if (container) {
        container.style.gridTemplateColumns = `repeat(${_numColumns}, max-content)`;
        container.style.width = 'max-content';
        container.style.rowGap    = _rowGap + 'px';
        container.style.columnGap = _colGap + 'px';
    }
}

function syncSliders() {

    if(!activeIndices.length) {
        _resetLeftPanelToDefaults();
        return;
    }

    const data = canvasData[activeIndices[0]];

    // If design objects are directly selected, reflect first object's _fx.
    if(selectedDesigns.size > 0){
        const firstObj = [...selectedDesigns][0];
        const fx = firstObj?._fx;
        if(fx){
            warpAmount.valueAsNumber    = fx.warpAmount    || 0;
            arcAmount.valueAsNumber     = fx.arcAmount     || 0;
            arcTilt.valueAsNumber       = fx.arcTilt       || 0;
            opacityAmount.valueAsNumber = Math.round((fx.opacity ?? 1) * 100);
            blurAmount.valueAsNumber    = fx.blurAmount    || 0;
            noiseAmount.valueAsNumber   = fx.noiseAmount   || 0;
            perspectiveTop.valueAsNumber  = fx.perspectiveTop  || 0;
            perspectiveLeft.valueAsNumber = fx.perspectiveLeft || 0;
            blendMode.value               = fx.blendMode       || "normal";
            return;
        }
    }

    const obj = data.designObject;

    if(!obj) return;

    warpAmount.valueAsNumber    = data.warpAmount    || 0;
    arcAmount.valueAsNumber     = data.arcAmount     || 0;
    arcTilt.valueAsNumber       = data.arcTilt       || 0;
    opacityAmount.valueAsNumber = Math.round((data.opacity ?? 1) * 100);
    blurAmount.valueAsNumber    = data.blurAmount    || 0;
    noiseAmount.valueAsNumber   = data.noiseAmount   || 0;
    perspectiveTop.valueAsNumber  = data.perspectiveTop  || 0;
    perspectiveLeft.valueAsNumber = data.perspectiveLeft || 0;
    blendMode.value               = data.blendMode        || "normal";

    _syncBgAdjustDisplay();
    _syncPatternDisplay();

    if(colorLayerMode && data.colorLayerFabricObj){
        const clOpacity = data.colorLayerFabricObj.opacity ?? 1;
        const clBlend   = data.colorLayerFabricObj.globalCompositeOperation ?? 'source-over';
        colorLayerOpacity   = clOpacity;
        colorLayerBlendMode = clBlend;
        document.getElementById("colorLayerOpacityInput").value = Math.round(clOpacity * 100);
        document.getElementById("colorLayerModeSelect").value   = clBlend;
    }
}







function _defaultFx(data){
    return {
        warpAmount:      data.warpAmount      ?? 0,
        arcAmount:       data.arcAmount       ?? 0,
        arcTilt:         data.arcTilt         ?? 0,
        perspectiveTop:  data.perspectiveTop  ?? 0,
        perspectiveLeft: data.perspectiveLeft ?? 0,
        opacity:         data.opacity         ?? 1,
        blurAmount:      data.blurAmount      ?? 0,
        noiseAmount:     data.noiseAmount     ?? 0,
        blendMode:       data.blendMode       ?? 'normal'
    };
}

// Clear per-object image pipeline caches (used after duplicate, eraser, etc.).
function _resetObjectPipelineCaches(obj) {
    if (!obj) return;
    delete obj._c_src;
    delete obj._c_blurR;
    delete obj._c_blurred;
    delete obj._c_noisyIn;
    delete obj._c_noiseP;
    delete obj._c_noisy;
    delete obj._c_warpOk;
    delete obj._c_warpSrc;
    delete obj._c_warpA;
    delete obj._c_arcA;
    delete obj._c_arcT;
    delete obj._c_warpLQ;
    delete obj._c_trimmed;
    delete obj._c_perspT;
    delete obj._c_perspL;
    delete obj._c_perspLQ;
    delete obj._c_persp;
    delete obj._c_srcTrimSrc;
    delete obj._c_srcTrimmed;
    delete obj._c_perspW;
    delete obj._c_perspH;
    delete obj._warpCanvas;
    delete obj._perspCanvas;
    delete obj._perspTempCanvas;
}

// Apply the full blur → noise → warp → perspective pipeline to ONE design
// object using its own _fx bag.  Called both from the design-mode slider
// handler (only the selected object) and from applyWarpToData (extra objects).
function _applyWarpToOneObject(obj, data, srcOriginal, lowQuality, opts){

    opts = opts || {};
    const skipTrimComp = !!opts.skipTrimComp;

    const fx = obj._fx || _defaultFx(data);

    if(!srcOriginal) return;

    if(!obj._warpCanvas) obj._warpCanvas = document.createElement('canvas');

    const blurR  = (fx.blurAmount  || 0) / 5;
    const noiseP =  fx.noiseAmount || 0;
    const warpA  =  fx.warpAmount  || 0;
    const arcA   =  fx.arcAmount   || 0;
    const arcT   =  fx.arcTilt     ?? 0;
    const perspT =  fx.perspectiveTop  || 0;
    const perspL =  fx.perspectiveLeft || 0;

    // ── Stage 1: blur ────────────────────────────────────────────────────────
    // Skip re-blurring when src and radius are unchanged (common during warp/persp drag).
    let blurred;
    if(obj._c_src === srcOriginal && obj._c_blurR === blurR && obj._c_blurred){
        blurred = obj._c_blurred;
    } else {
        blurred = applyGaussianBlurToImage(srcOriginal, blurR);
        obj._c_src     = srcOriginal;
        obj._c_blurR   = blurR;
        obj._c_blurred = blurred;
        obj._c_noisy   = null; // invalidate downstream
    }

    // ── Stage 2: noise ───────────────────────────────────────────────────────
    // Skip re-noising when noise% and blurred source are unchanged.
    let noisy;
    if(obj._c_noisyIn === blurred && obj._c_noiseP === noiseP && obj._c_noisy){
        noisy = obj._c_noisy;
    } else {
        noisy = applyNoiseToImage(blurred, noiseP);
        obj._c_noisyIn = blurred;
        obj._c_noiseP  = noiseP;
        obj._c_noisy   = noisy;
        obj._c_warpOk  = false; // invalidate warp
    }

    // ── Stage 3: warp ─────────────────────────────────────────────────────────
    // createWarpedImage writes to obj._warpCanvas in-place; skip when all params unchanged.
    let warpDirty;
    if( obj._c_warpOk       &&
        obj._c_warpSrc === noisy  &&
        obj._c_warpA   === warpA  &&
        obj._c_arcA    === arcA   &&
        obj._c_arcT    === arcT   &&
        obj._c_warpLQ  === lowQuality){
        warpDirty = false;
    } else {
        createWarpedImage(noisy, warpA, arcA, arcT, obj._warpCanvas, lowQuality);
        obj._c_warpOk  = true;
        obj._c_warpSrc = noisy;
        obj._c_warpA   = warpA;
        obj._c_arcA    = arcA;
        obj._c_arcT    = arcT;
        obj._c_warpLQ  = lowQuality;
        warpDirty = true;
    }

    // ── Stage 4: trim ─────────────────────────────────────────────────────────
    // trimTransparentBorders calls getImageData (GPU readback) — cache when warp unchanged.
    let trimmed;
    if(!warpDirty && obj._c_trimmed){
        trimmed = obj._c_trimmed;
    } else {
        trimmed = trimTransparentBorders(obj._warpCanvas);
        obj._c_trimmed = trimmed;
    }

    // ── Stage 5: perspective ──────────────────────────────────────────────────
    // Pass the cached trimmed canvas so applyPerspectiveDistortion skips its own
    // trimTransparentBorders call. Also skip the full perspective pass when both
    // the warp canvas and perspective params are unchanged.
    // Persistent canvases (_perspCanvas, _perspTempCanvas) are reused each call
    // to avoid GPU memory allocation on every frame across hundreds of windows.
    if(!obj._perspCanvas)     obj._perspCanvas     = document.createElement('canvas');
    if(!obj._perspTempCanvas) obj._perspTempCanvas = document.createElement('canvas');
    const prevPerspW = obj._c_perspW;
    const prevPerspH = obj._c_perspH;
    const perspChanged = obj._c_perspT !== perspT || obj._c_perspL !== perspL || obj._c_perspLQ !== lowQuality;
    let warped;
    if( !warpDirty          &&
        obj._c_perspT  === perspT   &&
        obj._c_perspL  === perspL   &&
        obj._c_perspLQ === lowQuality &&
        obj._c_persp){
        warped = obj._c_persp;
    } else {
        warped = applyPerspectiveDistortion(obj._warpCanvas, fx, lowQuality, trimmed, obj._perspCanvas, obj._perspTempCanvas);
        obj._c_perspT  = perspT;
        obj._c_perspL  = perspL;
        obj._c_perspLQ = lowQuality;
        obj._c_persp   = warped;
        obj._c_perspW  = warped.width;
        obj._c_perspH  = warped.height;
    }

    const prevLeft   = obj.left;
    const prevTop    = obj.top;
    const prevScaleX = obj.scaleX;
    const prevScaleY = obj.scaleY;
    const prevSkewX  = obj.skewX || 0;
    const prevSkewY  = obj.skewY || 0;
    const prevAngle  = obj.angle;

    obj.setElement(warped);
    obj.dirty = true;
    applyClipMaskToObject(obj, data);

    // Compensate for content shift introduced by trimTransparentBorders.
    // Only when arc/warp are both zero: arc and warp intentionally produce
    // asymmetric transparent borders whose trim must NOT be corrected
    // (compensating them shifts the design as sliders move).
    // Always use srcOriginal (pre-blur) as the reference: when blur is active,
    // obj._warpCanvas is padded (W + 2*pad) so its trim offsets diverge from
    // the original eraser-trimmed content and cause an apparent leftward shift.
    let adjLeft = prevLeft;
    let adjTop  = prevTop;
    // Only when warp output changed — not on perspective-only updates (avoids
    // re-applying trim offset every frame, which makes layers jump while dragging).
    if (!skipTrimComp && arcA === 0 && warpA === 0 && warpDirty) {
        // Cache trim of srcOriginal: only re-run getImageData when the source changes
        // (e.g. after an eraser stroke), not on every slider-drag render.
        let srcTrimmed;
        if (obj._c_srcTrimSrc === srcOriginal && obj._c_srcTrimmed) {
            srcTrimmed = obj._c_srcTrimmed;
        } else {
            srcTrimmed = trimTransparentBorders(srcOriginal);
            obj._c_srcTrimSrc = srcOriginal;
            obj._c_srcTrimmed = srcTrimmed;
        }
        if (srcTrimmed._trimX0 !== undefined || srcTrimmed._trimY0 !== undefined) {
            const tx0 = srcTrimmed._trimX0 || 0;
            const ty0 = srcTrimmed._trimY0 || 0;
            const dx  = (tx0 + srcTrimmed.width  / 2) - srcOriginal.width  / 2;
            const dy  = (ty0 + srcTrimmed.height / 2) - srcOriginal.height / 2;
            if (dx !== 0 || dy !== 0) {
                const rad  = (prevAngle || 0) * Math.PI / 180;
                const cosA = Math.cos(rad);
                const sinA = Math.sin(rad);
                adjLeft += dx * prevScaleX * cosA - dy * prevScaleY * sinA;
                adjTop  += dx * prevScaleX * sinA + dy * prevScaleY * cosA;
            }
        }
    }

    // Keep visual center stable when perspective output size changes (no warp re-run).
    if (!skipTrimComp && arcA === 0 && warpA === 0 && !warpDirty && perspChanged &&
        prevPerspW != null && prevPerspH != null) {
        const dW = warped.width - prevPerspW;
        const dH = warped.height - prevPerspH;
        if (dW !== 0 || dH !== 0) {
            const rad  = (prevAngle || 0) * Math.PI / 180;
            const cosA = Math.cos(rad);
            const sinA = Math.sin(rad);
            adjLeft += (dW / 2) * prevScaleX * cosA - (dH / 2) * prevScaleY * sinA;
            adjTop  += (dW / 2) * prevScaleX * sinA + (dH / 2) * prevScaleY * cosA;
        }
    }

    obj.set({
        left:   adjLeft,
        top:    adjTop,
        scaleX: prevScaleX,
        scaleY: prevScaleY,
        skewX:  prevSkewX,
        skewY:  prevSkewY,
        angle:  prevAngle,
        opacity: fx.opacity ?? 1,
        globalCompositeOperation: _blendToGCO(fx.blendMode)
    });
}


async function applyWarpToData(data, lowQuality = false){

    if(!data.designOriginal) return;

    if(!data.warpCanvas){
        data.warpCanvas = document.createElement("canvas");
    }

    // Apply flip before the rest of the pipeline so all effects (blur, noise,
    // warp, perspective) operate on the already-flipped image.
    const pipelineSrc = _cachedFlip(data, data.designOriginal);

    const blurredSource = applyGaussianBlurToImage(
        pipelineSrc,
        (data.blurAmount || 0) / 5
    );

    // Noise is applied after blur (so grain isn't softened) but before warp
    // (so it rides along with the texture distortion, matching PS behaviour).
    const noisySource = applyNoiseToImage(blurredSource, data.noiseAmount || 0);

    // ── Pattern mode: warp/perspective apply to the whole tiled canvas, not tiles ──
    // Requires designObject — reset clears pattern before dropping the object.
    if(data.patternMode && data.patternFabricObj && data.designObject){
        data._patternTileSource = noisySource;
        if(data.designObject){
            data.designObject.setElement(noisySource);
            data.designObject.dirty = true;
            data.designObject.set({opacity: 0});
        }
        _renderPattern(data, lowQuality);
        data.fabricCanvas.requestRenderAll();
        return;
    }

    const warpedBaseCanvas = createWarpedImage(
        noisySource,
        data.warpAmount,
        data.arcAmount,
        data.arcTilt ?? 0,
        data.warpCanvas,
        lowQuality
    );

    const warpedCanvas = applyPerspectiveDistortion(
        warpedBaseCanvas,
        data,
        lowQuality
    );

    if(data.designObject){

        data.designObject.setElement(warpedCanvas);
        data.designObject.dirty = true;

        applyClipMaskToObject(data.designObject, data);

        // Compensate for eraser-induced position shift only when arc/warp are
        // both zero.  Arc and warp produce their own asymmetric transparent
        // borders; compensating those trims shifts the design as sliders move.
        const scX = (data.scaleX || data.scale) * data.previewScale;
        const scY = (data.scaleY || data.scale) * data.previewScale;
        let adjX = data.x;
        let adjY = data.y;
        const _noArcWarp = !(data.arcAmount || 0) && !(data.warpAmount || 0);
        if (_noArcWarp) {
            // Always compute position compensation from pipelineSrc (pre-blur).
            // When blur is active, warpedBaseCanvas is padded (W + 2*pad) so
            // its trim offsets diverge from the original eraser-trimmed content,
            // causing the design to appear to shift left as blur increases.
            // pipelineSrc has the original dimensions in all cases (blur = 0
            // makes blurredSource === pipelineSrc, so behaviour is unchanged).
            const srcTrimmed = trimTransparentBorders(pipelineSrc);
            if (srcTrimmed._trimX0 !== undefined || srcTrimmed._trimY0 !== undefined) {
                const tx0  = srcTrimmed._trimX0 || 0;
                const ty0  = srcTrimmed._trimY0 || 0;
                const refW = pipelineSrc.width;
                const refH = pipelineSrc.height;
                const dx   = (tx0 + srcTrimmed.width  / 2) - refW / 2;
                const dy   = (ty0 + srcTrimmed.height / 2) - refH / 2;
                if (dx !== 0 || dy !== 0) {
                    const rad  = (data.rotation || 0) * Math.PI / 180;
                    const cosA = Math.cos(rad);
                    const sinA = Math.sin(rad);
                    adjX += dx * scX * cosA - dy * scY * sinA;
                    adjY += dx * scX * sinA + dy * scY * cosA;
                }
            }
        }

        data.designObject.set({
            left: adjX,
            top:  adjY,
            angle: data.rotation,
            scaleX: scX,
            scaleY: scY,
            skewX: data.skewX || 0,
            skewY: data.skewY || 0,
            opacity: data.opacity ?? 1,
            globalCompositeOperation: _blendToGCO(data.blendMode)
        });

        if(data.extraDesignObjects?.length){

            data.extraDesignObjects.forEach((obj, i)=>{

                // Each extra object uses its own _fx (set in design mode).
                // Uploads have their own source image; clones fall back to the
                // main design's source so the full pipeline runs from scratch.
                const srcForObj =
                    data.extraDesignOriginals?.[i] || data.designOriginal;

                _applyWarpToOneObject(obj, data, _cachedFlip(data, srcForObj), lowQuality);
            });
        }

        data.fabricCanvas.requestRenderAll();
        return;
    }

    const newImg = new fabric.Image(warpedCanvas);

    applyClipMaskToObject(newImg, data);

    newImg.set({
        left: data.x,
        top: data.y,
        angle: data.rotation,
        scaleX: (data.scaleX || data.scale) * data.previewScale,
        scaleY: (data.scaleY || data.scale) * data.previewScale,
        opacity: data.opacity ?? 1,
        globalCompositeOperation: _blendToGCO(data.blendMode),
        originX: 'center',
        originY: 'center',
        transparentCorners: false,
        cornerColor: 'blue',
        cornerStyle: 'circle'
    });

    data.designObject = newImg;

    // Initialise per-object effects from the current window settings so the
    // sliders correctly reflect this object when it's selected in design mode.
    newImg._fx = _defaultFx(data);

    data.fabricCanvas.add(newImg);
    data.fabricCanvas.discardActiveObject();
    data.fabricCanvas.requestRenderAll();

    attachFabricEvents(data);

    autoSaveSession();
}




function isElementVisible(el){
    // O(1) lookup into the IntersectionObserver-maintained Set.
    // Falls back to getBoundingClientRect for elements not yet observed
    // (e.g. queried before the observer fires its first callback).
    if(_visibleWrappers.has(el)) return true;
    const rect = el.getBoundingClientRect();
    return rect.bottom >= 0 && rect.top <= window.innerHeight + 300;
}


// ── Slider rAF throttle ───────────────────────────────────────────────────────
// Input events can fire 200+/sec during fast drags. We gate the expensive LQ
// render to at most one per animation frame (~60/sec) while still resetting the
// HQ debounce timer on every event so HQ fires exactly 220 ms after the user
// stops.  _lqRenderSliders reads slider DOM values when it runs (rAF tick), so
// it always sees the most recent position — no staleness risk.
var _sliderRAFId = null;

function updateFromSliders(event){

    if(clipEditMode){ showClipModeNotice(); return; }
    if(!activeIndices.length) return;

    if(event?.target?.id) activeSliderType = event.target.id;

    // Mark PRO effect when a warp or perspective slider is moved to a non-zero value.
    // (blur / noise are in _needsWarp for render reasons but are not PRO features.)
    const _isWarpProSlider =
        activeSliderType === "warpAmount"     ||
        activeSliderType === "arcAmount"      ||
        activeSliderType === "arcTilt"        ||
        activeSliderType === "perspectiveTop" ||
        activeSliderType === "perspectiveLeft";
    if (_isWarpProSlider && event?.target && parseFloat(event.target.value) !== 0) {
        activeIndices.forEach(i => _syncProEffect(canvasData[i]));
    }

    // Determine whether this slider type needs a warp re-render.
    const _needsWarp =
        activeSliderType === "warpAmount"     ||
        activeSliderType === "arcAmount"      ||
        activeSliderType === "arcTilt"        ||
        activeSliderType === "blurAmount"     ||
        activeSliderType === "noiseAmount"    ||
        activeSliderType === "perspectiveTop" ||
        activeSliderType === "perspectiveLeft";

    // Always reset HQ debounce on every input event so HQ fires after
    // the user stops — even when the LQ frame is throttled away.
    // Scale the delay up with selection size: each extra window adds 30 ms so
    // the HQ mip-chain allocations for many windows don't all land at once.
    if(selectedDesigns.size === 0 || _needsWarp){
        clearTimeout(globalHQTimer);
        const _hqDelay = 220 + Math.max(0, activeIndices.length - 1) * 30;
        globalHQTimer = setTimeout(_hqRenderSliders, _hqDelay);
    }

    // Gate LQ computation to one per animation frame.
    if(_sliderRAFId !== null) return;
    _sliderRAFId = requestAnimationFrame(()=>{
        _sliderRAFId = null;
        _lqRenderSliders();
    });
}

// ── LQ render (runs inside rAF, at most 60×/sec) ─────────────────────────────
function _lqRenderSliders(){

    if(!activeIndices.length) return;

    const requiresWarp =
        activeSliderType === "warpAmount"     ||
        activeSliderType === "arcAmount"      ||
        activeSliderType === "arcTilt"        ||
        activeSliderType === "blurAmount"     ||
        activeSliderType === "noiseAmount"    ||
        activeSliderType === "perspectiveTop" ||
        activeSliderType === "perspectiveLeft";

    // ── Design-mode: apply _fx to all selected objects ────────────────────────
    if(selectedDesigns.size > 0){

        opacityAmount.value = Math.max(0, Math.min(100, parseFloat(opacityAmount.value)||0));
        blurAmount.value    = Math.max(0, Math.min(100, parseFloat(blurAmount.value)   ||0));
        noiseAmount.value   = Math.max(0, Math.min(100, parseFloat(noiseAmount.value)  ||0));

        const newFx = {
            warpAmount:      parseFloat(warpAmount.value),
            arcAmount:       parseFloat(arcAmount.value),
            arcTilt:         parseFloat(arcTilt.value),
            perspectiveTop:  parseFloat(perspectiveTop.value),
            perspectiveLeft: parseFloat(perspectiveLeft.value),
            opacity:         parseFloat(opacityAmount.value) / 100,
            blurAmount:      parseFloat(blurAmount.value),
            noiseAmount:     parseFloat(noiseAmount.value),
            blendMode:       blendMode.value
        };

        selectedDesigns.forEach(obj => {
            const d = obj._ownerData;
            if(!d || d.locked) return;

            // Always update _fx so off-screen objects have correct state when
            // they scroll back into view.
            obj._fx = { ...newFx };

            // Mirror into data.* for main design so applyWarpToData stays in sync
            if(obj === d.designObject){
                d.warpAmount      = newFx.warpAmount;
                d.arcAmount       = newFx.arcAmount;
                d.arcTilt         = newFx.arcTilt;
                d.perspectiveTop  = newFx.perspectiveTop;
                d.perspectiveLeft = newFx.perspectiveLeft;
                d.opacity         = newFx.opacity;
                d.blurAmount      = newFx.blurAmount;
                d.noiseAmount     = newFx.noiseAmount;
                d.blendMode       = newFx.blendMode;
            }

            // Skip render work for off-screen objects — state is already updated above.
            if(!_visibleWrappers.has(d.wrapperEl || d.fabricCanvas.lowerCanvasEl.parentElement)) return;

            const isMain   = obj === d.designObject;
            const inPattern = isMain && d.patternMode && d.patternFabricObj;

            if(!requiresWarp){
                if(inPattern){
                    // Effects target the whole tiled canvas, not the invisible master tile
                    d.patternFabricObj.set({
                        opacity: newFx.opacity,
                        globalCompositeOperation: _blendToGCO(newFx.blendMode)
                    });
                    obj.set({opacity: 0});
                } else {
                    obj.set({
                        opacity: newFx.opacity,
                        globalCompositeOperation: _blendToGCO(newFx.blendMode)
                    });
                }
                d.fabricCanvas.requestRenderAll();
                return;
            }

            const extraIdx    = isMain ? -1 : (d.extraDesignObjects||[]).indexOf(obj);
            const srcOriginal = isMain
                ? d.designOriginal
                : (d.extraDesignOriginals?.[extraIdx] || d.designOriginal);

            if(!srcOriginal) return;

            if(inPattern){
                // Warp/blur/noise apply to the whole tiled canvas
                const _pSrc   = _cachedFlip(d, srcOriginal);
                const _pBlur  = applyGaussianBlurToImage(_pSrc, (newFx.blurAmount || 0) / 5);
                const _pNoise = applyNoiseToImage(_pBlur, newFx.noiseAmount || 0);
                d._patternTileSource = _pNoise;
                obj.setElement(_pNoise);
                obj.dirty = true;
                obj.set({opacity: 0});
                _renderPattern(d, true);
                d.fabricCanvas.requestRenderAll();
                return;
            }

            _applyWarpToOneObject(obj, d, _cachedFlip(d, srcOriginal), true);
            d.fabricCanvas.requestRenderAll();
        });

        // Sync PRO star badges for every active window based on the new _fx values.
        // Mirrors the zero-reset in the window-mode path so stars appear / disappear
        // correctly when multiple windows are selected in design mode.
        const _proWarpActive = newFx.warpAmount !== 0 || newFx.arcAmount !== 0 ||
            newFx.arcTilt !== 0 || newFx.perspectiveTop !== 0 || newFx.perspectiveLeft !== 0;
        const _proBlendActive = (newFx.blendMode || 'normal') !== 'normal';
        activeIndices.forEach(i => {
            const d = canvasData[i];
            if (!d || d.locked) return;
            _syncProEffect(d);
        });

        return;
    }

    // ── Window-mode: update visible windows ───────────────────────────────────
    // Read slider values once (shared across all windows in this frame).
    opacityAmount.value = Math.max(0, Math.min(100, parseFloat(opacityAmount.value) || 0));
    blurAmount.value    = Math.max(0, Math.min(100, parseFloat(blurAmount.value)    || 0));
    noiseAmount.value   = Math.max(0, Math.min(100, parseFloat(noiseAmount.value)   || 0));

    const _warpV  = parseFloat(warpAmount.value);
    const _arcV   = parseFloat(arcAmount.value);
    const _arcTV  = parseFloat(arcTilt.value);
    const _perspT = parseFloat(perspectiveTop.value);
    const _perspL = parseFloat(perspectiveLeft.value);
    const _opacV  = parseFloat(opacityAmount.value) / 100;
    const _blurV  = parseFloat(blurAmount.value);
    const _noiseV = parseFloat(noiseAmount.value);
    const _blendV = blendMode.value;

    activeIndices.forEach(index=>{

        const data = canvasData[index];
        if(data.locked) return;

        // Always update the scalar slider values so off-screen windows have
        // correct state when they scroll back into view.
        data.warpAmount      = _warpV;
        data.arcAmount       = _arcV;
        data.arcTilt         = _arcTV;
        data.perspectiveTop  = _perspT;
        data.perspectiveLeft = _perspL;
        data.opacity         = _opacV;
        data.blurAmount      = _blurV;
        data.noiseAmount     = _noiseV;
        data.blendMode       = _blendV;

        const _proWarpActive = _warpV !== 0 || _arcV !== 0 || _arcTV !== 0 ||
            _perspT !== 0 || _perspL !== 0;
        const _proBlendActive = (_blendV || 'normal') !== 'normal';
        _syncProEffect(data);

        // Skip all expensive render work for off-screen windows (O(1) Set lookup).
        const wrapper = data.wrapperEl || data.fabricCanvas.lowerCanvasEl.parentElement;
        if(!_visibleWrappers.has(wrapper)) return;

        // Sync live Fabric object transforms into data.* only for visible windows
        // (captureWindowState now reads from Fabric directly, so this is only
        // needed to keep applyWarpToData's left/top positioning correct).
        if(data.designObject){
            data.x        = data.designObject.left;
            data.y        = data.designObject.top;
            data.rotation = data.designObject.angle;
            data.scaleX   = data.designObject.scaleX / data.previewScale;
            data.scaleY   = data.designObject.scaleY / data.previewScale;
        }

        // Keep main design's _fx in sync with window-level properties
        if(data.designObject?._fx){
            data.designObject._fx.warpAmount     = _warpV;
            data.designObject._fx.arcAmount      = _arcV;
            data.designObject._fx.arcTilt        = _arcTV;
            data.designObject._fx.perspectiveTop  = _perspT;
            data.designObject._fx.perspectiveLeft = _perspL;
            data.designObject._fx.opacity         = _opacV;
            data.designObject._fx.blurAmount      = _blurV;
            data.designObject._fx.noiseAmount     = _noiseV;
            data.designObject._fx.blendMode       = _blendV;
        }

        // Fast path: opacity/blend only — no warp recomputation needed
        if(!requiresWarp){
            if(data.patternMode && data.patternFabricObj){
                data.patternFabricObj.set({
                    opacity: _opacV,
                    globalCompositeOperation: _blendToGCO(_blendV)
                });
                if(data.designObject) data.designObject.set({opacity: 0});
            } else if(data.designObject){
                data.designObject.set({
                    opacity: _opacV,
                    globalCompositeOperation: _blendToGCO(_blendV)
                });
            }
            data.fabricCanvas.requestRenderAll();
            return;
        }

        // Warp path: use _applyWarpToOneObject (with stage cache) for both main
        // design and extra layers, so unchanged pipeline stages are skipped.
        if(!data.designObject) return;

        // Pattern mode: recompute pre-warp tile source and re-render full canvas
        if(data.patternMode && data.patternFabricObj){
            const _pSrc   = _cachedFlip(data, data.designOriginal);
            const _pBlur  = applyGaussianBlurToImage(_pSrc, (_blurV || 0) / 5);
            const _pNoise = applyNoiseToImage(_pBlur, _noiseV || 0);
            data._patternTileSource = _pNoise;
            if(data.designObject){
                data.designObject.setElement(_pNoise);
                data.designObject.dirty = true;
                data.designObject.set({opacity: 0});
            }
            _renderPattern(data, true);
            data.fabricCanvas.requestRenderAll();
            return;
        }

        // Ensure _fx exists on the main design object so caching can compare params
        if(!data.designObject._fx) data.designObject._fx = _defaultFx(data);

        _applyWarpToOneObject(data.designObject, data, _cachedFlip(data, data.designOriginal), true);

        if(data.extraDesignObjects?.length){
            data.extraDesignObjects.forEach((obj, i) => {
                const src = data.extraDesignOriginals?.[i] || data.designOriginal;
                _applyWarpToOneObject(obj, data, _cachedFlip(data, src), true);
            });
        }

        data.fabricCanvas.requestRenderAll();
    });
}

// ── HQ render (runs 220 ms after the last slider event) ──────────────────────
async function _hqRenderSliders(){

    if(!activeIndices.length) return;

    // Design-mode HQ: re-render every selected object at full quality
    if(selectedDesigns.size > 0){
        selectedDesigns.forEach(obj => {
            const d = obj._ownerData;
            if(!d || d.locked) return;
            const isMain      = obj === d.designObject;
            const extraIdx    = isMain ? -1 : (d.extraDesignObjects||[]).indexOf(obj);
            const srcOriginal = isMain
                ? d.designOriginal
                : (d.extraDesignOriginals?.[extraIdx] || d.designOriginal);
            if(!srcOriginal) return;
            // Pattern mode: route through applyWarpToData so warp hits the whole canvas
            if(isMain && d.patternMode && d.patternFabricObj){
                applyWarpToData(d, false);
                return;
            }
            _applyWarpToOneObject(obj, d, _cachedFlip(d, srcOriginal), false);
            d.fabricCanvas.requestRenderAll();
        });
        autoSaveSession();
        return;
    }

    // Window-mode HQ: render visible windows first, then yield between each
    // off-screen item so the browser stays responsive.
    const wrapperEl = i => canvasData[i]?.fabricCanvas?.lowerCanvasEl?.parentElement;
    const sorted = [...activeIndices].sort((a, b)=>{
        const av = isElementVisible(wrapperEl(a)) ? 0 : 1;
        const bv = isElementVisible(wrapperEl(b)) ? 0 : 1;
        return av - bv;
    });

    for(const index of sorted){

        const data = canvasData[index];

        if(data.designObject){

            await applyWarpToData(data, false);

            if(data.designObject){
                // In pattern mode, designObject stays invisible; patternFabricObj carries opacity/blend
                data.designObject.set({
                    opacity: data.patternMode ? 0 : (data.opacity ?? 1),
                    globalCompositeOperation: _blendToGCO(data.blendMode)
                });
            }

            data.fabricCanvas.requestRenderAll();

            // Yield between windows so the browser can paint and handle events
            await new Promise(r => setTimeout(r, 0));
        }
    }
}


warpAmount.addEventListener("input", updateFromSliders);
arcAmount.addEventListener("input", updateFromSliders);
arcTilt.addEventListener("input", updateFromSliders);
opacityAmount.addEventListener("input", updateFromSliders);
blurAmount.addEventListener("input", updateFromSliders);
noiseAmount.addEventListener("input", updateFromSliders);
blendMode.addEventListener("change", updateFromSliders);
perspectiveTop.addEventListener("input", updateFromSliders);
perspectiveLeft.addEventListener("input", updateFromSliders);

// Push one undo snapshot per slider drag gesture
[warpAmount, arcAmount, arcTilt, opacityAmount, blurAmount,
 noiseAmount, perspectiveTop, perspectiveLeft].forEach(el => {
    el.addEventListener('mousedown', () => {
        if(!_sliderUndoLocked){ _sliderUndoLocked = true; pushGlobalUndo(); }
    });
    el.addEventListener('mouseup', () => { _sliderUndoLocked = false; });
});
blendMode.addEventListener('mousedown', () => {
    if(!_sliderUndoLocked){ _sliderUndoLocked = true; pushGlobalUndo(); }
});
blendMode.addEventListener('change', () => { _sliderUndoLocked = false; });

// BG adjustment sliders — own undo lock so they don't collide with design sliders
var _bgAdjUndoLocked = false;
[bgHue, bgSaturation, bgBrightness, bgContrast].forEach(el => {
    el.addEventListener('mousedown', () => {
        if(!_bgAdjUndoLocked){ _bgAdjUndoLocked = true; pushGlobalUndo(); }
    });
    el.addEventListener('mouseup', () => { _bgAdjUndoLocked = false; });
    el.addEventListener('input', _updateBgAdjust);
    el.addEventListener('input', () => {
        activeIndices.forEach(i => { if(canvasData[i]) _recomputeProEffect(canvasData[i]); });
    });
});
document.getElementById('bgAdjustResetBtn').addEventListener('click', () => {
    if(!activeIndices.length) return;
    if(activeIndices.every(i => canvasData[i]?.locked)) return;
    pushGlobalUndo();
    bgHue.valueAsNumber = 0; bgSaturation.valueAsNumber = 0;
    bgBrightness.valueAsNumber = 0; bgContrast.valueAsNumber = 0;
    _updateBgAdjust();
    activeIndices.forEach(i => { if(!canvasData[i]?.locked) _recomputeProEffect(canvasData[i]); });
});

// BG crop sliders
var _bgCropUndoLocked = false;
[bgCropRotation, bgCropScale, bgCropX, bgCropY].forEach(el => {
    el.addEventListener('mousedown', () => {
        if(!_bgCropUndoLocked){ _bgCropUndoLocked = true; pushGlobalUndo(); }
    });
    el.addEventListener('mouseup', () => { _bgCropUndoLocked = false; });
    el.addEventListener('input', _updateBgCrop);
    el.addEventListener('input', () => {
        activeIndices.forEach(i => { if(canvasData[i]) _recomputeProEffect(canvasData[i]); });
    });
});

document.querySelectorAll('.bg-aspect-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        if(!activeIndices.length) return;
        if(activeIndices.every(i => canvasData[i]?.locked)) return;
        pushGlobalUndo();
        const aspect = parseFloat(btn.dataset.aspect);
        activeIndices.forEach(i => {
            const d = canvasData[i];
            if(d.locked) return;
            if(!d.bgCrop) d.bgCrop = { x:0, y:0, scale:1, rotation:0, aspect:0 };
            d.bgCrop.aspect = aspect;
            _applyBgAdjust(d);
            _updateCropOverlay(d);
            _syncProEffect(d);
        });
        document.querySelectorAll('.bg-aspect-btn').forEach(b => {
            b.classList.toggle('active', b === btn);
        });
        _markDirty();
        autoSaveSession();
    });
});

document.getElementById('bgCropCustomApply').addEventListener('click', () => {
    if(!activeIndices.length) return;
    if(activeIndices.every(i => canvasData[i]?.locked)) return;
    const wVal = parseFloat(document.getElementById('bgCropCustomW').value);
    const hVal = parseFloat(document.getElementById('bgCropCustomH').value);
    if(!wVal || !hVal || wVal <= 0 || hVal <= 0) return;
    pushGlobalUndo();
    const aspect = wVal / hVal;
    activeIndices.forEach(i => {
        const d = canvasData[i];
        if(d.locked) return;
        if(!d.bgCrop) d.bgCrop = { x:0, y:0, scale:1, rotation:0, aspect:0 };
        d.bgCrop.aspect = aspect;
        _applyBgAdjust(d);
        _updateCropOverlay(d);
        _syncProEffect(d);
    });
    document.querySelectorAll('.bg-aspect-btn').forEach(b => b.classList.remove('active'));
    _markDirty();
    autoSaveSession();
});

document.getElementById('bgCropResetBtn').addEventListener('click', () => {
    if(!activeIndices.length) return;
    if(activeIndices.every(i => canvasData[i]?.locked)) return;
    pushGlobalUndo();
    bgCropRotation.valueAsNumber = 0;
    bgCropScale.valueAsNumber    = 100;
    bgCropX.valueAsNumber        = 0;
    bgCropY.valueAsNumber        = 0;
    activeIndices.forEach(i => {
        const d = canvasData[i];
        if(d.locked) return;
        d.bgCrop = { x:0, y:0, scale:1, rotation:0, aspect:0 };
        _applyBgAdjust(d);
        _updateCropOverlay(d);
        _recomputeProEffect(d);
        // Restore design positions captured when Attach Design was checked
        if(d._attachDesignSnapshot) {
            d._attachDesignSnapshot.forEach(snap => {
                snap.ref.set({
                    left: snap.left, top: snap.top,
                    scaleX: snap.scaleX, scaleY: snap.scaleY,
                    angle: snap.angle,
                });
                snap.ref.setCoords();
            });
            d._attachDesignSnapshot = null;
            if(d.patternMode) _renderPattern(d, false);
            d.fabricCanvas.requestRenderAll();
        }
    });
    // Uncheck the Attach Design checkbox and clear its internal state
    const attachChk = document.getElementById('bgCropAttachDesign');
    if(attachChk && attachChk.checked) {
        attachChk.checked = false;
        attachChk.dispatchEvent(new Event('change'));
    }
    document.querySelectorAll('.bg-aspect-btn').forEach(b => {
        b.classList.toggle('active', parseFloat(b.dataset.aspect) === 0);
    });
    document.getElementById('bgCropRotationVal').textContent = '0';
    document.getElementById('bgCropScaleVal').textContent    = '100';
    document.getElementById('bgCropXVal').textContent        = '0';
    document.getElementById('bgCropYVal').textContent        = '0';
    document.getElementById('bgCropCustomW').value = '';
    document.getElementById('bgCropCustomH').value = '';
    document.querySelectorAll('.bg-aspect-btn').forEach(b => b.classList.remove('active'));
    _markDirty();
    autoSaveSession();
});

// ── Pattern mode toggle ────────────────────────────────────────────────────────
document.getElementById('patternModeToggle').addEventListener('change', e => {
    if(!activeIndices.length) return;
    pushGlobalUndo();
    const on = e.target.checked;
    document.getElementById('patternControls').style.display = on ? 'block' : 'none';
    activeIndices.forEach(i => {
        const d = canvasData[i];
        if(d.locked) return;
        if(!d.patternSettings) d.patternSettings = _defaultPattern();
        _togglePatternMode(d, on);
        _syncProEffect(d);
    });
    _markDirty();
    autoSaveSession();
});

// ── Pattern type buttons ───────────────────────────────────────────────────────
document.querySelectorAll('.pattern-type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        if(!activeIndices.length) return;
        const type = btn.dataset.type;
        document.querySelectorAll('.pattern-type-btn').forEach(b => b.classList.toggle('active', b === btn));
        pushGlobalUndo();
        activeIndices.forEach(i => {
            const d = canvasData[i];
            if(d.locked) return;
            if(!d.patternSettings) d.patternSettings = _defaultPattern();
            d.patternSettings.type = type;
            if(d.patternMode) _renderPattern(d);
        });
        _markDirty();
        autoSaveSession();
    });
});

// ── Pattern sliders ────────────────────────────────────────────────────────────
document.getElementById('resetPatternBtn').addEventListener('click', () => {
    if(!activeIndices.length) return;
    pushGlobalUndo();
    activeIndices.forEach(i => {
        const d = canvasData[i];
        if(!d || d.locked) return;
        d.patternSettings = _defaultPattern();
        if(d.patternMode || d.patternFabricObj) _togglePatternMode(d, false);
        _recomputeProEffect(d);
    });
    // Sync UI — turn off toggle and hide controls
    document.getElementById('patternModeToggle').checked = false;
    document.getElementById('patternControls').style.display = 'none';
    document.querySelectorAll('.pattern-type-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.type === 'grid'));
    _patternSliderDefs.forEach(([id]) => {
        document.getElementById(id).valueAsNumber = 0;
        document.getElementById(id + 'Val').value = 0;
    });
    _markDirty();
    autoSaveSession();
});

// ── Bake Pattern Sheet ────────────────────────────────────────────────────────
// Flattens the live tiled pattern into a full-canvas PNG, exits pattern mode,
// and installs the result as the window's designOriginal so all subsequent
// tools (warp, arc, clip, erase, duplicate, copy) work on the flat sheet.

function _bakePatternSheet(data) {
    if (!data || !data.patternMode || !data.patternFabricObj) return;

    const fc  = data.fabricCanvas;
    const W   = fc.getWidth();
    const H   = fc.getHeight();
    const dpr = Math.max(1, fc.lowerCanvasEl.width / W);

    // Push undo BEFORE mutating — reuse the warp undo type which snapshots both
    // the window state and designOriginal so Undo can restore them together.
    const affIdx = canvasData.indexOf(data);
    if (affIdx !== -1) {
        globalUndoStack.push({
            type: 'warp',
            items: [{ idx: affIdx, state: captureWindowState(data), original: data.designOriginal }]
        });
        if (globalUndoStack.length > MAX_UNDO_HISTORY) globalUndoStack.shift();
        globalRedoStack = [];
        updateUndoRedoButtons();
    }

    // Capture the currently rendered pattern at the physical (DPR) resolution.
    const pEl = data.patternFabricObj.getElement();
    const bakedCanvas = document.createElement('canvas');
    bakedCanvas.width  = W * dpr;
    bakedCanvas.height = H * dpr;
    const ctx = bakedCanvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(pEl, 0, 0, W * dpr, H * dpr);

    // Exit pattern mode — removes patternFabricObj, restores designObject opacity.
    _togglePatternMode(data, false);

    // Install the baked canvas as the new design source.
    data.designOriginal = bakedCanvas;
    data.warpCanvas     = null;  // invalidate any cached warp canvas

    // Centre the flat sheet and size it to fill the canvas exactly.
    // applyWarpToData multiplies by previewScale, so we pre-divide to cancel it out.
    // Effective Fabric scale = (1/dpr / ps) * ps = 1/dpr → fills canvas exactly.
    const ps = data.previewScale || 1;
    data.x          = W / 2;
    data.y          = H / 2;
    data.scaleX     = (1 / dpr) / ps * 0.9;
    data.scaleY     = (1 / dpr) / ps * 0.9;
    data.rotation   = 0;
    data.warpAmount = 0;
    data.arcAmount  = 0;
    data.arcTilt    = 0;
    data.perspectiveTop  = 0;
    data.perspectiveLeft = 0;

    applyWarpToData(data, false);

    syncSliders();
    _syncPatternDisplay();
    refreshFabricHandles();
    updateWindowBorders();
    _markDirty();
    autoSaveSession();
}

// ── Copy Design to Selected Windows ──────────────────────────────────────────
// Takes the primary active window's designOriginal (the baked sheet or any
// other design) and loads it into every OTHER currently selected window,
// scaled to fill each target canvas.

function _copyDesignToSelected(sourceData) {
    if (!sourceData?.designOriginal) return;

    // Normalise the source to a canvas element so we can rescale it per target.
    let srcEl = sourceData.designOriginal;
    if (!(srcEl instanceof HTMLCanvasElement)) {
        const tmp = document.createElement('canvas');
        tmp.width  = srcEl.naturalWidth  || srcEl.width  || 1;
        tmp.height = srcEl.naturalHeight || srcEl.height || 1;
        tmp.getContext('2d').drawImage(srcEl, 0, 0);
        srcEl = tmp;
    }

    const srcIdx  = canvasData.indexOf(sourceData);
    const targets = activeIndices
        .filter(i => i !== srcIdx)
        .map(i => canvasData[i])
        .filter(d => d && !d.locked);

    if (!targets.length) {
        alert('Select one or more additional windows to receive the design.');
        return;
    }

    // Snapshot every target for undo before touching anything.
    const undoItems = targets
        .map(d => ({ idx: canvasData.indexOf(d), state: captureWindowState(d), original: d.designOriginal }))
        .filter(item => item.idx !== -1);
    if (undoItems.length) {
        globalUndoStack.push({ type: 'warp', items: undoItems });
        if (globalUndoStack.length > MAX_UNDO_HISTORY) globalUndoStack.shift();
        globalRedoStack = [];
        updateUndoRedoButtons();
    }

    targets.forEach(d => {
        // Turn off pattern mode in the target if active.
        if (d.patternMode || d.patternFabricObj) _togglePatternMode(d, false);

        const fc     = d.fabricCanvas;
        const W      = fc.getWidth();
        const H      = fc.getHeight();
        const dpr    = Math.max(1, fc.lowerCanvasEl.width / W);
        const physW  = W * dpr;
        const physH  = H * dpr;

        // Rescale the source canvas to exactly fill the target at physical resolution.
        const copy = document.createElement('canvas');
        copy.width  = physW;
        copy.height = physH;
        const cCtx  = copy.getContext('2d');
        cCtx.imageSmoothingEnabled = true;
        cCtx.imageSmoothingQuality = 'high';
        cCtx.drawImage(srcEl, 0, 0, physW, physH);

        const tps = d.previewScale || 1;
        d.designOriginal = copy;
        d.warpCanvas     = null;
        d.x          = W / 2;
        d.y          = H / 2;
        d.scaleX     = (1 / dpr) / tps;
        d.scaleY     = (1 / dpr) / tps;
        d.rotation   = 0;
        d.warpAmount = 0;
        d.arcAmount  = 0;
        d.arcTilt    = 0;
        d.perspectiveTop  = 0;
        d.perspectiveLeft = 0;

        applyWarpToData(d, false);
    });

    syncSliders();
    _markDirty();
}

document.getElementById('bakePatternBtn').addEventListener('click', () => {
    if (!activeIndices.length) return;
    const data = canvasData[activeIndices[0]];
    if (!data || data.locked) return;
    _bakePatternSheet(data);
});

var _patternSliderDefs = [
    ['patternHSpacing','hSpacing'],
    ['patternVSpacing','vSpacing'],
    ['patternAngle',   'angle'],
    ['patternHOffset', 'hOffset'],
    ['patternRotH',    'rotH'],
    ['patternRotV',    'rotV'],
];
var _patternUndoLocked = false;
_patternSliderDefs.forEach(([id, key]) => {
    const el = document.getElementById(id);
    const valEl = document.getElementById(id + 'Val');
    el.addEventListener('mousedown', () => {
        if(!_patternUndoLocked){ _patternUndoLocked = true; pushGlobalUndo(); }
    });
    el.addEventListener('mouseup', () => { _patternUndoLocked = false; });
    el.addEventListener('input', () => {
        const v = parseFloat(el.value);
        if(valEl) valEl.value = v;
        activeIndices.forEach(i => {
            const d = canvasData[i];
            if(d.locked) return;
            if(!d.patternSettings) d.patternSettings = _defaultPattern();
            d.patternSettings[key] = v;
            if(d.patternMode) _renderPattern(d);
        });
        _markDirty();
        autoSaveSession();
    });
    if(valEl){
        valEl.addEventListener('change', () => {
            const minV = parseFloat(el.min), maxV = parseFloat(el.max);
            const v = Math.max(minV, Math.min(maxV, parseFloat(valEl.value) || 0));
            valEl.value = v;
            el.value = v;
            pushGlobalUndo();
            activeIndices.forEach(i => {
                const d = canvasData[i];
                if(d.locked) return;
                if(!d.patternSettings) d.patternSettings = _defaultPattern();
                d.patternSettings[key] = v;
                if(d.patternMode) _renderPattern(d);
            });
            _markDirty();
            autoSaveSession();
        });
    }
});


function handleBgFiles(files){

    if(!files.length) return;

    _showUpgradePromptIfNeeded();

    // pre-allocate so images always appear in selection order
    backgrounds = new Array(files.length);

    let loaded = 0;

    files.forEach((file, i)=>{

        const reader = new FileReader();

        reader.onload = function(e){

            const img = new Image();

            img.onload = function(){

                backgrounds[i] = {
                    img: img,
                    name: file.name
                };

                loaded++;

                // render ONCE after all images loaded
                if(loaded === files.length){
                    // Sort alphabetically so order is deterministic regardless
                    // of which FileReader.onload callback fires first.
                    backgrounds.sort((a, b) => a.name.localeCompare(b.name));
                    createCanvasPreviews();
                }
            };

            img.src = e.target.result;
        };

        reader.readAsDataURL(file);
    });
}

document.getElementById('bgUpload').addEventListener('change', function(event){

    if(clipEditMode){
        showClipModeNotice();
        return;
    }

    handleBgFiles(Array.from(event.target.files));
});


async function handleDesignFiles(files){

    if(!files.length) return;

    _showUpgradePromptIfNeeded();

    designs = [];

    const loadingIndicator =
        document.getElementById("loadingIndicator");

    loadingIndicator.style.display = "block";
    loadingIndicator.innerText = "Preparing designs...";

    for(let i=0; i<files.length; i++){

        const file = files[i];

        loadingIndicator.innerText =
            `Processing designs... ${i + 1} / ${files.length}`;

        await new Promise(resolve=>{

            const reader = new FileReader();

            reader.onload = function(e){

                const img = new Image();

                img.onload = async function(){

                    let finalImg = img;

                    // skip expensive trimming for JPG/JPEG
                    const isJpg =
                        file.type === "image/jpeg" ||
                        file.type === "image/jpg";

                    if(!isJpg){

                        await new Promise(r=>requestAnimationFrame(r));

                        finalImg = trimTransparentPixels(img);
                    }

                    const finalize = ()=>{

                        designs.push({
                            img: finalImg,
                            name: file.name
                        });

                        resolve();
                    };

                    if(finalImg.complete){
                        finalize();
                    } else {
                        finalImg.onload = finalize;
                    }
                };

                img.src = e.target.result;
            };

            reader.readAsDataURL(file);
        });

        // yield back to browser every file
        await new Promise(r=>requestAnimationFrame(r));
    }

    loadingIndicator.innerText = "Loading previews...";

    // Sort alphabetically so order is deterministic regardless of async load order.
    designs.sort((a, b) => a.name.localeCompare(b.name));

    createCanvasPreviews();
}

document.getElementById('designUpload').addEventListener('change', async function(event){

    if(clipEditMode){
        showClipModeNotice();
        return;
    }

    await handleDesignFiles(Array.from(event.target.files));
});


function updateDropUI(){

    const dropZone     = document.getElementById('dropZone');
    const designPrompt = document.getElementById('designPrompt');
    if(backgrounds.length === 0){
        dropZone.style.display     = 'flex';
        designPrompt.style.display = 'none';
    } else if(designs.length === 0){
        dropZone.style.display     = 'none';
        designPrompt.style.display = 'flex';
    } else {
        dropZone.style.display     = 'none';
        designPrompt.style.display = 'none';
    }

    const bgBtn = document.getElementById('bgUploadBtn');
    const dsBtn = document.getElementById('designUploadBtn');
    bgBtn.textContent = backgrounds.length > 0
        ? `Upload Backgrounds (${backgrounds.length})`
        : 'Upload Backgrounds';
    dsBtn.textContent = designs.length > 0
        ? `Upload Designs (${designs.length})`
        : 'Upload Designs';

    // Auto-expand sidebar when designs are first loaded
    if (designs.length > 0 && !document.body.classList.contains('sidebar-expanded')) {
        if (window.setSidebarExpanded) {
            window.setSidebarExpanded(true);
        } else {
            document.body.classList.add('sidebar-expanded');
            const tb = document.getElementById('sidebarToggleBtn');
            if (tb) { tb.textContent = '◀'; tb.title = 'Collapse panel'; }
        }
    }
}

document.getElementById('bgUploadBtn').addEventListener('click', () => {
    document.getElementById('bgUpload').click();
});

document.getElementById('designUploadBtn').addEventListener('click', () => {
    document.getElementById('designUpload').click();
});

// Drop zone — background drag-and-drop
(function(){
    const dropZone = document.getElementById('dropZone');

    dropZone.addEventListener('dragenter', function(e){
        e.preventDefault();
        dropZone.classList.add('dz-hover');
    });

    dropZone.addEventListener('dragover', function(e){
        e.preventDefault();
        dropZone.classList.add('dz-hover');
    });

    dropZone.addEventListener('dragleave', function(e){
        if(!dropZone.contains(e.relatedTarget)){
            dropZone.classList.remove('dz-hover');
        }
    });

    dropZone.addEventListener('drop', function(e){
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.remove('dz-hover');
        dropZone.style.display = 'none';
        if(clipEditMode){ showClipModeNotice(); return; }
        const files = Array.from(e.dataTransfer.files)
            .filter(f => f.type === 'image/png' || f.type === 'image/jpeg');
        handleBgFiles(files);
    });
})();

// Design prompt — click or drag designs
(function(){
    const prompt = document.getElementById('designPrompt');
    const btn    = document.getElementById('designPromptBtn');

    btn.addEventListener('click', function(){
        document.getElementById('designUpload').click();
    });

    prompt.addEventListener('dragenter', function(e){
        e.preventDefault();
        prompt.classList.add('dz-hover');
    });

    prompt.addEventListener('dragover', function(e){
        e.preventDefault();
        prompt.classList.add('dz-hover');
    });

    prompt.addEventListener('dragleave', function(e){
        if(!prompt.contains(e.relatedTarget)){
            prompt.classList.remove('dz-hover');
        }
    });

    prompt.addEventListener('drop', async function(e){
        e.preventDefault();
        e.stopPropagation();
        prompt.classList.remove('dz-hover');
        if(clipEditMode){ showClipModeNotice(); return; }
        const files = Array.from(e.dataTransfer.files)
            .filter(f => f.type === 'image/png' || f.type === 'image/jpeg');
        await handleDesignFiles(files);
    });
})();

// Show drop zone on startup (no backgrounds loaded yet)
updateDropUI();


// Document-level drag intercept — prevents the browser from navigating to/opening
// dropped files, and routes design drops onto the canvas area when backgrounds exist.
(function(){
    let dragDepth = 0;
    const container = document.getElementById('canvasContainer');

    document.addEventListener('dragenter', function(e){
        e.preventDefault();
        dragDepth++;
        if(backgrounds.length > 0){
            container.classList.add('dz-designs-hover');
        }
    });

    document.addEventListener('dragover', function(e){
        e.preventDefault();
    });

    document.addEventListener('dragleave', function(e){
        dragDepth--;
        if(dragDepth <= 0){
            dragDepth = 0;
            container.classList.remove('dz-designs-hover');
        }
    });

    document.addEventListener('drop', async function(e){
        e.preventDefault();
        dragDepth = 0;
        container.classList.remove('dz-designs-hover');

        if(backgrounds.length === 0) return;  // let the #dropZone handler take it

        if(clipEditMode){ showClipModeNotice(); return; }

        const files = Array.from(e.dataTransfer.files)
            .filter(f => f.type === 'image/png' || f.type === 'image/jpeg');

        if(files.length) await handleDesignFiles(files);
    });
})();


function createCanvasData(bgObj, designObj){

    return {
        bg: bgObj.img,
        bgName: bgObj.name,
        designOriginal: designObj ? designObj.img : null,
        initialDesignOriginal: designObj ? designObj.img : null,
        designName: designObj ? designObj.name : null,
        notes: '',

        x: 50,
        y: 50,
        // Default preview size = ~50% of mockup window
        scale: designObj
            ? Math.min(
                (bgObj.img.width * 0.5) / designObj.img.width,
                (bgObj.img.height * 0.5) / designObj.img.height
            )
            : 1,

        rotation: 0,
        scaleX: null,
        scaleY: null,
        warpAmount: 0,
        arcAmount: 0,
        arcTilt: 0,
        opacity: 1,
        blurAmount: 0,
        noiseAmount: 0,
        blendMode: "normal",
        perspectiveTop: 0,
        perspectiveLeft: 0,

        bgAdjust: { hue: 0, saturation: 0, brightness: 0, contrast: 0 },
        bgCrop:   { x: 0, y: 0, scale: 1, rotation: 0, aspect: 0 },

        hasProEffect: false,
        forceProBadge: false,
        meshWarpApplied: false,
        invertedMain: false,
        invertedExtras: [],

        // future masking support
        maskPaths:
            backgroundMaskTemplates[bgObj.name]?.maskPaths
                ?.map(path => path.map(p => ({...p}))) || [],

        maskPath:
            backgroundMaskTemplates[bgObj.name]?.maskPath
                ?.map(p => ({...p})) || null,

        maskEnabled:
            backgroundMaskTemplates[bgObj.name]?.maskEnabled || false,

        maskType:
            backgroundMaskTemplates[bgObj.name]?.maskType || null,

        extraDesignObjects: [],

        filename: designObj
            ? `${designObj.name.replace(/\.[^/.]+$/, "")}_${bgObj.name.replace(/\.[^/.]+$/, "")}`
            : bgObj.name.replace(/\.[^/.]+$/, ""),

        // initial reset state
        initialScale: designObj
            ? Math.min(
                (bgObj.img.width * 0.5) / designObj.img.width,
                (bgObj.img.height * 0.5) / designObj.img.height
            )
            : 1,

        initialRotation: 0,
        initialWarpAmount: 0,
        initialArcAmount: 0,
        initialArcTilt: 0,
        initialOpacity: 1,
        initialBlurAmount: 0,
        initialNoiseAmount: 0,
        initialBlendMode: "normal",
        initialBlendIntensity: 100,
        initialPerspectiveTop: 0,
        initialPerspectiveLeft: 0,
    };
}


function createCanvasPreviews(){

    // preserve clipping masks across re-renders
    const existingMasks = {};

    canvasData.forEach(item=>{
        if(item.maskEnabled && item.maskPaths?.length){

            existingMasks[item.bgName] = {

                maskEnabled: true,
                maskType: item.maskType,

                maskPaths: item.maskPaths.map(path=>
                    path.map(p=>({
                        x: p.x,
                        y: p.y,
                        cx: p.cx,
                        cy: p.cy
                    }))
                ),

                maskPath:
                    item.maskPaths[
                        item.maskPaths.length - 1
                    ]
            };
        }
    });

    backgroundMaskTemplates = {
        ...backgroundMaskTemplates,
        ...existingMasks
    };

    const container = document.getElementById("canvasContainer");
    const loadingIndicator = document.getElementById("loadingIndicator");

    container.innerHTML = "";
    canvasData = [];

    if(!backgrounds.length){ updateDropUI(); return; }

    if(!designs.length){

        backgrounds.forEach(bg=>{
            canvasData.push(createCanvasData(bg, null));
        });

    } else {

        designs.forEach(design=>{
            backgrounds.forEach(bg=>{
                canvasData.push(createCanvasData(bg, design));
            });
        });
    }

    const totalItems = canvasData.length;
    let currentIndex = 0;

    loadingIndicator.style.display = "block";

    function renderBatch(){

        const batchSize = 4;

        const end =
            Math.min(currentIndex + batchSize, totalItems);

        for(let index=currentIndex; index<end; index++){

            const data = canvasData[index];

            loadingIndicator.innerText =
                `Preparing designs... ${index + 1} / ${totalItems}`;

            const wrapper = document.createElement("div");
            wrapper.className = "canvas-wrapper";
            data.wrapperEl = wrapper;
            _visibilityObserver.observe(wrapper);

            const canvasEl = document.createElement("canvas");
            canvasEl.width = data.bg.width;
            canvasEl.height = data.bg.height;

            wrapper.appendChild(canvasEl);

            const filenameInput = document.createElement("input");

            filenameInput.type = "text";
            filenameInput.value = data.filename;
            filenameInput.className = "filename-input";

            filenameInput.addEventListener("input", (e)=>{
                data.filename = e.target.value;
            });

            wrapper.appendChild(filenameInput);

            const cell = document.createElement("div");
            cell.className = "window-cell";
            cell.appendChild(wrapper);
            data.cellEl = cell;
            _addDragHandle(wrapper, cell);
            container.appendChild(cell);

            const fabricCanvas = new fabric.Canvas(canvasEl, {
                preserveObjectStacking: true,
                selection: false,
                renderOnAddRemove: false
            });

            data.fabricCanvas = fabricCanvas;
            _setFabricHighQualitySmoothing(fabricCanvas);

            const realWidth = data.bg.width;
            const realHeight = data.bg.height;

            const targetColumnWidth = 300;

            // Render at 1.5× the column display width so CSS zoom up to 1.5×
            // stays crisp without significant extra memory cost.
            const scaleRatio =
                Math.min(1, (targetColumnWidth * 1.5) / realWidth);

            const previewWidth  = Math.round(realWidth  * scaleRatio);
            const previewHeight = Math.round(realHeight * scaleRatio);

            fabricCanvas.setWidth(previewWidth);
            fabricCanvas.setHeight(previewHeight);

            // Shrink Fabric's internal .canvas-container to the CSS display size.
            // The canvas elements inside keep their oversampled DOM pixel count
            // (previewWidth × DPR), so the browser downscales those extra pixels
            // onto fewer CSS pixels — crisp rather than upscaled-blurry.
            const displayW = Math.round(targetColumnWidth);
            const displayH = Math.round(previewHeight * targetColumnWidth / previewWidth);
            fabricCanvas.wrapperEl.style.width  = displayW + 'px';
            fabricCanvas.wrapperEl.style.height = displayH + 'px';
            wrapper.style.width = displayW + 'px';

            data.previewScale = scaleRatio;

            data.x = previewWidth / 2;
            data.y = previewHeight / 2;

            data.initialX = data.x;
            data.initialY = data.y;

            _syncFabricDisplaySize(data, targetColumnWidth);
            _attachWrapperClickListener(wrapper, data);
            _attachWindowCanvasSelection(data);

            fabric.Image.fromURL(data.bg.src, function(bgImg){

                bgImg.set({
                    left: 0,
                    top: 0,
                    selectable: false,
                    evented: false,
                    originX: 'left',
                    originY: 'top',
                    scaleX: data.previewScale,
                    scaleY: data.previewScale
                });

                data.backgroundObject = bgImg;
                _applyBgAdjust(data);
                _updateCropOverlay(data);

                fabricCanvas.add(bgImg);
                fabricCanvas.sendToBack(bgImg);

                // restore clipping overlay if mask exists
                addClipOverlay(data);

                if(data.designOriginal){

                    // low-quality fast first render
                    applyWarpToData(data, true);

                    // upgrade to HQ after UI becomes responsive
                    setTimeout(()=>{
                        applyWarpToData(data, false);
                    }, 50);
                }

                fabricCanvas.requestRenderAll();

            }, { crossOrigin: 'anonymous' });

            attachClipDrawing(
                wrapper,
                fabricCanvas,
                data,
                index
            );
        }

        currentIndex = end;

        if(currentIndex < totalItems){

            requestAnimationFrame(renderBatch);

        } else {

            loadingIndicator.innerText = "Finished loading previews";

            setTimeout(()=>{
                loadingIndicator.style.display = "none";
                updateDropUI();
                _scheduleMinimapUpdate();
                _markDirty();
            }, 800);
        }
    }

    requestAnimationFrame(renderBatch);
}



function attachFabricEvents(data, targetObject = null){

    const designTarget = targetObject || data.designObject;

    if(!designTarget) return;

    // Is this the main window design or an extra/overlay layer?
    const isMainDesign = (designTarget === data.designObject);

    // Tag this object with its owning window data for cross-window effect lookups
    designTarget._ownerData = data;

    // Canvas-level handlers (background select, eraser, warp overlay) live in
    // _attachWindowCanvasSelection(), registered when each Fabric canvas is created.

    designTarget.on('moving', ()=>{
        designTarget._hadDragMovement = true;

        const deltaX = designTarget.left - (designTarget.lastLeft || designTarget.left);
        const deltaY = designTarget.top  - (designTarget.lastTop  || designTarget.top);

        if (_canCrossWindowSync()) {
            _syncAttachedLayersInDriverWindow(data, designTarget);
            _applyCrossWindowGeometrySync(designTarget, data);
            designTarget.lastLeft = designTarget.left;
            designTarget.lastTop  = designTarget.top;
            data.fabricCanvas.requestRenderAll();
            return;
        }

        if(isMainDesign){

            // Same-window: only move extra design layers that are also selected.
            // The color layer always travels with the main design (it's an overlay,
            // not an independently-selectable layer the user picks separately).
            getAllDesignObjects(data).forEach(obj=>{
                if(obj === designTarget) return;
                if((data.extraDesignObjects||[]).includes(obj) && !selectedDesigns.has(obj)) return;
                obj.left += deltaX;
                obj.top  += deltaY;
            });

            activeIndices.forEach(index=>{

                if(canvasData[index] === data) return;
                if(canvasData[index].locked) return;

                const target = canvasData[index];

                getAllDesignObjects(target).forEach(obj=>{
                    // Mirror same-window selection filter: only move an extra layer in
                    // the peer window if its same-index counterpart is selected in the source.
                    if((target.extraDesignObjects||[]).includes(obj)){
                        const idx     = (target.extraDesignObjects||[]).indexOf(obj);
                        const srcPeer = (data.extraDesignObjects||[])[idx];
                        if(srcPeer && !selectedDesigns.has(srcPeer)) return;
                    }
                    obj.left += deltaX;
                    obj.top  += deltaY;
                });

                if(target.patternMode) _renderPattern(target, true);
                target.fabricCanvas.requestRenderAll();
            });

        } else {

            // Extra layer: move other selected objects in the SAME window first,
            // then sync same-index peers in other selected windows.
            const layerIdx = (data.extraDesignObjects || []).indexOf(designTarget);

            selectedDesigns.forEach(obj => {
                if(obj === designTarget) return;
                if(obj._ownerData !== data) return; // only same-window peers
                obj.left += deltaX;
                obj.top  += deltaY;
                obj.setCoords();
            });

            activeIndices.forEach(index=>{

                if(canvasData[index] === data) return;
                if(canvasData[index].locked) return;

                const peer = (canvasData[index].extraDesignObjects || [])[layerIdx];

                if(peer){
                    peer.left += deltaX;
                    peer.top  += deltaY;
                    peer.setCoords();
                }

                // Always render — no visibility gate. The peer positions accumulate
                // correctly in memory but won't show until re-rendered; gating on
                // isElementVisible caused the "jumps on click" symptom.
                canvasData[index].fabricCanvas.requestRenderAll();
            });
        }

        designTarget.lastLeft = designTarget.left;
        designTarget.lastTop  = designTarget.top;

        data.fabricCanvas.requestRenderAll();
    });

    designTarget.on('mousedown', ()=>{

        suppressNextWrapperClick = true;
        designTarget.lastLeft = designTarget.left;
        designTarget.lastTop  = designTarget.top;
        designTarget._hadDragMovement = false;
        // Capture pre-gesture state for all active windows.
        // We don't push to the undo stack yet — we wait to see if the user
        // actually moves/scales/rotates.  If they just click without moving,
        // no undo slot is consumed (mouseup discards _preDragUndoEntry).
        designTarget._preDragUndoEntry = {
            affected: [...activeIndices],
            states:   activeIndices.map(i => captureWindowState(canvasData[i]))
        };
    });

    designTarget.on('mouseup', ()=>{
        if(designTarget._hadDragMovement && designTarget._preDragUndoEntry){
            globalUndoStack.push(designTarget._preDragUndoEntry);
            if(globalUndoStack.length > MAX_UNDO_HISTORY) globalUndoStack.shift();
            globalRedoStack = [];
            updateUndoRedoButtons();
            _markDirty();
        }
        designTarget._preDragUndoEntry  = null;
        designTarget._hadDragMovement   = false;
    });

    designTarget.on('scaling', ()=>{
        designTarget._hadDragMovement = true;

        const scaleX = designTarget.scaleX;
        const scaleY = designTarget.scaleY;
        const skewX  = designTarget.skewX || 0;
        const skewY  = designTarget.skewY || 0;
        const left   = designTarget.left;
        const top    = designTarget.top;

        // Compute delta so cross-window peers move relative to their own position
        // (avoids "jump" where other windows' designs teleport to this window's coords).
        const deltaX = left - (designTarget.lastLeft || left);
        const deltaY = top  - (designTarget.lastTop  || top);

        if (_canCrossWindowSync()) {
            _syncAttachedLayersInDriverWindow(data, designTarget);
            _applyCrossWindowGeometrySync(designTarget, data);
            designTarget.lastLeft = left;
            designTarget.lastTop  = top;
            data.fabricCanvas.requestRenderAll();
            return;
        }

        if(isMainDesign){

            // Same-window: set absolute — all layers share one coordinate space.
            // Extra design layers only scale/move if they're also selected.
            getAllDesignObjects(data).forEach(obj=>{
                if(obj === designTarget) return;
                if((data.extraDesignObjects||[]).includes(obj) && !selectedDesigns.has(obj)) return;
                obj.scaleX = scaleX;
                obj.scaleY = scaleY;
                obj.skewX  = skewX;
                obj.skewY  = skewY;
                obj.left   = left;
                obj.top    = top;
                obj.setCoords();
            });

            // Cross-window: apply delta so remote designs don't jump.
            activeIndices.forEach(index=>{

                if(canvasData[index] === data) return;
                if(canvasData[index].locked) return;

                const target = canvasData[index];

                getAllDesignObjects(target).forEach(obj=>{
                    if((target.extraDesignObjects||[]).includes(obj)){
                        const idx     = (target.extraDesignObjects||[]).indexOf(obj);
                        const srcPeer = (data.extraDesignObjects||[])[idx];
                        if(srcPeer && !selectedDesigns.has(srcPeer)) return;
                    }
                    obj.scaleX  = scaleX;
                    obj.scaleY  = scaleY;
                    obj.skewX   = skewX;
                    obj.skewY   = skewY;
                    obj.left   += deltaX;
                    obj.top    += deltaY;
                    obj.setCoords();
                });

                if(target.patternMode) _renderPattern(target, true);
                target.fabricCanvas.requestRenderAll();
            });

        } else {

            const layerIdx = (data.extraDesignObjects || []).indexOf(designTarget);

            // Scale other selected objects in the SAME window first
            selectedDesigns.forEach(obj => {
                if(obj === designTarget) return;
                if(obj._ownerData !== data) return;
                obj.scaleX  = scaleX;
                obj.scaleY  = scaleY;
                obj.skewX   = skewX;
                obj.skewY   = skewY;
                obj.left   += deltaX;
                obj.top    += deltaY;
                obj.setCoords();
            });

            activeIndices.forEach(index=>{

                if(canvasData[index] === data) return;
                if(canvasData[index].locked) return;

                const peer = (canvasData[index].extraDesignObjects || [])[layerIdx];

                if(peer){
                    peer.scaleX  = scaleX;
                    peer.scaleY  = scaleY;
                    peer.skewX   = skewX;
                    peer.skewY   = skewY;
                    peer.left   += deltaX;
                    peer.top    += deltaY;
                    peer.setCoords();
                }

                canvasData[index].fabricCanvas.requestRenderAll();
            });
        }

        designTarget.lastLeft = left;
        designTarget.lastTop  = top;

        data.fabricCanvas.requestRenderAll();
    });

    designTarget.on('rotating', ()=>{
        designTarget._hadDragMovement = true;

        const angle = designTarget.angle;

        if (_canCrossWindowSync()) {
            _syncAttachedLayersInDriverWindow(data, designTarget);
            _applyCrossWindowGeometrySync(designTarget, data);
            data.fabricCanvas.requestRenderAll();
            return;
        }

        if(isMainDesign){

            // Same-window: extra layers only rotate if they're also selected.
            getAllDesignObjects(data).forEach(obj=>{
                if((data.extraDesignObjects||[]).includes(obj) && !selectedDesigns.has(obj)) return;
                obj.angle = angle;
                obj.setCoords();
            });

            activeIndices.forEach(index=>{

                if(canvasData[index] === data) return;
                if(canvasData[index].locked) return;

                const target = canvasData[index];

                getAllDesignObjects(target).forEach(obj=>{
                    if((target.extraDesignObjects||[]).includes(obj)){
                        const idx     = (target.extraDesignObjects||[]).indexOf(obj);
                        const srcPeer = (data.extraDesignObjects||[])[idx];
                        if(srcPeer && !selectedDesigns.has(srcPeer)) return;
                    }
                    obj.angle = angle;
                    obj.setCoords();
                });

                if(target.patternMode) _renderPattern(target, true);
                target.fabricCanvas.requestRenderAll();
            });

        } else {

            const layerIdx = (data.extraDesignObjects || []).indexOf(designTarget);

            // Rotate other selected objects in the SAME window first
            selectedDesigns.forEach(obj => {
                if(obj === designTarget) return;
                if(obj._ownerData !== data) return;
                obj.angle = angle;
                obj.setCoords();
            });

            activeIndices.forEach(index=>{

                if(canvasData[index] === data) return;
                if(canvasData[index].locked) return;

                const peer = (canvasData[index].extraDesignObjects || [])[layerIdx];

                if(peer){
                    peer.angle = angle;
                    peer.setCoords();
                }

                canvasData[index].fabricCanvas.requestRenderAll();
            });
        }

        data.fabricCanvas.requestRenderAll();
    });

    // persist position/scale/rotation changes that don't go through applyWarpToData
    designTarget.on('mouseup', ()=>{
        _persistSelectedLayerDataForActiveWindows();
        autoSaveSession();
    });
}


var allSelected = false;

function updateSelectButtonState(){

    const btn = document.getElementById("selectAllBtn");

    if(activeIndices.length > 0){
        btn.innerText = "Unselect All";
        allSelected = true;
    } else {
        btn.innerText = "Select All";
        allSelected = false;
    }
}

function refreshNotesPanel(){
    const body  = document.getElementById('notesDrawerBody');
    const title = document.getElementById('notesDrawerTitle');
    if(!body || !title) return;

    const count = activeIndices.length;

    if(count === 1){
        _notesShowSingle(activeIndices[0]);
    } else if(count > 1){
        title.textContent = `${count} selected`;
        _notesSummaryRows(body, activeIndices);
    } else {
        title.textContent = 'All Mockups';
        _notesSummaryRows(body, canvasData.map((_,i)=>i));
    }
}

function _notesShowSingle(index){
    const data  = canvasData[index];
    if(!data) return;
    const body  = document.getElementById('notesDrawerBody');
    const title = document.getElementById('notesDrawerTitle');
    if(!body || !title) return;
    title.textContent = 'Notes';
    body.innerHTML = `
        <div class="notes-single-header">${_notesEsc(data.filename || data.bgName || `Mockup ${index+1}`)}</div>
        <textarea class="notes-textarea" placeholder="Add notes, keywords, SEO ideas…">${_notesEsc(data.notes || '')}</textarea>
    `;
    const ta = body.querySelector('.notes-textarea');
    ta.addEventListener('focus', ()=>{
        const d = canvasData[index];
        if(d && !d._notesUndoPushed){
            d._notesUndoPushed = true;
            pushGlobalUndo(index);
        }
    }, { once: false });
    ta.addEventListener('blur',  ()=>{
        const d = canvasData[index];
        if(d) d._notesUndoPushed = false;
    });
    ta.addEventListener('input', ()=>{ canvasData[index].notes = ta.value; });
}

function _notesSummaryRows(body, indices){
    if(!indices.length){
        body.innerHTML = '<div class="notes-empty">No mockups yet.</div>';
        return;
    }
    body.innerHTML = indices.map(i=>{
        const d = canvasData[i];
        if(!d) return '';
        const name    = d.filename || d.bgName || `Mockup ${i+1}`;
        const preview = (d.notes||'').split('\n')[0].trim() || 'No notes yet';
        return `<div class="notes-summary-row" data-index="${i}">
            <div class="notes-summary-name">${_notesEsc(name)}</div>
            <div class="notes-summary-preview">${_notesEsc(preview)}</div>
        </div>`;
    }).join('');
    body.querySelectorAll('.notes-summary-row').forEach(row=>{
        row.addEventListener('click', ()=>{
            const idx = parseInt(row.dataset.index, 10);
            const d   = canvasData[idx];
            if(d && d.wrapperEl){
                d.wrapperEl.scrollIntoView({ behavior:'smooth', block:'center' });
            }
            _notesShowSingle(idx);
        });
    });
}

function _notesEsc(str){
    return String(str)
        .replace(/&/g,'&amp;')
        .replace(/</g,'&lt;')
        .replace(/>/g,'&gt;')
        .replace(/"/g,'&quot;');
}

function updateLayerButtons(){
    const del       = document.getElementById("deleteLayerBtn");
    const dup       = document.getElementById("duplicateLayerBtn");
    const invertBtn = document.getElementById("invertColorsBtn");

    const hasSelection = selectedDesigns.size > 0;
    del.disabled       = !hasSelection;
    dup.disabled       = !hasSelection;
    invertBtn.disabled = !hasSelection;

    // Copy Layer / Paste Layer button
    const copyLayerBtn = document.getElementById('copyLayerBtn');
    if (copyLayerBtn){
        copyLayerBtn.disabled = !(hasSelection || _copiedLayer !== null);
        _updateCopyLayerBtn();
    }

    const copyBtn  = document.getElementById('copyTransformsBtn');
    if(copyBtn)  copyBtn.disabled  = (activeIndices.length !== 1);
    const pasteBtn = document.getElementById('pasteTransformsBtn');
    if(pasteBtn) pasteBtn.disabled = !(_copiedTransforms && activeIndices.length > 0);

    const centerBtn = document.getElementById('centerViewBtn');
    if(centerBtn) centerBtn.textContent = activeIndices.length > 0 ? 'Fit Selection' : 'Center';

    // Activate / idle the always-present left panel
    const hasActive = activeIndices.length > 0;
    const panel = document.getElementById("contextPanel");
    if(panel) panel.classList.toggle("active", hasActive);

    // Update panel title
    const title = document.getElementById("contextPanelTitle");
    if(title){
        const n = activeIndices.length;
        title.textContent = hasActive
            ? (n === 1 ? "1 mockup selected" : `${n} mockups selected`)
            : "Controls";
    }

    // Gray out lock-sensitive controls when all selected windows are locked
    const body = document.getElementById('contextPanelBody');
    if(body){
        const allLocked = activeIndices.length > 0 &&
                          activeIndices.every(i => canvasData[i]?.locked);
        body.classList.toggle('all-locked', allLocked);
    }

    refreshNotesPanel();
}



// Reusable wrapper click handler — used by both renderBatch (inline) and duplicated windows.
function _addDragHandle(wrapper, cell) {
    const handle = document.createElement('div');
    handle.className = 'drag-handle';
    handle.textContent = '⠿ drag';
    handle.title = 'Drag to reorder';
    if (cell) {
        cell.appendChild(handle);
        cell.setAttribute('draggable', 'true');
    } else {
        wrapper.appendChild(handle);
        wrapper.setAttribute('draggable', 'true');
    }
}

function deleteSelectedWindows(){

    if(!activeIndices.length) return;

    // Sort ascending so restoration can splice back in order; skip locked windows
    const sortedIndices = [...activeIndices]
        .filter(i => !canvasData[i]?.locked)
        .sort((a, b) => a - b);

    if(!sortedIndices.length) return;

    // Save data objects (with live Fabric canvases still intact) for undo.
    // We do NOT dispose the Fabric canvas — undo will need to re-attach it.
    const savedItems = sortedIndices.map(i => ({ originalIdx: i, data: canvasData[i] }));

    globalUndoStack.push({ type: 'deletion', saved: savedItems });
    if(globalUndoStack.length > MAX_UNDO_HISTORY) globalUndoStack.shift();
    globalRedoStack = [];
    updateUndoRedoButtons();
    _markDirty();

    // Remove cell (grid item) from DOM without destroying Fabric canvas.
    // cellEl is the .window-cell that is the direct CSS-grid child; wrapperEl
    // lives inside it.  Removing only wrapperEl would leave an empty ghost cell
    // in the grid and produce a visible gap.
    const toDelete = new Set(sortedIndices);
    sortedIndices.forEach(i => {
        const d = canvasData[i];
        if(!d) return;
        if(d.wrapperEl){
            _visibilityObserver.unobserve(d.wrapperEl);
            _visibleWrappers.delete(d.wrapperEl);
        }
        const domEl = d.cellEl || d.wrapperEl;
        if(domEl && domEl.parentNode) domEl.parentNode.removeChild(domEl);
    });

    canvasData = canvasData.filter((_, i) => !toDelete.has(i));

    // Reset selection state
    activeIndices     = [];
    lastSelectedIndex = null;
    selectedDesigns.clear();

    refreshFabricHandles();
    updateWindowBorders();
    updateLayerButtons();
    syncSliders();
    updateSelectButtonState();
    updateDropUI();
}

async function duplicateSelectedWindows(){
    if(!activeIndices.length) return;

    pushGlobalUndo();

    const container    = document.getElementById('canvasContainer');
    const sortedOrig   = [...activeIndices].sort((a, b) => a - b);
    const newIndices   = [];
    let   offset       = 0;   // grows by 1 for each window inserted before the next source

    for(const origIdx of sortedOrig){

        const srcIdx  = origIdx + offset;     // true position after prior insertions
        const srcData = canvasData[srcIdx];
        if(!srcData) continue;

        const insertAt = srcIdx + 1;

        // ── 1. Build cloned data object ───────────────────────────────────────
        // Read live transform from the Fabric object so we get the latest position
        const srcObj = srcData.designObject;
        const newData = {
            bg:                     srcData.bg,
            bgName:                 srcData.bgName,
            designOriginal:         srcData.designOriginal,
            initialDesignOriginal:  srcData.initialDesignOriginal ?? srcData.designOriginal,
            designName:             srcData.designName,
            notes:                  srcData.notes || '',

            flipX: !!srcData.flipX,
            flipY: !!srcData.flipY,

            x:        srcObj ? srcObj.left                       : srcData.x,
            y:        srcObj ? srcObj.top                        : srcData.y,
            scale:    srcData.scale,
            scaleX:   srcObj ? srcObj.scaleX / srcData.previewScale : srcData.scaleX,
            scaleY:   srcObj ? srcObj.scaleY / srcData.previewScale : srcData.scaleY,
            skewX:    srcObj ? (srcObj.skewX || 0) : (srcData.skewX || 0),
            skewY:    srcObj ? (srcObj.skewY || 0) : (srcData.skewY || 0),
            rotation: srcObj ? srcObj.angle                      : (srcData.rotation ?? 0),

            warpAmount:    srcData.warpAmount    ?? 0,
            arcAmount:     srcData.arcAmount     ?? 0,
            arcTilt:       srcData.arcTilt       ?? 0,
            opacity:       srcData.opacity       ?? 1,
            blurAmount:    srcData.blurAmount    ?? 0,
            noiseAmount:   srcData.noiseAmount   ?? 0,
            blendMode:     srcData.blendMode     ?? 'normal',
            blendIntensity:srcData.blendIntensity ?? 100,
            perspectiveTop:  srcData.perspectiveTop  ?? 0,
            perspectiveLeft: srcData.perspectiveLeft ?? 0,

            maskPaths:   srcData.maskPaths
                           ? srcData.maskPaths.map(path => path.map(p => ({...p})))
                           : [],
            maskPath:    srcData.maskPath
                           ? (Array.isArray(srcData.maskPath)
                               ? srcData.maskPath.map(p => ({...p}))
                               : srcData.maskPath)
                           : null,
            maskEnabled: srcData.maskEnabled || false,
            maskType:    srcData.maskType    || null,

            bgAdjust: srcData.bgAdjust
                ? { ...srcData.bgAdjust }
                : { hue: 0, saturation: 0, brightness: 0, contrast: 0 },
            bgCrop: srcData.bgCrop
                ? { ...srcData.bgCrop }
                : { x: 0, y: 0, scale: 1, rotation: 0, aspect: 0 },

            hasProEffect:    false,
            forceProBadge:   false,
            meshWarpApplied: !!srcData.meshWarpApplied,
            invertedMain:    !!srcData.invertedMain,
            invertedExtras:  [...(srcData.invertedExtras || [])],
            patternMode:     !!srcData.patternMode,
            patternSettings: srcData.patternSettings
                ? { ...srcData.patternSettings }
                : null,

            extraDesignObjects: [],
            locked: false,

            filename: srcData.filename + '_copy',

            initialScale:         srcData.scale,
            initialRotation:      srcData.rotation      ?? 0,
            initialWarpAmount:    srcData.warpAmount     ?? 0,
            initialArcAmount:     srcData.arcAmount      ?? 0,
            initialArcTilt:       srcData.arcTilt        ?? 0,
            initialOpacity:       srcData.opacity        ?? 1,
            initialBlurAmount:    srcData.blurAmount     ?? 0,
            initialBlendMode:     srcData.blendMode      ?? 'normal',
            initialBlendIntensity: 100,
            initialPerspectiveTop:  srcData.perspectiveTop  ?? 0,
            initialPerspectiveLeft: srcData.perspectiveLeft ?? 0,
        };

        // Capture color layer + extra-layer state before async work
        const srcColorCanvas   = srcData.colorLayerCanvas  || null;
        const srcColorBlend    = srcData.colorLayerFabricObj?.globalCompositeOperation ?? 'source-over';
        const srcColorOpacity  = srcData.colorLayerFabricObj?.opacity ?? 1;
        const srcDups          = captureWindowState(srcData).duplicates;

        // ── 2. Splice into canvasData now so indexOf works inside callbacks ──
        canvasData.splice(insertAt, 0, newData);
        offset++;
        newIndices.push(insertAt);

        // ── 3. Build DOM elements ─────────────────────────────────────────────
        const wrapper = document.createElement('div');
        wrapper.className = 'canvas-wrapper';
        if(srcData.wrapperEl) wrapper.style.width = srcData.wrapperEl.style.width;
        newData.wrapperEl = wrapper;

        const canvasEl = document.createElement('canvas');
        canvasEl.width  = srcData.bg.width;
        canvasEl.height = srcData.bg.height;
        wrapper.appendChild(canvasEl);

        const filenameInput = document.createElement('input');
        filenameInput.type      = 'text';
        filenameInput.value     = newData.filename;
        filenameInput.className = 'filename-input';
        filenameInput.addEventListener('input', ev => { newData.filename = ev.target.value; });
        wrapper.appendChild(filenameInput);

        const cell = document.createElement('div');
        cell.className = 'window-cell';
        cell.appendChild(wrapper);
        newData.cellEl = cell;
        _addDragHandle(wrapper, cell);

        // Insert right after the source wrapper
        const refChild = container.children[insertAt] || null;
        container.insertBefore(cell, refChild);
        _visibilityObserver.observe(wrapper);

        // ── 4. Create Fabric canvas with same dimensions as source ────────────
        const fabricCanvas = new fabric.Canvas(canvasEl, {
            preserveObjectStacking: true,
            selection: false,
            renderOnAddRemove: false,
        });
        newData.fabricCanvas = fabricCanvas;
        _setFabricHighQualitySmoothing(fabricCanvas);

        const srcFC = srcData.fabricCanvas;
        fabricCanvas.setWidth(srcFC.getWidth());
        fabricCanvas.setHeight(srcFC.getHeight());
        fabricCanvas.wrapperEl.style.width  = srcFC.wrapperEl.style.width;
        fabricCanvas.wrapperEl.style.height = srcFC.wrapperEl.style.height;
        newData.previewScale = srcData.previewScale;
        newData.x  = newData.x  || (fabricCanvas.getWidth()  / 2);
        newData.y  = newData.y  || (fabricCanvas.getHeight() / 2);
        newData.initialX = newData.x;
        newData.initialY = newData.y;

        // ── 5. Attach selection handlers ──────────────────────────────────────
        _attachWrapperClickListener(wrapper, newData);
        _attachWindowCanvasSelection(newData);

        // ── 6. Load background, then set up design + color layer (async) ─────
        await new Promise(resolve => {
            fabric.Image.fromURL(newData.bg.src, function(bgImg){
                bgImg.set({
                    left: 0, top: 0,
                    selectable: false, evented: false,
                    originX: 'left', originY: 'top',
                    scaleX: newData.previewScale,
                    scaleY: newData.previewScale,
                });
                newData.backgroundObject = bgImg;
                fabricCanvas.add(bgImg);
                fabricCanvas.sendToBack(bgImg);

                // Restore clip overlay if this window had a mask
                addClipOverlay(newData);

                // Re-apply design with same transforms
                if(newData.designOriginal){
                    applyWarpToData(newData, true);
                    setTimeout(() => { if(canvasData.includes(newData)) applyWarpToData(newData, false); }, 50);
                }
                if(newData.patternMode) _togglePatternMode(newData, true);
                _syncProEffect(newData);

                // Copy color layer content from source
                if(srcColorCanvas){
                    initColorLayer(newData);
                    // Draw source at the same scale (both are the same Fabric canvas size)
                    newData.colorLayerCtx.drawImage(srcColorCanvas, 0, 0);
                    if(newData.colorLayerFabricObj){
                        newData.colorLayerFabricObj.set({
                            globalCompositeOperation: srcColorBlend,
                            opacity: srcColorOpacity,
                        });
                        newData.colorLayerFabricObj.dirty = true;
                    }
                }

                fabricCanvas.requestRenderAll();
                resolve();
            }, { crossOrigin: 'anonymous' });
        });

        // ── 7. Copy extra overlay layers from source ──────────────────────────
        if(srcDups.length){
            await restoreDuplicatesFromState(newData, srcDups);
        }

        // ── 8. Attach clip-drawing + color-painting events ────────────────────
        const currentIdx = canvasData.indexOf(newData);
        attachClipDrawing(wrapper, fabricCanvas, newData, currentIdx);
        _syncProEffect(newData);
    }

    // Select the newly duplicated windows
    const dupDatas      = newIndices.map(i => canvasData[i]).filter(Boolean);
    activeIndices       = dupDatas.map(d => canvasData.indexOf(d)).filter(i => i !== -1);
    _remapActiveIndicesByData(dupDatas);
    lastSelectedIndex = activeIndices.length
        ? canvasData[activeIndices[activeIndices.length - 1]]
        : null;
    newIndices.forEach(i => _syncProEffect(canvasData[i]));
    selectedDesigns.clear();
    activeIndices.forEach(i => {
        const d = canvasData[i];
        if(d?.designObject && !d.locked){
            if(!d.designObject._fx) d.designObject._fx = _defaultFx(d);
            selectedDesigns.add(d.designObject);
        }
    });

    refreshFabricHandles();
    updateWindowBorders();
    updateLayerButtons();
    syncSliders();
    updateSelectButtonState();
    updateDropUI();
}


document.getElementById("deleteWindowsBtn").addEventListener("click", ()=>{

    if(clipEditMode){
        showClipModeNotice();
        return;
    }

    if(!activeIndices.length) return;

    deleteSelectedWindows();
});

document.getElementById("duplicateWindowsBtn").addEventListener("click", ()=>{

    if(clipEditMode){
        showClipModeNotice();
        return;
    }

    if(!activeIndices.length) return;

    duplicateSelectedWindows();
});


// ── Add Window (insert a fresh window at position 0) ─────────────────────────
(()=>{
    const addWindowBgInput     = document.getElementById('addWindowBgInput');
    const addWindowDesignInput = document.getElementById('addWindowDesignInput');
    const container            = document.getElementById('canvasContainer');
    const loadingIndicator     = document.getElementById('loadingIndicator');

    document.getElementById('addWindowBtn').addEventListener('click', () => {
        if(clipEditMode){ showClipModeNotice(); return; }
        addWindowBgInput.value = '';
        addWindowBgInput.click();
    });

    addWindowBgInput.addEventListener('change', async e => {
        const file = e.target.files[0];
        addWindowBgInput.value = '';
        if(!file) return;

        loadingIndicator.style.display = 'block';
        loadingIndicator.innerText = 'Loading new window…';

        // 1. Load background image
        const bgImg = await new Promise(resolve => {
            const reader = new FileReader();
            reader.onload = ev => {
                const img = new Image();
                img.onload = () => resolve(img);
                img.src = ev.target.result;
            };
            reader.readAsDataURL(file);
        });

        pushGlobalUndo();

        // 2. Build data object (no design yet)
        const newData = {
            bg:                    bgImg,
            bgName:                file.name,
            designOriginal:        null,
            initialDesignOriginal: null,
            designName:            null,
            notes:                 '',
            x:                     0,
            y:                     0,
            scale:                 1,
            rotation:              0,
            scaleX:                null,
            scaleY:                null,
            warpAmount:            0,
            arcAmount:             0,
            arcTilt:               0,
            opacity:               1,
            blurAmount:            0,
            noiseAmount:           0,
            blendMode:             'normal',
            blendIntensity:        100,
            perspectiveTop:        0,
            perspectiveLeft:       0,
            bgAdjust:              { hue: 0, saturation: 0, brightness: 0, contrast: 0 },
            bgCrop:                { x: 0, y: 0, scale: 1, rotation: 0, aspect: 0 },
            maskPaths:             [],
            maskPath:              null,
            maskEnabled:           false,
            maskType:              null,
            extraDesignObjects:    [],
            locked:                false,
            filename:              file.name.replace(/\.[^/.]+$/, ''),
            fabricCanvas:          null,
            backgroundObject:      null,
            designObject:          null,
            wrapperEl:             null,
            previewScale:          1,
            initialX:              0,
            initialY:              0,
        };

        // 3. Build DOM
        const wrapper = document.createElement('div');
        wrapper.className = 'canvas-wrapper';
        newData.wrapperEl = wrapper;
        _visibilityObserver.observe(wrapper);

        const canvasEl = document.createElement('canvas');
        wrapper.appendChild(canvasEl);

        const filenameInput = document.createElement('input');
        filenameInput.type = 'text';
        filenameInput.value = newData.filename;
        filenameInput.className = 'filename-input';
        filenameInput.addEventListener('input', ev => { newData.filename = ev.target.value; });
        wrapper.appendChild(filenameInput);

        const cell = document.createElement('div');
        cell.className = 'window-cell';
        cell.appendChild(wrapper);
        newData.cellEl = cell;
        _addDragHandle(wrapper, cell);

        // Insert at beginning of the grid
        container.insertBefore(cell, container.firstChild);

        // 4. Create Fabric canvas + size it
        const fabricCanvas = new fabric.Canvas(canvasEl, {
            preserveObjectStacking: true,
            selection: false,
            renderOnAddRemove: false
        });
        newData.fabricCanvas = fabricCanvas;
        _setFabricHighQualitySmoothing(fabricCanvas);

        const realWidth  = bgImg.width;
        const realHeight = bgImg.height;
        const targetColumnWidth = 300;
        const scaleRatio        = Math.min(1, (targetColumnWidth * 1.5) / realWidth);
        const previewWidth      = Math.round(realWidth  * scaleRatio);
        const previewHeight     = Math.round(realHeight * scaleRatio);
        const displayW          = Math.round(targetColumnWidth);
        const displayH          = Math.round(previewHeight * targetColumnWidth / previewWidth);

        fabricCanvas.setWidth(previewWidth);
        fabricCanvas.setHeight(previewHeight);
        fabricCanvas.wrapperEl.style.width  = displayW + 'px';
        fabricCanvas.wrapperEl.style.height = displayH + 'px';
        wrapper.style.width = displayW + 'px';

        newData.previewScale = scaleRatio;
        newData.x            = previewWidth  / 2;
        newData.y            = previewHeight / 2;
        newData.initialX     = newData.x;
        newData.initialY     = newData.y;

        // 5. Insert at front of canvasData + wire up interactions
        canvasData.unshift(newData);

        _attachWrapperClickListener(wrapper, newData);
        _attachWindowCanvasSelection(newData);
        attachClipDrawing(wrapper, fabricCanvas, newData, 0);

        // 6. Hide the empty-state overlay first (before any call that might
        //    invoke updateDropUI and re-show it)
        const dropZoneEl     = document.getElementById('dropZone');
        const designPromptEl = document.getElementById('designPrompt');
        if(dropZoneEl)     dropZoneEl.style.display     = 'none';
        if(designPromptEl) designPromptEl.style.display = 'none';

        // 7. Hide loading indicator
        loadingIndicator.style.display = 'none';

        // 8. Select the new window
        activeIndices     = [0];
        lastSelectedIndex = canvasData[0] ?? null;
        selectedDesigns.clear();
        refreshFabricHandles();
        updateWindowBorders();
        updateLayerButtons();
        syncSliders();
        updateSelectButtonState();

        // 9. Load background into Fabric (fire-and-forget — matches renderBatch)
        fabric.Image.fromURL(bgImg.src, bgFabricImg => {
            bgFabricImg.set({
                left: 0, top: 0,
                selectable: false, evented: false,
                originX: 'left', originY: 'top',
                scaleX: scaleRatio, scaleY: scaleRatio
            });
            newData.backgroundObject = bgFabricImg;
            fabricCanvas.add(bgFabricImg);
            fabricCanvas.sendToBack(bgFabricImg);
            addClipOverlay(newData);
            fabricCanvas.requestRenderAll();
        }, { crossOrigin: 'anonymous' });

        autoSaveSession();
    });
})();


// ── Change Background for selected windows ────────────────────────────────────
async function changeBackgroundForSelected(file){
    if(!activeIndices.length) return;

    // Load the new background image from the picked file
    const newImg = await new Promise(resolve => {
        const reader = new FileReader();
        reader.onload = e => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    });

    pushGlobalUndo();

    for(const i of [...activeIndices]){
        const data = canvasData[i];
        if(!data || data.locked) continue;

        const fabricCanvas  = data.fabricCanvas;
        const oldPreviewW   = fabricCanvas.getWidth();
        const oldPreviewH   = fabricCanvas.getHeight();

        // Recalculate previewScale to keep the same CSS column width
        const displayW     = parseInt(fabricCanvas.wrapperEl.style.width) || oldPreviewW;
        const newScale     = Math.min(1, (displayW * 1.5) / newImg.width);
        const newPreviewW  = Math.round(newImg.width  * newScale);
        const newPreviewH  = Math.round(newImg.height * newScale);
        const newDisplayH  = Math.round(newPreviewH * displayW / newPreviewW);

        // Preserve design's normalized position across the resize
        const xNorm = oldPreviewW > 0 ? data.x / oldPreviewW : 0.5;
        const yNorm = oldPreviewH > 0 ? data.y / oldPreviewH : 0.5;

        // Update data fields
        data.bg         = newImg;
        data.bgName     = file.name;
        data.previewScale = newScale;
        data.x = xNorm * newPreviewW;
        data.y = yNorm * newPreviewH;

        // Resize Fabric canvas
        fabricCanvas.setWidth(newPreviewW);
        fabricCanvas.setHeight(newPreviewH);
        fabricCanvas.wrapperEl.style.width  = displayW + 'px';
        fabricCanvas.wrapperEl.style.height = newDisplayH + 'px';
        if(data.wrapperEl) data.wrapperEl.style.width = displayW + 'px';

        // Resize color layer offscreen canvas proportionally if it exists
        if(data.colorLayerCanvas && data.colorLayerFabricObj){
            const tmp     = document.createElement('canvas');
            tmp.width     = newPreviewW;
            tmp.height    = newPreviewH;
            tmp.getContext('2d').drawImage(data.colorLayerCanvas, 0, 0, newPreviewW, newPreviewH);
            data.colorLayerCanvas = tmp;
            data.colorLayerCtx    = tmp.getContext('2d');
            data.colorLayerFabricObj.setElement(tmp);
            data.colorLayerFabricObj.width  = newPreviewW;
            data.colorLayerFabricObj.height = newPreviewH;
            data.colorLayerFabricObj.dirty  = true;
        }

        // Remove old background object from canvas
        if(data.backgroundObject) fabricCanvas.remove(data.backgroundObject);

        // Load new background image into Fabric
        await new Promise(resolve => {
            fabric.Image.fromURL(newImg.src, function(bgImg){
                bgImg.set({
                    left: 0, top: 0,
                    selectable: false, evented: false,
                    originX: 'left', originY: 'top',
                    scaleX: newScale,
                    scaleY: newScale,
                });
                data.backgroundObject = bgImg;
                fabricCanvas.add(bgImg);
                fabricCanvas.sendToBack(bgImg);

                // Maintain stacking: bg → color layer → designs
                if(data.colorLayerFabricObj){
                    fabricCanvas.sendToBack(data.colorLayerFabricObj);
                    fabricCanvas.sendToBack(bgImg);
                }

                addClipOverlay(data);

                if(data.designOriginal){
                    applyWarpToData(data, true);
                    setTimeout(() => { if(canvasData.includes(data)) applyWarpToData(data, false); }, 50);
                }

                fabricCanvas.requestRenderAll();
                resolve();
            }, { crossOrigin: 'anonymous' });
        });
    }

    refreshFabricHandles();
    syncSliders();
    updateWindowBorders();
}

document.getElementById('changeBgBtn').addEventListener('click', ()=>{
    if(!activeIndices.length) return;
    document.getElementById('changeBgInput').value = '';
    document.getElementById('changeBgInput').click();
});
document.getElementById('changeBgInput').addEventListener('change', async function(){
    if(!this.files.length) return;
    await changeBackgroundForSelected(this.files[0]);
    this.value = '';
});


// ── Change Design for selected windows ────────────────────────────────────────
async function changeDesignForSelected(file){
    if(!activeIndices.length) return;

    const loadingIndicator = document.getElementById('loadingIndicator');
    loadingIndicator.style.display = 'block';
    loadingIndicator.innerText = 'Processing design...';

    // Load and (for PNG) trim transparent pixels — exactly as in handleDesignFiles
    const newImg = await new Promise(resolve => {
        const reader = new FileReader();
        reader.onload = async e => {
            const img = new Image();
            img.onload = async () => {
                const isJpg = file.type === 'image/jpeg' || file.type === 'image/jpg';
                let finalImg = img;
                if(!isJpg){
                    await new Promise(r => requestAnimationFrame(r));
                    finalImg = trimTransparentPixels(img);
                }
                if(finalImg.complete) resolve(finalImg);
                else finalImg.onload = () => resolve(finalImg);
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    });

    loadingIndicator.style.display = 'none';

    pushGlobalUndo();

    for(const i of [...activeIndices]){
        const data = canvasData[i];
        if(!data || data.locked) continue;

        const hadNoDesign = !data.designOriginal;

        // Swap the image source — keep all transforms, effects, and layer settings as-is
        data.designOriginal        = newImg;
        data.initialDesignOriginal = newImg;
        data.designName            = file.name;

        // If this window had no design, initialise scale/position AND filename
        // exactly like createCanvasData does for a fresh upload.
        if(hadNoDesign){
            const designBase = file.name.replace(/\.[^/.]+$/, '');
            const bgBase     = (data.bgName || '').replace(/\.[^/.]+$/, '');
            data.filename = bgBase ? `${designBase}_${bgBase}` : designBase;
            const filenameInput = data.wrapperEl?.querySelector('.filename-input');
            if(filenameInput) filenameInput.value = data.filename;
            const bgW = data.bg.width;
            const bgH = data.bg.height;
            data.scale         = Math.min(
                (bgW * 0.5) / newImg.width,
                (bgH * 0.5) / newImg.height
            );
            data.scaleX        = null;
            data.scaleY        = null;
            data.rotation      = 0;
            data.warpAmount    = 0;
            data.arcAmount     = 0;
            data.arcTilt       = 0;
            data.opacity       = 1;
            data.blurAmount    = 0;
            data.noiseAmount   = 0;
            data.blendMode     = 'normal';
            data.perspectiveTop  = 0;
            data.perspectiveLeft = 0;
            const fc = data.fabricCanvas;
            data.x = fc ? fc.getWidth()  / 2 : bgW * data.previewScale / 2;
            data.y = fc ? fc.getHeight() / 2 : bgH * data.previewScale / 2;
        }

        applyWarpToData(data, true);
        setTimeout(() => { if(canvasData.includes(data)) applyWarpToData(data, false); }, 50);
    }

    refreshFabricHandles();
    syncSliders();
    updateWindowBorders();
    updateLayerButtons();
}

document.getElementById('changeDesignBtn').addEventListener('click', ()=>{
    if(!activeIndices.length) return;
    document.getElementById('changeDesignInput').value = '';
    document.getElementById('changeDesignInput').click();
});
document.getElementById('changeDesignInput').addEventListener('change', async function(){
    if(!this.files.length) return;
    await changeDesignForSelected(this.files[0]);
    this.value = '';
});


function lockSelectedWindows(){
    if(!activeIndices.length) return;
    pushGlobalUndo();
    activeIndices.forEach(i=>{
        const data = canvasData[i];
        if(!data || data.locked) return;
        data.locked = true;
        // Lock all Fabric objects so nothing can be dragged/transformed
        getAllDesignObjects(data).forEach(o=>{
            if(!o) return;
            o._lockSelectable = o.selectable;
            o._lockEvented    = o.evented;
            o.selectable      = false;
            o.evented         = false;
        });
        data.fabricCanvas.discardActiveObject();
        data.fabricCanvas.requestRenderAll();
        if(data.wrapperEl){
            data.wrapperEl.classList.add('window-locked');
            const inp = data.wrapperEl.querySelector('.filename-input');
            if(inp) inp.disabled = true;
        }
    });
    selectedDesigns.clear();
    updateLayerButtons();
}

function unlockSelectedWindows(){
    if(!activeIndices.length) return;
    pushGlobalUndo();
    activeIndices.forEach(i=>{
        const data = canvasData[i];
        if(!data || !data.locked) return;
        data.locked = false;
        getAllDesignObjects(data).forEach(o=>{
            if(!o) return;
            o.selectable = (o._lockSelectable !== undefined) ? o._lockSelectable : true;
            o.evented    = (o._lockEvented    !== undefined) ? o._lockEvented    : true;
            delete o._lockSelectable;
            delete o._lockEvented;
        });
        data.fabricCanvas.requestRenderAll();
        if(data.wrapperEl){
            data.wrapperEl.classList.remove('window-locked');
            const inp = data.wrapperEl.querySelector('.filename-input');
            if(inp) inp.disabled = false;
        }
    });
    updateLayerButtons();
}

document.getElementById("lockWindowsBtn").addEventListener("click", ()=>{
    if(!activeIndices.length) return;
    lockSelectedWindows();
});

document.getElementById("unlockWindowsBtn").addEventListener("click", ()=>{
    if(!activeIndices.length) return;
    unlockSelectedWindows();
});

// ── Invert Colors ─────────────────────────────────────────────────────────────
function invertSelectedDesigns(){
    if(!selectedDesigns.size) return;

    pushGlobalUndo();

    const _invertMarked = new Set();

    selectedDesigns.forEach(obj => {
        // Find the owning canvasData entry
        const d = canvasData.find(cd =>
            cd && (cd.designObject === obj ||
                   (cd.extraDesignObjects && cd.extraDesignObjects.includes(obj)))
        );
        if(!d || d.locked) return;

        // Step 1 — invert the currently-rendered element directly (what the user sees).
        // This is the same pattern the eraser uses: ensureErasableCanvas converts the
        // Fabric object's element to a writable canvas, then we pixel-flip it in-place.
        // This avoids re-running the warp/blur/perspective pipeline which would corrupt
        // the result for designs that have already been warped or processed.
        const el = ensureErasableCanvas(obj);
        invertCanvasInPlace(el);

        // Step 2 — if a non-normal blend mode is active, reset it to Normal.
        // Multiply/Screen distort what "inverted" means visually (e.g. white bg
        // stays invisible but black design goes transparent with Multiply).
        // Switching to Normal after inverting gives the correct visual result.
        if(!obj._fx) obj._fx = _defaultFx(d);
        if(obj._fx.blendMode && obj._fx.blendMode !== 'normal'){
            obj._fx.blendMode = 'normal';
            obj.set({ globalCompositeOperation: 'source-over' });
            // Keep the window-level copy in sync so buildSnapshot and syncSliders agree
            const isMainForMode = obj === d.designObject;
            if(isMainForMode) d.blendMode = 'normal';
        }

        obj.dirty = true;
        d.fabricCanvas.requestRenderAll();

        // Step 3 — also invert designOriginal (the pipeline source) so that any
        // future slider change (blur, warp, etc.) re-renders from the inverted source.
        const isMain   = obj === d.designObject;
        const extraIdx = isMain ? -1 : (d.extraDesignObjects || []).indexOf(obj);
        const src      = isMain
            ? d.designOriginal
            : (d.extraDesignOriginals?.[extraIdx] || null);

        if(src){
            const inverted = invertImageSource(src);
            if(isMain){
                d.designOriginal = inverted;
            } else if(extraIdx >= 0){
                if(!d.extraDesignOriginals) d.extraDesignOriginals = [];
                d.extraDesignOriginals[extraIdx] = inverted;
            }
        }

        if (isMain) d.invertedMain = true;
        else if (extraIdx >= 0) {
            if (!d.invertedExtras) d.invertedExtras = [];
            d.invertedExtras[extraIdx] = true;
        }
        _invertMarked.add(d);
    });

    _invertMarked.forEach(d => _syncProEffect(d));

    // Refresh the blend mode dropdown to reflect any mode resets above
    syncSliders();
}

document.getElementById("invertColorsBtn").addEventListener("click", ()=>{
    invertSelectedDesigns();
});

// ── Flip H / Flip V ───────────────────────────────────────────────────────────
function flipSelectedDesigns(axis){
    if(!activeIndices.length) return;
    pushGlobalUndo();
    activeIndices.forEach(i => {
        const data = canvasData[i];
        if(!data || data.locked || !data.designOriginal) return;
        if(axis === 'H') data.flipX = !data.flipX;
        else             data.flipY = !data.flipY;
        data._flipMap = null; // invalidate cached flipped sources
        applyWarpToData(data, false);
    });
}

document.getElementById('flipHBtn').addEventListener('click', () => flipSelectedDesigns('H'));
document.getElementById('flipVBtn').addEventListener('click', () => flipSelectedDesigns('V'));

// ── Copy / Paste Layer ─────────────────────────────────────────────────────────
// Stores the last "Copy Layer" payload so the user can paste it into other windows.
// type:'design' → replaces the window's main design
// type:'extra'  → appended as an overlay layer on top of the existing design
var _copiedLayer = null;

function _updateCopyLayerBtn(){
    const btn = document.getElementById('copyLayerBtn');
    if (!btn) return;
    if (_copiedLayer){
        btn.textContent         = 'Paste Layer';
        btn.style.background    = '#e8f5e9';
        btn.style.borderColor   = '#66bb6a';
        btn.style.color         = '#2e7d32';
    } else {
        btn.textContent         = 'Copy Layer';
        btn.style.background    = '';
        btn.style.borderColor   = '';
        btn.style.color         = '';
    }
}

function _captureLayerPosition(obj) {
    const pt = typeof obj.getCenterPoint === 'function'
        ? obj.getCenterPoint()
        : { x: obj.left, y: obj.top };
    return {
        srcLeft:   pt.x,
        srcTop:    pt.y,
        srcScaleX: obj.scaleX,
        srcScaleY: obj.scaleY,
        angle:     obj.angle ?? 0,
    };
}

function _copyCurrentLayer(){
    if (!selectedDesigns.size) return;

    const obj = [...selectedDesigns][0];
    let sourceData = null, layerType = null, layerIdx = -1;

    for (const d of canvasData){
        if (d.designObject === obj){ sourceData = d; layerType = 'design'; break; }
        const ei = (d.extraDesignObjects || []).indexOf(obj);
        if (ei !== -1){ sourceData = d; layerType = 'extra'; layerIdx = ei; break; }
    }
    if (!sourceData) return;

    const srcEl = layerType === 'design'
        ? sourceData.designOriginal
        : sourceData.extraDesignOriginals?.[layerIdx];
    if (!srcEl) return;

    const pos = _captureLayerPosition(obj);

    _copiedLayer = {
        type:     layerType,
        el:       srcEl,
        name:     obj._uploadedDesignName || null,
        fx:       obj._fx ? JSON.parse(JSON.stringify(obj._fx)) : null,
        srcIdx:   canvasData.indexOf(sourceData),
        srcLeft:  pos.srcLeft,
        srcTop:   pos.srcTop,
        srcScaleX: pos.srcScaleX,
        srcScaleY: pos.srcScaleY,
        angle:    pos.angle,
        designRotation:       sourceData.rotation      ?? 0,
        designWarpAmount:     sourceData.warpAmount     ?? 0,
        designArcAmount:      sourceData.arcAmount      ?? 0,
        designArcTilt:        sourceData.arcTilt        ?? 0,
        designPerspectiveTop: sourceData.perspectiveTop ?? 0,
        designPerspectiveLeft:sourceData.perspectiveLeft?? 0,
        designSkewX:  sourceData.skewX  ?? 0,
        designSkewY:  sourceData.skewY  ?? 0,
        designFlipX:  !!sourceData.flipX,
        designFlipY:  !!sourceData.flipY,
    };

    _updateCopyLayerBtn();
    updateLayerButtons();
}

async function _pasteLayerToTargets(){
    if (!_copiedLayer || !activeIndices.length) return;

    const srcIdx  = _copiedLayer.srcIdx;
    const targets = activeIndices
        .filter(i => i !== srcIdx)
        .map(i => canvasData[i])
        .filter(d => d && !d.locked);

    if (!targets.length){
        alert('Select one or more mockups (other than the source) to paste into.');
        _copiedLayer = null;
        _updateCopyLayerBtn();
        return;
    }

    // Snapshot every target for undo before touching anything
    const undoItems = targets
        .map(d => ({ idx: canvasData.indexOf(d), state: captureWindowState(d), original: d.designOriginal }))
        .filter(item => item.idx !== -1);
    if (undoItems.length){
        globalUndoStack.push({ type: 'warp', items: undoItems });
        if (globalUndoStack.length > MAX_UNDO_HISTORY) globalUndoStack.shift();
        globalRedoStack = [];
        updateUndoRedoButtons();
    }

    if (_copiedLayer.type === 'design'){
        // ── Replace main design in each target window ──────────────────────
        let srcEl = _copiedLayer.el;
        if (!(srcEl instanceof HTMLCanvasElement)){
            const tmp = document.createElement('canvas');
            tmp.width  = srcEl.naturalWidth  || srcEl.width  || 1;
            tmp.height = srcEl.naturalHeight || srcEl.height || 1;
            tmp.getContext('2d').drawImage(srcEl, 0, 0);
            srcEl = tmp;
        }
        for (const d of targets){
            if (d.patternMode || d.patternFabricObj) _togglePatternMode(d, false);
            const fc   = d.fabricCanvas;
            const W    = fc.getWidth();
            const H    = fc.getHeight();
            const dpr  = Math.max(1, fc.lowerCanvasEl.width / W);
            const tps  = d.previewScale || 1;
            const copy = document.createElement('canvas');
            copy.width  = W * dpr;
            copy.height = H * dpr;
            const cCtx  = copy.getContext('2d');
            cCtx.imageSmoothingEnabled = true;
            cCtx.imageSmoothingQuality = 'high';
            cCtx.drawImage(srcEl, 0, 0, W * dpr, H * dpr);
            d.designOriginal = copy;
            d.warpCanvas     = null;
            const cl = _copiedLayer;
            d.x          = cl.srcLeft;
            d.y          = cl.srcTop;
            d.scaleX     = cl.srcScaleX / tps;
            d.scaleY     = cl.srcScaleY / tps;
            d.rotation        = cl.designRotation       ?? 0;
            d.warpAmount      = cl.designWarpAmount     ?? 0;
            d.arcAmount       = cl.designArcAmount      ?? 0;
            d.arcTilt         = cl.designArcTilt        ?? 0;
            d.perspectiveTop  = cl.designPerspectiveTop ?? 0;
            d.perspectiveLeft = cl.designPerspectiveLeft?? 0;
            d.skewX           = cl.designSkewX          ?? 0;
            d.skewY           = cl.designSkewY          ?? 0;
            d.flipX           = cl.designFlipX          ?? false;
            d.flipY           = cl.designFlipY          ?? false;
            applyWarpToData(d, false);
        }
    } else {
        // ── Append as an overlay layer in each target window ───────────────
        const srcEl = _copiedLayer.el;
        const cl = _copiedLayer;
        for (const d of targets){
            if (!d.designObject) continue;
            const fabricImg = new fabric.Image(srcEl, {
                left:   cl.srcLeft,
                top:    cl.srcTop,
                scaleX: cl.srcScaleX,
                scaleY: cl.srcScaleY,
                angle:  cl.angle ?? 0,
                opacity: cl.fx?.opacity ?? 1,
                globalCompositeOperation: 'source-over',
                originX: 'center',
                originY: 'center',
            });
            fabricImg._uploadedDesignName = cl.name || 'pasted_layer';
            fabricImg._fx = cl.fx
                ? JSON.parse(JSON.stringify(cl.fx))
                : { warpAmount: 0, arcAmount: 0, arcTilt: 0,
                    perspectiveTop: 0, perspectiveLeft: 0,
                    opacity: 1, blurAmount: 0, noiseAmount: 0, blendMode: 'normal' };
            d.extraDesignObjects   = d.extraDesignObjects   || [];
            d.extraDesignOriginals = d.extraDesignOriginals || [];
            d.extraDesignObjects.push(fabricImg);
            d.extraDesignOriginals.push(srcEl);
            _applyExtraLayerHandleStyle(fabricImg, 'overlay');
            applyClipMaskToObject(fabricImg, d);
            d.fabricCanvas.add(fabricImg);
            attachFabricEvents(d, fabricImg);
            d.fabricCanvas.requestRenderAll();
        }
    }

    _copiedLayer = null;
    _updateCopyLayerBtn();
    syncSliders();
    _markDirty();
}

document.getElementById('copyLayerBtn').addEventListener('click', () => {
    if (_copiedLayer){
        _pasteLayerToTargets();
    } else {
        _copyCurrentLayer();
    }
});

// ── Copy / Paste Effects ───────────────────────────────────────────────────────
var _copiedTransforms = null;

const _EFFECT_FX_KEYS = [
    'opacity', 'blurAmount', 'noiseAmount',
    'warpAmount', 'arcAmount', 'arcTilt',
    'perspectiveTop', 'perspectiveLeft', 'blendMode',
];

function _pickEffectFx(source, fallbackData) {
    const fb = _defaultFx(fallbackData || {});
    const src = source || {};
    const out = {};
    _EFFECT_FX_KEYS.forEach(k => {
        out[k] = src[k] !== undefined ? src[k] : fb[k];
    });
    return out;
}

function _captureEffectPayload(data) {
    const obj = _getPrimarySelectedLayer(data);
    if (!obj) return null;
    const isMain = obj === data.designObject;
    const extraIdx = isMain ? -1 : (data.extraDesignObjects || []).indexOf(obj);
    return {
        designFx: _pickEffectFx(obj._fx, data),
        patternMode: !!data.patternMode,
        patternSettings: data.patternSettings
            ? JSON.parse(JSON.stringify(data.patternSettings))
            : null,
        invertActive: isMain
            ? !!data.invertedMain
            : !!(data.invertedExtras && data.invertedExtras[extraIdx]),
    };
}

function _applyCopiedWindowEffects(data, fx) {
    data.warpAmount      = fx.warpAmount      ?? 0;
    data.arcAmount       = fx.arcAmount       ?? 0;
    data.arcTilt         = fx.arcTilt         ?? 0;
    data.perspectiveTop  = fx.perspectiveTop  ?? 0;
    data.perspectiveLeft = fx.perspectiveLeft ?? 0;
    data.opacity         = fx.opacity         ?? 1;
    data.blurAmount      = fx.blurAmount      ?? 0;
    data.noiseAmount     = fx.noiseAmount     ?? 0;
    data.blendMode       = fx.blendMode       ?? 'normal';
}

function _syncInvertLayer(data, isMain, extraIdx, shouldBeInverted) {
    const obj = isMain ? data.designObject : data.extraDesignObjects?.[extraIdx];
    if (!obj) return;

    const currentlyInverted = isMain
        ? !!data.invertedMain
        : !!(data.invertedExtras && data.invertedExtras[extraIdx]);
    if (shouldBeInverted === currentlyInverted) return;

    const el = ensureErasableCanvas(obj);
    invertCanvasInPlace(el);

    if (!obj._fx) obj._fx = _defaultFx(data);
    if (obj._fx.blendMode && obj._fx.blendMode !== 'normal') {
        obj._fx.blendMode = 'normal';
        obj.set({ globalCompositeOperation: 'source-over' });
        if (isMain) data.blendMode = 'normal';
    }
    obj.dirty = true;

    const src = isMain
        ? data.designOriginal
        : (data.extraDesignOriginals?.[extraIdx] || null);
    if (src) {
        const inverted = invertImageSource(src);
        if (isMain) {
            data.designOriginal = inverted;
        } else if (extraIdx >= 0) {
            if (!data.extraDesignOriginals) data.extraDesignOriginals = [];
            data.extraDesignOriginals[extraIdx] = inverted;
        }
    }

    if (isMain) {
        data.invertedMain = shouldBeInverted;
    } else if (extraIdx >= 0) {
        if (!data.invertedExtras) data.invertedExtras = [];
        data.invertedExtras[extraIdx] = shouldBeInverted;
    }
}

function _applyWindowPatternFromPayload(data, payload) {
    if (payload.patternMode) {
        data.patternSettings = payload.patternSettings
            ? JSON.parse(JSON.stringify(payload.patternSettings))
            : _defaultPattern();
        if (!data.patternMode) {
            _togglePatternMode(data, true);
        } else {
            _renderPattern(data, false);
        }
    } else if (data.patternMode || data.patternFabricObj) {
        _togglePatternMode(data, false);
    }
}

function _applyEffectPayload(data, payload) {
    if (data.locked || !payload) return;
    const obj = _getPrimarySelectedLayer(data);
    if (!obj) return;

    const isMain = obj === data.designObject;
    const extraIdx = isMain ? -1 : (data.extraDesignObjects || []).indexOf(obj);

    if (payload.designFx) {
        obj._fx = {
            ...(obj._fx || _defaultFx(data)),
            ...JSON.parse(JSON.stringify(payload.designFx)),
        };
    }

    _syncInvertLayer(data, isMain, extraIdx, !!payload.invertActive);

    if (isMain) {
        if (!data.designOriginal) return;
        _applyCopiedWindowEffects(data, obj._fx);
        applyWarpToData(data, false);
    } else {
        const src = data.extraDesignOriginals?.[extraIdx] || data.designOriginal;
        if (src) {
            _applyWarpToOneObject(obj, data, _cachedFlip(data, src), false);
        }
        applyClipMaskToObject(obj, data);
    }

    _applyWindowPatternFromPayload(data, payload);
    data.fabricCanvas?.requestRenderAll();
}

document.getElementById('copyTransformsBtn').addEventListener('click', () => {
    const srcData = lastSelectedIndex ?? canvasData[activeIndices[activeIndices.length - 1]] ?? null;
    if(srcData === null) return;
    if(!_getPrimarySelectedLayer(srcData)) return;
    _copiedTransforms = _captureEffectPayload(srcData);
    // Visual feedback on the button
    const btn = document.getElementById('copyTransformsBtn');
    const _copyEffectsLabel = btn.innerHTML;
    btn.textContent = '✓ Copied';
    setTimeout(() => { btn.innerHTML = _copyEffectsLabel; }, 1400);
    updateLayerButtons(); // enable Paste
});

document.getElementById('pasteTransformsBtn').addEventListener('click', () => {
    if(!_copiedTransforms || !activeIndices.length) return;
    pushGlobalUndo();
    activeIndices.forEach(i => {
        const d = canvasData[i];
        if (!d || d.locked) return;
        _applyEffectPayload(d, _copiedTransforms);
        if (_userPlan === 'pro') {
            _syncProEffect(d);
        } else {
            d.forceProBadge = true;
            _syncProEffect(d);
        }
    });
    _markDirty();
    syncSliders();
});

document.getElementById("selectAllBtn").addEventListener("click", ()=>{

    if(clipEditMode){
        showClipModeNotice();
        return;
    }

    if(activeIndices.length === canvasData.length && canvasData.length > 0){

        activeIndices = [];
        selectedDesigns.clear();

    } else {

        activeIndices = canvasData.map((_,i)=>i);
        selectedDesigns.clear();
        canvasData.forEach(d => {
            if(d?.designObject && !d.locked){
                if(!d.designObject._fx) d.designObject._fx = _defaultFx(d);
                selectedDesigns.add(d.designObject);
            }
        });
    }

    refreshFabricHandles();
    updateWindowBorders();
    updateLayerButtons();
    syncSliders();
    updateSelectButtonState();
});



document.getElementById("duplicateLayerBtn").addEventListener("click", ()=>{

    if(clipEditMode){
        showClipModeNotice();
        return;
    }

    if(selectedDesigns.size === 0) return;

    pushGlobalUndo();

    const toClone = [...selectedDesigns]; // snapshot before modifications
    const newClones = [];
    let remaining = toClone.length;

    toClone.forEach(sourceObj => {
        const data = sourceObj._ownerData;
        if(!data){ remaining--; return; }

        sourceObj.clone((cloned) => {
            cloned._fx = sourceObj._fx
                ? { ...sourceObj._fx }
                : _defaultFx(data);

            const fx = cloned._fx;

            cloned.set({
                left: sourceObj.left + 40,
                top:  sourceObj.top  + 20,
                opacity: fx.opacity ?? 1,
                globalCompositeOperation: _blendToGCO(fx.blendMode)
            });

            data.extraDesignObjects   = data.extraDesignObjects   || [];
            data.extraDesignOriginals  = data.extraDesignOriginals  || [];

            const srcExtraIdx = (data.extraDesignObjects || []).indexOf(sourceObj);
            const clonedSrc   = _sourceForDuplicateLayer(data, sourceObj);
            data.extraDesignOriginals.push(clonedSrc);
            const isOverlayDup = _extraObjectIsOverlay(sourceObj);
            if (isOverlayDup && sourceObj._uploadedDesignName) {
                cloned._uploadedDesignName = sourceObj._uploadedDesignName;
            }

            _resetObjectPipelineCaches(cloned);

            data.extraDesignObjects.push(cloned);
            if (clonedSrc) {
                _applyWarpToOneObject(cloned, data, _cachedFlip(data, clonedSrc), false);
            }
            _applyExtraLayerHandleStyle(cloned, isOverlayDup ? 'overlay' : 'clone');

            data.fabricCanvas.add(cloned);
            attachFabricEvents(data, cloned);

            newClones.push(cloned);
            data.fabricCanvas.requestRenderAll();

            remaining--;
            if(remaining === 0){
                // Switch selection to the new clones
                selectedDesigns.clear();
                newClones.forEach(obj => selectedDesigns.add(obj));
                refreshFabricHandles();
                updateWindowBorders();
                updateLayerButtons();
                syncSliders();
                autoSaveSession();
            }
        });
    });
});



document.getElementById("deleteLayerBtn").addEventListener("click", ()=>{

    if(clipEditMode){
        showClipModeNotice();
        return;
    }

    if(selectedDesigns.size === 0) return;

    // Only delete added layers — not original designs
    const toDelete = [...selectedDesigns].filter(obj => {
        const d = obj._ownerData;
        return d && obj !== d.designObject;
    });

    if(toDelete.length === 0){
        alert("Cannot delete original design(s). Select an added layer to delete.");
        return;
    }

    pushGlobalUndo();

    toDelete.forEach(targetObj => {
        const data = targetObj._ownerData;
        if(!data) return;

        const delIdx = (data.extraDesignObjects || []).indexOf(targetObj);

        data.fabricCanvas.remove(targetObj);

        data.extraDesignObjects =
            (data.extraDesignObjects || []).filter(obj => obj !== targetObj);

        if(delIdx !== -1 && data.extraDesignOriginals){
            data.extraDesignOriginals.splice(delIdx, 1);
        }

        selectedDesigns.delete(targetObj);
        data.fabricCanvas.discardActiveObject();
        data.fabricCanvas.requestRenderAll();
    });

    refreshFabricHandles();
    updateWindowBorders();
    updateLayerButtons();
    syncSliders();
    autoSaveSession();
});

document.getElementById("designEraserBtn").addEventListener("click", () => {
    if (designEraserMode) {
        exitDesignEraserMode();
    } else {
        tryEnterDesignEraserMode();
    }
});

document.getElementById("designEraserSizeSlider").addEventListener("input", e => {
    designEraserSize = parseInt(e.target.value, 10);
    document.getElementById("designEraserSizeVal").textContent = designEraserSize;
});

document.getElementById("designEraserSoftnessSlider").addEventListener("input", e => {
    designEraserSoftness = parseInt(e.target.value, 10);
    document.getElementById("designEraserSoftnessVal").textContent = designEraserSoftness;
});

document.getElementById("designWarpBtn").addEventListener("click", () => {
    if (designWarpMode) {
        exitDesignWarpMode(false);
    } else {
        enterDesignWarpMode();
    }
});
document.getElementById("warpApplyBtn").addEventListener("click", () => {
    const _warpTargets = warpAllGroups.map(g => g.ownerData);
    exitDesignWarpMode(true);
    if (_warpTargets.length) _warpTargets.forEach(d => _syncProEffect(d));
    else activeIndices.forEach(i => _syncProEffect(canvasData[i]));
});
document.getElementById("warpCancelBtn").addEventListener("click", () => exitDesignWarpMode(false));



// ── Add Layer ─────────────────────────────────────────────────────────────────
document.getElementById("addLayerBtn").addEventListener("click", ()=>{

    if(clipEditMode){ showClipModeNotice(); return; }

    if(!activeIndices.length){
        alert("Select one or more windows first.");
        return;
    }

    const anyHasDesign = activeIndices.some(i => canvasData[i].designObject);
    if(!anyHasDesign){
        alert("Load a background and design first, then add layers.");
        return;
    }

    document.getElementById("layerUpload").value = "";
    document.getElementById("layerUpload").click();
});

document.getElementById("layerUpload").addEventListener("change", async function(){

    if(clipEditMode){ showClipModeNotice(); return; }
    if(!activeIndices.length) return;

    const files = Array.from(this.files);
    if(!files.length) return;

    // Snapshot ALL selected windows before adding layers
    pushGlobalUndo();

    const loadingIndicator = document.getElementById("loadingIndicator");
    loadingIndicator.style.display = "block";

    // Remember which window indices were selected at upload time
    const targetIndices = [...activeIndices];
    let lastAddedByIndex = {};   // index → last fabricImg added

    for(let fi = 0; fi < files.length; fi++){

        const file = files[fi];
        loadingIndicator.innerText =
            `Loading layer ${fi + 1} / ${files.length}…`;

        await new Promise(resolve => {

            const reader = new FileReader();

            reader.onload = function(e){

                const img = new Image();

                img.onload = async function(){

                    let finalImg = img;
                    const isJpg =
                        file.type === "image/jpeg" ||
                        file.type === "image/jpg";

                    if(!isJpg){
                        await new Promise(r => requestAnimationFrame(r));
                        finalImg = trimTransparentPixels(img);
                    }

                    const finalize = () => {

                        targetIndices.forEach(index => {

                            const data = canvasData[index];
                            if(!data.designObject) return;

                            const canvasW = data.fabricCanvas.getWidth();
                            const canvasH = data.fabricCanvas.getHeight();

                            // Scale overlay to ~35% of the shorter canvas edge
                            const maxDim = Math.min(canvasW, canvasH) * 0.35;
                            const imgScale = Math.min(
                                maxDim / finalImg.width,
                                maxDim / finalImg.height
                            );

                            const fabricImg = new fabric.Image(finalImg, {
                                left:   canvasW / 2,
                                top:    canvasH / 2,
                                scaleX: imgScale,
                                scaleY: imgScale,
                                angle:  0,
                                opacity: 1,
                                globalCompositeOperation: 'source-over',
                                originX: 'center',
                                originY: 'center',
                            });

                            fabricImg._uploadedDesignName = file.name;
                            fabricImg._fx = {
                                warpAmount: 0, arcAmount: 0, arcTilt: 0,
                                perspectiveTop: 0, perspectiveLeft: 0,
                                opacity: 1,
                                blurAmount: 0, noiseAmount: 0,
                                blendMode: 'normal'
                            };

                            data.extraDesignObjects   = data.extraDesignObjects   || [];
                            data.extraDesignOriginals = data.extraDesignOriginals || [];
                            data.extraDesignObjects.push(fabricImg);
                            data.extraDesignOriginals.push(finalImg);
                            _applyExtraLayerHandleStyle(fabricImg, 'overlay');

                            applyClipMaskToObject(fabricImg, data);
                            data.fabricCanvas.add(fabricImg);
                            attachFabricEvents(data, fabricImg);
                            data.fabricCanvas.requestRenderAll();

                            lastAddedByIndex[index] = fabricImg;
                        });

                        resolve();
                    };

                    if(finalImg.complete){
                        finalize();
                    } else {
                        finalImg.onload = finalize;
                    }
                };

                img.src = e.target.result;
            };

            reader.readAsDataURL(file);
        });

        await new Promise(r => requestAnimationFrame(r));
    }

    loadingIndicator.style.display = "none";
    autoSaveSession();

    // Auto-select the newly added layer when exactly one window was targeted.
    if(targetIndices.length === 1){

        const idx  = targetIndices[0];
        const data = canvasData[idx];
        const lastOverlay = lastAddedByIndex[idx];

        if(lastOverlay){
            // Select the new layer into the multi-select model
            selectedDesigns.clear();
            if(!lastOverlay._fx) lastOverlay._fx = _defaultFx(data);
            selectedDesigns.add(lastOverlay);
            if(!activeIndices.includes(idx)) activeIndices.push(idx);
            refreshFabricHandles();
            updateWindowBorders();
            updateLayerButtons();
            syncSliders();
            data.fabricCanvas.requestRenderAll();
        }
    }
});


// Toggle design-layer visibility while in clip edit mode.
// Opacity is saved and restored; nothing structural is changed.
function toggleClipLayersHidden() {
    if (!clipEditMode) return;
    clipLayersHidden = !clipLayersHidden;

    canvasData.forEach(data => {
        const wrapper = data.wrapperEl;
        const isActive = activeIndices.includes(canvasData.indexOf(data));

        if (clipLayersHidden && isActive) {
            // Save and hide
            getAllDesignObjects(data).forEach(o => {
                if (!o) return;
                o._clipHiddenOpacity = o.opacity;
                o.opacity = 0;
            });
            data.fabricCanvas.requestRenderAll();
            if (wrapper) wrapper.classList.add('clip-layers-hidden');
        } else if (!clipLayersHidden) {
            // Restore
            getAllDesignObjects(data).forEach(o => {
                if (!o) return;
                if (o._clipHiddenOpacity !== undefined) {
                    o.opacity = o._clipHiddenOpacity;
                    delete o._clipHiddenOpacity;
                }
            });
            data.fabricCanvas.requestRenderAll();
            if (wrapper) wrapper.classList.remove('clip-layers-hidden');
        }
    });

    const btn = document.getElementById('hideClipLayersBtn');
    if (btn) btn.textContent = clipLayersHidden ? '🚫 Show Layers' : '👁 Hide Layers';
}

// Restore all layers that were hidden during clip mode.
function _restoreClipLayersVisibility() {
    if (!clipLayersHidden) return;
    clipLayersHidden = false;
    canvasData.forEach(data => {
        getAllDesignObjects(data).forEach(o => {
            if (!o) return;
            if (o._clipHiddenOpacity !== undefined) {
                o.opacity = o._clipHiddenOpacity;
                delete o._clipHiddenOpacity;
            }
        });
        data.fabricCanvas.requestRenderAll();
        if (data.wrapperEl) data.wrapperEl.classList.remove('clip-layers-hidden');
    });
    const btn = document.getElementById('hideClipLayersBtn');
    if (btn) btn.textContent = '👁 Hide Layers';
}

document.getElementById("hideClipLayersBtn").addEventListener("click", toggleClipLayersHidden);

document.getElementById("editClipBtn").addEventListener("click", ()=>{

    if(!activeIndices.length){
        alert("Select at least one window");
        return;
    }

    clipEditMode = !clipEditMode;

    document.getElementById("editClipBtn").innerText =
        clipEditMode
            ? "Exit Clipping"
            : "Edit Clipping";

    document.getElementById("addClipAreaBtn").style.display =
        clipEditMode ? "inline-block" : "none";

    document.getElementById("deleteClipBtn").style.display =
        clipEditMode ? "inline-block" : "none";

    document.getElementById("copyClipBtn").style.display =
        clipEditMode ? "inline-block" : "none";

    document.getElementById("hideClipLayersBtn").style.display =
        clipEditMode ? "inline-block" : "none";

    // always hide the "to selected" button when toggling clip mode
    document.getElementById("copyClipToSelectedBtn").style.display = "none";

    // reset copy-select state when exiting clip mode
    if(!clipEditMode){
        clipCopySelectMode = false;
        clipCopySourceIndex = null;
    }

    // exiting clip mode
    if(!clipEditMode){

        // Restore any layers hidden via the Hide Layers toggle
        _restoreClipLayersVisibility();

        stopMarchingAnts();

        activeClipWindowIndex = null;

        // Restore interactivity on all design objects, background, and pattern
        canvasData.forEach(data=>{
            getAllDesignObjects(data).forEach(o=>{
                if(!o) return;
                o.selectable    = (o._prevSelectable !== undefined) ? o._prevSelectable : true;
                o.evented       = (o._prevEvented    !== undefined) ? o._prevEvented    : true;
                o.lockMovementX = false;
                o.lockMovementY = false;
                delete o._prevSelectable;
                delete o._prevEvented;
            });
            // Restore background and pattern objects
            [data.backgroundObject, data.patternFabricObj].forEach(o => {
                if(!o) return;
                o.selectable    = (o._clipPrevSelectable !== undefined) ? o._clipPrevSelectable : false;
                o.evented       = (o._clipPrevEvented    !== undefined) ? o._clipPrevEvented    : false;
                o.lockMovementX = false;
                o.lockMovementY = false;
                delete o._clipPrevSelectable;
                delete o._clipPrevEvented;
            });
            // Restore Fabric rubber-band selection state
            if(data._clipPrevFabricSelection !== undefined){
                data.fabricCanvas.selection = data._clipPrevFabricSelection;
                delete data._clipPrevFabricSelection;
            }
        });

        // Restore cursor
        document.querySelectorAll('.canvas-wrapper').forEach(w => { w.style.cursor = ''; });

        refreshFabricHandles();

        canvasData.forEach(data=>{

            clearBezierHelpers(data.fabricCanvas);

            // clearBezierHelpers now also removes rubber-band lines,
            // but remove any that slipped through on other canvases
            data.fabricCanvas.getObjects()
                .filter(obj => obj.isRubberBand)
                .forEach(obj => data.fabricCanvas.remove(obj));

            if(activeCurvePreview){
                activeCurvePreview.forEach(o=> data.fabricCanvas.remove(o));
            }

            activeCurvePreview = null;

            // keep final overlay visible
            addClipOverlay(data);

            data.fabricCanvas.requestRenderAll();
        });

        return;
    }

    // entering clip mode
    startMarchingAnts();

    // Deactivate any active toolbar tool (text/pan/select) so it doesn't
    // interfere with clip-polygon drawing on the canvas
    if(window._setActiveTool) window._setActiveTool(null);

    // Lock all objects so nothing can be accidentally moved/transformed.
    // This covers design layers, background image, and pattern overlay.
    canvasData.forEach(data=>{
        getAllDesignObjects(data).forEach(o=>{
            if(!o) return;
            o._prevSelectable = o.selectable;
            o._prevEvented    = o.evented;
            o.selectable      = false;
            o.evented         = false;
            o.lockMovementX   = true;
            o.lockMovementY   = true;
        });
        [data.backgroundObject, data.patternFabricObj].forEach(o => {
            if(!o) return;
            o._clipPrevSelectable = o.selectable;
            o._clipPrevEvented    = o.evented;
            o.selectable          = false;
            o.evented             = false;
            o.lockMovementX       = true;
            o.lockMovementY       = true;
        });
        // Disable Fabric's rubber-band selection so dragging handles
        // doesn't draw a blue selection rectangle over the canvas.
        data._clipPrevFabricSelection = data.fabricCanvas.selection;
        data.fabricCanvas.selection   = false;
        data.fabricCanvas.discardActiveObject();
        data.fabricCanvas.requestRenderAll();
    });

    // Set crosshair cursor so it's clear the user is drawing, not selecting
    document.querySelectorAll('.canvas-wrapper').forEach(w => { w.style.cursor = 'crosshair'; });

    selectedDesigns.clear();

    activeCurvePreview = null;

    const sourceData = canvasData[activeIndices[0]];

    if(
        sourceData &&
        sourceData.maskEnabled &&
        sourceData.maskPath &&
        sourceData.maskType === "bezier"
    ){

        clipCurvePoints = sourceData.maskPath.map(p=>({
            x: p.x,
            y: p.y,
            cx: p.cx,
            cy: p.cy
        }));

        clipPolygonClosed = true;

    } else {

        clipCurvePoints = [];
        clipPolygonClosed = false;
    }

    canvasData.forEach(data=>{

        addClipOverlay(data);

        // restore editable handles for selected clipping
        if(
            activeIndices.includes(canvasData.indexOf(data)) &&
            clipCurvePoints.length
        ){

            clearBezierHelpers(data.fabricCanvas);

            activeCurvePreview =
                createCurveOverlay(
                    clipCurvePoints,
                    true
                );

            activeCurvePreview.forEach(o=> data.fabricCanvas.add(o));

            drawBezierHelpers(
                data.fabricCanvas,
                clipCurvePoints
            );

            // Show nodes of all OTHER finalized paths alongside the active one
            drawInactivePaths(data.fabricCanvas, data);

            activeCurvePreview.forEach(o=> o.bringToFront());

            activeBezierHelpers.forEach(obj=>{
                obj.bringToFront();
            });
        }

        data.fabricCanvas.requestRenderAll();
    });

});


document.getElementById("addClipAreaBtn").addEventListener("click", ()=>{

    if(!clipEditMode){
        return;
    }

    pushGlobalUndo();
    clipCurvePoints = [];
    clipPolygonClosed = false;

    // next completed polygon should become
    // a NEW clipping area instead of replacing
    // the previous one
    currentMaskIndex = undefined;

    canvasData.forEach(data=>{

        clearBezierHelpers(data.fabricCanvas);

        // rebuild ALL finalized polygon overlays
        // while clearing only temporary editor helpers
        addClipOverlay(data);

        // Show all existing finalized paths as inactive nodes so user
        // can see them while drawing the new area
        if(activeIndices.includes(canvasData.indexOf(data))){
            drawInactivePaths(data.fabricCanvas, data);
        }

        data.fabricCanvas.requestRenderAll();
    });
});


document.getElementById("deleteClipBtn").addEventListener("click", ()=>{

    if(!activeIndices.length){
        return;
    }

    pushGlobalUndo();

    activeIndices.forEach(index=>{

        const data = canvasData[index];

        data.maskPaths = [];
        data.maskPath = null;
        data.maskEnabled = false;
        data.maskType = null;

        data.clipCurvePoints = [];
        data.clipPolygonClosed = false;

        if(data.designObject){
            data.designObject.clipPath = null;
        }

        if(data.extraDesignObjects){

            data.extraDesignObjects.forEach(obj=>{
                obj.clipPath = null;
            });
        }

        const canvas = data.fabricCanvas;

        canvas.getObjects()
            .filter(obj=>
                obj.excludeFromExport === true
            )
            .forEach(obj=>{
                canvas.remove(obj);
            });

        if(data.patternMode) _renderPattern(data, false);
        _recomputeProEffect(data);
        canvas.requestRenderAll();
    });

    clipCurvePoints = [];
    clipPolygonClosed = false;
    clearBezierHelpers(
        canvasData[activeIndices[0]].fabricCanvas
    );

    if(activeCurvePreview){
        activeCurvePreview.forEach(o=>
            canvasData[activeIndices[0]].fabricCanvas.remove(o)
        );
        activeCurvePreview = null;
    }
});





// ── "Copy Clipping" — enter target-selection mode ────────────────────────────
document.getElementById("copyClipBtn").addEventListener("click", ()=>{

    const srcIndex =
        activeClipWindowIndex !== null
            ? activeClipWindowIndex
            : (activeIndices.length ? activeIndices[0] : null);

    if(srcIndex === null) return;

    const src = canvasData[srcIndex];

    if(!src.maskPaths || !src.maskPaths.length){
        alert("No clipping areas to copy. Draw at least one clipping area first.");
        return;
    }

    // Save source and enter selection mode
    clipCopySourceIndex  = srcIndex;
    clipCopySelectMode   = true;

    // Clear selection so user starts fresh picking targets
    activeIndices = [];
    updateWindowBorders();

    // Swap buttons
    document.getElementById("copyClipBtn").style.display         = "none";
    document.getElementById("copyClipToSelectedBtn").style.display = "inline-block";
    // Also hide editing buttons that don't apply during target selection
    document.getElementById("addClipAreaBtn").style.display      = "none";
    document.getElementById("deleteClipBtn").style.display       = "none";
});


// ── "Copy Clipping to Selected" — apply and return to clip mode ───────────────
document.getElementById("copyClipToSelectedBtn").addEventListener("click", ()=>{

    if(clipCopySourceIndex === null) return;

    pushGlobalUndo();

    const src = canvasData[clipCopySourceIndex];

    // Normalise from canvas-pixel space to bg-image-pixel space
    const normalisedPaths = src.maskPaths.map(path=>
        path.map(p=>({
            x:  p.x  / src.previewScale,
            y:  p.y  / src.previewScale,
            ...(p.cx !== undefined ? { cx: p.cx / src.previewScale } : {}),
            ...(p.cy !== undefined ? { cy: p.cy / src.previewScale } : {})
        }))
    );

    let copied = 0;

    // Apply to every selected window (excluding the source itself)
    activeIndices.forEach(i=>{

        if(i === clipCopySourceIndex) return;

        const data = canvasData[i];
        const s    = data.previewScale;

        data.maskPaths = normalisedPaths.map(path=>
            path.map(p=>({
                x:  p.x  * s,
                y:  p.y  * s,
                ...(p.cx !== undefined ? { cx: p.cx * s } : {}),
                ...(p.cy !== undefined ? { cy: p.cy * s } : {})
            }))
        );

        data.maskPath    = data.maskPaths[data.maskPaths.length - 1];
        data.maskEnabled = true;
        data.maskType    = src.maskType;
        _syncProEffect(data);

        addClipOverlay(data);

        getAllDesignObjects(data).forEach(obj=>{
            applyClipMaskToObject(obj, data);
        });

        if(data.patternMode) _renderPattern(data, false);
        data.fabricCanvas.requestRenderAll();

        copied++;
    });

    // Restore source window as the sole selection and re-lock clip mode
    const restoredIndex = clipCopySourceIndex;
    clipCopySelectMode  = false;
    clipCopySourceIndex = null;

    // Allow the user to click any target window to start editing its clipping.
    // Leaving this set to the source would block switching to any target.
    activeClipWindowIndex = null;

    activeIndices = [restoredIndex];

    updateWindowBorders();
    updateSelectButtonState?.();

    // Restore editing buttons
    document.getElementById("copyClipToSelectedBtn").style.display = "none";
    document.getElementById("copyClipBtn").style.display           = "inline-block";
    document.getElementById("addClipAreaBtn").style.display        = "inline-block";
    document.getElementById("deleteClipBtn").style.display         = "inline-block";

    if(copied > 0){
        alert(`Clipping copied to ${copied} window${copied > 1 ? "s" : ""}.`);
    }
});


// ── Color layer button + controls ────────────────────────────────────────────
document.getElementById("addColorLayerBtn").addEventListener("click", ()=>{

    if(clipEditMode){ showClipModeNotice(); return; }

    if(!colorLayerMode){

        if(!activeIndices.length){
            alert("Select at least one window first.");
            return;
        }

        colorLayerMode = true;

        // Lock all design objects so they can't be accidentally moved/transformed,
        // AND disable Fabric's drag-to-select so it doesn't draw its blue selection
        // rectangle over the paint strokes.
        canvasData.forEach(data=>{
            getAllDesignObjects(data).forEach(o=>{
                if(!o) return;
                o._prevSelectable = o.selectable;
                o._prevEvented    = o.evented;
                o.selectable      = false;
                o.evented         = false;
            });
            data.fabricCanvas.selection = false;
            data.fabricCanvas.discardActiveObject();
            data.fabricCanvas.requestRenderAll();
        });

        selectedDesigns.clear();

        // Init color layer on every selected unlocked window
        activeIndices.forEach(i=>{
            if(canvasData[i]?.locked) return;
            initColorLayer(canvasData[i]);
            const el = canvasData[i].fabricCanvas.lowerCanvasEl;
            const wr = el && el.closest('.canvas-wrapper');
            if(wr) wr.classList.add('color-layer-mode');
        });

        document.getElementById("addColorLayerBtn").innerText       = "Exit Color Layer";
        document.getElementById("colorLayerControls").style.display = "inline-flex";
        document.getElementById("copyColorBtn").style.display       = "block";
        document.getElementById("deleteColorBtn").style.display     = "block";

        // Sync opacity/blend globals and UI inputs from the first active window
        // that already has a color layer (e.g. a just-loaded project).  If no
        // window has one yet, the defaults (1 / source-over) remain.
        for(const i of activeIndices){
            const d = canvasData[i];
            if(d?.colorLayerFabricObj){
                colorLayerOpacity   = d.colorLayerFabricObj.opacity ?? 1;
                colorLayerBlendMode = d.colorLayerFabricObj.globalCompositeOperation ?? 'source-over';
                document.getElementById("colorLayerOpacityInput").value = Math.round(colorLayerOpacity * 100);
                document.getElementById("colorLayerModeSelect").value   = colorLayerBlendMode;
                break;
            }
        }

        // Start global mousemove tracking for the brush cursor ring
        _startColorLayerCursorTracking();

    } else {

        colorLayerMode       = false;
        colorCopySelectMode  = false;
        colorCopySourceIndex = null;
        brushTool       = 'brush';
        isColorPainting = false;
        lastPaintNorm   = null;

        // Stop global mousemove tracking and hide ring
        _stopColorLayerCursorTracking();

        // Restore interactivity on all design objects and re-enable Fabric selection
        canvasData.forEach(data=>{
            getAllDesignObjects(data).forEach(o=>{
                if(!o) return;
                o.selectable = (o._prevSelectable !== undefined) ? o._prevSelectable : true;
                o.evented    = (o._prevEvented    !== undefined) ? o._prevEvented    : true;
                delete o._prevSelectable;
                delete o._prevEvented;
            });
            data.fabricCanvas.selection = true;
        });

        refreshFabricHandles();

        document.querySelectorAll('.canvas-wrapper')
            .forEach(w=> w.classList.remove('color-layer-mode'));

        document.getElementById("addColorLayerBtn").innerText       = "Paint Overlay";
        document.getElementById("colorLayerControls").style.display = "none";
        document.getElementById("copyColorBtn").style.display           = "none";
        document.getElementById("copyColorToSelectedBtn").style.display = "none";
        document.getElementById("deleteColorBtn").style.display         = "none";
        document.getElementById("brushToolBtn").classList.add("active");
        document.getElementById("eraserToolBtn").classList.remove("active");
        document.getElementById("brushColorPicker").style.visibility = '';
    }
});

document.getElementById("brushToolBtn").addEventListener("click", ()=>{
    brushTool = 'brush';
    document.getElementById("brushToolBtn").classList.add("active");
    document.getElementById("eraserToolBtn").classList.remove("active");
    document.getElementById("brushColorPicker").style.visibility = '';
});

document.getElementById("eraserToolBtn").addEventListener("click", ()=>{
    brushTool = 'eraser';
    document.getElementById("eraserToolBtn").classList.add("active");
    document.getElementById("brushToolBtn").classList.remove("active");
    document.getElementById("brushColorPicker").style.visibility = 'hidden';
});

document.getElementById("brushColorPicker").addEventListener("input", e=>{
    brushColor = e.target.value;
});

document.getElementById("brushSizeSlider").addEventListener("input", e=>{
    brushSize = parseInt(e.target.value, 10);
    // Ring size updates live on next mousemove — nothing extra needed here
});

document.getElementById("brushSoftnessSlider").addEventListener("input", e=>{
    brushSoftness = parseInt(e.target.value, 10);
});


// ── Delete Color Layer ────────────────────────────────────────────────────────
document.getElementById("deleteColorBtn").addEventListener("click", ()=>{
    if(!colorLayerMode || !activeIndices.length) return;
    pushGlobalUndo();
    activeIndices.forEach(i=>{
        const data = canvasData[i];
        if(!data.colorLayerCtx) return;
        data.colorLayerCtx.clearRect(
            0, 0,
            data.colorLayerCanvas.width,
            data.colorLayerCanvas.height
        );
        if(data.colorLayerFabricObj) data.colorLayerFabricObj.dirty = true;
        data.fabricCanvas.requestRenderAll();
    });
});


// ── "Copy Color" — enter target-selection mode ────────────────────────────────
document.getElementById("copyColorBtn").addEventListener("click", ()=>{
    if(!colorLayerMode) return;

    const srcIndex = activeIndices.length ? activeIndices[0] : null;
    if(srcIndex === null) return;

    const src = canvasData[srcIndex];
    if(!src.colorLayerCtx){
        alert("No color layer to copy. Paint something first.");
        return;
    }

    colorCopySourceIndex = srcIndex;
    colorCopySelectMode  = true;

    // Keep source selected and highlighted so the user knows which window they're copying from
    activeIndices = [srcIndex];
    updateWindowBorders();

    // Restore normal cursor — stop the brush ring and remove cursor:none from wrappers
    _stopColorLayerCursorTracking();
    document.querySelectorAll('.canvas-wrapper.color-layer-mode')
        .forEach(w => w.style.cursor = '');

    // Swap buttons
    document.getElementById("copyColorBtn").style.display           = "none";
    document.getElementById("copyColorToSelectedBtn").style.display = "block";
    document.getElementById("deleteColorBtn").style.display         = "none";
});


// ── "Copy Color to Selected" — apply and return ───────────────────────────────
document.getElementById("copyColorToSelectedBtn").addEventListener("click", ()=>{
    if(colorCopySourceIndex === null) return;

    pushGlobalUndo();

    const src = canvasData[colorCopySourceIndex];
    let copied = 0;

    activeIndices.forEach(i=>{
        if(i === colorCopySourceIndex) return;

        const tgt = canvasData[i];

        // Init color layer on target if it doesn't have one
        initColorLayer(tgt);

        // Scale source color layer to fit target canvas dimensions
        const tmpCanvas    = document.createElement('canvas');
        tmpCanvas.width    = tgt.colorLayerCanvas.width;
        tmpCanvas.height   = tgt.colorLayerCanvas.height;
        const tmpCtx       = tmpCanvas.getContext('2d');
        tmpCtx.drawImage(
            src.colorLayerCanvas,
            0, 0,
            tgt.colorLayerCanvas.width,
            tgt.colorLayerCanvas.height
        );

        // Replace target color layer content
        tgt.colorLayerCtx.clearRect(0, 0, tgt.colorLayerCanvas.width, tgt.colorLayerCanvas.height);
        tgt.colorLayerCtx.drawImage(tmpCanvas, 0, 0);

        // Sync blend mode and opacity from source
        if(tgt.colorLayerFabricObj && src.colorLayerFabricObj){
            tgt.colorLayerFabricObj.set({
                opacity: src.colorLayerFabricObj.opacity,
                globalCompositeOperation: src.colorLayerFabricObj.globalCompositeOperation
            });
            tgt.colorLayerFabricObj.dirty = true;
        }

        // Ensure the target also gets the color-layer-mode CSS class for painting
        const el = tgt.fabricCanvas.lowerCanvasEl;
        const wr = el && el.closest('.canvas-wrapper');
        if(wr) wr.classList.add('color-layer-mode');

        tgt.fabricCanvas.requestRenderAll();
        copied++;
    });

    // Restore source as sole active window
    colorCopySelectMode  = false;
    colorCopySourceIndex = null;
    const restoredIdx = canvasData.indexOf(src);
    activeIndices = restoredIdx !== -1 ? [restoredIdx] : [];

    updateWindowBorders();
    updateSelectButtonState?.();

    // Re-enable brush cursor — restore cursor:none and restart ring tracking
    document.querySelectorAll('.canvas-wrapper.color-layer-mode')
        .forEach(w => w.style.cursor = 'none');
    _startColorLayerCursorTracking();

    // Restore buttons
    document.getElementById("copyColorToSelectedBtn").style.display = "none";
    document.getElementById("copyColorBtn").style.display           = "block";
    document.getElementById("deleteColorBtn").style.display         = "block";

    if(copied > 0){
        alert(`Color layer copied to ${copied} window${copied > 1 ? "s" : ""}.`);
    }
});


// Global Cmd/Ctrl+Z → Undo, Cmd/Ctrl+Shift+Z → Redo
// (Clip-mode in-progress point removal is handled by its own guarded handler
//  which calls stopPropagation, so it takes priority when clipEditMode is true.)
document.addEventListener('keydown', function(e){
    if(!(e.metaKey || e.ctrlKey)) return;
    if(e.key.toLowerCase() !== 'z') return;
    if(clipEditMode) return;    // clip's own handler deals with it
    e.preventDefault();
    e.stopPropagation();
    // While painting, Ctrl+Z undoes the last stroke on every active window
    // (uses per-window colorLayerHistory). Redo is not supported in paint mode.
    if(colorLayerMode && !e.shiftKey){
        activeIndices.forEach(i => {
            const d = canvasData[i];
            if(d) undoColorLayer(d);
        });
        return;
    }
    if(e.shiftKey){
        performGlobalRedo();
    } else {
        performGlobalUndo();
    }
});

document.addEventListener('keydown', function(e){
    if(!(e.metaKey || e.ctrlKey)) return;
    if(e.key.toLowerCase() !== 'a') return;
    const tag = document.activeElement?.tagName;
    if(tag === 'INPUT' || tag === 'TEXTAREA') return;
    e.preventDefault();
    document.getElementById('selectAllBtn').click();
});

// Ctrl/Cmd+S — save progress
document.addEventListener('keydown', function(e){
    if(!(e.metaKey || e.ctrlKey)) return;
    if(e.key.toLowerCase() !== 's') return;
    e.preventDefault();
    document.getElementById('saveProgressBtn').click();
});

// Backspace — delete selected windows, or just the selected extra layers if
// Backspace in clip mode — delete the last placed anchor point.
document.addEventListener('keydown', function(e){
    if(e.key !== 'Backspace') return;
    if(!clipEditMode) return;
    if(clipPolygonClosed) return; // polygon finished; nothing in-progress to undo

    const tag = document.activeElement?.tagName;
    if(tag === 'INPUT' || tag === 'TEXTAREA') return;
    if(document.activeElement?.isContentEditable) return;

    if(!clipCurvePoints.length) return;

    e.preventDefault();
    e.stopPropagation();

    clipCurvePoints.pop();

    const activeCanvas = window.__activeClipCanvas;
    const redraw       = window.__activeClipRedraw;

    if(activeCanvas){
        activeCanvas.getObjects()
            .filter(obj => obj.excludeFromExport && obj !== activeCanvas.backgroundImage)
            .forEach(obj => activeCanvas.remove(obj));
    }
    activeCurvePreview = null;

    if(clipCurvePoints.length && redraw){
        redraw();
    } else if(activeCanvas){
        activeCanvas.requestRenderAll();
    }
});

// only non-main design layers are selected (main design is NOT in selection).
document.addEventListener('keydown', function(e){
    if(e.key !== 'Backspace' && e.key !== 'Delete') return;

    // Never fire when the user is typing in a text field or editable element.
    const tag = document.activeElement?.tagName;
    if(tag === 'INPUT' || tag === 'TEXTAREA') return;
    if(document.activeElement?.isContentEditable) return;

    // Respect special modes that have their own keyboard handling.
    if(clipEditMode || designEraserMode || designWarpMode) return;
    if(!activeIndices.length) return;

    e.preventDefault();

    // Build a set of ALL extra design objects across active windows so we can
    // classify what's in selectedDesigns.
    const extraObjsInActiveWindows = new Set();
    activeIndices.forEach(i => {
        const d = canvasData[i];
        if(d) (d.extraDesignObjects || []).forEach(o => extraObjsInActiveWindows.add(o));
    });

    // Check whether any selected design is the MAIN design of its window.
    const selectedArr = [...selectedDesigns];
    const hasMainSelected = selectedArr.some(obj =>
        canvasData.some(d => d.designObject === obj)
    );

    // Extra-layer-only deletion: all selected objects are extra layers (none
    // are main designs).  Delete just those layers and leave the windows intact.
    const extraToDelete = selectedArr.filter(obj => extraObjsInActiveWindows.has(obj));
    if(selectedDesigns.size > 0 && !hasMainSelected && extraToDelete.length > 0){
        // Snapshot before mutation so Ctrl+Z can restore the deleted layers.
        // pushGlobalUndo captures captureWindowState which includes `duplicates`
        // (the full extraDesignObjects list), so restoreWindowState will rebuild them.
        const affectedIndices = activeIndices.filter(i => {
            const d = canvasData[i];
            return d && (d.extraDesignObjects || []).some(o => selectedDesigns.has(o));
        });
        if(!affectedIndices.length) return;

        // Push undo for each affected window.
        globalUndoStack.push({
            affected: affectedIndices,
            states: affectedIndices.map(i => captureWindowState(canvasData[i]))
        });
        if(globalUndoStack.length > MAX_UNDO_HISTORY) globalUndoStack.shift();
        globalRedoStack = [];
        updateUndoRedoButtons();
        _markDirty();

        // Remove the selected extra layers from each window.
        affectedIndices.forEach(i => {
            const d = canvasData[i];
            if(!d || !d.extraDesignObjects) return;
            const toRemove = new Set(d.extraDesignObjects.filter(o => selectedDesigns.has(o)));
            if(!toRemove.size) return;

            toRemove.forEach(obj => d.fabricCanvas.remove(obj));

            // Rebuild the arrays, keeping originals aligned with their objects.
            const newExtras     = [];
            const newOriginals  = [];
            d.extraDesignObjects.forEach((obj, idx) => {
                if(!toRemove.has(obj)){
                    newExtras.push(obj);
                    newOriginals.push(d.extraDesignOriginals?.[idx] ?? null);
                }
            });
            d.extraDesignObjects  = newExtras;
            d.extraDesignOriginals = newOriginals;
            d.fabricCanvas.requestRenderAll();
        });

        selectedDesigns.clear();
        refreshFabricHandles();
        updateWindowBorders();
        updateLayerButtons();
        syncSliders();
        return;
    }

    // Default: delete the active windows (same behaviour as the Delete button).
    deleteSelectedWindows();
});

// L — lock selected windows
document.addEventListener('keydown', function(e){
    if(e.key.toLowerCase() !== 'l') return;
    if(e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;

    const tag = document.activeElement?.tagName;
    if(tag === 'INPUT' || tag === 'TEXTAREA') return;
    if(document.activeElement?.isContentEditable) return;

    if(clipEditMode || designEraserMode || designWarpMode) return;
    if(!activeIndices.length) return;

    e.preventDefault();
    lockSelectedWindows();
});

// U — unselect all windows
document.addEventListener('keydown', function(e){
    if(e.key.toLowerCase() !== 'u') return;
    if(e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;

    const tag = document.activeElement?.tagName;
    if(tag === 'INPUT' || tag === 'TEXTAREA') return;
    if(document.activeElement?.isContentEditable) return;

    if(clipEditMode || designEraserMode || designWarpMode) return;

    e.preventDefault();
    _deselectAll();
});

// E — toggle design eraser mode on/off
document.addEventListener('keydown', function(e){
    if(e.key.toLowerCase() !== 'e') return;
    if(e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;

    const tag = document.activeElement?.tagName;
    if(tag === 'INPUT' || tag === 'TEXTAREA') return;
    if(document.activeElement?.isContentEditable) return;

    if(clipEditMode || designWarpMode) return;

    e.preventDefault();
    if(designEraserMode) {
        exitDesignEraserMode();
    } else {
        tryEnterDesignEraserMode();
    }
});

// T — toggle text tool on/off
document.addEventListener('keydown', function(e){
    if(e.key.toLowerCase() !== 't') return;
    if(e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;

    const tag = document.activeElement?.tagName;
    if(tag === 'INPUT' || tag === 'TEXTAREA') return;
    if(document.activeElement?.isContentEditable) return;

    e.preventDefault();
    if(typeof window._setActiveTool === 'function') window._setActiveTool('text');
});

// S — toggle marquee-select tool on/off
document.addEventListener('keydown', function(e){
    if(e.key.toLowerCase() !== 's') return;
    if(e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;

    const tag = document.activeElement?.tagName;
    if(tag === 'INPUT' || tag === 'TEXTAREA') return;
    if(document.activeElement?.isContentEditable) return;

    e.preventDefault();
    if(typeof window._setActiveTool === 'function') window._setActiveTool('select');
});

// C — toggle clipping mode on/off
document.addEventListener('keydown', function(e){
    if(e.key.toLowerCase() !== 'c') return;
    if(e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;

    const tag = document.activeElement?.tagName;
    if(tag === 'INPUT' || tag === 'TEXTAREA') return;
    if(document.activeElement?.isContentEditable) return;

    e.preventDefault();
    document.getElementById('editClipBtn').click();
});

// P — toggle pattern mode on/off
document.addEventListener('keydown', function(e){
    if(e.key.toLowerCase() !== 'p') return;
    if(e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;

    const tag = document.activeElement?.tagName;
    if(tag === 'INPUT' || tag === 'TEXTAREA') return;
    if(document.activeElement?.isContentEditable) return;

    if(clipEditMode || designEraserMode || designWarpMode) return;
    if(!activeIndices.length) return;

    e.preventDefault();
    const toggle = document.getElementById('patternModeToggle');
    if(toggle){
        toggle.checked = !toggle.checked;
        toggle.dispatchEvent(new Event('change'));
    }
});

// R — reset selected mockup window
document.addEventListener('keydown', function(e){
    if(e.key.toLowerCase() !== 'r') return;
    if(e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;

    const el = document.activeElement;
    // Block R when typing in a text field, but allow it through for range sliders
    // so dragging a warp slider then pressing R still resets the design.
    if(el?.tagName === 'TEXTAREA') return;
    if(el?.tagName === 'INPUT' && el?.type !== 'range') return;
    if(el?.isContentEditable) return;

    if(clipEditMode || designEraserMode || designWarpMode) return;
    if(!activeIndices.length) return;

    e.preventDefault();
    document.getElementById('resetBtn').click();
    document.activeElement?.blur();
});

// H — toggle layer visibility in clip mode
document.addEventListener('keydown', function(e){
    if(e.key.toLowerCase() !== 'h') return;
    if(e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;

    const tag = document.activeElement?.tagName;
    if(tag === 'INPUT' || tag === 'TEXTAREA') return;
    if(document.activeElement?.isContentEditable) return;

    if(!clipEditMode) return;

    e.preventDefault();
    toggleClipLayersHidden();
});

// W — toggle free-form mesh warp on/off
document.addEventListener('keydown', function(e){
    if(e.key.toLowerCase() !== 'w') return;
    if(e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;

    const tag = document.activeElement?.tagName;
    if(tag === 'INPUT' || tag === 'TEXTAREA') return;
    if(document.activeElement?.isContentEditable) return;

    if(clipEditMode || designEraserMode) return;
    if(!designWarpMode && !activeIndices.length) return;

    e.preventDefault();
    document.getElementById('designWarpBtn').click();
});

// F — center / fit view
document.addEventListener('keydown', function(e){
    if(e.key.toLowerCase() !== 'f') return;
    if(e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;

    const tag = document.activeElement?.tagName;
    if(tag === 'INPUT' || tag === 'TEXTAREA') return;
    if(document.activeElement?.isContentEditable) return;

    e.preventDefault();
    document.getElementById('centerViewBtn').click();
});

// Ctrl/Cmd+L — load progress
document.addEventListener('keydown', function(e){
    if(!(e.metaKey || e.ctrlKey)) return;
    if(e.key.toLowerCase() !== 'l') return;

    const tag = document.activeElement?.tagName;
    if(tag === 'INPUT' || tag === 'TEXTAREA') return;
    if(document.activeElement?.isContentEditable) return;

    e.preventDefault();
    document.getElementById('loadProgressBtn').click();
});

// Ctrl/Cmd+D — duplicate selected window(s)
document.addEventListener('keydown', function(e){
    if(!(e.metaKey || e.ctrlKey)) return;
    if(e.key.toLowerCase() !== 'd') return;

    const tag = document.activeElement?.tagName;
    if(tag === 'INPUT' || tag === 'TEXTAREA') return;
    if(document.activeElement?.isContentEditable) return;

    if(clipEditMode || designEraserMode || designWarpMode) return;
    if(!activeIndices.length) return;

    e.preventDefault();
    document.getElementById('duplicateWindowsBtn').click();
});

// D — duplicate selected layer
document.addEventListener('keydown', function(e){
    if(e.metaKey || e.ctrlKey || e.altKey) return;
    if(e.key.toLowerCase() !== 'd') return;

    const tag = document.activeElement?.tagName;
    if(tag === 'INPUT' || tag === 'TEXTAREA') return;
    if(document.activeElement?.isContentEditable) return;

    if(clipEditMode || designEraserMode || designWarpMode) return;

    e.preventDefault();
    document.getElementById('duplicateLayerBtn').click();
});

// Ctrl/Cmd+E — export
document.addEventListener('keydown', function(e){
    if(!(e.metaKey || e.ctrlKey)) return;
    if(e.key.toLowerCase() !== 'e') return;

    const tag = document.activeElement?.tagName;
    if(tag === 'INPUT' || tag === 'TEXTAREA') return;
    if(document.activeElement?.isContentEditable) return;

    if(clipEditMode || designEraserMode || designWarpMode) return;

    e.preventDefault();
    document.getElementById('exportBtn').click();
});

document.getElementById("colorLayerOpacityInput").addEventListener("mousedown", ()=>{
    if(!_sliderUndoLocked){ _sliderUndoLocked = true; pushGlobalUndo(); }
});
document.getElementById("colorLayerOpacityInput").addEventListener("mouseup", ()=>{
    _sliderUndoLocked = false;
});
document.getElementById("colorLayerOpacityInput").addEventListener("input", e=>{
    colorLayerOpacity =
        Math.max(0, Math.min(100, parseInt(e.target.value, 10) || 0)) / 100;

    activeIndices.forEach(i=>{
        const d = canvasData[i];
        if(d.colorLayerFabricObj){
            d.colorLayerFabricObj.set('opacity', colorLayerOpacity);
            d.fabricCanvas.requestRenderAll();
        }
    });
    _markDirty();
    autoSaveSession();
});

document.getElementById("colorLayerModeSelect").addEventListener("mousedown", ()=>{
    if(!_sliderUndoLocked){ _sliderUndoLocked = true; pushGlobalUndo(); }
});
document.getElementById("colorLayerModeSelect").addEventListener("change", e=>{
    _sliderUndoLocked = false;
    colorLayerBlendMode = e.target.value;

    activeIndices.forEach(i=>{
        const d = canvasData[i];
        if(d.colorLayerFabricObj){
            d.colorLayerFabricObj.set('globalCompositeOperation', colorLayerBlendMode);
            d.fabricCanvas.requestRenderAll();
        }
    });
    _markDirty();
    autoSaveSession();
});


function attachClipDrawing(wrapper, fabricCanvas, data, index){

    function redrawEditor(){

        activeIndices.forEach(i=>{

            const target = canvasData[i];
            const targetCanvas = target.fabricCanvas;

            // remove ONLY temporary editor visuals
            // keep finalized clipping overlays visible
            targetCanvas.getObjects()
                .filter(obj =>
                    obj.isBezierHelper ||
                    obj.isTempCurvePreview ||
                    obj.isRubberBand
                )
                .forEach(obj=>{
                    targetCanvas.remove(obj);
                });

            if(!clipCurvePoints.length){
                // No active path being drawn — show all finalized paths as inactive nodes
                drawInactivePaths(targetCanvas, target);
                targetCanvas.requestRenderAll();
                return;
            }

            const overlays =
                createCurveOverlay(
                    clipCurvePoints,
                    clipPolygonClosed
                );

            overlays.forEach(o=> targetCanvas.add(o));

            // Photoshop-style workflow:
            // while user is still drawing the polygon,
            // do NOT show anchor handles or bezier controls.
            // This keeps clicks precise near previous points.
            if(clipPolygonClosed){

                drawBezierHelpers(
                    targetCanvas,
                    clipCurvePoints
                );

                // Show nodes of all OTHER finalized paths alongside the active one
                drawInactivePaths(targetCanvas, target);

                overlays.forEach(o=> o.bringToFront());

                activeBezierHelpers.forEach(obj=>{
                    obj.bringToFront();
                });
            }

            targetCanvas.requestRenderAll();
        });
    }

    function finalizePolygon(){

        activeIndices.forEach(i=>{

            const target = canvasData[i];

            target.maskEnabled = true;
            target.maskType = "bezier";
            _syncProEffect(target);

            if(!target.maskPaths){
                target.maskPaths = [];
            }

            const finalizedMask =
                clipCurvePoints.map(p=>({
                    x: p.x,
                    y: p.y,
                    cx: p.cx,
                    cy: p.cy
                }));

            // editing an existing finalized polygon
            if(
                clipPolygonClosed &&
                currentMaskIndex !== undefined &&
                target.maskPaths[currentMaskIndex]
            ){

                target.maskPaths[currentMaskIndex] =
                    finalizedMask;

            } else {

                // creating a brand new polygon
                target.maskPaths.push(finalizedMask);

                // remember which polygon is now active
                currentMaskIndex =
                    target.maskPaths.length - 1;
            }

            target.maskPath = finalizedMask;

            backgroundMaskTemplates[target.bgName] = {
                maskEnabled: true,
                maskType: "bezier",
                maskPaths: target.maskPaths.map(path => path.map(p => ({...p}))),
                maskPath: finalizedMask.map(p => ({...p}))
            };

            addClipOverlay(target);

            getAllDesignObjects(target).forEach(obj=>{
                applyClipMaskToObject(obj, target);
            });

            if(target.patternMode) _renderPattern(target, false);
            target.fabricCanvas.requestRenderAll();
        });
        autoSaveSession();
    }

    // only attach ONE global undo listener
    if(!window.__clipUndoAttached){

        window.__clipUndoAttached = true;

        window.__activeClipCanvas = null;
        window.__activeClipRedraw = null;

        document.addEventListener('keydown', function(e){

            if(!clipEditMode){
                return;
            }

            if(
                (e.metaKey || e.ctrlKey) &&
                e.key.toLowerCase() === 'z'
            ){

                e.preventDefault();
                e.stopPropagation();

                if(!clipCurvePoints.length){
                    return;
                }

                // remove ONLY the last point
                clipCurvePoints.pop();

                const activeCanvas =
                    window.__activeClipCanvas;

                const redraw =
                    window.__activeClipRedraw;

                if(!activeCanvas || !redraw){
                    return;
                }

                // remove ONLY temporary editor objects
                activeCanvas.getObjects()
                    .filter(obj=>
                        obj.excludeFromExport &&
                        obj !== activeCanvas.backgroundImage
                    )
                    .forEach(obj=>{
                        activeCanvas.remove(obj);
                    });

                activeCurvePreview = null;

                // redraw remaining points ONLY
                if(clipCurvePoints.length){

                    redraw();

                } else {

                    activeCanvas.requestRenderAll();
                }
            }
        });
    }

    // IMPORTANT:
    // do NOT globally overwrite the active clipping canvas during setup.
    // Every canvas calls attachClipDrawing() on load,
    // so the LAST canvas initialized becomes the active undo target.
    // That caused cmd+z from window 2 to redraw into window 3.

    fabricCanvas.on('mouse:down', function(opt){

        if(!clipEditMode) return;

        const liveIdx = canvasData.indexOf(data);
        if (liveIdx === -1) return;

        // first click locks clipping to this window
        if(activeClipWindowIndex === null){

            activeClipWindowIndex = liveIdx;

            // Load this canvas's existing clip data (e.g. from Copy Clipping)
            // into the editor globals and draw the bezier handles so it is
            // immediately editable, just like the original source window.
            const thisData = canvasData[liveIdx];
            if(thisData?.maskPath?.length){
                clipCurvePoints    = thisData.maskPath.map(p => ({ ...p }));
                clipPolygonClosed  = true;
            } else {
                clipCurvePoints   = [];
                clipPolygonClosed = false;
            }

            clearBezierHelpers(fabricCanvas);

            if(clipCurvePoints.length){
                // Draw the editable overlay (marching-ant path + anchor nodes)
                activeCurvePreview = createCurveOverlay(clipCurvePoints, true);
                activeCurvePreview.forEach(o => fabricCanvas.add(o));
                drawBezierHelpers(fabricCanvas, clipCurvePoints);
                drawInactivePaths(fabricCanvas, thisData);
                activeCurvePreview.forEach(o => o.bringToFront());
                activeBezierHelpers.forEach(obj => obj.bringToFront());
            }

            window.__activeClipCanvas = fabricCanvas;
            window.__activeClipRedraw = redrawEditor;
            fabricCanvas.requestRenderAll();

            // If existing clip data was loaded, stop here — the activation
            // click should not also move an anchor or add a new point.
            // For a fresh window (no clip yet), fall through so this first
            // click begins drawing the polygon.
            if(clipCurvePoints.length) return;
        }

        // In copy-select mode the user is picking target windows —
        // don't block or draw on any canvas, just let the wrapper
        // click handler handle the selection.
        if(clipCopySelectMode) return;

        // prevent drawing on other windows
        if(liveIdx !== activeClipWindowIndex){

            showClipModeNotice();
            return;
        }

        // set the CURRENT active clipping editor ONLY
        // when the user actually interacts with this canvas
        window.__activeClipCanvas = fabricCanvas;
        window.__activeClipRedraw = redrawEditor;

        const pointer = fabricCanvas.getPointer(opt.e);

        let clickedHandle = null;

        activeBezierHelpers.forEach(obj=>{

            if(
                obj.isBezierHandle &&
                Math.abs(obj.left - pointer.x) < 10 &&
                Math.abs(obj.top - pointer.y) < 10
            ){
                clickedHandle = obj;
            }
        });

        // IMPORTANT:
        // do not allow handle editing while polygon
        // is still being drawn. User must fully close
        // polygon first before curvature editing begins.
        if(clickedHandle){

            if(!clipPolygonClosed){
                return;
            }

            currentCurveHandle =
                clipCurvePoints[clickedHandle.pointIndex];

            isDraggingCurveHandle = true;
            pushGlobalUndo();   // capture before bezier handle adjustment

            return;
        }

        // allow moving anchor points ONLY after polygon closes
        if(clipPolygonClosed){

            let clickedAnchor = null;

            clipCurvePoints.forEach(point=>{

                if(
                    Math.abs(point.x - pointer.x) < 10 &&
                    Math.abs(point.y - pointer.y) < 10
                ){
                    clickedAnchor = point;
                }
            });

            if(clickedAnchor){

                currentCurveHandle = clickedAnchor;
                currentCurveHandle.isAnchorPoint = true;

                isDraggingCurveHandle = true;
                pushGlobalUndo();   // capture before anchor point adjustment

                return;
            }
        }

        // Click on an inactive (other finalized) path's anchor node →
        // switch the editor to that path. Works whether we just finished
        // a path (clipPolygonClosed=true) or are about to start a new one
        // (clipCurvePoints.length===0). Does NOT intercept mid-drawing clicks.
        if(clipCurvePoints.length === 0 || clipPolygonClosed){

            let hitInactive = null;

            activeBezierHelpers.forEach(obj => {
                if(
                    obj.isInactiveAnchor &&
                    Math.abs(obj.left - pointer.x) < 10 &&
                    Math.abs(obj.top  - pointer.y) < 10
                ){
                    hitInactive = obj;
                }
            });

            if(hitInactive !== null){

                const targetPath =
                    data.maskPaths &&
                    data.maskPaths[hitInactive.inactivePathIndex];

                if(targetPath){

                    pushGlobalUndo();

                    clipCurvePoints =
                        targetPath.map(p => ({
                            x:  p.x,
                            y:  p.y,
                            cx: p.cx,
                            cy: p.cy
                        }));

                    clipPolygonClosed = true;
                    currentMaskIndex  = hitInactive.inactivePathIndex;

                    window.__activeClipCanvas = fabricCanvas;
                    window.__activeClipRedraw = redrawEditor;

                    redrawEditor();
                    return;
                }
            }
        }

        if(!clipCurvePoints.length){

            activeIndices.forEach(i=>{

                const target = canvasData[i];

                // remove ONLY temporary editor helpers
                // keep finalized clipping overlays visible
                target.fabricCanvas.getObjects().forEach(obj=>{

                    const isPersistentOverlay =
                        target.clipOverlays &&
                        target.clipOverlays.includes(obj);

                    if(
                        obj.excludeFromExport &&
                        !isPersistentOverlay
                    ){
                        target.fabricCanvas.remove(obj);
                    }
                });

                target.fabricCanvas.requestRenderAll();
            });

            clearBezierHelpers(fabricCanvas);
        }

        if(clipCurvePoints.length >= 3){

            const first = clipCurvePoints[0];

            const dx = pointer.x - first.x;
            const dy = pointer.y - first.y;

            const dist = Math.sqrt(dx * dx + dy * dy);

            // larger click tolerance so user can
            // close polygon by clicking anywhere
            // on the visible first anchor point
            if(dist < 34){

                pushGlobalUndo();   // capture before polygon is closed/finalized
                clipPolygonClosed = true;

                finalizePolygon();

                redrawEditor();

                return;
            }
        }

        // once polygon is closed, prevent adding new anchors
        if(clipPolygonClosed){
            return;
        }

        clipCurvePoints.push({
            x:pointer.x,
            y:pointer.y
        });

        redrawEditor();
    });

    fabricCanvas.on('mouse:move', function(opt){

        if(!clipEditMode) return;

        const liveIdx = canvasData.indexOf(data);
        if (liveIdx === -1) return;

        // Rubber-band: live tether line from the last placed point to the
        // cursor so the user sees the next segment before clicking — same
        // feel as the Photoshop pen tool.
        if(
            !isDraggingCurveHandle &&
            !clipPolygonClosed    &&
            clipCurvePoints.length > 0 &&
            liveIdx === activeClipWindowIndex
        ){
            const pointer = fabricCanvas.getPointer(opt.e);
            const last    = clipCurvePoints[clipCurvePoints.length - 1];

            // clear any stale rubber-band lines from this canvas
            fabricCanvas.getObjects()
                .filter(obj => obj.isRubberBand)
                .forEach(obj => fabricCanvas.remove(obj));

            const rbCommon = {
                strokeWidth:       1,
                strokeDashArray:   [4, 4],
                selectable:        false,
                evented:           false,
                excludeFromExport: true,
                isRubberBand:      true,
                objectCaching:     false
            };

            // dark layer
            const rbDark = new fabric.Line(
                [last.x, last.y, pointer.x, pointer.y],
                { ...rbCommon, stroke: 'rgba(0,0,0,0.85)',
                  strokeDashOffset: _marchingAntsOffset }
            );

            // white layer — interleaved with dark
            const rbLight = new fabric.Line(
                [last.x, last.y, pointer.x, pointer.y],
                { ...rbCommon, stroke: 'rgba(255,255,255,0.92)',
                  strokeDashOffset: (_marchingAntsOffset + 4) % 8 }
            );

            fabricCanvas.add(rbDark);
            fabricCanvas.add(rbLight);
            rbDark.bringToFront();
            rbLight.bringToFront();
            fabricCanvas.requestRenderAll();
            return;
        }

        if(
            !isDraggingCurveHandle ||
            !currentCurveHandle
        ){
            return;
        }

        const pointer = fabricCanvas.getPointer(opt.e);

        // dragging anchor points
        if(currentCurveHandle.isAnchorPoint){

            currentCurveHandle.x = pointer.x;
            currentCurveHandle.y = pointer.y;

            redrawEditor();

            finalizePolygon();

            return;
        }

        // bezier handle editing
        const dx = pointer.x - currentCurveHandle.x;
        const dy = pointer.y - currentCurveHandle.y;

        const maxHandleDistance = 120;

        const distance =
            Math.sqrt(dx * dx + dy * dy);

        if(distance > maxHandleDistance){

            const scale =
                maxHandleDistance / distance;

            currentCurveHandle.cx =
                currentCurveHandle.x + (dx * scale);

            currentCurveHandle.cy =
                currentCurveHandle.y + (dy * scale);

        } else {

            currentCurveHandle.cx = pointer.x;
            currentCurveHandle.cy = pointer.y;
        }

        redrawEditor();

        // keep finalized polygon overlays and clip paths
        // updating live while dragging bezier handles
        // so curvature changes render in real time
        if(clipPolygonClosed){
            finalizePolygon();
        }
    });

    fabricCanvas.on('mouse:up', function(){

        if(
            clipEditMode &&
            clipPolygonClosed &&
            currentCurveHandle
        ){
            finalizePolygon();
        }

        isDraggingCurveHandle = false;

        if(currentCurveHandle){
            delete currentCurveHandle.isAnchorPoint;
        }

        currentCurveHandle = null;
    });

    // ── Color layer painting ─────────────────────────────────────────────────
    fabricCanvas.on('mouse:down', function(opt){
        if(!colorLayerMode) return;
        if(colorCopySelectMode) return;   // no painting while picking copy targets
        // Recompute the live index: windows are inserted via unshift, so the
        // index captured at attach time goes stale as more windows are added.
        if(!activeIndices.includes(canvasData.indexOf(data))) return;

        // Ensure color layer exists on every active window
        activeIndices.forEach(i=>{
            if(!canvasData[i].colorLayerFabricObj) initColorLayer(canvasData[i]);
        });

        // Snapshot before every stroke for undo
        pushGlobalUndo();

        const ptr  = fabricCanvas.getPointer(opt.e);
        const norm = { x: ptr.x / data.previewScale, y: ptr.y / data.previewScale };

        isColorPainting = true;
        lastPaintNorm   = norm;
        paintAtNorm(norm.x, norm.y);
    });

    fabricCanvas.on('mouse:move', function(opt){
        if(!colorLayerMode) return;

        if(!isColorPainting) return;
        // Recompute the live index (see mouse:down note above).
        if(!activeIndices.includes(canvasData.indexOf(data))) return;

        const ptr  = fabricCanvas.getPointer(opt.e);
        const norm = { x: ptr.x / data.previewScale, y: ptr.y / data.previewScale };

        if(lastPaintNorm){
            interpolatePaint(lastPaintNorm, norm);
        } else {
            paintAtNorm(norm.x, norm.y);
        }

        lastPaintNorm = norm;
    });

    fabricCanvas.on('mouse:up', function(){
        if(!colorLayerMode) return;
        if(isColorPainting){
            // Mark every window that received paint strokes as a PRO window
            activeIndices.forEach(i => {
                if(canvasData[i] && canvasData[i].colorLayerFabricObj) _syncProEffect(canvasData[i]);
            });
            autoSaveSession();
        }
        isColorPainting = false;
        lastPaintNorm   = null;
    });

    // Hide cursor ring when mouse leaves this canvas wrapper
    if(fabricCanvas.wrapperEl){
        fabricCanvas.wrapperEl.addEventListener('mouseleave', function(){
            if(colorLayerMode) hideBrushCursor();
        });
    }
}


document.getElementById("undoBtn").addEventListener("click", () => performGlobalUndo());
document.getElementById("redoBtn").addEventListener("click", () => performGlobalRedo());

// ── Upgrade prompt (top bar) ──────────────────────────────────────────────────
(function(){
    var close = document.getElementById('upgradePromptClose');
    if(close){
        close.addEventListener('click', () => {
            var bar = document.getElementById('upgradePrompt');
            if(bar) bar.style.display = 'none';
            localStorage.setItem('ms_upgrade_prompt_dismissed', '1');
            // ResizeObserver on .sticky-header fires automatically when the
            // banner collapses — no manual requestAnimationFrame needed.
        });
    }
    var link = document.getElementById('upgradePromptLink');
    if(link){
        link.addEventListener('click', e => {
            e.preventDefault();
            if (typeof openPlansModal === 'function') openPlansModal();
        });
    }
})();



document.getElementById("resetBtnTop").addEventListener("click", () =>
    document.getElementById("resetBtn").click());

document.getElementById("resetBtn").addEventListener("click", async ()=>{

    if(!activeIndices.length) return;

    pushGlobalUndo();

    for (const index of activeIndices) {
        await resetWindowToBaseline(canvasData[index]);
    }

    _resetLeftPanelToDefaults();

    refreshFabricHandles();
    updateLayerButtons();
    syncSliders();
    autoSaveSession();
});





function buildSnapshot(){

    return canvasData.map((data, index)=>{

        const mainObj = data.designObject;

        return {

            bgSrc: data.bg.src,
            bgName: data.bgName,

            designSrc: _originalToSrc(data.designOriginal),
            designName: data.designName,

            // Normalise position the same way scaleX/scaleY are normalised:
            // divide by previewScale so the value is in background-image pixels,
            // not in preview-canvas pixels.  The restore path multiplies back up
            // by the new previewScale, keeping the relative position intact.
            // Use getCenterPoint() so the saved coordinate is always the object
            // centre, regardless of whether originX is 'left' (mesh-warp Apply
            // creates images with originX:'left') or 'center' (normal
            // applyWarpToData).  The restore path always recreates images with
            // originX:'center', so saving the centre avoids a half-width shift.
            x: mainObj
                ? (typeof mainObj.getCenterPoint === 'function'
                    ? (mainObj.getCenterPoint().x / data.previewScale)
                    : (mainObj.left / data.previewScale))
                : (data.x / (data.previewScale || 1)),
            y: mainObj
                ? (typeof mainObj.getCenterPoint === 'function'
                    ? (mainObj.getCenterPoint().y / data.previewScale)
                    : (mainObj.top / data.previewScale))
                : (data.y / (data.previewScale || 1)),

            // Persist the reset-target position so the Reset button restores
            // the design to the correct canvas centre after a save-restore cycle.
            initialX: data.initialX / (data.previewScale || 1),
            initialY: data.initialY / (data.previewScale || 1),

            // Full reset baseline — pristine upload defaults, independent of
            // current effect values (fixes reset after autosave / JSON load).
            initialScale: data.initialScale,
            initialRotation: data.initialRotation ?? 0,
            initialWarpAmount: data.initialWarpAmount ?? 0,
            initialArcAmount: data.initialArcAmount ?? 0,
            initialArcTilt: data.initialArcTilt ?? 0,
            initialOpacity: data.initialOpacity ?? 1,
            initialBlurAmount: data.initialBlurAmount ?? 0,
            initialNoiseAmount: data.initialNoiseAmount ?? 0,
            initialBlendMode: data.initialBlendMode ?? 'normal',
            initialPerspectiveTop: data.initialPerspectiveTop ?? 0,
            initialPerspectiveLeft: data.initialPerspectiveLeft ?? 0,
            initialDesignSrc: _originalToSrc(data.initialDesignOriginal),

            scale: data.scale,

            scaleX: mainObj ? (mainObj.scaleX / data.previewScale) : data.scaleX,
            scaleY: mainObj ? (mainObj.scaleY / data.previewScale) : data.scaleY,

            skewX: mainObj ? (mainObj.skewX || 0) : (data.skewX || 0),
            skewY: mainObj ? (mainObj.skewY || 0) : (data.skewY || 0),

            flipX: !!data.flipX,
            flipY: !!data.flipY,

            rotation: mainObj ? mainObj.angle : data.rotation,

            warpAmount: data.warpAmount ?? 0,
            arcAmount: data.arcAmount ?? 0,
            arcTilt: data.arcTilt ?? 0,
            perspectiveTop: data.perspectiveTop ?? 0,
            perspectiveLeft: data.perspectiveLeft ?? 0,
            opacity: data.opacity ?? 1,
            blurAmount: data.blurAmount ?? 0,
            noiseAmount: data.noiseAmount ?? 0,
            blendMode: data.blendMode ?? "normal",
            bgAdjust:  data.bgAdjust  ? { ...data.bgAdjust } : { hue: 0, saturation: 0, brightness: 0, contrast: 0 },
            bgCrop:    data.bgCrop    ? { ...data.bgCrop   } : { x: 0, y: 0, scale: 1, rotation: 0, aspect: 0 },
            hasProEffect: data.hasProEffect ?? false,
            forceProBadge: !!data.forceProBadge,
            meshWarpApplied: !!data.meshWarpApplied,
            invertedMain: !!data.invertedMain,
            invertedExtras: [...(data.invertedExtras || [])],
            patternMode: !!data.patternMode,
            patternSettings: data.patternSettings ? { ...data.patternSettings } : null,

            // Normalise mask-path coordinates by dividing by previewScale so
            // they are stored in background-image-pixel space — the same
            // normalisation applied to x/y/scaleX/scaleY.  The restore path
            // multiplies back up by the new previewScale.
            maskPaths: (data.maskPaths ?? []).map(path=>
                path.map(p=>({
                    x:  p.x  / data.previewScale,
                    y:  p.y  / data.previewScale,
                    cx: p.cx !== undefined ? p.cx / data.previewScale : undefined,
                    cy: p.cy !== undefined ? p.cy / data.previewScale : undefined
                }))
            ),
            maskPath: data.maskPath
                ? data.maskPath.map(p=>({
                    x:  p.x  / data.previewScale,
                    y:  p.y  / data.previewScale,
                    cx: p.cx !== undefined ? p.cx / data.previewScale : undefined,
                    cy: p.cy !== undefined ? p.cy / data.previewScale : undefined
                  }))
                : null,
            maskEnabled: data.maskEnabled ?? false,
            maskType: data.maskType ?? null,

            filename: data.filename,

            // Normalise duplicate positions the same way the main design x/y are
            // normalised — divide by previewScale so values are in bg-image-pixel
            // space.  The restore path multiplies back up by the new previewScale.
            // Save the main design's per-object effects (set in design mode)
            designFx: data.designObject?._fx ?? null,

            duplicates: (data.extraDesignObjects || []).map((obj, i)=>({

                left: obj.left  / data.previewScale,
                top:  obj.top   / data.previewScale,

                scaleX: obj.scaleX / data.previewScale,
                scaleY: obj.scaleY / data.previewScale,

                skewX: obj.skewX || 0,
                skewY: obj.skewY || 0,

                angle: obj.angle,

                opacity:   obj.opacity ?? 1,
                blendMode: obj.globalCompositeOperation ?? 'source-over',

                // Uploaded designs store their own image source so they
                // survive save/restore independently of the main design.
                src:  _originalToSrc(data.extraDesignOriginals?.[i]),
                name: obj._uploadedDesignName || null,
                isClone: !_extraObjectIsOverlay(obj),

                // Per-object effects set in design mode
                fx: obj._fx ?? null
            })),

            // Color layer — save as data URL (bg-image scale); null if never painted
            colorLayerDataURL: data.colorLayerCanvas
                ? data.colorLayerCanvas.toDataURL()
                : null,
            colorLayerOpacity:   data.colorLayerFabricObj?.opacity   ?? 1,
            colorLayerBlendMode: data.colorLayerFabricObj?.globalCompositeOperation ?? 'source-over',

            notes: data.notes || '',

            locked: !!data.locked,

            // Restore which windows were selected when the user saved
            selected: activeIndices.includes(index)
        };
    });
}


var _autoSaveTimer = null;
var _cloudAutoSaveTimer = null;

// ── IndexedDB autosave with localStorage fallback ─────────────────────────────
// Design: IDB is the primary store (no size limit).  On ANY IDB failure (open
// OR put/get/delete), we fall back to localStorage (5 MB limit — sufficient for
// most sessions).  get() also checks localStorage when IDB opens fine but the
// key is absent, covering the case where a previous write fell back to LS.
const _autosaveDB = (() => {
    const DB_NAME = 'mockup_scripter';
    const STORE   = 'autosave';
    const LS_KEY  = (key) => 'mockup_autosave_' + key;

    function _open() {
        return new Promise((res, rej) => {
            const req = indexedDB.open(DB_NAME, 1);
            req.onupgradeneeded = e => e.target.result.createObjectStore(STORE);
            req.onsuccess = e => res(e.target.result);
            req.onerror   = e => rej(e.target.error);
        });
    }

    async function get(key) {
        let idbResult = null;
        try {
            const db = await _open();
            idbResult = await new Promise((res, rej) => {
                const req = db.transaction(STORE).objectStore(STORE).get(key);
                req.onsuccess = () => res(req.result !== undefined ? req.result : null);
                req.onerror   = () => rej(req.error);
            });
        } catch(e) {
            console.warn('[Autosave] IDB read failed, trying localStorage:', e);
        }
        if (idbResult !== null) return idbResult;
        // IDB unavailable or key absent — try localStorage fallback
        try {
            const r = localStorage.getItem(LS_KEY(key));
            return r ? JSON.parse(r) : null;
        } catch(_) { return null; }
    }

    async function set(key, value) {
        let idbOk = false;
        try {
            const db = await _open();
            await new Promise((res, rej) => {
                const tx  = db.transaction(STORE, 'readwrite');
                const req = tx.objectStore(STORE).put(value, key);
                req.onsuccess = () => res();
                req.onerror   = () => rej(req.error);
            });
            idbOk = true;
        } catch(e) {
            console.warn('[Autosave] IDB write failed, falling back to localStorage:', e);
        }
        if (!idbOk) {
            try { localStorage.setItem(LS_KEY(key), JSON.stringify(value)); } catch(_) {}
        }
    }

    async function del(key) {
        try {
            const db = await _open();
            await new Promise((res, rej) => {
                const tx  = db.transaction(STORE, 'readwrite');
                const req = tx.objectStore(STORE).delete(key);
                req.onsuccess = () => res();
                req.onerror   = () => rej(req.error);
            });
        } catch(e) {
            console.warn('[Autosave] IDB delete failed:', e);
        }
        try { localStorage.removeItem(LS_KEY(key)); } catch(_) {}
    }

    return { get, set, del };
})();

// ── Unsaved changes indicator ─────────────────────────────────────────────────
var _unsaved = false;

function _markDirty(){
    if(_unsaved) return;
    _unsaved = true;
    document.getElementById('saveProgressBtn')?.classList.add('has-unsaved');
    if(!document.title.startsWith('• ')) document.title = '• ' + document.title;
}

// ── Cloud save ────────────────────────────────────────────────────────────────
// Key stored in localStorage so refreshes re-attach to the same record.
const _CLOUD_UUID_KEY = 'ms_project_uuid';
var _projectName = '';

function _deriveAutoProjectName() {
    if (canvasData.length > 0) {
        const first = canvasData[0];
        const base = (
            first.filename ||
            (first.bgName && first.bgName.replace(/\.[^/.]+$/, '')) ||
            ''
        ).trim();
        if (base) return base;
    }
    return 'Untitled project';
}

async function _getClerkToken() {
    if (typeof window._clerkGetToken === 'function') {
        return window._clerkGetToken();
    }
    try {
        if (window.Clerk && window.Clerk.session) {
            return await window.Clerk.session.getToken();
        }
    } catch {}
    return null;
}

// Compress a data-URL image for cloud storage.
// Backgrounds → JPEG (no transparency needed, much smaller).
// Designs / color layers → PNG (preserve alpha).
// Returns null for non-data-URL inputs (blob:// URLs survive page-reload via IndexedDB).
function _compressForCloud(src, opts) {
    if (!src || !src.startsWith('data:')) return Promise.resolve(null);
    var format  = (opts && opts.format)  || 'jpeg';
    var quality = (opts && opts.quality) || 0.65;
    var maxDim  = (opts && opts.maxDim)  || 1200;
    return new Promise(function (resolve) {
        var img = new Image();
        img.onload = function () {
            var w = img.naturalWidth, h = img.naturalHeight;
            if (!w || !h) { resolve(null); return; }
            if (w > maxDim || h > maxDim) {
                var s = maxDim / Math.max(w, h);
                w = Math.round(w * s);
                h = Math.round(h * s);
            }
            var canvas = document.createElement('canvas');
            canvas.width = w; canvas.height = h;
            var ctx = canvas.getContext('2d');
            if (format === 'jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); }
            ctx.drawImage(img, 0, 0, w, h);
            resolve(canvas.toDataURL('image/' + format, quality));
        };
        img.onerror = function () { resolve(null); };
        img.src = src;
    });
}

async function buildCloudSnapshot() {
    const full = buildFullSnapshot();

    // --- Step 1: collect every unique data-URL used across all windows ---
    const srcToKey = new Map(); // data URL → '__img_N'
    let imgIdx = 0;
    function _registerSrc(src) {
        if (!src || !src.startsWith('data:')) return;
        if (!srcToKey.has(src)) srcToKey.set(src, '__img_' + (imgIdx++));
    }
    for (const w of full.windows) {
        _registerSrc(w.bgSrc);
        _registerSrc(w.designSrc);
        _registerSrc(w.colorLayerDataURL);
        for (const d of (w.duplicates || [])) _registerSrc(d.src);
    }

    // --- Step 2: compress each unique image exactly once ---
    const bgSrcSet = new Set(full.windows.map(function (w) { return w.bgSrc; }));
    const imageMap = {};
    for (const [src, key] of srcToKey) {
        const isBg = bgSrcSet.has(src);
        const compressed = await _compressForCloud(
            src,
            isBg ? { format: 'jpeg', quality: 0.50, maxDim: 900 }
                 : { format: 'png', maxDim: 800 }
        );
        if (compressed) imageMap[key] = compressed;
        // if compression fails the key stays absent → treated as null on restore
    }

    // --- Step 3: replace image data in windows with their keys ---
    function _toKey(src) {
        if (!src || !src.startsWith('data:')) return null;
        const key = srcToKey.get(src);
        return (key && imageMap[key]) ? key : null;
    }

    const compressedWindows = full.windows.map(function (w) {
        return Object.assign({}, w, {
            bgSrc:             _toKey(w.bgSrc),
            designSrc:         _toKey(w.designSrc),
            colorLayerDataURL: _toKey(w.colorLayerDataURL),
            duplicates: (w.duplicates || []).map(function (d) {
                return Object.assign({}, d, { src: _toKey(d.src) });
            }),
        });
    });

    return Object.assign({}, full, { windows: compressedWindows, imageMap });
}

async function _cloudSave({ isNew = false } = {}) {
    const snapshot = await buildCloudSnapshot();
    const currentUuid = isNew ? null : localStorage.getItem(_CLOUD_UUID_KEY);

    const body = { snapshot, name: _projectName || 'Untitled project' };
    if (currentUuid) body.uuid = currentUuid;

    // Guard against proxy/serverless upload limits (~4 MB target)
    const _payloadBytes = new Blob([JSON.stringify(body)]).size;
    if (_payloadBytes > 4 * 1024 * 1024) {
        return { ok: false, error: 'payload_too_large' };
    }

    const headers = { 'Content-Type': 'application/json' };
    const token = await _getClerkToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;

    let res;
    try {
        res = await fetch('/api/projects/save', {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
        });
    } catch {
        return { ok: false, error: 'Network error — check your connection' };
    }

    const data = await res.json().catch(() => ({}));

    if (res.ok && data.ok) {
        if (data.uuid) localStorage.setItem(_CLOUD_UUID_KEY, data.uuid);
        return { ok: true, uuid: data.uuid };
    }

    return { ok: false, error: data.error || 'Save failed' };
}

function _promptProjectName(defaultName) {
    return new Promise(function (resolve) {
        var existing = document.getElementById('msNamePrompt');
        if (existing) existing.remove();

        var overlay = document.createElement('div');
        overlay.id = 'msNamePrompt';
        overlay.className = 'ms-name-prompt-overlay';

        var box = document.createElement('div');
        box.className = 'ms-name-prompt-box';

        var title = document.createElement('div');
        title.className = 'ms-name-prompt-title';
        title.textContent = 'Name this project';

        var input = document.createElement('input');
        input.className = 'ms-name-prompt-input';
        input.type = 'text';
        input.maxLength = 60;
        input.placeholder = 'e.g. Fall Collection Mockups';
        input.autocomplete = 'off';
        input.spellcheck = false;
        input.value = defaultName || '';

        var actions = document.createElement('div');
        actions.className = 'ms-name-prompt-actions';

        var cancelBtn = document.createElement('button');
        cancelBtn.className = 'ms-name-prompt-cancel';
        cancelBtn.textContent = 'Cancel';

        var saveBtn = document.createElement('button');
        saveBtn.className = 'ms-name-prompt-save';
        saveBtn.textContent = 'Save';

        actions.appendChild(cancelBtn);
        actions.appendChild(saveBtn);
        box.appendChild(title);
        box.appendChild(input);
        box.appendChild(actions);
        overlay.appendChild(box);
        document.body.appendChild(overlay);

        setTimeout(function () { input.focus(); input.select(); }, 50);

        function finish(name) {
            overlay.remove();
            resolve(name);
        }

        saveBtn.addEventListener('click', function () {
            finish(input.value.trim() || 'Untitled');
        });
        cancelBtn.addEventListener('click', function () { finish(null); });
        overlay.addEventListener('click', function (e) {
            if (e.target === overlay) finish(null);
        });
        input.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') finish(input.value.trim() || 'Untitled');
            if (e.key === 'Escape') finish(null);
        });
    });
}

function _showSaveToast(message, isError = false) {
    const existing = document.getElementById('msSaveToast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'msSaveToast';
    toast.className = 'ms-upgrade-toast' + (isError ? ' ms-upgrade-toast--pending' : '');
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.classList.add('ms-upgrade-toast--visible'), 30);
    setTimeout(() => {
        toast.classList.remove('ms-upgrade-toast--visible');
        setTimeout(() => toast.remove(), 400);
    }, 4000);
}

// Toast with an action button — stays until dismissed or button clicked
function _showSaveToastWithAction(message, btnLabel, btnFn) {
    const existing = document.getElementById('msSaveToast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'msSaveToast';
    toast.className = 'ms-upgrade-toast ms-upgrade-toast--pending ms-save-toast-action';

    const msg = document.createElement('span');
    msg.textContent = message;

    const btn = document.createElement('button');
    btn.className = 'ms-save-toast-btn';
    btn.textContent = btnLabel;
    btn.addEventListener('click', () => {
        toast.classList.remove('ms-upgrade-toast--visible');
        setTimeout(() => toast.remove(), 400);
        btnFn();
    });

    const close = document.createElement('button');
    close.className = 'ms-save-toast-close';
    close.textContent = '✕';
    close.addEventListener('click', () => {
        toast.classList.remove('ms-upgrade-toast--visible');
        setTimeout(() => toast.remove(), 400);
    });

    toast.appendChild(msg);
    toast.appendChild(btn);
    toast.appendChild(close);
    document.body.appendChild(toast);
    setTimeout(() => toast.classList.add('ms-upgrade-toast--visible'), 30);
}

function _saveToLocalFile() {
    const snapshot = buildFullSnapshot();
    const blob = new Blob([JSON.stringify(snapshot)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = 'mockup-project-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    URL.revokeObjectURL(url);
}

function _countUniqueImages() {
    const seen = new Set();
    canvasData.forEach(function (data) {
        if (data.bg && data.bg.src && data.bg.src.startsWith('data:')) seen.add(data.bg.src);
        const dSrc = _originalToSrc(data.designOriginal);
        if (dSrc && dSrc.startsWith('data:')) seen.add(dSrc);
        (data.extraDesignOriginals || []).forEach(function (orig) {
            const s = _originalToSrc(orig);
            if (s && s.startsWith('data:')) seen.add(s);
        });
    });
    return seen.size;
}

const CLOUD_IMAGE_LIMIT = 40;

function _markClean(){
    _unsaved = false;
    clearTimeout(_cloudAutoSaveTimer);
    document.getElementById('saveProgressBtn')?.classList.remove('has-unsaved');
    document.title = document.title.replace(/^• /, '');
}

async function _loadProjectByUuid(uuid) {
    if (!uuid || typeof uuid !== 'string') return;

    let res;
    try {
        res = await fetch('/api/projects/' + encodeURIComponent(uuid));
    } catch {
        _showSaveToast('Could not reach server — check your connection', true);
        return;
    }

    const data = await res.json().catch(() => ({}));

    if (!res.ok || !data.ok) {
        _showSaveToast(data.error || 'Project not found', true);
        return;
    }

    let raw = data.snapshot;
    if (typeof migrateSnapshot === 'function') raw = migrateSnapshot(raw);

    if (!raw) {
        _showSaveToast('Project data is empty or invalid', true);
        return;
    }

    const isLegacy = Array.isArray(raw);
    let windows = isLegacy ? raw : (raw.windows || []);
    const tboxes = isLegacy ? [] : (raw.textBoxes || []);

    // New format: images are deduplicated into an imageMap keyed by '__img_N'.
    // Resolve all keys back to data URLs before anything else.
    const imageMap = (!isLegacy && raw.imageMap) ? raw.imageMap : {};
    function _fromKey(val) {
        if (!val) return null;
        if (typeof val === 'string' && val.startsWith('__img_')) return imageMap[val] || null;
        return val; // old format — already a data URL (or null)
    }
    if (Object.keys(imageMap).length > 0) {
        windows = windows.map(function (w) {
            return Object.assign({}, w, {
                bgSrc:             _fromKey(w.bgSrc),
                designSrc:         _fromKey(w.designSrc),
                colorLayerDataURL: _fromKey(w.colorLayerDataURL),
                duplicates: (w.duplicates || []).map(function (d) {
                    return Object.assign({}, d, { src: _fromKey(d.src) });
                }),
            });
        });
    }

    // Cloud snapshots may still have null images (old saves before deduplication fix).
    // Try to restore those from local IndexedDB autosave by matching bgName.
    const hasStripped = windows.some(function (w) { return !w.bgSrc; });
    if (hasStripped) {
        try {
            const localSession = await _autosaveDB.get('session');
            if (localSession) {
                const localWindows = Array.isArray(localSession)
                    ? localSession
                    : (localSession.windows || []);
                const localByName = {};
                localWindows.forEach(function (lw) {
                    if (lw.bgName && lw.bgSrc) localByName[lw.bgName] = lw;
                });
                windows = windows.map(function (w) {
                    if (w.bgSrc) return w;
                    const lw = localByName[w.bgName];
                    if (!lw) return w;
                    return Object.assign({}, w, {
                        bgSrc:           lw.bgSrc   || null,
                        designSrc:       w.designSrc || lw.designSrc || null,
                        colorLayerDataURL: w.colorLayerDataURL || lw.colorLayerDataURL || null,
                        duplicates: (w.duplicates || []).map(function (d, i) {
                            if (d.src) return d;
                            const ld = lw.duplicates && lw.duplicates[i];
                            return Object.assign({}, d, { src: ld ? ld.src : null });
                        }),
                    });
                });
            }
        } catch (_) {}
    }

    const restorable = windows.filter(function (w) { return !!w.bgSrc; });
    const missing    = windows.length - restorable.length;

    try {
        _applyLayoutFromSnapshot(isLegacy ? null : raw.layout);
        await createCanvasPreviewsFromSnapshot(restorable);
        if (window._restoreTextBoxes) window._restoreTextBoxes(tboxes);
        _applyViewportFromSnapshot(isLegacy ? null : raw.viewport);
        _applyUndoHistoryFromSnapshot(isLegacy ? null : raw.undoHistory);

        syncSliders();
        updateWindowBorders();
        updateDropUI();
    } catch (err) {
        console.error('_loadProjectByUuid: restore failed', err);
        _showSaveToast('Failed to restore project — file may be corrupted', true);
        return;
    }

    localStorage.setItem(_CLOUD_UUID_KEY, uuid);
    _projectName = raw.name || '';
    _markClean();

    if (missing > 0 && restorable.length === 0) {
        _showSaveToast('Project loaded — re-upload your images to restore the canvas', true);
    } else if (missing > 0) {
        _showSaveToast('Project loaded ✓ (' + missing + ' image' + (missing === 1 ? '' : 's') + ' need re-uploading on this device)');
    } else {
        _showSaveToast('Project loaded ✓');
    }
}

function autoSaveSession(){

    if(!canvasData.length && !_textBoxes.length) return;

    // Mark the canvas as dirty (updates the UI badge/title too) so that
    // _markClean() called later (e.g. after a project load) can suppress the
    // pending cloud-save timer via the _unsaved guard in the callback below.
    _markDirty();

    clearTimeout(_autoSaveTimer);

    _autoSaveTimer = setTimeout(async ()=>{
        let snap;
        try { snap = buildFullSnapshot(); } catch(e) { console.error('[Autosave] buildFullSnapshot threw:', e); return; }
        console.log('[Autosave] Saving session —', snap.windows.length, 'window(s)');
        await _autosaveDB.set('session', snap);
        console.log('[Autosave] Session saved ✓');
        _showSaveToast('Draft saved ✓');
    }, 2500);

    // Cloud backup — only when signed in and a UUID is already stored.
    // The callback re-checks _unsaved so that a _markClean() call (e.g. after a
    // project load) that fires between now and the 30 s deadline suppresses the
    // save rather than silently overwriting the freshly-loaded cloud project.
    clearTimeout(_cloudAutoSaveTimer);
    _cloudAutoSaveTimer = setTimeout(()=>{
        if (!_unsaved) return;           // canvas was cleaned (e.g. by a load) — skip
        const signedIn = window.Clerk && window.Clerk.user;
        const hasUuid  = !!localStorage.getItem(_CLOUD_UUID_KEY);
        if (signedIn && hasUuid) {
            _cloudSave().catch(()=>{});
        }
    }, 30000);
}


// ── File menu dropdown toggle ─────────────────────────────────────────────────
(()=>{
    const fileBtn     = document.getElementById('fileMenuBtn');
    const filePopover = document.getElementById('fileMenuPopover');
    if(!fileBtn || !filePopover) return;

    fileBtn.addEventListener('click', e => {
        e.stopPropagation();
        filePopover.hidden = !filePopover.hidden;
    });

    document.addEventListener('click', e => {
        if(!filePopover.hidden && !filePopover.contains(e.target) && e.target !== fileBtn){
            filePopover.hidden = true;
        }
    });
})();

// ── Open from cloud (File menu) ───────────────────────────────────────────────
(()=>{
    const openCloudBtn = document.getElementById('openCloudBtn');
    if (!openCloudBtn) return;

    openCloudBtn.addEventListener('click', e => {
        e.stopPropagation();
        const filePopover = document.getElementById('fileMenuPopover');
        if (filePopover) filePopover.hidden = true;
        if (typeof window._openCloudProjectsUI === 'function') {
            window._openCloudProjectsUI();
        }
    });
})();

function _updateSaveNewBtn() {
    const wrap  = document.getElementById('saveNewWrap');
    const btn   = document.getElementById('saveNewBtn');
    const badge = document.getElementById('saveNewProBadge');
    if (!wrap || !btn) return;
    const isPro = _userPlan === 'pro';
    btn.disabled = !isPro;
    wrap.classList.toggle('is-locked', !isPro);
    if (badge) {
        badge.textContent = '⭐ PRO';
        badge.className = 'file-menu-pro-badge' + (isPro ? ' file-menu-pro-badge-green' : '');
    }
}
// Set initial state on load (plan defaults to 'free' until Clerk resolves)
document.addEventListener('DOMContentLoaded', _updateSaveNewBtn);

document.getElementById("saveProgressBtn").addEventListener("click", async ()=>{

    if(window.Clerk && !window.Clerk.user){
        sessionStorage.setItem('ms_redirect_after_auth', 'save');
        try { await _autosaveDB.set('session', buildFullSnapshot()).catch(()=>{}); } catch(e) { console.error('[Save→SignIn] snapshot failed:', e); }
        try { window.Clerk.redirectToSignIn({ forceRedirectUrl: window.location.href }); } catch(e) { alert('Sign-in is temporarily unavailable \u2014 please refresh the page.'); }
        return;
    }
    if(_userPlan === 'free'){
        if(typeof openPlansModal === 'function') openPlansModal();
        return;
    }

    if(_countUniqueImages() >= CLOUD_IMAGE_LIMIT){
        _showSaveToastWithAction(
            'Too many unique images for cloud save (~40 max).',
            'Save to computer instead',
            _saveToLocalFile
        );
        return;
    }

    const isFirstSave = !localStorage.getItem(_CLOUD_UUID_KEY);
    if (isFirstSave) {
        const name = await _promptProjectName(_projectName || _deriveAutoProjectName());
        if (name === null) return;
        _projectName = name;
    }

    const btn = document.getElementById('saveProgressBtn');
    if(btn) btn.disabled = true;

    const result = await _cloudSave();

    if(btn) btn.disabled = false;

    if(result.ok){
        _markClean();
        _showSaveToast('Project saved ✓');
        if (typeof window._reloadCloudProjects === 'function') window._reloadCloudProjects();
    } else if(result.error === 'upgrade_required'){
        if(typeof openPlansModal === 'function') openPlansModal();
    } else if(result.error === 'payload_too_large' || (result.error && result.error.includes('15 MB'))){
        _showSaveToastWithAction(
            'Project too large for cloud save.',
            'Save to computer instead',
            _saveToLocalFile
        );
    } else {
        _showSaveToast(result.error || 'Save failed — try again', true);
    }
});

document.getElementById('saveNewBtn').addEventListener('click', async () => {
    if (_userPlan !== 'pro') {
        if (typeof openPlansModal === 'function') openPlansModal();
        return;
    }

    if(_countUniqueImages() >= CLOUD_IMAGE_LIMIT){
        _showSaveToastWithAction(
            'Too many unique images for cloud save (~40 max).',
            'Save to computer instead',
            _saveToLocalFile
        );
        return;
    }

    const newName = await _promptProjectName(_deriveAutoProjectName());
    if (newName === null) return;
    _projectName = newName;

    const btn = document.getElementById('saveNewBtn');
    if(btn) btn.disabled = true;

    const result = await _cloudSave({ isNew: true });

    if(btn) btn.disabled = false;

    if(result.ok){
        _markClean();
        _showSaveToast('Saved as new project ✓');
        if (typeof window._reloadCloudProjects === 'function') window._reloadCloudProjects();
    } else if(result.error === 'project_limit_reached'){
        _showSaveToast('Project limit reached (50 max). Delete an old project to save a new one.', true);
    } else if(result.error === 'payload_too_large' || (result.error && result.error.includes('15 MB'))){
        _showSaveToastWithAction(
            'Project too large for cloud save.',
            'Save to computer instead',
            _saveToLocalFile
        );
    } else {
        _showSaveToast(result.error || 'Save failed — try again', true);
    }
});



async function createCanvasPreviewsFromSnapshot(snapshot){

    const container =
        document.getElementById("canvasContainer");

    const loadingIndicator =
        document.getElementById("loadingIndicator");

    // Unobserve all existing wrappers before discarding them — without this,
    // the IntersectionObserver keeps stale entries for removed DOM nodes.
    canvasData.forEach(d => { if(d.wrapperEl) _visibilityObserver.unobserve(d.wrapperEl); });

    container.innerHTML = "";
    canvasData = [];
    activeIndices = [];

    // rebuild source asset pools so future uploads
    // can multiply/populate correctly after JSON load
    backgrounds = [];
    designs = [];

    // Hide the drop zone immediately — canvasData is empty right now, so any
    // call to updateDropUI would mistakenly show it during the load loop.
    const _dropZoneEl     = document.getElementById('dropZone');
    const _designPromptEl = document.getElementById('designPrompt');
    if(_dropZoneEl)     _dropZoneEl.style.display     = 'none';
    if(_designPromptEl) _designPromptEl.style.display = 'none';

    loadingIndicator.style.display = "block";

    for(let index = 0; index < snapshot.length; index++){

        const saved = snapshot[index];

        loadingIndicator.innerText =
            `Restoring session... ${index + 1} / ${snapshot.length}`;

        const bgImg = await new Promise(resolve=>{

            const img = new Image();

            img.onload  = ()=>resolve(img);
            img.onerror = ()=>resolve(img); // never hang if src is broken

            img.src = saved.bgSrc;
        });

        let designImg = null;

        if(saved.designSrc){

            designImg = await new Promise(resolve=>{

                const img = new Image();

                img.onload  = ()=>resolve(img);
                img.onerror = ()=>resolve(null); // broken design — continue anyway

                img.src = saved.designSrc;
            });

            // restore design source pool
            if(
                !designs.some(
                    d => d.img && d.img.src === saved.designSrc
                )
            ){
                designs.push({
                    img: designImg,
                    name: saved.designName || ""
                });
            }
        }

        let baselineDesignImg = designImg;
        if (saved.initialDesignSrc && saved.initialDesignSrc !== saved.designSrc) {
            baselineDesignImg = await new Promise(resolve => {
                const img = new Image();
                img.onload = () => resolve(img);
                img.onerror = () => resolve(designImg);
                img.src = saved.initialDesignSrc;
            });
        }

        // restore background source pool
        if(
            !backgrounds.some(
                b => b.img && b.img.src === saved.bgSrc
            )
        ){
            backgrounds.push({
                img: bgImg,
                name: saved.bgName || ""
            });
        }

        const data = {

            bg: bgImg,
            bgName: saved.bgName,

            designOriginal: designImg,
            initialDesignOriginal: baselineDesignImg ?? designImg,
            designName: saved.designName,

            x: saved.x,
            y: saved.y,

            scale: saved.scale,
            scaleX: saved.scaleX,
            scaleY: saved.scaleY,

            rotation: saved.rotation,

            skewX: saved.skewX ?? 0,
            skewY: saved.skewY ?? 0,

            flipX: !!saved.flipX,
            flipY: !!saved.flipY,

            warpAmount: saved.warpAmount,
            arcAmount: saved.arcAmount,
            arcTilt: saved.arcTilt ?? 0,
            perspectiveTop: saved.perspectiveTop ?? 0,
            perspectiveLeft: saved.perspectiveLeft ?? 0,

            opacity: saved.opacity ?? 1,
            blurAmount: saved.blurAmount ?? 0,
            noiseAmount: saved.noiseAmount ?? 0,
            blendMode: saved.blendMode ?? "normal",
            bgAdjust:  saved.bgAdjust  ? { ...saved.bgAdjust } : { hue: 0, saturation: 0, brightness: 0, contrast: 0 },
            bgCrop:    saved.bgCrop    ? { ...saved.bgCrop   } : { x: 0, y: 0, scale: 1, rotation: 0, aspect: 0 },

            maskPaths:
                saved.maskPaths ||
                (saved.maskPath ? [saved.maskPath] : []),

            maskPath: saved.maskPath ?? null,
            maskEnabled: saved.maskEnabled ?? false,
            maskType: saved.maskType ?? null,

            // restore editable clipping editor state
            clipCurvePoints: saved.maskPath
                ? JSON.parse(JSON.stringify(saved.maskPath))
                : [],
            clipPolygonClosed:
                !!(
                    saved.maskEnabled &&
                    saved.maskPath &&
                    saved.maskPath.length >= 3
                ),

            filename: saved.filename,
            notes: saved.notes || '',
            hasProEffect: saved.hasProEffect ?? false,
            forceProBadge: !!saved.forceProBadge,
            meshWarpApplied: !!saved.meshWarpApplied,
            invertedMain: !!saved.invertedMain,
            invertedExtras: [...(saved.invertedExtras || [])],

            extraDesignObjects: [],
        };

        canvasData.push(data);

        const wrapper = document.createElement("div");
        wrapper.className = "canvas-wrapper";
        data.wrapperEl = wrapper;

        const canvasEl = document.createElement("canvas");

        wrapper.appendChild(canvasEl);

        const filenameInput = document.createElement("input");

        filenameInput.type = "text";
        filenameInput.className = "filename-input";
        filenameInput.value = saved.filename ?? '';

        filenameInput.addEventListener("input", e=>{
            data.filename = e.target.value;
        });

        wrapper.appendChild(filenameInput);

        const cell = document.createElement("div");
        cell.className = "window-cell";
        cell.appendChild(wrapper);
        data.cellEl = cell;
        _addDragHandle(wrapper, cell);
        _updateProStarBadge(data);

        container.appendChild(cell);
        _visibilityObserver.observe(wrapper);

        const fabricCanvas = new fabric.Canvas(canvasEl,{
            preserveObjectStacking: true,
            selection: false,
            renderOnAddRemove: false
        });

        data.fabricCanvas = fabricCanvas;
        _setFabricHighQualitySmoothing(fabricCanvas);

        const realWidth = bgImg.width;

        const targetColumnWidth = 300;

        const previewScale =
            Math.min(1, (targetColumnWidth * 1.5) / realWidth);

        data.previewScale = previewScale;

        // saved.x / saved.y are now in background-image-pixel space (normalised).
        // Scale back up to preview-canvas pixels for this previewScale.
        data.x = saved.x * previewScale;
        data.y = saved.y * previewScale;

        // initialX/Y used by Reset — temporarily mirror x/y; corrected below
        // once previewW/H are known (they are computed a few lines later).
        data.initialX = data.x;
        data.initialY = data.y;

        // Mask paths were normalised on save (÷ previewScale).  Scale them
        // back up to canvas-pixel space for the current previewScale.
        const scalePoints = (path, s) => path.map(p=>({
            x:  p.x  * s,
            y:  p.y  * s,
            cx: p.cx !== undefined ? p.cx * s : undefined,
            cy: p.cy !== undefined ? p.cy * s : undefined
        }));

        data.maskPaths = (saved.maskPaths || []).map(path=>
            scalePoints(path, previewScale)
        );

        const scaledMaskPath = saved.maskPath
            ? scalePoints(saved.maskPath, previewScale)
            : null;

        data.maskPath = scaledMaskPath;

        // clipCurvePoints drives the live editor; keep it in sync.
        data.clipCurvePoints = scaledMaskPath
            ? JSON.parse(JSON.stringify(scaledMaskPath))
            : [];

        const previewW = Math.round(bgImg.width  * previewScale);
        const previewH = Math.round(bgImg.height * previewScale);

        fabricCanvas.setWidth(previewW);
        fabricCanvas.setHeight(previewH);

        // Now that previewW/H are known, set the correct reset baseline.
        // Use persisted baseline from snapshot when available; fall back to
        // pristine defaults for sessions saved before baseline was persisted.
        data.initialX = saved.initialX != null
            ? saved.initialX * previewScale
            : previewW / 2;
        data.initialY = saved.initialY != null
            ? saved.initialY * previewScale
            : previewH / 2;
        data.initialScale = saved.initialScale ?? saved.scale ?? 1;
        data.initialRotation = saved.initialRotation ?? 0;
        data.initialWarpAmount = saved.initialWarpAmount ?? 0;
        data.initialArcAmount = saved.initialArcAmount ?? 0;
        data.initialArcTilt = saved.initialArcTilt ?? 0;
        data.initialOpacity = saved.initialOpacity ?? 1;
        data.initialBlurAmount = saved.initialBlurAmount ?? 0;
        data.initialNoiseAmount = saved.initialNoiseAmount ?? 0;
        data.initialBlendMode = saved.initialBlendMode ?? 'normal';
        data.initialPerspectiveTop = saved.initialPerspectiveTop ?? 0;
        data.initialPerspectiveLeft = saved.initialPerspectiveLeft ?? 0;
        if (baselineDesignImg) {
            data.initialDesignOriginal = baselineDesignImg;
        }

        // Shrink Fabric's .canvas-container to the CSS display size so it doesn't
        // overflow the grid cell. Canvas DOM pixel count stays at previewW × DPR,
        // so the browser downscales those extra pixels — crisp at zoom.
        const displayW = Math.round(targetColumnWidth);
        const displayH = Math.round(previewH * targetColumnWidth / previewW);
        fabricCanvas.wrapperEl.style.width  = displayW + "px";
        fabricCanvas.wrapperEl.style.height = displayH + "px";
        wrapper.style.width = displayW + "px";

        _syncFabricDisplaySize(data, targetColumnWidth);
        _attachWrapperClickListener(wrapper, data);
        _attachWindowCanvasSelection(data);

        // Build the background Fabric image directly from the already-loaded
        // bgImg element — avoids a second load and the crossOrigin:'anonymous'
        // flag that hangs on data URLs (browsers block CORS for data: URIs,
        // causing the fromURL callback to never fire).
        const bgFabric = new fabric.Image(bgImg, {
            left:0,
            top:0,
            selectable:false,
            evented:false,
            originX:'left',
            originY:'top',
            scaleX:previewScale,
            scaleY:previewScale
        });

        fabricCanvas.add(bgFabric);
        data.backgroundObject = bgFabric;
        _applyBgAdjust(data);
        _updateCropOverlay(data);

        // Pattern mode restore (JSON load)
        data.patternMode = !!saved.patternMode;
        data.patternSettings = saved.patternSettings ? { ...saved.patternSettings } : _defaultPattern();
        if(data.patternMode) _togglePatternMode(data, true);

        // restore polygon overlay before rendering designs
        addClipOverlay(data);

        await applyWarpToData(data,false);
        await new Promise(r=>setTimeout(r,40));

        // Restore per-object effects on the main design (saved by design mode)
        if(saved.designFx && data.designObject){
            data.designObject._fx = saved.designFx;
        }

        if(saved.duplicates?.length){

            for(const dup of saved.duplicates){

                if(_dupStateIsOverlay(dup) && dup.src){

                    // Restore an independently-uploaded design from its saved
                    // data URL (different source from the main design).
                    await new Promise(resolve=>{

                        const img = new Image();

                        img.onerror = ()=>resolve(); // never hang on a broken src

                        img.onload = ()=>{

                            const fabricImg = new fabric.Image(img, {
                                left: dup.left * previewScale,
                                top:  dup.top  * previewScale,
                                scaleX: dup.scaleX * previewScale,
                                scaleY: dup.scaleY * previewScale,
                                skewX: dup.skewX ?? 0,
                                skewY: dup.skewY ?? 0,
                                angle: dup.angle,
                                opacity: dup.opacity ?? data.opacity,
                                globalCompositeOperation: _blendToGCO(dup.blendMode),
                                originX: 'center',
                                originY: 'center',
                            });

                            fabricImg._uploadedDesignName = dup.name || '';
                            fabricImg._fx = dup.fx || _defaultFx(data);

                            _applyWarpToOneObject(fabricImg, data, _cachedFlip(data, img), false);

                            data.extraDesignOriginals = data.extraDesignOriginals || [];
                            data.extraDesignOriginals.push(img);

                            data.extraDesignObjects.push(fabricImg);
                            _applyExtraLayerHandleStyle(fabricImg, 'overlay');

                            fabricCanvas.add(fabricImg);
                            attachFabricEvents(data, fabricImg);
                            applyClipMaskToObject(fabricImg, data);

                            resolve();
                        };

                        img.src = dup.src;
                    });

                } else if (dup.src) {

                    // Clone with its own pipeline source (eraser edits, post-ea7251d saves).
                    await new Promise(resolve => {
                        const img = new Image();
                        img.onerror = () => resolve();
                        img.onload = () => {
                            const fabricImg = new fabric.Image(img, {
                                left: dup.left * previewScale,
                                top:  dup.top  * previewScale,
                                scaleX: dup.scaleX * previewScale,
                                scaleY: dup.scaleY * previewScale,
                                skewX: dup.skewX ?? 0,
                                skewY: dup.skewY ?? 0,
                                angle: dup.angle,
                                opacity: dup.opacity ?? data.opacity,
                                globalCompositeOperation: _blendToGCO(dup.blendMode),
                                originX: 'center',
                                originY: 'center',
                            });
                            if (dup.name) fabricImg._uploadedDesignName = dup.name;
                            fabricImg._fx = dup.fx || _defaultFx(data);

                            _applyWarpToOneObject(fabricImg, data, _cachedFlip(data, img), false);

                            data.extraDesignOriginals = data.extraDesignOriginals || [];
                            data.extraDesignOriginals.push(img);
                            data.extraDesignObjects.push(fabricImg);
                            _applyExtraLayerHandleStyle(fabricImg, 'clone');

                            fabricCanvas.add(fabricImg);
                            attachFabricEvents(data, fabricImg);
                            applyClipMaskToObject(fabricImg, data);
                            resolve();
                        };
                        img.src = dup.src;
                    });

                } else {

                    // Legacy clone — shared main designOriginal pipeline source.
                    await new Promise(resolve=>{

                        data.designObject.clone(cloned=>{

                            cloned.set({
                                // dup.left/top are normalised (bg-image-pixel space);
                                // multiply by new previewScale to get canvas pixels.
                                left: dup.left * previewScale,
                                top:  dup.top  * previewScale,

                                scaleX: dup.scaleX * previewScale,
                                scaleY: dup.scaleY * previewScale,

                                skewX: dup.skewX ?? 0,
                                skewY: dup.skewY ?? 0,

                                angle: dup.angle,

                                opacity: dup.opacity ?? data.opacity,

                                globalCompositeOperation: _blendToGCO(dup.blendMode)
                            });

                            cloned._fx = dup.fx || _defaultFx(data);

                            // Bake this duplicate's own warp/arc/perspective/blur/noise
                            // pipeline into its pixels — restoring _fx alone only stores
                            // the values, it doesn't render them (mirrors the per-object
                            // pass applyWarpToData runs for extraDesignObjects normally).
                            _applyWarpToOneObject(cloned, data, _cachedFlip(data, data.designOriginal), false);

                            data.extraDesignOriginals = data.extraDesignOriginals || [];
                            data.extraDesignOriginals.push(null);

                            data.extraDesignObjects.push(cloned);
                            _applyExtraLayerHandleStyle(cloned, 'clone');

                            fabricCanvas.add(cloned);
                            attachFabricEvents(data, cloned);
                            applyClipMaskToObject(cloned, data);

                            resolve();
                        });
                    });
                }
            }
        }

        addClipOverlay(data);

        // Restore color layer if one was saved
        if(saved.colorLayerDataURL){
            const clImg = new Image();
            clImg.onload = ()=>{
                initColorLayer(data);
                // Push the blank canvas as the baseline undo point so that
                // Ctrl+Z in Color Layer mode can revert to "no paint" even
                // immediately after a project is loaded.
                pushColorLayerHistory(data);
                // Scale the saved bitmap to the current canvas size
                data.colorLayerCtx.drawImage(
                    clImg, 0, 0,
                    data.fabricCanvas.getWidth(),
                    data.fabricCanvas.getHeight()
                );
                if(data.colorLayerFabricObj){
                    data.colorLayerFabricObj.set({
                        opacity: saved.colorLayerOpacity ?? 1,
                        globalCompositeOperation: saved.colorLayerBlendMode ?? 'source-over'
                    });
                }
                data.fabricCanvas.requestRenderAll();
            };
            clImg.src = saved.colorLayerDataURL;
        }

        fabricCanvas.requestRenderAll();

        // Restore locked state — re-apply Fabric locks and CSS class
        if(saved.locked){
            data.locked = true;
            getAllDesignObjects(data).forEach(o=>{
                if(!o) return;
                o._lockSelectable = o.selectable;
                o._lockEvented    = o.evented;
                o.selectable      = false;
                o.evented         = false;
            });
            fabricCanvas.discardActiveObject();
            wrapper.classList.add('window-locked');
        }

        attachClipDrawing(wrapper, fabricCanvas, data, index);

        _syncProEffect(data);
    }

    // Restore selection state from snapshot
    activeIndices = [];
    selectedDesigns.clear();
    lastSelectedIndex = null;
    snapshot.forEach((saved, i) => {
        if(saved.selected && canvasData[i]){
            activeIndices.push(i);
            const d = canvasData[i];
            if(d?.designObject && !d.locked){
                if(!d.designObject._fx) d.designObject._fx = _defaultFx(d);
                selectedDesigns.add(d.designObject);
            }
        }
    });
    if(activeIndices.length) lastSelectedIndex = canvasData[activeIndices[activeIndices.length - 1]] ?? null;
    refreshFabricHandles();
    updateWindowBorders();
    updateLayerButtons();
    syncSliders();
    updateSelectButtonState();
    updateDropUI();

    canvasData.forEach(function (d) { _syncProEffect(d); });

    loadingIndicator.innerText =
        "Session restored";

    setTimeout(()=>{
        loadingIndicator.style.display = "none";
    },800);
}


document.getElementById("saveLocalBtn").addEventListener("click", () => {
    _saveToLocalFile();
});

document.getElementById("loadProgressBtn").addEventListener("click", ()=>{

    document.getElementById("loadProgressInput").click();
});

document.getElementById("loadProgressInput").addEventListener("change", function(event){

    const file = event.target.files[0];

    if(!file) return;

    const reader = new FileReader();

    reader.onload = async function(e){

        let data;
        try {
            data = JSON.parse(e.target.result);
        } catch(err) {
            alert('Could not load project — the file appears to be corrupt or is not a valid project file.');
            return;
        }
        const isLegacy = Array.isArray(data);
        const snapshot = isLegacy ? data : (data.windows || []);
        const tboxes   = isLegacy ? [] : (data.textBoxes || []);
        _projectName   = isLegacy ? '' : (data.name || '');

        _applyLayoutFromSnapshot(isLegacy ? null : data.layout);
        await createCanvasPreviewsFromSnapshot(snapshot);
        if (window._restoreTextBoxes) window._restoreTextBoxes(tboxes);
        _applyViewportFromSnapshot(isLegacy ? null : data.viewport);
        _applyUndoHistoryFromSnapshot(isLegacy ? null : data.undoHistory);

        syncSliders();
        updateWindowBorders();
        updateDropUI();
    };

    reader.readAsText(file);
});


document.getElementById("clearSessionBtn").addEventListener("click", ()=>{

    if(!confirm("Clear the autosaved session? The canvas will start blank on the next page load.")) return;

    _exitAllEditModes();

    _autosaveDB.del('session').catch(()=>{});
    localStorage.removeItem('mockup_autosave');
    localStorage.removeItem(_CLOUD_UUID_KEY);
    _projectName = '';

    canvasData.forEach(d => {
        if (d.wrapperEl) _visibilityObserver.unobserve(d.wrapperEl);
    });
    _visibleWrappers.clear();

    // Reset all state
    canvasData = [];
    backgrounds = [];
    designs = [];
    activeIndices = [];
    lastSelectedIndex = null;
    selectedDesigns.clear();
    globalUndoStack = [];
    globalRedoStack = [];
    _copiedLayer = null;
    if (typeof _copiedTransforms !== 'undefined') _copiedTransforms = null;

    if (typeof window._applyTextBoxState === 'function') {
        window._applyTextBoxState([]);
    } else if (typeof window._restoreTextBoxes === 'function') {
        window._restoreTextBoxes([]);
    }

    _vpScale = 1;
    _vpX     = 0;
    _vpY     = 0;
    _activeTool = null;
    _applyVP();

    document.getElementById("canvasContainer").innerHTML = "";
    document.getElementById("loadingIndicator").style.display = "none";

    // Clear file input labels so "4 files" / "3 files" badges disappear
    document.getElementById("bgUpload").value = "";
    document.getElementById("designUpload").value = "";

    _markClean();
    _resetLeftPanelToDefaults();
    _resetLayoutToDefaults();

    updateWindowBorders();
    updateSelectButtonState();
    updateLayerButtons();
    updateUndoRedoButtons();
    updateDropUI();
});


// ── Pan / Zoom Viewport ───────────────────────────────────────────────────────
// Pure CSS-transform approach: the #canvasContainer is translated + scaled
// inside #viewportWrapper. No Fabric canvas is re-rendered; all content,
// edits, backgrounds, and designs remain completely unchanged during zoom/pan.

var _vpScale = 1;
var _vpX     = 0;
var _vpY     = 0;
var _vpPanning    = false;
var _vpPanStart   = null;
var _vpPanMoved   = false;
var _vpSpaceDown  = false;
var _activeTool   = null;  // null | 'select' | 'pan' | 'text'

var _textBoxes = [];  // { id, x, y, w, h, content, el }
var _tbNextId  = 1;

function deleteTextBox(box) {
    if (box.el && box.el.parentNode) box.el.parentNode.removeChild(box.el);
    const idx = _textBoxes.indexOf(box);
    if (idx !== -1) _textBoxes.splice(idx, 1);
    autoSaveSession();
}

// ── Text-box undo helpers (used by createTextBox IIFE and undo engine) ────────
function captureTextBoxState() {
    return _textBoxes.map(b => ({
        x: b.x, y: b.y, w: b.w, h: b.h,
        content: b.textEl ? b.textEl.innerHTML : b.content
    }));
}

function pushTextBoxUndo() {
    globalUndoStack.push({ type: 'textboxes', state: captureTextBoxState() });
    if (globalUndoStack.length > MAX_UNDO_HISTORY) globalUndoStack.shift();
    globalRedoStack = [];
    updateUndoRedoButtons();
}

// Global viewport apply — mirrors the IIFE-local applyVP; used by undo/redo.
function _applyVP() {
    const t  = `translate(${_vpX}px,${_vpY}px) scale(${_vpScale})`;
    const cc = document.getElementById('canvasContainer');
    const tl = document.getElementById('textLayer');
    if (cc) cc.style.transform = t;
    if (tl) tl.style.transform = t;
    const el = document.getElementById('zoomLevelDisplay');
    if (el) el.textContent = Math.round(_vpScale * 100) + '%';
    _scheduleMinimapUpdate();
}

// ── Minimap ───────────────────────────────────────────────────────────────────
var _MM_W   = 180;   // minimap canvas width  (px)
var _MM_HMAX = 150;  // minimap canvas max height (px)
var _MM_PAD  = 6;    // inner padding

var _minimapRaf = false;
function _scheduleMinimapUpdate(){
    if(_minimapRaf) return;
    _minimapRaf = true;
    requestAnimationFrame(() => { _minimapRaf = false; updateMinimap(); });
}

function updateMinimap(){
    const mm = document.getElementById('minimap');
    const cv = document.getElementById('minimapCanvas');
    const cc = document.getElementById('canvasContainer');
    const vw = document.getElementById('viewportWrapper');
    if(!mm || !cv || !cc || !vw) return;

    if(!canvasData.some(d => d?.designOriginal)){ mm.hidden = true; return; }
    mm.hidden = false;

    const natW = cc.offsetWidth;
    const natH = cc.offsetHeight;
    if(!natW || !natH) return;

    // Scale that fits the whole container into the minimap bounds
    const ms = Math.min(
        (_MM_W    - _MM_PAD * 2) / natW,
        (_MM_HMAX - _MM_PAD * 2) / natH
    );
    const cvW = Math.round(natW * ms + _MM_PAD * 2);
    const cvH = Math.round(natH * ms + _MM_PAD * 2);

    if(cv.width !== cvW || cv.height !== cvH){ cv.width = cvW; cv.height = cvH; }

    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cvW, cvH);

    // Window cells — use cellEl for position (wrapperEl.offsetLeft is always 0
    // because .window-cell is its offsetParent; cellEl gives correct grid offset)
    const activeSet = new Set(activeIndices);
    canvasData.forEach((data, i) => {
        const el = data?.cellEl || data?.wrapperEl;
        if(!el) return;
        const x = _MM_PAD + el.offsetLeft  * ms;
        const y = _MM_PAD + el.offsetTop   * ms;
        const w = Math.max(1, el.offsetWidth  * ms);
        const h = Math.max(1, el.offsetHeight * ms);

        ctx.fillStyle   = activeSet.has(i) ? 'rgba(30,94,255,0.88)' : 'rgba(255,255,255,0.13)';
        ctx.strokeStyle = activeSet.has(i) ? '#6aa0ff'              : 'rgba(255,255,255,0.28)';
        ctx.lineWidth   = activeSet.has(i) ? 1 : 0.5;
        ctx.fillRect(x, y, w, h);
        ctx.strokeRect(x + 0.25, y + 0.25, w - 0.5, h - 0.5);
    });

    // Viewport indicator
    const vwRect  = vw.getBoundingClientRect();
    const visLeft = -_vpX / _vpScale;
    const visTop  = -_vpY / _vpScale;
    const visW    = vwRect.width  / _vpScale;
    const visH    = vwRect.height / _vpScale;

    const rx = _MM_PAD + visLeft * ms;
    const ry = _MM_PAD + visTop  * ms;
    const rw = visW * ms;
    const rh = visH * ms;

    ctx.fillStyle   = 'rgba(255,255,255,0.07)';
    ctx.strokeStyle = 'rgba(255,255,255,0.88)';
    ctx.lineWidth   = 1.5;
    ctx.fillRect(rx, ry, rw, rh);
    ctx.strokeRect(rx + 0.75, ry + 0.75, rw - 1.5, rh - 1.5);
}

// Click / drag to pan via minimap
(function(){
    const cv = document.getElementById('minimapCanvas');
    const vw = document.getElementById('viewportWrapper');
    const cc = document.getElementById('canvasContainer');
    let _mmDown = false;

    function panTo(e){
        if(!cv || !vw || !cc) return;
        const cvRect = cv.getBoundingClientRect();
        const natW   = cc.offsetWidth;
        const natH   = cc.offsetHeight;
        if(!natW || !natH) return;
        const ms = Math.min(
            (_MM_W    - _MM_PAD * 2) / natW,
            (_MM_HMAX - _MM_PAD * 2) / natH
        );
        // Click in canvas px (accounting for CSS scaling of the element)
        const scaleX = cv.width  / cvRect.width;
        const scaleY = cv.height / cvRect.height;
        const mx = (e.clientX - cvRect.left) * scaleX;
        const my = (e.clientY - cvRect.top)  * scaleY;
        // Natural container coords of the clicked point
        const natX = (mx - _MM_PAD) / ms;
        const natY = (my - _MM_PAD) / ms;
        // Pan so that point sits at the viewport centre
        const vwRect = vw.getBoundingClientRect();
        _vpX = vwRect.width  / 2 - natX * _vpScale;
        _vpY = vwRect.height / 2 - natY * _vpScale;
        _applyVP();
    }

    cv.addEventListener('mousedown', e => {
        _mmDown = true;
        panTo(e);
        e.stopPropagation();
        e.preventDefault();
    });
    document.addEventListener('mousemove', e => { if(_mmDown) panTo(e); });
    document.addEventListener('mouseup',   () => { _mmDown = false; });
})();

(()=>{
    const vw = document.getElementById('viewportWrapper');
    const cc = document.getElementById('canvasContainer');

    function applyVP() {
        const t = `translate(${_vpX}px,${_vpY}px) scale(${_vpScale})`;
        cc.style.transform = t;
        const tl = document.getElementById('textLayer');
        if (tl) tl.style.transform = t;
        const pct = Math.round(_vpScale * 100);
        document.getElementById('zoomLevelDisplay').textContent = pct + '%';
        _scheduleMinimapUpdate();
    }

    function zoomAt(cx, cy, factor) {
        const next = Math.max(0.08, Math.min(6, _vpScale * factor));
        const ratio = next / _vpScale;
        _vpX = cx - (cx - _vpX) * ratio;
        _vpY = cy - (cy - _vpY) * ratio;
        _vpScale = next;
        applyVP();
    }

    // ── Wheel: Ctrl / pinch = zoom; plain scroll = pan ──────────────────────
    vw.addEventListener('wheel', e => {
        e.preventDefault();
        const rect = vw.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        if (e.ctrlKey || e.metaKey) {
            const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
            zoomAt(cx, cy, factor);
        } else {
            _vpX -= e.deltaX;
            _vpY -= e.deltaY;
            applyVP();
        }
    }, { passive: false });

    // ── Space bar: grab cursor ───────────────────────────────────────────────
    document.addEventListener('keydown', e => {
        if (e.code === 'Space' && !e.target.matches('input,textarea,select,[contenteditable]')) {
            if (!_vpSpaceDown) { _vpSpaceDown = true; vw.style.cursor = 'grab'; }
            e.preventDefault();
        }
    });
    document.addEventListener('keyup', e => {
        if (e.code === 'Space') { _vpSpaceDown = false; if (!_vpPanning) vw.style.cursor = ''; }
    });

    // ── Mouse pan: Space+left-drag OR middle-mouse-drag ──────────────────────
    vw.addEventListener('mousedown', e => {
        if (_vpSpaceDown || e.button === 1) {
            _vpPanning  = true;
            _vpPanMoved = false;
            _vpPanStart = { x: e.clientX - _vpX, y: e.clientY - _vpY };
            vw.style.cursor = 'grabbing';
            _beginWatermarkInteraction();
            e.preventDefault();
        }
    });
    document.addEventListener('mousemove', e => {
        if (!_vpPanning || !_vpPanStart) return;
        const nx = e.clientX - _vpPanStart.x;
        const ny = e.clientY - _vpPanStart.y;
        if (Math.abs(nx - _vpX) > 2 || Math.abs(ny - _vpY) > 2) _vpPanMoved = true;
        _vpX = nx; _vpY = ny;
        applyVP();
    });
    document.addEventListener('mouseup', e => {
        if (!_vpPanning) return;
        _vpPanning = false;
        _endWatermarkInteraction();
        vw.style.cursor = _vpSpaceDown ? 'grab' : '';
        if (_vpPanMoved) {
            // Suppress the next wrapper click so panning doesn't toggle selection
            suppressNextWrapperClick = true;
        }
        _vpPanStart = null;
    });

    // ── Zoom buttons ─────────────────────────────────────────────────────────
    document.getElementById('zoomInBtn').addEventListener('click', () => {
        const r = vw.getBoundingClientRect();
        zoomAt(r.width / 2, r.height / 2, 1.25);
    });
    document.getElementById('zoomOutBtn').addEventListener('click', () => {
        const r = vw.getBoundingClientRect();
        zoomAt(r.width / 2, r.height / 2, 1 / 1.25);
    });
    document.getElementById('zoomLevelDisplay').addEventListener('click', () => {
        _vpScale = 1; _vpX = 0; _vpY = 0; applyVP();
    });

    // ── Keyboard shortcuts ───────────────────────────────────────────────────
    document.addEventListener('keydown', e => {
        const mod = e.ctrlKey || e.metaKey;
        if (!mod) return;
        if (e.key === '0') {
            _vpScale = 1; _vpX = 0; _vpY = 0; applyVP(); e.preventDefault();
        } else if (e.key === '=' || e.key === '+') {
            const r = vw.getBoundingClientRect();
            zoomAt(r.width / 2, r.height / 2, 1.25); e.preventDefault();
        } else if (e.key === '-') {
            const r = vw.getBoundingClientRect();
            zoomAt(r.width / 2, r.height / 2, 1 / 1.25); e.preventDefault();
        }
    });
})();


// ── Center / fit-all + zoom-to-selected ───────────────────────────────────────
function _animateVP(targetScale, targetX, targetY, duration = 300){
    const startScale = _vpScale, startX = _vpX, startY = _vpY;
    const startTime  = performance.now();
    function step(now){
        const t    = Math.min(1, (now - startTime) / duration);
        const ease = t < 0.5 ? 2*t*t : -1+(4-2*t)*t;
        _vpScale = startScale + (targetScale - startScale) * ease;
        _vpX     = startX     + (targetX     - startX)     * ease;
        _vpY     = startY     + (targetY     - startY)     * ease;
        _applyVP();
        if(t < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
}

document.getElementById('centerViewBtn').addEventListener('click', () => {
    const vw = document.getElementById('viewportWrapper');
    const cc = document.getElementById('canvasContainer');
    if(!vw || !cc) return;

    const vwRect = vw.getBoundingClientRect();
    const MARGIN = 40;
    let targetScale = 1, targetX = 0, targetY = 0;

    // Push undo before moving so Ctrl+Z can revert the view
    globalUndoStack.push({ type: 'pan', prevX: _vpX, prevY: _vpY, prevScale: _vpScale });
    if(globalUndoStack.length > MAX_UNDO_HISTORY) globalUndoStack.shift();
    globalRedoStack = [];
    updateUndoRedoButtons();

    // ── Zoom to selected ──────────────────────────────────────────────────────
    if(activeIndices.length > 0){
        // Union bounding rect of selected wrappers (in screen space)
        let minLeft = Infinity, minTop = Infinity, maxRight = -Infinity, maxBottom = -Infinity;
        activeIndices.forEach(i => {
            const w = canvasData[i]?.wrapperEl;
            if(!w) return;
            const r = w.getBoundingClientRect();
            if(r.left   < minLeft)   minLeft   = r.left;
            if(r.top    < minTop)    minTop    = r.top;
            if(r.right  > maxRight)  maxRight  = r.right;
            if(r.bottom > maxBottom) maxBottom = r.bottom;
        });

        // Convert union rect from screen space → natural container coords
        // (inverse of: screenX = vwRect.left + _vpX + natX * _vpScale)
        const natLeft = (minLeft   - vwRect.left - _vpX) / _vpScale;
        const natTop  = (minTop    - vwRect.top  - _vpY) / _vpScale;
        const natW    = (maxRight  - minLeft) / _vpScale;
        const natH    = (maxBottom - minTop)  / _vpScale;

        const fitScaleX = (vwRect.width  - MARGIN * 2) / natW;
        const fitScaleY = (vwRect.height - MARGIN * 2) / natH;
        targetScale = Math.max(0.08, Math.min(2, Math.min(fitScaleX, fitScaleY)));

        // Translate so the union center sits at the viewport center
        targetX = vwRect.width  / 2 - (natLeft + natW / 2) * targetScale;
        targetY = vwRect.height / 2 - (natTop  + natH / 2) * targetScale;

    // ── Fit all ───────────────────────────────────────────────────────────────
    } else if(canvasData.length > 0){
        const ccRect = cc.getBoundingClientRect();
        const natW = ccRect.width  / _vpScale;
        const natH = ccRect.height / _vpScale;
        const fitScaleX = (vwRect.width  - MARGIN * 2) / natW;
        const fitScaleY = (vwRect.height - MARGIN * 2) / natH;
        targetScale = Math.min(1, Math.max(0.08, Math.min(fitScaleX, fitScaleY)));
        targetX = (vwRect.width  - natW * targetScale) / 2;
        targetY = (vwRect.height - natH * targetScale) / 2;
    }

    _animateVP(targetScale, targetX, targetY);
});


// ── Column count control ──────────────────────────────────────────────────────
(()=>{
    const container   = document.getElementById('canvasContainer');
    const input       = document.getElementById('numColsInput');
    let _colsRebuildTimer = null;

    function applyGridColumns() {
        container.style.gridTemplateColumns =
            `repeat(${_numColumns}, max-content)`;
        container.style.width = 'max-content';
    }

    async function rebuildForColumns() {
        if (!canvasData.length) {
            applyGridColumns();
            return;
        }
        const snapshot = buildSnapshot();
        applyGridColumns();
        await createCanvasPreviewsFromSnapshot(snapshot);
        syncSliders();
        updateWindowBorders();
    }

    input.addEventListener('change', () => {
        const raw = parseInt(input.value, 10);
        const clamped = Math.max(1, Math.min(20, isNaN(raw) ? _numColumns : raw));
        input.value = clamped;
        if (clamped === _numColumns) return;
        pushLayoutUndo();
        _numColumns = clamped;
        clearTimeout(_colsRebuildTimer);
        _colsRebuildTimer = setTimeout(rebuildForColumns, 0);
    });

    // Also apply the grid immediately on page load so CSS matches _numColumns
    applyGridColumns();

    // When the responsive breakpoint forces single-column layout, reflect that
    // in the Cols input so the displayed value matches what the user actually sees.
    const mq = window.matchMedia('(max-width: 900px)');
    function syncColsInputToBreakpoint(e) {
        if (e.matches) {
            input.value = 1;
            input.disabled = true;
            input.title = 'Single column forced on small screens';
        } else {
            input.value = _numColumns;
            input.disabled = false;
            input.title = 'Number of columns (1\u201320)';
        }
    }
    mq.addEventListener('change', syncColsInputToBreakpoint);
    syncColsInputToBreakpoint(mq);
})();


// ── Row / Column gap controls ─────────────────────────────────────────────────
(()=>{
    const container  = document.getElementById('canvasContainer');
    const rowInput   = document.getElementById('rowGapInput');
    const colInput   = document.getElementById('colGapInput');

    function applyGaps() {
        container.style.rowGap    = _rowGap + 'px';
        container.style.columnGap = _colGap + 'px';
    }

    rowInput.addEventListener('change', () => {
        const v = Math.max(0, Math.min(200, parseInt(rowInput.value, 10) || 0));
        rowInput.value = v;
        if (v === _rowGap) return;
        pushLayoutUndo();
        _rowGap = v;
        applyGaps();
    });

    colInput.addEventListener('change', () => {
        const v = Math.max(0, Math.min(200, parseInt(colInput.value, 10) || 0));
        colInput.value = v;
        if (v === _colGap) return;
        pushLayoutUndo();
        _colGap = v;
        applyGaps();
    });

    // Initialise on load
    applyGaps();
})();


// ── Toolbar tools: text + marquee-select + hand-pan ──────────────────────────
(()=>{
    const vw        = document.getElementById('viewportWrapper');
    const cc        = document.getElementById('canvasContainer');
    const textBtn   = document.getElementById('toolTextBtn');
    const selectBtn = document.getElementById('toolSelectBtn');
    const panBtn    = document.getElementById('toolPanBtn');

    // Rubber-band selection overlay
    const rb = document.createElement('div');
    rb.id = 'selectionRubberBand';
    Object.assign(rb.style, {
        position:'fixed', pointerEvents:'none', zIndex:'9998',
        border:'1.5px dashed #1e5eff', background:'rgba(30,94,255,0.08)',
        display:'none', boxSizing:'border-box'
    });
    document.body.appendChild(rb);

    function showRb(x1, y1, x2, y2) {
        rb.style.left   = Math.min(x1, x2) + 'px';
        rb.style.top    = Math.min(y1, y2) + 'px';
        rb.style.width  = Math.abs(x2 - x1) + 'px';
        rb.style.height = Math.abs(y2 - y1) + 'px';
    }

    // ── Tool toggle ──────────────────────────────────────────────────────────
    function setTool(tool) {
        _activeTool = (_activeTool === tool) ? null : tool;
        textBtn.classList.toggle('tool-active',   _activeTool === 'text');
        selectBtn.classList.toggle('tool-active', _activeTool === 'select');
        panBtn.classList.toggle('tool-active',    _activeTool === 'pan');
        // Disable Fabric pointer events while a tool is active so drags don't
        // accidentally move designs.
        cc.style.pointerEvents = (_activeTool !== null) ? 'none' : '';
        vw.style.cursor = _activeTool === 'pan'    ? 'grab'
                        : _activeTool === 'select' ? 'crosshair'
                        : _activeTool === 'text'   ? 'text'
                        : '';
    }
    window._setActiveTool = setTool;

    textBtn.addEventListener('click',   () => setTool('text'));
    selectBtn.addEventListener('click', () => setTool('select'));
    panBtn.addEventListener('click',    () => setTool('pan'));

    // ── Marquee select ───────────────────────────────────────────────────────
    let _selStart = null, _selDragging = false;

    vw.addEventListener('mousedown', e => {
        if (_activeTool !== 'select' || e.button !== 0) return;
        e.preventDefault();
        _selStart    = { x: e.clientX, y: e.clientY };
        _selDragging = false;
    });

    document.addEventListener('mousemove', e => {
        if (!_selStart || _activeTool !== 'select') return;
        if (!_selDragging &&
            (Math.abs(e.clientX - _selStart.x) > 3 || Math.abs(e.clientY - _selStart.y) > 3)) {
            _selDragging = true;
            rb.style.display = 'block';
        }
        if (_selDragging) showRb(_selStart.x, _selStart.y, e.clientX, e.clientY);
    });

    document.addEventListener('mouseup', e => {
        if (_activeTool !== 'select' || !_selStart) return;
        rb.style.display = 'none';

        if (_selDragging) {
            const rx1 = Math.min(_selStart.x, e.clientX);
            const ry1 = Math.min(_selStart.y, e.clientY);
            const rx2 = Math.max(_selStart.x, e.clientX);
            const ry2 = Math.max(_selStart.y, e.clientY);

            // Record the pre-selection state for undo
            globalUndoStack.push({ type: 'selection', prevActiveIndices: [...activeIndices] });
            if (globalUndoStack.length > MAX_UNDO_HISTORY) globalUndoStack.shift();
            globalRedoStack = [];
            updateUndoRedoButtons();

            // Find windows whose wrappers intersect the rubber-band rect
            const newIndices = [];
            canvasData.forEach((d, i) => {
                if (!d.wrapperEl) return;
                const wr = d.wrapperEl.getBoundingClientRect();
                if (wr.right > rx1 && wr.left < rx2 && wr.bottom > ry1 && wr.top < ry2) {
                    newIndices.push(i);
                }
            });

            activeIndices = newIndices;
            lastSelectedIndex = canvasData[newIndices[newIndices.length - 1]] ?? null;
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
            suppressNextWrapperClick = true;
        }

        _selStart    = null;
        _selDragging = false;
    });

    // ── Hand pan tool ────────────────────────────────────────────────────────
    let _panPreX = 0, _panPreY = 0, _panPreScale = 1;

    vw.addEventListener('mousedown', e => {
        if (_activeTool !== 'pan' || e.button !== 0) return;
        e.preventDefault();
        _panPreX = _vpX; _panPreScale = _vpScale;
        _panPreY = _vpY;
        // Reuse the viewport IIFE's pan state — its mousemove/mouseup handlers
        // pick up _vpPanning automatically, so the viewport updates as normal.
        _vpPanning  = true;
        _vpPanMoved = false;
        _vpPanStart = { x: e.clientX - _vpX, y: e.clientY - _vpY };
        vw.style.cursor = 'grabbing';
        _beginWatermarkInteraction();
    });

    document.addEventListener('mouseup', () => {
        if (_activeTool !== 'pan') return;
        // The viewport IIFE's mouseup resets cursor to '' — restore 'grab'.
        requestAnimationFrame(() => { if (_activeTool === 'pan') vw.style.cursor = 'grab'; });
        if (_vpPanMoved) {
            globalUndoStack.push({ type: 'pan', prevX: _panPreX, prevY: _panPreY, prevScale: _panPreScale });
            if (globalUndoStack.length > MAX_UNDO_HISTORY) globalUndoStack.shift();
            globalRedoStack = [];
            updateUndoRedoButtons();
        }
    });
})();


// ── Canvas text tool ─────────────────────────────────────────────────────────
(()=>{
    const vw = document.getElementById('viewportWrapper');
    const tl = document.getElementById('textLayer');

    // ── screen → canvas-space coords ─────────────────────────────────────────
    function toCanvas(clientX, clientY) {
        const r = vw.getBoundingClientRect();
        return {
            x: (clientX - r.left - _vpX) / _vpScale,
            y: (clientY - r.top  - _vpY) / _vpScale
        };
    }

    // ── Floating font-size toolbar (singleton) ────────────────────────────────
    const fontToolbar = document.createElement('div');
    fontToolbar.className = 'tb-font-toolbar';
    fontToolbar.innerHTML =
        '<label>Size</label>' +
        '<select id="tbFontSizeSelect">' +
        [10,11,12,14,16,18,20,24,28,32,36,48,60,72].map(s =>
            `<option value="${s}"${s===14?' selected':''}>${s}px</option>`
        ).join('') +
        '</select>';
    document.body.appendChild(fontToolbar);

    let _activeTbText = null;  // the currently focused .tb-text element

    // Position toolbar above the selection / box
    function positionFontToolbar(anchorEl) {
        const r = anchorEl.getBoundingClientRect();
        fontToolbar.style.left = r.left + 'px';
        fontToolbar.style.top  = Math.max(4, r.top - 34) + 'px';
    }

    // Apply font size to current selection inside a .tb-text
    const fontSizeSelect = fontToolbar.querySelector('#tbFontSizeSelect');
    fontSizeSelect.addEventListener('mousedown', e => e.stopPropagation());
    fontSizeSelect.addEventListener('change', () => {
        const px = fontSizeSelect.value;
        if (!_activeTbText) return;
        _activeTbText.focus();
        // Restore selection if browser wiped it on select change
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) return;
        // Use fontName trick: mark selection, then replace <font> with <span>
        document.execCommand('fontName', false, '__TBFS__');
        _activeTbText.querySelectorAll('font[face="__TBFS__"]').forEach(f => {
            const span = document.createElement('span');
            span.style.fontSize = px + 'px';
            span.innerHTML = f.innerHTML;
            f.replaceWith(span);
        });
        const box = _textBoxes.find(b => b.textEl === _activeTbText);
        if (box) { box.content = _activeTbText.innerHTML; autoSaveSession(); }
    });

    // Show/hide toolbar based on selection
    document.addEventListener('selectionchange', () => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || !sel.rangeCount) {
            fontToolbar.classList.remove('visible');
            return;
        }
        const anchor = sel.anchorNode;
        const textEl = anchor?.closest?.('.tb-text') ||
                       anchor?.parentElement?.closest('.tb-text');
        if (!textEl) { fontToolbar.classList.remove('visible'); return; }
        fontToolbar.classList.add('visible');
        positionFontToolbar(textEl.closest('.canvas-text-box'));
    });

    // ── Build one text-box element ────────────────────────────────────────────
    function createTextBox(x, y, w, h, content) {
        // Outer wrapper — handles border, shadow, drag
        const el = document.createElement('div');
        el.className  = 'canvas-text-box';
        el.style.left = x + 'px';
        el.style.top  = y + 'px';
        if (w > 0) {
            el.style.width = Math.max(120, w) + 'px';
        } else {
            // Click-created: grow horizontally until user resizes
            el.classList.add('tb-auto-width');
        }
        // NO height set — auto-expands with content

        // Thin grab bar at the top
        const bar = document.createElement('div');
        bar.className = 'tb-drag-bar';
        el.appendChild(bar);

        // Inner contenteditable
        const textEl = document.createElement('div');
        textEl.className       = 'tb-text';
        textEl.contentEditable = 'true';
        textEl.spellcheck      = false;
        if (content) textEl.innerHTML = content;
        el.appendChild(textEl);

        // Right-edge resize handle (sets fixed width, enables wrapping)
        const resizeR = document.createElement('div');
        resizeR.className = 'tb-resize-r';
        el.appendChild(resizeR);

        // Bottom-edge resize handle (sets min-height)
        const resizeB = document.createElement('div');
        resizeB.className = 'tb-resize-b';
        el.appendChild(resizeB);

        // Delete button
        const del = document.createElement('button');
        del.className   = 'tb-delete';
        del.textContent = '×';
        del.title       = 'Delete text box';
        el.appendChild(del);

        // Restore bottom-resize min-height if previously set
        if (h > 0) textEl.style.minHeight = (h - 13) + 'px';

        tl.appendChild(el);

        const box = { id: _tbNextId++, x, y, w: w || 0, h: h || 0, content: content || '', el, textEl };
        _textBoxes.push(box);

        // ── Sync content (save HTML to preserve font sizes) ───────────────────
        textEl.addEventListener('input', () => {
            box.content = textEl.innerHTML;
            autoSaveSession();
        });

        // ── Focus / blur styling ──────────────────────────────────────────────
        textEl.addEventListener('focus', () => {
            el.classList.add('tb-focused');
            _activeTbText = textEl;
            // Push undo snapshot before editing begins (once per focus session).
            // Skip if this is a brand-new box (creation already pushed an entry).
            if (!box._skipFocusUndo) pushTextBoxUndo();
            box._skipFocusUndo = false;
        });
        textEl.addEventListener('blur', () => {
            el.classList.remove('tb-focused');
            if (_activeTbText === textEl) _activeTbText = null;
            fontToolbar.classList.remove('visible');
            setTimeout(() => {
                if (document.activeElement !== textEl && !textEl.innerText.trim()) {
                    deleteTextBox(box);
                }
            }, 200);
        });

        // ── ESC: blur ─────────────────────────────────────────────────────────
        textEl.addEventListener('keydown', e => {
            if (e.key === 'Escape') { e.preventDefault(); textEl.blur(); }
        });

        // ── Stop wrapper mousedown from bubbling to vw ────────────────────────
        el.addEventListener('mousedown', e => e.stopPropagation());

        // ── Delete button ─────────────────────────────────────────────────────
        del.addEventListener('mousedown', e => { e.stopPropagation(); e.preventDefault(); });
        del.addEventListener('click',     e => { e.stopPropagation(); pushTextBoxUndo(); deleteTextBox(box); });

        // ── Drag: grab bar OR border drag (click target is the outer el) ──────
        function startDrag(e) {
            e.stopPropagation();
            e.preventDefault();
            el.style.cursor = 'grabbing';
            const startCX = e.clientX, startCY = e.clientY;
            const startBX = box.x,     startBY = box.y;
            const preDragState = captureTextBoxState(); // snapshot BEFORE move
            let moved = false;
            function onMove(ev) {
                const dx = (ev.clientX - startCX) / _vpScale;
                const dy = (ev.clientY - startCY) / _vpScale;
                if (!moved && Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
                moved = true;
                box.x = startBX + dx;
                box.y = startBY + dy;
                el.style.left = box.x + 'px';
                el.style.top  = box.y + 'px';
            }
            function onUp() {
                el.style.cursor = '';
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup',   onUp);
                if (moved) {
                    globalUndoStack.push({ type: 'textboxes', state: preDragState });
                    if (globalUndoStack.length > MAX_UNDO_HISTORY) globalUndoStack.shift();
                    globalRedoStack = [];
                    updateUndoRedoButtons();
                    autoSaveSession();
                }
            }
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup',   onUp);
        }

        // Drag from the grab bar always moves
        bar.addEventListener('mousedown', startDrag);

        // Drag from the outer wrapper (border zone) moves only if target is el itself
        el.addEventListener('mousedown', e => {
            if (e.target === el) startDrag(e);
        });

        // ── Right-edge resize (width) ─────────────────────────────────────────
        resizeR.addEventListener('mousedown', e => {
            e.stopPropagation();
            e.preventDefault();
            const startCX      = e.clientX;
            const startW       = el.getBoundingClientRect().width / _vpScale;
            const preResStateR = captureTextBoxState();
            let resizedR = false;
            function onMove(ev) {
                const newW = Math.max(80, startW + (ev.clientX - startCX) / _vpScale);
                el.style.width = newW + 'px';
                box.w = newW;
                el.classList.remove('tb-auto-width');
                resizedR = true;
            }
            function onUp() {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup',   onUp);
                if (resizedR) {
                    globalUndoStack.push({ type: 'textboxes', state: preResStateR });
                    if (globalUndoStack.length > MAX_UNDO_HISTORY) globalUndoStack.shift();
                    globalRedoStack = [];
                    updateUndoRedoButtons();
                    autoSaveSession();
                }
            }
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup',   onUp);
        });

        // ── Bottom-edge resize (min-height) ───────────────────────────────────
        resizeB.addEventListener('mousedown', e => {
            e.stopPropagation();
            e.preventDefault();
            const startCY      = e.clientY;
            const startH       = el.getBoundingClientRect().height / _vpScale;
            const preResStateB = captureTextBoxState();
            let resizedB = false;
            function onMove(ev) {
                const newH = Math.max(40, startH + (ev.clientY - startCY) / _vpScale);
                textEl.style.minHeight = (newH - 13) + 'px';
                box.h = newH;
                resizedB = true;
            }
            function onUp() {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup',   onUp);
                if (resizedB) {
                    globalUndoStack.push({ type: 'textboxes', state: preResStateB });
                    if (globalUndoStack.length > MAX_UNDO_HISTORY) globalUndoStack.shift();
                    globalRedoStack = [];
                    updateUndoRedoButtons();
                    autoSaveSession();
                }
            }
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup',   onUp);
        });

        return box;
    }

    // Expose restore helpers for load/autorestore and undo/redo paths
    window._restoreTextBoxes = function(boxes) {
        _textBoxes.forEach(b => { if (b.el.parentNode) b.el.parentNode.removeChild(b.el); });
        _textBoxes = [];
        _tbNextId  = 1;
        (boxes || []).forEach(b => createTextBox(b.x, b.y, b.w || 0, b.h || 0, b.content || ''));
    };

    // Used by the undo/redo engine to apply a textboxes snapshot
    window._applyTextBoxState = function(state) {
        _textBoxes.forEach(b => { if (b.el && b.el.parentNode) b.el.parentNode.removeChild(b.el); });
        _textBoxes = [];
        (state || []).forEach(b => createTextBox(b.x, b.y, b.w || 0, b.h || 0, b.content || ''));
        autoSaveSession();
    };

    // ── Drag-to-create state ──────────────────────────────────────────────────
    let _tbStart    = null;   // { clientX, clientY, canvasX, canvasY }
    let _tbPreview  = null;   // temporary preview div
    let _tbDragging = false;

    vw.addEventListener('mousedown', e => {
        if (_activeTool !== 'text' || e.button !== 0) return;
        if (clipEditMode || colorLayerMode) return;   // don't create text boxes in special modes
        if (e.target.closest('.canvas-text-box')) return;
        e.preventDefault();
        const pos = toCanvas(e.clientX, e.clientY);
        _tbStart    = { clientX: e.clientX, clientY: e.clientY, ...pos };
        _tbDragging = false;

        // Placeholder preview div
        _tbPreview = document.createElement('div');
        _tbPreview.className = 'canvas-text-box';
        _tbPreview.style.pointerEvents = 'none';
        _tbPreview.style.opacity = '0.45';
        _tbPreview.style.left = pos.x + 'px';
        _tbPreview.style.top  = pos.y + 'px';
        _tbPreview.style.width  = '2px';
        _tbPreview.style.height = '2px';
        tl.appendChild(_tbPreview);
    });

    document.addEventListener('mousemove', e => {
        if (!_tbStart || _activeTool !== 'text') return;
        const dx = e.clientX - _tbStart.clientX;
        const dy = e.clientY - _tbStart.clientY;
        if (!_tbDragging && (Math.abs(dx) > 5 || Math.abs(dy) > 5)) _tbDragging = true;
        if (_tbDragging && _tbPreview) {
            const cur = toCanvas(e.clientX, e.clientY);
            const x = Math.min(_tbStart.x, cur.x);
            const y = Math.min(_tbStart.y, cur.y);
            const w = Math.max(80,  Math.abs(cur.x - _tbStart.x));
            const h = Math.max(28, Math.abs(cur.y - _tbStart.y));
            _tbPreview.style.left   = x + 'px';
            _tbPreview.style.top    = y + 'px';
            _tbPreview.style.width  = w + 'px';
            _tbPreview.style.height = h + 'px';
        }
    });

    document.addEventListener('mouseup', e => {
        if (!_tbStart || _activeTool !== 'text') return;
        if (clipEditMode || colorLayerMode) { _tbStart = null; _tbDragging = false; return; }
        if (_tbPreview && _tbPreview.parentNode) _tbPreview.parentNode.removeChild(_tbPreview);
        _tbPreview = null;

        if (_tbDragging) {
            const cur = toCanvas(e.clientX, e.clientY);
            const x = Math.min(_tbStart.x, cur.x);
            const y = Math.min(_tbStart.y, cur.y);
            const w = Math.max(80,  Math.abs(cur.x - _tbStart.x));
            const h = Math.max(28, Math.abs(cur.y - _tbStart.y));
            pushTextBoxUndo(); // snapshot BEFORE creating the box
            const box = createTextBox(x, y, w, h, '');
            box._skipFocusUndo = true; // creation already pushed an entry
            setTimeout(() => box.textEl.focus(), 0);
        } else {
            pushTextBoxUndo(); // snapshot BEFORE creating the box
            const box = createTextBox(_tbStart.x, _tbStart.y, 0, 0, '');
            box._skipFocusUndo = true; // creation already pushed an entry
            setTimeout(() => box.textEl.focus(), 0);
        }

        _tbStart    = null;
        _tbDragging = false;
        suppressNextWrapperClick = true;
    });
})();


// ── Full snapshot (windows + text boxes) ─────────────────────────────────────
function buildFullSnapshot() {
    // Only lightweight undo types are serialisable (pan/selection have no image data).
    // canvas-type and layout-type entries contain full data-URL snapshots — too large.
    const serializableTypes = new Set(['pan', 'selection']);
    const undoHistory = globalUndoStack
        .filter(e => serializableTypes.has(e.type))
        .slice(-20);

    return {
        schemaVersion: 1,
        name:        _projectName || 'Untitled project',
        windows:     buildSnapshot(),
        textBoxes:   _textBoxes.map(b => ({ x: b.x, y: b.y, w: b.w, h: b.h, content: b.content })),
        viewport:    { scale: _vpScale, x: _vpX, y: _vpY },
        layout:      { cols: _numColumns, rowGap: _rowGap, colGap: _colGap },
        undoHistory: undoHistory
    };
}

// ── Snapshot meta-restore helpers ─────────────────────────────────────────────
function _applyLayoutFromSnapshot(layout) {
    if (!layout) return;
    _numColumns = layout.cols   ?? 4;
    _rowGap     = layout.rowGap ?? 20;
    _colGap     = layout.colGap ?? 20;
    const colsInput = document.getElementById('numColsInput');
    const rowInput  = document.getElementById('rowGapInput');
    const colInput  = document.getElementById('colGapInput');
    if (colsInput) colsInput.value = _numColumns;
    if (rowInput)  rowInput.value  = _rowGap;
    if (colInput)  colInput.value  = _colGap;
    const container = document.getElementById('canvasContainer');
    if (container) {
        container.style.gridTemplateColumns = `repeat(${_numColumns}, max-content)`;
        container.style.width = 'max-content';
        container.style.rowGap    = _rowGap + 'px';
        container.style.columnGap = _colGap + 'px';
    }
}

function _applyViewportFromSnapshot(vp) {
    if (!vp) return;
    _vpScale = vp.scale ?? 1;
    _vpX     = vp.x     ?? 0;
    _vpY     = vp.y     ?? 0;
    _applyVP();
}

function _applyUndoHistoryFromSnapshot(history) {
    if (!history || !history.length) return;
    for (const entry of history) globalUndoStack.push(entry);
    if (globalUndoStack.length > MAX_UNDO_HISTORY) {
        globalUndoStack.splice(0, globalUndoStack.length - MAX_UNDO_HISTORY);
    }
    globalRedoStack = [];
    updateUndoRedoButtons();
}


window.addEventListener('DOMContentLoaded', async ()=>{

    const snapshot = await _autosaveDB.get('session').catch(e => {
        console.error('[Restore] IDB read failed:', e);
        return null;
    });

    if(!snapshot){
        console.log('[Restore] No session found in IndexedDB — showing drop zone');
        return;
    }

    const isLegacy = Array.isArray(snapshot);
    const windows  = isLegacy ? snapshot : (snapshot.windows  || []);
    const tboxes   = isLegacy ? []       : (snapshot.textBoxes || []);

    console.log('[Restore] Session found —', windows.length, 'window(s),', tboxes.length, 'text box(es)');

    if (!windows.length && !tboxes.length) return;

    _applyLayoutFromSnapshot(isLegacy ? null : snapshot.layout);

    if (windows.length){
        try {
            await createCanvasPreviewsFromSnapshot(windows);
        } catch(e) {
            console.error('[Restore] createCanvasPreviewsFromSnapshot threw:', e);
        }
    }

    if (window._restoreTextBoxes) window._restoreTextBoxes(tboxes);
    _applyViewportFromSnapshot(isLegacy ? null : snapshot.viewport);
    _applyUndoHistoryFromSnapshot(isLegacy ? null : snapshot.undoHistory);

    syncSliders();
    updateWindowBorders();
    updateDropUI();
});


// ── Drag-to-reorder windows ───────────────────────────────────────────────────
(()=>{
    const container = document.getElementById('canvasContainer');
    let _dragSrcCell       = null;
    let _dragOrigNext      = null; // next sibling at dragstart — used to restore on cancel
    let _dropTarget        = null;
    let _dropBefore        = true;
    let _pendingFromHandle = false;
    let _dropped           = false; // true when drop fired (so dragend skips restore)

    // Track whether the drag was initiated from a drag handle
    document.addEventListener('mousedown', e => {
        _pendingFromHandle = e.target.classList.contains('drag-handle');
    });

    container.addEventListener('dragstart', e => {
        if(!_pendingFromHandle){ e.preventDefault(); return; }
        if(clipEditMode || colorLayerMode){ e.preventDefault(); return; }
        const cell = e.target.closest('.window-cell');
        if(!cell){ e.preventDefault(); return; }
        const srcData = canvasData.find(d => d.cellEl === cell);
        if(srcData?.locked){ e.preventDefault(); return; }
        _dragSrcCell  = cell;
        _dragOrigNext = cell.nextElementSibling; // remember original position
        _dropped      = false;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', '');
        // Delay so the ghost image captures the element at full opacity
        requestAnimationFrame(() => cell.classList.add('drag-source'));
    });

    container.addEventListener('dragover', e => {
        if(!_dragSrcCell) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const cell = e.target.closest('.window-cell');
        if(!cell || cell === _dragSrcCell) return;
        const rect   = cell.getBoundingClientRect();
        const before = e.clientX < rect.left + rect.width / 2;
        // Only move if target or direction changed (avoids unnecessary reflows)
        if(cell === _dropTarget && before === _dropBefore) return;
        _dropTarget = cell;
        _dropBefore = before;
        // Live DOM reorder — grid reflows so surrounding items shift to fill the gap
        if(before) cell.before(_dragSrcCell);
        else       cell.after(_dragSrcCell);
    });

    container.addEventListener('dragend', () => {
        if(_dragSrcCell){
            _dragSrcCell.classList.remove('drag-source');
            // Drag was cancelled (no drop) — restore to original position
            if(!_dropped){
                const parent = _dragSrcCell.parentNode;
                if(parent) parent.insertBefore(_dragSrcCell, _dragOrigNext);
            }
        }
        _dragSrcCell   = null;
        _dropTarget    = null;
        _dragOrigNext  = null;
        _dropped       = false;
        _pendingFromHandle = false;
    });

    container.addEventListener('drop', e => {
        e.preventDefault();
        if(!_dragSrcCell){ return; }

        _dropped = true; // tell dragend not to restore

        // No reorder needed — live dragover already placed the element correctly

        // ── 0. Push undo ──────────────────────────────────────────────────────
        globalUndoStack.push({ type: 'reorder', order: [...canvasData] });
        if(globalUndoStack.length > MAX_UNDO_HISTORY) globalUndoStack.shift();
        globalRedoStack = [];
        updateUndoRedoButtons();
        _markDirty();

        // ── 1. Remove drag-source class ───────────────────────────────────────
        _dragSrcCell.classList.remove('drag-source');

        // ── 2. Rebuild canvasData to match new DOM order ──────────────────────
        const oldCanvasData = [...canvasData];
        const selectedDatas = activeIndices.map(i => oldCanvasData[i]);

        const cells = [...container.querySelectorAll('.window-cell')];
        canvasData = cells.map(c => oldCanvasData.find(d => d.cellEl === c));

        // ── 3. Remap active indices ───────────────────────────────────────────
        activeIndices = selectedDatas.map(d => canvasData.indexOf(d)).filter(i => i !== -1);
        if(lastSelectedIndex !== null && !canvasData.includes(lastSelectedIndex)){
            lastSelectedIndex = null;
        }

        _dragSrcCell  = null;
        _dropTarget   = null;

        updateWindowBorders();
        updateSelectButtonState();
        autoSaveSession();
    });
})();


// ── Filename undo ──────────────────────────────────────────────────────────────
// Push one undo entry the first time a filename input is focused in each
// editing session (reset on blur so a second edit session pushes again).
// This captures the state of ALL selected windows plus the edited window,
// covering both single and batch renames.
document.getElementById('canvasContainer').addEventListener('focus', e => {
    if(!e.target.classList.contains('filename-input')) return;
    const wrapper = e.target.closest('.canvas-wrapper');
    if(!wrapper) return;
    const srcData = canvasData.find(d => d.wrapperEl === wrapper);
    if(!srcData || srcData._filenameUndoPushed) return;
    srcData._filenameUndoPushed = true;
    const srcIdx = canvasData.indexOf(srcData);
    pushGlobalUndo(srcIdx >= 0 ? srcIdx : null);
}, true); // capture phase so `focus` fires (it doesn't bubble)

document.getElementById('canvasContainer').addEventListener('blur', e => {
    if(!e.target.classList.contains('filename-input')) return;
    const wrapper = e.target.closest('.canvas-wrapper');
    if(!wrapper) return;
    const srcData = canvasData.find(d => d.wrapperEl === wrapper);
    if(srcData) srcData._filenameUndoPushed = false;
}, true);

// ── Batch rename ──────────────────────────────────────────────────────────────
// When multiple windows are selected and the user edits any one of their
// filename inputs, the new value is immediately mirrored to all other selected
// windows.
document.getElementById('canvasContainer').addEventListener('input', e => {
    if(!e.target.classList.contains('filename-input')) return;
    if(activeIndices.length <= 1) return;

    const wrapper = e.target.closest('.canvas-wrapper');
    if(!wrapper) return;
    const srcData = canvasData.find(d => d.wrapperEl === wrapper);
    if(!srcData) return;
    const srcIdx  = canvasData.indexOf(srcData);
    if(!activeIndices.includes(srcIdx)) return; // edited window isn't selected

    const newName = e.target.value;
    activeIndices.forEach(i => {
        if(i === srcIdx) return;
        const d = canvasData[i];
        if(!d) return;
        d.filename = newName;
        const inp = d.wrapperEl?.querySelector('.filename-input');
        if(inp && inp !== e.target) inp.value = newName;
    });
});

// ── Sidebar collapse + resize ─────────────────────────────────────────────────
(function(){
    const panel       = document.getElementById('contextPanel');
    const toggleBtn   = document.getElementById('sidebarToggleBtn');
    const resizeHandle = document.getElementById('sidebarResizeHandle');
    if (!toggleBtn || !panel) return;

    const COLLAPSED_W  = 26;
    const MIN_W        = 180;
    const DEFAULT_W    = 220;
    const LS_KEY       = 'sidebarWidth';

    function _savedW() {
        const v = parseInt(localStorage.getItem(LS_KEY));
        return (v >= MIN_W) ? v : DEFAULT_W;
    }

    function _applyW(w) {
        panel.style.width      = w + 'px';
        toggleBtn.style.left   = w + 'px';
    }

    function _clearW() {
        panel.style.width    = '';
        toggleBtn.style.left = '';
    }

    function setSidebarExpanded(expanded) {
        document.body.classList.toggle('sidebar-expanded', expanded);
        toggleBtn.textContent = expanded ? '◀' : '▶';
        toggleBtn.title = expanded ? 'Collapse panel' : 'Open panel';
        if (expanded) {
            _applyW(_savedW());
        } else {
            _clearW();
        }
    }

    // Expose globally so auto-expand code can use it
    window.setSidebarExpanded = setSidebarExpanded;

    // Start collapsed
    setSidebarExpanded(false);

    toggleBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        setSidebarExpanded(!document.body.classList.contains('sidebar-expanded'));
    });

    // ── Drag-to-resize ────────────────────────────────────────────────────────
    if (!resizeHandle) return;

    resizeHandle.addEventListener('mousedown', function(e) {
        if (!document.body.classList.contains('sidebar-expanded')) return;
        e.preventDefault();
        document.body.classList.add('sidebar-resizing');
        panel.style.transition    = 'none';
        toggleBtn.style.transition = 'none';

        function onMove(ev) {
            _applyW(Math.max(MIN_W, ev.clientX));
        }

        function onUp(ev) {
            const w = Math.max(MIN_W, ev.clientX);
            _applyW(w);
            localStorage.setItem(LS_KEY, w);
            document.body.classList.remove('sidebar-resizing');
            panel.style.transition    = '';
            toggleBtn.style.transition = '';
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup',   onUp);
        }

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup',   onUp);
    });
})();

// ── vpControlPanel collapse toggle ───────────────────────────────────────────
(function(){
    const panel      = document.getElementById('vpControlPanel');
    const collapseBtn = document.getElementById('vpPanelCollapseBtn');
    const teaser     = document.getElementById('vpPanelTeaser');
    if (!panel || !collapseBtn || !teaser) return;

    function setVpcHidden(hidden) {
        panel.classList.toggle('vpc-hidden', hidden);
        teaser.hidden = !hidden;
    }

    collapseBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        setVpcHidden(true);
    });
    teaser.addEventListener('click', function(e) {
        e.stopPropagation();
        setVpcHidden(false);
    });
})();

// ── Stripe checkout helper ─────────────────────────────────────────────────────
// Call _startCheckout(plan, period) from anywhere in the app to redirect the
// user to Stripe's hosted checkout page.  On success Stripe sends the user back
// to /?payment=success which triggers _handlePaymentSuccess in clerk-auth.js.
async function _startCheckout(plan, period) {
    if (!window.Clerk || !window.Clerk.user) {
        sessionStorage.setItem('ms_redirect_after_auth', 'home');
        try { sessionStorage.setItem('ms_pending_checkout_plan', plan || ''); } catch (_) {}
        try { sessionStorage.setItem('ms_pending_checkout_period', period || 'monthly'); } catch (_) {}
        await _autosaveDB.set('session', buildFullSnapshot()).catch(()=>{});
        if (window.Clerk) {
            try { window.Clerk.redirectToSignIn({ forceRedirectUrl: window.location.href }); } catch(e) { alert('Sign-in is temporarily unavailable \u2014 please refresh the page.'); }
        } else {
            alert('Sign-in is temporarily unavailable \u2014 please refresh the page.');
        }
        return;
    }

    const _planRank = { free: 0, starter: 1, pro: 2 };
    const currentPlan = (window._userPlan || 'free').toLowerCase();
    const requestedPlan = (plan || 'free').toLowerCase();
    if ((_planRank[currentPlan] ?? 0) >= (_planRank[requestedPlan] ?? 0) && currentPlan !== 'free') {
        const planLabel = requestedPlan.charAt(0).toUpperCase() + requestedPlan.slice(1);
        alert(`You\u2019re already on the ${planLabel} plan (or higher) \u2014 no need to purchase it again!`);
        return;
    }

    // Fetch a fresh Clerk session token — required for server-side JWT verification.
    const token = window.Clerk.session
        ? await window.Clerk.session.getToken().catch(function () { return null; })
        : null;

    let url;
    try {
        const resp = await fetch('/api/checkout', {
            method: 'POST',
            headers: Object.assign(
                { 'Content-Type': 'application/json' },
                token ? { 'Authorization': 'Bearer ' + token } : {}
            ),
            body: JSON.stringify({ plan, period }),
        });
        const data = await resp.json();
        if (!data.ok || !data.url) {
            console.error('Checkout error:', data.error);
            if (resp.status === 409) {
                alert(data.error || 'You\u2019re already subscribed to this plan \u2014 no charge has been made.');
            } else if (data.code === 'CLERK_UNREACHABLE') {
                alert('We couldn\u2019t verify your current plan \u2014 please refresh and try again.');
            } else if (data.code === 'CLERK_ERROR') {
                alert(data.error || 'We couldn\u2019t verify your current plan \u2014 please try again.');
            } else if (data.code === 'STRIPE_ERROR') {
                alert(data.error || 'Our payment provider returned an error \u2014 please try again in a moment.');
            } else {
                alert('Could not start checkout \u2014 please try again.');
            }
            return;
        }
        url = data.url;
    } catch (err) {
        console.error('Checkout fetch failed:', err);
        alert('Could not start checkout \u2014 please try again.');
        return;
    }

    // Persist the purchased plan so the payment poller in clerk-auth.js knows
    // exactly which plan to wait for. Critical for paid→paid upgrades
    // (e.g. Starter→Pro) where the user is already on a paid plan and
    // `alreadyUpgraded` would otherwise short-circuit the poll prematurely.
    try { localStorage.setItem('ms_pending_plan', requestedPlan); } catch (_) {}

    window.location.href = url;
}
