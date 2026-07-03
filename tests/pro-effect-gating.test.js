/**
 * @jest-environment jsdom
 *
 * Unit tests for PRO effect detection helpers in js/pro-gating.js.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const PRO_GATING_PATH = path.join(__dirname, '../js/pro-gating.js');

function loadProEffectFunctions() {
    global._markDirty = jest.fn();
    global._userPlan  = 'starter';

    const src = fs.readFileSync(PRO_GATING_PATH, 'utf8');
    // eslint-disable-next-line no-eval
    window.eval(src);
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
        forceProBadge: false,
        hasProEffect: false,
        wrapperEl: null,
        ...overrides,
    };
}

describe('PRO effect detection', () => {
    beforeEach(() => {
        loadProEffectFunctions();
        _markDirty.mockClear();
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
        expect(_transformsContainProEffect({
            designFx: { warpAmount: 10, blendMode: 'normal' },
        })).toBe(true);
    });

    test('_transformsContainProEffect: blur-only is not PRO', () => {
        expect(_transformsContainProEffect({
            designFx: {
                warpAmount: 0,
                arcAmount: 0,
                arcTilt: 0,
                perspectiveTop: 0,
                perspectiveLeft: 0,
                blendMode: 'normal',
                blurAmount: 50,
                opacity: 0.5,
            },
        })).toBe(false);
    });

    test('_transformsContainProEffect: non-normal blend is PRO', () => {
        expect(_transformsContainProEffect({
            designFx: { blendMode: 'screen' },
        })).toBe(true);
    });

    test('_transformsContainProEffect: patternMode is PRO', () => {
        expect(_transformsContainProEffect({
            patternMode: true,
            designFx: { blendMode: 'normal' },
        })).toBe(true);
    });

    test('_transformsContainProEffect: invertActive is PRO', () => {
        expect(_transformsContainProEffect({ invertActive: true })).toBe(true);
    });

    test('_windowHasProBlend detects per-layer blend on extra object', () => {
        const data = makeData({
            designObject: { _fx: { blendMode: 'normal' } },
            extraDesignObjects: [{ _fx: { blendMode: 'overlay' } }],
        });
        expect(_windowHasProBlend(data)).toBe(true);
    });

    test('extra-layer warp in _fx marks PRO via _windowHasProEffect', () => {
        const data = makeData({
            designObject: { _fx: { blendMode: 'normal', warpAmount: 0 } },
            extraDesignObjects: [{ _fx: { warpAmount: 25, blendMode: 'normal' } }],
        });
        expect(_windowHasProEffect(data)).toBe(true);
    });

    test('forceProBadge gates without real PRO effects', () => {
        const data = makeData({ forceProBadge: true });
        expect(_windowHasProEffect(data)).toBe(false);
        expect(_windowIsProGated(data)).toBe(true);
        _syncProEffect(data);
        expect(data.hasProEffect).toBe(true);
    });

    test('_syncProEffect clears forceProBadge when real PRO effect appears', () => {
        const data = makeData({ forceProBadge: true, warpAmount: 10 });
        _syncProEffect(data);
        expect(data.forceProBadge).toBe(false);
        expect(data.hasProEffect).toBe(true);
    });
});

describe('paste PRO sync helpers', () => {
    beforeEach(() => {
        loadProEffectFunctions();
        _markDirty.mockClear();
        _userPlan = 'starter';
    });

    test('_copiedLayerPayloadIsPro detects design warp', () => {
        expect(_copiedLayerPayloadIsPro({
            type: 'design',
            designWarpAmount: 15,
        })).toBe(true);
        expect(_copiedLayerPayloadIsPro({
            type: 'design',
            designWarpAmount: 0,
        })).toBe(false);
    });

    test('_copiedLayerPayloadIsPro detects extra-layer PRO _fx', () => {
        expect(_copiedLayerPayloadIsPro({
            type: 'extra',
            fx: { warpAmount: 0, blendMode: 'multiply' },
        })).toBe(true);
    });

    test('_applyPasteProSync does not gate Starter for plain payload', () => {
        const data = makeData();
        _applyPasteProSync(data, 'starter', false);
        expect(data.forceProBadge).toBe(false);
        expect(data.hasProEffect).toBe(false);
    });

    test('_applyPasteProSync gates Starter immediately for PRO payload', () => {
        const data = makeData();
        _applyPasteProSync(data, 'starter', true);
        expect(data.forceProBadge).toBe(true);
        expect(data.hasProEffect).toBe(true);
    });

    test('_finishPasteProSync clears forceProBadge when window has no PRO effects', () => {
        const data = makeData({ forceProBadge: true });
        _finishPasteProSync(data);
        expect(data.forceProBadge).toBe(false);
        expect(data.hasProEffect).toBe(false);
    });

    test('_applyPasteProSync does not gate Pro for plain payload', () => {
        _userPlan = 'pro';
        const data = makeData();
        _applyPasteProSync(data, 'pro', false);
        expect(data.forceProBadge).toBe(false);
        expect(data.hasProEffect).toBe(false);
    });

    test('_applyPasteProSync gates Pro when payload is PRO', () => {
        _userPlan = 'pro';
        const data = makeData();
        _applyPasteProSync(data, 'pro', true);
        expect(data.forceProBadge).toBe(false);
    });

    test('_carriesBakedPro on designObject marks PRO', () => {
        const data = makeData({ designObject: { _carriesBakedPro: true } });
        _recomputeProEffect(data);
        expect(data.hasProEffect).toBe(true);
    });

    test('_copiedLayerPayloadIsPro detects srcCarriesBakedPro', () => {
        expect(_copiedLayerPayloadIsPro({ srcCarriesBakedPro: true })).toBe(true);
        expect(_copiedLayerPayloadIsPro({
            type: 'design',
            designWarpAmount: 0,
            srcCarriesBakedPro: false,
        })).toBe(false);
    });

    test('_layerCarriesBakedProWork detects meshWarpApplied main', () => {
        const obj = {};
        const data = makeData({ meshWarpApplied: true, designObject: obj });
        expect(_layerCarriesBakedProWork(data, obj, 'design', -1)).toBe(true);
    });

    test('_layerCarriesBakedProWork detects eraser-modified main', () => {
        const obj = {};
        const data = makeData({
            designObject: obj,
            designOriginal: { id: 'erased' },
            initialDesignOriginal: { id: 'original' },
        });
        expect(_layerCarriesBakedProWork(data, obj, 'design', -1)).toBe(true);
    });
});
