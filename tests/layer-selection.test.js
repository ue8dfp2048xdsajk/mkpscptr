/**
 * @jest-environment jsdom
 *
 * Unit tests for layer selection helpers in js/app.js.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const APP_JS_PATH = path.join(__dirname, '../js/app.js');

function loadLayerSelectionHelpers() {
    global.selectedDesigns = new Set();
    global.canvasData      = [];

    const appSrc = fs.readFileSync(APP_JS_PATH, 'utf8');
    const match  = appSrc.match(
        /function _selectedLayersForWindow[\s\S]*?function _canCrossWindowSync/
    );
    if (!match) throw new Error('Could not extract layer selection helpers from app.js');
    // eslint-disable-next-line no-eval
    window.eval(match[0].replace(/function _canCrossWindowSync\s*$/, ''));
}

function makeData(extraObjs, mainSelected, extraSelectedIndices) {
    const main = { id: 'main' };
    const extras = extraObjs.map((id, i) => ({ id, extraIdx: i }));
    const data = { designObject: main, extraDesignObjects: extras };
    if (mainSelected) selectedDesigns.add(main);
    extraSelectedIndices.forEach(i => selectedDesigns.add(extras[i]));
    return data;
}

describe('_windowHasAnyLayerSelected', () => {
    beforeEach(() => {
        loadLayerSelectionHelpers();
        selectedDesigns.clear();
    });

    test('false when no layers selected', () => {
        const data = makeData(['a', 'b'], false, []);
        expect(_windowHasAnyLayerSelected(data)).toBe(false);
    });

    test('true when main design selected', () => {
        const data = makeData(['a'], true, []);
        expect(_windowHasAnyLayerSelected(data)).toBe(true);
    });

    test('true when duplicate/extra layer selected', () => {
        const data = makeData(['dup'], false, [0]);
        expect(_windowHasAnyLayerSelected(data)).toBe(true);
    });

    test('true when both main and extra selected', () => {
        const data = makeData(['dup'], true, [0]);
        expect(_windowHasAnyLayerSelected(data)).toBe(true);
    });
});
