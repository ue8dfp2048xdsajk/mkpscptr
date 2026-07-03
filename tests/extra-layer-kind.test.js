/**
 * @jest-environment jsdom
 *
 * Unit tests for extra-layer clone vs overlay classification (undo.js + app.js).
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const UNDO_JS_PATH = path.join(__dirname, '../js/undo.js');
const APP_JS_PATH  = path.join(__dirname, '../js/app.js');

function loadLayerKindHelpers() {
    const undoSrc = fs.readFileSync(UNDO_JS_PATH, 'utf8');
    const undoMatch = undoSrc.match(
        /function _extraObjectIsOverlay[\s\S]*?function captureWindowState/
    );
    if (!undoMatch) throw new Error('Could not extract overlay helpers from undo.js');
    // eslint-disable-next-line no-eval
    window.eval(undoMatch[0].replace(/function captureWindowState\s*$/, ''));

    const appSrc = fs.readFileSync(APP_JS_PATH, 'utf8');
    const appMatch = appSrc.match(
        /function _extraLayerKind[\s\S]*?function _selectedLayersForWindow/
    );
    if (!appMatch) throw new Error('Could not extract _extraLayerKind from app.js');
    // eslint-disable-next-line no-eval
    window.eval(appMatch[0].replace(/function _selectedLayersForWindow\s*$/, ''));
}

describe('extra layer kind classification', () => {
    beforeEach(() => {
        loadLayerKindHelpers();
    });

    test('duplicate with cloned pipeline source is still a clone', () => {
        const canvas = document.createElement('canvas');
        const data = {
            extraDesignObjects: [{ _fx: {} }],
            extraDesignOriginals: [canvas],
        };
        expect(_extraLayerKind(data, 0)).toBe('clone');
        expect(_extraObjectIsOverlay(data.extraDesignObjects[0])).toBe(false);
    });

    test('uploaded overlay is classified as overlay', () => {
        const data = {
            extraDesignObjects: [{ _uploadedDesignName: 'logo.png' }],
            extraDesignOriginals: [{}],
        };
        expect(_extraLayerKind(data, 0)).toBe('overlay');
    });

    test('_dupStateIsOverlay uses isClone and falls back to name', () => {
        expect(_dupStateIsOverlay({ isClone: true, src: 'data:image/png;base64,x', name: null })).toBe(false);
        expect(_dupStateIsOverlay({ isClone: false })).toBe(true);
        expect(_dupStateIsOverlay({ src: 'data:image/png;base64,x', name: 'logo.png' })).toBe(true);
        expect(_dupStateIsOverlay({ src: 'data:image/png;base64,x' })).toBe(false);
        expect(_dupStateIsOverlay({})).toBe(false);
    });
});
