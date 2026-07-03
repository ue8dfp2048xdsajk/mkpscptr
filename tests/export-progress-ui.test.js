/**
 * @jest-environment node
 *
 * Export progress should mirror button state in #loadingIndicator.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const EXPORT_UI_PATH = path.join(__dirname, '../js/export-ui.js');

describe('export progress UI', () => {
    test('uses loadingIndicator helpers synced with export button', () => {
        const src = fs.readFileSync(EXPORT_UI_PATH, 'utf8');
        expect(src).toMatch(/function _showExportStatus\(msg\)/);
        expect(src).toMatch(/function _hideExportStatus\(\)/);
        expect(src).toMatch(/function _setExportProgress\(msg\)/);
        expect(src).toMatch(/getElementById\('loadingIndicator'\)/);
        expect(src).toMatch(/_setExportProgress\('Preparing export/);
        expect(src).toMatch(/_setExportProgress\('Exporting '/);
        expect(src).toMatch(/_setExportProgress\('Zipping/);
        expect(src).toMatch(/_setExportProgress\('Export complete/);
        expect(src).toMatch(/finally \{[\s\S]*?_hideExportStatus\(\)/);
    });
});
