/**
 * @jest-environment jsdom
 *
 * Unit tests for window click selection helpers in js/app.js.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const APP_JS_PATH = path.join(__dirname, '../js/app.js');

function loadHelpersSimple() {
    global.activeIndices        = [];
    global.selectedDesigns      = new Set();
    global.canvasData           = [];
    global.lastSelectedIndex    = null;
    global.designEraserMode     = false;
    global.clipEditMode         = false;
    global.clipCopySelectMode   = false;
    global.colorLayerMode       = false;
    global.colorCopySelectMode  = false;
    global.refreshFabricHandles = jest.fn();
    global.updateWindowBorders  = jest.fn();
    global.updateLayerButtons   = jest.fn();
    global.syncSliders          = jest.fn();
    global.updateSelectButtonState = jest.fn();
    global._defaultFx           = () => ({ blurAmount: 0 });
    global.alert                = jest.fn();

    const src = fs.readFileSync(APP_JS_PATH, 'utf8');
    const start = src.indexOf('function _windowHasAnyLayerSelected');
    const end   = src.indexOf('function _attachWrapperClickListener');
    if (start === -1 || end === -1) throw new Error('Could not locate helper block');
    // eslint-disable-next-line no-eval
    window.eval(src.slice(start, end));
}

function makeWindow(id, { locked = false, hasMain = true } = {}) {
    const main = hasMain ? { id: `${id}-main` } : null;
    const data = { locked, designObject: main, extraDesignObjects: [] };
    if (main) main._ownerData = data;
    return data;
}

describe('_applyWindowClickSelection', () => {
    beforeEach(() => {
        loadHelpersSimple();
        activeIndices = [];
        selectedDesigns.clear();
        lastSelectedIndex = null;
        designEraserMode = false;
    });

    test('plain click selects unselected window and main design', () => {
        const w0 = makeWindow('a');
        const w1 = makeWindow('b');
        canvasData = [w0, w1];
        activeIndices = [0];
        selectedDesigns.add(w0.designObject);

        _applyWindowClickSelection(1, {});

        expect(activeIndices).toEqual([1]);
        expect(selectedDesigns.has(w1.designObject)).toBe(true);
        expect(selectedDesigns.has(w0.designObject)).toBe(false);
    });

    test('plain click on already-selected window keeps multi-select', () => {
        const w0 = makeWindow('a');
        const w1 = makeWindow('b');
        canvasData = [w0, w1];
        activeIndices = [0, 1];
        selectedDesigns.add(w0.designObject);

        _applyWindowClickSelection(1, {});

        expect(activeIndices).toEqual([0, 1]);
        expect(selectedDesigns.has(w1.designObject)).toBe(true);
    });

    test('cmd+click toggles window off', () => {
        const w0 = makeWindow('a');
        canvasData = [w0];
        activeIndices = [0];
        selectedDesigns.add(w0.designObject);

        _applyWindowClickSelection(0, { metaKey: true });

        expect(activeIndices).toEqual([]);
        expect(selectedDesigns.has(w0.designObject)).toBe(false);
    });

    test('shift+click range-selects windows', () => {
        const w0 = makeWindow('a');
        const w1 = makeWindow('b');
        const w2 = makeWindow('c');
        canvasData = [w0, w1, w2];
        activeIndices = [0];
        selectedDesigns.add(w0.designObject);
        lastSelectedIndex = w0;

        _applyWindowClickSelection(2, { shiftKey: true });

        expect(activeIndices.sort()).toEqual([0, 1, 2]);
    });

    test('no-op in eraser mode', () => {
        const w0 = makeWindow('a');
        canvasData = [w0];
        designEraserMode = true;

        _applyWindowClickSelection(0, {});

        expect(activeIndices).toEqual([]);
        expect(refreshFabricHandles).not.toHaveBeenCalled();
    });

    test('locked window selected but design not added', () => {
        const w0 = makeWindow('a', { locked: true });
        canvasData = [w0];

        _applyWindowClickSelection(0, {});

        expect(activeIndices).toEqual([0]);
        expect(selectedDesigns.size).toBe(0);
    });
});
