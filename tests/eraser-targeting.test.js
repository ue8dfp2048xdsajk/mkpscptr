/**
 * @jest-environment jsdom
 *
 * Unit tests for design-layer eraser targeting in js/eraser.js.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const ERASER_JS_PATH = path.join(__dirname, '../js/eraser.js');

function loadEraserTargetingHelpers() {
    global.selectedDesigns     = new Set();
    global.canvasData          = [];
    global.designEraserMode    = false;
    global.designEraserDown    = false;
    global.designEraserSize    = 30;
    global.designEraserSoftness = 0;
    global.eraserTargetObject  = null;
    global._invalidateEraserPipelineCaches = () => {};
    global._previewEraserTarget = () => {};

    const src   = fs.readFileSync(ERASER_JS_PATH, 'utf8');
    const match = src.match(
        /function _canEnterDesignEraserMode[\s\S]*?function updateEraserCursor/
    );
    if (!match) throw new Error('Could not extract eraser targeting helpers from eraser.js');
    // eslint-disable-next-line no-eval
    window.eval(match[0].replace(/function updateEraserCursor\s*$/, ''));
}

function makeLayer(id, data) {
    return { id, _ownerData: data };
}

function makeData({ locked = false, hasMain = true, extras = [] } = {}) {
    const data = {
        locked,
        designObject: hasMain ? makeLayer('main', null) : null,
        extraDesignObjects: extras.map((id, i) => makeLayer(id, null)),
    };
    if (data.designObject) data.designObject._ownerData = data;
    data.extraDesignObjects.forEach(o => { o._ownerData = data; });
    return data;
}

describe('_canEnterDesignEraserMode', () => {
    beforeEach(() => {
        loadEraserTargetingHelpers();
        selectedDesigns.clear();
    });

    test('blocks when no layer selected', () => {
        const gate = _canEnterDesignEraserMode();
        expect(gate.ok).toBe(false);
        expect(gate.message).toMatch(/exactly one/i);
    });

    test('blocks when two layers selected', () => {
        const data = makeData({ extras: ['dup'] });
        selectedDesigns.add(data.designObject);
        selectedDesigns.add(data.extraDesignObjects[0]);
        const gate = _canEnterDesignEraserMode();
        expect(gate.ok).toBe(false);
    });

    test('allows exactly one main layer', () => {
        const data = makeData();
        selectedDesigns.add(data.designObject);
        const gate = _canEnterDesignEraserMode();
        expect(gate.ok).toBe(true);
        expect(gate.target).toBe(data.designObject);
    });

    test('allows exactly one duplicate layer', () => {
        const data = makeData({ hasMain: true, extras: ['dup'] });
        selectedDesigns.add(data.extraDesignObjects[0]);
        const gate = _canEnterDesignEraserMode();
        expect(gate.ok).toBe(true);
        expect(gate.target).toBe(data.extraDesignObjects[0]);
    });

    test('blocks locked window', () => {
        const data = makeData({ locked: true });
        selectedDesigns.add(data.designObject);
        const gate = _canEnterDesignEraserMode();
        expect(gate.ok).toBe(false);
        expect(gate.message).toMatch(/locked/i);
    });

    test('blocks window with no design layers', () => {
        const data = makeData({ hasMain: false, extras: [] });
        const orphan = { id: 'orphan', _ownerData: data };
        selectedDesigns.add(orphan);
        const gate = _canEnterDesignEraserMode();
        expect(gate.ok).toBe(false);
    });
});

describe('applyDesignEraserAt targeting', () => {
    beforeEach(() => {
        global.selectedDesigns     = new Set();
        global.canvasData          = [];
        global.eraserTargetObject  = null;
        global._invalidateEraserPipelineCaches = () => {};
        global._previewEraserTarget = () => {};

        const src   = fs.readFileSync(ERASER_JS_PATH, 'utf8');
        const match = src.match(
            /function applyDesignEraserAt[\s\S]*?function updateEraserCursor/
        );
        if (!match) throw new Error('Could not extract applyDesignEraserAt from eraser.js');
        // eslint-disable-next-line no-eval
        window.eval(match[0].replace(/function updateEraserCursor\s*$/, ''));
    });

    test('no-ops when pointer is on a different window than the target', () => {
        const dataA = makeData();
        const dataB = makeData({ extras: ['dup'] });
        const target = dataB.extraDesignObjects[0];
        eraserTargetObject = target;

        const erased = [];
        global.eraseFromObject = (obj) => { erased.push(obj.id); };

        applyDesignEraserAt(dataA, { x: 10, y: 10 });
        expect(erased).toEqual([]);

        applyDesignEraserAt(dataB, { x: 10, y: 10 });
        expect(erased).toEqual(['dup']);
    });
});
