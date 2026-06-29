#!/usr/bin/env node
/**
 * End-to-end smoke test for the Stripe → webhook → set-plan → Clerk chain.
 *
 * Fires a properly HMAC-signed checkout.session.completed event at the
 * deployed webhook endpoint and reports the result of every stage.
 *
 * Usage:
 *   STRIPE_WEBHOOK_SECRET=whsec_... \
 *   CLERK_USER_ID=user_... \
 *   node scripts/test-webhook.js [--url https://mkpscptr.vercel.app] [--plan starter]
 *
 * Required:
 *   STRIPE_WEBHOOK_SECRET   The whsec_... signing secret configured on Vercel.
 *   CLERK_USER_ID           A real Clerk user ID (user_...) to test the update against.
 *                           The user's plan metadata will be patched to the requested plan.
 *
 * Optional:
 *   --url   Deployment base URL (default: https://mkpscptr.vercel.app)
 *   --plan  Plan name to set: "starter" or "pro" (default: starter)
 *
 * What passes means:
 *   HTTP 200  → signature OK + set-plan succeeded + Clerk was updated
 *   HTTP 502  → signature OK + Clerk rejected (user not found or API error)
 *   HTTP 400  → signature FAILED (wrong secret) or malformed payload
 *   HTTP 500  → env vars missing on the server
 */

'use strict';

const crypto = require('crypto');
const https  = require('https');
const url    = require('url');

function parseArgs() {
    const args = process.argv.slice(2);
    const opts = {
        baseUrl: 'https://mkpscptr.vercel.app',
        plan: 'starter',
    };
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--url'  && args[i + 1]) { opts.baseUrl = args[++i]; }
        if (args[i] === '--plan' && args[i + 1]) { opts.plan    = args[++i]; }
    }
    return opts;
}

function httpPost(targetUrl, body, headers) {
    return new Promise((resolve, reject) => {
        const parsed  = url.parse(targetUrl);
        const options = {
            hostname: parsed.hostname,
            port:     parsed.port || 443,
            path:     parsed.path,
            method:   'POST',
            headers:  {
                'Content-Type':   'application/json',
                'Content-Length': Buffer.byteLength(body),
                ...headers,
            },
        };
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end',  ()      => resolve({ status: res.statusCode, body: data }));
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

function buildSignature(rawBody, secret, timestamp) {
    const signed = `${timestamp}.${rawBody}`;
    const sig    = crypto.createHmac('sha256', secret).update(signed, 'utf8').digest('hex');
    return `t=${timestamp},v1=${sig}`;
}

async function main() {
    const opts              = parseArgs();
    const webhookSecret     = process.env.STRIPE_WEBHOOK_SECRET;
    const clerkUserId       = process.env.CLERK_USER_ID;

    if (!webhookSecret) {
        console.error('ERROR: STRIPE_WEBHOOK_SECRET is not set.');
        console.error('  export STRIPE_WEBHOOK_SECRET=whsec_...');
        process.exit(1);
    }
    if (!clerkUserId) {
        console.error('ERROR: CLERK_USER_ID is not set.');
        console.error('  export CLERK_USER_ID=user_...');
        console.error('');
        console.error('  To find your Clerk user ID: sign in at https://dashboard.clerk.com,');
        console.error('  open Users, click your account, and copy the "User ID" field.');
        process.exit(1);
    }

    const targetUrl  = opts.baseUrl.replace(/\/$/, '') + '/api/webhooks/stripe';
    const plan       = opts.plan;
    const timestamp  = Math.floor(Date.now() / 1000);
    const eventId    = `evt_test_smoke_${timestamp}`;

    const event = {
        id:          eventId,
        object:      'event',
        api_version: '2023-10-16',
        created:     timestamp,
        type:        'checkout.session.completed',
        data:        {
            object: {
                id:                    `cs_test_smoke_${timestamp}`,
                object:                'checkout.session',
                client_reference_id:   clerkUserId,
                payment_status:        'paid',
                status:                'complete',
                metadata:              { plan },
                amount_total:          plan === 'pro' ? 3900 : 2500,
                currency:              'usd',
                mode:                  'payment',
            },
        },
    };

    const rawBody        = JSON.stringify(event);
    const stripeSignature = buildSignature(rawBody, webhookSecret, timestamp);

    console.log('\nStripe Webhook Smoke Test');
    console.log('=========================');
    console.log(`Target URL    : ${targetUrl}`);
    console.log(`Clerk user ID : ${clerkUserId}`);
    console.log(`Plan to set   : ${plan}`);
    console.log(`Event ID      : ${eventId}`);
    console.log(`Signature     : ${stripeSignature.slice(0, 72)}...`);
    console.log('');
    console.log('Sending signed webhook event...');

    let res;
    try {
        res = await httpPost(targetUrl, rawBody, { 'stripe-signature': stripeSignature });
    } catch (err) {
        console.error(`\nFATAL: could not reach ${targetUrl}`);
        console.error(err.message);
        process.exit(1);
    }

    let parsed;
    try {
        parsed = JSON.parse(res.body);
    } catch {
        parsed = { raw: res.body };
    }

    console.log(`\nHTTP status   : ${res.status}`);
    console.log(`Response body : ${JSON.stringify(parsed)}`);
    console.log('');

    if (res.status === 200 && parsed.ok) {
        console.log('✓ PASS — Full chain verified:');
        console.log('  1. Stripe-Signature validated  ✓');
        console.log('  2. Event parsed                ✓');
        console.log('  3. /api/set-plan called        ✓');
        console.log(`  4. Clerk metadata updated      ✓  (userId=${clerkUserId}, plan=${plan})`);
        console.log('');
        console.log('The payment plan has been set on this Clerk user.');
        console.log('Reload the deployed app and sign in to confirm the badge updates.');
    } else if (res.status === 400) {
        console.error('✗ FAIL — Signature verification or payload parsing failed.');
        console.error('  Check that STRIPE_WEBHOOK_SECRET matches the value in Vercel.');
    } else if (res.status === 500) {
        console.error('✗ FAIL — Server-side env var missing (STRIPE_WEBHOOK_SECRET, SET_PLAN_SECRET, BASE_URL).');
        console.error('  Run scripts/check-env.js on the server to diagnose.');
    } else if (res.status === 502) {
        console.error('✗ FAIL — Signature OK but downstream call failed.');
        console.error(`  Error: ${parsed.error || 'unknown'}`);
        console.error('  Most likely cause: CLERK_USER_ID does not exist in Clerk.');
        console.error('  Verify the user ID at https://dashboard.clerk.com > Users.');
    } else {
        console.error(`✗ FAIL — Unexpected status ${res.status}: ${res.body}`);
    }

    process.exit(res.status === 200 && parsed.ok ? 0 : 1);
}

main().catch((err) => {
    console.error('Unexpected error:', err.message);
    process.exit(1);
});
