/**
 * @jest-environment jsdom
 *
 * Unit tests for auto-marquee empty viewport hit detection.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const APP_JS_PATH = path.join(__dirname, '../js/app.js');

function loadEmptyViewportHelper() {
    global._vpSpaceDown        = false;
    global._mouseDownOnControl = false;
    global.clipEditMode        = false;
    global.colorLayerMode      = false;
    global.designEraserMode    = false;

    const src = fs.readFileSync(APP_JS_PATH, 'utf8');
    const match = src.match(/function _isEmptyViewportMouseTarget\(e\)[\s\S]*?\n}\n/);
    if (!match) throw new Error('_isEmptyViewportMouseTarget not found in app.js');
    // eslint-disable-next-line no-eval
    window.eval(match[0]);
}

function makeEvent(target, button = 0) {
    return { button, target };
}

describe('_isEmptyViewportMouseTarget', () => {
    beforeEach(() => {
        loadEmptyViewportHelper();
        document.body.innerHTML = `
            <div id="canvasContainer"></div>
            <div class="window-cell"><div class="drag-handle"></div><div class="canvas-wrapper"></div></div>
            <div class="canvas-text-box"></div>
        `;
    });

    test('allows empty canvas container', () => {
        const el = document.getElementById('canvasContainer');
        expect(_isEmptyViewportMouseTarget(makeEvent(el))).toBe(true);
    });

    test('blocks canvas wrapper', () => {
        const el = document.querySelector('.canvas-wrapper');
        expect(_isEmptyViewportMouseTarget(makeEvent(el))).toBe(false);
    });

    test('blocks window cell and drag handle', () => {
        expect(_isEmptyViewportMouseTarget(makeEvent(document.querySelector('.window-cell')))).toBe(false);
        expect(_isEmptyViewportMouseTarget(makeEvent(document.querySelector('.drag-handle')))).toBe(false);
    });

    test('blocks text box', () => {
        expect(_isEmptyViewportMouseTarget(makeEvent(document.querySelector('.canvas-text-box')))).toBe(false);
    });

    test('blocks special modes and controls', () => {
        const el = document.getElementById('canvasContainer');
        clipEditMode = true;
        expect(_isEmptyViewportMouseTarget(makeEvent(el))).toBe(false);
        clipEditMode = false;
        colorLayerMode = true;
        expect(_isEmptyViewportMouseTarget(makeEvent(el))).toBe(false);
        colorLayerMode = false;
        designEraserMode = true;
        expect(_isEmptyViewportMouseTarget(makeEvent(el))).toBe(false);
        designEraserMode = false;
        _mouseDownOnControl = true;
        expect(_isEmptyViewportMouseTarget(makeEvent(el))).toBe(false);
    });
});
