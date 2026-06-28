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
// 'free' | 'starter' | 'pro'  — overwritten by API call in Phase 7
var _userPlan = 'free';

var _wmTileCache = null; // cached watermark tile (one tile shared across all canvases)

function _getWatermarkTile() {
    if (_wmTileCache) return _wmTileCache;
    // Tile must be large enough so the rotated text block never clips against an edge
    var tile = document.createElement('canvas');
    tile.width  = 220;
    tile.height = 120;
    var c = tile.getContext('2d');

    c.save();
    c.translate(110, 60);
    c.rotate(-Math.PI / 5.5); // ~32.7 degrees diagonal

    c.font = 'bold 12px Arial, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';

    // Dark shadow layer — readable on light backgrounds
    c.shadowColor   = 'rgba(0,0,0,0.55)';
    c.shadowBlur    = 4;
    c.shadowOffsetX = 1;
    c.shadowOffsetY = 1;

    // Line 1: brand name
    c.fillStyle = 'rgba(255,255,255,0.62)';
    c.fillText('MOCKUP SCRIPTER', 0, -11);

    // Line 2: URL (slightly lower opacity)
    c.fillStyle = 'rgba(255,255,255,0.50)';
    c.fillText('mockupscripter.com', 0, 7);

    c.restore();
    _wmTileCache = tile;
    return tile;
}

// Draw watermark over a canvas (called from after:render).
// Applies to: all free-plan canvases with a design, AND
//             any starred (PRO-feature) windows on the Starter plan.
function _drawWatermarkOnCanvas(data) {
    var isFree    = _userPlan === 'free';
    var isStarred = _userPlan === 'starter' && data.hasProEffect;
    if (!isFree && !isStarred) return;
    if (!data.fabricCanvas || !data.designObject) return;
    var fc  = data.fabricCanvas;
    var ctx = fc.contextContainer;
    var tile = _getWatermarkTile();
    ctx.save();
    ctx.fillStyle = ctx.createPattern(tile, 'repeat');
    ctx.fillRect(0, 0, fc.width, fc.height);
    ctx.restore();
}

// Show / refresh the ⭐ PRO-feature badge on a canvas wrapper
function _updateProStarBadge(data) {
    if (!data.wrapperEl) return;
    var existing = data.wrapperEl.querySelector('.pro-star-badge');
    if (existing) existing.remove();
    if (!data.hasProEffect) return;
    var badge = document.createElement('span');
    badge.className = 'pro-star-badge' +
        (_userPlan === 'pro' ? ' pro-star-green' : ' pro-star-yellow');
    badge.textContent = '⭐ PRO';
    badge.title = _userPlan === 'pro'
        ? 'Uses a PRO feature — exports fine on your plan'
        : 'Uses a PRO feature — upgrade to export this window';
    data.wrapperEl.appendChild(badge);
}

// Mark a window as using a PRO feature + refresh its badge
function _markProEffect(data) {
    if (!data || data.hasProEffect) return;
    data.hasProEffect = true;
    _updateProStarBadge(data);
    _markDirty();
}

// Refresh all star badges (called when _userPlan changes in Phase 7)
function _refreshAllProStarBadges() {
    canvasData.forEach(function(d) { _updateProStarBadge(d); });
}

// Show the top upgrade prompt bar (once per session, dismissible)
function _showUpgradePromptIfNeeded() {
    if (_userPlan !== 'free') return;
    if (localStorage.getItem('ms_upgrade_prompt_dismissed') === '1') return;
    var el = document.getElementById('upgradePrompt');
    if (el) el.style.display = 'flex';
}

var designEraserMode     = false;  // true while design-layer eraser is active
var designEraserDown     = false;  // true while mouse button held in eraser mode
var designEraserSize     = 30;     // eraser radius in CSS pixels (visual size on screen)
var designEraserSoftness = 0;      // 0 = hard edge, 100 = fully soft
var eraserTargetObjects  = new Set(); // design objects selected at eraser-entry time

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







// Show Fabric handles on all selected designs; hide on all others.
function refreshFabricHandles(){
    canvasData.forEach(d => {
        if(!d.fabricCanvas) return;
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
            const toActivate = ownSelected[ownSelected.length - 1];
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
    document.querySelectorAll(".canvas-wrapper")
        .forEach((w,i)=>{
            w.classList.remove("active","design-active");
            const d = canvasData[i];
            if(selectedDesigns.size > 0){
                // Design-select mode: highlight windows that contain a selected object.
                // Also highlight locked windows that are in activeIndices — their designs
                // aren't in selectedDesigns (locked), but they're still "selected" windows
                // and should show the gray border (.window-locked.active in CSS).
                const hasSelected = d && (
                    (d.designObject && selectedDesigns.has(d.designObject)) ||
                    (d.extraDesignObjects||[]).some(obj => selectedDesigns.has(obj))
                );
                if(hasSelected || activeIndices.includes(i)) w.classList.add("active");
            } else if(activeIndices.includes(i)){
                w.classList.add("active");
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

function getAllDesignObjects(data){
    const seen = new Set();
    const objs = [];
    const add  = o => { if(o && !seen.has(o)){ seen.add(o); objs.push(o); } };
    add(data.designObject);
    (data.extraDesignObjects || []).forEach(add);
    // Color layer lives between bg and designs; include it so clipping updates apply to it too
    add(data.colorLayerFabricObj);
    return objs;
}

function syncSliders() {

    if(!activeIndices.length) return;

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

// Apply the full blur → noise → warp → perspective pipeline to ONE design
// object using its own _fx bag.  Called both from the design-mode slider
// handler (only the selected object) and from applyWarpToData (extra objects).
function _applyWarpToOneObject(obj, data, srcOriginal, lowQuality){

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
    if (arcA === 0 && warpA === 0) {
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
    if(data.patternMode && data.patternFabricObj){
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
        activeIndices.forEach(i => _markProEffect(canvasData[i]));
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

    // Always reset HQ debounce on every input event so HQ fires 220 ms after
    // the user stops — even when the LQ frame is throttled away.
    if(selectedDesigns.size === 0 || _needsWarp){
        clearTimeout(globalHQTimer);
        globalHQTimer = setTimeout(_hqRenderSliders, 220);
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

            _applyWarpToOneObject(obj, d, srcOriginal, true);
            d.fabricCanvas.requestRenderAll();
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

        _applyWarpToOneObject(data.designObject, data, data.designOriginal, true);

        if(data.extraDesignObjects?.length){
            data.extraDesignObjects.forEach((obj, i) => {
                const src = data.extraDesignOriginals?.[i] || data.designOriginal;
                _applyWarpToOneObject(obj, data, src, true);
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
            _applyWarpToOneObject(obj, d, srcOriginal, false);
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
        activeIndices.forEach(i => _markProEffect(canvasData[i]));
    });
});
document.getElementById('bgAdjustResetBtn').addEventListener('click', () => {
    if(!activeIndices.length) return;
    if(activeIndices.every(i => canvasData[i]?.locked)) return;
    pushGlobalUndo();
    bgHue.valueAsNumber = 0; bgSaturation.valueAsNumber = 0;
    bgBrightness.valueAsNumber = 0; bgContrast.valueAsNumber = 0;
    _updateBgAdjust();
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
        activeIndices.forEach(i => _markProEffect(canvasData[i]));
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
        });
        document.querySelectorAll('.bg-aspect-btn').forEach(b => {
            b.classList.toggle('active', b === btn);
        });
        _markDirty();
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
    });
    document.querySelectorAll('.bg-aspect-btn').forEach(b => b.classList.remove('active'));
    _markDirty();
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
    });
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
        if(on) _markProEffect(d);
    });
    _markDirty();
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
        if(d.patternMode) _renderPattern(d, false);
    });
    // Sync UI
    document.querySelectorAll('.pattern-type-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.type === 'grid'));
    _patternSliderDefs.forEach(([id]) => {
        document.getElementById(id).valueAsNumber = 0;
        document.getElementById(id + 'Val').value = 0;
    });
    _markDirty();
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
}

// ── Export Pattern PNG ────────────────────────────────────────────────────────
// Downloads the current pattern canvas (before or after baking) as a PNG file.

function _exportPatternPNG(data) {
    if (!data) return;

    let src = (data.patternMode && data.patternFabricObj)
        ? data.patternFabricObj.getElement()
        : data.designOriginal;
    if (!src) return;

    // designOriginal may be an HTMLImageElement; wrap it in a canvas for toBlob.
    if (!(src instanceof HTMLCanvasElement)) {
        const tmp = document.createElement('canvas');
        tmp.width  = src.naturalWidth  || src.width  || 1;
        tmp.height = src.naturalHeight || src.height || 1;
        tmp.getContext('2d').drawImage(src, 0, 0);
        src = tmp;
    }

    src.toBlob(blob => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const a   = document.createElement('a');
        a.href     = url;
        a.download = (data.filename || 'pattern') + '_sheet.png';
        a.click();
        URL.revokeObjectURL(url);
    }, 'image/png');
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

document.getElementById('exportPatternBtn').addEventListener('click', () => {
    if (!activeIndices.length) return;
    const data = canvasData[activeIndices[0]];
    if (!data) return;
    _exportPatternPNG(data);
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
        });
    }
});


function handleBgFiles(files){

    if(!files.length) return;

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
        document.body.classList.add('sidebar-expanded');
        const tb = document.getElementById('sidebarToggleBtn');
        if (tb) { tb.textContent = '◀'; tb.title = 'Collapse panel'; }
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
            _addDragHandle(wrapper);

            container.appendChild(wrapper);

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

            wrapper.addEventListener('click', function(e){

            // Recompute live index — closed-over `index` becomes stale after window deletions
            const index = canvasData.indexOf(data);
            if(index === -1) return;

            if(suppressNextWrapperClick){
                return;
            }

            if(clipEditMode && !clipCopySelectMode){
                return;
            }

            if(colorLayerMode && !colorCopySelectMode){
                if(!activeIndices.includes(index)){
                    alert("Exit Color Layer mode to interact with other windows.");
                }
                return;
            }

            // In color copy-select mode: simple toggle so the user can pick targets
            if(colorCopySelectMode){
                const pos = activeIndices.indexOf(index);
                if(pos === -1) activeIndices.push(index);
                else           activeIndices.splice(pos, 1);
                updateWindowBorders();
                return;
            }

                const isModifierMultiSelect = e.metaKey || e.ctrlKey;

                // SHIFT = range select — adds windows AND their original designs
                if(e.shiftKey){

                    const prevIndices = [...activeIndices];

                    if(lastSelectedIndex === null){

                        activeIndices = [index];

                    } else {

                        const lastAnchorIdx = canvasData.indexOf(lastSelectedIndex);
                        const start = Math.min(lastAnchorIdx, index);
                        const end = Math.max(lastAnchorIdx, index);

                        const range = [];

                        for(let i = start; i <= end; i++){
                            range.push(i);
                        }

                        activeIndices = [...new Set([
                            ...activeIndices,
                            ...range
                        ])];
                    }

                    // Add original designs of newly-included windows (skip locked)
                    activeIndices.forEach(i => {
                        const d = canvasData[i];
                        if(d?.designObject && !d.locked && !selectedDesigns.has(d.designObject)){
                            if(!d.designObject._fx) d.designObject._fx = _defaultFx(d);
                            selectedDesigns.add(d.designObject);
                        }
                    });
                    // Remove designs belonging to windows no longer in activeIndices
                    prevIndices.filter(i => !activeIndices.includes(i)).forEach(i => {
                        const d = canvasData[i];
                        if(d){
                            selectedDesigns.delete(d.designObject);
                            (d.extraDesignObjects||[]).forEach(obj => selectedDesigns.delete(obj));
                        }
                    });

                    lastSelectedIndex = canvasData[index];

                // CMD / CTRL = toggle window + its original design
                } else if(isModifierMultiSelect){

                    if(activeIndices.includes(index)){

                        activeIndices = activeIndices.filter(i => i !== index);

                        const d = canvasData[index];
                        if(d){
                            selectedDesigns.delete(d.designObject);
                            (d.extraDesignObjects||[]).forEach(obj => selectedDesigns.delete(obj));
                        }

                    } else {

                        activeIndices.push(index);

                        const d = canvasData[index];
                        if(d?.designObject && !d.locked){
                            if(!d.designObject._fx) d.designObject._fx = _defaultFx(d);
                            selectedDesigns.add(d.designObject);
                        }
                    }

                    lastSelectedIndex = canvasData[index];

                // Normal click = if window already selected keep group; else single-select
                } else {

                    lastSelectedIndex = canvasData[index];

                    if(!activeIndices.includes(index)){
                        // Clicking an unselected window — start fresh
                        activeIndices = [index];
                        selectedDesigns.clear();
                        const d = canvasData[index];
                        if(d?.designObject && !d.locked){
                            if(!d.designObject._fx) d.designObject._fx = _defaultFx(d);
                            selectedDesigns.add(d.designObject);
                        }
                    } else {
                        // Window already in selection — keep everything, just ensure
                        // its design is represented in selectedDesigns (skip locked)
                        const d = canvasData[index];
                        if(d?.designObject && !d.locked && !selectedDesigns.has(d.designObject)){
                            if(!d.designObject._fx) d.designObject._fx = _defaultFx(d);
                            selectedDesigns.add(d.designObject);
                        }
                    }
                }

                if(e.shiftKey){
                    lastSelectedIndex = canvasData[index];
                }

                refreshFabricHandles();
                updateWindowBorders();
                updateLayerButtons();
                syncSliders();
                updateSelectButtonState();
            });

            
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

    // One-time canvas-level handler: track design object clicks for multi-select
    if(!data._canvasHandlersAttached){
        data._canvasHandlersAttached = true;
        data.fabricCanvas.on('mouse:down', (opt)=>{

            const target = opt.target;

            // No target = blank canvas click; let the wrapper click handler deal with it
            if(!target) return;

            const isDesign = target === data.designObject ||
                             (data.extraDesignObjects||[]).includes(target);
            if(!isDesign) return;

            const isCmd   = opt.e?.metaKey || opt.e?.ctrlKey;
            const isShift = opt.e?.shiftKey;
            const winIdx  = canvasData.indexOf(data);

            if(isCmd){
                // Cmd/Ctrl: toggle this specific design object only
                if(selectedDesigns.has(target)){
                    selectedDesigns.delete(target);
                    // If no designs from this window remain selected, deselect the window
                    const anyLeft = [...selectedDesigns].some(obj =>
                        obj === data.designObject ||
                        (data.extraDesignObjects||[]).includes(obj)
                    );
                    if(!anyLeft && winIdx !== -1){
                        activeIndices = activeIndices.filter(i => i !== winIdx);
                    }
                } else {
                    if(!target._fx) target._fx = _defaultFx(data);
                    selectedDesigns.add(target);
                    if(winIdx !== -1 && !activeIndices.includes(winIdx)){
                        activeIndices.push(winIdx);
                    }
                }
            } else if(isShift){
                // Shift on design = window-select: add this window + its original design
                if(!data.designObject._fx) data.designObject._fx = _defaultFx(data);
                selectedDesigns.add(data.designObject);
                if(winIdx !== -1 && !activeIndices.includes(winIdx)){
                    activeIndices.push(winIdx);
                }
            } else {
                // Plain click on a design object — select only this layer.
                // Use Shift or Cmd/Ctrl to build a multi-layer selection.
                if(!selectedDesigns.has(target)){
                    // Plain click on an unselected layer — replace the current
                    // selection with just this layer.  When clicking a layer that
                    // is already selected (e.g. to start dragging it along with
                    // other selected layers) we leave the multi-selection intact.
                    selectedDesigns.clear();
                    if(winIdx !== -1) activeIndices = [winIdx];
                    if(!target._fx) target._fx = _defaultFx(data);
                    selectedDesigns.add(target);
                    refreshFabricHandles();
                    updateWindowBorders();
                    updateLayerButtons();
                    syncSliders();
                }
                // else: already selected — preserve multi-selection for group drag.
                return;
            }

            refreshFabricHandles();
            updateWindowBorders();
            updateLayerButtons();
            syncSliders();
        });

        // Draw selection handles on every selected object that isn't Fabric's active object.
        // This lets multiple objects in the same window show transform handles simultaneously
        // without needing a fabric.ActiveSelection (which would break our cross-window sync).
        data.fabricCanvas.on('after:render', () => {
            const canvas = data.fabricCanvas;
            const ctx    = canvas.contextContainer;
            const active = canvas.getActiveObject();

            [...selectedDesigns].forEach(obj => {
                const isOwn =
                    obj === data.designObject ||
                    (data.extraDesignObjects||[]).includes(obj);
                if(!isOwn) return;
                if(obj === active) return; // already has Fabric's native handles

                ctx.save();
                try {
                    obj._renderControls(ctx, { hasBorders: true, hasControls: true });
                } catch(_) {
                    // fallback: plain selection border
                    const br = obj.getBoundingRect(true, true);
                    ctx.strokeStyle = '#2196F3';
                    ctx.lineWidth   = 2;
                    ctx.setLineDash([5, 3]);
                    ctx.strokeRect(br.left, br.top, br.width, br.height);
                }
                ctx.restore();
            });

            // Warp overlay — drawn on the primary canvas that owns the warp session.
            if (designWarpMode && data === warpActiveData) {
                _drawWarpOverlay(ctx);
            }
            // Secondary canvases: draw a live deformed preview using scaled warp points.
            if (designWarpMode && data !== warpActiveData) {
                const secGroup = warpAllGroups.find((g, i) => i > 0 && g.ownerData === data);
                if (secGroup) {
                    _drawWarpPreview(ctx, secGroup.sourceCanvas, _scaledWarpPointsForGroup(secGroup));
                }
            }
            _drawWatermarkOnCanvas(data);
        });

        // Design-layer eraser mouse handlers — active only when designEraserMode is true.
        // Objects are made non-selectable on entry so clicks go straight to these handlers.
        data.fabricCanvas.on('mouse:down', (opt) => {
            if (!designEraserMode) return;

            // Snapshot ONCE at the very start of each stroke (before any pixels change).
            // Always includes this canvas's window (index) so that erasing on a window
            // that wasn't in activeIndices at entry time is still undoable.
            if (!designEraserDown) {
                const index = canvasData.indexOf(data);
                const toCapture = new Set([...activeIndices, index]);
                const items = [];
                toCapture.forEach(i => {
                    const d = canvasData[i];
                    if (!d || d.locked) return;
                    items.push({ idx: i, snap: _captureEraserSnapshot(d) });
                });
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
                _markProEffect(data);
                // When warp was active during erasing, applyDesignEraserAt only
                // updated the display element for performance.  Now that the stroke
                // is finished, rebuild the full pipeline from the erased source so
                // future blur/noise/warp changes all start from the correct state.
                // Flush this window plus every other window that was synced during
                // the stroke (they may also have _erasePendingRebuild set).
                if (data._erasePendingRebuild) {
                    data._erasePendingRebuild = false;
                    applyWarpToData(data, false);
                }
                activeIndices.forEach(i => {
                    const d = canvasData[i];
                    if (!d || d === data) return;
                    if (d._erasePendingRebuild) {
                        d._erasePendingRebuild = false;
                        applyWarpToData(d, false);
                    }
                });
            }
        });

        // Warp-mode mouse handlers — drag control points to deform the mesh.
        data.fabricCanvas.on('mouse:down', (opt) => {
            if (!designWarpMode || data !== warpActiveData) return;
            const pointer = data.fabricCanvas.getPointer(opt.e);
            let bestDist2 = 18 * 18;
            let bestRC    = null;
            for (let r = 0; r < 4; r++) {
                for (let c = 0; c < 4; c++) {
                    const p  = warpPoints[r][c];
                    const dx = p.x - pointer.x, dy = p.y - pointer.y;
                    const d2 = dx*dx + dy*dy;
                    if (d2 < bestDist2) { bestDist2 = d2; bestRC = {r, c}; }
                }
            }
            warpDragRC = bestRC;
        });
        data.fabricCanvas.on('mouse:move', (opt) => {
            if (!designWarpMode || !warpDragRC || data !== warpActiveData) return;
            const pointer = data.fabricCanvas.getPointer(opt.e);
            warpPoints[warpDragRC.r][warpDragRC.c] = {x: pointer.x, y: pointer.y};
            data.fabricCanvas.requestRenderAll();
            // Trigger live preview on all secondary canvases too.
            warpAllGroups.forEach((g, i) => {
                if (i > 0) g.ownerData.fabricCanvas.requestRenderAll();
            });
        });
        data.fabricCanvas.on('mouse:up', () => {
            if (designWarpMode) warpDragRC = null;
        });
    }

    // mouse:down handler manages selectedDesigns and syncSliders; selected event is unused.

    designTarget.on('moving', ()=>{
        designTarget._hadDragMovement = true;

        const deltaX = designTarget.left - (designTarget.lastLeft || designTarget.left);
        const deltaY = designTarget.top  - (designTarget.lastTop  || designTarget.top);

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
        // Sync every active window's main-design Fabric state back to data.
        // The moving/scaling/rotating handlers update Fabric objects directly on
        // peer windows without touching their data.* fields.  If data.* stays stale
        // and a slider change later calls applyWarpToData, that function reads data.x/y
        // and would silently teleport the design back to its pre-drag position.
        if(isMainDesign){
            activeIndices.forEach(i => {
                const d = canvasData[i];
                if(!d || d.locked || !d.designObject) return;
                const ps = d.previewScale || 1;
                d.x        = d.designObject.left;
                d.y        = d.designObject.top;
                d.scaleX   = d.designObject.scaleX / ps;
                d.scaleY   = d.designObject.scaleY / ps;
                d.rotation = d.designObject.angle;
                d.skewX    = d.designObject.skewX || 0;
                d.skewY    = d.designObject.skewY || 0;
            });
        }
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
function _addDragHandle(wrapper) {
    const handle = document.createElement('div');
    handle.className = 'drag-handle';
    handle.textContent = '⠿ drag';
    handle.title = 'Drag to reorder';
    wrapper.appendChild(handle);
    wrapper.setAttribute('draggable', 'true');
}

function _attachWrapperClickListener(wrapper, data){
    wrapper.addEventListener('click', function(e){
        const index = canvasData.indexOf(data);
        if(index === -1) return;

        if(suppressNextWrapperClick) return;

        if(designEraserMode) return;

        if(clipEditMode && !clipCopySelectMode) return;

        if(colorLayerMode && !colorCopySelectMode){
            if(!activeIndices.includes(index)){
                alert("Exit Color Layer mode to interact with other windows.");
            }
            return;
        }

        if(colorCopySelectMode){
            const pos = activeIndices.indexOf(index);
            if(pos === -1) activeIndices.push(index);
            else           activeIndices.splice(pos, 1);
            updateWindowBorders();
            return;
        }

        const isModifierMultiSelect = e.metaKey || e.ctrlKey;

        if(e.shiftKey){
            const prevIndices = [...activeIndices];
            if(lastSelectedIndex === null){
                activeIndices = [index];
            } else {
                const lastAnchorIdx = canvasData.indexOf(lastSelectedIndex);
                const start = Math.min(lastAnchorIdx, index);
                const end   = Math.max(lastAnchorIdx, index);
                const range = [];
                for(let i = start; i <= end; i++) range.push(i);
                activeIndices = [...new Set([...activeIndices, ...range])];
            }
            activeIndices.forEach(i => {
                const d = canvasData[i];
                if(d?.designObject && !d.locked && !selectedDesigns.has(d.designObject)){
                    if(!d.designObject._fx) d.designObject._fx = _defaultFx(d);
                    selectedDesigns.add(d.designObject);
                }
            });
            prevIndices.filter(i => !activeIndices.includes(i)).forEach(i => {
                const d = canvasData[i];
                if(d){
                    selectedDesigns.delete(d.designObject);
                    (d.extraDesignObjects||[]).forEach(obj => selectedDesigns.delete(obj));
                }
            });
            lastSelectedIndex = canvasData[index];
        } else if(isModifierMultiSelect){
            if(activeIndices.includes(index)){
                activeIndices = activeIndices.filter(i => i !== index);
                const d = canvasData[index];
                if(d){
                    selectedDesigns.delete(d.designObject);
                    (d.extraDesignObjects||[]).forEach(obj => selectedDesigns.delete(obj));
                }
            } else {
                activeIndices.push(index);
                const d = canvasData[index];
                if(d?.designObject && !d.locked){
                    if(!d.designObject._fx) d.designObject._fx = _defaultFx(d);
                    selectedDesigns.add(d.designObject);
                }
            }
            lastSelectedIndex = canvasData[index];
        } else {
            lastSelectedIndex = canvasData[index];
            if(!activeIndices.includes(index)){
                activeIndices = [index];
                selectedDesigns.clear();
                const d = canvasData[index];
                if(d?.designObject && !d.locked){
                    if(!d.designObject._fx) d.designObject._fx = _defaultFx(d);
                    selectedDesigns.add(d.designObject);
                }
            } else {
                const d = canvasData[index];
                if(d?.designObject && !d.locked && !selectedDesigns.has(d.designObject)){
                    if(!d.designObject._fx) d.designObject._fx = _defaultFx(d);
                    selectedDesigns.add(d.designObject);
                }
            }
        }

        if(e.shiftKey) lastSelectedIndex = canvasData[index];

        refreshFabricHandles();
        updateWindowBorders();
        updateLayerButtons();
        syncSliders();
        updateSelectButtonState();
    });
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

    // Remove wrappers from DOM without destroying Fabric canvas
    const toDelete = new Set(sortedIndices);
    sortedIndices.forEach(i => {
        const d = canvasData[i];
        if(!d) return;
        if(d.wrapperEl){
            _visibilityObserver.unobserve(d.wrapperEl);
            _visibleWrappers.delete(d.wrapperEl);
            if(d.wrapperEl.parentNode) d.wrapperEl.parentNode.removeChild(d.wrapperEl);
        }
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
            initialDesignOriginal:  srcData.designOriginal,
            designName:             srcData.designName,
            notes:                  srcData.notes || '',

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
        _addDragHandle(wrapper);

        // Insert right after the source wrapper
        const refChild = container.children[insertAt] || null;
        container.insertBefore(wrapper, refChild);
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

        // ── 5. Attach wrapper click listener ──────────────────────────────────
        _attachWrapperClickListener(wrapper, newData);

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
    }

    // Select the newly duplicated windows
    activeIndices     = newIndices;
    lastSelectedIndex = canvasData[newIndices[newIndices.length - 1]] ?? null;
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
        _addDragHandle(wrapper);

        // Insert at beginning of the grid
        container.insertBefore(wrapper, container.firstChild);

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
    });

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

    // Compute a canvas-size-independent scale ratio so the same visual
    // proportion is reproduced on any target canvas (even different sizes).
    // ratio = scaleX / fillScale  where fillScale = (1/srcDpr)/srcPs
    const srcDpr = Math.max(1, sourceData.fabricCanvas.lowerCanvasEl.width / sourceData.fabricCanvas.getWidth());
    const srcPs  = sourceData.previewScale || 1;
    const srcSX  = sourceData.scaleX ?? sourceData.scale ?? 1;
    const srcSY  = sourceData.scaleY ?? sourceData.scale ?? 1;

    _copiedLayer = {
        type:     layerType,
        el:       srcEl,
        name:     obj._uploadedDesignName || null,
        fx:       obj._fx ? JSON.parse(JSON.stringify(obj._fx)) : null,
        srcIdx:   canvasData.indexOf(sourceData),
        srcScaleX: obj.scaleX,
        srcScaleY: obj.scaleY,
        // canvas-relative scale ratios (1.0 = fills canvas exactly)
        designScaleXRatio: srcSX * srcPs * srcDpr,
        designScaleYRatio: srcSY * srcPs * srcDpr,
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
            d.x          = W / 2;
            d.y          = H / 2;
            // Apply source transforms, converting canvas-relative ratios to
            // target scale units: ratio / (tps * dpr) = fillScale × ratio
            const cl = _copiedLayer;
            const fillScale = (1 / dpr) / tps;
            d.scaleX          = cl.designScaleXRatio !== undefined ? cl.designScaleXRatio * fillScale : fillScale;
            d.scaleY          = cl.designScaleYRatio !== undefined ? cl.designScaleYRatio * fillScale : fillScale;
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
        for (const d of targets){
            if (!d.designObject) continue;
            const canvasW = d.fabricCanvas.getWidth();
            const canvasH = d.fabricCanvas.getHeight();
            const fabricImg = new fabric.Image(srcEl, {
                left:   canvasW / 2,
                top:    canvasH / 2,
                scaleX: _copiedLayer.srcScaleX,
                scaleY: _copiedLayer.srcScaleY,
                angle:  0,
                opacity: _copiedLayer.fx?.opacity ?? 1,
                globalCompositeOperation: 'source-over',
                originX: 'center',
                originY: 'center',
                transparentCorners: false,
                cornerColor: '#ff6600',
                cornerStyle: 'circle'
            });
            fabricImg._isOverlay          = true;
            fabricImg._uploadedDesignName = _copiedLayer.name || 'pasted_layer';
            fabricImg._fx = _copiedLayer.fx
                ? JSON.parse(JSON.stringify(_copiedLayer.fx))
                : { warpAmount: 0, arcAmount: 0, arcTilt: 0,
                    perspectiveTop: 0, perspectiveLeft: 0,
                    opacity: 1, blurAmount: 0, noiseAmount: 0, blendMode: 'normal' };
            d.extraDesignObjects   = d.extraDesignObjects   || [];
            d.extraDesignOriginals = d.extraDesignOriginals || [];
            d.extraDesignObjects.push(fabricImg);
            d.extraDesignOriginals.push(srcEl);
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

// ── Copy / Paste Transforms ────────────────────────────────────────────────────
var _copiedTransforms = null;

function _captureTransforms(data){
    const obj = data.designObject;
    const ps  = data.previewScale || 1;
    const cW  = data.fabricCanvas ? data.fabricCanvas.getWidth()  : 1;
    const cH  = data.fabricCanvas ? data.fabricCanvas.getHeight() : 1;
    const absX = obj ? obj.left : data.x;
    const absY = obj ? obj.top  : data.y;
    return {
        x:        absX,
        y:        absY,
        xFrac:    absX / cW,
        yFrac:    absY / cH,
        scale:    data.scale,
        scaleX:   obj ? (obj.scaleX / ps) : (data.scaleX ?? data.scale),
        scaleY:   obj ? (obj.scaleY / ps) : (data.scaleY ?? data.scale),
        skewX:    obj ? (obj.skewX  || 0) : (data.skewX  || 0),
        skewY:    obj ? (obj.skewY  || 0) : (data.skewY  || 0),
        rotation: obj ? obj.angle         : data.rotation,
        warpAmount:    data.warpAmount    ?? 0,
        arcAmount:     data.arcAmount     ?? 0,
        arcTilt:       data.arcTilt       ?? 0,
        perspectiveTop:  data.perspectiveTop  ?? 0,
        perspectiveLeft: data.perspectiveLeft ?? 0,
        opacity:     data.opacity    ?? 1,
        blurAmount:  data.blurAmount ?? 0,
        noiseAmount: data.noiseAmount ?? 0,
        blendMode:   data.blendMode  ?? 'normal',
        flipX:       !!data.flipX,
        flipY:       !!data.flipY,
        designFx:    obj?._fx ? JSON.parse(JSON.stringify(obj._fx)) : null
    };
}

function _applyTransforms(data, t){
    if(data.locked || !data.designOriginal) return;
    // Restore position: use canvas-fraction if available (works across
    // different-sized canvases), fall back to absolute coords.
    if(t.xFrac !== undefined && data.fabricCanvas){
        data.x = t.xFrac * data.fabricCanvas.getWidth();
        data.y = t.yFrac * data.fabricCanvas.getHeight();
    } else {
        data.x = t.x;
        data.y = t.y;
    }
    data.scale       = t.scale;
    data.scaleX      = t.scaleX;
    data.scaleY      = t.scaleY;
    data.rotation    = t.rotation;
    data.warpAmount  = t.warpAmount;
    data.arcAmount   = t.arcAmount;
    data.arcTilt     = t.arcTilt;
    data.perspectiveTop  = t.perspectiveTop;
    data.perspectiveLeft = t.perspectiveLeft;
    data.opacity     = t.opacity;
    data.blurAmount  = t.blurAmount;
    data.noiseAmount = t.noiseAmount;
    data.blendMode   = t.blendMode;
    data.skewX       = t.skewX  || 0;
    data.skewY       = t.skewY  || 0;
    data.flipX       = t.flipX;
    data.flipY       = t.flipY;
    data._flipMap    = null;
    if(data.designObject && t.designFx){
        data.designObject._fx = JSON.parse(JSON.stringify(t.designFx));
    }
    applyWarpToData(data, false);
}

document.getElementById('copyTransformsBtn').addEventListener('click', () => {
    const srcData = lastSelectedIndex ?? canvasData[activeIndices[activeIndices.length - 1]] ?? null;
    if(srcData === null) return;
    const data = srcData;
    if(!data) return;
    _copiedTransforms = _captureTransforms(data);
    // Visual feedback on the button
    const btn = document.getElementById('copyTransformsBtn');
    btn.textContent = '✓ Copied';
    setTimeout(() => { btn.textContent = 'Copy Style'; }, 1400);
    updateLayerButtons(); // enable Paste
});

document.getElementById('pasteTransformsBtn').addEventListener('click', () => {
    if(!_copiedTransforms || !activeIndices.length) return;
    pushGlobalUndo();
    activeIndices.forEach(i => _applyTransforms(canvasData[i], _copiedTransforms));
    syncSliders();
});

document.getElementById("selectAllBtn").addEventListener("click", ()=>{

    if(clipEditMode){
        showClipModeNotice();
        return;
    }

    if(activeIndices.length > 0){

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

            data.extraDesignObjects.push(cloned);
            data.extraDesignOriginals.push(null); // clone shares source with original

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
        enterDesignEraserMode();
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
    const _warpTarget = warpActiveData;
    exitDesignWarpMode(true);
    if (_warpTarget) _markProEffect(_warpTarget);
    else activeIndices.forEach(i => _markProEffect(canvasData[i]));
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
                                transparentCorners: false,
                                cornerColor: '#ff6600',
                                cornerStyle: 'circle'
                            });

                            fabricImg._isOverlay          = true;
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
        _markProEffect(data);

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
        if(!activeIndices.length) return;
        enterDesignEraserMode();
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
            _markProEffect(target);

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

        // first click locks clipping to this window
        if(activeClipWindowIndex === null){

            activeClipWindowIndex = index;

            // Load this canvas's existing clip data (e.g. from Copy Clipping)
            // into the editor globals and draw the bezier handles so it is
            // immediately editable, just like the original source window.
            const thisData = canvasData[index];
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
        if(index !== activeClipWindowIndex){

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

        // Rubber-band: live tether line from the last placed point to the
        // cursor so the user sees the next segment before clicking — same
        // feel as the Photoshop pen tool.
        if(
            !isDraggingCurveHandle &&
            !clipPolygonClosed    &&
            clipCurvePoints.length > 0 &&
            index === activeClipWindowIndex
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
                if(canvasData[i] && canvasData[i].colorLayerFabricObj) _markProEffect(canvasData[i]);
            });
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


// Render one canvas item to a full-resolution PNG blob
// ── Export: format + quality ───────────────────────────────────────────────────
var _exportFormat  = 'png';   // 'png' | 'jpeg'
var _exportQuality = 0.92;    // 0–1, only used for jpeg
var _exportOutput  = 'zip';   // 'file' | 'zip'

async function exportDataToBlob(data, fmt, quality){
    fmt     = fmt     ?? _exportFormat;
    quality = quality ?? _exportQuality;

    data.fabricCanvas.discardActiveObject();

    const hiddenOverlayObjects = [];
    data.fabricCanvas.getObjects().forEach(obj=>{
        if(obj.excludeFromExport){
            hiddenOverlayObjects.push(obj);
            obj.visible = false;
        }
    });
    data.fabricCanvas.requestRenderAll();

    const exportMultiplier = 1 / data.previewScale;
    const cropAspect = data.bgCrop?.aspect || 0;
    let cropLeft = 0, cropTop = 0, cropWidth = data.fabricCanvas.width, cropHeight = data.fabricCanvas.height;
    if(cropAspect){
        const W = data.fabricCanvas.width, H = data.fabricCanvas.height;
        if(W / H > cropAspect){
            cropWidth  = H * cropAspect;
            cropLeft   = (W - cropWidth) / 2;
        } else if(W / H < cropAspect){
            cropHeight = W / cropAspect;
            cropTop    = (H - cropHeight) / 2;
        }
    }
    const dataURL = data.fabricCanvas.toDataURL({
        format:    fmt,
        quality:   quality,
        multiplier: exportMultiplier,
        enableRetinaScaling: true,
        left:   cropLeft,
        top:    cropTop,
        width:  cropWidth,
        height: cropHeight
    });

    hiddenOverlayObjects.forEach(obj=>{ obj.visible = true; });
    data.fabricCanvas.requestRenderAll();

    return await (await fetch(dataURL)).blob();
}

// ── Export popover wiring ──────────────────────────────────────────────────────
(function(){
    const popover     = document.getElementById('exportPopover');
    const triggerBtn  = document.getElementById('exportBtn');
    const qualityRow  = document.getElementById('exportQualityRow');
    const qualSlider  = document.getElementById('exportQualitySlider');
    const qualVal     = document.getElementById('exportQualityVal');
    const goBtn       = document.getElementById('exportGoBtn');

    // Quality row starts hidden (PNG is default)
    qualityRow.hidden = true;

    // Toggle popover
    triggerBtn.addEventListener('click', e => {
        e.stopPropagation();
        popover.hidden = !popover.hidden;
    });

    // Close on outside click
    document.addEventListener('click', e => {
        if(!popover.hidden && !popover.contains(e.target) && e.target !== triggerBtn){
            popover.hidden = true;
        }
    });

    // Segmented toggles
    function wireSegToggle(id, onChange){
        const seg = document.getElementById(id);
        seg.querySelectorAll('.seg-btn').forEach(btn => {
            btn.addEventListener('click', ()=>{
                seg.querySelectorAll('.seg-btn').forEach(b => b.classList.remove('seg-active'));
                btn.classList.add('seg-active');
                onChange(btn.dataset.val);
            });
        });
    }

    wireSegToggle('exportOutputToggle', val => { _exportOutput = val; });
    wireSegToggle('exportScopeToggle', val => { /* stored via active class */ });
    wireSegToggle('exportFormatToggle', val => {
        _exportFormat = val;
        qualityRow.hidden = (val !== 'jpeg');
    });

    // Quality slider
    qualSlider.addEventListener('input', () => {
        _exportQuality = qualSlider.value / 100;
        qualVal.textContent = qualSlider.value + '%';
    });

    // Run export
    goBtn.addEventListener('click', async () => {
        if(clipEditMode){ showClipModeNotice(); return; }

        // FREE users cannot export — redirect them to upgrade
        if(_userPlan === 'free'){
            alert('Export is not available on the Free plan.\n\nUpgrade to Starter or PRO to export your mockups.');
            return;
        }

        // STARTER users cannot export windows that use PRO features
        if(_userPlan === 'starter'){
            const scopeBtn2 = document.querySelector('#exportScopeToggle .seg-active');
            const scope2    = scopeBtn2 ? scopeBtn2.dataset.val : 'selected';
            const checkIndices = scope2 === 'all'
                ? canvasData.map((_, i) => i)
                : [...activeIndices];
            const blocked = checkIndices.filter(i => canvasData[i]?.hasProEffect);
            if(blocked.length){
                const ok = confirm(
                    blocked.length + ' window(s) use PRO-only features (⭐) and will be skipped.\n\n' +
                    'Continue exporting the remaining windows?'
                );
                if(!ok) return;
                // Remove starred windows from the export scope — handled below
            }
        }

        const scopeBtn = document.querySelector('#exportScopeToggle .seg-active');
        const scope    = scopeBtn ? scopeBtn.dataset.val : 'selected';
        const ext      = _exportFormat === 'jpeg' ? 'jpg' : 'png';

        let indices;
        if(scope === 'all'){
            indices = canvasData.map((_, i) => i);
        } else {
            if(!activeIndices.length){
                alert('Select at least one window before exporting.');
                return;
            }
            indices = [...activeIndices];
        }

        // STARTER: skip PRO-starred windows (user already confirmed above)
        if(_userPlan === 'starter'){
            indices = indices.filter(i => !canvasData[i]?.hasProEffect);
            if(!indices.length){
                alert('All selected windows use PRO features. Upgrade to PRO to export them.');
                return;
            }
        }

        goBtn.textContent = 'Exporting…';
        goBtn.disabled = true;

        try {
            if(_exportOutput === 'zip'){
                // --- ZIP mode: collect all blobs → single .zip download ---
                const zip = new JSZip();
                const usedNames = {};
                for(let i = 0; i < indices.length; i++){
                    const data = canvasData[indices[i]];
                    goBtn.textContent = 'Exporting ' + (i + 1) + ' of ' + indices.length + '…';
                    const blob = await exportDataToBlob(data, _exportFormat, _exportQuality);
                    let baseName = (data.filename || ('mockup_' + (i + 1)));
                    // Deduplicate filenames within the zip
                    let fileName = baseName + '.' + ext;
                    if(usedNames[fileName]){
                        usedNames[fileName]++;
                        fileName = baseName + '_' + usedNames[fileName] + '.' + ext;
                    } else {
                        usedNames[fileName] = 1;
                    }
                    zip.file(fileName, blob);
                }
                goBtn.textContent = 'Zipping…';
                const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
                const url = URL.createObjectURL(zipBlob);
                const a   = document.createElement('a');
                a.href     = url;
                a.download = 'mockups.zip';
                a.click();
                await new Promise(r => setTimeout(r, 200));
                URL.revokeObjectURL(url);
            } else {
                // --- File mode ---
                // Path A: File System Access API (Chrome/Edge) — save to folder
                if(typeof window.showDirectoryPicker === 'function'){
                    let dirHandle;
                    try{ dirHandle = await window.showDirectoryPicker(); }
                    catch(err){ return; }  // user cancelled — finally re-enables button

                    for(let i = 0; i < indices.length; i++){
                        const data = canvasData[indices[i]];
                        goBtn.textContent = 'Exporting ' + (i + 1) + ' of ' + indices.length + '…';
                        const blob = await exportDataToBlob(data, _exportFormat, _exportQuality);
                        const fh   = await dirHandle.getFileHandle((data.filename || ('mockup_' + (i + 1))) + '.' + ext, { create: true });
                        const wr   = await fh.createWritable();
                        await wr.write(blob);
                        await wr.close();
                    }
                    alert('Exported ' + indices.length + ' file(s)!');
                } else {
                    // Path B: fallback <a download> — one download per file
                    for(let i = 0; i < indices.length; i++){
                        const data = canvasData[indices[i]];
                        goBtn.textContent = 'Exporting ' + (i + 1) + ' of ' + indices.length + '…';
                        const blob = await exportDataToBlob(data, _exportFormat, _exportQuality);
                        const url  = URL.createObjectURL(blob);
                        const a    = document.createElement('a');
                        a.href     = url;
                        a.download = (data.filename || ('mockup_' + (i + 1))) + '.' + ext;
                        a.click();
                        await new Promise(r => setTimeout(r, 150));
                        URL.revokeObjectURL(url);
                    }
                }
            }
        } catch(err) {
            console.error('Export failed:', err);
            alert('Export failed — ' + (err.message || 'unknown error'));
        } finally {
            goBtn.textContent = 'Export';
            goBtn.disabled = false;
        }
    });
})();

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
        });
    }
    var link = document.getElementById('upgradePromptLink');
    if(link){
        link.addEventListener('click', e => {
            e.preventDefault();
            alert('Pricing plans coming soon!\n\nStarter: $19/mo — export unlimited mockups\nPRO: $39/mo — everything in Starter + all PRO features');
        });
    }
})();



document.getElementById("resetBtnTop").addEventListener("click", () =>
    document.getElementById("resetBtn").click());

document.getElementById("resetBtn").addEventListener("click", ()=>{

    if(!activeIndices.length) return;

    pushGlobalUndo();

    activeIndices.forEach(index=>{

        const data = canvasData[index];
        if(data.locked) return;

        // ── Remove extra/duplicate layers ─────────────────────────────────────
        if(data.extraDesignObjects){
            data.extraDesignObjects.forEach(obj=>{
                selectedDesigns.delete(obj); // remove from selection too
                data.fabricCanvas.remove(obj);
            });
            data.extraDesignObjects   = [];
            data.extraDesignOriginals = [];
        }

        // ── Restore original position/state ───────────────────────────────────
        data.x    = data.initialX;
        data.y    = data.initialY;
        data.scale  = data.initialScale;
        data.scaleX = null;
        data.scaleY = null;
        data.rotation     = data.initialRotation;
        data.warpAmount   = data.initialWarpAmount;
        data.arcAmount    = data.initialArcAmount;
        data.arcTilt      = data.initialArcTilt     ?? 0;
        data.opacity      = data.initialOpacity;
        data.blurAmount   = data.initialBlurAmount;
        data.noiseAmount  = data.initialNoiseAmount ?? 0;
        data.blendMode    = data.initialBlendMode   ?? "normal";
        data.perspectiveTop  = data.initialPerspectiveTop  ?? 0;
        data.perspectiveLeft = data.initialPerspectiveLeft ?? 0;
        data.flipX = false;
        data.flipY = false;
        data._flipMap = null;
        data.skewX = 0;
        data.skewY = 0;

        // ── Reset _fx on the main design object ──────────────────────────────
        // syncSliders() reads from _fx when selectedDesigns is non-empty, so _fx
        // must be updated here — otherwise sliders show stale values after reset.
        if(data.designObject){
            data.designObject._fx = {
                warpAmount:      data.warpAmount,
                arcAmount:       data.arcAmount,
                arcTilt:         data.arcTilt,
                perspectiveTop:  data.perspectiveTop,
                perspectiveLeft: data.perspectiveLeft,
                opacity:         data.opacity,
                blurAmount:      data.blurAmount,
                noiseAmount:     data.noiseAmount,
                blendMode:       data.blendMode
            };

            // Invalidate the LQ pipeline cache so the next render runs clean.
            data.designObject._c_src     = null;
            data.designObject._c_blurred = null;
            data.designObject._c_noisy   = null;
            data.designObject._c_warpOk  = false;
            data.designObject._c_trimmed = null;
            data.designObject._c_persp   = null;
        }

        // ── Restore fabric object to initial transform ────────────────────────
        if(data.designObject){
            applyClipMaskToObject(data.designObject, data);
            data.designObject.set({
                left:   data.initialX,
                top:    data.initialY,
                angle:  data.initialRotation,
                scaleX: data.initialScale * data.previewScale,
                scaleY: data.initialScale * data.previewScale,
                skewX:  0,
                skewY:  0,
                opacity: data.initialOpacity,
                globalCompositeOperation: 'source-over'
            });
        }

        // ── Restore designOriginal (undoes eraser baking / invert) ────────────
        if(data.initialDesignOriginal){
            data.designOriginal = data.initialDesignOriginal;
        }

        applyWarpToData(data);

        // ── Clear clipping ────────────────────────────────────────────────────
        data.maskEnabled        = false;
        data.maskType           = null;
        data.maskPath           = null;
        data.maskPaths          = [];
        data.clipCurvePoints    = [];
        data.clipPolygonClosed  = false;

        getAllDesignObjects(data).forEach(obj=>{
            applyClipMaskToObject(obj, data);
        });
        addClipOverlay(data);

        // ── Clear color layer ─────────────────────────────────────────────────
        if(data.colorLayerFabricObj){
            data.fabricCanvas.remove(data.colorLayerFabricObj);
            data.colorLayerFabricObj = null;
        }
        if(data.colorLayerCtx){
            data.colorLayerCtx.clearRect(
                0, 0,
                data.colorLayerCanvas.width,
                data.colorLayerCanvas.height
            );
        }
        data.colorLayerCanvas  = null;
        data.colorLayerCtx     = null;
        data.colorLayerHistory = [];

        // ── Reset pattern ─────────────────────────────────────────────────────
        if(data.patternMode || data.patternFabricObj) _togglePatternMode(data, false);
        data.patternMode = false;
        data.patternSettings = _defaultPattern();

        // ── Reset background adjustments ──────────────────────────────────────
        data.bgAdjust = { hue: 0, saturation: 0, brightness: 0, contrast: 0 };

        // ── Reset framing (bgCrop) ────────────────────────────────────────────
        data.bgCrop = { x: 0, y: 0, scale: 1, rotation: 0, aspect: 0 };
        _applyBgAdjust(data);
        _updateCropOverlay(data);

        // ── Clear PRO star (all effects were reset above) ────────────────────────
        data.hasProEffect = false;
        _updateProStarBadge(data);

        data.fabricCanvas.discardActiveObject();
        data.fabricCanvas.requestRenderAll();
    });

    // ── Sync bgAdjust UI ──────────────────────────────────────────────────────
    bgHue.valueAsNumber        = 0;
    bgSaturation.valueAsNumber = 0;
    bgBrightness.valueAsNumber = 0;
    bgContrast.valueAsNumber   = 0;
    document.getElementById('bgHueVal')        && (document.getElementById('bgHueVal').textContent        = '0');
    document.getElementById('bgSaturationVal') && (document.getElementById('bgSaturationVal').textContent = '0');
    document.getElementById('bgBrightnessVal') && (document.getElementById('bgBrightnessVal').textContent = '0');
    document.getElementById('bgContrastVal')   && (document.getElementById('bgContrastVal').textContent   = '0');

    // ── Sync framing UI ───────────────────────────────────────────────────────
    bgCropRotation.valueAsNumber = 0;
    bgCropScale.valueAsNumber    = 100;
    bgCropX.valueAsNumber        = 0;
    bgCropY.valueAsNumber        = 0;
    document.getElementById('bgCropRotationVal').textContent = '0';
    document.getElementById('bgCropScaleVal').textContent    = '100';
    document.getElementById('bgCropXVal').textContent        = '0';
    document.getElementById('bgCropYVal').textContent        = '0';
    document.getElementById('bgCropCustomW').value = '';
    document.getElementById('bgCropCustomH').value = '';
    document.querySelectorAll('.bg-aspect-btn').forEach(b => b.classList.remove('active'));

    // ── Sync pattern UI ───────────────────────────────────────────────────────
    document.getElementById('patternModeToggle').checked = false;
    document.getElementById('patternControls').style.display = 'none';
    document.querySelectorAll('.pattern-type-btn').forEach(b => b.classList.toggle('active', b.dataset.type === 'grid'));
    _patternSliderDefs.forEach(([id]) => {
        document.getElementById(id).valueAsNumber = 0;
        document.getElementById(id + 'Val').value = 0;
    });

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
            x: mainObj
                ? (mainObj.left  / data.previewScale)
                : (data.x        / (data.previewScale || 1)),
            y: mainObj
                ? (mainObj.top   / data.previewScale)
                : (data.y        / (data.previewScale || 1)),

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
                name: data.extraDesignOriginals?.[i]
                    ? (obj._uploadedDesignName || null)
                    : null,

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

// ── Unsaved changes indicator ─────────────────────────────────────────────────
var _unsaved = false;

function _markDirty(){
    if(_unsaved) return;
    _unsaved = true;
    document.getElementById('saveProgressBtn')?.classList.add('has-unsaved');
    if(!document.title.startsWith('• ')) document.title = '• ' + document.title;
}

function _markClean(){
    _unsaved = false;
    document.getElementById('saveProgressBtn')?.classList.remove('has-unsaved');
    document.title = document.title.replace(/^• /, '');
}

function autoSaveSession(){

    if(!canvasData.length && !_textBoxes.length) return;

    clearTimeout(_autoSaveTimer);

    _autoSaveTimer = setTimeout(()=>{

        try {
            localStorage.setItem(
                'mockup_autosave',
                JSON.stringify(buildFullSnapshot())
            );
        } catch(e){
            // quota exceeded or private browsing — silently skip
        }

    }, 2500);
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

document.getElementById("saveProgressBtn").addEventListener("click", ()=>{

    const snapshot = buildFullSnapshot();

    const blob = new Blob(
        [JSON.stringify(snapshot, null, 2)],
        {type:'application/json'}
    );

    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = 'mockup_progress.json';
    a.click();

    URL.revokeObjectURL(url);
    _markClean();
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

            extraDesignObjects: [],

            initialX: saved.x,
            initialY: saved.y,

            initialScale: saved.scale,
            initialRotation: saved.rotation,
            initialWarpAmount: saved.warpAmount,
            initialArcAmount: saved.arcAmount,
            initialOpacity: saved.opacity ?? 1,
            initialBlurAmount: saved.blurAmount ?? 0,
            initialNoiseAmount: saved.noiseAmount ?? 0,
            initialBlendMode: saved.blendMode ?? "normal"
        };

        canvasData.push(data);

        const wrapper = document.createElement("div");
        wrapper.className = "canvas-wrapper";
        data.wrapperEl = wrapper;
        _updateProStarBadge(data);

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
        _addDragHandle(wrapper);

        container.appendChild(wrapper);
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

        // initialX/Y used by Reset — must also be in preview-canvas pixels.
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

        // Shrink Fabric's .canvas-container to the CSS display size so it doesn't
        // overflow the grid cell. Canvas DOM pixel count stays at previewW × DPR,
        // so the browser downscales those extra pixels — crisp at zoom.
        const displayW = Math.round(targetColumnWidth);
        const displayH = Math.round(previewH * targetColumnWidth / previewW);
        fabricCanvas.wrapperEl.style.width  = displayW + "px";
        fabricCanvas.wrapperEl.style.height = displayH + "px";
        wrapper.style.width = displayW + "px";

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

                if(dup.src){

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
                                transparentCorners: false,
                                cornerColor: 'blue',
                                cornerStyle: 'circle'
                            });

                            fabricImg._uploadedDesignName = dup.name || '';
                            fabricImg._fx = dup.fx || _defaultFx(data);

                            data.extraDesignOriginals = data.extraDesignOriginals || [];
                            data.extraDesignOriginals.push(img);

                            data.extraDesignObjects.push(fabricImg);

                            fabricCanvas.add(fabricImg);
                            attachFabricEvents(data, fabricImg);
                            applyClipMaskToObject(fabricImg, data);

                            resolve();
                        };

                        img.src = dup.src;
                    });

                } else {

                    // Restore a cloned design — same source as main design.
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

                            data.extraDesignOriginals = data.extraDesignOriginals || [];
                            data.extraDesignOriginals.push(null);

                            data.extraDesignObjects.push(cloned);

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

        wrapper.addEventListener('click', function(e){

            if(suppressNextWrapperClick){
                return;
            }

            if(clipEditMode && !clipCopySelectMode){
                return;
            }

            if(colorLayerMode && !colorCopySelectMode){
                if(!activeIndices.includes(index)){
                    alert("Exit Color Layer mode to interact with other windows.");
                }
                return;
            }

            // In color copy-select mode: simple toggle so the user can pick targets
            if(colorCopySelectMode){
                const pos = activeIndices.indexOf(index);
                if(pos === -1) activeIndices.push(index);
                else           activeIndices.splice(pos, 1);
                updateWindowBorders();
                return;
            }

                const isModifierMultiSelect = e.metaKey || e.ctrlKey;

                // SHIFT = range select — adds windows AND their original designs
                if(e.shiftKey){

                    const prevIndices = [...activeIndices];

                    if(lastSelectedIndex === null){

                        activeIndices = [index];

                    } else {

                        const lastAnchorIdx = canvasData.indexOf(lastSelectedIndex);
                        const start = Math.min(lastAnchorIdx, index);
                        const end = Math.max(lastAnchorIdx, index);

                        const range = [];

                        for(let i = start; i <= end; i++){
                            range.push(i);
                        }

                        activeIndices = [...new Set([
                            ...activeIndices,
                            ...range
                        ])];
                    }

                    // Add original designs of newly-included windows (skip locked)
                    activeIndices.forEach(i => {
                        const d = canvasData[i];
                        if(d?.designObject && !d.locked && !selectedDesigns.has(d.designObject)){
                            if(!d.designObject._fx) d.designObject._fx = _defaultFx(d);
                            selectedDesigns.add(d.designObject);
                        }
                    });
                    // Remove designs belonging to windows no longer in activeIndices
                    prevIndices.filter(i => !activeIndices.includes(i)).forEach(i => {
                        const d = canvasData[i];
                        if(d){
                            selectedDesigns.delete(d.designObject);
                            (d.extraDesignObjects||[]).forEach(obj => selectedDesigns.delete(obj));
                        }
                    });

                    lastSelectedIndex = canvasData[index];

                // CMD / CTRL = toggle window + its original design
                } else if(isModifierMultiSelect){

                    if(activeIndices.includes(index)){

                        activeIndices = activeIndices.filter(i => i !== index);

                        const d = canvasData[index];
                        if(d){
                            selectedDesigns.delete(d.designObject);
                            (d.extraDesignObjects||[]).forEach(obj => selectedDesigns.delete(obj));
                        }

                    } else {

                        activeIndices.push(index);

                        const d = canvasData[index];
                        if(d?.designObject && !d.locked){
                            if(!d.designObject._fx) d.designObject._fx = _defaultFx(d);
                            selectedDesigns.add(d.designObject);
                        }
                    }

                    lastSelectedIndex = canvasData[index];

                // Normal click = if window already selected keep group; else single-select
                } else {

                    lastSelectedIndex = canvasData[index];

                    if(!activeIndices.includes(index)){
                        // Clicking an unselected window — start fresh
                        activeIndices = [index];
                        selectedDesigns.clear();
                        const d = canvasData[index];
                        if(d?.designObject && !d.locked){
                            if(!d.designObject._fx) d.designObject._fx = _defaultFx(d);
                            selectedDesigns.add(d.designObject);
                        }
                    } else {
                        // Window already in selection — keep everything, just ensure
                        // its design is represented in selectedDesigns (skip locked)
                        const d = canvasData[index];
                        if(d?.designObject && !d.locked && !selectedDesigns.has(d.designObject)){
                            if(!d.designObject._fx) d.designObject._fx = _defaultFx(d);
                            selectedDesigns.add(d.designObject);
                        }
                    }
                }

                if(e.shiftKey){
                    lastSelectedIndex = canvasData[index];
                }

                refreshFabricHandles();
                updateWindowBorders();
                updateLayerButtons();
                syncSliders();
                updateSelectButtonState();
            });
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

    loadingIndicator.innerText =
        "Session restored";

    setTimeout(()=>{
        loadingIndicator.style.display = "none";
    },800);
}


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

    localStorage.removeItem('mockup_autosave');

    // Reset all state
    canvasData = [];
    backgrounds = [];
    designs = [];
    activeIndices = [];
    lastSelectedIndex = null;

    document.getElementById("canvasContainer").innerHTML = "";
    document.getElementById("loadingIndicator").style.display = "none";

    // Clear file input labels so "4 files" / "3 files" badges disappear
    document.getElementById("bgUpload").value = "";
    document.getElementById("designUpload").value = "";

    updateSelectButtonState();
    syncSliders();
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

    // Window cells
    const activeSet = new Set(activeIndices);
    canvasData.forEach((data, i) => {
        const el = data?.wrapperEl;
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
        const v = Math.max(0, Math.min(120, parseInt(rowInput.value, 10) || 0));
        rowInput.value = v;
        if (v === _rowGap) return;
        pushLayoutUndo();
        _rowGap = v;
        applyGaps();
    });

    colInput.addEventListener('change', () => {
        const v = Math.max(0, Math.min(120, parseInt(colInput.value, 10) || 0));
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


// ── Export canvas text ────────────────────────────────────────────────────────
document.getElementById('exportTextBtn').addEventListener('click', () => {
    if(_userPlan === 'free'){
        alert('Exporting is not available on the Free plan.\n\nUpgrade to Starter or PRO to export your work.');
        return;
    }
    const sorted = [..._textBoxes]
        .filter(b => b.textEl ? b.textEl.innerText.trim() : b.content.trim())
        .sort((a, b) => a.y !== b.y ? a.y - b.y : a.x - b.x);
    if (!sorted.length) {
        alert('No text on the canvas to export yet.');
        return;
    }
    const text = sorted.map(b => (b.textEl ? b.textEl.innerText : b.content).trim()).join('\n\n') + '\n';
    const blob = new Blob([text], { type: 'text/plain' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = 'canvas-text.txt';
    a.click();
    URL.revokeObjectURL(url);
});


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

    const raw = localStorage.getItem('mockup_autosave');

    if(!raw) return;

    let snapshot;

    try {
        snapshot = JSON.parse(raw);
    } catch(e){
        localStorage.removeItem('mockup_autosave');
        return;
    }

    const isLegacy = Array.isArray(snapshot);
    const windows  = isLegacy ? snapshot : (snapshot.windows  || []);
    const tboxes   = isLegacy ? []       : (snapshot.textBoxes || []);

    if (!windows.length && !tboxes.length) return;

    _applyLayoutFromSnapshot(isLegacy ? null : snapshot.layout);
    if (windows.length) await createCanvasPreviewsFromSnapshot(windows);
    if (window._restoreTextBoxes) window._restoreTextBoxes(tboxes);
    _applyViewportFromSnapshot(isLegacy ? null : snapshot.viewport);
    _applyUndoHistoryFromSnapshot(isLegacy ? null : snapshot.undoHistory);

    syncSliders();
    updateWindowBorders();
});


// ── Drag-to-reorder windows ───────────────────────────────────────────────────
(()=>{
    const container = document.getElementById('canvasContainer');
    let _dragSrcWrapper = null;
    let _dropTarget     = null;
    let _dropBefore     = true;
    let _pendingFromHandle = false;

    // Blue insertion-bar indicator (fixed-position overlay, avoids grid/overflow issues)
    const ind = document.createElement('div');
    ind.style.cssText = 'position:fixed;width:3px;border-radius:2px;background:#1e5eff;pointer-events:none;z-index:9999;display:none;';
    document.body.appendChild(ind);

    // Track whether the drag was initiated from a drag handle
    document.addEventListener('mousedown', e => {
        _pendingFromHandle = e.target.classList.contains('drag-handle');
    });

    container.addEventListener('dragstart', e => {
        if(!_pendingFromHandle){ e.preventDefault(); return; }
        if(clipEditMode || colorLayerMode){ e.preventDefault(); return; }
        const wrapper = e.target.closest('.canvas-wrapper');
        if(!wrapper){ e.preventDefault(); return; }
        const srcData = canvasData.find(d => d.wrapperEl === wrapper);
        if(srcData?.locked){ e.preventDefault(); return; }
        _dragSrcWrapper = wrapper;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', ''); // required for Firefox
        // Delay opacity so the ghost image still renders at full opacity
        requestAnimationFrame(() => wrapper.classList.add('drag-source'));
    });

    container.addEventListener('dragover', e => {
        if(!_dragSrcWrapper) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const wrapper = e.target.closest('.canvas-wrapper');
        if(!wrapper || wrapper === _dragSrcWrapper){ ind.style.display = 'none'; _dropTarget = null; return; }
        const rect = wrapper.getBoundingClientRect();
        _dropBefore = e.clientX < rect.left + rect.width / 2;
        _dropTarget = wrapper;
        // Position the blue bar in the gap between cells
        const x = _dropBefore ? rect.left - 1 : rect.right - 2;
        ind.style.left   = x + 'px';
        ind.style.top    = rect.top + 'px';
        ind.style.height = rect.height + 'px';
        ind.style.display = 'block';
    });

    container.addEventListener('dragleave', e => {
        if(!container.contains(e.relatedTarget)){
            ind.style.display = 'none';
            _dropTarget = null;
        }
    });

    container.addEventListener('dragend', () => {
        if(_dragSrcWrapper) _dragSrcWrapper.classList.remove('drag-source');
        _dragSrcWrapper = null;
        _dropTarget     = null;
        ind.style.display = 'none';
        _pendingFromHandle = false;
    });

    container.addEventListener('drop', e => {
        e.preventDefault();
        ind.style.display = 'none';

        if(!_dragSrcWrapper || !_dropTarget || _dragSrcWrapper === _dropTarget){
            if(_dragSrcWrapper) _dragSrcWrapper.classList.remove('drag-source');
            _dragSrcWrapper = null; _dropTarget = null;
            return;
        }

        // ── 0. Push undo for the reorder ─────────────────────────────────────
        globalUndoStack.push({ type: 'reorder', order: [...canvasData] });
        if(globalUndoStack.length > MAX_UNDO_HISTORY) globalUndoStack.shift();
        globalRedoStack = [];
        updateUndoRedoButtons();
        _markDirty();

        // ── 1. Reorder DOM ────────────────────────────────────────────────────
        _dragSrcWrapper.classList.remove('drag-source');
        if(_dropBefore) _dropTarget.before(_dragSrcWrapper);
        else            _dropTarget.after(_dragSrcWrapper);

        // ── 2. Rebuild canvasData to match DOM order (all state lives on data
        //       objects so nothing is lost — just the index changes) ────────────
        const oldCanvasData   = [...canvasData];
        const selectedDatas   = activeIndices.map(i => oldCanvasData[i]);

        const wrappers = [...container.querySelectorAll('.canvas-wrapper')];
        canvasData = wrappers.map(w => oldCanvasData.find(d => d.wrapperEl === w));

        // ── 3. Remap active indices to new positions ───────────────────────────
        activeIndices     = selectedDatas.map(d => canvasData.indexOf(d)).filter(i => i !== -1);
        // lastSelectedIndex is a data-object reference — remains valid after reorder;
        // only clear it if the object is no longer present in canvasData.
        if(lastSelectedIndex !== null && !canvasData.includes(lastSelectedIndex)){
            lastSelectedIndex = null;
        }

        _dragSrcWrapper = null;
        _dropTarget     = null;

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

// ── Sidebar collapse toggle ───────────────────────────────────────────────────
(function(){
    const toggleBtn = document.getElementById('sidebarToggleBtn');
    if (!toggleBtn) return;

    function setSidebarExpanded(expanded) {
        document.body.classList.toggle('sidebar-expanded', expanded);
        toggleBtn.textContent = expanded ? '◀' : '▶';
        toggleBtn.title = expanded ? 'Collapse panel' : 'Open panel';
    }

    // Start collapsed (no sidebar-expanded class on body)
    setSidebarExpanded(false);

    toggleBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        setSidebarExpanded(!document.body.classList.contains('sidebar-expanded'));
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
