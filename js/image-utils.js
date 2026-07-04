'use strict';
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

    if(!canvas || !canvas.getContext) return canvas;

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
    // Record crop offsets so callers can compensate for the position shift.
    trimmed._trimX0   = x0;
    trimmed._trimY0   = y0;
    trimmed._trimSrcW = width;
    trimmed._trimSrcH = height;
    return trimmed;
}

// Map a content-space delta (source pixels from center) to canvas-space delta
// using scale + skew + rotation (matches Fabric object local transform).
function contentDeltaToCanvasDelta(dx, dy, geo) {
    geo = geo || {};
    if (typeof fabric !== 'undefined' && fabric.util && fabric.util.composeMatrix) {
        const m = fabric.util.composeMatrix({
            angle:  geo.angle  || 0,
            scaleX: geo.scaleX ?? 1,
            scaleY: geo.scaleY ?? 1,
            skewX:  geo.skewX  || 0,
            skewY:  geo.skewY  || 0,
        });
        return fabric.util.transformPoint({ x: dx, y: dy }, m);
    }
    const rad  = (geo.angle || 0) * Math.PI / 180;
    const cosA = Math.cos(rad);
    const sinA = Math.sin(rad);
    const sx   = geo.scaleX ?? 1;
    const sy   = geo.scaleY ?? 1;
    const kx   = Math.tan((geo.skewX || 0) * Math.PI / 180);
    const ky   = Math.tan((geo.skewY || 0) * Math.PI / 180);
    const sxdx = sx * dx;
    const sydy = sy * dy;
    const skx  = sxdx + ky * sydy;
    const sky  = kx * sxdx + sydy;
    return {
        x: skx * cosA - sky * sinA,
        y: skx * sinA + sky * cosA,
    };
}


// Ensure every render call on a Fabric canvas uses high-quality image smoothing.
// Fabric v5 leaves imageSmoothingQuality at the browser default ('low'), which
// causes visible pixelation when a high-res design is drawn at a small scale.
function _setFabricHighQualitySmoothing(fc) {
    fc.on('before:render', () => {
        const ctx = fc.contextContainer;
        if (ctx) {
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
        }
    });
}

// preTrimmed: pass an already-trimmed canvas to skip the getImageData pixel scan.
// Used by _applyWarpToOneObject when the warp canvas hasn't changed (trim cache hit).
// Build a mipmap chain from a canvas: [original, half, quarter, …]
// Each level is half the previous, drawn with high smoothing.
function buildMipChain(canvas) {
    const mips = [canvas];
    let prev = canvas;
    while (prev.width > 8 && prev.height > 8) {
        const half = document.createElement('canvas');
        half.width  = Math.max(1, Math.floor(prev.width  / 2));
        half.height = Math.max(1, Math.floor(prev.height / 2));
        const hc = half.getContext('2d');
        hc.imageSmoothingEnabled = true;
        hc.imageSmoothingQuality = 'high';
        hc.drawImage(prev, 0, 0, half.width, half.height);
        mips.push(half);
        prev = half;
    }
    return mips;
}
// Pick the smallest mip level whose width is still >= targetW (no upscaling).
function pickMipW(mips, targetW) {
    for (let i = mips.length - 1; i >= 0; i--) {
        if (mips[i].width >= targetW) return i;
    }
    return 0;
}
// Pick the smallest mip level whose height is still >= targetH.
function pickMipH(mips, targetH) {
    for (let i = mips.length - 1; i >= 0; i--) {
        if (mips[i].height >= targetH) return i;
    }
    return 0;
}

