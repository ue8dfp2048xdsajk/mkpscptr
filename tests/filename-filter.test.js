/**
 * @jest-environment node
 *
 * Select-by-filename must match the visible canvas filename, not bgName.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const APP_JS_PATH = path.join(__dirname, '../js/app.js');

describe('filter by filename selection', () => {
    test('applyNameFilter matches d.filename not d.bgName', () => {
        const src = fs.readFileSync(APP_JS_PATH, 'utf8');
        const block = src.match(/function applyNameFilter\(\)[\s\S]*?\n    \}/);
        expect(block).toBeTruthy();
        expect(block[0]).toMatch(/\(d\.filename \|\| ''\)\.toLowerCase\(\)/);
        expect(block[0]).not.toMatch(/d\.bgName/);
    });
});
