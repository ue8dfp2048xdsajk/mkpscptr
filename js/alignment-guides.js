'use strict';

// Alignment guides — off by default; toggle via control panel or G.
// Visible only while dragging or nudging a design layer.

var alignmentGuidesEnabled = false;

var _guideRafPending = false;
var _guidePendingData = null;
var _guidePendingObj  = null;

var _GUIDE_CENTER_COLOR = '#E040FB';
var _GUIDE_ALIGN_COLOR  = '#00BCD4';
var _GUIDE_THRESHOLD_PX = 5;

function _guideSnapThreshold() {
    const scale = (typeof _vpScale === 'number' && _vpScale > 0) ? _vpScale : 1;
    return _GUIDE_THRESHOLD_PX / scale;
}

function _guideNear(a, b, threshold) {
    return Math.abs(a - b) <= threshold;
}

function _getCanvasDisplayScale(data) {
    const fc = data?.fabricCanvas;
    if (!fc) return { sx: 1, sy: 1, w: 0, h: 0 };
    const previewW = fc.getWidth();
    const previewH = fc.getHeight();
    if (!previewW || !previewH) return { sx: 1, sy: 1, w: 0, h: 0 };
    const displayW = data.wrapperEl?.offsetWidth || previewW;
    const displayH = Math.round(previewH * displayW / previewW);
    return {
        sx: displayW / previewW,
        sy: displayH / previewH,
        w:  displayW,
        h:  displayH,
    };
}

function _getCellContentOffset(data) {
    const cell = data?.cellEl;
    const wrap = data?.wrapperEl;
    if (!cell) return { left: 0, top: 0 };
    return {
        left: cell.offsetLeft + (wrap?.offsetLeft || 0),
        top:  cell.offsetTop  + (wrap?.offsetTop  || 0),
    };
}

function _getObjectContainerRect(data, obj) {
    if (!data?.fabricCanvas || !obj || !data.cellEl) return null;
    const { sx, sy } = _getCanvasDisplayScale(data);
    const off = _getCellContentOffset(data);
    if (typeof obj.getBoundingRect !== 'function') return null;
    const br = obj.getBoundingRect(true, true);
    const left   = off.left + br.left * sx;
    const top    = off.top  + br.top  * sy;
    const width  = br.width  * sx;
    const height = br.height * sy;
    return {
        left, top,
        right:  left + width,
        bottom: top  + height,
        cx: left + width  / 2,
        cy: top  + height / 2,
        width, height,
    };
}

function _getCanvasDisplayBounds(data) {
    const { w, h } = _getCanvasDisplayScale(data);
    const off = _getCellContentOffset(data);
    return {
        left:   off.left,
        top:    off.top,
        right:  off.left + w,
        bottom: off.top  + h,
        cx:     off.left + w / 2,
        cy:     off.top  + h / 2,
        width:  w,
        height: h,
    };
}

function _gridNeighbors(index) {
    const n = canvasData.length;
    const cols = (typeof _numColumns === 'number' && _numColumns > 0) ? _numColumns : 4;
    const col = index % cols;
    return {
        left:  col > 0 ? index - 1 : null,
        right: col < cols - 1 && index + 1 < n ? index + 1 : null,
        above: index >= cols ? index - cols : null,
        below: index + cols < n ? index + cols : null,
    };
}

function _neighborReferenceRects(nIdx) {
    const nd = canvasData[nIdx];
    if (!nd?.fabricCanvas) return [];
    if (typeof getAllDesignObjects !== 'function') return [];
    return getAllDesignObjects(nd).filter(o => o && typeof o.getBoundingRect === 'function');
}

function _boundsUnion(a, b) {
    return {
        left:   Math.min(a.left, b.left),
        top:    Math.min(a.top, b.top),
        right:  Math.max(a.right, b.right),
        bottom: Math.max(a.bottom, b.bottom),
    };
}

function _computeAlignmentGuideLines(data, movingObj) {
    if (!alignmentGuidesEnabled || !data || !movingObj) return [];

    const threshold = _guideSnapThreshold();
    const moving = _getObjectContainerRect(data, movingObj);
    if (!moving) return [];

    const lines = [];
    const seen = new Set();

    function addLine(kind, x1, y1, x2, y2) {
        const key = kind + ':' +
            Math.round(x1) + ',' + Math.round(y1) + ':' +
            Math.round(x2) + ',' + Math.round(y2);
        if (seen.has(key)) return;
        seen.add(key);
        lines.push({ kind, x1, y1, x2, y2 });
    }

    const canvas = _getCanvasDisplayBounds(data);

    if (_guideNear(moving.cx, canvas.cx, threshold)) {
        addLine('center', canvas.cx, canvas.top, canvas.cx, canvas.bottom);
    }
    if (_guideNear(moving.cy, canvas.cy, threshold)) {
        addLine('center', canvas.left, canvas.cy, canvas.right, canvas.cy);
    }

    const idx = canvasData.indexOf(data);
    if (idx === -1) return lines;

    const neighbors = _gridNeighbors(idx);
    const myBounds = canvas;

    function checkHorizontalNeighbor(nIdx) {
        if (nIdx == null) return;
        const nd = canvasData[nIdx];
        if (!nd) return;
        const nBounds = _getCanvasDisplayBounds(nd);
        const span = _boundsUnion(myBounds, nBounds);
        _neighborReferenceRects(nIdx).forEach(refObj => {
            const ref = _getObjectContainerRect(nd, refObj);
            if (!ref) return;
            if (_guideNear(moving.top, ref.top, threshold)) {
                addLine('align', span.left, ref.top, span.right, ref.top);
            }
            if (_guideNear(moving.bottom, ref.bottom, threshold)) {
                addLine('align', span.left, ref.bottom, span.right, ref.bottom);
            }
        });
    }

    function checkVerticalNeighbor(nIdx) {
        if (nIdx == null) return;
        const nd = canvasData[nIdx];
        if (!nd) return;
        const nBounds = _getCanvasDisplayBounds(nd);
        const span = _boundsUnion(myBounds, nBounds);
        _neighborReferenceRects(nIdx).forEach(refObj => {
            const ref = _getObjectContainerRect(nd, refObj);
            if (!ref) return;
            if (_guideNear(moving.left, ref.left, threshold)) {
                addLine('align', ref.left, span.top, ref.left, span.bottom);
            }
            if (_guideNear(moving.right, ref.right, threshold)) {
                addLine('align', ref.right, span.top, ref.right, span.bottom);
            }
        });
    }

    checkHorizontalNeighbor(neighbors.left);
    checkHorizontalNeighbor(neighbors.right);
    checkVerticalNeighbor(neighbors.above);
    checkVerticalNeighbor(neighbors.below);

    return lines;
}

function _renderAlignmentGuideLines(lines) {
    const overlay = document.getElementById('guideOverlay');
    const svg     = document.getElementById('guideOverlaySvg');
    const cc      = document.getElementById('canvasContainer');
    if (!overlay || !svg || !cc) return;

    if (!lines.length) {
        overlay.hidden = true;
        svg.innerHTML = '';
        return;
    }

    const w = cc.scrollWidth  || cc.offsetWidth;
    const h = cc.scrollHeight || cc.offsetHeight;
    svg.setAttribute('width', w);
    svg.setAttribute('height', h);
    svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);

    const parts = lines.map(line => {
        const color = line.kind === 'center' ? _GUIDE_CENTER_COLOR : _GUIDE_ALIGN_COLOR;
        return '<line x1="' + line.x1 + '" y1="' + line.y1 +
            '" x2="' + line.x2 + '" y2="' + line.y2 +
            '" stroke="' + color + '" stroke-width="1" stroke-dasharray="4 4" opacity="0.75" />';
    });
    svg.innerHTML = parts.join('');
    overlay.hidden = false;
}

function clearAlignmentGuides() {
    _guidePendingData = null;
    _guidePendingObj  = null;
    _renderAlignmentGuideLines([]);
}

function _flushAlignmentGuides() {
    _guideRafPending = false;
    if (!alignmentGuidesEnabled || !_guidePendingData || !_guidePendingObj) {
        clearAlignmentGuides();
        return;
    }
    const lines = _computeAlignmentGuideLines(_guidePendingData, _guidePendingObj);
    _renderAlignmentGuideLines(lines);
}

function scheduleAlignmentGuidesUpdate(data, obj) {
    if (!alignmentGuidesEnabled) return;
    _guidePendingData = data;
    _guidePendingObj  = obj;
    if (_guideRafPending) return;
    _guideRafPending = true;
    requestAnimationFrame(_flushAlignmentGuides);
}

function applyGuideOverlayTransform(transform) {
    const overlay = document.getElementById('guideOverlay');
    if (overlay) overlay.style.transform = transform;
}

function syncAlignmentGuidesToggleUI() {
    const btn = document.getElementById('toolGuidesBtn');
    if (!btn) return;
    btn.classList.toggle('tool-active', alignmentGuidesEnabled);
    btn.setAttribute('aria-pressed', alignmentGuidesEnabled ? 'true' : 'false');
}

function setAlignmentGuidesEnabled(on) {
    alignmentGuidesEnabled = !!on;
    syncAlignmentGuidesToggleUI();
    if (!alignmentGuidesEnabled) clearAlignmentGuides();
    if (typeof autoSaveSession === 'function') autoSaveSession();
}

function toggleAlignmentGuides() {
    setAlignmentGuidesEnabled(!alignmentGuidesEnabled);
}

function applyAlignmentGuidesFromSnapshot(snapshot) {
    alignmentGuidesEnabled = !!(snapshot && snapshot.alignmentGuidesEnabled);
    syncAlignmentGuidesToggleUI();
    clearAlignmentGuides();
}

function flashAlignmentGuides(data, obj) {
    if (!alignmentGuidesEnabled || !data || !obj) return;
    const lines = _computeAlignmentGuideLines(data, obj);
    _renderAlignmentGuideLines(lines);
    requestAnimationFrame(clearAlignmentGuides);
}

document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('toolGuidesBtn');
    if (btn) {
        btn.addEventListener('click', () => toggleAlignmentGuides());
        syncAlignmentGuidesToggleUI();
    }
});
