/**
 * @jest-environment jsdom
 *
 * Cloud snapshot image deduplication - initialDesignSrc must not stay inline.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const APP_JS_PATH = path.join(__dirname, '../js/app.js');

function loadBuildCloudSnapshot() {
    global.buildFullSnapshot = jest.fn();
    global._compressForCloud = jest.fn(async () => 'data:image/png;base64,cZ');

    const appSrc = fs.readFileSync(APP_JS_PATH, 'utf8');
    const match  = appSrc.match(/async function buildCloudSnapshot\(\)[\s\S]*?\n}\n/);
    if (!match) throw new Error('buildCloudSnapshot not found in app.js');
    // eslint-disable-next-line no-eval
    window.eval(match[0]);
}

function resolveImageKey(val, imageMap) {
    if (!val) return null;
    if (typeof val === 'string' && val.startsWith('__img_')) return imageMap[val] || null;
    return val;
}

describe('buildCloudSnapshot - initialDesignSrc deduplication', () => {
    beforeEach(() => {
        loadBuildCloudSnapshot();
    });

    test('duplicate windows with shared baseline omit inline initialDesignSrc', async () => {
        const sharedDesign = 'data:image/png;base64,' + 'A'.repeat(5000);
        const sharedBg     = 'data:image/jpeg;base64,' + 'B'.repeat(5000);
        const windows = Array.from({ length: 10 }, () => ({
            bgSrc: sharedBg,
            designSrc: sharedDesign,
            initialDesignSrc: sharedDesign,
            colorLayerDataURL: null,
            duplicates: [],
        }));

        global.buildFullSnapshot.mockReturnValue({
            schemaVersion: 1,
            windows,
            textBoxes: [],
            viewport: {},
            layout: {},
            undoHistory: [],
        });

        const snapshot = await global.buildCloudSnapshot();
        const json     = JSON.stringify(snapshot);

        expect(snapshot.windows.every(w => w.initialDesignSrc === null)).toBe(true);
        expect(snapshot.windows.every(w => w.designSrc === '__img_1')).toBe(true);
        expect(json.match(/data:image\/png;base64,AAAA/g) || []).toHaveLength(0);
        expect(Object.keys(snapshot.imageMap)).toHaveLength(2);
    });

    test('separate baseline is keyed when it differs from designSrc', async () => {
        const baseline = 'data:image/png;base64,' + 'C'.repeat(200);
        const current  = 'data:image/png;base64,' + 'D'.repeat(200);

        global.buildFullSnapshot.mockReturnValue({
            schemaVersion: 1,
            windows: [{
                bgSrc: 'data:image/jpeg;base64,BG',
                designSrc: current,
                initialDesignSrc: baseline,
                colorLayerDataURL: null,
                duplicates: [],
            }],
            textBoxes: [],
            viewport: {},
            layout: {},
            undoHistory: [],
        });

        const snapshot = await global.buildCloudSnapshot();
        const w        = snapshot.windows[0];

        expect(w.designSrc).toMatch(/^__img_/);
        expect(w.initialDesignSrc).toMatch(/^__img_/);
        expect(w.initialDesignSrc).not.toBe(w.designSrc);
        expect(JSON.stringify(snapshot)).not.toContain('CCCC');
        expect(JSON.stringify(snapshot)).not.toContain('DDDD');
    });
});

describe('cloud load - resolve initialDesignSrc keys', () => {
    test('_fromKey resolves keys, passes through inline URLs, handles null', () => {
        const imageMap = {
            '__img_0': 'data:image/png;base64,resolved',
        };

        expect(resolveImageKey('__img_0', imageMap)).toBe('data:image/png;base64,resolved');
        expect(resolveImageKey('__img_missing', imageMap)).toBeNull();
        expect(resolveImageKey('data:image/png;base64,inline', imageMap))
            .toBe('data:image/png;base64,inline');
        expect(resolveImageKey(null, imageMap)).toBeNull();
    });
});
