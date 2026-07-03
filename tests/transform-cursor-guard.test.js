/**
 * @jest-environment jsdom
 *
 * Unit tests for transform cursor mode guard in js/app.js.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const APP_JS_PATH = path.join(__dirname, '../js/app.js');

function loadTransformCursorGuard() {
    global.designEraserMode = false;
    global.colorLayerMode   = false;
    global.clipEditMode     = false;
    global.designWarpMode   = false;
    global._activeTool      = null;

    const src = fs.readFileSync(APP_JS_PATH, 'utf8');
    const match = src.match(/function _transformCursorsAllowed\(\)[\s\S]*?\n}\n/);
    if (!match) throw new Error('_transformCursorsAllowed not found in app.js');
    // eslint-disable-next-line no-eval
    window.eval(match[0]);
}

describe('_transformCursorsAllowed', () => {
    beforeEach(() => {
        loadTransformCursorGuard();
    });

    test('allows cursors in normal design mode', () => {
        expect(_transformCursorsAllowed()).toBe(true);
    });

    test('blocks during eraser mode', () => {
        designEraserMode = true;
        expect(_transformCursorsAllowed()).toBe(false);
    });

    test('blocks during color layer mode', () => {
        colorLayerMode = true;
        expect(_transformCursorsAllowed()).toBe(false);
    });

    test('blocks during clip edit mode', () => {
        clipEditMode = true;
        expect(_transformCursorsAllowed()).toBe(false);
    });

    test('blocks during mesh warp mode', () => {
        designWarpMode = true;
        expect(_transformCursorsAllowed()).toBe(false);
    });

    test('blocks when viewport tool is active', () => {
        _activeTool = 'pan';
        expect(_transformCursorsAllowed()).toBe(false);
    });
});
