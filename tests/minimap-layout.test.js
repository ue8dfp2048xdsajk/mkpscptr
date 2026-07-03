/**
 * @jest-environment node
 *
 * Minimap vertical position follows vpControlPanel collapse state (UX only).
 */

'use strict';

const fs = require('fs');
const path = require('path');

const APP_JS_PATH = path.join(__dirname, '../js/app.js');
const STYLES_PATH = path.join(__dirname, '../css/styles.css');

describe('minimap layout vs collapsed tool grid', () => {
    test('setVpcHidden toggles vpc-panel-collapsed on body', () => {
        const src = fs.readFileSync(APP_JS_PATH, 'utf8');
        const block = src.match(/function setVpcHidden\(hidden\)[\s\S]*?\n    \}/);
        expect(block).toBeTruthy();
        expect(block[0]).toMatch(/document\.body\.classList\.toggle\('vpc-panel-collapsed', hidden\)/);
    });

    test('minimap has open and collapsed bottom offsets with transition', () => {
        const src = fs.readFileSync(STYLES_PATH, 'utf8');
        expect(src).toMatch(/#minimap \{[\s\S]*?bottom: 220px;/);
        expect(src).toMatch(/transition: bottom 0\.18s ease;/);
        expect(src).toMatch(/body\.vpc-panel-collapsed #minimap \{[\s\S]*?bottom: 100px;/);
    });
});
