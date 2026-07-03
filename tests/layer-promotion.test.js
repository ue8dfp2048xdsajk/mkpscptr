/**
 * @jest-environment jsdom
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const APP_JS_PATH = path.join(__dirname, '../js/app.js');

function loadCountDesignLayers() {
    const appSrc = fs.readFileSync(APP_JS_PATH, 'utf8');
    const match  = appSrc.match(/function _countDesignLayers\(data\)[\s\S]*?\n}\n/);
    if (!match) throw new Error('_countDesignLayers not found in app.js');
    // eslint-disable-next-line no-eval
    window.eval(match[0]);
}

describe('_countDesignLayers', () => {
    beforeEach(() => {
        loadCountDesignLayers();
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
