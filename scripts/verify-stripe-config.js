#!/usr/bin/env node
'use strict';

/**
 * Diagnose Stripe test/live mode mismatches between STRIPE_SECRET_KEY and the
 * STRIPE_PRICE_* env vars used by api/checkout.js.
 *
 * Stripe keys and price/product IDs are each scoped to either test mode or
 * live mode. A test-mode key can never see a live-mode price (and vice
 * versa) — Stripe rejects the request with "No such price" even though the
 * ID looks syntactically valid. check-env.js only validates that a price ID
 * starts with "price_"; it cannot detect this, because mode is only knowable
 * by actually asking Stripe.
 *
 * Usage (run with the SAME env vars your deployment uses):
 *   STRIPE_SECRET_KEY=sk_live_... \
 *   STRIPE_PRICE_STARTER_MONTHLY=price_... \
 *   ... \
 *   node scripts/verify-stripe-config.js
 *
 * Or against real Vercel production values:
 *   vercel env pull .env.production.local --environment=production
 *   set -a && source .env.production.local && set +a
 *   node scripts/verify-stripe-config.js
 */

const secretKey = process.env.STRIPE_SECRET_KEY;

if (!secretKey) {
    console.error('STRIPE_SECRET_KEY is not set in this shell — nothing to check.');
    process.exit(1);
}

const keyMode = secretKey.startsWith('sk_live_')
    ? 'live'
    : secretKey.startsWith('sk_test_')
        ? 'test'
        : 'unknown';

console.log(`STRIPE_SECRET_KEY mode: ${keyMode}${keyMode === 'unknown' ? ' (does not start with sk_live_ or sk_test_ — is this a real Stripe secret key?)' : ''}\n`);

const PRICE_VARS = [
    'STRIPE_PRICE_STARTER_MONTHLY',
    'STRIPE_PRICE_STARTER_ANNUAL',
    'STRIPE_PRICE_STARTER_LIFETIME',
    'STRIPE_PRICE_PRO_MONTHLY',
    'STRIPE_PRICE_PRO_ANNUAL',
    'STRIPE_PRICE_PRO_LIFETIME',
];

async function checkPrice(name) {
    const priceId = process.env[name];
    if (!priceId) {
        console.log(`  SKIP     ${name} — not set`);
        return true;
    }

    let res;
    try {
        res = await fetch(`https://api.stripe.com/v1/prices/${encodeURIComponent(priceId)}`, {
            headers: { Authorization: `Bearer ${secretKey}` },
            signal: AbortSignal.timeout(10000),
        });
    } catch (err) {
        console.log(`  ERROR    ${name} (${priceId}) — could not reach Stripe: ${err.message}`);
        return false;
    }

    const data = await res.json().catch(() => ({}));

    if (res.ok) {
        const liveness = data.livemode ? 'live' : 'test';
        const modeMatches = liveness === keyMode;
        console.log(`  ${modeMatches ? 'OK      ' : 'MISMATCH'} ${name} (${priceId}) — price is ${liveness}-mode${modeMatches ? '' : `, but key is ${keyMode}-mode`}`);
        return modeMatches;
    }

    // Stripe returns 404 "No such price" for both "doesn't exist" and
    // "exists in the other mode" — the error message text disambiguates.
    const message = data.error?.message || `HTTP ${res.status}`;
    console.log(`  FAIL     ${name} (${priceId}) — ${message}`);
    return false;
}

async function main() {
    console.log('Checking STRIPE_PRICE_* variables against this key...\n');

    const results = await Promise.all(PRICE_VARS.map(checkPrice));
    const allOk = results.every(Boolean);

    console.log('');
    if (allOk) {
        console.log('All configured price IDs match the key\'s mode. No mismatch detected.');
    } else {
        console.log('One or more price IDs do NOT match the key\'s mode (see FAIL/MISMATCH above).');
        console.log(`Fix: in the Stripe Dashboard, switch to ${keyMode === 'live' ? 'Live' : 'Test'} mode and copy the`);
        console.log(`matching price IDs for the flagged vars, then update them in Vercel and redeploy.`);
        process.exit(1);
    }
}

main().catch(err => {
    console.error('verify-stripe-config failed:', err.message);
    process.exit(1);
});
