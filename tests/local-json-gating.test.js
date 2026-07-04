/**
 * @jest-environment node
 *
 * Local JSON save/load is Starter+ only.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const APP_JS_PATH = path.join(__dirname, '../js/app.js');
const INDEX_HTML_PATH = path.join(__dirname, '../index.html');
const APP_HTML_PATH = path.join(__dirname, '../app.html');

describe('local JSON gating', () => {
    test('app.js guards save and load for free users', () => {
        const src = fs.readFileSync(APP_JS_PATH, 'utf8');
        expect(src).toMatch(/function _canUseLocalJson\(/);
        expect(src).toMatch(/function _guardLocalJsonAccess\(/);
        expect(src).toMatch(/saveLocalBtn[\s\S]*?_guardLocalJsonAccess\('save'\)/);
        expect(src).toMatch(/loadProgressBtn[\s\S]*?_guardLocalJsonAccess\('load'\)/);
        expect(src).toMatch(/loadProgressInput[\s\S]*?!_canUseLocalJson\(\)/);
    });

    test('open cloud requires sign-in or paid plan', () => {
        const appSrc = fs.readFileSync(APP_JS_PATH, 'utf8');
        expect(appSrc).toMatch(/openCloudBtn[\s\S]*?ms_redirect_after_auth', 'cloud'/);
        expect(appSrc).toMatch(/openCloudBtn[\s\S]*?_userPlan === 'free'/);
        expect(appSrc).toMatch(/openCloudBtn[\s\S]*?openPlansModal/);

        const clerkSrc = fs.readFileSync(path.join(__dirname, '../js/clerk-auth.js'), 'utf8');
        expect(clerkSrc).toMatch(/redirect === 'cloud'/);
    });

    test('landing pricing moves local JSON to Starter column', () => {
        const src = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
        const freeBlock = src.match(/data-plan="free"[\s\S]*?<\/ul>/);
        expect(freeBlock).toBeTruthy();
        expect(freeBlock[0]).toMatch(/muted[\s\S]*Save &amp; load locally \(JSON\)/);
        expect(freeBlock[0]).not.toMatch(/<span class="check">✓<\/span> Save &amp; load locally/);

        const starterBlock = src.match(/data-plan="starter"[\s\S]*?<\/ul>/);
        expect(starterBlock).toBeTruthy();
        expect(starterBlock[0]).toMatch(/<span class="check">✓<\/span> Save &amp; load locally \(JSON\)/);
    });

    test('plans modal marks local JSON as paid-only on free tier', () => {
        const src = fs.readFileSync(APP_HTML_PATH, 'utf8');
        const freeBlock = src.match(/data-plan="free"[\s\S]*?<\/ul>/);
        expect(freeBlock).toBeTruthy();
        expect(freeBlock[0]).toMatch(/ms-feature-no[\s\S]*Local save\/load \(JSON\)/);
    });
});
