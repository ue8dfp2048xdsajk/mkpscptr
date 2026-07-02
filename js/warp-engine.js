'use strict';
function applyPerspectiveDistortion(sourceCanvas, data, lowQuality = false, preTrimmed = null, outCanvas = null, tempCanvasArg = null){

    const top  = data.perspectiveTop  || 0;
    const left = data.perspectiveLeft || 0;

    // Trim transparent borders from the source (e.g. warp/arc padding).
    // In LQ (live-drag) mode skip the getImageData pixel readback — it stalls
    // the GPU pipeline and is the main cause of perspective lag vs cylinder/arc.
    const src  = preTrimmed || (lowQuality ? sourceCanvas : trimTransparentBorders(sourceCanvas));
    const srcW = src.width;
    const srcH = src.height;

    if(top === 0 && left === 0){
        return src;
    }

    // ── Supersampling ─────────────────────────────────────────────────────────
    // At extreme perspective values the compressed tip is built from very few
    // source pixels, which causes severe pixelation regardless of how well each
    // drawImage step is tuned. The fix is to work at a higher resolution:
    // upscale the source by 1/(1−perspFactor) so the compressed tip retains
    // approximately the original pixel count, then scale the output back down.
    // Cap at 4× in single-window HQ; 2× when many windows are selected so the
    // simultaneous mip-chain allocations don't exhaust GPU memory.
    const perspF  = Math.min(0.75, Math.max(Math.abs(top), Math.abs(left)) / 100);
    const _multiWin = typeof activeIndices !== 'undefined' && activeIndices.length > 1;
    const upScale = lowQuality ? 1 : Math.min(_multiWin ? 2 : 4, Math.max(1, 1 / (1 - perspF)));

    let wSrc = src;
    if(upScale > 1.05){
        wSrc = document.createElement('canvas');
        wSrc.width  = Math.round(srcW * upScale);
        wSrc.height = Math.round(srcH * upScale);
        const wc = wSrc.getContext('2d');
        wc.imageSmoothingEnabled = true;
        wc.imageSmoothingQuality = 'high';
        wc.drawImage(src, 0, 0, wSrc.width, wSrc.height);
    }
    const wSrcW = wSrc.width;
    const wSrcH = wSrc.height;

    const out = outCanvas || document.createElement('canvas');
    const ctx = out.getContext('2d');

    // Two-sided symmetric perspective: one edge grows to 1+|v|/100, the other
    // shrinks to 1-|v|/100 (reaching 0 at max). Required padding so neither
    // edge clips: pad ≥ wSrcW * |top| / 200  (transposed for vPad).
    const hPadNeeded = Math.abs(top) > 0
        ? Math.ceil(wSrcW * Math.abs(top) / 200)
        : 0;
    const vPadNeeded = Math.abs(left) > 0
        ? Math.ceil(wSrcH * Math.abs(left) / 200)
        : 0;
    const pad = Math.max(hPadNeeded, vPadNeeded, 20);

    out.width  = wSrcW + pad * 2;
    out.height = wSrcH + pad * 2;

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = lowQuality ? 'low' : 'high';

    // Live-drag uses fewer slices with no visible quality difference because
    // perspective distortion is a smooth linear transform.
    // 30 LQ slices ≈ cylinder's ~33, 2× faster than the old 60.
    const horizontalSlices = lowQuality ? 30 : 180;

    // ── Pass 1: top/bottom perspective (horizontal slices) ───────────────────
    // Mip chain keeps each slice's internal compression ≤ 2:1 on top of
    // the supersampled source.

    const srcMips = lowQuality ? [wSrc] : buildMipChain(wSrc);

    for(let y = 0; y < horizontalSlices; y++){

        const t      = y / (horizontalSlices - 1);
        const srcY   = t * wSrcH;
        const sliceH = Math.max(2, wSrcH / horizontalSlices);

        // Two-sided: top > 0 → top edge wide (1+|top|/100), bottom edge narrows
        // to 0 at max (sharp tip). top < 0: mirrored. Max(0) prevents negatives.
        const widthScale = top > 0
            ? Math.max(0, 1 + (top  / 100) * (1 - 2 * t))
            : Math.max(0, 1 + (-top / 100) * (2 * t - 1));
        const targetW = wSrcW * widthScale;
        if(targetW < 0.5) continue;

        const dx = pad + (wSrcW - targetW) / 2;
        const dy = pad + srcY;

        const mi    = pickMipW(srcMips, targetW);
        const mip   = srcMips[mi];
        const mipSY = mip.height / wSrcH;

        ctx.drawImage(
            mip,
            0,                                   Math.round(srcY * mipSY),
            mip.width,                           Math.max(1, Math.ceil(sliceH * mipSY)),
            Math.round(dx),                      Math.round(dy),
            Math.max(1, Math.ceil(targetW + 1)), Math.ceil(sliceH + 1)
        );
    }
    // Free pass-1 mip levels (not index 0 — that is the source canvas itself).
    // Setting width=0 releases the GPU backing store immediately rather than
    // waiting for GC, which prevents GPU OOM when many windows render at once.
    for(let i = 1; i < srcMips.length; i++) srcMips[i].width = 0;

    // ── Pass 2: left/right perspective (vertical slices) ─────────────────────
    // Operates on the supersampled Pass-1 output; mip chain applied here too.

    if(left !== 0){

        const tempCanvas = tempCanvasArg || document.createElement('canvas');
        const tempCtx    = tempCanvas.getContext('2d');
        tempCanvas.width  = out.width;
        tempCanvas.height = out.height;
        tempCtx.drawImage(out, 0, 0);
        ctx.clearRect(0, 0, out.width, out.height);

        const tempMips = lowQuality ? [tempCanvas] : buildMipChain(tempCanvas);

        const verticalSlices = lowQuality ? 30 : 180;

        for(let x = 0; x < verticalSlices; x++){

            const t      = x / (verticalSlices - 1);
            const srcX   = t * out.width;
            const sliceW = Math.max(2, out.width / verticalSlices);

            // t_c: normalised position within the design content (0 = left, 1 = right).
            const t_c = Math.max(0, Math.min(1, (srcX - pad) / wSrcW));

            // Two-sided: left > 0 → right edge tall (1+|left|/100), left edge
            // narrows to 0 at max (sharp tip). left < 0: mirrored.
            const leftScale = left > 0
                ? Math.max(0, 1 + (left  / 100) * (2 * t_c - 1))
                : Math.max(0, 1 + (-left / 100) * (1 - 2 * t_c));
            const targetH    = out.height * leftScale;
            if(targetH < 0.5) continue;
            const extraSpace = targetH - out.height;
            const dy         = -(extraSpace / 2);

            const mi    = pickMipH(tempMips, targetH);
            const mip   = tempMips[mi];
            const mipSX = mip.width  / tempCanvas.width;
            const mipSY = mip.height / tempCanvas.height;

            ctx.drawImage(
                mip,
                Math.round(srcX * mipSX),              0,
                Math.max(1, Math.ceil(sliceW * mipSX)), mip.height,
                Math.round(srcX),                       Math.round(dy),
                Math.ceil(sliceW + 1),                  Math.max(1, Math.ceil(targetH + 1))
            );
        }
        // Free pass-2 mip levels immediately (same reason as pass-1 above).
        for(let i = 1; i < tempMips.length; i++) tempMips[i].width = 0;
    }

    // ── Scale back down & trim ────────────────────────────────────────────────
    // In LQ mode skip the output trim (another getImageData stall) — transparent
    // padding is invisible during a live drag and the caller handles it fine.
    if(lowQuality) return out;

    // Trim first at full supersampled size, then scale down to 1× so the caller
    // receives the same output dimensions as without supersampling.
    const trimmedHQ = trimTransparentBorders(out);
    if(upScale <= 1.05) return trimmedHQ;

    const finalOut = document.createElement('canvas');
    finalOut.width  = Math.round(trimmedHQ.width  / upScale);
    finalOut.height = Math.round(trimmedHQ.height / upScale);
    if(finalOut.width < 1 || finalOut.height < 1) return trimmedHQ;
    const fc = finalOut.getContext('2d');
    fc.imageSmoothingEnabled = true;
    fc.imageSmoothingQuality = 'high';
    fc.drawImage(trimmedHQ, 0, 0, finalOut.width, finalOut.height);
    // Free the supersampled intermediate canvas — it is distinct from src/out
    // and not referenced by the caller, so releasing it here prevents it from
    // sitting in memory until GC eventually collects it.
    wSrc.width = 0;
    return finalOut;
}


function createWarpedImage(img, cylinderAmount, arcAmount, arcTiltAmount, targetCanvas, lowQuality = false, referenceH = null) {

    const temp = targetCanvas;

    const ctx = temp.getContext("2d");

    if(cylinderAmount === 0 && arcAmount === 0 && arcTiltAmount === 0){

        temp.width = img.width;
        temp.height = img.height;

        ctx.clearRect(0,0,temp.width,temp.height);
        ctx.drawImage(img,0,0);

        return temp;
    }

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";

    // True circular arc geometry.
    // arcAmount (−100…+100) maps to half-angle α (−π/2…+π/2).
    // At ±100 the design bends into a perfect semicircle (180° total sweep).
    const absAlpha   = Math.abs(arcAmount) / 100 * (Math.PI / 2);
    const sinAlpha   = absAlpha < 1e-6 ? absAlpha : Math.sin(absAlpha);
    const arcR       = sinAlpha < 1e-6 ? 0 : (img.width / 2) / sinAlpha;
    const arcCosAlpha = Math.cos(absAlpha);
    // Sagitta = (img.width/2)*tan(α/2); at α=π/2 equals exactly img.width/2.
    const arcSagitta = sinAlpha < 1e-6 ? 0 : arcR * (1 - arcCosAlpha);
    const arcSign    = Math.sign(arcAmount);

    // pad must cover arc sagitta AND the fisheye vertical balloon at the centre.
    const effectH = referenceH || img.height;
    const pad = Math.ceil(arcSagitta)
        + Math.ceil(Math.abs(arcTiltAmount) / 100 * effectH * 0.45);

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

        // Circular arc: arcSign*(R*(cos(nx*α) - cos(α))).
        // At nx=0 (centre) this equals arcSign*arcSagitta; at nx=±1 it equals 0.
        const arcCurve = absAlpha < 1e-6 ? 0
            : arcSign * arcR * (Math.cos(nx * absAlpha) - arcCosAlpha);

        const drawH = img.height * verticalScale;

        // Fisheye vertical effect: each slice is vertically stretched or squashed
        // by an amount that peaks at the centre (nx=0) and falls to zero at edges.
        // Negative (left) → tiltK positive → slice drawn lower + shorter = pinched.
        // Positive (right) → tiltK negative → slice drawn higher + taller = ballooned.
        // Coefficient 0.45 gives near-full pinch / 1.9× balloon at extremes.
        const tiltK = (-arcTiltAmount / 100) * effectH * 0.45 * (1 - nx * nx);

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
        // projection; with normalization the centre spacing is π/2 * sliceW (~3.14px)
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
