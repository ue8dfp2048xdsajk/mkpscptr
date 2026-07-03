/**
 * @jest-environment jsdom
 *
 * Unit tests for structural undo helpers (insertion / deletion by data ref).
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const UNDO_JS_PATH = path.join(__dirname, '../js/undo.js');

function loadStructuralHelpers() {
    document.body.innerHTML = '<div id="canvasContainer"></div>';

    global.canvasData           = [];
    global.activeIndices        = [];
    global.selectedDesigns      = new Set();
    global.lastSelectedIndex    = null;
    global.globalUndoStack      = [];
    global.globalRedoStack      = [];
    global._visibleWrappers     = new Set();
    global._visibilityObserver  = { observe: jest.fn(), unobserve: jest.fn() };
    global.refreshFabricHandles = jest.fn();
    global.updateWindowBorders  = jest.fn();
    global.updateLayerButtons   = jest.fn();
    global.syncSliders          = jest.fn();
    global.updateSelectButtonState = jest.fn();
    global.updateDropUI         = jest.fn();
    global.updateUndoRedoButtons = jest.fn();
    global._markDirty            = jest.fn();
    global.MAX_UNDO_HISTORY      = 50;

    const src = fs.readFileSync(UNDO_JS_PATH, 'utf8');
    const start = src.indexOf('function pushPropertyUndo');
    const end   = src.indexOf('async function performGlobalUndo');
    if (start === -1 || end === -1) throw new Error('Could not locate structural helper block');
    // eslint-disable-next-line no-eval
    window.eval(src.slice(start, end));
}

function makeWindow(id) {
    const wrapper = document.createElement('div');
    wrapper.className = 'canvas-wrapper';
    const cell = document.createElement('div');
    cell.className = 'window-cell';
    cell.appendChild(wrapper);
    const data = { wrapperEl: wrapper, cellEl: cell, designObject: null, extraDesignObjects: [] };
    return data;
}

describe('_reDeleteWindows', () => {
    beforeEach(() => {
        loadStructuralHelpers();
        canvasData = [];
    });

    test('removes windows by data reference when indices have shifted', () => {
        const a = makeWindow('a');
        const b = makeWindow('b');
        const dup = makeWindow('dup');
        canvasData = [a, b, dup];

        const container = document.getElementById('canvasContainer');
        [a, b, dup].forEach(d => container.appendChild(d.cellEl));

        // Saved as if dup was at index 2, but caller passes data refs only.
        _reDeleteWindows([{ originalIdx: 99, data: dup }]);

        expect(canvasData).toEqual([a, b]);
        expect(container.children.length).toBe(2);
        expect(_visibilityObserver.unobserve).toHaveBeenCalledWith(dup.wrapperEl);
    });
});

describe('_applySelectionFromDatas', () => {
    beforeEach(() => {
        loadStructuralHelpers();
        canvasData = [];
        selectedDesigns.clear();
    });

    test('resolves selection after insert shifts indices', () => {
        const a = makeWindow('a');
        const b = makeWindow('b');
        canvasData = [a, b];

        const dup = makeWindow('dup');
        canvasData.splice(2, 0, dup);

        _applySelectionFromDatas([b], b);

        expect(activeIndices).toEqual([1]);
        expect(lastSelectedIndex).toBe(b);
    });
});

describe('pushInsertionUndo', () => {
    beforeEach(() => {
        loadStructuralHelpers();
        canvasData = [];
        globalUndoStack = [];
    });

    test('pushes insertion entry with selection snapshots', () => {
        const a = makeWindow('a');
        const dup = makeWindow('dup');
        canvasData = [a, dup];

        pushInsertionUndo(
            [{ originalIdx: 1, data: dup }],
            {
                prevActiveDatas: [a],
                prevLastSelected: a,
                nextActiveDatas: [dup],
                nextLastSelected: dup,
            }
        );

        expect(globalUndoStack).toHaveLength(1);
        expect(globalUndoStack[0].type).toBe('insertion');
        expect(globalUndoStack[0].saved[0].data).toBe(dup);
        expect(globalUndoStack[0].prevActiveDatas).toEqual([a]);
        expect(globalRedoStack).toEqual([]);
    });
});

describe('_restoreDeletedWindows + _reDeleteWindows round-trip', () => {
    beforeEach(() => {
        loadStructuralHelpers();
        canvasData = [];
    });

    test('restore then re-delete by data ref', () => {
        const a = makeWindow('a');
        const b = makeWindow('b');
        canvasData = [a];

        const container = document.getElementById('canvasContainer');
        container.appendChild(a.cellEl);

        _restoreDeletedWindows([{ originalIdx: 1, data: b }]);
        expect(canvasData).toEqual([a, b]);
        expect(container.children.length).toBe(2);

        _reDeleteWindows([{ originalIdx: 0, data: b }]);
        expect(canvasData).toEqual([a]);
        expect(container.children.length).toBe(1);
    });
});

describe('_applyReorderOrder', () => {
    beforeEach(() => {
        loadStructuralHelpers();
        canvasData = [];
    });

    test('reorders cellEl nodes and keeps wrapper inside cell', () => {
        const a = makeWindow('a');
        const b = makeWindow('b');
        canvasData = [a, b];

        const container = document.getElementById('canvasContainer');
        container.appendChild(a.cellEl);
        container.appendChild(b.cellEl);

        _applyReorderOrder([b, a]);

        expect(canvasData).toEqual([b, a]);
        expect(container.children[0]).toBe(b.cellEl);
        expect(container.children[1]).toBe(a.cellEl);
        expect(b.cellEl.contains(b.wrapperEl)).toBe(true);
        expect(a.cellEl.contains(a.wrapperEl)).toBe(true);
        expect(container.contains(b.wrapperEl)).toBe(true);
        expect(b.wrapperEl.parentElement).toBe(b.cellEl);
    });

    test('does not append bare wrapperEl to canvasContainer', () => {
        const a = makeWindow('a');
        const b = makeWindow('b');
        canvasData = [a, b];

        const container = document.getElementById('canvasContainer');
        container.appendChild(a.cellEl);
        container.appendChild(b.cellEl);

        _applyReorderOrder([b, a]);

        [...container.children].forEach(child => {
            expect(child.classList.contains('window-cell')).toBe(true);
        });
    });
});

describe('_applyReorderSelectionFromBefore', () => {
    beforeEach(() => {
        loadStructuralHelpers();
        canvasData = [];
        lastSelectedIndex = null;
    });

    test('resolves window selection by data ref after reorder', () => {
        const a = makeWindow('a');
        const b = makeWindow('b');
        canvasData = [a, b];

        const container = document.getElementById('canvasContainer');
        container.appendChild(a.cellEl);
        container.appendChild(b.cellEl);

        _applyReorderOrder([b, a]);
        _applyReorderSelectionFromBefore([b], b);

        expect(activeIndices).toEqual([0]);
        expect(lastSelectedIndex).toBe(b);
    });
});
