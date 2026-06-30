#!/usr/bin/env node
/**
 * Smoke test for the Stripe webhook retry path.
 *
 * Verifies that a failed webhook delivery does NOT leave the user on the free
 * plan and that Stripe's retry succeeds end-to-end.
 *
 * Requires ENABLE_WEBHOOK_TEST_HOOKS=true to be set in the deployment's
 * environment variables so the controlled failure hook inside set-plan.js
 * is active.  The hook simulates a Clerk API failure AFTER the nonce has been
 * recorded, exercising the deleteNonce-on-error branch without touching real
 * user data on the first delivery.
 *
 * Two scenarios are exercised:
 *
 *   Scenario A — Full webhook retry: same body, same nonce position, first fails
 *   ---------------------------------------------------------------------------
 *   Sends the EXACT SAME event body twice (same JSON, same Stripe event ID).
 *
 *     Delivery 1: the payload is sent with the custom header
 *       X-Test-Force-Clerk-Error: 1  (forwarded by the webhook handler to
 *       set-plan when ENABLE_WEBHOOK_TEST_HOOKS=true).  set-plan records
 *       nonce N1, hits the test hook, calls deleteNonce(N1) automatically
 *       via the production error branch, returns 502.  The webhook endpoint
 *       propagates 502 to the caller — exactly what Stripe would observe.
 *
 *     Delivery 2 (the retry): identical body, fresh timestamp + re-signed
 *       (as Stripe does), no test header.  The webhook handler generates a
 *       fresh nonce N2 (crypto.randomUUID()), set-plan records N2, calls
 *       Clerk for real, returns 200.  The webhook endpoint returns 200.
 *
 *     Final check: Clerk publicMetadata.plan is verified to match the
 *       requested plan, confirming the user is NOT left on the free plan.
 *
 *   Scenario B — deleteNonce-on-error path: direct set-plan calls, same nonce
 *   ---------------------------------------------------------------------------
 *   Exercises the exact lines inside set-plan.js that protect against a
 *   stuck nonce blocking retries when the nonce value is the SAME between
 *   calls (e.g., direct set-plan consumers that do not use the webhook
 *   handler's fresh-UUID generation):
 *
 *     1. POST /api/set-plan  nonce=N  (+ X-Test-Force-Clerk-Error: 1)
 *        → nonce N is recorded
 *        → test hook fires: deleteNonce(N) called automatically (production path)
 *        → returns 502
 *
 *     2. POST /api/set-plan  nonce=N  (no test header)
 *        → nonce N is absent from the store (deleted in step 1)
 *        → Clerk is updated for real
 *        → returns 200
 *
 *     3. Verify Clerk publicMetadata.plan matches the expected plan.
 *
 * Prerequisites:
 *   - ENABLE_WEBHOOK_TEST_HOOKS=true must be set in the deployment env.
 *   - All four env vars below must be exported locally.
 *
 * Usage:
 *   STRIPE_WEBHOOK_SECRET=whsec_... \
 *   SET_PLAN_SECRET=...            \
 *   CLERK_SECRET_KEY=sk_test_...   \
 *   CLERK_USER_ID=user_...         \
 *   node scripts/test-webhook-retry.js [--url https://mkpscptr.vercel.app] [--plan starter]
 *
 * Required env vars (local):
 *   STRIPE_WEBHOOK_SECRET   Stripe webhook signing secret (whsec_...)
 *   SET_PLAN_SECRET         Internal secret for /api/set-plan
 *   CLERK_SECRET_KEY        Clerk secret key — used to verify final metadata
 *   CLERK_USER_ID           A real Clerk user ID (user_...)
 *
 * Required deployment env var:
 *   ENABLE_WEBHOOK_TEST_HOOKS=true   Must be set in Vercel / deployment env.
 *                                    Without it the test hook is inert and
 *                                    Delivery 1 will return 200 instead of 502.
 *
 * Exit codes:
 *   0  All scenarios passed
 *   1  Any scenario failed or a required env var is missing
 */

'use strict';

const crypto = require('crypto');
const https  = require('https');
const http   = require('http');
const url    = require('url');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseArgs() {
    const args = process.argv.slice(2);
    const opts = { baseUrl: 'https://mkpscptr.vercel.app', plan: 'starter' };
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--url'  && args[i + 1]) opts.baseUrl = args[++i];
        if (args[i] === '--plan' && args[i + 1]) opts.plan    = args[++i];
    }
    opts.baseUrl = opts.baseUrl.replace(/\/$/, '');
    return opts;
}

function httpRequest(method, targetUrl, body, headers) {
    return new Promise((resolve, reject) => {
        const parsed  = url.parse(targetUrl);
        const isHttps = parsed.protocol === 'https:';
        const lib     = isHttps ? https : http;
        const bodyBuf = body ? Buffer.from(body, 'utf8') : Buffer.alloc(0);
        const options = {
            hostname: parsed.hostname,
            port:     parsed.port || (isHttps ? 443 : 80),
            path:     parsed.path,
            method,
            headers:  {
                'Content-Type':   'application/json',
                'Content-Length': bodyBuf.length,
                ...headers,
            },
        };
        const req = lib.request(options, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end',  () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('error', reject);
        if (bodyBuf.length) req.write(bodyBuf);
        req.end();
    });
}

function post(targetUrl, body, headers) { return httpRequest('POST', targetUrl, body, headers); }
function getReq(targetUrl, headers)     { return httpRequest('GET',  targetUrl, '',   headers); }

function buildStripeSignature(rawBody, secret, timestamp) {
    const signed = `${timestamp}.${rawBody}`;
    const sig    = crypto.createHmac('sha256', secret).update(signed, 'utf8').digest('hex');
    return `t=${timestamp},v1=${sig}`;
}

function buildStripeEvent(clerkUserId, plan, baseTimestamp) {
    return {
        id:          `evt_test_retry_${baseTimestamp}`,
        object:      'event',
        api_version: '2023-10-16',
        created:     baseTimestamp,
        type:        'checkout.session.completed',
        data: {
            object: {
                id:                   `cs_test_retry_${baseTimestamp}`,
                object:               'checkout.session',
                client_reference_id:  clerkUserId,
                payment_status:       'paid',
                status:               'complete',
                metadata:             { plan },
                amount_total:         plan === 'pro' ? 3900 : 2500,
                currency:             'usd',
                mode:                 'payment',
            },
        },
    };
}

function parseJson(raw) {
    try { return JSON.parse(raw); } catch { return { raw }; }
}

async function verifyClerkPlan(clerkUserId, expectedPlan, clerkSecretKey) {
    const clerkUrl = `https://api.clerk.com/v1/users/${encodeURIComponent(clerkUserId)}`;
    let res;
    try {
        res = await getReq(clerkUrl, { Authorization: `Bearer ${clerkSecretKey}` });
    } catch (err) {
        return { ok: false, error: `Clerk API unreachable: ${err.message}` };
    }
    if (res.status !== 200) {
        return { ok: false, error: `Clerk returned HTTP ${res.status}` };
    }
    let user;
    try { user = JSON.parse(res.body); } catch {
        return { ok: false, error: 'Clerk response was not valid JSON' };
    }
    const actual = user.public_metadata && user.public_metadata.plan;
    if (actual !== expectedPlan) {
        return { ok: false, error: `Expected plan="${expectedPlan}" but Clerk has plan="${actual}"` };
    }
    return { ok: true, plan: actual };
}

function step(n, total, label) { console.log(`\n  [ ${n}/${total} ] ${label}`); }
function ok(msg)   { console.log(`          ✓  ${msg}`); }
function fail(msg) { console.error(`          ✗  ${msg}`); }
function info(msg) { console.log(`             ${msg}`); }

// ---------------------------------------------------------------------------
// Scenario A — Full webhook retry: same body, delivery 1 fails, delivery 2 ok
// ---------------------------------------------------------------------------

async function scenarioA(opts, webhookSecret, clerkSecretKey, clerkUserId) {
    console.log('\n┌─ Scenario A: Full Webhook Retry — Same Body, Delivery 1 Fails');
    console.log('│');
    console.log('│  Both deliveries send the EXACT same JSON payload to /api/webhooks/stripe.');
    console.log('│  Delivery 1 includes X-Test-Force-Clerk-Error: 1 which the webhook handler');
    console.log('│  forwards to set-plan (when ENABLE_WEBHOOK_TEST_HOOKS=true).  set-plan');
    console.log('│  records nonce N, fires the test hook, calls deleteNonce(N) via the');
    console.log('│  production error branch, and returns 502.  Delivery 2 omits the header');
    console.log('│  so set-plan reaches Clerk normally and returns 200.');

    const webhookUrl = opts.baseUrl + '/api/webhooks/stripe';
    const plan       = opts.plan;
    const baseTs     = Math.floor(Date.now() / 1000);

    const event   = buildStripeEvent(clerkUserId, plan, baseTs);
    const rawBody = JSON.stringify(event);   // identical bytes for both deliveries

    // ── Delivery 1: force failure via test hook ──────────────────────────────
    step(1, 3, 'Delivery 1 — X-Test-Force-Clerk-Error: 1  (expect 502: deleteNonce fires)');

    const ts1  = baseTs;
    const sig1 = buildStripeSignature(rawBody, webhookSecret, ts1);
    info(`Event ID  : ${event.id}`);
    info(`Signature : ${sig1.slice(0, 72)}...`);

    let res1;
    try {
        res1 = await post(webhookUrl, rawBody, {
            'stripe-signature':        sig1,
            'x-test-force-clerk-error': '1',
        });
    } catch (err) {
        fail(`Could not reach ${webhookUrl}: ${err.message}`);
        return false;
    }
    const p1 = parseJson(res1.body);
    info(`HTTP ${res1.status}  ${JSON.stringify(p1)}`);

    if (res1.status === 200) {
        fail(
            'Got 200 — expected 502.  The test hook did not fire. ' +
            'Make sure ENABLE_WEBHOOK_TEST_HOOKS=true is set in the deployment env ' +
            '(Vercel > Project > Environment Variables).'
        );
        return false;
    }
    if (res1.status === 400) {
        fail('Got 400 — signature rejected before the event was processed.');
        info('Check that STRIPE_WEBHOOK_SECRET matches the value in Vercel.');
        return false;
    }
    if (res1.status !== 502) {
        fail(`Unexpected HTTP ${res1.status} — expected 502 from test hook.`);
        return false;
    }
    ok('Delivery 1 returned 502 — test hook fired, deleteNonce(N) called automatically');

    // ── Delivery 2 (retry): same body, no test header — must succeed ─────────
    step(2, 3, 'Delivery 2 — same body, no test header (Stripe retry semantics — expect 200)');

    // Stripe re-signs with the original body bytes and a fresh timestamp.
    const ts2  = Math.floor(Date.now() / 1000);
    const sig2 = buildStripeSignature(rawBody, webhookSecret, ts2);
    info(`Same raw body, fresh t=${ts2}`);

    let res2;
    try {
        res2 = await post(webhookUrl, rawBody, { 'stripe-signature': sig2 });
    } catch (err) {
        fail(`Could not reach ${webhookUrl}: ${err.message}`);
        return false;
    }
    const p2 = parseJson(res2.body);
    info(`HTTP ${res2.status}  ${JSON.stringify(p2)}`);

    if (res2.status !== 200 || !p2.ok) {
        fail('Delivery 2 (retry) failed — user would be left on the free plan.');
        if (res2.status === 502) info('Check that CLERK_USER_ID exists in your Clerk project.');
        return false;
    }
    ok('Delivery 2 returned 200 — retry succeeded after simulated first-delivery failure');

    // ── Clerk verification ───────────────────────────────────────────────────
    step(3, 3, 'Verifying Clerk publicMetadata.plan');
    const check = await verifyClerkPlan(clerkUserId, plan, clerkSecretKey);
    if (!check.ok) {
        fail(`Clerk metadata check failed: ${check.error}`);
        return false;
    }
    ok(`Clerk has plan="${check.plan}" for userId=${clerkUserId}`);

    console.log('\n└─ Scenario A PASSED ✓');
    return true;
}

// ---------------------------------------------------------------------------
// Scenario B — deleteNonce-on-error: direct set-plan calls, same nonce value
// ---------------------------------------------------------------------------

async function scenarioB(opts, setPlanSecret, clerkSecretKey, clerkUserId) {
    console.log('\n┌─ Scenario B: deleteNonce-on-error — Direct set-plan Calls, Same Nonce');
    console.log('│');
    console.log('│  Exercises the case where a set-plan caller reuses the SAME nonce value');
    console.log('│  across attempts (e.g. an admin script or future idempotency layer).');
    console.log('│  The test hook forces a Clerk failure on call 1; call 2 with the same');
    console.log('│  nonce must succeed because deleteNonce() cleaned up the store.');
    console.log('│');
    console.log('│  Steps:');
    console.log('│    1. POST /api/set-plan  nonce=N  + X-Test-Force-Clerk-Error: 1');
    console.log('│       → recordNonce(N) runs → test hook fires → deleteNonce(N) auto-called');
    console.log('│       → returns 502');
    console.log('│    2. POST /api/set-plan  nonce=N  (no test header)');
    console.log('│       → nonce N absent from store (deleted above) → Clerk updated → 200');
    console.log('│    3. Verify Clerk has the correct plan');

    const setPlanUrl = opts.baseUrl + '/api/set-plan';
    const plan       = opts.plan;
    const nonce      = `retry-test-${crypto.randomUUID()}`;

    function headers(extra) {
        return {
            Authorization: `Bearer ${setPlanSecret}`,
            'X-Timestamp': String(Math.floor(Date.now() / 1000)),
            'X-Nonce':     nonce,
            ...extra,
        };
    }

    const payload = JSON.stringify({ userId: clerkUserId, plan });

    // ── Step 1: same nonce + test hook → 502, deleteNonce auto-fires ─────────
    step(1, 3, 'POST /api/set-plan  nonce=N + X-Test-Force-Clerk-Error: 1  (expect 502)');
    info(`Nonce : ${nonce}`);

    let r1;
    try {
        r1 = await post(setPlanUrl, payload, headers({ 'x-test-force-clerk-error': '1' }));
    } catch (err) {
        fail(`Could not reach ${setPlanUrl}: ${err.message}`);
        return false;
    }
    const b1 = parseJson(r1.body);
    info(`HTTP ${r1.status}  ${JSON.stringify(b1)}`);

    if (r1.status === 200) {
        fail(
            'Got 200 — test hook did not fire. ' +
            'Ensure ENABLE_WEBHOOK_TEST_HOOKS=true is set in the deployment env.'
        );
        return false;
    }
    if (r1.status === 401) {
        fail('Got 401 — SET_PLAN_SECRET mismatch. Verify against the Vercel env var.');
        return false;
    }
    if (r1.status === 400 && (b1.error || '').toLowerCase().includes('duplicate')) {
        fail('Got "Duplicate nonce" on the first call — a previous run left a stuck nonce.');
        info('Wait ~5 minutes for the nonce TTL to expire, then re-run this script.');
        return false;
    }
    if (r1.status !== 502) {
        fail(`Unexpected HTTP ${r1.status} — expected 502 from test hook.`);
        return false;
    }
    ok('step 1 returned 502 — test hook fired, production deleteNonce branch executed');

    // ── Step 2: same nonce, no test hook → must succeed ──────────────────────
    step(2, 3, 'POST /api/set-plan  same nonce=N  (no test header — expect 200)');
    info(`Same nonce: ${nonce}`);

    let r2;
    try {
        r2 = await post(setPlanUrl, payload, headers());
    } catch (err) {
        fail(`Could not reach ${setPlanUrl}: ${err.message}`);
        return false;
    }
    const b2 = parseJson(r2.body);
    info(`HTTP ${r2.status}  ${JSON.stringify(b2)}`);

    if (r2.status === 400 && (b2.error || '').toLowerCase().includes('duplicate')) {
        fail(
            '"Duplicate nonce" on second call — deleteNonce was NOT called by the production ' +
            'error branch (step 1).  A Stripe retry after a transient Clerk error would be ' +
            'rejected with "Duplicate nonce" and the user would remain on the free plan.'
        );
        return false;
    }
    if (r2.status !== 200 || !b2.ok) {
        fail(`Expected 200 OK after nonce was cleared, got HTTP ${r2.status}: ${JSON.stringify(b2)}`);
        return false;
    }
    ok('step 2 returned 200 — nonce re-accepted after auto-delete → user NOT left on free plan');

    // ── Step 3: verify Clerk ─────────────────────────────────────────────────
    step(3, 3, 'Verifying Clerk publicMetadata.plan');
    const check = await verifyClerkPlan(clerkUserId, plan, clerkSecretKey);
    if (!check.ok) {
        fail(`Clerk metadata check failed: ${check.error}`);
        return false;
    }
    ok(`Clerk has plan="${check.plan}" for userId=${clerkUserId}`);

    console.log('\n└─ Scenario B PASSED ✓');
    return true;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
    const opts = parseArgs();

    const webhookSecret  = process.env.STRIPE_WEBHOOK_SECRET;
    const setPlanSecret  = process.env.SET_PLAN_SECRET;
    const clerkSecretKey = process.env.CLERK_SECRET_KEY;
    const clerkUserId    = process.env.CLERK_USER_ID;

    console.log('\nStripe Webhook Retry Smoke Test');
    console.log('================================');
    console.log(`Target base URL : ${opts.baseUrl}`);
    console.log(`Plan            : ${opts.plan}`);
    console.log(`Clerk user ID   : ${clerkUserId || '(not set)'}`);
    console.log('');
    console.log('NOTE: ENABLE_WEBHOOK_TEST_HOOKS=true must be set in the deployment env.');
    console.log('      Without it, Delivery 1 will return 200 instead of 502 and the test');
    console.log('      will fail — it cannot exercise the deleteNonce-on-error branch.');

    let missing = false;
    if (!webhookSecret)  { console.error('\nERROR: STRIPE_WEBHOOK_SECRET is not set. export STRIPE_WEBHOOK_SECRET=whsec_...'); missing = true; }
    if (!setPlanSecret)  { console.error('\nERROR: SET_PLAN_SECRET is not set. export SET_PLAN_SECRET=<value from Vercel>');  missing = true; }
    if (!clerkSecretKey) { console.error('\nERROR: CLERK_SECRET_KEY is not set. export CLERK_SECRET_KEY=sk_test_...');        missing = true; }
    if (!clerkUserId)    {
        console.error('\nERROR: CLERK_USER_ID is not set. export CLERK_USER_ID=user_...');
        console.error('  Find it at https://dashboard.clerk.com > Users.');
        missing = true;
    }
    if (missing) process.exit(1);

    const aOk = await scenarioA(opts, webhookSecret, clerkSecretKey, clerkUserId);
    const bOk = await scenarioB(opts, setPlanSecret, clerkSecretKey, clerkUserId);

    console.log('\n================================================');
    if (aOk && bOk) {
        console.log('✓ ALL SCENARIOS PASSED');
        console.log('');
        console.log('  Scenario A  Same event body sent twice. Delivery 1 returned 502');
        console.log('              (test hook forced a Clerk failure, deleteNonce called');
        console.log('              automatically by set-plan\'s production error branch).');
        console.log('              Delivery 2 returned 200 — Stripe retry unblocked.');
        console.log('              Clerk confirmed the plan was set — user NOT on free plan.');
        console.log('');
        console.log('  Scenario B  Same nonce N used across two direct set-plan calls.');
        console.log('              deleteNonce(N) was called automatically after the');
        console.log('              simulated Clerk failure on call 1, allowing call 2');
        console.log('              with the identical nonce to succeed and update Clerk.');
        process.exit(0);
    } else {
        console.log('✗ ONE OR MORE SCENARIOS FAILED — see details above.');
        process.exit(1);
    }
}

main().catch((err) => {
    console.error('\nUnexpected error:', err.message);
    process.exit(1);
});
