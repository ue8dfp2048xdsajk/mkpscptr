'use strict';
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
        obj.dirty = true;
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
    obj.dirty = true;
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
            const cx = W / 2, cy = H / 2;

            // Pre-compute shared transform deltas
            const zr   = oldScale > 0 ? newScale / oldScale : 1;
            const dRad = (newRotation - oldRotation) * Math.PI / 180;
            const dAngle = newRotation - oldRotation;
            const cos  = Math.cos(dRad), sin = Math.sin(dRad);
            const dPanX = (newX - oldX) * W;
            const dPanY = (newY - oldY) * H;

            // Apply to every design object in this window (main + duplicates/uploads)
            const allObjs = [d.designObject, ...(d.extraDesignObjects || [])];
            allObjs.forEach(obj => {
                if (!obj) return;

                // Zoom: scale position around canvas centre, scale object size
                let left = cx + (obj.left - cx) * zr;
                let top  = cy + (obj.top  - cy) * zr;

                // Rotation: rotate position around canvas centre by delta angle
                if(dRad !== 0){
                    const dx = left - cx, dy = top - cy;
                    left = cx + dx * cos - dy * sin;
                    top  = cy + dx * sin + dy * cos;
                }

                // Pan: shift by delta fraction of canvas size
                left += dPanX;
                top  += dPanY;

                obj.set({
                    left,
                    top,
                    scaleX: obj.scaleX * zr,
                    scaleY: obj.scaleY * zr,
                    angle:  (obj.angle || 0) + dAngle,
                });
                obj.setCoords();
            });

            if(d.patternMode) _renderPattern(d, false);
            d.fabricCanvas.requestRenderAll();
        }
    });
    _markDirty();
}

