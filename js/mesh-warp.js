'use strict';
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

        // When pattern mode is on the visible surface is patternFabricObj (W×H overlay).
        // Expand bounds to the full canvas so the warp grid and rasterised source cover
        // the whole pattern sheet rather than the invisible designObject bounding box.
        const hasPattern = !!(grpData.patternMode && grpData.patternFabricObj);
        group.wasPatternMode = hasPattern;

        let grpBounds;
        if (hasPattern) {
            grpBounds = { left: 0, top: 0, width: grpFc.width, height: grpFc.height };
        } else {
            const rects  = grpObjs.map(o => o.getBoundingRect(true, true));
            const bMinX  = Math.min(...rects.map(r => r.left));
            const bMinY  = Math.min(...rects.map(r => r.top));
            const bMaxX  = Math.max(...rects.map(r => r.left + r.width));
            const bMaxY  = Math.max(...rects.map(r => r.top  + r.height));
            grpBounds = { left: bMinX, top: bMinY, width: bMaxX - bMinX, height: bMaxY - bMinY };
        }

        grpAllFObjs.forEach(o => {
            if (!grpObjs.includes(o)) {
                o._warpHiddenVis = o.visible; o.visible = false;
            }
        });
        const savedBg  = grpFc.backgroundImage;
        if (savedBg) grpFc.backgroundImage = null;
        const savedSel = new Set(selectedDesigns);
        selectedDesigns.clear();
        grpFc.discardActiveObject();

        const lc  = grpFc.lowerCanvasEl;
        const dpr = Math.max(1, lc.width / grpFc.getWidth());
        // Use grpBounds.left/top so coords are defined for both the pattern
        // (left=0, top=0) and normal (left=bMinX, top=bMinY) paths.
        const lcX = Math.round(grpBounds.left * dpr);
        const lcY = Math.round(grpBounds.top  * dpr);
        const lcW = Math.max(1, Math.round(grpBounds.width  * dpr));
        const lcH = Math.max(1, Math.round(grpBounds.height * dpr));

        const srcCanvas = document.createElement('canvas');
        srcCanvas.width  = lcW;
        srcCanvas.height = lcH;
        const sCtx = srcCanvas.getContext('2d');
        sCtx.imageSmoothingEnabled = true;
        sCtx.imageSmoothingQuality = 'high';

        if (hasPattern && grpData.patternFabricObj) {
            // Read the pattern overlay's own pixel canvas — it is a transparent
            // canvas with just the tiles, no Fabric background colour baked in.
            // Drawing this in the warp preview lets the real background show through.
            const pEl = grpData.patternFabricObj.getElement();
            if (pEl) sCtx.drawImage(pEl, 0, 0, lcW, lcH);
        } else {
            grpFc.renderAll();
            sCtx.drawImage(lc, lcX, lcY, lcW, lcH, 0, 0, lcW, lcH);
        }

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
    // Also hide patternFabricObj so only the live warp preview is shown (not
    // the original unwarped pattern underneath it).
    warpAllGroups.forEach(({ targets: grpObjs, ownerData: grpData }) => {
        grpObjs.forEach(o => { o._warpWasVisible = o.visible; o.visible = false; });
        if (grpData.patternFabricObj) {
            grpData.patternFabricObj._warpPatternVis = grpData.patternFabricObj.visible;
            grpData.patternFabricObj.visible = false;
        }
    });

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

    document.getElementById('designWarpBtn').textContent      = 'Exit Warp (W)';
    document.getElementById('warpModeControls').style.display = 'inline-flex';
    document.querySelectorAll('.canvas-wrapper').forEach(w => w.style.cursor = 'crosshair');
}

// Swap selected fabric design object(s) for a baked mesh-warp result canvas.
function _swapInBakedDesign(data, applyObjs, outCanvas, left, top, dpr, wasPatternMode) {
    const fc   = data.fabricCanvas;
    const ps   = data.previewScale || 1;
    const newImg = new fabric.Image(outCanvas, {
        left:            left,
        top:             top,
        scaleX:          1 / dpr,
        scaleY:          1 / dpr,
        selectable:      true,
        evented:         true,
        transparentCorners: false,
        cornerColor:     'blue',
        cornerStyle:     'circle',
    });

    const isMain    = applyObjs.includes(data.designObject);
    const newExtras = (data.extraDesignObjects || []).filter(o => !applyObjs.includes(o));

    if (isMain) {
        data.designOriginal  = outCanvas;
        data.warpCanvas      = null;
        data.x               = left;
        data.y               = top;
        data.scaleX          = (1 / dpr) / ps;
        data.scaleY          = (1 / dpr) / ps;
        data.rotation        = 0;
        data.warpAmount      = 0;
        data.arcAmount       = 0;
        data.arcTilt         = 0;
        data.perspectiveTop  = 0;
        data.perspectiveLeft = 0;
    } else {
        applyObjs.forEach(obj => {
            const idx = (data.extraDesignObjects || []).indexOf(obj);
            if (idx !== -1) {
                if (!data.extraDesignOriginals) data.extraDesignOriginals = [];
                data.extraDesignOriginals[idx] = outCanvas;
            }
        });
    }

    newImg._ownerData = data;
    newImg._fx        = _defaultFx(data);

    if (wasPatternMode) _togglePatternMode(data, false);

    applyObjs.forEach(obj => fc.remove(obj));
    fc.add(newImg);

    if (isMain) data.designObject = newImg;
    else newExtras.push(newImg);
    data.extraDesignObjects = newExtras;

    attachFabricEvents(data, newImg);
    applyClipMaskToObject(newImg, data);
    addClipOverlay(data);

    fc.setActiveObject(newImg);
    selectedDesigns.add(newImg);
    fc.requestRenderAll();

    data.meshWarpApplied = true;
    return newImg;
}

// Restore a baked mesh-warp from undo/redo snapshot (same geometry path as Apply).
function _restoreBakedMeshWarpItem(d, item) {
    const st  = item.state;
    const ps  = d.previewScale || 1;
    const left = st.x;
    const top  = st.y;
    const scaleX = st.scaleX ?? st.scale ?? 1;
    const dpr = scaleX > 0 ? 1 / (scaleX * ps) : 1;
    const outCanvas = item.original;

    let applyObjs = [];
    if (item.wasMain !== false) {
        if (d.designObject) applyObjs = [d.designObject];
    } else if (item.warpedExtraIdx >= 0) {
        const obj = d.extraDesignObjects?.[item.warpedExtraIdx];
        if (obj) applyObjs = [obj];
    }
    if (!applyObjs.length && d.designObject) applyObjs = [d.designObject];

    d.designOriginal = outCanvas;
    _swapInBakedDesign(d, applyObjs, outCanvas, left, top, dpr, false);
    _markProEffect(d);
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

            secondaryResults.push({ ownerData: grp.ownerData, targets: grp.targets, result: grpResult, wasPatternMode: grp.wasPatternMode });
        }
    }

    // Restore target object visibility for ALL groups regardless of apply/cancel.
    // On cancel also restore patternFabricObj (apply removes it via _togglePatternMode).
    allGroups.forEach(({ targets: grpObjs, ownerData: grpData }) => {
        grpObjs.forEach(o => {
            o.visible = (o._warpWasVisible !== undefined) ? o._warpWasVisible : true;
            delete o._warpWasVisible;
        });
        if (grpData.patternFabricObj) {
            if (!apply && grpData.patternFabricObj._warpPatternVis !== undefined)
                grpData.patternFabricObj.visible = grpData.patternFabricObj._warpPatternVis;
            delete grpData.patternFabricObj._warpPatternVis;
        }
    });

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
    document.getElementById('designWarpBtn').textContent      = 'Warp Mesh (W)';
    document.getElementById('warpModeControls').style.display = 'none';

    if (renderResult && applyData) {
        // Capture the PRE-WARP state (designOriginal + full window snapshot) for
        // every affected window BEFORE any mutation so undo can reconstruct it.
        const warpUndoItems = allGroups
            .map(({ ownerData: d, targets: grpObjs }) => ({
                idx: canvasData.indexOf(d),
                state: captureWindowState(d),
                original: d.designOriginal,
                baked: false,
                wasMain: grpObjs.includes(d.designObject),
                warpedExtraIdx: grpObjs.includes(d.designObject)
                    ? -1
                    : (d.extraDesignObjects || []).indexOf(grpObjs[0]),
            }))
            .filter(item => item.idx !== -1);
        if (warpUndoItems.length) {
            globalUndoStack.push({ type: 'warp', items: warpUndoItems });
            if (globalUndoStack.length > MAX_UNDO_HISTORY) globalUndoStack.shift();
            globalRedoStack = [];
            updateUndoRedoButtons();
        }

        const { canvas: outCanvas, left, top, dpr = 1 } = renderResult;

        _swapInBakedDesign(
            applyData, applyObjs, outCanvas, left, top, dpr,
            allGroups[0]?.wasPatternMode
        );

        // Apply secondary group results with the same pattern.
        for (const { ownerData: grpData, targets: grpObjs, result: grpResult, wasPatternMode: grpWasPattern } of secondaryResults) {
            const { canvas: outCanvas2, left: left2, top: top2, dpr: dpr2 = 1 } = grpResult;
            _swapInBakedDesign(grpData, grpObjs, outCanvas2, left2, top2, dpr2, grpWasPattern);
        }

        refreshFabricHandles();
        updateWindowBorders();
        updateLayerButtons();
        syncSliders();
    } else {
        // Cancel — re-render every involved canvas with the restored originals.
        allGroups.forEach(({ ownerData: d }) => d.fabricCanvas.requestRenderAll());
        refreshFabricHandles();
        updateWindowBorders();
        updateLayerButtons();
    }
}

window.addEventListener('mouseup', () => { if (designWarpMode) warpDragRC = null; });

