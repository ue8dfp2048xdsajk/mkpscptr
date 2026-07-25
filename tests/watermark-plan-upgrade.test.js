/**
 * @jest-environment jsdom
 *
 * End-to-end simulation: watermarks disappear instantly after a plan upgrade.
 *
 * Loads js/pro-gating.js (watermark + PRO helpers) and _refreshAllProStarBadges
 * from js/app.js - matching the browser <script> load order.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const PRO_GATING_PATH = path.join(__dirname, '../js/pro-gating.js');
const APP_JS_PATH     = path.join(__dirname, '../js/app.js');

function loadWatermarkFunctions() {
    global.canvasData        = [];
    global._markDirty        = jest.fn();
    global._updateSaveNewBtn = jest.fn();
    global._userPlan         = 'free';

    const proGating = fs.readFileSync(PRO_GATING_PATH, 'utf8');
    // eslint-disable-next-line no-eval
    window.eval(proGating);

    const appSrc = fs.readFileSync(APP_JS_PATH, 'utf8');
    const match  = appSrc.match(/function _refreshAllProStarBadges\(\)[\s\S]*?\n}\n/);
    if (!match) throw new Error('_refreshAllProStarBadges not found in app.js');
    // eslint-disable-next-line no-eval
    window.eval(match[0]);
}

function makeFakeCanvas(width, height) {
    const pattern = { __wmPattern: true };
    return {
        width,
        height,
        contextContainer: {
            save:          jest.fn(),
            restore:       jest.fn(),
            translate:     jest.fn(),
            rotate:        jest.fn(),
            fillText:      jest.fn(),
            fillRect:      jest.fn(),
            createPattern: jest.fn(() => pattern),
            set font(_) {},
            set textAlign(_) {},
            set textBaseline(_) {},
            set shadowColor(_) {},
            set shadowBlur(_) {},
            set shadowOffsetX(_) {},
            set shadowOffsetY(_) {},
            set fillStyle(_) {},
        },
        requestRenderAll: jest.fn(),
    };
}

function makeCanvasData(fc, overrides = {}) {
    const sharedOriginal = overrides.designOriginal ?? {};
    return {
        fabricCanvas: fc,
        designObject: {},
        hasProEffect: false,
        forceProBadge: false,
        warpAmount: 0,
        arcAmount: 0,
        arcTilt: 0,
        perspectiveTop: 0,
        perspectiveLeft: 0,
        patternMode: false,
        maskEnabled: false,
        meshWarpApplied: false,
        invertedMain: false,
        invertedExtras: [],
        blendMode: 'normal',
        bgAdjust: { hue: 0, saturation: 0, brightness: 0, contrast: 0 },
        bgCrop: { x: 0, y: 0, scale: 1, rotation: 0, aspect: 0 },
        designOriginal: sharedOriginal,
        initialDesignOriginal: overrides.initialDesignOriginal ?? sharedOriginal,
        extraDesignObjects: [],
        ...overrides,
    };
}

function buildDOM() {
    document.body.innerHTML = `
      <div id="upgradePrompt" style="display:flex;">
        Free plan - watermarks appear on canvas.
        <button id="upgradePromptClose">✕</button>
      </div>
      <span class="pro-badge">PRO</span>
    `;
}

beforeAll(() => {
    loadWatermarkFunctions();
});

beforeEach(() => {
    window._userPlan = 'free';
    global.canvasData = [];
    buildDOM();
    jest.clearAllMocks();
});

describe('_drawWatermarkOnCanvas - watermark by plan', () => {
    test('free plan: stamps watermark via createPattern + fillRect', () => {
        window._userPlan = 'free';
        const fc   = makeFakeCanvas(800, 600);
        const data = makeCanvasData(fc);

        window._drawWatermarkOnCanvas(data);

        expect(fc.contextContainer.createPattern).toHaveBeenCalledWith(
            expect.any(Object),
            'repeat'
        );
        expect(fc.contextContainer.fillRect).toHaveBeenCalled();
        const tile = window._ensureWatermarkTileCanvas();
        expect(tile).toBeTruthy();
        expect(tile.width).toBe(155);
        expect(tile.height).toBe(104);
    });

    test('after upgrade to starter (no PRO effect): pattern stamp is NOT called', () => {
        window._userPlan = 'starter';
        const fc   = makeFakeCanvas(800, 600);
        const data = makeCanvasData(fc);

        window._drawWatermarkOnCanvas(data);

        expect(fc.contextContainer.createPattern).not.toHaveBeenCalled();
        expect(fc.contextContainer.fillRect).not.toHaveBeenCalled();
    });

    test('starter plan + PRO-effect canvas: pattern stamp IS still called', () => {
        window._userPlan = 'starter';
        const fc   = makeFakeCanvas(800, 600);
        const data = makeCanvasData(fc, { warpAmount: 10 });

        window._drawWatermarkOnCanvas(data);

        expect(fc.contextContainer.createPattern).toHaveBeenCalled();
        expect(fc.contextContainer.fillRect).toHaveBeenCalled();
    });

    test('after upgrade to pro: pattern stamp is NOT called even for PRO-effect canvas', () => {
        window._userPlan = 'pro';
        const fc   = makeFakeCanvas(800, 600);
        const data = makeCanvasData(fc, { warpAmount: 10 });

        window._drawWatermarkOnCanvas(data);

        expect(fc.contextContainer.createPattern).not.toHaveBeenCalled();
        expect(fc.contextContainer.fillRect).not.toHaveBeenCalled();
    });

    test('bails silently when fabricCanvas is absent', () => {
        window._userPlan = 'free';
        expect(() => window._drawWatermarkOnCanvas(
            { fabricCanvas: null, designObject: {} }
        )).not.toThrow();
    });

    test('bails silently when designObject is absent', () => {
        window._userPlan = 'free';
        const fc = makeFakeCanvas(200, 200);
        window._drawWatermarkOnCanvas({ fabricCanvas: fc, designObject: null });
        expect(fc.contextContainer.createPattern).not.toHaveBeenCalled();
        expect(fc.contextContainer.fillRect).not.toHaveBeenCalled();
    });

    test('skips drawing during pan/transform interaction suppression', () => {
        window._userPlan = 'free';
        const fc   = makeFakeCanvas(800, 600);
        const data = makeCanvasData(fc);

        _beginWatermarkInteraction();
        window._drawWatermarkOnCanvas(data);
        expect(fc.contextContainer.fillRect).not.toHaveBeenCalled();

        _endWatermarkInteraction();
        window._drawWatermarkOnCanvas(data);
        expect(fc.contextContainer.fillRect).toHaveBeenCalled();
    });

    test('_endWatermarkInteraction refreshes gated canvases when suppression ends', () => {
        window._userPlan = 'starter';
        const fc   = makeFakeCanvas(800, 600);
        const data = makeCanvasData(fc, { warpAmount: 10 });
        global.canvasData = [data];

        _beginWatermarkInteraction();
        fc.requestRenderAll.mockClear();
        _endWatermarkInteraction();
        expect(fc.requestRenderAll).toHaveBeenCalledTimes(1);
    });

    test('Fabric _currentTransform alone does not suppress pattern stamp', () => {
        window._userPlan = 'free';
        const fc   = makeFakeCanvas(800, 600);
        fc._currentTransform = { action: 'drag' };
        const data = makeCanvasData(fc);

        window._drawWatermarkOnCanvas(data);
        expect(fc.contextContainer.fillRect).toHaveBeenCalled();
    });
});

describe('_refreshAllProStarBadges - #upgradePrompt bar', () => {
    test('free plan: #upgradePrompt remains visible', () => {
        window._userPlan = 'free';

        window._refreshAllProStarBadges();

        const bar = document.getElementById('upgradePrompt');
        expect(bar).not.toBeNull();
        expect(bar.style.display).not.toBe('none');
    });

    test('upgrade to starter: #upgradePrompt is hidden immediately', () => {
        window._userPlan = 'starter';

        window._refreshAllProStarBadges();

        expect(document.getElementById('upgradePrompt').style.display).toBe('none');
    });

    test('upgrade to pro: #upgradePrompt is hidden immediately', () => {
        window._userPlan = 'pro';

        window._refreshAllProStarBadges();

        expect(document.getElementById('upgradePrompt').style.display).toBe('none');
    });

    test('absent #upgradePrompt does not throw when plan is paid', () => {
        document.getElementById('upgradePrompt').remove();
        window._userPlan = 'pro';
        expect(() => window._refreshAllProStarBadges()).not.toThrow();
    });
});

describe('_refreshAllProStarBadges - requestRenderAll', () => {
    test('calls requestRenderAll on every fabric canvas', () => {
        window._userPlan = 'pro';
        const fc1 = makeFakeCanvas(400, 300);
        const fc2 = makeFakeCanvas(400, 300);
        global.canvasData = [makeCanvasData(fc1), makeCanvasData(fc2)];

        window._refreshAllProStarBadges();

        expect(fc1.requestRenderAll).toHaveBeenCalledTimes(1);
        expect(fc2.requestRenderAll).toHaveBeenCalledTimes(1);
    });

    test('entry with no fabricCanvas skips requestRenderAll gracefully', () => {
        window._userPlan = 'pro';
        global.canvasData = [{ fabricCanvas: null, designObject: {}, wrapperEl: null, hasProEffect: false }];
        expect(() => window._refreshAllProStarBadges()).not.toThrow();
    });
});

describe('_drawWatermarkOnCanvas - export capture plan override', () => {
    test('export capture with verified free plan draws watermark even when _userPlan is tampered to pro', () => {
        window._userPlan = 'pro';
        const fc   = makeFakeCanvas(800, 600);
        const data = makeCanvasData(fc);

        window._beginExportCapture('free');
        window._drawWatermarkOnCanvas(data);
        window._endExportCapture();

        expect(fc.contextContainer.fillRect).toHaveBeenCalled();
    });

    test('export capture with verified starter plan skips watermark on plain mockups', () => {
        window._userPlan = 'free';
        const fc   = makeFakeCanvas(800, 600);
        const data = makeCanvasData(fc);

        window._beginExportCapture('starter');
        window._drawWatermarkOnCanvas(data);
        window._endExportCapture();

        expect(fc.contextContainer.fillRect).not.toHaveBeenCalled();
    });

    test('preview still uses _userPlan when export capture is inactive', () => {
        window._userPlan = 'pro';
        const fc   = makeFakeCanvas(800, 600);
        const data = makeCanvasData(fc);

        window._drawWatermarkOnCanvas(data);

        expect(fc.contextContainer.fillRect).not.toHaveBeenCalled();
    });
});

describe('full upgrade simulation', () => {
    test('free → pro: upgradePrompt hidden AND canvas no longer draws watermark', () => {
        window._userPlan = 'free';

        const fc   = makeFakeCanvas(800, 600);
        const data = makeCanvasData(fc);
        global.canvasData = [data];

        window._drawWatermarkOnCanvas(data);
        expect(fc.contextContainer.fillRect).toHaveBeenCalled();
        expect(fc.contextContainer.createPattern).toHaveBeenCalled();

        expect(document.getElementById('upgradePrompt').style.display).not.toBe('none');

        window._userPlan = 'pro';
        window._refreshAllProStarBadges();

        expect(document.getElementById('upgradePrompt').style.display).toBe('none');
        expect(fc.requestRenderAll).toHaveBeenCalledTimes(1);

        fc.contextContainer.fillRect.mockClear();
        fc.contextContainer.createPattern.mockClear();
        window._drawWatermarkOnCanvas(data);
        expect(fc.contextContainer.fillRect).not.toHaveBeenCalled();
        expect(fc.contextContainer.createPattern).not.toHaveBeenCalled();
    });

    test('free → starter (no PRO effect): upgradePrompt hidden AND no watermark', () => {
        window._userPlan = 'free';
        const fc   = makeFakeCanvas(400, 300);
        const data = makeCanvasData(fc, { hasProEffect: false });
        global.canvasData = [data];

        window._drawWatermarkOnCanvas(data);
        expect(fc.contextContainer.fillRect).toHaveBeenCalled();

        window._userPlan = 'starter';
        window._refreshAllProStarBadges();

        expect(document.getElementById('upgradePrompt').style.display).toBe('none');

        fc.contextContainer.fillRect.mockClear();
        window._drawWatermarkOnCanvas(data);
        expect(fc.contextContainer.fillRect).not.toHaveBeenCalled();
    });
});
