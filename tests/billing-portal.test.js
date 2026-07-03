/**
 * @jest-environment node
 *
 * Billing portal return_url must match checkout: editor app, not marketing landing page.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const BILLING_ACTION_PATH = path.join(__dirname, '../api/billing/[action].js');

describe('billing portal return_url', () => {
    test('handlePortal sends users back to /app.html', () => {
        const src = fs.readFileSync(BILLING_ACTION_PATH, 'utf8');
        expect(src).toMatch(/params\.set\('return_url',\s*`\$\{baseUrl\}\/app\.html`\)/);
        expect(src).not.toMatch(/params\.set\('return_url',\s*`\$\{baseUrl\}\/`\)/);
    });
});
