/**
 * @jest-environment jsdom
 *
 * Unit tests for keyboard nudge driver selection in js/app.js.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const APP_JS_PATH = path.join(__dirname, '../js/app.js');

function loadNudgeDriverHelpers() {
    global.selectedDesigns  = new Set();
    global.canvasData       = [];
    global.activeIndices    = [];
    global.lastSelectedIndex = null;

    const appSrc = fs.readFileSync(APP_JS_PATH, 'utf8');
    const match  = appSrc.match(
        /function _selectedLayersForWindow[\s\S]*?function refreshFabricHandles/
    );
    if (!match) throw new Error('Could not extract nudge driver helpers from app.js');
    const src = match[0].replace(/\nfunction refreshFabricHandles\s*$/, '');
    // eslint-disable-next-line no-eval
    window.eval(src);
}

function makeWindow(id, { locked = false, extras = [] } = {}) {
    const main = { id: `${id}-main`, left: 0, top: 0 };
    const extraObjs = extras.map((eid, i) => ({ id: `${id}-extra-${i}`, left: 0, top: 0 }));
    return {
        id,
        locked,
        designObject: main,
        extraDesignObjects: extraObjs,
        fabricCanvas: { requestRenderAll: jest.fn() },
    };
}

function reset() {
    selectedDesigns.clear();
    canvasData.length = 0;
    activeIndices = [];
    lastSelectedIndex = null;
}

describe('_collectNudgeDrivers', () => {
    beforeEach(() => {
        loadNudgeDriverHelpers();
        reset();
    });

    test('returns empty when no active windows have selection', () => {
        const w = makeWindow('a');
        canvasData.push(w);
        activeIndices = [0];
        expect(_collectNudgeDrivers()).toEqual([]);
    });

    test('main selected in one active window yields one driver', () => {
        const w = makeWindow('a');
        canvasData.push(w);
        activeIndices = [0];
        selectedDesigns.add(w.designObject);
        const drivers = _collectNudgeDrivers();
        expect(drivers).toHaveLength(1);
        expect(drivers[0].driver).toBe(w.designObject);
    });

    test('skips locked windows', () => {
        const w = makeWindow('a', { locked: true });
        canvasData.push(w);
        activeIndices = [0];
        selectedDesigns.add(w.designObject);
        expect(_collectNudgeDrivers()).toEqual([]);
    });

    test('main in A mirrors driver only (peer sync via move delta)', () => {
        const a = makeWindow('a');
        const b = makeWindow('b');
        canvasData.push(a, b);
        activeIndices = [0, 1];
        selectedDesigns.add(a.designObject);
        const drivers = _collectNudgeDrivers();
        expect(drivers).toHaveLength(1);
        expect(drivers[0].data).toBe(a);
    });

    test('extra selected in A and B dedupes to one driver per layer index', () => {
        const a = makeWindow('a', { extras: ['x'] });
        const b = makeWindow('b', { extras: ['x'] });
        canvasData.push(a, b);
        activeIndices = [0, 1];
        selectedDesigns.add(a.extraDesignObjects[0]);
        selectedDesigns.add(b.extraDesignObjects[0]);
        const drivers = _collectNudgeDrivers();
        expect(drivers).toHaveLength(1);
        expect(drivers[0].driver).toBe(a.extraDesignObjects[0]);
    });

    test('cross-window sync uses lastSelectedIndex window as driver source', () => {
        const a = makeWindow('a');
        const b = makeWindow('b');
        canvasData.push(a, b);
        activeIndices = [0, 1];
        selectedDesigns.add(a.designObject);
        selectedDesigns.add(b.designObject);
        lastSelectedIndex = b;
        const drivers = _collectNudgeDrivers();
        expect(drivers).toHaveLength(1);
        expect(drivers[0].data).toBe(b);
        expect(drivers[0].driver).toBe(b.designObject);
    });

    test('main and extra both selected in same window uses main driver', () => {
        const w = makeWindow('a', { extras: ['x'] });
        canvasData.push(w);
        activeIndices = [0];
        selectedDesigns.add(w.designObject);
        selectedDesigns.add(w.extraDesignObjects[0]);
        const drivers = _collectNudgeDrivers();
        expect(drivers).toHaveLength(1);
        expect(drivers[0].driver).toBe(w.designObject);
    });
});
