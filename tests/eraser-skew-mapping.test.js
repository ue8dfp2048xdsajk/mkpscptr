/**
 * @jest-environment jsdom
 *
 * Eraser pointer mapping + geometry helpers (skew / trim / flip).
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const ERASER_JS_PATH = path.join(__dirname, '../js/eraser.js');
const IMAGE_UTILS_PATH = path.join(__dirname, '../js/image-utils.js');

function loadEraserMappingHelpers() {
    global._getLayerFlip = (obj, data) => {
        if (obj === data.designObject) return { flipX: !!data.flipX, flipY: !!data.flipY };
        const fx = obj._fx || {};
        return { flipX: !!fx.flipX, flipY: !!fx.flipY };
    };

    global.fabric = {
        util: {
            invertTransform(m) {
                const [a, b, c, d, e, f] = m;
                const det = a * d - b * c;
                const ia =  d / det;
                const ib = -b / det;
                const ic = -c / det;
                const id =  a / det;
                const ie = -(ia * e + ic * f);
                const iff = -(ib * e + id * f);
                return [ia, ib, ic, id, ie, iff];
            },
            transformPoint(p, m) {
                const [a, b, c, d, e, f] = m;
                return { x: a * p.x + c * p.y + e, y: b * p.x + d * p.y + f };
            },
            composeMatrix(opts) {
                const angle  = (opts.angle  || 0) * Math.PI / 180;
                const skewX  = (opts.skewX  || 0) * Math.PI / 180;
                const skewY  = (opts.skewY  || 0) * Math.PI / 180;
                const cos    = Math.cos(angle);
                const sin    = Math.sin(angle);
                const sx     = opts.scaleX ?? 1;
                const sy     = opts.scaleY ?? 1;
                const a = cos * sx + Math.tan(skewY) * sin * sx;
                const b = sin * sx - Math.tan(skewY) * cos * sx;
                const c = -sin * sy + Math.tan(skewX) * cos * sy;
                const d = cos * sy + Math.tan(skewX) * sin * sy;
                return [a, b, c, d, 0, 0];
            },
        },
    };

    const src = fs.readFileSync(ERASER_JS_PATH, 'utf8');
    const block = src.match(
        /function _eraserFabricRadius[\s\S]*?function _drawEraseStampOnContext[\s\S]*?\n\}/
    );
    if (!block) throw new Error('Could not extract eraser mapping helpers');
    // eslint-disable-next-line no-eval
    window.eval(block[0]);
}

function loadContentDeltaHelper() {
    const src = fs.readFileSync(IMAGE_UTILS_PATH, 'utf8');
    const fn  = src.match(/function contentDeltaToCanvasDelta[\s\S]*?\n\}/);
    if (!fn) throw new Error('Could not extract contentDeltaToCanvasDelta');
    // eslint-disable-next-line no-eval
    window.eval(fn[0]);
}

describe('contentDeltaToCanvasDelta', () => {
    beforeEach(() => loadContentDeltaHelper());

    test('skew produces different delta than rotation-only', () => {
        const rotated = contentDeltaToCanvasDelta(10, 0, { angle: 15, scaleX: 1, scaleY: 1, skewX: 0, skewY: 0 });
        const skewed  = contentDeltaToCanvasDelta(10, 0, { angle: 15, scaleX: 1, scaleY: 1, skewX: 20, skewY: 0 });
        expect(skewed.x).not.toBeCloseTo(rotated.x, 3);
    });
});

describe('eraser source mapping', () => {
    beforeEach(() => loadEraserMappingHelpers());

    function makeObj(overrides) {
        return Object.assign({
            width: 80,
            height: 60,
            scaleX: 1,
            scaleY: 1,
            angle: 0,
            skewX: 0,
            skewY: 0,
            _c_trimmed: { _trimX0: 5, _trimY0: 10, width: 80, height: 60, _trimSrcW: 100, _trimSrcH: 80 },
            _c_blurR: 0,
            calcTransformMatrix() {
                return fabric.util.composeMatrix({
                    angle: this.angle,
                    scaleX: this.scaleX,
                    scaleY: this.scaleY,
                    skewX: this.skewX,
                    skewY: this.skewY,
                });
            },
        }, overrides);
    }

    test('_localToOriginalPixel applies trim offset', () => {
        const srcEl = { width: 100, height: 80 };
        const data  = { designObject: {}, flipX: false, flipY: false };
        const obj   = makeObj();
        obj._ownerData = data;
        data.designObject = obj;

        const hit = _localToOriginalPixel(obj, data, 0, 0, srcEl);
        expect(hit.px).toBe(5 + 40);
        expect(hit.py).toBe(10 + 30);
    });

    test('_localToOriginalPixel applies flipX', () => {
        const srcEl = { width: 100, height: 80 };
        const data  = { designObject: {}, flipX: true, flipY: false };
        const obj   = makeObj({ _c_trimmed: null });
        obj._ownerData = data;
        data.designObject = obj;

        const hit = _localToOriginalPixel(obj, data, -40, -30, srcEl);
        expect(hit.px).toBe(99);
        expect(hit.py).toBe(0);
    });

    test('_pointerToSourceEraseStamp uses ellipse when skewed', () => {
        const srcEl = { width: 100, height: 80, getContext: () => ({}) };
        global._ensureErasableOriginal = () => srcEl;
        global.designEraserSize = 20;

        const data = {
            designObject: {},
            flipX: false,
            flipY: false,
            fabricCanvas: {
                width: 400,
                height: 300,
                upperCanvasEl: { getBoundingClientRect: () => ({ width: 400, height: 300 }) },
            },
        };
        const obj = makeObj({ skewX: 25, skewY: 0 });
        obj._ownerData = data;
        data.designObject = obj;

        const stamp = _pointerToSourceEraseStamp(obj, data, { x: 50, y: 40 });
        expect(stamp.useEllipse).toBe(true);
        expect(stamp.rx).toBeGreaterThan(0);
        expect(stamp.ry).toBeGreaterThan(0);
    });

    test('_beginEraserStroke captures geometry metadata', () => {
        global.canvasData = [{ designObject: null, extraDesignObjects: [] }];
        const data = canvasData[0];
        const obj  = { left: 10, top: 20, scaleX: 2, scaleY: 2, angle: 5, skewX: 12, skewY: 0, _ownerData: data };
        data.designObject = obj;
        global._captureEraserSnapshot = () => ({ original: null, extraOriginals: [] });

        const item = _beginEraserStroke(data, obj);
        expect(item.geo.skewX).toBe(12);
        expect(item.isMain).toBe(true);
        expect(item.extraIdx).toBe(-1);
    });

    test('_beginEraserStroke must receive fabric layer, not window data', () => {
        global.canvasData = [{ designObject: null, extraDesignObjects: [] }];
        const data = canvasData[0];
        const obj  = { left: 10, top: 20, scaleX: 2, scaleY: 2, angle: 5, skewX: 0, skewY: 0, _ownerData: data };
        data.designObject = obj;
        global._captureEraserSnapshot = () => ({ original: null, extraOriginals: [] });

        const wrong = _beginEraserStroke(data, data);
        expect(wrong.geo.left).toBeUndefined();
        expect(wrong.isMain).toBe(false);

        const right = _beginEraserStroke(data, obj);
        expect(right.geo.left).toBe(10);
        expect(right.geo.top).toBe(20);
        expect(right.isMain).toBe(true);
    });
});
