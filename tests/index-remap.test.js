/**
 * @jest-environment jsdom
 *
 * Unit tests for activeIndices remapping after canvasData splice/reorder.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const APP_JS_PATH = path.join(__dirname, '../js/app.js');

function loadRemapHelpers() {
    global.activeIndices     = [];
    global.selectedDesigns   = new Set();
    global.canvasData        = [];
    global.lastSelectedIndex = null;

    const src = fs.readFileSync(APP_JS_PATH, 'utf8');
    const start = src.indexOf('function _pruneOrphanSelectedDesigns');
    const end   = src.indexOf('function _syncFabricDisplaySize');
    if (start === -1 || end === -1) throw new Error('Could not locate remap helper block');
    // eslint-disable-next-line no-eval
    window.eval(src.slice(start, end));
}

function makeData(id) {
    const main = { id: `${id}-main` };
    const data = { designObject: main, extraDesignObjects: [] };
    main._ownerData = data;
    return data;
}

describe('_remapActiveIndicesByData', () => {
    beforeEach(() => {
        loadRemapHelpers();
        activeIndices = [];
        selectedDesigns.clear();
        lastSelectedIndex = null;
    });

    test('remaps via pre-splice data refs after insert shifts positions', () => {
        const a = makeData('a');
        const b = makeData('b');
        const c = makeData('c');
        canvasData = [a, b, c];
        activeIndices = [2];

        const dup = makeData('b-copy');
        canvasData.splice(2, 0, dup); // [a, b, dup, c]

        _remapActiveIndicesByData([c]);

        expect(activeIndices).toEqual([3]);
    });

    test('drops indices whose data objects were removed', () => {
        const a = makeData('a');
        const b = makeData('b');
        canvasData = [a, b];
        activeIndices = [0, 1];
        lastSelectedIndex = b;

        canvasData.splice(1, 1);

        _remapActiveIndicesByData();

        expect(activeIndices).toEqual([0]);
        expect(lastSelectedIndex).toBeNull();
    });

    test('prunes orphan selectedDesigns', () => {
        const a = makeData('a');
        canvasData = [a];
        activeIndices = [0];
        selectedDesigns.add(a.designObject);

        canvasData = [];

        _remapActiveIndicesByData();

        expect(activeIndices).toEqual([]);
        expect(selectedDesigns.size).toBe(0);
    });

    test('dedupes activeIndices after remap', () => {
        const a = makeData('a');
        canvasData = [a];
        activeIndices = [0, 0, 0];

        _remapActiveIndicesByData();

        expect(activeIndices).toEqual([0]);
    });
});

describe('_resolveExportIndices', () => {
    beforeEach(() => {
        loadRemapHelpers();
        activeIndices = [];
        selectedDesigns.clear();
    });

    test('maps export slots through data refs after duplicate insert', () => {
        const a = makeData('a');
        const b = makeData('b');
        const c = makeData('c');
        canvasData = [a, b, c];

        const dup = makeData('b-copy');
        canvasData.splice(2, 0, dup);

        const resolved = _resolveExportIndices([canvasData.indexOf(c)]);

        expect(resolved).toEqual([3]);
    });

    test('null input remaps activeIndices when slots still match data', () => {
        const a = makeData('a');
        const b = makeData('b');
        canvasData = [a, b];
        activeIndices = [canvasData.indexOf(b)];

        const dup = makeData('a-copy');
        canvasData.splice(1, 0, dup);
        activeIndices = [canvasData.indexOf(b)];

        const resolved = _resolveExportIndices(null);

        expect(resolved).toEqual([2]);
        expect(activeIndices).toEqual([2]);
    });
});
