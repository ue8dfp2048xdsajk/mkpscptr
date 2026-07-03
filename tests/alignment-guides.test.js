/**
 * @jest-environment jsdom
 *
 * Unit tests for alignment guide helpers.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const GUIDES_PATH = path.join(__dirname, '../js/alignment-guides.js');

function loadGuideHelpers() {
    global.canvasData  = [];
    global._numColumns = 4;
    global._vpScale    = 1;
    global.alignmentGuidesEnabled = true;
    global.getAllDesignObjects = (data) => {
        const objs = [];
        if (data.designObject) objs.push(data.designObject);
        (data.extraDesignObjects || []).forEach(o => objs.push(o));
        return objs;
    };

    const src = fs.readFileSync(GUIDES_PATH, 'utf8');
    const match = src.match(
        /function _guideNear[\s\S]*?function _computeAlignmentGuideLines/
    );
    if (!match) throw new Error('Could not extract guide helpers');
    const body = match[0].replace(/\nfunction _computeAlignmentGuideLines\s*$/, '');
    // eslint-disable-next-line no-eval
    window.eval(body + '\nfunction _computeAlignmentGuideLines() { return []; }');
}

describe('_gridNeighbors', () => {
    beforeEach(() => {
        loadGuideHelpers();
        canvasData = [{ id: 0 }, { id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }];
        _numColumns = 3;
    });

    test('middle cell has four neighbors', () => {
        const n = _gridNeighbors(4);
        expect(n.left).toBe(3);
        expect(n.right).toBe(5);
        expect(n.above).toBe(1);
        expect(n.below).toBe(null);
    });

    test('top-left corner has only right and below', () => {
        const n = _gridNeighbors(0);
        expect(n.left).toBe(null);
        expect(n.above).toBe(null);
        expect(n.right).toBe(1);
        expect(n.below).toBe(3);
    });
});

describe('_guideNear', () => {
    beforeEach(() => loadGuideHelpers());

    test('within threshold', () => {
        expect(_guideNear(10, 12, 5)).toBe(true);
    });

    test('outside threshold', () => {
        expect(_guideNear(10, 20, 5)).toBe(false);
    });
});

describe('_getObjectContainerRect', () => {
    beforeEach(() => loadGuideHelpers());

    test('maps fabric bounds into container space', () => {
        const obj = {
            getBoundingRect: () => ({ left: 10, top: 20, width: 100, height: 50 }),
        };
        const data = {
            cellEl: { offsetLeft: 200, offsetTop: 50 },
            wrapperEl: { offsetLeft: 0, offsetTop: 0, offsetWidth: 300 },
            fabricCanvas: { getWidth: () => 600, getHeight: () => 400 },
        };
        const rect = _getObjectContainerRect(data, obj);
        expect(rect.left).toBe(205);
        expect(rect.top).toBe(60);
        expect(rect.width).toBe(50);
        expect(rect.height).toBe(25);
        expect(rect.cx).toBe(230);
        expect(rect.cy).toBe(72.5);
    });
});
