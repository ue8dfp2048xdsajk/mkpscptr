/**
 * @jest-environment node
 *
 * Export render path must require server authorization and stay out of global scope.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const EXPORT_UI_PATH = path.join(__dirname, '../js/export-ui.js');
const PRO_GATING_PATH = path.join(__dirname, '../js/pro-gating.js');

describe('export UI gating', () => {
    test('exportDataToBlob is not a global and requires export session', () => {
        const src = fs.readFileSync(EXPORT_UI_PATH, 'utf8');
        expect(src).toMatch(/function _authorizeExport\(/);
        expect(src).toMatch(/Export not authorized/);
        expect(src).toMatch(/function _startAuthorizedExport\(/);
        expect(src).not.toMatch(/^async function exportDataToBlob/m);
        expect(src).toMatch(/_beginExportCapture\(_exportSession\.plan\)/);
    });

    test('plans modal onSkip path uses authorized export', () => {
        const src = fs.readFileSync(EXPORT_UI_PATH, 'utf8');
        expect(src).toMatch(/onSkip: async \(\) => \{[\s\S]*?_startAuthorizedExport/);
    });

    test('starter PRO-window filter uses server-verified plan during export', () => {
        const src = fs.readFileSync(EXPORT_UI_PATH, 'utf8');
        expect(src).toMatch(/verifiedPlan === 'starter'/);
    });

    test('pattern PNG export calls _authorizeExport', () => {
        const src = fs.readFileSync(EXPORT_UI_PATH, 'utf8');
        expect(src).toMatch(/exportPatternBtn[\s\S]*?await _authorizeExport\(\)/);
    });
});

describe('pro-gating export capture', () => {
    test('defines export capture helpers and effective plan resolver', () => {
        const src = fs.readFileSync(PRO_GATING_PATH, 'utf8');
        expect(src).toMatch(/function _beginExportCapture\(/);
        expect(src).toMatch(/function _endExportCapture\(/);
        expect(src).toMatch(/function _effectivePlanForGating\(/);
        expect(src).toMatch(/var plan\s*=\s*_effectivePlanForGating\(\)/);
    });
});
