let backgrounds = [];
let designs = [];
let canvasData = [];
let activeIndices = [];
let clipCopySelectMode = false;   // true while user is picking copy targets
let clipCopySourceIndex = null;   // which window the clipping will be copied FROM

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


document.addEventListener('mouseup', ()=>{
    setTimeout(()=>{
        suppressNextWrapperClick = false;
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


function applyPerspectiveDistortion(sourceCanvas, data){

    const top = data.perspectiveTop || 0;
    const left = data.perspectiveLeft || 0;

    if(
        top === 0 &&        left === 0 &&
        false
    ){
        return sourceCanvas;
    }

    const srcW = sourceCanvas.width;
    const srcH = sourceCanvas.height;

    const out = document.createElement('canvas');
    const ctx = out.getContext('2d');

    // Compute minimum padding to prevent clipping when perspective
    // values go negative (image expands beyond the canvas edge).
    // Keep 420 as the floor so zero/positive values are unchanged.
    const hPadNeeded = top < 0
        ? Math.ceil(srcW * (-top) / 360)
        : 0;
    const leftDenom = 360 - 2 * Math.abs(left);
    const vPadNeeded = (left < 0 && leftDenom > 0)
        ? Math.ceil(srcH * (-left) / leftDenom)
        : 0;
    // 420px floor was massively oversized — it created 840px of empty transparent
    // space around every design regardless of actual perspective values, making
    // Fabric handles expand far beyond the design. Dynamic formulas already compute
    // the exact needed padding; keep only a small 20px safety margin as the floor.
    const pad = Math.max(hPadNeeded, vPadNeeded, 20);

    out.width = srcW + (pad * 2);
    out.height = srcH + (pad * 2);

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "medium";

    // horizontal slices = top/bottom perspective
    const horizontalSlices = 180;

    for(let y = 0; y < horizontalSlices; y++){

        const t = y / (horizontalSlices - 1);

        const srcY = t * srcH;
        const sliceH = Math.max(2, srcH / horizontalSlices);

        // preserve original top-perspective behaviour:
        // affect ONLY the top slices instead of
        // uniformly scaling the whole image
        const topScale =
            1 - (top / 180);

        const widthScale =
            topScale + ((1 - topScale) * t);

        const targetW =
            srcW * widthScale;

        const dx =
            pad +
            ((out.width - (pad * 2) - targetW) / 2);

        const dy =
            pad + srcY;

        ctx.drawImage(
            sourceCanvas,
            0,
            Math.round(srcY),
            srcW,
            Math.ceil(sliceH),
            Math.round(dx),
            Math.round(dy),
            Math.ceil(targetW + 1),
            Math.ceil(sliceH + 1)
        );
    }

    // LEFT / RIGHT perspective pass
    // done AFTER top/bottom so they stay independent

    if(left !== 0){

        const tempCanvas = document.createElement('canvas');
        const tempCtx = tempCanvas.getContext('2d');

        tempCanvas.width = out.width;
        tempCanvas.height = out.height;

        tempCtx.drawImage(out, 0, 0);

        ctx.clearRect(0, 0, out.width, out.height);

        const verticalSlices = 180;

        for(let x = 0; x < verticalSlices; x++){

            const t = x / (verticalSlices - 1);

            const srcX = t * out.width;
            const sliceW = Math.max(2, out.width / verticalSlices);

            // LEFT affects ONLY left side
            const leftScale =
                1 - ((left / 180) * (1 - t));

            const heightScale = leftScale;

            const targetH =
                out.height * heightScale;

            // anchor expansion from center while
            // preserving full visible bounds
            const extraSpace =
                targetH - out.height;

            const dy =
                -(extraSpace / 2);

            ctx.drawImage(
                tempCanvas,
                Math.round(srcX),
                0,
                Math.ceil(sliceW),
                out.height,
                Math.round(srcX),
                Math.round(dy),
                Math.ceil(sliceW + 1),
                Math.ceil(targetH + 1)
            );
        }
    }

    return out;
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
        const tiltK = (arcTiltAmount / 100) * img.height * 0.18 * (1 - nx * nx);

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
                // Design-select mode: highlight windows that contain a selected object
                // OR windows in activeIndices (their designs move too via the sync handlers)
                const hasSelected = d && (
                    (d.designObject && selectedDesigns.has(d.designObject)) ||
                    (d.extraDesignObjects||[]).some(obj => selectedDesigns.has(obj))
                );
                if(hasSelected) w.classList.add("active");
            } else if(activeIndices.includes(i)){
                w.classList.add("active");
            }
        });
}

function getAllDesignObjects(data){
    const objs = [];
    if(data.designObject) objs.push(data.designObject);
    if(data.extraDesignObjects){
        objs.push(...data.extraDesignObjects);
    }
    // Color layer lives between bg and designs; include it so clipping updates apply to it too
    if(data.colorLayerFabricObj) objs.push(data.colorLayerFabricObj);
    return objs;
}

// ── Design-layer eraser ──────────────────────────────────────────────────────

// Ensure a fabric.Image's underlying element is a writable canvas so we can
// draw destination-out circles directly onto the pixel data.
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

// Apply the eraser at a canvas-space point to all design objects in one window.
function applyDesignEraserAt(data, pointer) {
    const targets = [];
    if (data.designObject)       targets.push(data.designObject);
    if (data.extraDesignObjects) targets.push(...data.extraDesignObjects);
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
    const d = Math.round(brushSize * previewScale * 2);
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

// ── Undo / redo engine ────────────────────────────────────────────────────────

function captureWindowState(data){
    return {
        x: data.x, y: data.y,
        scale: data.scale, scaleX: data.scaleX, scaleY: data.scaleY,
        rotation: data.rotation,
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

    if(data.designObject){
        data.designObject._fx = state.designFx
            ? JSON.parse(JSON.stringify(state.designFx)) : null;
        data.designObject.set({
            left:  state.x,  top: state.y,
            angle: state.rotation,
            scaleX: (state.scaleX ?? state.scale) * data.previewScale,
            scaleY: (state.scaleY ?? state.scale) * data.previewScale,
            opacity: state.opacity ?? 1,
            globalCompositeOperation:
                state.blendMode === 'multiply' ? 'multiply'
                : state.blendMode === 'screen'  ? 'screen'
                : 'source-over'
        });
    }

    await applyWarpToData(data, false);

    data.maskEnabled = state.maskEnabled;
    data.maskType    = state.maskType;
    data.maskPath    = state.maskPath  ? JSON.parse(JSON.stringify(state.maskPath))  : null;
    data.maskPaths   = JSON.parse(JSON.stringify(state.maskPaths || []));
    getAllDesignObjects(data).forEach(obj => applyClipMaskToObject(obj, data));
    addClipOverlay(data);

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

    data.fabricCanvas.discardActiveObject();
    data.fabricCanvas.requestRenderAll();
}

function pushGlobalUndo(){
    if(!canvasData.length || !activeIndices.length) return;
    const affected = [...activeIndices];
    globalUndoStack.push({
        affected,
        states: affected.map(i => captureWindowState(canvasData[i]))
    });
    if(globalUndoStack.length > MAX_UNDO_HISTORY) globalUndoStack.shift();
    globalRedoStack = [];
    updateUndoRedoButtons();
}

async function performGlobalUndo(){
    if(!globalUndoStack.length) return;
    const entry = globalUndoStack.pop();
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
            warpAmount.value    = fx.warpAmount    || 0;
            arcAmount.value     = fx.arcAmount     || 0;
            arcTilt.value       = fx.arcTilt       || 0;
            opacityAmount.value = Math.round((fx.opacity ?? 1) * 100);
            blurAmount.value    = fx.blurAmount    || 0;
            noiseAmount.value   = fx.noiseAmount   || 0;
            perspectiveTop.value  = fx.perspectiveTop  || 0;
            perspectiveLeft.value = fx.perspectiveLeft || 0;
            blendMode.value       = fx.blendMode       || "normal";
            return;
        }
    }

    const obj = data.designObject;

    if(!obj) return;

    warpAmount.value = data.warpAmount || 0;
    arcAmount.value = data.arcAmount || 0;
    arcTilt.value = data.arcTilt || 0;
    opacityAmount.value = Math.round((data.opacity ?? 1) * 100);
    blurAmount.value  = data.blurAmount  || 0;
    noiseAmount.value = data.noiseAmount || 0;
    perspectiveTop.value = data.perspectiveTop || 0;
    perspectiveLeft.value = data.perspectiveLeft || 0;
    blendMode.value = data.blendMode || "normal";

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

    const blurred    = applyGaussianBlurToImage(srcOriginal, (fx.blurAmount||0)/5);
    const noisy      = applyNoiseToImage(blurred, fx.noiseAmount||0);
    const warpedBase = createWarpedImage(
        noisy,
        fx.warpAmount    ||0,
        fx.arcAmount     ||0,
        fx.arcTilt       ??0,
        obj._warpCanvas,
        lowQuality
    );
    const warped = applyPerspectiveDistortion(warpedBase, fx);

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
        globalCompositeOperation:
            fx.blendMode === 'multiply' ? 'multiply'
            : fx.blendMode === 'screen'  ? 'screen'
            : 'source-over'
    });
}


async function applyWarpToData(data, lowQuality = false){

    if(!data.designOriginal) return;

    if(!data.warpCanvas){
        data.warpCanvas = document.createElement("canvas");
    }

    const blurredSource = applyGaussianBlurToImage(
        data.designOriginal,
        (data.blurAmount || 0) / 5
    );

    // Noise is applied after blur (so grain isn't softened) but before warp
    // (so it rides along with the texture distortion, matching PS behaviour).
    const noisySource = applyNoiseToImage(blurredSource, data.noiseAmount || 0);

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
        data
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
            globalCompositeOperation:
                data.blendMode === 'multiply'
                    ? 'multiply'
                    : data.blendMode === 'screen'
                        ? 'screen'
                        : 'source-over'
        });

        if(data.extraDesignObjects?.length){

            data.extraDesignObjects.forEach((obj, i)=>{

                // Each extra object uses its own _fx (set in design mode).
                // Uploads have their own source image; clones fall back to the
                // main design's source so the full pipeline runs from scratch.
                const srcForObj =
                    data.extraDesignOriginals?.[i] || data.designOriginal;

                _applyWarpToOneObject(obj, data, srcForObj, lowQuality);
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
        globalCompositeOperation:
            data.blendMode === 'multiply'
                ? 'multiply'
                : data.blendMode === 'screen'
                    ? 'screen'
                    : 'source-over',
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

    const rect = el.getBoundingClientRect();

    return (
        rect.bottom >= 0 &&
        rect.top <= window.innerHeight + 300
    );
}


function updateFromSliders(event){

    if(clipEditMode){
        showClipModeNotice();
        return;
    }

    if(!activeIndices.length) return;

    activeSliderType =
        event?.target?.id || activeSliderType;

    // ── Apply _fx to ALL selected design objects at once ──────────────────────
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

        const requiresWarpObjs =
            activeSliderType === "warpAmount"     ||
            activeSliderType === "arcAmount"      ||
            activeSliderType === "arcTilt"        ||
            activeSliderType === "blurAmount"     ||
            activeSliderType === "noiseAmount"    ||
            activeSliderType === "perspectiveTop" ||
            activeSliderType === "perspectiveLeft";

        selectedDesigns.forEach(obj => {
            const d = obj._ownerData;
            if(!d) return;

            obj._fx = { ...newFx };

            // Also mirror into data.* for main design so applyWarpToData stays in sync
            if(obj === d.designObject){
                d.warpAmount    = newFx.warpAmount;
                d.arcAmount     = newFx.arcAmount;
                d.arcTilt       = newFx.arcTilt;
                d.perspectiveTop  = newFx.perspectiveTop;
                d.perspectiveLeft = newFx.perspectiveLeft;
                d.opacity       = newFx.opacity;
                d.blurAmount    = newFx.blurAmount;
                d.noiseAmount   = newFx.noiseAmount;
                d.blendMode     = newFx.blendMode;
            }

            if(!requiresWarpObjs){
                obj.set({
                    opacity: newFx.opacity,
                    globalCompositeOperation:
                        newFx.blendMode === 'multiply' ? 'multiply'
                        : newFx.blendMode === 'screen'  ? 'screen'
                        : 'source-over'
                });
                d.fabricCanvas.requestRenderAll();
                return;
            }

            const isMain      = obj === d.designObject;
            const extraIdx    = isMain ? -1 : (d.extraDesignObjects||[]).indexOf(obj);
            const srcOriginal = isMain
                ? d.designOriginal
                : (d.extraDesignOriginals?.[extraIdx] || d.designOriginal);

            if(!srcOriginal) return;
            _applyWarpToOneObject(obj, d, srcOriginal, true);
            d.fabricCanvas.requestRenderAll();
        });

        if(requiresWarpObjs){
            clearTimeout(globalHQTimer);
            globalHQTimer = setTimeout(()=>{
                selectedDesigns.forEach(obj => {
                    const d = obj._ownerData;
                    if(!d) return;
                    const isMain      = obj === d.designObject;
                    const extraIdx    = isMain ? -1 : (d.extraDesignObjects||[]).indexOf(obj);
                    const srcOriginal = isMain
                        ? d.designOriginal
                        : (d.extraDesignOriginals?.[extraIdx] || d.designOriginal);
                    if(!srcOriginal) return;
                    _applyWarpToOneObject(obj, d, srcOriginal, false);
                    d.fabricCanvas.requestRenderAll();
                });
                autoSaveSession();
            }, 220);
        }

        return;
    }
    // ─────────────────────────────────────────────────────────────────────────

    const requiresWarp =
        activeSliderType === "warpAmount" ||
        activeSliderType === "arcAmount" ||
        activeSliderType === "arcTilt" ||
        activeSliderType === "blurAmount" ||
        activeSliderType === "noiseAmount" ||
        activeSliderType === "perspectiveTop"  ||
        activeSliderType === "perspectiveLeft" ;

    activeIndices.forEach(index=>{

        const data = canvasData[index];

        // preserve current live object transforms
        if(data.designObject){

            data.x = data.designObject.left;
            data.y = data.designObject.top;

            data.rotation = data.designObject.angle;

            data.scaleX =
                data.designObject.scaleX / data.previewScale;

            data.scaleY =
                data.designObject.scaleY / data.previewScale;
        }

        data.warpAmount = parseFloat(warpAmount.value);
        data.arcAmount = parseFloat(arcAmount.value);
        data.arcTilt = parseFloat(arcTilt.value);
        data.perspectiveTop = parseFloat(perspectiveTop.value);
        data.perspectiveLeft = parseFloat(perspectiveLeft.value);

        opacityAmount.value = Math.max(
            0,
            Math.min(100, parseFloat(opacityAmount.value) || 0)
        );

        blurAmount.value = Math.max(
            0,
            Math.min(100, parseFloat(blurAmount.value) || 0)
        );

        noiseAmount.value = Math.max(
            0,
            Math.min(100, parseFloat(noiseAmount.value) || 0)
        );

        data.opacity    = parseFloat(opacityAmount.value) / 100;
        data.blurAmount = parseFloat(blurAmount.value);
        data.noiseAmount = parseFloat(noiseAmount.value);
        data.blendMode  = blendMode.value;

        // Keep main design's _fx in sync with window-level properties
        if(data.designObject?._fx){
            data.designObject._fx.warpAmount    = data.warpAmount;
            data.designObject._fx.arcAmount     = data.arcAmount;
            data.designObject._fx.arcTilt       = data.arcTilt;
            data.designObject._fx.perspectiveTop  = data.perspectiveTop;
            data.designObject._fx.perspectiveLeft = data.perspectiveLeft;
            data.designObject._fx.opacity       = data.opacity;
            data.designObject._fx.blurAmount    = data.blurAmount;
            data.designObject._fx.noiseAmount   = data.noiseAmount;
            data.designObject._fx.blendMode     = data.blendMode;
        }

        const wrapper =
            data.fabricCanvas.lowerCanvasEl.parentElement;

        // skip expensive updates for offscreen windows
        if(!isElementVisible(wrapper)){
            return;
        }

        // fast live updates for opacity/blend only (window mode: main design only)
        if(!requiresWarp){

            if(data.designObject){
                data.designObject.set({
                    opacity: data.opacity ?? 1,
                    globalCompositeOperation:
                        data.blendMode === 'multiply'
                            ? 'multiply'
                            : data.blendMode === 'screen'
                                ? 'screen'
                                : 'source-over'
                });
            }

            data.fabricCanvas.requestRenderAll();
            return;
        }

        // ultra-fast live warp preview
        if(data.designObject){

            applyWarpToData(data, true);
        }
    });

    // only do HQ render AFTER user stops dragging
    clearTimeout(globalHQTimer);

    globalHQTimer = setTimeout(async ()=>{

        // Render visible canvases first so the user sees results immediately,
        // then yield between each off-screen item so the UI stays responsive.
        const wrapper = i => canvasData[i]?.fabricCanvas?.lowerCanvasEl?.parentElement;
        const sorted = [...activeIndices].sort((a, b)=>{
            const av = isElementVisible(wrapper(a)) ? 0 : 1;
            const bv = isElementVisible(wrapper(b)) ? 0 : 1;
            return av - bv;
        });

        for(const index of sorted){

            const data = canvasData[index];

            if(data.designObject){

                await applyWarpToData(data, false);

                // Window mode HQ: apply opacity only to main design
                if(data.designObject){
                    data.designObject.set({
                        opacity: data.opacity ?? 1,
                        globalCompositeOperation:
                            data.blendMode === 'multiply'
                                ? 'multiply'
                                : data.blendMode === 'screen'
                                    ? 'screen'
                                    : 'source-over'
                    });
                }

                data.fabricCanvas.requestRenderAll();

                // yield after each item so the browser can paint and handle events
                await new Promise(r => setTimeout(r, 0));
            }
        }

    }, 220);
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


document.getElementById('bgUpload').addEventListener('change', function(event){

    if(clipEditMode){
        showClipModeNotice();
        return;
    }

    const files = Array.from(event.target.files);

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
});


document.getElementById('designUpload').addEventListener('change', async function(event){

    if(clipEditMode){
        showClipModeNotice();
        return;
    }

    designs = [];

    const loadingIndicator =
        document.getElementById("loadingIndicator");

    loadingIndicator.style.display = "block";
    loadingIndicator.innerText = "Preparing designs...";

    const files = Array.from(event.target.files);

    if(!files.length){
        loadingIndicator.style.display = "none";
        return;
    }

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
});


function createCanvasData(bgObj, designObj){

    return {
        bg: bgObj.img,
        bgName: bgObj.name,
        designOriginal: designObj ? designObj.img : null,
        designName: designObj ? designObj.name : null,

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

    if(!backgrounds.length) return;

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
            const gapSpace = 20 * 3;
            const availableWidth = containerWidth - gapSpace - 40;

            const targetColumnWidth =
                Math.min(420, availableWidth / 4);

            const scaleRatio =
                Math.min(1, targetColumnWidth / realWidth);

            const previewWidth = realWidth * scaleRatio;
            const previewHeight = realHeight * scaleRatio;

            fabricCanvas.setWidth(previewWidth);
            fabricCanvas.setHeight(previewHeight);

            wrapper.style.width = previewWidth + 'px';

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

            if(suppressNextWrapperClick){
                return;
            }

            if(clipEditMode && !clipCopySelectMode){
                return;
            }

            if(colorLayerMode){
                if(!activeIndices.includes(index)){
                    alert("Exit Color Layer mode to interact with other windows.");
                }
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

                    // Add original designs of newly-included windows
                    activeIndices.forEach(i => {
                        const d = canvasData[i];
                        if(d?.designObject && !selectedDesigns.has(d.designObject)){
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
                        if(d?.designObject){
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
                        if(d?.designObject){
                            if(!d.designObject._fx) d.designObject._fx = _defaultFx(d);
                            selectedDesigns.add(d.designObject);
                        }
                    } else {
                        // Window already in selection — keep everything, just ensure
                        // its design is represented in selectedDesigns
                        const d = canvasData[index];
                        if(d?.designObject && !selectedDesigns.has(d.designObject)){
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
    }

    // mouse:down handler manages selectedDesigns and syncSliders; selected event is unused.

    designTarget.on('moving', ()=>{

        const deltaX = designTarget.left - (designTarget.lastLeft || designTarget.left);
        const deltaY = designTarget.top  - (designTarget.lastTop  || designTarget.top);

        if(isMainDesign){

            getAllDesignObjects(data).forEach(obj=>{
                if(obj === designTarget) return;
                obj.left += deltaX;
                obj.top  += deltaY;
            });

            activeIndices.forEach(index=>{

                if(canvasData[index] === data) return;

                const target = canvasData[index];

                getAllDesignObjects(target).forEach(obj=>{
                    obj.left += deltaX;
                    obj.top  += deltaY;
                });

                // only re-render canvases currently on screen
                const tw = target.fabricCanvas.lowerCanvasEl.parentElement;
                if(isElementVisible(tw)) target.fabricCanvas.requestRenderAll();
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

                const peer = (canvasData[index].extraDesignObjects || [])[layerIdx];

                if(peer){
                    peer.left += deltaX;
                    peer.top  += deltaY;
                    peer.setCoords();
                }

                const tw = canvasData[index].fabricCanvas.lowerCanvasEl.parentElement;
                if(isElementVisible(tw)) canvasData[index].fabricCanvas.requestRenderAll();
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
        pushGlobalUndo();
    });

    designTarget.on('scaling', ()=>{

        const scaleX = designTarget.scaleX;
        const scaleY = designTarget.scaleY;
        const left   = designTarget.left;
        const top    = designTarget.top;

        // Compute delta so cross-window peers move relative to their own position
        // (avoids "jump" where other windows' designs teleport to this window's coords).
        const deltaX = left - (designTarget.lastLeft || left);
        const deltaY = top  - (designTarget.lastTop  || top);

        if(isMainDesign){

            // Same-window: set absolute — all layers here share one coordinate space.
            getAllDesignObjects(data).forEach(obj=>{
                if(obj === designTarget) return;
                obj.scaleX = scaleX;
                obj.scaleY = scaleY;
                obj.left   = left;
                obj.top    = top;
                obj.setCoords();
            });

            // Cross-window: apply delta so remote designs don't jump.
            activeIndices.forEach(index=>{

                if(canvasData[index] === data) return;

                const target = canvasData[index];

                getAllDesignObjects(target).forEach(obj=>{
                    obj.scaleX  = scaleX;
                    obj.scaleY  = scaleY;
                    obj.left   += deltaX;
                    obj.top    += deltaY;
                    obj.setCoords();
                });

                const sw = target.fabricCanvas.lowerCanvasEl.parentElement;
                if(isElementVisible(sw)) target.fabricCanvas.requestRenderAll();
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

                const peer = (canvasData[index].extraDesignObjects || [])[layerIdx];

                if(peer){
                    peer.scaleX  = scaleX;
                    peer.scaleY  = scaleY;
                    peer.left   += deltaX;
                    peer.top    += deltaY;
                    peer.setCoords();
                }

                const sw = canvasData[index].fabricCanvas.lowerCanvasEl.parentElement;
                if(isElementVisible(sw)) canvasData[index].fabricCanvas.requestRenderAll();
            });
        }

        designTarget.lastLeft = left;
        designTarget.lastTop  = top;

        data.fabricCanvas.requestRenderAll();
    });

    designTarget.on('rotating', ()=>{

        const angle = designTarget.angle;

        if(isMainDesign){

            getAllDesignObjects(data).forEach(obj=>{
                obj.angle = angle;
            });

            activeIndices.forEach(index=>{

                if(canvasData[index] === data) return;

                const target = canvasData[index];

                getAllDesignObjects(target).forEach(obj=>{
                    obj.angle = angle;
                });

                const rw = target.fabricCanvas.lowerCanvasEl.parentElement;
                if(isElementVisible(rw)) target.fabricCanvas.requestRenderAll();
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

                const peer = (canvasData[index].extraDesignObjects || [])[layerIdx];

                if(peer){
                    peer.angle = angle;
                    peer.setCoords();
                }

                const rw = canvasData[index].fabricCanvas.lowerCanvasEl.parentElement;
                if(isElementVisible(rw)) canvasData[index].fabricCanvas.requestRenderAll();
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

function updateLayerButtons(){
    const del = document.getElementById("deleteLayerBtn");
    const dup = document.getElementById("duplicateLayerBtn");
    if(selectedDesigns.size > 0){
        del.style.display = "inline-block";
        dup.style.display = "inline-block";
    } else {
        del.style.display = "none";
        dup.style.display = "none";
    }
}



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
            if(d?.designObject){
                if(!d.designObject._fx) d.designObject._fx = _defaultFx(d);
                selectedDesigns.add(d.designObject);
            }
        });
    }

    refreshFabricHandles();
    updateWindowBorders();
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
                globalCompositeOperation:
                    fx.blendMode === 'multiply' ? 'multiply'
                    : fx.blendMode === 'screen'  ? 'screen'
                    : 'source-over'
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

        // Init color layer on every selected window
        activeIndices.forEach(i=>{
            initColorLayer(canvasData[i]);
            const el = canvasData[i].fabricCanvas.lowerCanvasEl;
            const wr = el && el.closest('.canvas-wrapper');
            if(wr) wr.classList.add('color-layer-mode');
        });

        document.getElementById("addColorLayerBtn").innerText       = "Exit Color Layer";
        document.getElementById("colorLayerControls").style.display = "inline-flex";

    } else {

        colorLayerMode  = false;
        brushTool       = 'brush';
        isColorPainting = false;
        lastPaintNorm   = null;
        hideBrushCursor();

        document.querySelectorAll('.canvas-wrapper')
            .forEach(w=> w.classList.remove('color-layer-mode'));

        document.getElementById("addColorLayerBtn").innerText       = "Add Color Layer";
        document.getElementById("colorLayerControls").style.display = "none";
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

// Global Cmd/Ctrl+Z → Undo, Cmd/Ctrl+Shift+Z → Redo
// (Clip-mode in-progress point removal is handled by its own guarded handler
//  which calls stopPropagation, so it takes priority when clipEditMode is true.)
document.addEventListener('keydown', function(e){
    if(!(e.metaKey || e.ctrlKey)) return;
    if(e.key.toLowerCase() !== 'z') return;
    if(clipEditMode) return;    // clip's own handler deals with it
    e.preventDefault();
    e.stopPropagation();
    if(e.shiftKey){
        performGlobalRedo();
    } else {
        performGlobalUndo();
    }
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

        // Always update cursor ring
        updateBrushCursor(opt.e, data.previewScale);

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
async function exportDataToBlob(data){

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

    const dataURL = data.fabricCanvas.toDataURL({
        format: 'png',
        quality: 1,
        multiplier: exportMultiplier,
        enableRetinaScaling: true
    });

    hiddenOverlayObjects.forEach(obj=>{ obj.visible = true; });
    data.fabricCanvas.requestRenderAll();

    return await (await fetch(dataURL)).blob();
}


document.getElementById("undoBtn").addEventListener("click", () => performGlobalUndo());
document.getElementById("redoBtn").addEventListener("click", () => performGlobalRedo());

document.getElementById("exportBtn").addEventListener("click", async ()=>{

    if(clipEditMode){
        showClipModeNotice();
        return;
    }

    if(!activeIndices.length){
        alert("Select at least one canvas window before exporting.");
        return;
    }

    // --- Path A: File System Access API (Chrome/Edge, HTTPS) ---
    if(typeof window.showDirectoryPicker === "function"){

        let dirHandle;

        try{
            dirHandle = await window.showDirectoryPicker();
        } catch(err){
            // User cancelled the picker — do nothing
            return;
        }

        for(let index of activeIndices){

            const data = canvasData[index];
            const blob = await exportDataToBlob(data);

            const fileHandle = await dirHandle.getFileHandle(
                data.filename + ".png",
                { create: true }
            );

            const writable = await fileHandle.createWritable();
            await writable.write(blob);
            await writable.close();
        }

        alert("Exported " + activeIndices.length + " file(s)!");
        return;
    }

    // --- Path B: fallback download for Firefox / Safari / HTTP ---
    // Trigger individual <a download> for each selected canvas.
    for(let index of activeIndices){

        const data = canvasData[index];
        const blob = await exportDataToBlob(data);

        const url = URL.createObjectURL(blob);
        const a   = document.createElement("a");

        a.href     = url;
        a.download = data.filename + ".png";
        a.click();

        // Small delay so the browser registers each download separately
        await new Promise(r => setTimeout(r, 150));

        URL.revokeObjectURL(url);
    }
});



document.getElementById("resetBtn").addEventListener("click", ()=>{

    if(!activeIndices.length) return;

    pushGlobalUndo();

    activeIndices.forEach(index=>{

        const data = canvasData[index];

        // remove all duplicated designs
        if(data.extraDesignObjects){

            data.extraDesignObjects.forEach(obj=>{
                data.fabricCanvas.remove(obj);
            });

            data.extraDesignObjects = [];
        }

        // restore original position/state
        data.x = data.initialX;
        data.y = data.initialY;

        data.scale = data.initialScale;
        data.scaleX = null;
        data.scaleY = null;

        data.rotation = data.initialRotation;

        data.warpAmount = data.initialWarpAmount;
        data.arcAmount = data.initialArcAmount;
        data.arcTilt = data.initialArcTilt;
        data.opacity = data.initialOpacity;
        data.blurAmount  = data.initialBlurAmount;
        data.noiseAmount = data.initialNoiseAmount ?? 0;
        data.blendMode   = data.initialBlendMode;
        data.perspectiveTop = data.initialPerspectiveTop;
        data.perspectiveLeft = data.initialPerspectiveLeft;

        // restore original design object
        if(data.designObject){

            applyClipMaskToObject(data.designObject, data);

        data.designObject.set({
                left: data.initialX,
                top: data.initialY,
                angle: data.initialRotation,
                scaleX: data.initialScale * data.previewScale,
                scaleY: data.initialScale * data.previewScale,
                opacity: data.initialOpacity,
                globalCompositeOperation: 'source-over'
            });
        }

        applyWarpToData(data);

        // ── Clear clipping ────────────────────────────────────────────────────
        data.maskEnabled        = false;
        data.maskType           = null;
        data.maskPath           = null;
        data.maskPaths          = [];
        data.clipCurvePoints    = [];
        data.clipPolygonClosed  = false;

        // Remove clip path from main design + any duplicates
        getAllDesignObjects(data).forEach(obj=>{
            applyClipMaskToObject(obj, data);
        });
        addClipOverlay(data);   // clears overlay visuals

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

        data.fabricCanvas.discardActiveObject();
        data.fabricCanvas.requestRenderAll();
    });

    syncSliders();
});





function buildSnapshot(){

    return canvasData.map(data=>{

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
            colorLayerBlendMode: data.colorLayerFabricObj?.globalCompositeOperation ?? 'source-over'
        };
    });
}


let _autoSaveTimer = null;

function autoSaveSession(){

    if(!canvasData.length) return;

    clearTimeout(_autoSaveTimer);

    _autoSaveTimer = setTimeout(()=>{

        try {
            localStorage.setItem(
                'mockup_autosave',
                JSON.stringify(buildSnapshot())
            );
        } catch(e){
            // quota exceeded or private browsing — silently skip
        }

    }, 2500);
}


document.getElementById("saveProgressBtn").addEventListener("click", ()=>{

    const snapshot = buildSnapshot();

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

            img.onload = ()=>resolve(img);

            img.src = saved.bgSrc;
        });

        let designImg = null;

        if(saved.designSrc){

            designImg = await new Promise(resolve=>{

                const img = new Image();

                img.onload = ()=>resolve(img);

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

        const canvasEl = document.createElement("canvas");

        wrapper.appendChild(canvasEl);

        const filenameInput = document.createElement("input");

        filenameInput.type = "text";
        filenameInput.className = "filename-input";
        filenameInput.value = saved.filename;

        filenameInput.addEventListener("input", e=>{
            data.filename = e.target.value;
        });

        wrapper.appendChild(filenameInput);

        container.appendChild(wrapper);

        const fabricCanvas = new fabric.Canvas(canvasEl,{
            preserveObjectStacking: true,
            selection: false,
            renderOnAddRemove: false
        });

        data.fabricCanvas = fabricCanvas;

        const realWidth = bgImg.width;

        const containerWidth = container.clientWidth;

        const targetColumnWidth =
            Math.min(420, (containerWidth - 100) / 4);

        const previewScale =
            Math.min(1, targetColumnWidth / realWidth);

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

        fabricCanvas.setWidth(bgImg.width * previewScale);
        fabricCanvas.setHeight(bgImg.height * previewScale);

        wrapper.style.width =
            (bgImg.width * previewScale) + "px";

        const bgFabric = await new Promise(resolve=>{

            fabric.Image.fromURL(saved.bgSrc, resolve,{
                crossOrigin:'anonymous'
            });
        });

        bgFabric.set({
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
                                globalCompositeOperation:
                                    dup.blendMode === 'multiply'
                                        ? 'multiply'
                                        : dup.blendMode === 'screen'
                                            ? 'screen'
                                            : 'source-over',
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

                                globalCompositeOperation:
                                    dup.blendMode === 'multiply'
                                        ? 'multiply'
                                        : dup.blendMode === 'screen'
                                            ? 'screen'
                                            : 'source-over'
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

        wrapper.addEventListener('click', function(e){

            if(suppressNextWrapperClick){
                return;
            }

            if(clipEditMode && !clipCopySelectMode){
                return;
            }

            if(colorLayerMode){
                if(!activeIndices.includes(index)){
                    alert("Exit Color Layer mode to interact with other windows.");
                }
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

                    // Add original designs of newly-included windows
                    activeIndices.forEach(i => {
                        const d = canvasData[i];
                        if(d?.designObject && !selectedDesigns.has(d.designObject)){
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
                        if(d?.designObject){
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
                        if(d?.designObject){
                            if(!d.designObject._fx) d.designObject._fx = _defaultFx(d);
                            selectedDesigns.add(d.designObject);
                        }
                    } else {
                        // Window already in selection — keep everything, just ensure
                        // its design is represented in selectedDesigns
                        const d = canvasData[index];
                        if(d?.designObject && !selectedDesigns.has(d.designObject)){
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

        const snapshot = JSON.parse(e.target.result);

        await createCanvasPreviewsFromSnapshot(snapshot);

        syncSliders();
        updateWindowBorders();
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
});


let resizeTimer;
let _resizeRestoreInProgress = false;

window.addEventListener('resize', ()=>{

    clearTimeout(resizeTimer);

    resizeTimer = setTimeout(async ()=>{

        if(!canvasData.length) return;

        // Guard against concurrent restores: if a previous resize is still
        // running its async restore, skip this one entirely so canvasData
        // is never written by two calls at once (which scrambles the order).
        if(_resizeRestoreInProgress) return;

        _resizeRestoreInProgress = true;

        try {
            // Rebuild at new viewport width while preserving all effects and transforms.
            // createCanvasPreviews() resets everything to defaults; snapshot-restore keeps state.
            const snapshot = buildSnapshot();

            await createCanvasPreviewsFromSnapshot(snapshot);

            syncSliders();
            updateWindowBorders();
        } finally {
            _resizeRestoreInProgress = false;
        }

    }, 150);
});


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

    if(!Array.isArray(snapshot) || !snapshot.length) return;

    await createCanvasPreviewsFromSnapshot(snapshot);

    syncSliders();
    updateWindowBorders();
});
