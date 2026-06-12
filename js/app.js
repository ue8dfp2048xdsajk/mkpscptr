let backgrounds = [];
let designs = [];
let canvasData = [];
let activeIndices = [];
let editMode = "window";
let activeDesignObject = null;
let activeDesignWindow = null;
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

    const insideSelectedWindow =
        e.target.closest('.canvas-wrapper.active');

    const exitButton =
        e.target.id === 'editClipBtn';

    const deleteClipButton =
        e.target.id === 'deleteClipBtn';

    const addClipAreaButton =
        e.target.id === 'addClipAreaBtn';

    if(
        insideSelectedWindow ||
        exitButton ||
        deleteClipButton ||
        addClipAreaButton
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



function updateWindowBorders(){
    document.querySelectorAll(".canvas-wrapper")
        .forEach((w,i)=>{
            w.classList.remove("active","design-active");
            if(activeIndices.includes(i)){
                if(editMode === "design" && i === activeDesignWindow){
                    w.classList.add("design-active");
                } else {
                    w.classList.add("active");
                }
            }
        });
}

function getAllDesignObjects(data){
    const objs = [];
    if(data.designObject) objs.push(data.designObject);
    if(data.extraDesignObjects){
        objs.push(...data.extraDesignObjects);
    }
    return objs;
}


function syncSliders() {

    if(!activeIndices.length) return;

    const data = canvasData[activeIndices[0]];
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
                obj.isTempCurvePreview
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
                        stroke:'rgba(95,143,255,0.45)',
                        strokeWidth:0.6,
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
            fill: 'rgba(30,94,255,0.55)',
            stroke:'rgba(255,255,255,0.55)',
            strokeWidth:0.6,
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
                stroke:'rgba(160,191,255,0.35)',
                strokeWidth:0.45,
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
                stroke:'rgba(30,94,255,0.55)',
                strokeWidth:0.45,
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
            fill:'rgba(255,255,255,0.45)',
            stroke:'rgba(30,94,255,0.55)',
            strokeWidth:0.55,
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

function createCurveOverlay(
    points,
    closed = false,
    isTemporary = true
){

    return new fabric.Path(
        buildCurvePathString(points, closed),
        {
            fill: (
                closed && !isTemporary
            )
                ? 'rgba(0,0,255,0.08)'
                : 'rgba(0,0,255,0)',
            stroke: '#1e5eff',
            strokeWidth: 0.85,
            selectable: false,
            evented: false,
            excludeFromExport: true,

            // ONLY live editor previews should be removable.
            // Finalized overlays must persist while drawing
            // additional polygons.
            isTempCurvePreview: isTemporary,

            objectCaching: false
        }
    );
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

        const overlay =
            createCurveOverlay(
                path,
                true,
                false
            );

        data.clipOverlays.push(overlay);

        data.fabricCanvas.add(overlay);

        overlay.bringToFront();
    });

    if(data.designObject){
        data.designObject.bringToFront();
    }
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

            data.extraDesignObjects.forEach(obj=>{

                const prevLeft = obj.left;
                const prevTop = obj.top;
                const prevScaleX = obj.scaleX;
                const prevScaleY = obj.scaleY;
                const prevAngle = obj.angle;

                obj.setElement(warpedCanvas);

                applyClipMaskToObject(obj, data);

                obj.set({
                    left: prevLeft,
                    top: prevTop,
                    scaleX: prevScaleX,
                    scaleY: prevScaleY,
                    angle: prevAngle,
                    opacity: data.opacity ?? 1,
                    globalCompositeOperation:
                        data.blendMode === 'multiply'
                            ? 'multiply'
                            : data.blendMode === 'screen'
                                ? 'screen'
                                : 'source-over'
                });
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

    data.fabricCanvas.add(newImg);
    data.fabricCanvas.setActiveObject(newImg);
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

        const wrapper =
            data.fabricCanvas.lowerCanvasEl.parentElement;

        // skip expensive updates for offscreen windows
        if(!isElementVisible(wrapper)){
            return;
        }

        const allObjects = getAllDesignObjects(data);

        // fast live updates for opacity/blend only
        if(!requiresWarp){

            allObjects.forEach(obj=>{

                obj.set({
                    opacity: data.opacity ?? 1,
                    globalCompositeOperation:
                        data.blendMode === 'multiply'
                            ? 'multiply'
                            : data.blendMode === 'screen'
                                ? 'screen'
                                : 'source-over'
                });
            });

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

                const allObjects = getAllDesignObjects(data);

                allObjects.forEach(obj=>{

                    obj.set({
                        opacity: data.opacity ?? 1,
                        globalCompositeOperation:
                            data.blendMode === 'multiply'
                                ? 'multiply'
                                : data.blendMode === 'screen'
                                    ? 'screen'
                                    : 'source-over'
                    });
                });

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

            if(clipEditMode){
                return;
            }

                if(editMode === "design"){

                    if(index !== activeDesignWindow){
                        return;
                    }

                    activeIndices = [activeDesignWindow];

                    updateWindowBorders();
                    syncSliders();
                    updateSelectButtonState();

                    return;
                }

                const isModifierMultiSelect = e.metaKey || e.ctrlKey;

                // SHIFT = range select
                if(e.shiftKey){

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

                // CMD / CTRL = individual toggle select
                } else if(isModifierMultiSelect){

                    if(activeIndices.includes(index)){

                        activeIndices =
                            activeIndices.filter(i => i !== index);

                    } else {

                        activeIndices.push(index);
                    }

                    lastSelectedIndex = index;

                // normal click = single select
                } else {

                    activeIndices = [index];

                    lastSelectedIndex = index;
                }

                if(e.shiftKey){
                    lastSelectedIndex = index;
                }

                updateWindowBorders();

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

    designTarget.on('selected', ()=>{

        if(editMode === "design"){
            activeDesignObject = designTarget;
        }
    });

    designTarget.on('moving', ()=>{

        if(editMode === "design"){
            return;
        }

        const deltaX = designTarget.left - (designTarget.lastLeft || designTarget.left);
        const deltaY = designTarget.top - (designTarget.lastTop || designTarget.top);

        getAllDesignObjects(data).forEach(obj=>{
            if(obj === designTarget) return;
            obj.left += deltaX;
            obj.top += deltaY;
        });

        activeIndices.forEach(index=>{

            if(canvasData[index] === data) return;

            const target = canvasData[index];

            getAllDesignObjects(target).forEach(obj=>{
                obj.left += deltaX;
                obj.top += deltaY;
            });

            // only re-render canvases currently on screen; off-screen ones
            // get the position update but skip the expensive paint call
            const tw = target.fabricCanvas.lowerCanvasEl.parentElement;
            if(isElementVisible(tw)) target.fabricCanvas.requestRenderAll();
        });

        designTarget.lastLeft = designTarget.left;
        designTarget.lastTop = designTarget.top;

        data.fabricCanvas.requestRenderAll();
    });

    designTarget.on('mousedown', ()=>{

        suppressNextWrapperClick = true;
        designTarget.lastLeft = designTarget.left;
        designTarget.lastTop = designTarget.top;
    });

    designTarget.on('scaling', ()=>{

        if(editMode === "design"){
            return;
        }

        const scaleX = designTarget.scaleX;
        const scaleY = designTarget.scaleY;

        const left = designTarget.left;
        const top = designTarget.top;

        getAllDesignObjects(data).forEach(obj=>{

            obj.scaleX = scaleX;
            obj.scaleY = scaleY;

            obj.left = left;
            obj.top = top;

            obj.setCoords();
        });

        activeIndices.forEach(index=>{

            if(canvasData[index] === data) return;

            const target = canvasData[index];

            getAllDesignObjects(target).forEach(obj=>{

                obj.scaleX = scaleX;
                obj.scaleY = scaleY;

                obj.left = left;
                obj.top = top;

                obj.setCoords();
            });

            const sw = target.fabricCanvas.lowerCanvasEl.parentElement;
            if(isElementVisible(sw)) target.fabricCanvas.requestRenderAll();
        });

        data.fabricCanvas.requestRenderAll();
    });

    designTarget.on('rotating', ()=>{

        if(editMode === "design"){
            return;
        }

        const angle = designTarget.angle;

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



document.getElementById("selectAllBtn").addEventListener("click", ()=>{

    if(clipEditMode){
        showClipModeNotice();
        return;
    }

    if(activeIndices.length > 0){

        activeIndices = [];

updateWindowBorders();

    } else {

        activeIndices = canvasData.map((_,i)=>i);

updateWindowBorders();
    }

    updateSelectButtonState();
});


document.getElementById("designModeBtn").addEventListener("click", ()=>{

    if(clipEditMode){
        showClipModeNotice();
        return;
    }

    if(editMode === "window"){

        if(activeIndices.length !== 1){
            alert("Select one window");
            return;
        }

        editMode = "design";
        activeDesignWindow = activeIndices[0];

        // lock selection to one window only
        activeIndices = [activeDesignWindow];

        document.getElementById("designModeBtn").innerText = "Exit Design Mode";
        document.getElementById("duplicateDesignBtn").style.display = "inline-block";
        document.getElementById("deleteDesignBtn").style.display = "inline-block";

        // disable select all during design mode
        document.getElementById("selectAllBtn").disabled = true;

    } else {

        editMode = "window";
        activeDesignObject = null;
        activeDesignWindow = null;

        document.getElementById("designModeBtn").innerText = "Design Mode";
        document.getElementById("duplicateDesignBtn").style.display = "none";
        document.getElementById("deleteDesignBtn").style.display = "none";

        // re-enable select all after exiting design mode
        document.getElementById("selectAllBtn").disabled = false;

        canvasData.forEach(data=>{
            data.fabricCanvas.discardActiveObject();
            data.fabricCanvas.requestRenderAll();
        });
    }

    updateWindowBorders();
});

document.getElementById("duplicateDesignBtn").addEventListener("click", ()=>{

    if(clipEditMode){
        showClipModeNotice();
        return;
    }

    if(editMode !== "design" || activeDesignWindow === null) return;

    const data = canvasData[activeDesignWindow];

    const sourceObj = activeDesignObject || data.designObject;

    if(!sourceObj) return;

    sourceObj.clone((cloned)=>{

        cloned.set({
            left: sourceObj.left + 40,
            top: sourceObj.top + 20,
            opacity: data.opacity ?? 1,
            globalCompositeOperation:
                data.blendMode === 'multiply'
                    ? 'multiply'
                    : data.blendMode === 'screen'
                        ? 'screen'
                        : 'source-over'
        });

        data.extraDesignObjects = data.extraDesignObjects || [];
        data.extraDesignObjects.push(cloned);

        data.fabricCanvas.add(cloned);
        attachFabricEvents(data, cloned);

        data.fabricCanvas.setActiveObject(cloned);
        activeDesignObject = cloned;

        data.fabricCanvas.requestRenderAll();
    });
});



document.getElementById("deleteDesignBtn").addEventListener("click", ()=>{

    if(clipEditMode){
        showClipModeNotice();
        return;
    }

    if(editMode !== "design" || activeDesignWindow === null) return;

    const data = canvasData[activeDesignWindow];

    if(!activeDesignObject) return;

    // prevent deleting original base design
    if(activeDesignObject === data.designObject){
        alert("Cannot delete original design");
        return;
    }

    data.fabricCanvas.remove(activeDesignObject);

    data.extraDesignObjects =
        data.extraDesignObjects.filter(
            obj => obj !== activeDesignObject
        );

    activeDesignObject = null;

    data.fabricCanvas.discardActiveObject();
    data.fabricCanvas.requestRenderAll();
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

    // exiting clip mode
    if(!clipEditMode){

        activeClipWindowIndex = null;

        canvasData.forEach(data=>{

            clearBezierHelpers(data.fabricCanvas);

            if(activeCurvePreview){
                data.fabricCanvas.remove(activeCurvePreview);
            }

            activeCurvePreview = null;

            // keep final overlay visible
            addClipOverlay(data);

            data.fabricCanvas.requestRenderAll();
        });

        return;
    }

    // entering clip mode
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

            data.fabricCanvas.add(activeCurvePreview);

            drawBezierHelpers(
                data.fabricCanvas,
                clipCurvePoints
            );

            activeCurvePreview.bringToFront();

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
        canvasData[activeIndices[0]].fabricCanvas
            .remove(activeCurvePreview);

        activeCurvePreview = null;
    }
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
                    obj.isTempCurvePreview
                )
                .forEach(obj=>{
                    targetCanvas.remove(obj);
                });

            if(!clipCurvePoints.length){
                targetCanvas.requestRenderAll();
                return;
            }

            const overlay =
                createCurveOverlay(
                    clipCurvePoints,
                    clipPolygonClosed
                );

            targetCanvas.add(overlay);

            // Photoshop-style workflow:
            // while user is still drawing the polygon,
            // do NOT show anchor handles or bezier controls.
            // This keeps clicks precise near previous points.
            if(clipPolygonClosed){

                drawBezierHelpers(
                    targetCanvas,
                    clipCurvePoints
                );

                overlay.bringToFront();

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

        if(
            !clipEditMode ||
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

        data.fabricCanvas.discardActiveObject();
        data.fabricCanvas.requestRenderAll();
    });

    activeDesignObject = null;

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

            maskPaths: data.maskPaths ?? [],
            maskPath: data.maskPath ?? null,
            maskEnabled: data.maskEnabled ?? false,
            maskType: data.maskType ?? null,

            filename: data.filename,

            // Normalise duplicate positions the same way the main design x/y are
            // normalised — divide by previewScale so values are in bg-image-pixel
            // space.  The restore path multiplies back up by the new previewScale.
            duplicates: (data.extraDesignObjects || []).map(obj=>({

                left: obj.left  / data.previewScale,
                top:  obj.top   / data.previewScale,

                scaleX: obj.scaleX / data.previewScale,
                scaleY: obj.scaleY / data.previewScale,

                angle: obj.angle
            }))
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

        if(saved.duplicates?.length){

            for(const dup of saved.duplicates){

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

                        data.extraDesignObjects.push(cloned);

                        fabricCanvas.add(cloned);

                        attachFabricEvents(data, cloned);

                        resolve();
                    });
                });
            }
        }

        addClipOverlay(data);

        fabricCanvas.requestRenderAll();

        wrapper.addEventListener('click', function(e){

            if(suppressNextWrapperClick){
                return;
            }

                if(editMode === "design"){

                    if(index !== activeDesignWindow){
                        return;
                    }

                    activeIndices = [activeDesignWindow];

                    updateWindowBorders();
                    syncSliders();
                    updateSelectButtonState();

                    return;
                }

                const isModifierMultiSelect = e.metaKey || e.ctrlKey;

                // SHIFT = range select
                if(e.shiftKey){

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

                // CMD / CTRL = individual toggle select
                } else if(isModifierMultiSelect){

                    if(activeIndices.includes(index)){

                        activeIndices =
                            activeIndices.filter(i => i !== index);

                    } else {

                        activeIndices.push(index);
                    }

                    lastSelectedIndex = index;

                // normal click = single select
                } else {

                    activeIndices = [index];

                    lastSelectedIndex = index;
                }

                if(e.shiftKey){
                    lastSelectedIndex = index;
                }

                updateWindowBorders();

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
    activeDesignWindow = null;
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
