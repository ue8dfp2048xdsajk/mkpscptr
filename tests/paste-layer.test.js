/**
 * @jest-environment jsdom
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const APP_JS_PATH = path.join(__dirname, '../js/app.js');

function loadPasteLayerHelpers() {
    const appSrc = fs.readFileSync(APP_JS_PATH, 'utf8');
    const match  = appSrc.match(
        /function _fxFromCopiedLayer\(cl\)[\s\S]*?function _resolvePasteLayerTargets[\s\S]*?\n}\n\n\/\/ Append a copied layer/
    );
    if (!match) throw new Error('paste layer helpers not found in app.js');
    // eslint-disable-next-line no-eval
    window.eval(match[0].replace(/\n\/\/ Append a copied layer$/, ''));
}

function makeWindow(id, { locked = false, hasDesign = true } = {}) {
    return {
        id,
        locked,
        designObject: hasDesign ? { id: `${id}-main` } : null,
    };
}

describe('_fxFromCopiedLayer', () => {
    beforeEach(() => {
        loadPasteLayerHelpers();
    });

    test('returns cloned fx bag when present on clipboard', () => {
        const cl = {
            fx: { warpAmount: 5, blendMode: 'multiply', opacity: 0.8 },
        };
        const fx = window._fxFromCopiedLayer(cl);
        expect(fx.warpAmount).toBe(5);
        expect(fx.blendMode).toBe('multiply');
        expect(fx.opacity).toBe(0.8);
        expect(fx).not.toBe(cl.fx);
    });

    test('builds fx from main-design fields when fx bag is absent', () => {
        const fx = window._fxFromCopiedLayer({
            type: 'design',
            designWarpAmount: 12,
            designArcAmount: 3,
            designPerspectiveTop: 4,
        });
        expect(fx.warpAmount).toBe(12);
        expect(fx.arcAmount).toBe(3);
        expect(fx.perspectiveTop).toBe(4);
        expect(fx.blendMode).toBe('normal');
    });
});

describe('_resolvePasteLayerTargets', () => {
    beforeEach(() => {
        loadPasteLayerHelpers();
    });

    test('returns cross-window targets when other windows are selected', () => {
        const windows = [makeWindow('a'), makeWindow('b'), makeWindow('c')];
        const result = _resolvePasteLayerTargets(0, [0, 2], windows);
        expect(result.sameWindow).toBe(false);
        expect(result.targets).toEqual([windows[2]]);
    });

    test('returns same-window target when only source is selected', () => {
        const windows = [makeWindow('a'), makeWindow('b')];
        const result = _resolvePasteLayerTargets(0, [0], windows);
        expect(result.sameWindow).toBe(true);
        expect(result.targets).toEqual([windows[0]]);
    });

    test('prefers cross-window when source and others are both selected', () => {
        const windows = [makeWindow('a'), makeWindow('b')];
        const result = _resolvePasteLayerTargets(0, [0, 1], windows);
        expect(result.sameWindow).toBe(false);
        expect(result.targets).toEqual([windows[1]]);
    });

    test('returns empty when source is locked and only source selected', () => {
        const windows = [makeWindow('a', { locked: true })];
        const result = _resolvePasteLayerTargets(0, [0], windows);
        expect(result.targets).toEqual([]);
    });

    test('returns empty when source has no design and only source selected', () => {
        const windows = [makeWindow('a', { hasDesign: false })];
        const result = _resolvePasteLayerTargets(0, [0], windows);
        expect(result.targets).toEqual([]);
    });
});
