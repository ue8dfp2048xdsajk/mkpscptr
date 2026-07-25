// ── PRO effect detection, watermark, and star badges ─────────────────────────
// Depends on global _userPlan (declared in app.js) and _markDirty (app.js).

var _watermarkInteractionDepth = 0;
var _exportCaptureDepth = 0;
var _exportCapturePlan = null;

function _beginExportCapture(verifiedPlan) {
    _exportCaptureDepth++;
    _exportCapturePlan = verifiedPlan;
}

function _endExportCapture() {
    _exportCaptureDepth = Math.max(0, _exportCaptureDepth - 1);
    if (_exportCaptureDepth === 0) _exportCapturePlan = null;
}

function _effectivePlanForGating() {
    if (_exportCaptureDepth > 0 && _exportCapturePlan) return _exportCapturePlan;
    return _userPlan;
}

function _beginWatermarkInteraction() {
    _watermarkInteractionDepth++;
}

function _endWatermarkInteraction() {
    _watermarkInteractionDepth = Math.max(0, _watermarkInteractionDepth - 1);
    if (_watermarkInteractionDepth === 0) _refreshWatermarkedCanvases();
}

function _canvasNeedsWatermark(data) {
    if (!data?.fabricCanvas || !data.designObject) return false;
    var plan = _effectivePlanForGating();
    if (plan === 'free') return true;
    if (plan === 'starter' && _windowIsProGated(data)) return true;
    return false;
}

// Re-paint watermarks after pan/transform suppression ends (after:render skips while active).
function _refreshWatermarkedCanvases() {
    if (typeof canvasData === 'undefined') return;
    canvasData.forEach(d => {
        if (_canvasNeedsWatermark(d)) d.fabricCanvas.requestRenderAll();
    });
}

function _watermarkInteractionActive() {
    if (_watermarkInteractionDepth > 0) return true;
    if (typeof _vpPanning !== 'undefined' && _vpPanning) return true;
    return false;
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

// Baked once: 2-row brick tile matching the old fillText grid (col 155 / row 52).
// Per-frame draw is createPattern + one fillRect instead of hundreds of shadowed texts.
var _wmTileCanvas = null;
var _WM_COL_PITCH = 155;
var _WM_ROW_PITCH = 52;

function _ensureWatermarkTileCanvas() {
    if (_wmTileCanvas) return _wmTileCanvas;
    if (typeof document === 'undefined') return null;
    var colPitch = _WM_COL_PITCH;
    var rowPitch = _WM_ROW_PITCH;
    var c = document.createElement('canvas');
    c.width  = colPitch;
    c.height = rowPitch * 2;
    var t = c.getContext('2d');
    if (!t) return null;

    t.font         = 'bold 14px Arial, sans-serif';
    t.textAlign    = 'center';
    t.textBaseline = 'middle';
    t.shadowColor  = 'rgba(0,0,0,0.65)';
    t.shadowBlur   = 4;
    t.shadowOffsetX = 1;
    t.shadowOffsetY = 1;

    function drawPair(x, y) {
        t.fillStyle = 'rgba(255,255,255,0.58)';
        t.fillText('MOCKUP RABBIT', x, y - 11);
        t.fillStyle = 'rgba(255,255,255,0.48)';
        t.fillText('mockuprabbit.com', x, y + 7);
    }
    // Even row centered on the tile seam (x=0); odd row brick-shifted by half pitch.
    drawPair(0, rowPitch * 0.5);
    drawPair(colPitch / 2, rowPitch * 1.5);

    _wmTileCanvas = c;
    return _wmTileCanvas;
}

// Draw watermark over a canvas (called from after:render).
// Applies to: all free-plan canvases with a design, AND
//             any starred (PRO-feature) windows on the Starter plan.
function _drawWatermarkOnCanvas(data) {
    var plan      = _effectivePlanForGating();
    var isFree    = plan === 'free';
    var isStarred = plan === 'starter' && _windowIsProGated(data);
    if (!isFree && !isStarred) return;
    // Suppress during viewport/hand pan and design move/scale/rotate transforms.
    if (_watermarkInteractionActive()) return;
    if (!data.fabricCanvas || !data.designObject) return;
    var fc  = data.fabricCanvas;
    var ctx = fc.contextContainer;
    var W   = fc.width;
    var H   = fc.height;

    var tile = _ensureWatermarkTileCanvas();
    if (!tile || typeof ctx.createPattern !== 'function') return;
    var pattern = ctx.createPattern(tile, 'repeat');
    if (!pattern) return;

    ctx.save();
    // Rotate so the axis-aligned pattern stamps on a diagonal, same as before.
    ctx.translate(W / 2, H / 2);
    ctx.rotate(-Math.PI / 5.5); // ~-32.7°
    ctx.fillStyle = pattern;
    var diag = Math.sqrt(W * W + H * H);
    ctx.fillRect(-diag, -diag, diag * 2, diag * 2);
    ctx.restore();
}

// Show / refresh the ⭐ PRO-feature badge on a canvas wrapper
function _updateProStarBadge(data) {
    if (!data.wrapperEl) return;
    // Prefer the outer cell (overflow-visible) so the badge sits above the window.
    var host = data.cellEl || data.wrapperEl;
    var existing = host.querySelector('.pro-star-badge');
    if (existing) existing.remove();
    if (!data.hasProEffect) return;
    var badge = document.createElement('span');
    badge.className = 'pro-star-badge' +
        (_userPlan === 'pro' ? ' pro-star-green' : ' pro-star-yellow');
    badge.textContent = '⭐ PRO';
    badge.title = _userPlan === 'pro'
        ? 'Uses a PRO feature - exports fine on your plan'
        : 'Uses a PRO feature - upgrade to export this window';
    host.appendChild(badge);
}

function _layerFxIsPro(fx) {
    if (!fx) return false;
    if ((fx.warpAmount || 0) !== 0) return true;
    if ((fx.arcAmount || 0) !== 0) return true;
    if ((fx.arcTilt || 0) !== 0) return true;
    if ((fx.perspectiveTop || 0) !== 0) return true;
    if ((fx.perspectiveLeft || 0) !== 0) return true;
    if ((fx.blendMode || 'normal') !== 'normal') return true;
    return false;
}

function _markObjectBakedPro(obj) {
    if (obj) obj._carriesBakedPro = true;
}

function _objectCarriesBakedPro(obj) {
    return !!(obj && obj._carriesBakedPro);
}

function _layerCarriesBakedProWork(data, obj, layerType, layerIdx) {
    if (_objectCarriesBakedPro(obj)) return true;
    if (layerType === 'design' && data.meshWarpApplied) return true;
    if (layerType === 'design' &&
        data.designOriginal && data.initialDesignOriginal &&
        data.designOriginal !== data.initialDesignOriginal) return true;
    return false;
}

function _windowHasProBlend(data) {
    if (!data) return false;
    if ((data.blendMode || 'normal') !== 'normal') return true;
    return getAllDesignObjects(data).some(function (obj) {
        return obj && obj._fx && (obj._fx.blendMode || 'normal') !== 'normal';
    });
}

// Pure detector: true when live window state uses any PRO effect (spec list).
function _windowHasProEffect(data) {
    if (!data) return false;
    if ((data.warpAmount    || 0) !== 0) return true;
    if ((data.arcAmount     || 0) !== 0) return true;
    if ((data.arcTilt       || 0) !== 0) return true;
    if ((data.perspectiveTop  || 0) !== 0) return true;
    if ((data.perspectiveLeft || 0) !== 0) return true;
    if (data.patternMode) return true;
    if (data.maskEnabled) return true;
    if (data.colorLayerFabricObj) return true;
    if (data.designOriginal && data.initialDesignOriginal &&
        data.designOriginal !== data.initialDesignOriginal) return true;
    if (data.bgAdjust) {
        var a = data.bgAdjust;
        if ((a.hue || 0) !== 0 || (a.saturation || 0) !== 0 ||
            (a.brightness || 0) !== 0 || (a.contrast || 0) !== 0) return true;
    }
    if (data.bgCrop) {
        var bc = data.bgCrop;
        if ((bc.x || 0) !== 0 || (bc.y || 0) !== 0 || (bc.scale || 1) !== 1 ||
            (bc.rotation || 0) !== 0 || (bc.aspect || 0) !== 0) return true;
    }
    if (data.meshWarpApplied) return true;
    if (_windowHasProBlend(data)) return true;
    if (_windowHasInvert(data)) return true;
    if (getAllDesignObjects(data).some(_objectCarriesBakedPro)) return true;
    return getAllDesignObjects(data).some(function (obj) {
        return _layerFxIsPro(obj && obj._fx);
    });
}

// True when window or any layer uses PRO gating (live effects or baked lineage).
function _windowIsProGated(data) {
    if (!data) return false;
    return _windowHasProEffect(data) || !!data.forceProBadge;
}

// Sync cached hasProEffect + DOM badge from live state. Single write path.
function _syncProEffect(data) {
    if (!data) return false;
    if (_windowHasProEffect(data)) data.forceProBadge = false;
    const gated = _windowIsProGated(data);
    const wasMarked = data.hasProEffect;
    data.hasProEffect = gated;
    _updateProStarBadge(data);
    if (gated !== wasMarked) _markDirty();
    return gated;
}

function _transformsContainProEffect(t) {
    if (!t) return false;
    if (t.patternMode) return true;
    if (t.invertActive) return true;
    const fx = t.designFx || t;
    if ((fx.warpAmount || 0) !== 0) return true;
    if ((fx.arcAmount || 0) !== 0) return true;
    if ((fx.arcTilt || 0) !== 0) return true;
    if ((fx.perspectiveTop || 0) !== 0) return true;
    if ((fx.perspectiveLeft || 0) !== 0) return true;
    if ((fx.blendMode || 'normal') !== 'normal') return true;
    return false;
}

// True when a Copy Layer clipboard payload contains PRO effect values.
function _copiedLayerPayloadIsPro(cl) {
    if (!cl) return false;
    if (cl.srcCarriesBakedPro) return true;
    if (cl.type === 'extra') return _layerFxIsPro(cl.fx);
    return _transformsContainProEffect({
        designFx: {
            warpAmount:      cl.designWarpAmount      ?? 0,
            arcAmount:       cl.designArcAmount       ?? 0,
            arcTilt:         cl.designArcTilt         ?? 0,
            perspectiveTop:  cl.designPerspectiveTop  ?? 0,
            perspectiveLeft: cl.designPerspectiveLeft ?? 0,
            blendMode: 'normal',
        },
    });
}

// Instant ⭐ before heavy applyWarpToData / effect pipeline when payload is PRO.
function _applyPasteProSync(data, plan, payloadIsPro) {
    if (!data || !payloadIsPro) return;
    if (plan === 'pro') {
        _syncProEffect(data);
        return;
    }
    data.forceProBadge = true;
    _syncProEffect(data);
}

// Reconcile badge + trigger watermark after paste apply completes.
function _finishPasteProSync(data) {
    if (!data) return;
    if (!_windowHasProEffect(data)) data.forceProBadge = false;
    _syncProEffect(data);
    if (data.fabricCanvas) data.fabricCanvas.requestRenderAll();
}

function _windowHasInvert(data) {
    if (!data) return false;
    if (data.invertedMain) return true;
    return (data.invertedExtras || []).some(Boolean);
}

function _recomputeProEffect(data) {
    return _syncProEffect(data);
}
