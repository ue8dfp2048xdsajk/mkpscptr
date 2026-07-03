/**
 * @jest-environment jsdom
 *
 * Unit tests for PRO effect detection helpers extracted from js/app.js.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const APP_JS_PATH = path.join(__dirname, '../js/app.js');

function loadProEffectFunctions() {
    global.getAllDesignObjects = function (data) {
        const objs = [];
        if (data.designObject) objs.push(data.designObject);
        (data.extraDesignObjects || []).forEach(o => objs.push(o));
        return objs;
    };
    global._markDirty           = jest.fn();
    global._updateProStarBadge  = jest.fn();
    global._userPlan            = 'starter';

    const src   = fs.readFileSync(APP_JS_PATH, 'utf8');
    const lines = src.split('\n');
    // Lines 127-181 (1-indexed): _windowHasProBlend … _recomputeProEffect
    const snippet = lines.slice(126, 181).join('\n');
    // eslint-disable-next-line no-eval
    window.eval(snippet);
}

function makeData(overrides = {}) {
    const sharedOriginal = {};
    return {
        blendMode: 'normal',
        warpAmount: 0,
        arcAmount: 0,
        arcTilt: 0,
        perspectiveTop: 0,
        perspectiveLeft: 0,
        patternMode: false,
        maskEnabled: false,
        colorLayerFabricObj: null,
        designOriginal: sharedOriginal,
        initialDesignOriginal: sharedOriginal,
        bgAdjust: { hue: 0, saturation: 0, brightness: 0, contrast: 0 },
        bgCrop: { x: 0, y: 0, scale: 1, rotation: 0, aspect: 0 },
        meshWarpApplied: false,
        invertedMain: false,
        invertedExtras: [],
        designObject: null,
        extraDesignObjects: [],
        hasProEffect: false,
        wrapperEl: null,
        ...overrides,
    };
}

describe('PRO effect detection', () => {
    beforeEach(() => {
        loadProEffectFunctions();
        _updateProStarBadge.mockClear();
    });

    test('non-normal blend marks PRO', () => {
        const data = makeData({ blendMode: 'multiply' });
        _recomputeProEffect(data);
        expect(data.hasProEffect).toBe(true);
    });

    test('normal blend with no other effects clears PRO', () => {
        const data = makeData({ hasProEffect: true });
        _recomputeProEffect(data);
        expect(data.hasProEffect).toBe(false);
    });

    test('meshWarpApplied marks PRO even when hasProEffect was false', () => {
        const data = makeData({ meshWarpApplied: true, hasProEffect: false });
        _recomputeProEffect(data);
        expect(data.hasProEffect).toBe(true);
    });

    test('invertedMain marks PRO', () => {
        const data = makeData({ invertedMain: true });
        _recomputeProEffect(data);
        expect(data.hasProEffect).toBe(true);
    });

    test('invertedExtras on any layer marks PRO', () => {
        const data = makeData({ invertedExtras: [false, true] });
        _recomputeProEffect(data);
        expect(data.hasProEffect).toBe(true);
    });

    test('_transformsContainProEffect: warp non-zero is PRO', () => {
        expect(_transformsContainProEffect({ warpAmount: 10, blendMode: 'normal' })).toBe(true);
    });

    test('_transformsContainProEffect: blur-only is not PRO', () => {
        expect(_transformsContainProEffect({
            warpAmount: 0,
            arcAmount: 0,
            arcTilt: 0,
            perspectiveTop: 0,
            perspectiveLeft: 0,
            blendMode: 'normal',
            blurAmount: 50,
            opacity: 0.5,
        })).toBe(false);
    });

    test('_transformsContainProEffect: non-normal blend is PRO', () => {
        expect(_transformsContainProEffect({ blendMode: 'screen' })).toBe(true);
    });

    test('_windowHasProBlend detects per-layer blend on extra object', () => {
        const data = makeData({
            designObject: { _fx: { blendMode: 'normal' } },
            extraDesignObjects: [{ _fx: { blendMode: 'overlay' } }],
        });
        expect(_windowHasProBlend(data)).toBe(true);
    });
});
