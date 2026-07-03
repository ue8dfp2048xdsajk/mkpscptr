// ── PRO effect detection, watermark, and star badges ─────────────────────────
// Depends on global _userPlan (declared in app.js) and _markDirty (app.js).

var _watermarkInteractionDepth = 0;

function _beginWatermarkInteraction() {
    _watermarkInteractionDepth++;
}

function _endWatermarkInteraction() {
    _watermarkInteractionDepth = Math.max(0, _watermarkInteractionDepth - 1);
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

// Draw watermark over a canvas (called from after:render).
// Applies to: all free-plan canvases with a design, AND
//             any starred (PRO-feature) windows on the Starter plan.
// Uses direct rotated-grid drawing (no tile repeat) so density is
// uniform across the whole canvas with no edge-clipping gaps.
function _drawWatermarkOnCanvas(data) {
    var isFree    = _userPlan === 'free';
    var isStarred = _userPlan === 'starter' && _windowIsProGated(data);
    if (!isFree && !isStarred) return;
    if (_watermarkInteractionActive()) return;
    if (!data.fabricCanvas || !data.designObject) return;
    var fc  = data.fabricCanvas;
    if (fc._currentTransform) return;
    var ctx = fc.contextContainer;
    var W   = fc.width;
    var H   = fc.height;

    ctx.save();

    // Rotate the whole drawing context so all text lays out diagonally
    ctx.translate(W / 2, H / 2);
    ctx.rotate(-Math.PI / 5.5); // ~-32.7°

    // Set text style once for all instances
    ctx.font          = 'bold 12px Arial, sans-serif';
    ctx.textAlign     = 'center';
    ctx.textBaseline  = 'middle';
    ctx.shadowColor   = 'rgba(0,0,0,0.50)';
    ctx.shadowBlur    = 3;
    ctx.shadowOffsetX = 1;
    ctx.shadowOffsetY = 1;

    // rowPitch: spacing between rows (perpendicular to text direction).
    // Smaller = denser.  52px gives ~25% gap between rows → ~80% coverage.
    var rowPitch = 52;
    // colPitch: spacing between text blocks along the text direction.
    var colPitch = 155;

    var diag = Math.sqrt(W * W + H * H);
    var rows = Math.ceil(diag / rowPitch) + 1;
    var cols = Math.ceil(diag / colPitch) + 1;

    // Draw all line-1 text first (batching same fillStyle avoids redundant GPU state changes)
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    for (var r = -rows; r <= rows; r++) {
        var y   = r * rowPitch;
        var xOff = (r & 1) ? colPitch / 2 : 0; // brick offset on odd rows
        for (var c = -cols; c <= cols; c++) {
            ctx.fillText('MOCKUP SCRIPTER', c * colPitch + xOff, y - 11);
        }
    }
    // Draw all line-2 text
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    for (var r = -rows; r <= rows; r++) {
        var y   = r * rowPitch;
        var xOff = (r & 1) ? colPitch / 2 : 0;
        for (var c = -cols; c <= cols; c++) {
            ctx.fillText('mockupscripter.com', c * colPitch + xOff, y + 7);
        }
    }

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
        ? 'Uses a PRO feature — exports fine on your plan'
        : 'Uses a PRO feature — upgrade to export this window';
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
    return getAllDesignObjects(data).some(function (obj) {
        return _layerFxIsPro(obj && obj._fx);
    });
}

// Starter paste policy: force gate even when payload is blur-only (spec).
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

function _windowHasInvert(data) {
    if (!data) return false;
    if (data.invertedMain) return true;
    return (data.invertedExtras || []).some(Boolean);
}

function _recomputeProEffect(data) {
    return _syncProEffect(data);
}
