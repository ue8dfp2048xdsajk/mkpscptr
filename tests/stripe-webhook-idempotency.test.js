/**
 * @jest-environment node
 *
 * Regression test for the webhook idempotency un-claim fix (commit bebea27).
 *
 * Bug being guarded against: api/webhooks/stripe.js claims a Stripe event ID
 * in MongoDB's idempotency_keys collection (tryClaimStripeEvent) BEFORE
 * attempting to store the customer mapping / call /api/set-plan. If any of
 * those downstream steps failed, the event stayed claimed forever. Stripe's
 * automatic retry (same event.id) would then hit tryClaimStripeEvent, see
 * the event already claimed, and get silently swallowed with
 * `200 { ok: true, ignored: true, reason: 'duplicate_event' }` — Stripe sees
 * success and stops retrying, but the customer's plan was never actually
 * updated. This is exactly how a Starter customer ended up with
 * stripeCustomerId set but no plan.
 *
 * The fix: every failure branch that returns a non-2xx status after the
 * event was claimed must first call unclaimStripeEvent(event.id) to delete
 * the idempotency_keys record, so a genuine retry re-runs the handler
 * instead of being swallowed.
 *
 * This suite verifies, for every affected event type and failure branch,
 * that a retry with the same event.id after a failure actually re-executes
 * (calls set-plan/Clerk again) rather than being swallowed as a duplicate.
 */

'use strict';

const crypto = require('crypto');
const { EventEmitter } = require('events');
const { makeFakeDb } = require('./_helpers/mongo-mock');

const WEBHOOK_SECRET = 'whsec_test_idempotency_regression_secret';
const SET_PLAN_SECRET = 'idempotency_regression_set_plan_secret';
const BASE_URL = 'https://mkpscptr.vercel.app';
const CLERK_SECRET_KEY = 'sk_test_clerk_dummy';

function buildStripeSignature(rawBodyStr) {
    const timestamp = Math.floor(Date.now() / 1000);
    const signedPayload = `${timestamp}.${rawBodyStr}`;
    const hmac = crypto
        .createHmac('sha256', WEBHOOK_SECRET)
        .update(signedPayload, 'utf8')
        .digest('hex');
    return `t=${timestamp},v1=${hmac}`;
}

function makeStreamReq(bodyStr) {
    const sigHeader = buildStripeSignature(bodyStr);
    const emitter = new EventEmitter();
    emitter.method = 'POST';
    emitter.headers = { 'stripe-signature': sigHeader };
    process.nextTick(() => {
        emitter.emit('data', Buffer.from(bodyStr, 'utf8'));
        emitter.emit('end');
    });
    return emitter;
}

function makeRes() {
    return {
        _status: null,
        _body: null,
        status(code) { this._status = code; return this; },
        json(body) { this._body = body; return this; },
        setHeader() {},
        end() {},
    };
}

describe('Stripe webhook idempotency — unclaimStripeEvent releases the claim on failure', () => {
    let webhookHandler;
    let setPlanHandler;
    let fakeDb;
    const savedEnv = {};

    beforeEach(() => {
        jest.resetModules();

        const envOverrides = {
            STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
            SET_PLAN_SECRET,
            BASE_URL,
            CLERK_SECRET_KEY,
        };
        for (const [k, v] of Object.entries(envOverrides)) {
            savedEnv[k] = process.env[k];
            process.env[k] = v;
        }
        delete process.env.UPSTASH_REDIS_REST_URL;
        delete process.env.UPSTASH_REDIS_REST_TOKEN;
        delete process.env.DATABASE_URL;

        fakeDb = makeFakeDb();
        jest.doMock('../api/_db', () => ({ getDb: async () => fakeDb }));

        webhookHandler = require('../api/webhooks/stripe');
        setPlanHandler = require('../api/set-plan');
    });

    afterEach(() => {
        for (const [k, v] of Object.entries(savedEnv)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
        jest.clearAllMocks();
    });

    /** Wire global.fetch to route /api/set-plan calls into the real setPlanHandler,
     *  and Clerk calls through a caller-provided responder. */
    function installFetchRouter(clerkResponder) {
        global.fetch = jest.fn(async (url, options) => {
            const urlStr = String(url);

            if (urlStr.includes('/api/set-plan')) {
                const bodyStr = options && options.body ? String(options.body) : '{}';
                const reqHeaders = {};
                for (const [k, v] of Object.entries((options && options.headers) || {})) {
                    reqHeaders[k.toLowerCase()] = v;
                }
                const setPlanReq = {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json',
                        authorization: reqHeaders['authorization'] || '',
                        'x-timestamp': reqHeaders['x-timestamp'] || '',
                        'x-nonce': reqHeaders['x-nonce'] || '',
                    },
                    body: bodyStr,
                    socket: { remoteAddress: '127.0.0.1' },
                };
                const setPlanRes = makeRes();
                await setPlanHandler(setPlanReq, setPlanRes);
                const isOk = setPlanRes._status >= 200 && setPlanRes._status < 300;
                return { ok: isOk, status: setPlanRes._status, json: async () => setPlanRes._body };
            }

            if (urlStr.includes('api.clerk.com')) {
                return clerkResponder(urlStr, options);
            }

            throw new Error(`Unexpected fetch to: ${urlStr}`);
        });
    }

    test('checkout.session.completed: storeCustomerMapping failure releases the claim so a retry re-runs', async () => {
        const stripeEvent = {
            id: 'evt_idem_mapping_fail_001',
            type: 'checkout.session.completed',
            data: {
                object: {
                    id: 'cs_idem_mapping_fail_001',
                    client_reference_id: 'user_mapping_fail_001',
                    customer: 'cus_mapping_fail_001',
                    metadata: { plan: 'starter' },
                },
            },
        };
        const rawBody = JSON.stringify(stripeEvent);

        // Make the customers collection's updateOne fail exactly once, to
        // simulate a transient MongoDB write failure during storeCustomerMapping.
        const realUpdateOne = fakeDb.collection('customers').updateOne.bind(fakeDb.collection('customers'));
        let updateOneCalls = 0;
        fakeDb.collection('customers').updateOne = async (...args) => {
            updateOneCalls++;
            if (updateOneCalls === 1) throw new Error('transient Mongo write failure');
            return realUpdateOne(...args);
        };

        installFetchRouter(() => ({ ok: true, status: 200, json: async () => ({}) }));

        // Attempt 1 — storeCustomerMapping fails → 500, event must be un-claimed.
        const res1 = makeRes();
        await webhookHandler(makeStreamReq(rawBody), res1);
        expect(res1._status).toBe(500);
        expect(res1._body.ok).toBe(false);

        // The claim must have been released — not left stuck in idempotency_keys.
        const claimAfterFailure = await fakeDb.collection('idempotency_keys').findOne({ _id: stripeEvent.id });
        expect(claimAfterFailure).toBeNull();

        // Attempt 2 (retry, same event.id) — must actually re-run, not be
        // swallowed as a duplicate, and this time storeCustomerMapping succeeds.
        const res2 = makeRes();
        await webhookHandler(makeStreamReq(rawBody), res2);
        expect(res2._status).toBe(200);
        expect(res2._body.ok).toBe(true);
        expect(res2._body.reason).not.toBe('duplicate_event');
        expect(updateOneCalls).toBe(2);
    });

    test('checkout.session.completed: set-plan fetch error (network) releases the claim so a retry re-runs', async () => {
        const stripeEvent = {
            id: 'evt_idem_fetch_error_001',
            type: 'checkout.session.completed',
            data: {
                object: {
                    id: 'cs_idem_fetch_error_001',
                    client_reference_id: 'user_fetch_error_001',
                    metadata: { plan: 'pro' },
                },
            },
        };
        const rawBody = JSON.stringify(stripeEvent);

        let attempt = 0;
        global.fetch = jest.fn(async (url, options) => {
            const urlStr = String(url);
            attempt++;
            if (urlStr.includes('/api/set-plan')) {
                if (attempt === 1) throw new Error('ECONNREFUSED');
                // Second attempt: route through the real set-plan handler.
                const bodyStr = options && options.body ? String(options.body) : '{}';
                const reqHeaders = {};
                for (const [k, v] of Object.entries((options && options.headers) || {})) {
                    reqHeaders[k.toLowerCase()] = v;
                }
                const setPlanReq = {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json',
                        authorization: reqHeaders['authorization'] || '',
                        'x-timestamp': reqHeaders['x-timestamp'] || '',
                        'x-nonce': reqHeaders['x-nonce'] || '',
                    },
                    body: bodyStr,
                    socket: { remoteAddress: '127.0.0.1' },
                };
                const setPlanRes = makeRes();
                await setPlanHandler(setPlanReq, setPlanRes);
                const isOk = setPlanRes._status >= 200 && setPlanRes._status < 300;
                return { ok: isOk, status: setPlanRes._status, json: async () => setPlanRes._body };
            }
            if (urlStr.includes('api.clerk.com')) {
                return { ok: true, status: 200, json: async () => ({}) };
            }
            throw new Error(`Unexpected fetch to: ${urlStr}`);
        });

        const res1 = makeRes();
        await webhookHandler(makeStreamReq(rawBody), res1);
        expect(res1._status).toBe(502);
        expect(res1._body.ok).toBe(false);

        const claimAfterFailure = await fakeDb.collection('idempotency_keys').findOne({ _id: stripeEvent.id });
        expect(claimAfterFailure).toBeNull();

        const res2 = makeRes();
        await webhookHandler(makeStreamReq(rawBody), res2);
        expect(res2._status).toBe(200);
        expect(res2._body.ok).toBe(true);
        expect(res2._body.reason).not.toBe('duplicate_event');
    });

    test('customer.subscription.updated: set-plan failure releases the claim so a retry re-runs', async () => {
        const subEvent = {
            id: 'evt_idem_sub_updated_001',
            type: 'customer.subscription.updated',
            data: {
                object: {
                    customer: 'cus_sub_updated_001',
                    status: 'active',
                    items: { data: [{ price: { id: process.env.STRIPE_PRICE_PRO_MONTHLY || 'price_pro_monthly' } }] },
                    cancel_at_period_end: false,
                },
            },
        };
        process.env.STRIPE_PRICE_PRO_MONTHLY = 'price_pro_monthly';
        const rawBody = JSON.stringify(subEvent);

        // Pre-seed the customer mapping so getClerkUserIdByCustomer resolves.
        await fakeDb.collection('customers').updateOne(
            { stripeCustomerId: 'cus_sub_updated_001' },
            { $set: { stripeCustomerId: 'cus_sub_updated_001', clerkUserId: 'user_sub_updated_001', updatedAt: new Date() } },
            { upsert: true }
        );

        let clerkCallCount = 0;
        installFetchRouter(() => {
            clerkCallCount++;
            if (clerkCallCount === 1) {
                return { ok: false, status: 500, json: async () => ({ errors: [{ message: 'Clerk down' }] }) };
            }
            return { ok: true, status: 200, json: async () => ({}) };
        });

        const res1 = makeRes();
        await webhookHandler(makeStreamReq(rawBody), res1);
        expect(res1._status).toBe(502);

        const claimAfterFailure = await fakeDb.collection('idempotency_keys').findOne({ _id: subEvent.id });
        expect(claimAfterFailure).toBeNull();

        const res2 = makeRes();
        await webhookHandler(makeStreamReq(rawBody), res2);
        expect(res2._status).toBe(200);
        expect(res2._body.ok).toBe(true);
        expect(res2._body.reason).not.toBe('duplicate_event');
        expect(res2._body.plan).toBe('pro');
    });

    test('customer.subscription.deleted: set-plan failure releases the claim so a retry re-runs', async () => {
        const subEvent = {
            id: 'evt_idem_sub_deleted_001',
            type: 'customer.subscription.deleted',
            data: { object: { customer: 'cus_sub_deleted_001' } },
        };
        const rawBody = JSON.stringify(subEvent);

        await fakeDb.collection('customers').updateOne(
            { stripeCustomerId: 'cus_sub_deleted_001' },
            { $set: { stripeCustomerId: 'cus_sub_deleted_001', clerkUserId: 'user_sub_deleted_001', updatedAt: new Date() } },
            { upsert: true }
        );

        let clerkCallCount = 0;
        installFetchRouter(() => {
            clerkCallCount++;
            if (clerkCallCount === 1) {
                return { ok: false, status: 500, json: async () => ({ errors: [{ message: 'Clerk down' }] }) };
            }
            return { ok: true, status: 200, json: async () => ({}) };
        });

        const res1 = makeRes();
        await webhookHandler(makeStreamReq(rawBody), res1);
        expect(res1._status).toBe(502);

        const claimAfterFailure = await fakeDb.collection('idempotency_keys').findOne({ _id: subEvent.id });
        expect(claimAfterFailure).toBeNull();

        const res2 = makeRes();
        await webhookHandler(makeStreamReq(rawBody), res2);
        expect(res2._status).toBe(200);
        expect(res2._body.ok).toBe(true);
        expect(res2._body.reason).not.toBe('duplicate_event');
        expect(res2._body.plan).toBe('free');
    });

    test('invoice.payment_failed (final failure): set-plan failure releases the claim so a retry re-runs', async () => {
        const invoiceEvent = {
            id: 'evt_idem_invoice_failed_001',
            type: 'invoice.payment_failed',
            data: {
                object: {
                    customer: 'cus_invoice_failed_001',
                    attempt_count: 4,
                    next_payment_attempt: null,
                },
            },
        };
        const rawBody = JSON.stringify(invoiceEvent);

        await fakeDb.collection('customers').updateOne(
            { stripeCustomerId: 'cus_invoice_failed_001' },
            { $set: { stripeCustomerId: 'cus_invoice_failed_001', clerkUserId: 'user_invoice_failed_001', updatedAt: new Date() } },
            { upsert: true }
        );

        let clerkCallCount = 0;
        installFetchRouter(() => {
            clerkCallCount++;
            if (clerkCallCount === 1) {
                return { ok: false, status: 500, json: async () => ({ errors: [{ message: 'Clerk down' }] }) };
            }
            return { ok: true, status: 200, json: async () => ({}) };
        });

        const res1 = makeRes();
        await webhookHandler(makeStreamReq(rawBody), res1);
        expect(res1._status).toBe(502);

        const claimAfterFailure = await fakeDb.collection('idempotency_keys').findOne({ _id: invoiceEvent.id });
        expect(claimAfterFailure).toBeNull();

        const res2 = makeRes();
        await webhookHandler(makeStreamReq(rawBody), res2);
        expect(res2._status).toBe(200);
        expect(res2._body.ok).toBe(true);
        expect(res2._body.reason).not.toBe('duplicate_event');
        expect(res2._body.plan).toBe('free');
    });

    test('successful processing leaves the claim in place — an exact duplicate delivery is swallowed', async () => {
        const stripeEvent = {
            id: 'evt_idem_success_001',
            type: 'checkout.session.completed',
            data: {
                object: {
                    id: 'cs_idem_success_001',
                    client_reference_id: 'user_success_001',
                    metadata: { plan: 'starter' },
                },
            },
        };
        const rawBody = JSON.stringify(stripeEvent);

        installFetchRouter(() => ({ ok: true, status: 200, json: async () => ({}) }));

        const res1 = makeRes();
        await webhookHandler(makeStreamReq(rawBody), res1);
        expect(res1._status).toBe(200);

        // Claim remains — this is correct: a truly successful delivery should
        // NOT be re-processed if Stripe re-delivers the exact same event.
        const claimAfterSuccess = await fakeDb.collection('idempotency_keys').findOne({ _id: stripeEvent.id });
        expect(claimAfterSuccess).not.toBeNull();

        const res2 = makeRes();
        await webhookHandler(makeStreamReq(rawBody), res2);
        expect(res2._status).toBe(200);
        expect(res2._body.reason).toBe('duplicate_event');
    });
});
