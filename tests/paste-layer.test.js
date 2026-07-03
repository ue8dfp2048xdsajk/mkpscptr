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
        /function _fxFromCopiedLayer\(cl\)[\s\S]*?\n}\n\n\/\/ Append a copied layer/
    );
    if (!match) throw new Error('_fxFromCopiedLayer not found in app.js');
    // eslint-disable-next-line no-eval
    window.eval(match[0].replace(/\n\/\/ Append a copied layer$/, ''));
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
