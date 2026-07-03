/**
 * @jest-environment jsdom
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const APP_JS_PATH = path.join(__dirname, '../js/app.js');

function loadLayerHelpers() {
    const appSrc = fs.readFileSync(APP_JS_PATH, 'utf8');
    const countMatch = appSrc.match(/function _countDesignLayers\(data\)[\s\S]*?\n}\n/);
    const mainMatch  = appSrc.match(/function _isMainDesignObject\(obj, data\)[\s\S]*?\n}\n/);
    if (!countMatch) throw new Error('_countDesignLayers not found in app.js');
    if (!mainMatch)  throw new Error('_isMainDesignObject not found in app.js');
    // eslint-disable-next-line no-eval
    window.eval(countMatch[0] + mainMatch[0]);
}

describe('_countDesignLayers', () => {
    beforeEach(() => {
        loadLayerHelpers();
    });

    test('counts main and extras', () => {
        expect(window._countDesignLayers({
            designObject: {},
            extraDesignObjects: [{}, {}],
        })).toBe(3);
    });

    test('counts extras only when main is absent', () => {
        expect(window._countDesignLayers({
            designObject: null,
            extraDesignObjects: [{}],
        })).toBe(1);
    });

    test('returns zero for empty window', () => {
        expect(window._countDesignLayers({
            designObject: null,
            extraDesignObjects: [],
        })).toBe(0);
    });
});

describe('_isMainDesignObject', () => {
    beforeEach(() => {
        loadLayerHelpers();
    });

    test('reflects current designObject slot after swap', () => {
        const main  = { id: 1 };
        const extra = { id: 2 };
        const data  = { designObject: main, extraDesignObjects: [extra] };

        expect(window._isMainDesignObject(main, data)).toBe(true);
        expect(window._isMainDesignObject(extra, data)).toBe(false);

        data.designObject = extra;
        data.extraDesignObjects = [main];

        expect(window._isMainDesignObject(extra, data)).toBe(true);
        expect(window._isMainDesignObject(main, data)).toBe(false);
    });
});
