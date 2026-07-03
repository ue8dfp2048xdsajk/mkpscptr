/**
 * @jest-environment jsdom
 *
 * Unit tests for Tier A canvas render coalescing in js/app.js.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const APP_JS_PATH = path.join(__dirname, '../js/app.js');

function loadRenderCoalesceHelpers() {
    global._renderPattern = jest.fn();

    const appSrc = fs.readFileSync(APP_JS_PATH, 'utf8');
    const match  = appSrc.match(
        /\/\/ Tier A: paint coalesce[\s\S]*?function _cancelCanvasRenderCoalesce\(\) \{[\s\S]*?\n\}/
    );
    if (!match) throw new Error('Could not extract render coalesce helpers from app.js');
    // eslint-disable-next-line no-eval
    window.eval(match[0]);
}

function makeData(id, { patternMode = false } = {}) {
    return {
        id,
        patternMode,
        fabricCanvas: { requestRenderAll: jest.fn() },
    };
}

describe('render coalesce', () => {
    beforeEach(() => {
        loadRenderCoalesceHelpers();
        _cancelCanvasRenderCoalesce();
        _renderPattern.mockClear();
        jest.useFakeTimers();
    });

    afterEach(() => {
        _cancelCanvasRenderCoalesce();
        jest.useRealTimers();
    });

    test('_scheduleCanvasRender dedupes same canvas and merges patternLQ', () => {
        const data = makeData('a', { patternMode: true });

        _scheduleCanvasRender(data);
        _scheduleCanvasRender(data, { patternLQ: true });

        expect(_renderCoalesceRaf).not.toBeNull();

        jest.runAllTimers();
        _flushCanvasRenderCoalesce();

        expect(_renderPattern).toHaveBeenCalledTimes(1);
        expect(_renderPattern).toHaveBeenCalledWith(data, true);
        expect(data.fabricCanvas.requestRenderAll).toHaveBeenCalledTimes(1);
    });

    test('_flushCanvasRenderCoalesce runs pattern before requestRenderAll', () => {
        const order = [];
        const data = makeData('b', { patternMode: true });
        _renderPattern.mockImplementation(() => order.push('pattern'));
        data.fabricCanvas.requestRenderAll = jest.fn(() => order.push('render'));

        _scheduleCanvasRender(data, { patternLQ: true });
        _flushCanvasRenderCoalesce();

        expect(order).toEqual(['pattern', 'render']);
    });

    test('_cancelCanvasRenderCoalesce clears pending queue without painting', () => {
        const data = makeData('c', { patternMode: true });
        _scheduleCanvasRender(data, { patternLQ: true });
        _cancelCanvasRenderCoalesce();

        expect(_renderCoalesceQueue.size).toBe(0);
        expect(_renderCoalesceRaf).toBeNull();
        expect(data.fabricCanvas.requestRenderAll).not.toHaveBeenCalled();
        expect(_renderPattern).not.toHaveBeenCalled();
    });
});
