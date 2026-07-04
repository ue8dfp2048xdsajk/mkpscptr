/**
 * @jest-environment jsdom
 *
 * Per-layer flip helpers - flip must not bleed across layers in one window.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const APP_JS_PATH    = path.join(__dirname, '../js/app.js');
const ERASER_JS_PATH = path.join(__dirname, '../js/eraser.js');

function loadFlipHelpers() {
    global.selectedDesigns = new Set();
    global.activeIndices   = [];
    global.canvasData      = [];

    const eraserSrc = fs.readFileSync(ERASER_JS_PATH, 'utf8');
    const flipFns = eraserSrc.match(
        /function _flipImageSource[\s\S]*?function _cachedFlip\(data, src\) \{[\s\S]*?\n\}/
    );
    if (!flipFns) throw new Error('Could not extract flip cache helpers from eraser.js');
    // eslint-disable-next-line no-eval
    window.eval(flipFns[0]);

    const appSrc = fs.readFileSync(APP_JS_PATH, 'utf8');
    const match  = appSrc.match(
        /function _defaultFx[\s\S]*?function _resetObjectPipelineCaches\(obj\) \{/
    );
    if (!match) throw new Error('Could not extract flip helpers from app.js');
    // eslint-disable-next-line no-eval
    window.eval(match[0].replace(/function _resetObjectPipelineCaches\(obj\) \{\s*$/, ''));
}

function makeWindow({ flipX = false, flipY = false, extras = [] } = {}) {
    const main = { id: 'main', _fx: null };
    const data = {
        designObject: main,
        designOriginal: { width: 10, height: 10 },
        flipX,
        flipY,
        extraDesignObjects: extras.map(e => e.obj),
        extraDesignOriginals: extras.map(e => e.src || { width: 10, height: 10 }),
        locked: false,
    };
    extras.forEach((e, i) => {
        e.obj._fx = e.fx || null;
        if (!e.obj.id) e.obj.id = `extra-${i}`;
    });
    return data;
}

describe('layer flip helpers', () => {
    beforeEach(() => {
        loadFlipHelpers();
        selectedDesigns.clear();
        activeIndices = [];
        canvasData = [];
    });

    test('_getLayerFlip reads main from window fields', () => {
        const data = makeWindow({ flipX: true, flipY: false });
        expect(_getLayerFlip(data.designObject, data)).toEqual({ flipX: true, flipY: false });
    });

    test('_getLayerFlip reads extra from obj._fx only', () => {
        const extra = { id: 'extra' };
        const data  = makeWindow({
            flipX: true,
            extras: [{ obj: extra, fx: { flipX: false, flipY: true } }],
        });
        expect(_getLayerFlip(extra, data)).toEqual({ flipX: false, flipY: true });
    });

    test('_setLayerFlip toggles extra without changing main or sibling', () => {
        const extraA = { id: 'a' };
        const extraB = { id: 'b', _fx: { flipX: false, flipY: false } };
        const data   = makeWindow({
            extras: [
                { obj: extraA },
                { obj: extraB, fx: { flipX: false, flipY: false } },
            ],
        });

        _setLayerFlip(extraA, data, 'H');

        expect(data.flipX).toBe(false);
        expect(data.flipY).toBe(false);
        expect(extraA._fx.flipX).toBe(true);
        expect(extraB._fx.flipX).toBe(false);
        expect(_getLayerFlip(data.designObject, data).flipX).toBe(false);
    });

    test('_setLayerFlip toggles main without changing extras', () => {
        const extra = { id: 'extra' };
        const data  = makeWindow({
            extras: [{ obj: extra, fx: { flipX: true, flipY: false } }],
        });

        _setLayerFlip(data.designObject, data, 'V');

        expect(data.flipY).toBe(true);
        expect(data.designObject._fx.flipY).toBe(true);
        expect(extra._fx.flipX).toBe(true);
        expect(extra._fx.flipY).toBe(false);
    });

    test('_cachedFlipForLayer caches independently for clone layers sharing src', () => {
        const sharedSrc = document.createElement('canvas');
        sharedSrc.width  = 4;
        sharedSrc.height = 4;
        const extraA = { id: 'a', _fx: { flipX: true, flipY: false } };
        const extraB = { id: 'b', _fx: { flipX: false, flipY: false } };
        const data   = {
            designObject: { id: 'main' },
            flipX: false,
            flipY: false,
            extraDesignObjects: [extraA, extraB],
        };

        const flippedA = _cachedFlipForLayer(data, sharedSrc, extraA);
        const plainB   = _cachedFlipForLayer(data, sharedSrc, extraB);

        expect(flippedA).not.toBe(sharedSrc);
        expect(plainB).toBe(sharedSrc);
    });
});
