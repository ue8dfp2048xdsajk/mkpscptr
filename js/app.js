let backgrounds = [];
let designs = [];
let canvasData = [];
let activeIndices = [];
let _numColumns = 4;
let _rowGap = 20;
let _colGap = 20;

// ── Visibility cache (IntersectionObserver) ───────────────────────────────────
// Tracks which canvas wrapper divs are currently scrolled into the viewport
// (+ 300 px buffer). Replaces per-frame getBoundingClientRect() calls with an
// O(1) Set.has() lookup so iterating hundreds of windows costs nothing.
const _visibleWrappers = new Set();
const _visibilityObserver = new IntersectionObserver(entries => {
    entries.forEach(e => {
        if(e.isIntersecting) _visibleWrappers.add(e.target);
        else                 _visibleWrappers.delete(e.target);
    });
}, { rootMargin: '300px 0px' });
let clipCopySelectMode = false;   // true while user is picking copy targets
let clipCopySourceIndex = null;   // which window the clipping will be copied FROM
let colorCopySelectMode  = false; // true while user is picking color-copy targets
let colorCopySourceIndex = null;  // which window the color layer will be copied FROM

// ── Color layer state ────────────────────────────────────────────────────────
// ── Global undo / redo ───────────────────────────────────────────────────────
let globalUndoStack = [];
let globalRedoStack = [];
const MAX_UNDO_HISTORY = 50;
let _sliderUndoLocked = false;   // one push per slider drag gesture

let designEraserMode     = false;  // true while design-layer eraser is active
let designEraserDown     = false;  // true while mouse button held in eraser mode
let designEraserSize     = 30;     // eraser radius in CSS pixels (visual size on screen)
let designEraserSoftness = 60;     // 0 = hard edge, 100 = fully soft
let eraserTargetObjects  = new Set(); // design objects selected at eraser-entry time

let designWarpMode   = false;      // true while free-form mesh warp is active
let warpActiveData   = null;       // canvasData entry that owns the warp session
let warpTargetObjs   = [];         // fabric objects being warped
let warpPoints       = [];         // 4×4 array of {x,y} in Fabric canvas coordinates
let warpSourceCanvas = null;       // rasterised source image for the warp target(s)
let warpSourceBounds = null;       // {left,top,width,height} of source in Fabric coords
let warpDragRC       = null;       // {r,c} of control point being dragged, or null
let warpDPR          = 1;          // device pixel ratio at capture time
let warpAllGroups    = [];         // [{ownerData, targets, sourceCanvas, sourceBounds, dpr}] for every canvas involved

let colorLayerMode  = false;
let brushTool       = 'brush'; // 'brush' | 'eraser'
let brushColor      = '#ff0000';
let brushSize       = 20;
let brushSoftness   = 30;
let colorLayerOpacity    = 1;
let colorLayerBlendMode  = 'source-over';
let isColorPainting = false;
let lastPaintNorm   = null;   // last painted point in bg-image-pixel space
let selectedDesigns = new Set();  // design objects directly clicked (main or extra, any window)
let lastSelectedIndex = null;

let clipEditMode = false;
let clipCurvePoints = [];
let activeCurvePreview = null;
let currentCurveHandle = null;
let isDraggingCurveHandle = false;

let activeBezierHelpers = [];

let clipPolygonClosed = false;
let currentMaskIndex = 0;

let activeClipWindowIndex = null;

let suppressNextWrapperClick = false;

// stores clipping masks per background type
let backgroundMaskTemplates = {};

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

    if(
        insideSelectedWindow ||
        insideAnyWindow ||
        exitButton ||
        deleteClipButton ||
        addClipAreaButton ||
        copyClipButton
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
let _mouseDownOnControl = false;
document.addEventListener('mousedown', e => {
    const tag = e.target.tagName;
    _mouseDownOnControl = (tag === 'INPUT' || tag === 'SELECT' ||
                           tag === 'TEXTAREA' || tag === 'BUTTON');
});

// Clicking empty space in the canvas container deselects everything
document.getElementById('canvasContainer').addEventListener('click', function(e){
    if(suppressNextWrapperClick) return;
    if(_mouseDownOnControl) return;   // drag started on a control — ignore
    if(clipEditMode || colorLayerMode) return;
    // Only act when the click landed outside every canvas-wrapper
    if(e.target.closest('.canvas-wrapper')) return;
    _deselectAll();
});

// Clicking the white surrounding area (outside #canvasContainer) also deselects
document.addEventListener('click', function(e){
    if(suppressNextWrapperClick) return;
    if(_mouseDownOnControl) return;   // drag started on a control — ignore
    if(clipEditMode || colorLayerMode) return;
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



const warpAmount = document.getElementById("warpAmount");
const arcAmount = document.getElementById("arcAmount");
const arcTilt = document.getElementById("arcTilt");
const perspectiveTop = document.getElementById("perspectiveTop");
const perspectiveLeft = document.getElementById("perspectiveLeft");
const opacityAmount = document.getElementById("opacityAmount");
const blurAmount = document.getElementById("blurAmount");
const noiseAmount = document.getElementById("noiseAmount");
const blendMode = document.getElementById("blendMode");
const bgHue        = document.getElementById('bgHue');
const bgSaturation = document.getElementById('bgSaturation');
const bgBrightness = document.getElementById('bgBrightness');
const bgContrast   = document.getElementById('bgContrast');


// performance throttling
let warpFramePending = false;
let pendingWarpUpdate = false;
let globalHQTimer = null;
let activeSliderType = null;

// marching ants animation
let _marchingAntsTimer  = null;
let _marchingAntsOffset = 0;


function trimTransparentPixels(img){

    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');

    c.width = img.width;
    c.height = img.height;

    ctx.drawImage(img, 0, 0);

    const data = ctx.getImageData(0,0,c.width,c.height).data;

    let top = c.height;
    let left = c.width;
    let right = 0;
    let bottom = 0;

    for(let y=0; y<c.height; y++){
        for(let x=0; x<c.width; x++){

            const alpha = data[(y * c.width + x) * 4 + 3];

            if(alpha > 0){

                if(x < left) left = x;
                if(x > right) right = x;
                if(y < top) top = y;
                if(y > bottom) bottom = y;
            }
        }
    }

    // fallback if fully transparent
    if(right <= left || bottom <= top){
        return img;
    }

    const trimmed = document.createElement('canvas');
    const tctx = trimmed.getContext('2d');

    const w = right - left + 1;
    const h = bottom - top + 1;

    trimmed.width = w;
    trimmed.height = h;

    tctx.drawImage(
        c,
        left, top, w, h,
        0, 0, w, h
    );

    const out = new Image();
    out.src = trimmed.toDataURL();

    return out;
}





function _blendToGCO(mode){
    return (mode && mode !== 'normal') ? mode : 'source-over';
}

function _applyBgAdjust(data){
    const obj = data.backgroundObject;
    if(!obj) return;

    const a = data.bgAdjust || {};
    const c = data.bgCrop   || {};

    const hue = a.hue        || 0;
    const sat = (a.saturation || 0) + 100;
    const bri = (a.brightness || 0) + 100;
    const con = (a.contrast   || 0) + 100;

    const cropScale  = c.scale    || 1;
    const cropX      = c.x        || 0;
    const cropY      = c.y        || 0;
    const cropRot    = c.rotation || 0;
    const cropAspect = c.aspect   || 0;

    const colorNeutral = hue === 0 && sat === 100 && bri === 100 && con === 100;
    const cropNeutral  = cropScale === 1 && cropX === 0 && cropY === 0 && cropRot === 0 && !cropAspect;
    const src = data.bg;

    if(colorNeutral && cropNeutral){
        obj.setElement(src);
        obj.filters = [];
        obj.applyFilters();
        data.fabricCanvas.requestRenderAll();
        return;
    }

    const imgW = src.naturalWidth  || src.width;
    const imgH = src.naturalHeight || src.height;

    const off = document.createElement('canvas');
    off.width  = imgW;
    off.height = imgH;
    const ctx  = off.getContext('2d');

    const totalScale = cropScale;
    const panX = cropX * imgW;
    const panY = cropY * imgH;

    if(!colorNeutral){
        ctx.filter = `hue-rotate(${hue}deg) saturate(${sat}%) brightness(${bri}%) contrast(${con}%)`;
    }

    ctx.save();
    ctx.translate(imgW / 2 + panX, imgH / 2 + panY);
    ctx.rotate(cropRot * Math.PI / 180);
    ctx.scale(totalScale, totalScale);
    ctx.drawImage(src, -imgW / 2, -imgH / 2, imgW, imgH);
    ctx.restore();

    obj.setElement(off);
    obj.filters = [];
    obj.applyFilters();
    data.fabricCanvas.requestRenderAll();
}

function _updateCropOverlay(data){
    if(data.cropOverlayRects && data.cropOverlayRects.length){
        data.cropOverlayRects.forEach(r => data.fabricCanvas.remove(r));
    }
    data.cropOverlayRects = [];

    const aspect = data.bgCrop?.aspect || 0;
    if(!aspect){
        data.fabricCanvas.requestRenderAll();
        return;
    }

    const W = data.fabricCanvas.width;
    const H = data.fabricCanvas.height;
    let cropX = 0, cropY = 0, cropW = W, cropH = H;
    const canvasAR = W / H;
    if(canvasAR > aspect){
        cropW = H * aspect;
        cropX = (W - cropW) / 2;
    } else if(canvasAR < aspect){
        cropH = W / aspect;
        cropY = (H - cropH) / 2;
    }

    const FILL = 'rgba(0,0,0,0.45)';
    const base = { selectable:false, evented:false, excludeFromExport:true, originX:'left', originY:'top' };
    const rects = [];
    if(cropY > 0.5){
        rects.push(new fabric.Rect({ ...base, left:0, top:0,           width:W, height:cropY,         fill:FILL }));
        rects.push(new fabric.Rect({ ...base, left:0, top:cropY+cropH, width:W, height:cropY,         fill:FILL }));
    }
    if(cropX > 0.5){
        rects.push(new fabric.Rect({ ...base, left:0,         top:0, width:cropX, height:H, fill:FILL }));
        rects.push(new fabric.Rect({ ...base, left:cropX+cropW, top:0, width:cropX, height:H, fill:FILL }));
    }

    rects.forEach(r => data.fabricCanvas.add(r));
    data.cropOverlayRects = rects;

    if(data.backgroundObject) data.fabricCanvas.sendToBack(data.backgroundObject);
    // Keep pattern overlay just above background when both exist
    if(data.patternFabricObj){
        data.fabricCanvas.sendToBack(data.patternFabricObj);
        data.fabricCanvas.sendToBack(data.backgroundObject);
    }
    data.fabricCanvas.requestRenderAll();
}

// ── Pattern Creator ────────────────────────────────────────────────────────────
function _defaultPattern(){
    return { type:'grid', hSpacing:0, vSpacing:0, angle:0, hOffset:0, rotH:0, rotV:0 };
}

function _renderPattern(data, lowQuality = false){
    if(!data.patternMode || !data.patternFabricObj || !data.designObject) return;
    const fc = data.fabricCanvas;
    const W = fc.width, H = fc.height;
    const obj = data.designObject;
    const s = data.patternSettings || _defaultPattern();

    // Use pre-warp tile source if stored by applyWarpToData — warp is applied
    // to the whole tiled canvas below, so individual tiles must be undistorted.
    const tileEl = data._patternTileSource || obj.getElement();
    if(!tileEl) return;
    const srcW = tileEl.width  || tileEl.naturalWidth  || obj.width;
    const srcH = tileEl.height || tileEl.naturalHeight || obj.height;
    if(srcW < 1 || srcH < 1) return;

    // The master tile is invisible — the pattern canvas renders all tiles
    // including its position, so it shows through the evented-false overlay.
    obj.set({opacity: 0});

    const tileW  = srcW * Math.abs(obj.scaleX);
    const tileH  = srcH * Math.abs(obj.scaleY);
    const stepX  = Math.max(1, tileW * (1 + (s.hSpacing || 0) / 100));
    const stepY  = Math.max(1, tileH * (1 + (s.vSpacing || 0) / 100));
    const aRad   = (s.angle || 0) * Math.PI / 180;
    const cosA   = Math.cos(aRad), sinA = Math.sin(aRad);
    const hOffPx = stepX * ((s.hOffset || 0) / 100);
    const mc     = obj.getCenterPoint();
    const mAngle = obj.angle || 0;

    // ── Pre-compute warp / perspective so we know if extra margin is needed ──
    const hasWarp = (data.warpAmount || 0) !== 0 || (data.arcAmount || 0) !== 0;
    const hasPerspective = (data.perspectiveTop || 0) !== 0 || (data.perspectiveLeft || 0) !== 0;

    // When warp or perspective is active, tile a canvas larger than W×H so
    // that after distortion the edges are still filled (no white gaps).
    // The extra pad must cover the maximum pixel displacement introduced by each effect.
    const arcExtraPad   = Math.abs(data.arcAmount || 0) * 5
                        + Math.abs(data.arcTilt  ?? 0) / 100 * H * 0.25;
    const perspExtraPad = Math.abs(data.perspectiveTop  || 0) * W / 160
                        + Math.abs(data.perspectiveLeft || 0) * H / 160;
    const extraPad = (hasWarp || hasPerspective)
        ? Math.ceil(arcExtraPad + perspExtraPad) + 20
        : 0;

    const offW = W + extraPad * 2;
    const offH = H + extraPad * 2;

    const off = document.createElement('canvas');
    off.width = offW; off.height = offH;
    const ctx = off.getContext('2d');

    const diagLen = Math.sqrt(offW * offW + offH * offH);
    const nCols = Math.ceil(diagLen / stepX) + 2;
    const nRows = Math.ceil(diagLen / stepY) + 2;
    const margin = Math.sqrt(tileW * tileW + tileH * tileH);

    for(let row = -nRows; row <= nRows; row++){
        for(let col = -nCols; col <= nCols; col++){
            let gx = col * stepX + row * hOffPx;
            let gy = row * stepY;
            if(s.type === 'brick-h' && Math.abs(row % 2) === 1) gx += stepX / 2;
            if(s.type === 'brick-v' && Math.abs(col % 2) === 1) gy += stepY / 2;

            const rx = gx * cosA - gy * sinA;
            const ry = gx * sinA + gy * cosA;
            // Shift tile origin by extraPad so the larger canvas is fully tiled
            const cx = mc.x + extraPad + rx, cy = mc.y + extraPad + ry;

            if(cx + margin < 0 || cx - margin > offW || cy + margin < 0 || cy - margin > offH) continue;

            const rot = (mAngle + col * (s.rotH || 0) + row * (s.rotV || 0)) * Math.PI / 180;
            const sx  = obj.flipX ? -obj.scaleX : obj.scaleX;
            const sy  = obj.flipY ? -obj.scaleY : obj.scaleY;

            ctx.save();
            ctx.translate(cx, cy);
            ctx.rotate(rot);
            // opacity is handled by patternFabricObj, not per-tile
            ctx.scale(sx, sy);
            ctx.drawImage(tileEl, -srcW / 2, -srcH / 2, srcW, srcH);
            ctx.restore();
        }
    }

    // ── Apply warp / perspective to the entire tiled canvas ──────────────────
    let finalCanvas = off;

    if(hasWarp){
        if(!data._patternWarpCanvas) data._patternWarpCanvas = document.createElement('canvas');
        finalCanvas = createWarpedImage(
            finalCanvas,
            data.warpAmount, data.arcAmount, data.arcTilt ?? 0,
            data._patternWarpCanvas, lowQuality
        );
    }
    if(hasPerspective){
        finalCanvas = applyPerspectiveDistortion(finalCanvas, data, lowQuality);
    }

    // ── Crop back to W×H after warp/perspective ───────────────────────────────
    // The tiled canvas was made larger by extraPad on each side (plus internal
    // warp padding), so after distortion we center-crop to W×H.  This ensures
    // the extra surrounding tiles fill any gaps the warp leaves at the edges.
    if(extraPad > 0 && finalCanvas.width > W){
        const crop = document.createElement('canvas');
        crop.width = W; crop.height = H;
        const cropCtx = crop.getContext('2d');
        const srcX = Math.round((finalCanvas.width  - W) / 2);
        const srcY = Math.round((finalCanvas.height - H) / 2);
        cropCtx.drawImage(finalCanvas, srcX, srcY, W, H, 0, 0, W, H);
        finalCanvas = crop;
    }

    // ── Burn clip mask into the pixel canvas ─────────────────────────────────
    // Fabric.js clipPath on a full-canvas image at (0,0) is unreliable in v5;
    // we clip directly with the Canvas 2D API so the mask is pixel-perfect.
    if(data.maskEnabled && data.maskType === 'bezier' && (data.maskPath || data.maskPaths?.length)){
        const allPaths = data.maskPaths?.length
            ? data.maskPaths
            : (data.maskPath ? [data.maskPath] : []);
        const cw = finalCanvas.width, ch = finalCanvas.height;
        const masked = document.createElement('canvas');
        masked.width = cw; masked.height = ch;
        const mCtx = masked.getContext('2d');
        mCtx.beginPath();
        allPaths.forEach(points => {
            if(!points?.length) return;
            mCtx.moveTo(points[0].x, points[0].y);
            for(let i = 1; i < points.length; i++){
                const prev = points[i - 1];
                const cur  = points[i];
                if(prev.cx !== undefined && prev.cy !== undefined){
                    mCtx.quadraticCurveTo(prev.cx, prev.cy, cur.x, cur.y);
                } else {
                    mCtx.lineTo(cur.x, cur.y);
                }
            }
            // close back to first point
            if(points.length >= 3){
                const last  = points[points.length - 1];
                const first = points[0];
                if(last.cx !== undefined && last.cy !== undefined){
                    mCtx.quadraticCurveTo(last.cx, last.cy, first.x, first.y);
                } else {
                    mCtx.lineTo(first.x, first.y);
                }
            }
            mCtx.closePath();
        });
        mCtx.clip();
        mCtx.drawImage(finalCanvas, 0, 0);
        finalCanvas = masked;
    }

    // ── Apply opacity and blend mode to the pattern object ───────────────────
    // (clipPath on patternFabricObj is now handled pixel-level above)
    data.patternFabricObj.clipPath = null;
    data.patternFabricObj.set({
        opacity: data.opacity ?? 1,
        globalCompositeOperation: _blendToGCO(data.blendMode ?? 'normal'),
        width: finalCanvas.width || W,
        height: finalCanvas.height || H,
        scaleX: 1, scaleY: 1, left: 0, top: 0,
    });
    data.patternFabricObj.setElement(finalCanvas);
    data.patternFabricObj.applyFilters();
    fc.requestRenderAll();
}

function _togglePatternMode(data, on){
    if(data.patternFabricObj){
        data.fabricCanvas.remove(data.patternFabricObj);
        data.patternFabricObj = null;
    }
    if(data._patternListener){
        ['object:moving','object:scaling','object:rotating','object:modified'].forEach(ev =>
            data.fabricCanvas.off(ev, data._patternListener));
        data._patternListener = null;
    }
    data.patternMode = !!on;
    if(!on){
        // Restore design object visibility with correct opacity
        if(data.designObject) data.designObject.set({
            opacity: data.opacity ?? 1,
            globalCompositeOperation: _blendToGCO(data.blendMode ?? 'normal'),
        });
        data._patternTileSource = null;
        data._patternWarpCanvas = null;
        data.fabricCanvas.requestRenderAll();
        return;
    }
    if(!data.designObject) return;

    const fc = data.fabricCanvas;
    const dummy = document.createElement('canvas');
    dummy.width = fc.width; dummy.height = fc.height;
    const pObj = new fabric.Image(dummy, {
        left:0, top:0, originX:'left', originY:'top',
        selectable:false, evented:false,
    });
    pObj._isPatternOverlay = true;
    fc.add(pObj);
    data.patternFabricObj = pObj;

    // Z-order: bg (0) → pattern (1) → design/overlays above
    fc.sendToBack(pObj);
    if(data.backgroundObject) fc.sendToBack(data.backgroundObject);

    data._patternListener = (e) => {
        if(e.target !== data.designObject) return;
        if(data._patternRAF) return;
        data._patternRAF = requestAnimationFrame(() => {
            data._patternRAF = null;
            _renderPattern(data, false);
        });
    };
    ['object:moving','object:scaling','object:rotating','object:modified'].forEach(ev =>
        fc.on(ev, data._patternListener));

    // Trigger full pipeline: populate _patternTileSource and render with effects
    if(data.warpAmount || data.arcAmount || data.perspectiveTop || data.perspectiveLeft || data.blurAmount || data.noiseAmount){
        applyWarpToData(data, true); // async; intercept inside will call _renderPattern
    } else {
        _renderPattern(data, false);
    }
}

function _syncPatternDisplay(){
    const data = activeIndices.length ? canvasData[activeIndices[0]] : null;
    const on = data?.patternMode || false;
    const s  = data?.patternSettings || _defaultPattern();

    const toggle = document.getElementById('patternModeToggle');
    const controls = document.getElementById('patternControls');
    if(toggle) toggle.checked = on;
    if(controls) controls.style.display = on ? 'block' : 'none';

    document.querySelectorAll('.pattern-type-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.type === (s.type || 'grid')));

    [['patternHSpacing','hSpacing'],['patternVSpacing','vSpacing'],['patternAngle','angle'],
     ['patternHOffset','hOffset'],['patternRotH','rotH'],['patternRotV','rotV']
    ].forEach(([id, key]) => {
        const v = s[key] || 0;
        const el = document.getElementById(id);
        if(el) el.valueAsNumber = v;
        const vEl = document.getElementById(id + 'Val');
        if(vEl) vEl.value = v;
    });
}

function _syncBgAdjustDisplay(){
    const data = activeIndices.length ? canvasData[activeIndices[0]] : null;
    const a = (data && data.bgAdjust) || {};
    bgHue.valueAsNumber        = a.hue        ?? 0;
    bgSaturation.valueAsNumber = a.saturation ?? 0;
    bgBrightness.valueAsNumber = a.brightness ?? 0;
    bgContrast.valueAsNumber   = a.contrast   ?? 0;
    document.getElementById('bgHueVal').textContent        = bgHue.value;
    document.getElementById('bgSaturationVal').textContent = bgSaturation.value;
    document.getElementById('bgBrightnessVal').textContent = bgBrightness.value;
    document.getElementById('bgContrastVal').textContent   = bgContrast.value;
    _syncBgCropDisplay();
}

function _syncBgCropDisplay(){
    const data = activeIndices.length ? canvasData[activeIndices[0]] : null;
    const c = (data && data.bgCrop) || {};
    bgCropRotation.valueAsNumber = c.rotation ?? 0;
    bgCropScale.valueAsNumber    = Math.round((c.scale ?? 1) * 100);
    bgCropX.valueAsNumber        = Math.round((c.x     ?? 0) * 100);
    bgCropY.valueAsNumber        = Math.round((c.y     ?? 0) * 100);
    document.getElementById('bgCropRotationVal').textContent = bgCropRotation.value;
    document.getElementById('bgCropScaleVal').textContent    = bgCropScale.value;
    document.getElementById('bgCropXVal').textContent        = bgCropX.value;
    document.getElementById('bgCropYVal').textContent        = bgCropY.value;
    const aspect = c.aspect ?? 0;
    document.querySelectorAll('.bg-aspect-btn').forEach(btn => {
        btn.classList.toggle('active', parseFloat(btn.dataset.aspect) === aspect);
    });
}

function _updateBgAdjust(){
    if(!activeIndices.length) return;
    const adj = {
        hue:        parseFloat(bgHue.value),
        saturation: parseFloat(bgSaturation.value),
        brightness: parseFloat(bgBrightness.value),
        contrast:   parseFloat(bgContrast.value)
    };
    document.getElementById('bgHueVal').textContent        = adj.hue;
    document.getElementById('bgSaturationVal').textContent = adj.saturation;
    document.getElementById('bgBrightnessVal').textContent = adj.brightness;
    document.getElementById('bgContrastVal').textContent   = adj.contrast;
    activeIndices.forEach(i => {
        const d = canvasData[i];
        if(d.locked) return;
        d.bgAdjust = { ...adj };
        _applyBgAdjust(d);
    });
    _markDirty();
}

let _bgCropAttachDesign = false;
document.getElementById('bgCropAttachDesign').addEventListener('change', e => {
    _bgCropAttachDesign = e.target.checked;
});

function _updateBgCrop(){
    if(!activeIndices.length) return;
    document.getElementById('bgCropRotationVal').textContent = bgCropRotation.value;
    document.getElementById('bgCropScaleVal').textContent    = bgCropScale.value;
    document.getElementById('bgCropXVal').textContent        = bgCropX.value;
    document.getElementById('bgCropYVal').textContent        = bgCropY.value;

    const newScale = parseFloat(bgCropScale.value) / 100;
    const newX     = parseFloat(bgCropX.value)     / 100;
    const newY     = parseFloat(bgCropY.value)     / 100;

    activeIndices.forEach(i => {
        const d = canvasData[i];
        if(d.locked) return;
        if(!d.bgCrop) d.bgCrop = { x:0, y:0, scale:1, rotation:0, aspect:0 };

        const oldX        = d.bgCrop.x;
        const oldY        = d.bgCrop.y;
        const oldScale    = d.bgCrop.scale;
        const oldRotation = d.bgCrop.rotation;

        const newRotation = parseFloat(bgCropRotation.value);
        d.bgCrop.rotation = newRotation;
        d.bgCrop.scale    = newScale;
        d.bgCrop.x        = newX;
        d.bgCrop.y        = newY;
        _applyBgAdjust(d);

        if(_bgCropAttachDesign && d.designObject){
            const W  = d.fabricCanvas.width;
            const H  = d.fabricCanvas.height;
            const obj = d.designObject;
            const cx  = W / 2, cy = H / 2;

            // Zoom: scale position around canvas centre, scale object size
            const zr     = oldScale > 0 ? newScale / oldScale : 1;
            let left = cx + (obj.left - cx) * zr;
            let top  = cy + (obj.top  - cy) * zr;

            // Rotation: rotate position around canvas centre by delta angle
            const dRad = (newRotation - oldRotation) * Math.PI / 180;
            if(dRad !== 0){
                const dx = left - cx, dy = top - cy;
                const cos = Math.cos(dRad), sin = Math.sin(dRad);
                left = cx + dx * cos - dy * sin;
                top  = cy + dx * sin + dy * cos;
            }

            // Pan: shift by delta fraction of canvas size
            left += (newX - oldX) * W;
            top  += (newY - oldY) * H;

            obj.set({
                left,
                top,
                scaleX: obj.scaleX * zr,
                scaleY: obj.scaleY * zr,
                angle:  (obj.angle || 0) + (newRotation - oldRotation),
            });
            obj.setCoords();
            if(d.patternMode) _renderPattern(d, false);
            d.fabricCanvas.requestRenderAll();
        }
    });
    _markDirty();
}

function applyBlendModeToImage(sourceImg, data, mode, intensity){

    if(!mode || mode === "normal"){
        return sourceImg;
    }

    const normalizedIntensity = Math.max(0, Math.min(1, intensity / 100));

    if(normalizedIntensity <= 0){
        return sourceImg;
    }

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    canvas.width = sourceImg.width;
    canvas.height = sourceImg.height;

    ctx.drawImage(sourceImg, 0, 0);

    const designData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const designPixels = designData.data;

    // Sample ONLY the actual area underneath the design
    const bgCanvas = document.createElement('canvas');
    const bgCtx = bgCanvas.getContext('2d');

    bgCanvas.width = canvas.width;
    bgCanvas.height = canvas.height;

    const designWidth =
        ((data.scaleX || data.scale) * data.previewScale) * canvas.width;

    const designHeight =
        ((data.scaleY || data.scale) * data.previewScale) * canvas.height;

    const left = data.x - (designWidth / 2);
    const top = data.y - (designHeight / 2);

    const sx = left / data.previewScale;
    const sy = top / data.previewScale;
    const sw = designWidth / data.previewScale;
    const sh = designHeight / data.previewScale;

    bgCtx.drawImage(
        data.bg,
        sx,
        sy,
        sw,
        sh,
        0,
        0,
        canvas.width,
        canvas.height
    );

    const bgData = bgCtx.getImageData(0, 0, canvas.width, canvas.height);
    const bgPixels = bgData.data;

    for(let i = 0; i < designPixels.length; i += 4){

        const alpha = designPixels[i + 3] / 255;

        if(alpha <= 0) continue;

        for(let c = 0; c < 3; c++){

            const base = bgPixels[i + c];
            const blend = designPixels[i + c];

            let blended;

            if(mode === "multiply"){

                blended = (base * blend) / 255;

            } else if(mode === "screen"){

                blended = 255 - (
                    ((255 - base) * (255 - blend)) / 255
                );

            } else if(mode === "overlay"){

                blended = base < 128
                    ? (2 * base * blend) / 255
                    : 255 - (2 * (255 - base) * (255 - blend)) / 255;

            } else if(mode === "soft-light"){

                const b = base / 255, s = blend / 255;
                let d;
                if(b <= 0.25) d = ((16 * b - 12) * b + 4) * b;
                else          d = Math.sqrt(b);
                blended = s <= 0.5
                    ? Math.round((b - (1 - 2*s) * b * (1 - b)) * 255)
                    : Math.round((b + (2*s - 1) * (d - b)) * 255);

            } else {

                blended = blend;
            }

            const finalValue =
                (blend * (1 - normalizedIntensity)) +
                (blended * normalizedIntensity);

            designPixels[i + c] = finalValue;
        }
    }

    ctx.putImageData(designData, 0, 0);

    return canvas;
}


function applyGaussianBlurToImage(sourceImg, blurRadius){

    if(!blurRadius || blurRadius <= 0){
        return sourceImg;
    }

    // Add transparent padding so blur can extend outward
    // instead of being clipped at the image edges
    const pad = Math.ceil(blurRadius * 4);

    const blurCanvas = document.createElement('canvas');
    const blurCtx = blurCanvas.getContext('2d');

    blurCanvas.width = sourceImg.width + (pad * 2);
    blurCanvas.height = sourceImg.height + (pad * 2);

    blurCtx.clearRect(0, 0, blurCanvas.width, blurCanvas.height);

    blurCtx.filter = `blur(${blurRadius}px)`;

    // draw inset so blur has room to expand
    blurCtx.drawImage(sourceImg, pad, pad);

    return blurCanvas;
}



// Applies Photoshop-style monochromatic Gaussian noise to a canvas/image.
// noisePercent: 0–100, where 100 = maximum grain (amplitude ≈ ±127 luminance).
// Returns the original source unchanged when noisePercent is 0 (fast path).
function applyNoiseToImage(source, noisePercent){

    if(!noisePercent || noisePercent <= 0) return source;

    const w = source.width || source.naturalWidth;
    const h = source.height || source.naturalHeight;

    const c = document.createElement('canvas');
    c.width  = w;
    c.height = h;

    const ctx = c.getContext('2d');
    ctx.drawImage(source, 0, 0);

    const imageData = ctx.getImageData(0, 0, w, h);
    const px = imageData.data;

    // amplitude scales so 100 % ≈ ±127 (half of 255),
    // matching Photoshop's Gaussian noise visual range
    const amplitude = (noisePercent / 100) * 127;

    for(let i = 0; i < px.length; i += 4){

        if(px[i + 3] === 0) continue; // leave fully-transparent pixels alone

        // Box-Muller transform → Gaussian random variable (mean 0, σ ≈ 1)
        const u1 = Math.random() || 1e-10;
        const u2 = Math.random();
        const z  = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);

        // Monochromatic: same offset on R, G, B so hue is preserved
        const delta = z * amplitude * 0.5;

        px[i]     = Math.min(255, Math.max(0, px[i]     + delta));
        px[i + 1] = Math.min(255, Math.max(0, px[i + 1] + delta));
        px[i + 2] = Math.min(255, Math.max(0, px[i + 2] + delta));
        // alpha (px[i+3]) intentionally unchanged
    }

    ctx.putImageData(imageData, 0, 0);
    return c;
}


// Scan a canvas for the bounding box of non-transparent pixels and return a
// new canvas cropped to that box (+ a small anti-alias margin). Returns the
// original canvas unchanged when there is nothing to trim.
function trimTransparentBorders(canvas){

    const ctx = canvas.getContext('2d');
    const { width, height } = canvas;
    const px = ctx.getImageData(0, 0, width, height).data;

    let top = height, bottom = -1, left = width, right = -1;

    for(let y = 0; y < height; y++){
        const rowBase = y * width * 4;
        for(let x = 0; x < width; x++){
            if(px[rowBase + x * 4 + 3] > 4){   // ignore near-invisible AA fringe
                if(y < top)    top    = y;
                if(y > bottom) bottom = y;
                if(x < left)   left   = x;
                if(x > right)  right  = x;
            }
        }
    }

    if(bottom < 0) return canvas;   // fully transparent – nothing to trim

    const margin = 2;   // keep a couple of pixels for edge anti-aliasing
    const x0 = Math.max(0,     left   - margin);
    const y0 = Math.max(0,     top    - margin);
    const x1 = Math.min(width, right  + margin + 1);
    const y1 = Math.min(height, bottom + margin + 1);

    if(x0 === 0 && y0 === 0 && x1 === width && y1 === height) return canvas;

    const trimmed = document.createElement('canvas');
    trimmed.width  = x1 - x0;
    trimmed.height = y1 - y0;
    trimmed.getContext('2d').drawImage(canvas, x0, y0, trimmed.width, trimmed.height,
                                               0,  0,  trimmed.width, trimmed.height);
    return trimmed;
}


// preTrimmed: pass an already-trimmed canvas to skip the getImageData pixel scan.
// Used by _applyWarpToOneObject when the warp canvas hasn't changed (trim cache hit).
function applyPerspectiveDistortion(sourceCanvas, data, lowQuality = false, preTrimmed = null){

    const top  = data.perspectiveTop  || 0;
    const left = data.perspectiveLeft || 0;

    // Trim transparent borders from the source (e.g. warp/arc padding) BEFORE
    // computing perspective. Two problems arise if we skip this:
    //   1. Jump at 0: the early-return path returns a padded warpedBase canvas
    //      while the non-zero path returns a trimmed canvas → size differs → jump.
    //   2. Squashing: srcW/srcH include warp padding, so perspective maths are
    //      computed over a larger area than the actual content — the effect is
    //      over-amplified proportionally to the warp padding.
    // Trimming here is fast (< 1 ms for typical sizes) and idempotent for sources
    // that already have no transparent border (e.g. a plain uploaded image).
    const src  = preTrimmed || trimTransparentBorders(sourceCanvas);
    const srcW = src.width;
    const srcH = src.height;

    if(top === 0 && left === 0){
        return src;
    }

    const out = document.createElement('canvas');
    const ctx = out.getContext('2d');

    // Minimum horizontal padding: stretched row dx = pad - srcW*|top|/180 ≥ 0
    // → pad ≥ srcW * |top| / 180  (same derivation as vPadNeeded, transposed).
    const hPadNeeded = Math.abs(top) > 0
        ? Math.ceil(srcW * Math.abs(top) / 180)
        : 0;
    // Correct minimum padding: content top in output = dy + pad*leftScale ≥ 0
    // → pad ≥ srcH * L/2, where L = max leftScale - 1 = |left|/90 (for 2× formula).
    const vPadNeeded = Math.abs(left) > 0
        ? Math.ceil(srcH * Math.abs(left) / 180)
        : 0;
    const pad = Math.max(hPadNeeded, vPadNeeded, 20);

    out.width  = srcW + pad * 2;
    out.height = srcH + pad * 2;

    const outW = out.width;
    const outH = out.height;

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = lowQuality ? 'low' : 'medium';

    // Live-drag uses fewer slices (3× faster per pass) with no visible quality
    // difference because perspective distortion is a smooth linear transform.
    const horizontalSlices = lowQuality ? 60 : 180;

    // ── Pass 1: top/bottom perspective (horizontal slices) ───────────────────
    // Width of each row is scaled by widthScale, which is 1 on the untouched
    // side and 1+|top|/90 on the stretched side — straight lines, no curves.
    // Source has no padding, so t is already content-normalised (t=0 = top edge,
    // t=1 = bottom edge). top > 0: top side stretches; top < 0: bottom side stretches.

    for(let y = 0; y < horizontalSlices; y++){

        const t      = y / (horizontalSlices - 1);
        const srcY   = t * srcH;
        const sliceH = Math.max(2, srcH / horizontalSlices);

        // top > 0: top edge (t=0) at max width, bottom edge (t=1) untouched
        // top < 0: top edge (t=0) untouched, bottom edge (t=1) at max width
        const widthScale = top > 0
            ? 1 + (top  / 90) * (1 - t)
            : 1 + (-top / 90) * t;
        const targetW = srcW * widthScale;

        const dx = pad + (srcW - targetW) / 2;
        const dy = pad + srcY;

        ctx.drawImage(
            src,
            0,              Math.round(srcY),
            srcW,           Math.ceil(sliceH),
            Math.round(dx), Math.round(dy),
            Math.ceil(targetW + 1), Math.ceil(sliceH + 1)
        );
    }

    // ── Pass 2: left/right perspective (vertical slices) ─────────────────────
    // Height of each column interpolates linearly from leftScale (left) to 1
    // (right). Vertical slices always span full canvas height → no horizontal
    // gaps or stripes possible.

    if(left !== 0){

        const tempCanvas = document.createElement('canvas');
        const tempCtx    = tempCanvas.getContext('2d');
        tempCanvas.width  = out.width;
        tempCanvas.height = out.height;
        tempCtx.drawImage(out, 0, 0);
        ctx.clearRect(0, 0, out.width, out.height);

        const verticalSlices = lowQuality ? 60 : 180;

        for(let x = 0; x < verticalSlices; x++){

            const t      = x / (verticalSlices - 1);
            const srcX   = t * out.width;
            const sliceW = Math.max(2, out.width / verticalSlices);

            // t_c: normalised position within the design content (0 = left edge, 1 = right edge).
            // Using the full-canvas t would make content edges slightly non-zero,
            // causing both sides to stretch. Anchoring to content bounds ensures
            // exactly scale=1 at the untouched side and scale=1+|left|/180 at the stretched side.
            const t_c = Math.max(0, Math.min(1, (srcX - pad) / srcW));

            // left > 0: right side stretches, left side untouched
            // left < 0: left side stretches, right side untouched
            const leftScale = left > 0
                ? 1 + (left  / 90) * t_c
                : 1 + (-left / 90) * (1 - t_c);
            const targetH    = out.height * leftScale;
            const extraSpace = targetH - out.height;
            const dy         = -(extraSpace / 2);

            ctx.drawImage(
                tempCanvas,
                Math.round(srcX), 0,
                Math.ceil(sliceW), out.height,
                Math.round(srcX),  Math.round(dy),
                Math.ceil(sliceW + 1), Math.ceil(targetH + 1)
            );
        }
    }

    // Always trim transparent borders so the bounding box / handles reflect the
    // actual distorted content size in both LQ (live drag) and HQ (debounce)
    // passes. Without this, handles oscillate between the oversized padded canvas
    // and the trimmed canvas every 220 ms, which looks like the design jumping.
    // trimTransparentBorders is a fast pixel scan (< 1 ms for typical canvas sizes)
    // so it is safe to run on every drag frame.
    return trimTransparentBorders(out);
}


function createWarpedImage(img, cylinderAmount, arcAmount, arcTiltAmount, targetCanvas, lowQuality = false) {

    const temp = targetCanvas;

    const ctx = temp.getContext("2d");

    if(cylinderAmount === 0 && arcAmount === 0){

        temp.width = img.width;
        temp.height = img.height;

        ctx.clearRect(0,0,temp.width,temp.height);
        ctx.drawImage(img,0,0);

        return temp;
    }

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "medium";

    // pad must cover both arc displacement (max = arcAmount px at centre) and
    // tilt displacement (max = 0.18 × img.height × |arcTiltAmount|/100 at centre).
    const pad = Math.abs(arcAmount) * 6
        + Math.ceil(Math.abs(arcTiltAmount) / 100 * img.height * 0.2);

    temp.width = img.width + pad;
    temp.height = img.height + pad * 2;

    ctx.clearRect(0,0,temp.width,temp.height);

    const centerX = temp.width / 2;
    const centerY = temp.height / 2;

    const slices = lowQuality
        ? Math.max(32, Math.floor(img.width / 18))
        : Math.max(260, Math.floor(img.width / 3.5));
    const sliceW = Math.max(2, Math.ceil(img.width / slices));

    // Normalize projection so content always spans full design width.
    // Without this, sin(θ) * 0.42 shrinks the design to 84% at cylinder=100
    // and ~59% at cylinder=50, forcing users to manually rescale after warping.
    const sinMax = Math.sin((Math.PI / 2) * (Math.abs(cylinderAmount) / 100));

    for(let i = 0; i < slices; i++){

        const sx = i * sliceW;

        // nx must be derived from source pixel position, not slice index.
        // sliceW = ceil(img.width/slices) so slices×sliceW > img.width —
        // the excess slices read transparent pixels and would push all real
        // content toward the left half of the cylinder if nx used the index.
        const nx = Math.max(-1, Math.min(1,
            (sx + sliceW * 0.5) / img.width * 2 - 1
        ));

        const theta = nx * (Math.PI / 2) * (cylinderAmount / 100);

        const projectedX = Math.sin(theta);

        const depth = Math.cos(theta);

        // A cylinder label runs parallel to the cylinder axis — only horizontal
        // dimension is foreshortened (handled by projectedSliceW), not vertical.
        // The old 0.82+depth*0.18 created spherical barrel distortion: top and
        // bottom edges bowed inward at the sides, making arc look asymmetric.
        const verticalScale = 1.0;

        const arcCurve =
            arcAmount * 4 *
            (1 - Math.pow(nx, 2));

        const drawH = img.height * verticalScale;

        // Arc tilt: makes top and bottom curve by different amounts.
        // tiltK > 0 (camera from above): bottom curves more, top curves less.
        // tiltK < 0 (camera from below): top curves more, bottom curves less.
        // Scales with img.height so the effect is consistent across design sizes.
        const tiltK = (-arcTiltAmount / 100) * img.height * 0.18 * (1 - nx * nx);

        // When cylinderAmount=0, projectedX=0 so all slices collapse to centerX.
        // Otherwise normalize: divide by sinMax so edges always land at ±img.width/2
        // from center regardless of cylinder amount — design width stays constant.
        const dx = cylinderAmount === 0
            ? centerX + (sx + sliceW / 2 - img.width / 2)
            : centerX + (projectedX / sinMax) * (img.width / 2);

        // tiltK shifts the top edge and compresses/stretches height so top and
        // bottom arcs are independent: top = arcCurve + tiltK, bottom = arcCurve - tiltK.
        const dy =
            centerY -
            drawH / 2 +
            arcCurve +
            tiltK;

        const drawH_tilt = Math.max(1, drawH - 2 * tiltK);

        // projectedSliceW must match the actual derivative of dx w.r.t. slice index,
        // otherwise slices spread wider than they draw and leave transparent gaps.
        // Old formula (0.55 + depth*0.45) was calibrated for the un-normalized
        // projection; with normalization the center spacing is π/2 * sliceW (~3.14px)
        // but the old formula only drew 2px there — causing periodic 1px gaps.
        const projectedSliceW = cylinderAmount === 0
            ? sliceW
            : Math.max(
                depth * (Math.PI / 2) * (Math.abs(cylinderAmount) / 100) / sinMax * sliceW,
                1
              );

        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "medium";

        ctx.drawImage(
            img,
            Math.round(sx),
            0,
            Math.ceil(sliceW + 2),
            img.height,
            Math.round(dx - (projectedSliceW / 2)),
            Math.round(dy),
            Math.ceil(projectedSliceW + 1),
            Math.ceil(drawH_tilt)
        );
    }

    return temp;
}



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
    return c;
}

// Erase a soft circle from obj at a Fabric canvas-space point.
// data is the owning canvasData entry, used to convert CSS px → Fabric units.
function eraseFromObject(obj, data, pointer) {
    const el  = ensureErasableCanvas(obj);
    const ctx = el.getContext('2d');

    // CSS-pixel radius → Fabric canvas units
    const cvEl       = data.fabricCanvas.upperCanvasEl;
    const rect       = cvEl.getBoundingClientRect();
    const cssToFabric = (rect.width > 0) ? (cvEl.width / rect.width) : 1;
    const fabricRadius = designEraserSize * cssToFabric;

    // Convert Fabric canvas-space → object-local space (origin = object center)
    const inv   = fabric.util.invertTransform(obj.calcTransformMatrix());
    const local = fabric.util.transformPoint(pointer, inv);

    // Object-local → element pixel coordinates
    const sx = el.width  / obj.width;
    const sy = el.height / obj.height;
    const px = (local.x + obj.width  / 2) * sx;
    const py = (local.y + obj.height / 2) * sy;

    // Radius in element pixels (compensate for object scale and element:object ratio)
    const scl    = Math.min(obj.scaleX || 1, obj.scaleY || 1);
    const radius = Math.max(1, fabricRadius / scl * Math.min(sx, sy));

    // Softness: inner hard core radius where erase is 100%, fades to 0 at outer edge
    const softFrac  = designEraserSoftness / 100;
    const innerR    = Math.max(0, radius * (1 - softFrac) - 0.5);

    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    if (softFrac < 0.02) {
        // Hard eraser — solid fill
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

// Apply the eraser at a canvas-space point to design objects in one window.
// Only touches objects that were selected when eraser mode was entered;
// falls back to all objects if nothing was selected at that time.
function applyDesignEraserAt(data, pointer) {
    let targets = [];
    if (data.designObject)       targets.push(data.designObject);
    if (data.extraDesignObjects) targets.push(...data.extraDesignObjects);
    if (eraserTargetObjects.size > 0) {
        targets = targets.filter(obj => eraserTargetObjects.has(obj));
    }
    targets.forEach(obj => eraseFromObject(obj, data, pointer));
    if (targets.length) data.fabricCanvas.requestRenderAll();
}

function updateEraserCursor(e) {
    if (!designEraserMode) return;
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
window.addEventListener('mouseup', () => { if (designEraserMode) designEraserDown = false; });

// ── Free-form Mesh Warp ───────────────────────────────────────────────────────

function _bernstein3(i, t) {
    const mt = 1 - t;
    if (i === 0) return mt*mt*mt;
    if (i === 1) return 3*t*mt*mt;
    if (i === 2) return 3*t*t*mt;
    return t*t*t;
}

// Evaluate the 4×4 bicubic Bézier patch at parameter (u,v).
// warpPoints[row][col] are the control points; u = col direction, v = row direction.
function _evalWarpPatch(u, v) {
    let x = 0, y = 0;
    for (let r = 0; r < 4; r++) {
        const bv = _bernstein3(r, v);
        for (let c = 0; c < 4; c++) {
            const w = bv * _bernstein3(c, u);
            x += w * warpPoints[r][c].x;
            y += w * warpPoints[r][c].y;
        }
    }
    return {x, y};
}

// Render a textured triangle onto ctx.
// Source triangle: (sx0,sy0),(sx1,sy1),(sx2,sy2) in img pixel space.
// Destination triangle: (dx0,dy0),(dx1,dy1),(dx2,dy2) in ctx space.
// Uses an affine transform + clip to map the source patch to the destination triangle.
function _drawTexturedTriangle(ctx, img,
        sx0, sy0, dx0, dy0,
        sx1, sy1, dx1, dy1,
        sx2, sy2, dx2, dy2) {
    const det = sx0*(sy1-sy2) + sx1*(sy2-sy0) + sx2*(sy0-sy1);
    if (Math.abs(det) < 0.5) return;
    const a = (dx0*(sy1-sy2) + dx1*(sy2-sy0) + dx2*(sy0-sy1)) / det;
    const c = (dx0*(sx2-sx1) + dx1*(sx0-sx2) + dx2*(sx1-sx0)) / det;
    const e = (dx0*(sx1*sy2-sx2*sy1) + dx1*(sx2*sy0-sx0*sy2) + dx2*(sx0*sy1-sx1*sy0)) / det;
    const b = (dy0*(sy1-sy2) + dy1*(sy2-sy0) + dy2*(sy0-sy1)) / det;
    const d = (dy0*(sx2-sx1) + dy1*(sx0-sx2) + dy2*(sx1-sx0)) / det;
    const f = (dy0*(sx1*sy2-sx2*sy1) + dy1*(sx2*sy0-sx0*sy2) + dy2*(sx0*sy1-sx1*sy0)) / det;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(dx0, dy0);
    ctx.lineTo(dx1, dy1);
    ctx.lineTo(dx2, dy2);
    ctx.closePath();
    ctx.clip();
    ctx.transform(a, b, c, d, e, f);
    ctx.drawImage(img, 0, 0);
    ctx.restore();
}

// Render the bicubic warp using forward-mapped triangle subdivision.
// Returns {canvas, left, top} — canvas is the warped image; left/top are its
// top-left corner in Fabric canvas coordinates.
function _renderBicubicWarp() {
    const N    = 40;
    const dpr  = warpDPR || 1;
    const srcW = warpSourceCanvas.width;   // physical pixels (DPR-scaled)
    const srcH = warpSourceCanvas.height;

    // Compute output bounding box by densely sampling the patch.
    // warpPoints are in CSS/Fabric coords; multiply by dpr for physical pixels.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const steps = 24;
    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        for (const [u, v] of [[t,0],[t,1],[0,t],[1,t],[t,t]]) {
            const p = _evalWarpPatch(u, v);
            if (p.x < minX) minX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.x > maxX) maxX = p.x;
            if (p.y > maxY) maxY = p.y;
        }
    }
    // Output canvas at full physical-pixel resolution
    const outW = Math.max(1, Math.ceil((maxX - minX) * dpr) + 2);
    const outH = Math.max(1, Math.ceil((maxY - minY) * dpr) + 2);

    const outCanvas = document.createElement('canvas');
    outCanvas.width  = outW;
    outCanvas.height = outH;
    const outCtx = outCanvas.getContext('2d');
    outCtx.imageSmoothingEnabled = true;
    outCtx.imageSmoothingQuality = 'high';

    for (let ri = 0; ri < N; ri++) {
        for (let ci = 0; ci < N; ci++) {
            const u0 = ci / N, u1 = (ci + 1) / N;
            const v0 = ri / N, v1 = (ri + 1) / N;

            const sx0 = u0 * srcW, sy0 = v0 * srcH;
            const sx1 = u1 * srcW, sy1 = v1 * srcH;

            const D00 = _evalWarpPatch(u0, v0);
            const D10 = _evalWarpPatch(u1, v0);
            const D01 = _evalWarpPatch(u0, v1);
            const D11 = _evalWarpPatch(u1, v1);

            // Destination in physical pixels: (CSS offset) × dpr
            _drawTexturedTriangle(outCtx, warpSourceCanvas,
                sx0, sy0, (D00.x - minX) * dpr, (D00.y - minY) * dpr,
                sx1, sy0, (D10.x - minX) * dpr, (D10.y - minY) * dpr,
                sx0, sy1, (D01.x - minX) * dpr, (D01.y - minY) * dpr
            );
            _drawTexturedTriangle(outCtx, warpSourceCanvas,
                sx1, sy1, (D11.x - minX) * dpr, (D11.y - minY) * dpr,
                sx0, sy1, (D01.x - minX) * dpr, (D01.y - minY) * dpr,
                sx1, sy0, (D10.x - minX) * dpr, (D10.y - minY) * dpr
            );
        }
    }
    return { canvas: outCanvas, left: minX, top: minY, dpr };
}

// Draw the warp overlay (grid + handles) directly onto a Fabric canvas context.
// Draw the live deformed preview of the warped design directly onto the Fabric canvas ctx.
// Compute warp control points for a secondary group, proportionally scaled
// from the primary source bounds to that group's source bounds.
function _scaledWarpPointsForGroup(group) {
    const pb = warpSourceBounds;
    const gb = group.sourceBounds;
    const sx = pb.width  > 0 ? gb.width  / pb.width  : 1;
    const sy = pb.height > 0 ? gb.height / pb.height : 1;
    return warpPoints.map((row, r) =>
        row.map((pt, c) => ({
            x: gb.left + (c / 3) * gb.width  + (pt.x - (pb.left + (c / 3) * pb.width))  * sx,
            y: gb.top  + (r / 3) * gb.height + (pt.y - (pb.top  + (r / 3) * pb.height)) * sy,
        }))
    );
}

// Draw live deformed preview of the warp target(s) onto ctx.
// Accepts optional srcCanvas / pts overrides so it can be called for secondary
// canvases; falls back to the globals (warpSourceCanvas / warpPoints) for the
// primary canvas. Uses N=20 subdivision (fast enough for real-time dragging).
function _drawWarpPreview(ctx, srcCanvas, pts) {
    const src = srcCanvas || warpSourceCanvas;
    if (!src || !warpPoints.length) return;
    // Temporarily swap the warpPoints global so _evalWarpPatch uses the override.
    const savedPts = warpPoints;
    if (pts) warpPoints = pts;
    const N    = 20;
    const srcW = src.width;
    const srcH = src.height;
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    for (let ri = 0; ri < N; ri++) {
        for (let ci = 0; ci < N; ci++) {
            const u0 = ci / N,     u1 = (ci + 1) / N;
            const v0 = ri / N,     v1 = (ri + 1) / N;
            const sx0 = u0 * srcW, sy0 = v0 * srcH;
            const sx1 = u1 * srcW, sy1 = v1 * srcH;
            const D00 = _evalWarpPatch(u0, v0);
            const D10 = _evalWarpPatch(u1, v0);
            const D01 = _evalWarpPatch(u0, v1);
            const D11 = _evalWarpPatch(u1, v1);
            _drawTexturedTriangle(ctx, src,
                sx0, sy0, D00.x, D00.y,
                sx1, sy0, D10.x, D10.y,
                sx0, sy1, D01.x, D01.y);
            _drawTexturedTriangle(ctx, src,
                sx1, sy1, D11.x, D11.y,
                sx0, sy1, D01.x, D01.y,
                sx1, sy0, D10.x, D10.y);
        }
    }
    ctx.restore();
    if (pts) warpPoints = savedPts;
}

function _drawWarpOverlay(ctx) {
    if (!designWarpMode || warpPoints.length !== 4) return;
    ctx.save();
    ctx.imageSmoothingEnabled = true;

    // Live deformed design preview — drawn first so grid sits on top
    _drawWarpPreview(ctx);

    // Bezier grid lines
    ctx.strokeStyle = 'rgba(74,158,255,0.9)';
    ctx.lineWidth   = 1.3;
    ctx.setLineDash([]);

    for (let r = 0; r < 4; r++) {               // horizontal curves
        const p = warpPoints[r];
        ctx.beginPath();
        ctx.moveTo(p[0].x, p[0].y);
        ctx.bezierCurveTo(p[1].x, p[1].y, p[2].x, p[2].y, p[3].x, p[3].y);
        ctx.stroke();
    }
    for (let c = 0; c < 4; c++) {               // vertical curves
        const p = [warpPoints[0][c], warpPoints[1][c], warpPoints[2][c], warpPoints[3][c]];
        ctx.beginPath();
        ctx.moveTo(p[0].x, p[0].y);
        ctx.bezierCurveTo(p[1].x, p[1].y, p[2].x, p[2].y, p[3].x, p[3].y);
        ctx.stroke();
    }

    // Control point handles
    for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
            const p          = warpPoints[r][c];
            const isCorner   = (r === 0 || r === 3) && (c === 0 || c === 3);
            const isDragging = warpDragRC && warpDragRC.r === r && warpDragRC.c === c;

            ctx.beginPath();
            if (isCorner) {
                const s = isDragging ? 7 : 5;
                ctx.rect(p.x - s, p.y - s, s * 2, s * 2);
                ctx.fillStyle   = '#ffffff';
                ctx.fill();
                ctx.strokeStyle = isDragging ? '#0055cc' : '#555555';
                ctx.lineWidth   = isDragging ? 2 : 1.5;
                ctx.stroke();
            } else {
                const rad = isDragging ? 7 : 5;
                ctx.arc(p.x, p.y, rad, 0, Math.PI * 2);
                ctx.fillStyle   = isDragging ? '#0055cc' : '#4a9eff';
                ctx.fill();
                ctx.strokeStyle = '#ffffff';
                ctx.lineWidth   = 1.5;
                ctx.stroke();
            }
        }
    }
    ctx.restore();
}

function enterDesignWarpMode() {
    let targets = [...selectedDesigns];
    if (targets.length === 0) {
        for (const d of canvasData) {
            const ao = d.fabricCanvas.getActiveObject();
            if (ao) { targets = [ao]; break; }
        }
    }
    if (targets.length === 0) {
        alert('Select at least one design layer before using Warp.');
        return;
    }

    // Group targets by canvas entry so every selected design on every window
    // gets the same warp map applied proportionally.
    warpAllGroups = [];
    for (const d of canvasData) {
        const allObjs = [d.designObject, ...(d.extraDesignObjects || [])].filter(Boolean);
        const grpTargets = targets.filter(t => allObjs.includes(t));
        if (grpTargets.length > 0) warpAllGroups.push({ ownerData: d, targets: grpTargets });
    }
    // Fallback: nothing matched known design entries (shouldn't normally happen)
    if (warpAllGroups.length === 0) {
        const fb = canvasData.find(d => d.fabricCanvas.getObjects().some(o => targets.includes(o)));
        if (fb) warpAllGroups.push({ ownerData: fb, targets });
    }
    if (warpAllGroups.length === 0) return;

    // Rasterise source for EVERY group.
    // For each canvas: hide non-target objects, render, copy lower-canvas region
    // at full DPR resolution, then restore — capturing exactly what the user sees.
    for (const group of warpAllGroups) {
        const { ownerData: grpData, targets: grpObjs } = group;
        const grpFc       = grpData.fabricCanvas;
        const grpAllFObjs = grpFc.getObjects();

        const rects  = grpObjs.map(o => o.getBoundingRect(true, true));
        const bMinX  = Math.min(...rects.map(r => r.left));
        const bMinY  = Math.min(...rects.map(r => r.top));
        const bMaxX  = Math.max(...rects.map(r => r.left + r.width));
        const bMaxY  = Math.max(...rects.map(r => r.top  + r.height));
        const grpBounds = { left: bMinX, top: bMinY, width: bMaxX - bMinX, height: bMaxY - bMinY };

        grpAllFObjs.forEach(o => {
            if (!grpObjs.includes(o)) { o._warpHiddenVis = o.visible; o.visible = false; }
        });
        const savedBg  = grpFc.backgroundImage;
        if (savedBg) grpFc.backgroundImage = null;
        const savedSel = new Set(selectedDesigns);
        selectedDesigns.clear();
        grpFc.discardActiveObject();
        grpFc.renderAll();

        const lc  = grpFc.lowerCanvasEl;
        const dpr = Math.max(1, lc.width / grpFc.getWidth());
        const lcX = Math.round(bMinX * dpr);
        const lcY = Math.round(bMinY * dpr);
        const lcW = Math.max(1, Math.round(grpBounds.width  * dpr));
        const lcH = Math.max(1, Math.round(grpBounds.height * dpr));

        const srcCanvas        = document.createElement('canvas');
        srcCanvas.width  = lcW;
        srcCanvas.height = lcH;
        const sCtx = srcCanvas.getContext('2d');
        sCtx.imageSmoothingEnabled = true;
        sCtx.imageSmoothingQuality = 'high';
        sCtx.drawImage(lc, lcX, lcY, lcW, lcH, 0, 0, lcW, lcH);

        savedSel.forEach(o => selectedDesigns.add(o));
        grpAllFObjs.forEach(o => {
            if (o._warpHiddenVis !== undefined) { o.visible = o._warpHiddenVis; delete o._warpHiddenVis; }
        });
        if (savedBg) grpFc.backgroundImage = savedBg;

        group.sourceCanvas = srcCanvas;
        group.sourceBounds = grpBounds;
        group.dpr          = dpr;
    }

    // Primary group (first) drives the visible warp grid and live preview.
    const primary    = warpAllGroups[0];
    warpActiveData   = primary.ownerData;
    warpTargetObjs   = primary.targets;
    warpSourceCanvas = primary.sourceCanvas;
    warpSourceBounds = primary.sourceBounds;
    warpDPR          = primary.dpr;

    // Initialise 4×4 control point grid evenly over the PRIMARY bounding box.
    const { left: minX, top: minY } = warpSourceBounds;
    warpPoints = [];
    for (let r = 0; r < 4; r++) {
        warpPoints.push([]);
        for (let c = 0; c < 4; c++) {
            warpPoints[r].push({
                x: minX + (c / 3) * warpSourceBounds.width,
                y: minY + (r / 3) * warpSourceBounds.height
            });
        }
    }
    warpDragRC     = null;
    designWarpMode = true;

    // Hide ALL group targets. Each canvas now has a live warp preview drawn in
    // after:render that replaces the hidden originals, so none will go blank.
    warpAllGroups.forEach(({ targets: grpObjs }) =>
        grpObjs.forEach(o => { o._warpWasVisible = o.visible; o.visible = false; })
    );

    // Disable Fabric selection on all canvases (same pattern as eraser).
    canvasData.forEach(d => {
        d.fabricCanvas.selection = false;
        d.fabricCanvas.forEachObject(o => {
            o._prevSelectable = o.selectable;
            o._prevEvented    = o.evented;
            o.selectable      = false;
            o.evented         = false;
        });
        d.fabricCanvas.discardActiveObject();
        d.fabricCanvas.requestRenderAll();
    });
    selectedDesigns.clear();
    refreshFabricHandles();
    updateWindowBorders();
    updateLayerButtons();

    document.getElementById('designWarpBtn').textContent      = 'Exit Warp';
    document.getElementById('warpModeControls').style.display = 'inline-flex';
    document.querySelectorAll('.canvas-wrapper').forEach(w => w.style.cursor = 'crosshair');
}

function exitDesignWarpMode(apply) {
    const applyData  = warpActiveData;
    const applyObjs  = [...warpTargetObjs];          // primary group targets only
    const allGroups  = [...warpAllGroups];            // all groups (primary + secondaries)

    // ── Render all warped results while source canvases / warpPoints are valid ──

    // Primary group: render using the current globals as-is.
    let renderResult = null;
    if (apply && applyData && warpSourceCanvas) {
        renderResult = _renderBicubicWarp();
    }

    // Secondary groups: apply the same warp proportionally scaled to each
    // group's source bounds, so every selected design deforms identically.
    const secondaryResults = [];
    if (apply && allGroups.length > 1) {
        for (let gi = 1; gi < allGroups.length; gi++) {
            const grp       = allGroups[gi];

            // Re-use the same helper that drives the live preview.
            const scaledPts = _scaledWarpPointsForGroup(grp);

            // Temporarily swap globals so _renderBicubicWarp uses secondary data.
            const savedSrc  = warpSourceCanvas, savedPts  = warpPoints;
            const savedBnds = warpSourceBounds,  savedDpr  = warpDPR;
            warpSourceCanvas = grp.sourceCanvas;
            warpPoints       = scaledPts;
            warpSourceBounds = grp.sourceBounds;
            warpDPR          = grp.dpr;
            const grpResult  = _renderBicubicWarp();
            warpSourceCanvas = savedSrc;
            warpPoints       = savedPts;
            warpSourceBounds = savedBnds;
            warpDPR          = savedDpr;

            secondaryResults.push({ ownerData: grp.ownerData, targets: grp.targets, result: grpResult });
        }
    }

    // Restore target object visibility for ALL groups regardless of apply/cancel.
    allGroups.forEach(({ targets: grpObjs }) =>
        grpObjs.forEach(o => {
            o.visible = (o._warpWasVisible !== undefined) ? o._warpWasVisible : true;
            delete o._warpWasVisible;
        })
    );

    // Clear warp state so after:render no longer draws the overlay.
    designWarpMode   = false;
    warpActiveData   = null;
    warpTargetObjs   = [];
    warpPoints       = [];
    warpSourceCanvas = null;
    warpSourceBounds = null;
    warpDragRC       = null;
    warpDPR          = 1;
    warpAllGroups    = [];

    // Restore Fabric interactivity across all canvases.
    canvasData.forEach(d => {
        d.fabricCanvas.selection = true;
        d.fabricCanvas.forEachObject(o => {
            o.selectable = (o._prevSelectable !== undefined) ? o._prevSelectable : true;
            o.evented    = (o._prevEvented    !== undefined) ? o._prevEvented    : true;
            delete o._prevSelectable;
            delete o._prevEvented;
        });
    });
    document.querySelectorAll('.canvas-wrapper').forEach(w => w.style.cursor = '');
    document.getElementById('designWarpBtn').textContent      = 'Warp';
    document.getElementById('warpModeControls').style.display = 'none';

    if (renderResult && applyData) {
        const { canvas: outCanvas, left, top, dpr = 1 } = renderResult;
        const fc   = applyData.fabricCanvas;
        const ps   = applyData.previewScale || 1;
        // outCanvas is at physical-pixel resolution; convert back to CSS space for placement
        const cssW = outCanvas.width  / dpr;
        const cssH = outCanvas.height / dpr;
        const cx   = left + cssW / 2;
        const cy   = top  + cssH / 2;

        // Build the new Fabric image synchronously from the canvas element —
        // no async fromURL, so there is zero gap between removing the originals
        // and displaying the warped result.
        // scaleX/scaleY = 1/dpr so the DPR-resolution image displays at CSS size.
        const newImg = new fabric.Image(outCanvas, {
            left:            cx,
            top:             cy,
            scaleX:          1 / dpr,
            scaleY:          1 / dpr,
            originX:         'center',
            originY:         'center',
            selectable:      true,
            evented:         true,
            transparentCorners: false,
            cornerColor:     'blue',
            cornerStyle:     'circle',
        });

        // Bake the warp into the effects-pipeline source so that moving sliders
        // later starts from the warped result instead of the original image.
        // Reset position/scale/effects so applyWarpToData is an identity pass.
        const isMain    = applyObjs.includes(applyData.designObject);
        const newExtras = (applyData.extraDesignObjects || []).filter(o => !applyObjs.includes(o));

        if (isMain) {
            applyData.designOriginal  = outCanvas;   // warped canvas is the new source
            applyData.warpCanvas      = null;         // force recreation
            applyData.x               = cx;
            applyData.y               = cy;
            // Effective Fabric scale = data.scaleX * previewScale = (1/dpr)/ps * ps = 1/dpr ✓
            applyData.scaleX          = (1 / dpr) / ps;
            applyData.scaleY          = (1 / dpr) / ps;
            applyData.rotation        = 0;
            applyData.warpAmount      = 0;
            applyData.arcAmount       = 0;
            applyData.arcTilt         = 0;
            applyData.perspectiveTop  = 0;
            applyData.perspectiveLeft = 0;
        } else {
            // Extra design object — update its original in extraDesignOriginals
            applyObjs.forEach(obj => {
                const idx = (applyData.extraDesignObjects || []).indexOf(obj);
                if (idx !== -1) {
                    if (!applyData.extraDesignOriginals) applyData.extraDesignOriginals = [];
                    applyData.extraDesignOriginals[idx] = outCanvas;
                }
            });
        }

        // _defaultFx reads from applyData — now returns all-zero warp/perspective
        newImg._ownerData = applyData;
        newImg._fx        = _defaultFx(applyData);

        // Swap old objects for new in one synchronous block so the canvas never
        // shows a frame with no design.
        applyObjs.forEach(obj => fc.remove(obj));
        fc.add(newImg);

        if (isMain) applyData.designObject = newImg;
        newExtras.push(newImg);
        applyData.extraDesignObjects = newExtras;

        attachFabricEvents(applyData, newImg);

        fc.setActiveObject(newImg);
        selectedDesigns.add(newImg);
        fc.requestRenderAll();

        // Apply secondary group results with the same pattern.
        for (const { ownerData: grpData, targets: grpObjs, result: grpResult } of secondaryResults) {
            const { canvas: outCanvas2, left: left2, top: top2, dpr: dpr2 = 1 } = grpResult;
            const grpFc  = grpData.fabricCanvas;
            const grpPs  = grpData.previewScale || 1;
            const cssW2  = outCanvas2.width  / dpr2;
            const cssH2  = outCanvas2.height / dpr2;
            const cx2    = left2 + cssW2 / 2;
            const cy2    = top2  + cssH2 / 2;

            const newImg2 = new fabric.Image(outCanvas2, {
                left: cx2, top: cy2,
                scaleX: 1 / dpr2, scaleY: 1 / dpr2,
                originX: 'center', originY: 'center',
                selectable: true, evented: true,
                transparentCorners: false,
                cornerColor: 'blue', cornerStyle: 'circle',
            });

            const grpIsMain    = grpObjs.includes(grpData.designObject);
            const grpNewExtras = (grpData.extraDesignObjects || []).filter(o => !grpObjs.includes(o));

            if (grpIsMain) {
                grpData.designOriginal  = outCanvas2;
                grpData.warpCanvas      = null;
                grpData.x               = cx2;
                grpData.y               = cy2;
                grpData.scaleX          = (1 / dpr2) / grpPs;
                grpData.scaleY          = (1 / dpr2) / grpPs;
                grpData.rotation        = 0;
                grpData.warpAmount      = 0;
                grpData.arcAmount       = 0;
                grpData.arcTilt         = 0;
                grpData.perspectiveTop  = 0;
                grpData.perspectiveLeft = 0;
            } else {
                grpObjs.forEach(obj => {
                    const idx = (grpData.extraDesignObjects || []).indexOf(obj);
                    if (idx !== -1) {
                        if (!grpData.extraDesignOriginals) grpData.extraDesignOriginals = [];
                        grpData.extraDesignOriginals[idx] = outCanvas2;
                    }
                });
            }

            newImg2._ownerData = grpData;
            newImg2._fx        = _defaultFx(grpData);

            grpObjs.forEach(obj => grpFc.remove(obj));
            grpFc.add(newImg2);

            if (grpIsMain) grpData.designObject = newImg2;
            grpNewExtras.push(newImg2);
            grpData.extraDesignObjects = grpNewExtras;

            attachFabricEvents(grpData, newImg2);

            grpFc.setActiveObject(newImg2);
            selectedDesigns.add(newImg2);
            grpFc.requestRenderAll();
        }

        refreshFabricHandles();
        updateWindowBorders();
        updateLayerButtons();
        syncSliders();
        pushGlobalUndo();
    } else {
        // Cancel — re-render every involved canvas with the restored originals.
        allGroups.forEach(({ ownerData: d }) => d.fabricCanvas.requestRenderAll());
        refreshFabricHandles();
        updateWindowBorders();
        updateLayerButtons();
    }
}

window.addEventListener('mouseup', () => { if (designWarpMode) warpDragRC = null; });

// ── Color layer helpers ──────────────────────────────────────────────────────

function hexToRgb(hex){
    const r = parseInt(hex.slice(1,3), 16);
    const g = parseInt(hex.slice(3,5), 16);
    const b = parseInt(hex.slice(5,7), 16);
    return `${r},${g},${b}`;
}

function initColorLayer(data){
    if(data.colorLayerFabricObj) return;

    const w = data.fabricCanvas.getWidth();
    const h = data.fabricCanvas.getHeight();

    const offscreen = document.createElement('canvas');
    offscreen.width  = w;
    offscreen.height = h;

    data.colorLayerCanvas = offscreen;
    data.colorLayerCtx    = offscreen.getContext('2d');

    const fabricImg = new fabric.Image(offscreen, {
        left: 0, top: 0,
        selectable: false, evented: false,
        originX: 'left', originY: 'top',
        opacity: colorLayerOpacity,
        globalCompositeOperation: colorLayerBlendMode
    });

    data.colorLayerFabricObj = fabricImg;
    data.fabricCanvas.add(fabricImg);

    // Stack: bg first (index 0), color layer next (index 1), designs above
    data.fabricCanvas.sendToBack(fabricImg);
    if(data.backgroundObject) data.fabricCanvas.sendToBack(data.backgroundObject);

    data.colorLayerHistory = [];   // ImageData undo stack

    applyClipMaskToObject(fabricImg, data);
    data.fabricCanvas.requestRenderAll();
}

function pushColorLayerHistory(data){
    if(!data.colorLayerCtx) return;
    const snap = data.colorLayerCtx.getImageData(
        0, 0,
        data.colorLayerCanvas.width,
        data.colorLayerCanvas.height
    );
    if(!data.colorLayerHistory) data.colorLayerHistory = [];
    data.colorLayerHistory.push(snap);
    if(data.colorLayerHistory.length > 30) data.colorLayerHistory.shift();
}

function undoColorLayer(data){
    if(!data.colorLayerHistory || !data.colorLayerHistory.length) return;
    const snap = data.colorLayerHistory.pop();
    data.colorLayerCtx.putImageData(snap, 0, 0);
    data.fabricCanvas.requestRenderAll();
}

// Build a multi-stop radial gradient approximating (1-t)^gamma falloff
// innerR: start of falloff (hard core ends here), outerR: full brush extent
function buildSoftGradient(ctx, x, y, innerR, outerR, rgb, gamma){
    const g = ctx.createRadialGradient(x, y, innerR, x, y, outerR);
    const steps = 10;
    for(let i = 0; i <= steps; i++){
        const t   = i / steps;
        const op  = Math.pow(1 - t, gamma);
        g.addColorStop(t, `rgba(${rgb},${op.toFixed(4)})`);
    }
    return g;
}

function paintDot(ctx, x, y, size, softness, hexColor, compositeOp = 'source-over'){
    ctx.save();
    ctx.globalCompositeOperation = compositeOp;
    // For destination-out (eraser) the colour is irrelevant — only alpha matters
    const rgb = compositeOp === 'destination-out' ? '0,0,0' : hexToRgb(hexColor);

    if(softness <= 0){
        // Fully hard — plain filled circle
        ctx.beginPath();
        ctx.arc(x, y, size, 0, Math.PI * 2);
        ctx.fillStyle = `rgb(${rgb})`;
        ctx.fill();
    } else {
        // softness 1-100:
        //   hardR = hard-core radius (shrinks to 0 at softness=100)
        //   gamma controls how steeply opacity falls in the soft zone:
        //     low softness → gamma ~1 (gentle feather)
        //     high softness → gamma ~4 (very fast fall-off = much softer feel)
        const hardR = size * (1 - softness / 100);
        const gamma = 1 + (softness / 100) * 3;   // 1 → 4 across the range

        const g = buildSoftGradient(ctx, x, y, hardR, size, rgb, gamma);
        ctx.beginPath();
        ctx.arc(x, y, size, 0, Math.PI * 2);
        ctx.fillStyle = g;
        ctx.fill();
    }

    ctx.restore();
}

function updateBrushCursor(nativeEvent, previewScale){
    const ring = document.getElementById('brushCursorRing');
    if(!ring) return;
    // Account for viewport zoom (_vpScale) so the ring matches the on-screen brush size
    const d = Math.max(4, Math.round(brushSize * previewScale * (_vpScale || 1) * 2));
    ring.style.width  = d + 'px';
    ring.style.height = d + 'px';
    ring.style.left   = nativeEvent.clientX + 'px';
    ring.style.top    = nativeEvent.clientY + 'px';
    ring.style.display = 'block';
}

function hideBrushCursor(){
    const ring = document.getElementById('brushCursorRing');
    if(ring) ring.style.display = 'none';
}

// ── Global mousemove handler for the color-layer brush cursor ring ────────────
// More reliable than Fabric's synthetic mouse:move (works even between canvases,
// updates immediately when brush size changes, etc.)
let _colorLayerMoveHandler = null;

function _startColorLayerCursorTracking(){
    if(_colorLayerMoveHandler) return;
    _colorLayerMoveHandler = function(e){
        if(!colorLayerMode){ hideBrushCursor(); return; }
        // Only show ring while over a canvas wrapper that is in color-layer-mode
        const wrapper = e.target && e.target.closest && e.target.closest('.canvas-wrapper.color-layer-mode');
        if(!wrapper){ hideBrushCursor(); return; }
        // Find matching canvasData to get the correct previewScale
        let ps = 1;
        for(let i = 0; i < canvasData.length; i++){
            const el = canvasData[i].fabricCanvas && canvasData[i].fabricCanvas.lowerCanvasEl;
            if(el && el.closest('.canvas-wrapper') === wrapper){
                ps = canvasData[i].previewScale || 1;
                break;
            }
        }
        updateBrushCursor(e, ps);
    };
    document.addEventListener('mousemove', _colorLayerMoveHandler);
}

function _stopColorLayerCursorTracking(){
    if(_colorLayerMoveHandler){
        document.removeEventListener('mousemove', _colorLayerMoveHandler);
        _colorLayerMoveHandler = null;
    }
    hideBrushCursor();
}

// ── Undo / redo engine ────────────────────────────────────────────────────────

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
        designFx: data.designObject?._fx
            ? JSON.parse(JSON.stringify(data.designObject._fx))
            : null,
        duplicates: (data.extraDesignObjects || []).map((obj, i) => ({
            left: obj.left, top: obj.top,
            scaleX: obj.scaleX, scaleY: obj.scaleY,
            angle: obj.angle,
            src:  data.extraDesignOriginals?.[i]?.src ?? null,
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
                  scaleX: s.scaleX, scaleY: s.scaleY, angle: s.angle });
        if(s.fx) obj._fx = JSON.parse(JSON.stringify(s.fx));
        obj.setCoords();
    }

    // Re-create missing objects
    for(let i = (data.extraDesignObjects || []).length; i < targetCount; i++){
        const s = savedDups[i];
        await new Promise(resolve => {
            const build = (imgEl) => {
                const fImg = new fabric.Image(imgEl, {
                    left: s.left, top: s.top,
                    scaleX: s.scaleX, scaleY: s.scaleY,
                    angle: s.angle,
                    selectable: true, evented: true
                });
                fImg._fx = s.fx ? JSON.parse(JSON.stringify(s.fx)) : _defaultFx(data);
                if(s.name) fImg._uploadedDesignName = s.name;

                data.extraDesignObjects  = data.extraDesignObjects  || [];
                data.extraDesignOriginals = data.extraDesignOriginals || [];
                data.extraDesignObjects.push(fImg);
                data.extraDesignOriginals.push(s.src ? { src: s.src } : null);

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

async function restoreWindowState(data, state){
    data.x = state.x;   data.y = state.y;
    data.scale  = state.scale;
    data.scaleX = state.scaleX;  data.scaleY = state.scaleY;
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
    container.style.gridTemplateColumns = `repeat(${_numColumns}, minmax(0, 1fr))`;
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

        // Re-insert the wrapper DOM node at the correct position.
        const refChild = container.children[originalIdx] || null;
        container.insertBefore(data.wrapperEl, refChild);

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
            if(data.wrapperEl.parentNode) data.wrapperEl.parentNode.removeChild(data.wrapperEl);
        }
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

function paintAtNorm(normX, normY){
    const compositeOp = brushTool === 'eraser' ? 'destination-out' : 'source-over';
    activeIndices.forEach(i=>{
        const d = canvasData[i];
        if(!d.colorLayerCtx) return;
        const s = d.previewScale;
        paintDot(d.colorLayerCtx, normX * s, normY * s, brushSize * s, brushSoftness, brushColor, compositeOp);
        d.fabricCanvas.requestRenderAll();
    });
}

function interpolatePaint(fromNorm, toNorm){
    const dx   = toNorm.x - fromNorm.x;
    const dy   = toNorm.y - fromNorm.y;
    const dist = Math.sqrt(dx*dx + dy*dy);
    const step = Math.max(0.5, brushSize * 0.25);
    const n    = Math.max(1, Math.ceil(dist / step));
    for(let i = 1; i <= n; i++){
        const t = i / n;
        paintAtNorm(fromNorm.x + dx*t, fromNorm.y + dy*t);
    }
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







function clearBezierHelpers(canvas){

    activeBezierHelpers.forEach(obj=>{

        if(canvas.getObjects().includes(obj)){
            canvas.remove(obj);
        }
    });

    activeBezierHelpers = [];

    // IMPORTANT:
    // remove ONLY temporary editor helper objects.
    // keep finalized clipping overlays visible
    // while drawing additional polygons.
    canvas.getObjects()
        .filter(obj=>
            obj.excludeFromExport &&
            (
                obj.isBezierHelper ||
                obj.isRubberBand   ||
                // Only remove marching-ants paths that are temporary
                // (live editor preview). Finalized overlays have
                // isTempCurvePreview === false and must stay visible.
                ((obj.isMarchingDark || obj.isMarchingLight || obj.isTempCurvePreview) &&
                  obj.isTempCurvePreview)
            )
        )
        .forEach(obj=>{
            canvas.remove(obj);
        });
}


function drawBezierHelpers(canvas, points){

    clearBezierHelpers(canvas);

    if(points.length >= 2){

        for(let i = 0; i < points.length - 1; i++){

            const p1 = points[i];
            const p2 = points[i + 1];

            // only show straight helper edge
            // if this segment has not been curved yet
            if(
                p1.cx === undefined ||
                p1.cy === undefined
            ){

                const line = new fabric.Line(
                    [p1.x, p1.y, p2.x, p2.y],
                    {
                        stroke:'rgba(180,180,180,0.5)',
                        strokeWidth:0.5,
                        selectable:false,
                        evented:false,
                        excludeFromExport:true,
                        isBezierHelper:true
                    }
                );

                canvas.add(line);
                activeBezierHelpers.push(line);
            }
        }
    }

    points.forEach((point,index)=>{

        const anchor = new fabric.Circle({
            left: point.x,
            top: point.y,
            radius: 2.2,
            fill: 'rgba(230,230,230,0.85)',
            stroke:'rgba(80,80,80,0.7)',
            strokeWidth:0.5,
            originX:'center',
            originY:'center',
            selectable:false,
            evented:false,
            excludeFromExport:true,
            isBezierHelper:true
        });

        canvas.add(anchor);
        activeBezierHelpers.push(anchor);

        const handleLength = 10;

        const leftHandleX = point.x - handleLength;

        const rightHandleX =
            point.cx !== undefined
                ? point.cx
                : point.x + handleLength;

        const leftLine = new fabric.Line(
            [point.x, point.y, leftHandleX, point.y],
            {
                stroke:'rgba(180,180,180,0.35)',
                strokeWidth:0.4,
                selectable:false,
                evented:false,
                excludeFromExport:true,
                isBezierHelper:true
            }
        );

        const rightLine = new fabric.Line(
            [
                point.x,
                point.y,
                rightHandleX,
                point.cy !== undefined
                    ? point.cy
                    : point.y
            ],
            {
                stroke:'rgba(180,180,180,0.5)',
                strokeWidth:0.4,
                selectable:false,
                evented:false,
                excludeFromExport:true,
                isBezierHelper:true
            }
        );

        canvas.add(leftLine);
        canvas.add(rightLine);

        activeBezierHelpers.push(leftLine);
        activeBezierHelpers.push(rightLine);

        const rightHandle = new fabric.Circle({
            left: rightHandleX,
            top:
                point.cy !== undefined
                    ? point.cy
                    : point.y,
            radius:1.4,
            fill:'rgba(255,255,255,0.7)',
            stroke:'rgba(140,140,140,0.7)',
            strokeWidth:0.5,
            originX:'center',
            originY:'center',
            selectable:false,
            evented:false,
            excludeFromExport:true,
            isBezierHelper:true
        });

        rightHandle.pointIndex = index;
        rightHandle.isBezierHandle = true;

        canvas.add(rightHandle);
        activeBezierHelpers.push(rightHandle);
    });
}


// Draws dimmed anchor nodes + curvature handles for every finalized maskPath
// that is NOT the one currently being edited (currentMaskIndex / active clipCurvePoints).
// Called after drawBezierHelpers so their bring-to-front ordering is maintained.
function drawInactivePaths(canvas, data){

    const paths = data.maskPaths || [];

    paths.forEach((path, pathIdx) => {

        // skip the path currently loaded into the editor
        if(
            clipPolygonClosed &&
            currentMaskIndex !== undefined &&
            pathIdx === currentMaskIndex
        ) return;

        if(!path || !path.length) return;

        path.forEach((point, ptIdx) => {

            // anchor dot — blue-tinted to distinguish from active path (white)
            const anchor = new fabric.Circle({
                left:           point.x,
                top:            point.y,
                radius:         2.5,
                fill:           'rgba(140,165,255,0.65)',
                stroke:         'rgba(70,100,210,0.55)',
                strokeWidth:    0.5,
                originX:        'center',
                originY:        'center',
                selectable:     false,
                evented:        false,
                excludeFromExport: true,
                isBezierHelper: true,
                isInactiveClipHelper: true,
                isInactiveAnchor:    true,
                inactivePathIndex:   pathIdx,
                inactivePointIndex:  ptIdx
            });

            canvas.add(anchor);
            activeBezierHelpers.push(anchor);

            // curvature handle + tether line (when curve control exists)
            if(point.cx !== undefined && point.cy !== undefined){

                const line = new fabric.Line(
                    [point.x, point.y, point.cx, point.cy],
                    {
                        stroke:         'rgba(120,145,235,0.35)',
                        strokeWidth:    0.5,
                        selectable:     false,
                        evented:        false,
                        excludeFromExport: true,
                        isBezierHelper: true,
                        isInactiveClipHelper: true
                    }
                );
                canvas.add(line);
                activeBezierHelpers.push(line);

                const handle = new fabric.Circle({
                    left:           point.cx,
                    top:            point.cy,
                    radius:         1.6,
                    fill:           'rgba(185,200,255,0.6)',
                    stroke:         'rgba(90,115,215,0.5)',
                    strokeWidth:    0.4,
                    originX:        'center',
                    originY:        'center',
                    selectable:     false,
                    evented:        false,
                    excludeFromExport: true,
                    isBezierHelper: true,
                    isInactiveClipHelper: true
                });
                canvas.add(handle);
                activeBezierHelpers.push(handle);
            }
        });
    });
}


function buildCurvePathString(points, closed = true){

    if(!points.length){
        return "";
    }

    let path = `M ${points[0].x} ${points[0].y}`;

    for(let i = 1; i < points.length; i++){

        const prev = points[i - 1];
        const current = points[i];

        // straight line by default
        if(
            prev.cx === undefined ||
            prev.cy === undefined
        ){

            path += ` L ${current.x} ${current.y}`;

        } else {

            path += ` Q ${prev.cx} ${prev.cy} ${current.x} ${current.y}`;
        }
    }

    if(closed && points.length >= 3){

        const last = points[points.length - 1];
        const first = points[0];

        if(
            last.cx === undefined ||
            last.cy === undefined
        ){

            path += ` L ${first.x} ${first.y} Z`;

        } else {

            path += ` Q ${last.cx} ${last.cy} ${first.x} ${first.y} Z`;
        }
    }

    return path;
}

// Returns [darkPath, lightPath] — two overlapping dashed paths that together
// create Photoshop polygon-lasso "marching ants": black and white dashes
// interleaved so the outline is visible on any background colour.
// The animation loop (startMarchingAnts) scrolls strokeDashOffset over time.
function createCurveOverlay(
    points,
    closed = false,
    isTemporary = true
){
    const pathStr = buildCurvePathString(points, closed);

    const common = {
        fill:             'rgba(0,0,0,0)',
        strokeWidth:      1,
        strokeDashArray:  [4, 4],
        selectable:       false,
        evented:          false,
        excludeFromExport:true,
        isTempCurvePreview: isTemporary,
        objectCaching:    false
    };

    // dark layer — black dashes
    const dark = new fabric.Path(pathStr, {
        ...common,
        stroke:           'rgba(0,0,0,0.85)',
        strokeDashOffset: _marchingAntsOffset,
        isMarchingDark:   true
    });

    // light layer — white dashes, offset by half the dash cycle so they
    // fill the gaps left by the dark dashes
    const light = new fabric.Path(pathStr, {
        ...common,
        stroke:           'rgba(255,255,255,0.92)',
        strokeDashOffset: (_marchingAntsOffset + 4) % 8,
        isMarchingLight:  true
    });

    return [dark, light];
}


function startMarchingAnts(){
    if(_marchingAntsTimer) return;

    _marchingAntsTimer = setInterval(()=>{

        _marchingAntsOffset = (_marchingAntsOffset + 1) % 8;

        canvasData.forEach(data=>{
            if(!data.fabricCanvas) return;

            let dirty = false;

            data.fabricCanvas.getObjects().forEach(obj=>{

                if(obj.isMarchingDark){
                    obj.strokeDashOffset = _marchingAntsOffset;
                    dirty = true;
                }

                if(obj.isMarchingLight){
                    obj.strokeDashOffset = (_marchingAntsOffset + 4) % 8;
                    dirty = true;
                }
            });

            if(dirty) data.fabricCanvas.requestRenderAll();
        });

    }, 80);
}


function stopMarchingAnts(){
    if(_marchingAntsTimer){
        clearInterval(_marchingAntsTimer);
        _marchingAntsTimer = null;
    }
}



function applyClipMaskToObject(obj, data){

    if(!obj) return;

    if(
        data.maskEnabled &&
        data.maskPath &&
        data.maskType === "bezier"
    ){

        const paths = (data.maskPaths || [data.maskPath])
            .filter(Boolean)
            .map(points=>
                new fabric.Path(
                    buildCurvePathString(points, true),
                    {
                        absolutePositioned:true,
                        originX:'left',
                        originY:'top'
                    }
                )
            );

        obj.clipPath = new fabric.Group(paths,{
            absolutePositioned:true
        });

    } else {

        obj.clipPath = null;
    }
}





function addClipOverlay(data){

    if(data.clipOverlays){

        data.clipOverlays.forEach(overlay=>{
            data.fabricCanvas.remove(overlay);
        });
    }

    data.clipOverlays = [];

    if(
        !data.maskEnabled ||
        data.maskType !== "bezier"
    ){
        return;
    }

    const allMasks =
        data.maskPaths?.length
            ? data.maskPaths
            : (data.maskPath ? [data.maskPath] : []);

    if(!allMasks.length){
        return;
    }

    // restore editor state using latest polygon only
    const latestMask =
        allMasks[allMasks.length - 1];

    data.clipCurvePoints = JSON.parse(
        JSON.stringify(latestMask)
    );

    data.clipPolygonClosed = true;

    allMasks.forEach(path=>{

        const overlays =
            createCurveOverlay(
                path,
                true,
                false
            );

        overlays.forEach(o=>{
            data.clipOverlays.push(o);
            data.fabricCanvas.add(o);
            o.bringToFront();
        });
    });

    if(data.designObject){
        data.designObject.bringToFront();
    }
}




// Creates a default _fx settings bag from the window-level data object.
// Used to initialise a design object's per-object effects on first use.
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
    let warped;
    if( !warpDirty          &&
        obj._c_perspT  === perspT   &&
        obj._c_perspL  === perspL   &&
        obj._c_perspLQ === lowQuality &&
        obj._c_persp){
        warped = obj._c_persp;
    } else {
        warped = applyPerspectiveDistortion(obj._warpCanvas, fx, lowQuality, trimmed);
        obj._c_perspT  = perspT;
        obj._c_perspL  = perspL;
        obj._c_perspLQ = lowQuality;
        obj._c_persp   = warped;
    }

    const prevLeft   = obj.left;
    const prevTop    = obj.top;
    const prevScaleX = obj.scaleX;
    const prevScaleY = obj.scaleY;
    const prevAngle  = obj.angle;

    obj.setElement(warped);
    applyClipMaskToObject(obj, data);

    obj.set({
        left:   prevLeft,
        top:    prevTop,
        scaleX: prevScaleX,
        scaleY: prevScaleY,
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

        applyClipMaskToObject(data.designObject, data);

        data.designObject.set({
            left: data.x,
            top: data.y,
            angle: data.rotation,
            scaleX: (data.scaleX || data.scale) * data.previewScale,
            scaleY: (data.scaleY || data.scale) * data.previewScale,
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
let _sliderRAFId = null;

function updateFromSliders(event){

    if(clipEditMode){ showClipModeNotice(); return; }
    if(!activeIndices.length) return;

    if(event?.target?.id) activeSliderType = event.target.id;

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
let _bgAdjUndoLocked = false;
[bgHue, bgSaturation, bgBrightness, bgContrast].forEach(el => {
    el.addEventListener('mousedown', () => {
        if(!_bgAdjUndoLocked){ _bgAdjUndoLocked = true; pushGlobalUndo(); }
    });
    el.addEventListener('mouseup', () => { _bgAdjUndoLocked = false; });
    el.addEventListener('input', _updateBgAdjust);
});
document.getElementById('bgAdjustResetBtn').addEventListener('click', () => {
    if(!activeIndices.length) return;
    if(activeIndices.every(i => canvasData[i].locked)) return;
    pushGlobalUndo();
    bgHue.valueAsNumber = 0; bgSaturation.valueAsNumber = 0;
    bgBrightness.valueAsNumber = 0; bgContrast.valueAsNumber = 0;
    _updateBgAdjust();
});

// BG crop sliders
let _bgCropUndoLocked = false;
[bgCropRotation, bgCropScale, bgCropX, bgCropY].forEach(el => {
    el.addEventListener('mousedown', () => {
        if(!_bgCropUndoLocked){ _bgCropUndoLocked = true; pushGlobalUndo(); }
    });
    el.addEventListener('mouseup', () => { _bgCropUndoLocked = false; });
    el.addEventListener('input', _updateBgCrop);
});

document.querySelectorAll('.bg-aspect-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        if(!activeIndices.length) return;
        if(activeIndices.every(i => canvasData[i].locked)) return;
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
    if(activeIndices.every(i => canvasData[i].locked)) return;
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
    if(activeIndices.every(i => canvasData[i].locked)) return;
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

const _patternSliderDefs = [
    ['patternHSpacing','hSpacing'],
    ['patternVSpacing','vSpacing'],
    ['patternAngle',   'angle'],
    ['patternHOffset', 'hOffset'],
    ['patternRotH',    'rotH'],
    ['patternRotV',    'rotV'],
];
let _patternUndoLocked = false;
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
    const bgCount      = document.getElementById('bgCount');
    const designCount  = document.getElementById('designCount');

    // If windows already exist (e.g. added via Add Window) never show overlays
    if(canvasData.length > 0){
        dropZone.style.display     = 'none';
        designPrompt.style.display = 'none';
    } else if(backgrounds.length === 0){
        dropZone.style.display     = 'flex';
        designPrompt.style.display = 'none';
    } else if(designs.length === 0){
        dropZone.style.display     = 'none';
        designPrompt.style.display = 'flex';
    } else {
        dropZone.style.display     = 'none';
        designPrompt.style.display = 'none';
    }

    bgCount.textContent     = backgrounds.length > 0
        ? `${backgrounds.length} background${backgrounds.length !== 1 ? 's' : ''}`
        : '';
    designCount.textContent = designs.length > 0
        ? `${designs.length} design${designs.length !== 1 ? 's' : ''}`
        : '';
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

        // future masking support
        maskPaths:
            backgroundMaskTemplates[bgObj.name]?.maskPaths || [],

        maskPath:
            backgroundMaskTemplates[bgObj.name]?.maskPath || null,

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

            const realWidth = data.bg.width;
            const realHeight = data.bg.height;

            const containerWidth = container.clientWidth;
            const gapSpace = _colGap * (_numColumns - 1);
            const availableWidth = containerWidth - gapSpace - 40;

            const targetColumnWidth =
                Math.max(100, Math.min(420, availableWidth / _numColumns));

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

                        const start = Math.min(lastSelectedIndex, index);
                        const end = Math.max(lastSelectedIndex, index);

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

                    lastSelectedIndex = index;

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

                    lastSelectedIndex = index;

                // Normal click = if window already selected keep group; else single-select
                } else {

                    lastSelectedIndex = index;

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
                    lastSelectedIndex = index;
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
                // Plain click on a design object.
                // Within the already-active window: add to the current selection so the
                // user can freely accumulate any number of designs/layers without needing
                // a modifier key.  Clicking in a different window starts fresh.
                if(!selectedDesigns.has(target)){
                    const clickingInActiveWindow = activeIndices.includes(winIdx);
                    if(!clickingInActiveWindow){
                        // Different window — clear and start fresh
                        selectedDesigns.clear();
                        if(winIdx !== -1) activeIndices = [winIdx];
                    }
                    if(!target._fx) target._fx = _defaultFx(data);
                    selectedDesigns.add(target);
                    refreshFabricHandles();
                    updateWindowBorders();
                    updateLayerButtons();
                    syncSliders();
                }
                // else: already selected — Fabric handles active object naturally.
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
        });

        // Design-layer eraser mouse handlers — active only when designEraserMode is true.
        // Objects are made non-selectable on entry so clicks go straight to these handlers.
        data.fabricCanvas.on('mouse:down', (opt) => {
            if (!designEraserMode) return;
            designEraserDown = true;
            applyDesignEraserAt(data, data.fabricCanvas.getPointer(opt.e));
        });
        data.fabricCanvas.on('mouse:move', (opt) => {
            if (!designEraserMode || !designEraserDown) return;
            applyDesignEraserAt(data, data.fabricCanvas.getPointer(opt.e));
        });
        data.fabricCanvas.on('mouse:up', () => {
            if (designEraserMode) designEraserDown = false;
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
        autoSaveSession();
    });
}


let allSelected = false;

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

    if(selectedDesigns.size > 0){
        del.style.display       = "block";
        dup.style.display       = "block";
        invertBtn.style.display = "block";
    } else {
        del.style.display       = "none";
        dup.style.display       = "none";
        invertBtn.style.display = "none";
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
            ? (n === 1 ? "1 window selected" : `${n} windows selected`)
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
                const start = Math.min(lastSelectedIndex, index);
                const end   = Math.max(lastSelectedIndex, index);
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
            lastSelectedIndex = index;
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
            lastSelectedIndex = index;
        } else {
            lastSelectedIndex = index;
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

        if(e.shiftKey) lastSelectedIndex = index;

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
                    setTimeout(() => applyWarpToData(newData, false), 50);
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
    lastSelectedIndex = newIndices[newIndices.length - 1] ?? null;
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
            maskPaths:             backgroundMaskTemplates[file.name]?.maskPaths || [],
            maskPath:              backgroundMaskTemplates[file.name]?.maskPath  || null,
            maskEnabled:           backgroundMaskTemplates[file.name]?.maskEnabled || false,
            maskType:              backgroundMaskTemplates[file.name]?.maskType   || null,
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

        const realWidth  = bgImg.width;
        const realHeight = bgImg.height;
        const containerWidth    = container.clientWidth;
        const gapSpace          = _colGap * (_numColumns - 1);
        const availableWidth    = containerWidth - gapSpace - 40;
        const targetColumnWidth = Math.max(100, Math.min(420, availableWidth / _numColumns));
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
        lastSelectedIndex = 0;
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
                    setTimeout(() => applyWarpToData(data, false), 50);
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
        setTimeout(() => applyWarpToData(data, false), 50);
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

// ── Copy / Paste Transforms ────────────────────────────────────────────────────
let _copiedTransforms = null;

function _captureTransforms(data){
    const obj = data.designObject;
    const ps  = data.previewScale || 1;
    return {
        x:        obj ? obj.left          : data.x,
        y:        obj ? obj.top           : data.y,
        scale:    data.scale,
        scaleX:   obj ? (obj.scaleX / ps) : (data.scaleX ?? data.scale),
        scaleY:   obj ? (obj.scaleY / ps) : (data.scaleY ?? data.scale),
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
    data.x           = t.x;
    data.y           = t.y;
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
    data.flipX       = t.flipX;
    data.flipY       = t.flipY;
    data._flipMap    = null;
    if(data.designObject && t.designFx){
        data.designObject._fx = JSON.parse(JSON.stringify(t.designFx));
    }
    applyWarpToData(data, false);
}

document.getElementById('copyTransformsBtn').addEventListener('click', () => {
    const srcIdx = lastSelectedIndex ?? activeIndices[activeIndices.length - 1] ?? null;
    if(srcIdx === null) return;
    const data = canvasData[srcIdx];
    if(!data) return;
    _copiedTransforms = _captureTransforms(data);
    // Visual feedback on the button
    const btn = document.getElementById('copyTransformsBtn');
    btn.textContent = '✓ Copied';
    setTimeout(() => { btn.textContent = 'Copy Transforms'; }, 1400);
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
document.getElementById("warpApplyBtn").addEventListener("click", () => exitDesignWarpMode(true));
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

    // always hide the "to selected" button when toggling clip mode
    document.getElementById("copyClipToSelectedBtn").style.display = "none";

    // reset copy-select state when exiting clip mode
    if(!clipEditMode){
        clipCopySelectMode = false;
        clipCopySourceIndex = null;
    }

    // exiting clip mode
    if(!clipEditMode){

        stopMarchingAnts();

        activeClipWindowIndex = null;

        // Restore interactivity on all design objects
        canvasData.forEach(data=>{
            getAllDesignObjects(data).forEach(o=>{
                if(!o) return;
                o.selectable = (o._prevSelectable !== undefined) ? o._prevSelectable : true;
                o.evented    = (o._prevEvented    !== undefined) ? o._prevEvented    : true;
                delete o._prevSelectable;
                delete o._prevEvented;
            });
        });

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

    // Lock all design objects so they can't be accidentally moved/transformed
    canvasData.forEach(data=>{
        getAllDesignObjects(data).forEach(o=>{
            if(!o) return;
            o._prevSelectable = o.selectable;
            o._prevEvented    = o.evented;
            o.selectable      = false;
            o.evented         = false;
        });
        data.fabricCanvas.discardActiveObject();
        data.fabricCanvas.requestRenderAll();
    });

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

        // Lock all design objects so they can't be accidentally moved/transformed
        canvasData.forEach(data=>{
            getAllDesignObjects(data).forEach(o=>{
                if(!o) return;
                o._prevSelectable = o.selectable;
                o._prevEvented    = o.evented;
                o.selectable      = false;
                o.evented         = false;
            });
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

        // Restore interactivity on all design objects
        canvasData.forEach(data=>{
            getAllDesignObjects(data).forEach(o=>{
                if(!o) return;
                o.selectable = (o._prevSelectable !== undefined) ? o._prevSelectable : true;
                o.evented    = (o._prevEvented    !== undefined) ? o._prevEvented    : true;
                delete o._prevSelectable;
                delete o._prevEvented;
            });
        });

        refreshFabricHandles();

        document.querySelectorAll('.canvas-wrapper')
            .forEach(w=> w.classList.remove('color-layer-mode'));

        document.getElementById("addColorLayerBtn").innerText       = "Add Color Layer";
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
                maskPaths: target.maskPaths,
                maskPath: finalizedMask
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
        if(!activeIndices.includes(index)) return;

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
        if(!activeIndices.includes(index)) return;

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
let _exportFormat  = 'png';   // 'png' | 'jpeg'
let _exportQuality = 0.92;    // 0–1, only used for jpeg

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

        popover.hidden = true;
        goBtn.textContent = 'Exporting…';
        goBtn.disabled = true;

        // --- Path A: File System Access API (Chrome/Edge) ---
        if(typeof window.showDirectoryPicker === 'function'){
            let dirHandle;
            try{ dirHandle = await window.showDirectoryPicker(); }
            catch(err){ goBtn.textContent = 'Export'; goBtn.disabled = false; return; }

            for(const index of indices){
                const data = canvasData[index];
                const blob = await exportDataToBlob(data, _exportFormat, _exportQuality);
                const fh   = await dirHandle.getFileHandle(data.filename + '.' + ext, { create: true });
                const wr   = await fh.createWritable();
                await wr.write(blob);
                await wr.close();
            }
            alert('Exported ' + indices.length + ' file(s)!');
        } else {
            // --- Path B: fallback <a download> ---
            for(const index of indices){
                const data = canvasData[index];
                const blob = await exportDataToBlob(data, _exportFormat, _exportQuality);
                const url  = URL.createObjectURL(blob);
                const a    = document.createElement('a');
                a.href     = url;
                a.download = data.filename + '.' + ext;
                a.click();
                await new Promise(r => setTimeout(r, 150));
                URL.revokeObjectURL(url);
            }
        }

        goBtn.textContent = 'Export';
        goBtn.disabled = false;
    });
})();

document.getElementById("undoBtn").addEventListener("click", () => performGlobalUndo());
document.getElementById("redoBtn").addEventListener("click", () => performGlobalRedo());



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

            designSrc: data.designOriginal ? data.designOriginal.src : null,
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

                angle: obj.angle,

                // Uploaded designs store their own image source so they
                // survive save/restore independently of the main design.
                src:  data.extraDesignOriginals?.[i]?.src  ?? null,
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


let _autoSaveTimer = null;

// ── Unsaved changes indicator ─────────────────────────────────────────────────
let _unsaved = false;

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

    container.innerHTML = "";
    canvasData = [];
    activeIndices = [];

    // rebuild source asset pools so future uploads
    // can multiply/populate correctly after JSON load
    backgrounds = [];
    designs = [];

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

        const realWidth = bgImg.width;

        const containerWidth = container.clientWidth;

        const gapSpace = _colGap * (_numColumns - 1);
        const availableWidth = containerWidth - gapSpace - 40;
        const targetColumnWidth =
            Math.max(100, Math.min(420, availableWidth / _numColumns));

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

                        img.onload = ()=>{

                            const fabricImg = new fabric.Image(img, {
                                left: dup.left * previewScale,
                                top:  dup.top  * previewScale,
                                scaleX: dup.scaleX * previewScale,
                                scaleY: dup.scaleY * previewScale,
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

                                scaleX:
                                    dup.scaleX * previewScale,

                                scaleY:
                                    dup.scaleY * previewScale,

                                angle: dup.angle,

                                opacity:
                                    dup.opacity ?? data.opacity,

                                globalCompositeOperation: _blendToGCO(dup.blendMode)
                            });

                            cloned._fx = dup.fx || _defaultFx(data);

                            data.extraDesignOriginals = data.extraDesignOriginals || [];
                            data.extraDesignOriginals.push(null);

                            data.extraDesignObjects.push(cloned);

                            fabricCanvas.add(cloned);

                            attachFabricEvents(data, cloned);

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

                        const start = Math.min(lastSelectedIndex, index);
                        const end = Math.max(lastSelectedIndex, index);

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

                    lastSelectedIndex = index;

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

                    lastSelectedIndex = index;

                // Normal click = if window already selected keep group; else single-select
                } else {

                    lastSelectedIndex = index;

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
                    lastSelectedIndex = index;
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
    if(activeIndices.length) lastSelectedIndex = activeIndices[activeIndices.length - 1];
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

        const data     = JSON.parse(e.target.result);
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

let _vpScale = 1;
let _vpX     = 0;
let _vpY     = 0;
let _vpPanning    = false;
let _vpPanStart   = null;
let _vpPanMoved   = false;
let _vpSpaceDown  = false;
let _activeTool   = null;  // null | 'select' | 'pan' | 'text'

let _textBoxes = [];  // { id, x, y, w, h, content, el }
let _tbNextId  = 1;

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
const _MM_W   = 180;   // minimap canvas width  (px)
const _MM_HMAX = 150;  // minimap canvas max height (px)
const _MM_PAD  = 6;    // inner padding

let _minimapRaf = false;
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
            `repeat(${_numColumns}, minmax(0, 1fr))`;
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
            lastSelectedIndex = newIndices[newIndices.length - 1] ?? null;
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
        container.style.gridTemplateColumns = `repeat(${_numColumns}, minmax(0, 1fr))`;
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
        const lastSelData     = lastSelectedIndex !== null ? oldCanvasData[lastSelectedIndex] : null;

        const wrappers = [...container.querySelectorAll('.canvas-wrapper')];
        canvasData = wrappers.map(w => oldCanvasData.find(d => d.wrapperEl === w));

        // ── 3. Remap active indices to new positions ───────────────────────────
        activeIndices     = selectedDatas.map(d => canvasData.indexOf(d)).filter(i => i !== -1);
        lastSelectedIndex = lastSelData ? canvasData.indexOf(lastSelData) : null;

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
