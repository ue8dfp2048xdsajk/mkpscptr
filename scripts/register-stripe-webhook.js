#!/usr/bin/env node
/**
 * Registers the Stripe webhook endpoint and prints the signing secret.
 *
 * Usage:
 *   STRIPE_SECRET_KEY=sk_test_... WEBHOOK_URL=https://your-domain.com node scripts/register-stripe-webhook.js
 *
 * The printed whsec_... value is your STRIPE_WEBHOOK_SECRET.
 */

const https = require('https');
const querystring = require('querystring');

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const WEBHOOK_URL = process.env.WEBHOOK_URL;

if (!STRIPE_SECRET_KEY) {
    console.error('ERROR: STRIPE_SECRET_KEY environment variable is required.');
    console.error('  export STRIPE_SECRET_KEY=sk_test_...');
    process.exit(1);
}

if (!WEBHOOK_URL) {
    console.error('ERROR: WEBHOOK_URL environment variable is required.');
    console.error('  export WEBHOOK_URL=https://your-deployed-domain.com');
    process.exit(1);
}

const endpointUrl = WEBHOOK_URL.replace(/\/$/, '') + '/api/webhooks/stripe';

function stripePost(path, params) {
    return new Promise((resolve, reject) => {
        const body = querystring.stringify(params);
        const options = {
            hostname: 'api.stripe.com',
            port: 443,
            path,
            method: 'POST',
            headers: {
                Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(body),
            },
        };
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, body: JSON.parse(data) });
                } catch (e) {
                    reject(new Error(`Failed to parse Stripe response: ${data}`));
                }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

function stripeGet(path) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'api.stripe.com',
            port: 443,
            path,
            method: 'GET',
            headers: {
                Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
            },
        };
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, body: JSON.parse(data) });
                } catch (e) {
                    reject(new Error(`Failed to parse Stripe response: ${data}`));
                }
            });
        });
        req.on('error', reject);
        req.end();
    });
}

async function main() {
    console.log(`\nStripe Webhook Registration`);
    console.log(`===========================`);
    console.log(`Endpoint URL : ${endpointUrl}`);
    console.log(`Stripe mode  : ${STRIPE_SECRET_KEY.startsWith('sk_live_') ? 'LIVE' : 'TEST'}\n`);

    // Check for existing webhooks pointing to the same URL to avoid duplicates.
    console.log('Checking for existing webhooks...');
    const listRes = await stripeGet('/v1/webhook_endpoints?limit=100');
    if (listRes.status !== 200) {
        console.error('Failed to list existing webhooks:', JSON.stringify(listRes.body, null, 2));
        process.exit(1);
    }

    const existing = (listRes.body.data || []).find(
        (wh) => wh.url === endpointUrl && wh.status === 'enabled'
    );

    if (existing) {
        console.log(`An active webhook already exists for this URL (id: ${existing.id}).`);
        console.log('');
        console.log('NOTE: Stripe does not re-expose the signing secret after creation.');
        console.log('If you no longer have the secret, delete the existing webhook and re-run this script.');
        console.log('');
        console.log(`Webhook ID   : ${existing.id}`);
        console.log(`Events       : ${(existing.enabled_events || []).join(', ')}`);
        console.log(`Status       : ${existing.status}`);
        process.exit(0);
    }

    console.log('No existing webhook found. Creating new endpoint...');
    const createRes = await stripePost('/v1/webhook_endpoints', {
        url: endpointUrl,
        'enabled_events[]': 'checkout.session.completed',
        description: 'Canvas app checkout completion handler',
    });

    if (createRes.status !== 200) {
        console.error('\nFailed to create webhook endpoint:');
        console.error(JSON.stringify(createRes.body, null, 2));
        process.exit(1);
    }

    const wh = createRes.body;
    console.log('\n✓ Webhook endpoint created successfully!\n');
    console.log(`Webhook ID   : ${wh.id}`);
    console.log(`URL          : ${wh.url}`);
    console.log(`Events       : ${(wh.enabled_events || []).join(', ')}`);
    console.log(`Status       : ${wh.status}`);
    console.log('');
    console.log('══════════════════════════════════════════════════════════════');
    console.log(`STRIPE_WEBHOOK_SECRET=${wh.secret}`);
    console.log('══════════════════════════════════════════════════════════════');
    console.log('');
    console.log('Copy the whsec_... value above and add it as a secret named');
    console.log('STRIPE_WEBHOOK_SECRET in your Replit Secrets tab (or Vercel');
    console.log('environment variables if deploying there).');
}

main().catch((err) => {
    console.error('Unexpected error:', err.message);
    process.exit(1);
});
