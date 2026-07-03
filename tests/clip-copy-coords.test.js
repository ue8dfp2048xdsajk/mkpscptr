/**
 * @jest-environment jsdom
 *
 * Clipping copy / batch-edit coordinate helpers.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const APP_JS_PATH = path.join(__dirname, '../js/app.js');

function loadClipCoordHelpers() {
    global.activeIndices         = [];
    global.activeClipWindowIndex = null;
    global.canvasData            = [];

    const appSrc = fs.readFileSync(APP_JS_PATH, 'utf8');
    const match  = appSrc.match(
        /function _clipCanvasSize[\s\S]*?function _finalizeClipPolygon\(\) \{/
    );
    if (!match) throw new Error('Could not extract clip coord helpers from app.js');
    // eslint-disable-next-line no-eval
    window.eval(match[0].replace(/function _finalizeClipPolygon\(\) \{\s*$/, ''));
}

describe('clip coordinate helpers', () => {
    beforeEach(() => {
        loadClipCoordHelpers();
        activeIndices = [];
        activeClipWindowIndex = null;
        canvasData = [];
    });

    test('_scaleMaskPath preserves coords when canvas sizes match', () => {
        const path = [{ x: 100, y: 50, cx: 120, cy: 60 }];
        const out  = _scaleMaskPath(path, 600, 400, 600, 400);
        expect(out[0].x).toBe(100);
        expect(out[0].y).toBe(50);
        expect(out[0].cx).toBe(120);
        expect(out[0].cy).toBe(60);
    });

    test('_scaleMaskPath doubles x when destination canvas is twice as wide', () => {
        const path = [{ x: 100, y: 50 }];
        const out  = _scaleMaskPath(path, 300, 400, 600, 400);
        expect(out[0].x).toBe(200);
        expect(out[0].y).toBe(50);
    });

    test('_scaleMaskPaths scales every path in the array', () => {
        const paths = [
            [{ x: 10, y: 10 }],
            [{ x: 20, y: 30 }],
        ];
        const out = _scaleMaskPaths(paths, 100, 100, 200, 100);
        expect(out[0][0].x).toBe(20);
        expect(out[1][0].x).toBe(40);
    });

    test('_clipEditTargetIndices prefers activeIndices', () => {
        activeIndices = [1, 2];
        activeClipWindowIndex = 5;
        expect(_clipEditTargetIndices()).toEqual([1, 2]);
    });

    test('_clipEditTargetIndices falls back to activeClipWindowIndex', () => {
        activeIndices = [];
        activeClipWindowIndex = 3;
        expect(_clipEditTargetIndices()).toEqual([3]);
    });
});
