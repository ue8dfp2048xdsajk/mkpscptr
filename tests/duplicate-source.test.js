/**
 * @jest-environment jsdom
 *
 * Unit tests for duplicate-layer source cloning (eraser.js).
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const ERASER_JS_PATH = path.join(__dirname, '../js/eraser.js');

function loadEraserHelpers() {
    const src = fs.readFileSync(ERASER_JS_PATH, 'utf8');
    const match = src.match(
        /function _cloneEraserSource[\s\S]*?function _captureEraserSnapshot/
    );
    if (!match) throw new Error('Could not extract duplicate-source helpers from eraser.js');
    // eslint-disable-next-line no-eval
    window.eval(match[0].replace(/function _captureEraserSnapshot\s*$/, ''));
}

function makeCanvas(w, h, fill) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    if (fill) {
        const ctx = c.getContext('2d');
        ctx.fillStyle = fill;
        ctx.fillRect(0, 0, w, h);
    }
    return c;
}

describe('_sourceForDuplicateLayer', () => {
    beforeEach(() => {
        loadEraserHelpers();
    });

    test('main design: clones designOriginal canvas (independent copy)', () => {
        const original = makeCanvas(40, 30, '#f00');
        const data = {
            designOriginal: original,
            extraDesignObjects: [],
            extraDesignOriginals: [],
        };
        const mainObj = { _ownerData: data };

        const cloned = _sourceForDuplicateLayer(data, mainObj);

        expect(cloned).not.toBe(original);
        expect(cloned).toBeInstanceOf(HTMLCanvasElement);
        expect(cloned.width).toBe(40);
        expect(cloned.height).toBe(30);
    });

    test('extra layer: clones its extraDesignOriginals entry', () => {
        const main = makeCanvas(10, 10);
        const extra = makeCanvas(20, 20, '#0f0');
        const data = {
            designOriginal: main,
            extraDesignObjects: [{ id: 'extra1' }],
            extraDesignOriginals: [extra],
        };
        const extraObj = data.extraDesignObjects[0];

        const cloned = _sourceForDuplicateLayer(data, extraObj);

        expect(cloned).not.toBe(extra);
        expect(cloned).not.toBe(main);
        expect(cloned.width).toBe(20);
    });

    test('extra layer with null original falls back to cloned designOriginal', () => {
        const main = makeCanvas(15, 15);
        const data = {
            designOriginal: main,
            extraDesignObjects: [{ id: 'extra1' }],
            extraDesignOriginals: [null],
        };

        const cloned = _sourceForDuplicateLayer(data, data.extraDesignObjects[0]);

        expect(cloned).not.toBe(main);
        expect(cloned.width).toBe(15);
    });

    test('image original is returned as-is (immutable reference)', () => {
        const img = { src: 'data:image/png;base64,abc', width: 100, height: 50 };
        const data = {
            designOriginal: img,
            extraDesignObjects: [],
            extraDesignOriginals: [],
        };

        const cloned = _sourceForDuplicateLayer(data, { _ownerData: data });

        expect(cloned).toBe(img);
    });
});
