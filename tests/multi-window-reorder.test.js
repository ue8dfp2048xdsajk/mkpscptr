/**
 * @jest-environment jsdom
 *
 * Unit tests for multi-window drag-reorder helpers in js/app.js.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const APP_JS_PATH = path.join(__dirname, '../js/app.js');

function loadReorderHelpers() {
    global.activeIndices = [];
    global.canvasData    = [];

    const src = fs.readFileSync(APP_JS_PATH, 'utf8');
    const start = src.indexOf('function _cellsForDragGroup');
    const end   = src.indexOf('(()=>{\n    const container = document.getElementById(\'canvasContainer\');');
    if (start === -1 || end === -1) throw new Error('Could not extract reorder helpers');
    // eslint-disable-next-line no-eval
    window.eval(src.slice(start, end));
}

function makeCell(id) {
    const cell = document.createElement('div');
    cell.className = 'window-cell';
    cell.id = id;
    return cell;
}

describe('_cellsForDragGroup', () => {
    beforeEach(() => {
        loadReorderHelpers();
    });

    test('returns single cell when not multi-selecting', () => {
        const cell = makeCell('a');
        const data = { locked: false, cellEl: cell };
        canvasData = [data];
        activeIndices = [];

        expect(_cellsForDragGroup(data)).toEqual([cell]);
    });

    test('returns all selected unlocked cells when source is in selection', () => {
        const a = makeCell('a');
        const b = makeCell('b');
        const c = makeCell('c');
        const da = { locked: false, cellEl: a };
        const db = { locked: false, cellEl: b };
        const dc = { locked: false, cellEl: c };
        canvasData = [da, db, dc];
        activeIndices = [0, 2];

        expect(_cellsForDragGroup(dc)).toEqual([a, c]);
        expect(_cellsForDragGroup(da)).toEqual([a, c]);
    });

    test('returns only source cell when multi-select but source not in selection', () => {
        const a = makeCell('a');
        const b = makeCell('b');
        const c = makeCell('c');
        const da = { locked: false, cellEl: a };
        const db = { locked: false, cellEl: b };
        const dc = { locked: false, cellEl: c };
        canvasData = [da, db, dc];
        activeIndices = [0, 2];

        expect(_cellsForDragGroup(db)).toEqual([b]);
    });

    test('excludes locked windows from multi drag group', () => {
        const a = makeCell('a');
        const b = makeCell('b');
        const da = { locked: false, cellEl: a };
        const db = { locked: true,  cellEl: b };
        canvasData = [da, db];
        activeIndices = [0, 1];

        expect(_cellsForDragGroup(da)).toEqual([a]);
    });
});

describe('_insertCellBlock', () => {
    beforeEach(() => {
        loadReorderHelpers();
    });

    test('inserts block before target preserving internal order', () => {
        const container = document.createElement('div');
        const a = makeCell('a');
        const b = makeCell('b');
        const c = makeCell('c');
        const d = makeCell('d');
        [a, b, c, d].forEach(el => container.appendChild(el));

        _insertCellBlock(container, [b, c], d, true);

        expect([...container.children].map(el => el.id)).toEqual(['a', 'b', 'c', 'd']);
    });

    test('inserts block after target', () => {
        const container = document.createElement('div');
        const a = makeCell('a');
        const b = makeCell('b');
        const c = makeCell('c');
        const d = makeCell('d');
        [a, b, c, d].forEach(el => container.appendChild(el));

        _insertCellBlock(container, [b, c], a, false);

        expect([...container.children].map(el => el.id)).toEqual(['a', 'b', 'c', 'd']);
    });

    test('no-op when target is inside the moving block', () => {
        const container = document.createElement('div');
        const a = makeCell('a');
        const b = makeCell('b');
        const c = makeCell('c');
        [a, b, c].forEach(el => container.appendChild(el));

        _insertCellBlock(container, [b, c], b, true);

        expect([...container.children].map(el => el.id)).toEqual(['a', 'b', 'c']);
    });
});

describe('_restoreCellsAfterCancelledDrag', () => {
    beforeEach(() => {
        loadReorderHelpers();
    });

    test('restores non-contiguous cells to original positions', () => {
        const container = document.createElement('div');
        const a = makeCell('a');
        const b = makeCell('b');
        const c = makeCell('c');
        const d = makeCell('d');
        [a, b, c, d].forEach(el => container.appendChild(el));

        const origNext = new Map([[b, c], [d, null]]);
        const origIndex = new Map([[b, 1], [d, 3]]);

        container.removeChild(b);
        container.removeChild(d);
        container.appendChild(b);
        container.appendChild(d);

        _restoreCellsAfterCancelledDrag(container, [b, d], origNext, origIndex);

        expect([...container.children].map(el => el.id)).toEqual(['a', 'b', 'c', 'd']);
    });
});
