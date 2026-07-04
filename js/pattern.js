'use strict';
// ── Pattern Creator ────────────────────────────────────────────────────────────
function _defaultPattern(){
    return { type:'grid', hSpacing:0, vSpacing:0, angle:0, hOffset:0, rotH:0, rotV:0 };
}

// Progressive downsampling: halve dimensions until within 2× of (targetW, targetH).
// Bilinear at 0.5× is excellent; this avoids the aliasing of a single large-to-tiny step.
function _downsampleTile(src, srcW, srcH, targetW, targetH) {
    let cur;
    if (src instanceof HTMLCanvasElement) {
        cur = src;
    } else {
        const tmp = document.createElement('canvas');
        tmp.width = srcW; tmp.height = srcH;
        tmp.getContext('2d').drawImage(src, 0, 0);
        cur = tmp;
    }
    while (cur.width > targetW * 2 || cur.height > targetH * 2) {
        const nw = Math.max(targetW, Math.ceil(cur.width  / 2));
        const nh = Math.max(targetH, Math.ceil(cur.height / 2));
        const next = document.createElement('canvas');
        next.width = nw; next.height = nh;
        const nc = next.getContext('2d');
        nc.imageSmoothingEnabled = true;
        nc.imageSmoothingQuality = 'high';
        nc.drawImage(cur, 0, 0, nw, nh);
        cur = next;
    }
    return cur;
}

function _renderPattern(data, lowQuality = false){
    if(!data.patternMode || !data.patternFabricObj || !data.designObject) return;
    const fc = data.fabricCanvas;
    const W = fc.width, H = fc.height;

    // Render the tile canvas at physical (device) resolution so the pattern is
    // pixel-crisp on high-DPI screens.  All CSS-pixel coordinates are fed to a
    // 2D context pre-scaled by dpr; the resulting canvas is then displayed via
    // patternFabricObj at 1/dpr scale so it occupies the correct CSS area.
    const dpr = window.devicePixelRatio || 1;
    const PW  = Math.round(W * dpr);   // physical canvas width
    const PH  = Math.round(H * dpr);   // physical canvas height

    const obj = data.designObject;
    const s = data.patternSettings || _defaultPattern();

    // Use pre-warp tile source if stored by applyWarpToData - warp is applied
    // to the whole tiled canvas below, so individual tiles must be undistorted.
    const tileEl = data._patternTileSource || obj.getElement();
    if(!tileEl) return;
    const srcW = tileEl.width  || tileEl.naturalWidth  || obj.width;
    const srcH = tileEl.height || tileEl.naturalHeight || obj.height;
    if(srcW < 1 || srcH < 1) return;

    // The master tile is invisible - the pattern canvas renders all tiles
    // including its position, so it shows through the evented-false overlay.
    obj.set({opacity: 0});

    // All dimensions below are in CSS pixels; ctx.scale(dpr,dpr) converts them
    // to physical pixels without having to touch any of the tile math.
    const tileW  = srcW * Math.abs(obj.scaleX);
    const tileH  = srcH * Math.abs(obj.scaleY);
    const stepX  = Math.max(1, tileW * (1 + (s.hSpacing || 0) / 100));
    const stepY  = Math.max(1, tileH * (1 + (s.vSpacing || 0) / 100));
    const aRad   = (s.angle || 0) * Math.PI / 180;
    const cosA   = Math.cos(aRad), sinA = Math.sin(aRad);
    const hOffPx = stepX * ((s.hOffset || 0) / 100);
    const mc     = obj.getCenterPoint();
    const mAngle = obj.angle || 0;

    // ── Pre-compute warp / perspective flags ─────────────────────────────────
    const hasWarp = (data.warpAmount || 0) !== 0 || (data.arcAmount || 0) !== 0 || (data.arcTilt || 0) !== 0;
    const hasPerspective = (data.perspectiveTop || 0) !== 0 || (data.perspectiveLeft || 0) !== 0;

    // Extra padding (CSS pixels) fills the arc/tilt gap at canvas edges.
    // Perspective is applied AFTER the warp crop so its strength is never amplified.
    // arcCurveMax: sagitta in CSS px for a circular arc of half-angle α over width W.
    // At arcAmount=±100, α=π/2 → sagitta = W/2 (perfect semicircle).
    const _absArcAlpha = Math.abs(data.arcAmount || 0) / 100 * (Math.PI / 2);
    const arcCurveMax  = _absArcAlpha < 1e-6 ? 0
        : (W / 2) * Math.tan(_absArcAlpha / 2);
    const tiltMax      = Math.abs(data.arcTilt ?? 0) / 100 * H * 0.45;
    const extraPad     = hasWarp ? Math.ceil(arcCurveMax + 2 * tiltMax) : 0;

    // Physical canvas dimensions at normal DPR (used for warp/perspective/display)
    const offW = Math.round((W + extraPad * 2) * dpr);
    const offH = Math.round((H + extraPad * 2) * dpr);

    // ── Tile-phase supersampling (SS=2) ────────────────────────────────────────
    // Render tiles at SS× physical resolution so each output pixel averages SS²
    // source samples (4-sample SSAA at SS=2).  After the tile loop the supersampled
    // canvas is box-filtered down to normal physical resolution; warp/perspective
    // then run on the normal-resolution canvas so their slice counts are unchanged.
    const SS   = lowQuality ? 1 : 2;
    const ssW  = Math.round((W + extraPad * 2) * dpr * SS);
    const ssH  = Math.round((H + extraPad * 2) * dpr * SS);

    const off = document.createElement('canvas');
    off.width = ssW; off.height = ssH;
    const ctx = off.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    // Pre-scale by dpr×SS so all tile coordinates stay in CSS pixel space
    ctx.scale(dpr * SS, dpr * SS);

    // Use CSS-pixel canvas dimensions for the tile-coverage bounds check
    const cssOffW = W + extraPad * 2;
    const cssOffH = H + extraPad * 2;
    const diagLen = Math.sqrt(cssOffW * cssOffW + cssOffH * cssOffH);
    const nCols = Math.ceil(diagLen / stepX) + 2;
    const nRows = Math.ceil(diagLen / stepY) + 2;
    const margin = Math.sqrt(tileW * tileW + tileH * tileH);

    // ── Progressive downsampling (mipmap-style) ───────────────────────────────
    // When a tile is drawn much smaller than its source a single drawImage step
    // causes aliasing.  Pre-shrink in halving steps to ~2× the SS-scaled display
    // size so the final drawImage only performs a ≤2× reduction - much sharper.
    const physTileW = Math.max(2, Math.round(tileW * dpr * SS));
    const physTileH = Math.max(2, Math.round(tileH * dpr * SS));
    let drawEl = tileEl;
    if (srcW > physTileW * 2 || srcH > physTileH * 2) {
        const dsKey = `${srcW}x${srcH}_${physTileW}x${physTileH}`;
        if (data._dsSrc !== tileEl || data._dsKey !== dsKey) {
            // Sync mipmap: used immediately
            data._dsCanvas = _downsampleTile(tileEl, srcW, srcH, physTileW, physTileH);
            data._dsSrc    = tileEl;
            data._dsKey    = dsKey;
            data._hqCanvas = null;  // invalidate any prior HQ mip

            // Async HQ mip via createImageBitmap (Lanczos/area-average quality).
            // Resolves quickly; triggers a second crisp render automatically.
            if (!lowQuality && typeof createImageBitmap === 'function') {
                const mipEpoch = data._tileEpoch;
                createImageBitmap(tileEl, {
                    resizeWidth:   physTileW * 2,
                    resizeHeight:  physTileH * 2,
                    resizeQuality: 'high',
                }).then(bmp => {
                    // Only apply if tile/key still match (user hasn't moved on)
                    // and the source pixels weren't mutated in place (e.g. eraser)
                    // since this bitmap was snapshotted - tracked via _tileEpoch.
                    if (data._dsKey === dsKey && data._dsSrc === tileEl && data._tileEpoch === mipEpoch) {
                        const hq = document.createElement('canvas');
                        hq.width  = bmp.width;
                        hq.height = bmp.height;
                        hq.getContext('2d').drawImage(bmp, 0, 0);
                        data._hqCanvas = hq;
                        data._hqKey    = dsKey;
                        _renderPattern(data, false);  // re-render with Lanczos mip
                    }
                }).catch(() => {});
            }
        }
        // Prefer the HQ Lanczos mip if it matches the current key
        drawEl = (data._hqCanvas && data._hqKey === dsKey) ? data._hqCanvas : data._dsCanvas;
    }

    for(let row = -nRows; row <= nRows; row++){
        for(let col = -nCols; col <= nCols; col++){
            let gx = col * stepX + row * hOffPx;
            let gy = row * stepY;
            if(s.type === 'brick-h' && Math.abs(row % 2) === 1) gx += stepX / 2;
            if(s.type === 'brick-v' && Math.abs(col % 2) === 1) gy += stepY / 2;

            const rx = gx * cosA - gy * sinA;
            const ry = gx * sinA + gy * cosA;
            // Shift origin by extraPad (CSS px) so the enlarged canvas is fully tiled
            const cx = mc.x + extraPad + rx, cy = mc.y + extraPad + ry;

            if(cx + margin < 0 || cx - margin > cssOffW || cy + margin < 0 || cy - margin > cssOffH) continue;

            const rot = (mAngle + col * (s.rotH || 0) + row * (s.rotV || 0)) * Math.PI / 180;
            const sx  = obj.flipX ? -obj.scaleX : obj.scaleX;
            const sy  = obj.flipY ? -obj.scaleY : obj.scaleY;

            ctx.save();
            ctx.translate(cx, cy);
            ctx.rotate(rot);
            // opacity is handled by patternFabricObj, not per-tile
            ctx.scale(sx, sy);
            // Draw at the original CSS rectangle; ctx already at dpr×SS scale, and
            // drawEl is pre-shrunk so the final step is a gentle ≤2× reduction.
            ctx.drawImage(drawEl, -srcW / 2, -srcH / 2, srcW, srcH);
            ctx.restore();
        }
    }

    // ── Box-filter SS× tile canvas down to normal physical resolution ─────────
    // Each output pixel averages SS² supersampled input pixels → SSAA.
    // Warp and perspective then run on the normal-resolution canvas so their
    // slice counts and arc amplitudes are unchanged.
    let finalCanvas;
    if (SS > 1) {
        const norm = document.createElement('canvas');
        norm.width  = offW; norm.height = offH;
        const normCtx = norm.getContext('2d');
        normCtx.imageSmoothingEnabled = true;
        normCtx.imageSmoothingQuality = 'high';
        normCtx.drawImage(off, 0, 0, offW, offH);
        finalCanvas = norm;
    } else {
        finalCanvas = off;
    }

    // ── Apply warp to the normal-resolution tile canvas, then crop to PW×PH ───
    // Pass arcAmount * dpr so the arc-curve displacement scales for physical pixels.
    // Pass referenceH = PH so tiltK amplitude matches the physical canvas height.

    if(hasWarp){
        if(!data._patternWarpCanvas) data._patternWarpCanvas = document.createElement('canvas');
        finalCanvas = createWarpedImage(
            finalCanvas,
            data.warpAmount, data.arcAmount, data.arcTilt ?? 0,
            data._patternWarpCanvas, lowQuality,
            PH   // referenceH in physical pixels
        );
        // Center-crop back to PW×PH: extra border tiles filled the arc/tilt gap.
        if(finalCanvas.width !== PW || finalCanvas.height !== PH){
            const crop = document.createElement('canvas');
            crop.width = PW; crop.height = PH;
            const cropCtx = crop.getContext('2d');
            cropCtx.imageSmoothingEnabled = true;
            cropCtx.imageSmoothingQuality = 'high';
            const srcX = Math.round((finalCanvas.width  - PW) / 2);
            const srcY = Math.round((finalCanvas.height - PH) / 2);
            cropCtx.drawImage(finalCanvas, srcX, srcY, PW, PH, 0, 0, PW, PH);
            finalCanvas = crop;
        }
    }

    // ── Apply perspective on the PW×PH canvas (after warp crop) ──────────────
    if(hasPerspective){
        finalCanvas = applyPerspectiveDistortion(finalCanvas, data, lowQuality);
        // Fit trim-padded perspective output back to PW×PH (centered draw).
        if(finalCanvas.width !== PW || finalCanvas.height !== PH){
            const fitted = document.createElement('canvas');
            fitted.width = PW; fitted.height = PH;
            const fCtx = fitted.getContext('2d');
            fCtx.imageSmoothingEnabled = true;
            fCtx.imageSmoothingQuality = 'high';
            fCtx.drawImage(
                finalCanvas,
                Math.round((PW - finalCanvas.width)  / 2),
                Math.round((PH - finalCanvas.height) / 2)
            );
            finalCanvas = fitted;
        }
    }

    // ── Burn clip mask into the pixel canvas ─────────────────────────────────
    // Mask paths are stored in CSS pixels; scale the context by dpr so they
    // map correctly onto the physical-pixel finalCanvas.
    if(data.maskEnabled && data.maskType === 'bezier' && (data.maskPath || data.maskPaths?.length)){
        const allPaths = data.maskPaths?.length
            ? data.maskPaths
            : (data.maskPath ? [data.maskPath] : []);
        const cw = finalCanvas.width, ch = finalCanvas.height;
        const masked = document.createElement('canvas');
        masked.width = cw; masked.height = ch;
        const mCtx = masked.getContext('2d');
        mCtx.scale(dpr, dpr);   // CSS-pixel path coords → physical pixels
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
        // Draw finalCanvas at CSS size - the dpr scale converts it to physical
        mCtx.drawImage(finalCanvas, 0, 0, W, H);
        finalCanvas = masked;
    }

    // ── Apply opacity / blend mode; display at CSS size via 1/dpr scale ───────
    data.patternFabricObj.clipPath = null;
    data.patternFabricObj.set({
        opacity: data.opacity ?? 1,
        globalCompositeOperation: _blendToGCO(data.blendMode ?? 'normal'),
        width:  PW,
        height: PH,
        scaleX: 1 / dpr,
        scaleY: 1 / dpr,
        left: 0,
        top:  0,
    });
    data.patternFabricObj.setElement(finalCanvas);
    data.patternFabricObj.dirty = true;
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

