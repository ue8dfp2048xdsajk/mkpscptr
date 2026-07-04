'use strict';
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
    // For destination-out (eraser) the colour is irrelevant - only alpha matters
    const rgb = compositeOp === 'destination-out' ? '0,0,0' : hexToRgb(hexColor);

    if(softness <= 0){
        // Fully hard - plain filled circle
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


