/**
 * @jest-environment jsdom
 *
 * Unit tests for Shift+mousedown guard during Fabric transforms.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const APP_JS_PATH = path.join(__dirname, '../js/app.js');

function loadShiftTransformGuard() {
    const src = fs.readFileSync(APP_JS_PATH, 'utf8');
    const match = src.match(/function _shouldSkipShiftLayerSelection[\s\S]*?\n}\n/);
    if (!match) throw new Error('_shouldSkipShiftLayerSelection not found in app.js');
    // eslint-disable-next-line no-eval
    window.eval(match[0]);
}

describe('_shouldSkipShiftLayerSelection', () => {
    beforeEach(() => {
        loadShiftTransformGuard();
    });

    test('returns false when canvas or target is missing', () => {
        expect(_shouldSkipShiftLayerSelection(null, { target: {} })).toBe(false);
        expect(_shouldSkipShiftLayerSelection({}, null)).toBe(false);
    });

    test('skips when Fabric reports target already selected', () => {
        const target = { id: 'extra' };
        const canvas = { getActiveObject: () => null, _currentTransform: null };
        expect(_shouldSkipShiftLayerSelection(canvas, { target, alreadySelected: true })).toBe(true);
    });

    test('skips when target is the active object', () => {
        const target = { id: 'extra' };
        const canvas = { getActiveObject: () => target, _currentTransform: null };
        expect(_shouldSkipShiftLayerSelection(canvas, { target })).toBe(true);
    });

    test('skips when mousedown is on a control handle', () => {
        const target = { id: 'extra' };
        const canvas = {
            getActiveObject: () => null,
            _currentTransform: { target, corner: 'ml' },
        };
        expect(_shouldSkipShiftLayerSelection(canvas, { target })).toBe(true);
    });

    test('does not skip for body drag without corner on inactive target', () => {
        const target = { id: 'extra' };
        const canvas = {
            getActiveObject: () => null,
            _currentTransform: { target, action: 'drag' },
        };
        expect(_shouldSkipShiftLayerSelection(canvas, { target })).toBe(false);
    });
});
