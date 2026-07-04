/**
 * @jest-environment node
 *
 * Tests for the STRIPE_WEBHOOK_SECRET configuration check in
 * api/webhooks/stripe.js and scripts/check-env.js.
 *
 * These tests verify:
 *  1. GET /api/webhooks/stripe returns 200 + {ok:true} when all required
 *     env vars are set and STRIPE_WEBHOOK_SECRET starts with whsec_.
 *  2. GET returns 503 + {ok:false} when STRIPE_WEBHOOK_SECRET is missing.
 *  3. GET returns 503 + {ok:false} when STRIPE_WEBHOOK_SECRET has the
 *     wrong format (does not start with whsec_).
 *  4. POST without a Stripe-Signature header returns 400 (not 500),
 *     confirming the secret is present and the handler proceeds past the
 *     env-var gate.
 *  5. POST without a Stripe-Signature header returns 500 when
 *     STRIPE_WEBHOOK_SECRET is missing, confirming the guard is active.
 *  6. check-env.js validate() rejects values not starting with whsec_.
 */

'use strict';

const crypto = require('crypto');
const { EventEmitter } = require('events');
const { makeFakeDb } = require('./_helpers/mongo-mock');

function makeReqRes({ method = 'GET', headers = {}, env = {} } = {}) {
    const saved = {};
    for (const [k, v] of Object.entries(env)) {
        saved[k] = process.env[k];
        process.env[k] = v;
    }

    const res = {
        _status: null,
        _body: null,
        status(code) { this._status = code; return this; },
        json(body) { this._body = body; return this; },
    };

    const req = { method, headers };

    const restore = () => {
        for (const [k] of Object.entries(env)) {
            if (saved[k] === undefined) {
                delete process.env[k];
            } else {
                process.env[k] = saved[k];
            }
        }
    };

    return { req, res, restore };
}

const GOOD_ENV = {
    STRIPE_WEBHOOK_SECRET: 'whsec_test_dummy_secret_for_unit_tests',
    STRIPE_SECRET_KEY: 'sk_test_dummy_secret_for_unit_tests',
    SET_PLAN_SECRET: 'test_set_plan_secret',
    BASE_URL: 'https://mkpscptr.vercel.app',
};

describe('GET /api/webhooks/stripe - config health-check', () => {
    let handler;
    beforeAll(() => {
        jest.resetModules();
        handler = require('../api/webhooks/stripe');
    });

    test('returns 200 + ok:true when all required env vars are set correctly', async () => {
        const { req, res, restore } = makeReqRes({
            method: 'GET',
            headers: { authorization: `Bearer ${GOOD_ENV.SET_PLAN_SECRET}` },
            env: GOOD_ENV,
        });
        await handler(req, res);
        restore();
        expect(res._status).toBe(200);
        expect(res._body.ok).toBe(true);
        expect(res._body.configured.STRIPE_WEBHOOK_SECRET).toBe(true);
        expect(res._body.configured.SET_PLAN_SECRET).toBe(true);
        expect(res._body.configured.BASE_URL).toBe(true);
    });

    test('returns 503 + ok:false when STRIPE_WEBHOOK_SECRET is missing', async () => {
        const env = { ...GOOD_ENV };
        delete env.STRIPE_WEBHOOK_SECRET;
        const { req, res, restore } = makeReqRes({
            method: 'GET',
            headers: { authorization: `Bearer ${GOOD_ENV.SET_PLAN_SECRET}` },
            env: { ...env, STRIPE_WEBHOOK_SECRET: '' },
        });
        await handler(req, res);
        restore();
        expect(res._status).toBe(503);
        expect(res._body.ok).toBe(false);
        expect(res._body.configured.STRIPE_WEBHOOK_SECRET).toBe(false);
    });

    test('returns 503 + ok:false when STRIPE_WEBHOOK_SECRET has wrong format', async () => {
        const { req, res, restore } = makeReqRes({
            method: 'GET',
            headers: { authorization: `Bearer ${GOOD_ENV.SET_PLAN_SECRET}` },
            env: { ...GOOD_ENV, STRIPE_WEBHOOK_SECRET: 'not_a_valid_secret' },
        });
        await handler(req, res);
        restore();
        expect(res._status).toBe(503);
        expect(res._body.ok).toBe(false);
        expect(res._body.configured.STRIPE_WEBHOOK_SECRET).toBe(false);
    });
});

describe('GET /api/webhooks/stripe - STRIPE_SECRET_KEY health-check', () => {
    let handler;
    beforeAll(() => {
        jest.resetModules();
        handler = require('../api/webhooks/stripe');
    });

    test('returns 503 + configured.STRIPE_SECRET_KEY===false when STRIPE_SECRET_KEY is missing', async () => {
        const { req, res, restore } = makeReqRes({
            method: 'GET',
            headers: { authorization: `Bearer ${GOOD_ENV.SET_PLAN_SECRET}` },
            env: { ...GOOD_ENV, STRIPE_SECRET_KEY: '' },
        });
        await handler(req, res);
        restore();
        expect(res._status).toBe(503);
        expect(res._body.ok).toBe(false);
        expect(res._body.configured.STRIPE_SECRET_KEY).toBe(false);
    });

    test('returns 200 + ok:true when all four env vars are present', async () => {
        const { req, res, restore } = makeReqRes({
            method: 'GET',
            headers: { authorization: `Bearer ${GOOD_ENV.SET_PLAN_SECRET}` },
            env: GOOD_ENV,
        });
        await handler(req, res);
        restore();
        expect(res._status).toBe(200);
        expect(res._body.ok).toBe(true);
        expect(res._body.configured.STRIPE_SECRET_KEY).toBe(true);
        expect(res._body.configured.STRIPE_WEBHOOK_SECRET).toBe(true);
        expect(res._body.configured.SET_PLAN_SECRET).toBe(true);
        expect(res._body.configured.BASE_URL).toBe(true);
    });
});

describe('POST /api/webhooks/stripe - env-var gate', () => {
    let handler;
    beforeAll(() => {
        jest.resetModules();
        handler = require('../api/webhooks/stripe');
    });

    test('returns 400 (not 500) when secret is set but Stripe-Signature is missing', async () => {
        const { req, res, restore } = makeReqRes({
            method: 'POST',
            headers: {},
            env: GOOD_ENV,
        });
        await handler(req, res);
        restore();
        expect(res._status).toBe(400);
        expect(res._body.error).toMatch(/stripe-signature/i);
    });

    test('returns 500 when STRIPE_WEBHOOK_SECRET is not set', async () => {
        const { req, res, restore } = makeReqRes({
            method: 'POST',
            headers: { 'stripe-signature': 't=1,v1=abc' },
            env: { ...GOOD_ENV, STRIPE_WEBHOOK_SECRET: '' },
        });
        await handler(req, res);
        restore();
        expect(res._status).toBe(500);
        expect(res._body.error).toMatch(/webhook secret not configured/i);
    });
});

describe('scripts/check-env.js - STRIPE_WEBHOOK_SECRET validate()', () => {
    let REQUIRED;
    beforeAll(() => {
        jest.resetModules();
        const mod = require('fs');
        const src = mod.readFileSync('./scripts/check-env.js', 'utf8');
        const match = src.match(/const REQUIRED\s*=\s*(\[[\s\S]*?\]);/);
        if (!match) throw new Error('Could not extract REQUIRED array from check-env.js');
        REQUIRED = eval(match[1]);
    });

    test('STRIPE_WEBHOOK_SECRET validate() accepts a valid whsec_ value', () => {
        const entry = REQUIRED.find((r) => r.name === 'STRIPE_WEBHOOK_SECRET');
        expect(entry).toBeDefined();
        expect(entry.validate).toBeDefined();
        expect(entry.validate('whsec_test_dummy_secret_for_unit_tests')).toBe(true);
    });

    test('STRIPE_WEBHOOK_SECRET validate() rejects a value without whsec_ prefix', () => {
        const entry = REQUIRED.find((r) => r.name === 'STRIPE_WEBHOOK_SECRET');
        const result = entry.validate('sk_live_wrong_type');
        expect(typeof result).toBe('string');
        expect(result).toMatch(/whsec_/);
    });

    test('STRIPE_WEBHOOK_SECRET validate() rejects an empty string', () => {
        const entry = REQUIRED.find((r) => r.name === 'STRIPE_WEBHOOK_SECRET');
        const result = entry.validate('');
        expect(typeof result).toBe('string');
    });
});

describe('Stripe webhook retry & idempotency - MongoDB-backed claim and nonce store', () => {
    const WEBHOOK_SECRET = 'whsec_test_retry_integration_secret';
    const SET_PLAN_SECRET = 'retry_test_set_plan_secret';
    const BASE_URL = 'https://mkpscptr.vercel.app';
    const CLERK_SECRET_KEY = 'sk_test_clerk_dummy';

    let webhookHandler;
    let setPlanHandler;
    const savedEnv = {};

    beforeAll(() => {
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

        // Both the webhook's idempotency_keys claim and set-plan's nonce store
        // are MongoDB-backed - share one fake db across the whole describe
        // block so idempotency/nonce state persists across deliveries exactly
        // like it would against a real MongoDB instance.
        const fakeDb = makeFakeDb();
        jest.doMock('../api/_db', () => ({ getDb: async () => fakeDb }));

        webhookHandler = require('../api/webhooks/stripe');
        setPlanHandler = require('../api/set-plan');
    });

    afterAll(() => {
        for (const [k, v] of Object.entries(savedEnv)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    });

    function buildStripeSignature(rawBodyStr) {
        const timestamp = Math.floor(Date.now() / 1000);
        const signedPayload = `${timestamp}.${rawBodyStr}`;
        const hmac = crypto
            .createHmac('sha256', WEBHOOK_SECRET)
            .update(signedPayload, 'utf8')
            .digest('hex');
        return `t=${timestamp},v1=${hmac}`;
    }

    function makeStreamReq(sigHeader, bodyStr) {
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

    test('first attempt returns 502 when Clerk fails; second attempt (retry) succeeds', async () => {
        const stripeEvent = {
            id: 'evt_test_retry_001',
            type: 'checkout.session.completed',
            data: {
                object: {
                    id: 'cs_test_retry_001',
                    client_reference_id: 'user_retry_001',
                    metadata: { plan: 'starter' },
                },
            },
        };
        const rawBody = JSON.stringify(stripeEvent);

        let clerkCallCount = 0;

        const realFetch = global.fetch;
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
                return {
                    ok: isOk,
                    status: setPlanRes._status,
                    json: async () => setPlanRes._body,
                };
            }

            if (urlStr.includes('api.clerk.com')) {
                clerkCallCount += 1;
                if (clerkCallCount === 1) {
                    return {
                        ok: false,
                        status: 500,
                        json: async () => ({ errors: [{ message: 'Clerk internal server error' }] }),
                    };
                }
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({ id: 'user_retry_001', public_metadata: { plan: 'starter' } }),
                };
            }

            throw new Error(`Unexpected fetch to: ${urlStr}`);
        });

        try {
            const sig1 = buildStripeSignature(rawBody);
            const req1 = makeStreamReq(sig1, rawBody);
            const res1 = makeRes();
            await webhookHandler(req1, res1);

            expect(res1._status).toBe(502);
            expect(res1._body.ok).toBe(false);
            expect(clerkCallCount).toBe(1);

            const sig2 = buildStripeSignature(rawBody);
            const req2 = makeStreamReq(sig2, rawBody);
            const res2 = makeRes();
            await webhookHandler(req2, res2);

            expect(res2._status).toBe(200);
            expect(res2._body.ok).toBe(true);
            expect(res2._body.userId).toBe('user_retry_001');
            expect(res2._body.plan).toBe('starter');
            expect(clerkCallCount).toBe(2);
        } finally {
            global.fetch = realFetch;
        }
    });

    test('second delivery of same event ID is blocked by MongoDB idempotency claim - Clerk called exactly once', async () => {
        // Both deliveries share the same event.id. The first claims the event
        // in the shared MongoDB idempotency_keys collection (tryClaimStripeEvent);
        // the second delivery's claim attempt hits the same _id and is rejected
        // as a duplicate, short-circuiting with 200 before set-plan/Clerk are
        // ever called again. The set-plan nonce store (also MongoDB-backed,
        // keyed on the same event.id) is a second, independent layer of
        // defense that would also reject it if this first layer were ever
        // bypassed - see tests/nonce-replay.test.js and tests/nonce-race.test.js.
        const stripeEvent = {
            id: 'evt_test_idempotent_001',
            type: 'checkout.session.completed',
            data: {
                object: {
                    id: 'cs_test_idempotent_001',
                    client_reference_id: 'user_idempotent_001',
                    metadata: { plan: 'pro' },
                },
            },
        };
        const rawBody = JSON.stringify(stripeEvent);

        let clerkCallCount = 0;

        const realFetch = global.fetch;
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
                    socket: { remoteAddress: '127.0.0.2' },
                };
                const setPlanRes = makeRes();
                await setPlanHandler(setPlanReq, setPlanRes);
                const isOk = setPlanRes._status >= 200 && setPlanRes._status < 300;
                return {
                    ok: isOk,
                    status: setPlanRes._status,
                    json: async () => setPlanRes._body,
                };
            }

            if (urlStr.includes('api.clerk.com')) {
                clerkCallCount += 1;
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({ id: 'user_idempotent_001', public_metadata: { plan: 'pro' } }),
                };
            }

            throw new Error(`Unexpected fetch to: ${urlStr}`);
        });

        try {
            // First delivery: succeeds, nonce (event.id) recorded.
            const sig1 = buildStripeSignature(rawBody);
            const req1 = makeStreamReq(sig1, rawBody);
            const res1 = makeRes();
            await webhookHandler(req1, res1);
            expect(res1._status).toBe(200);
            expect(res1._body.ok).toBe(true);
            expect(clerkCallCount).toBe(1);

            // Second delivery of the same event: the MongoDB idempotency claim
            // for this event.id already exists, so tryClaimStripeEvent returns
            // false and the webhook short-circuits with 200 (ignored,
            // duplicate_event) without ever calling set-plan/Clerk again.
            const sig2 = buildStripeSignature(rawBody);
            const req2 = makeStreamReq(sig2, rawBody);
            const res2 = makeRes();
            await webhookHandler(req2, res2);
            expect(res2._status).toBe(200);
            expect(res2._body.ok).toBe(true);
            expect(res2._body.reason).toBe('duplicate_event');
            expect(clerkCallCount).toBe(1); // Clerk was NOT called again
        } finally {
            global.fetch = realFetch;
        }
    });

    test('concurrent deliveries of same Stripe event are deduplicated - Clerk called exactly once', async () => {
        // Two deliveries of the SAME event arrive simultaneously (e.g. Stripe
        // fires twice due to a network blip). Both carry the same event.id, so
        // MongoDB's atomic unique _id index on idempotency_keys ensures only one
        // wins tryClaimStripeEvent; the other is short-circuited with 200
        // (ignored, duplicate_event) before ever reaching set-plan/Clerk.
        const stripeEvent = {
            id: 'evt_test_concurrent_001',
            type: 'checkout.session.completed',
            data: {
                object: {
                    id: 'cs_test_concurrent_001',
                    client_reference_id: 'user_concurrent_001',
                    metadata: { plan: 'starter' },
                },
            },
        };
        const rawBody = JSON.stringify(stripeEvent);

        let clerkCallCount = 0;

        const realFetch = global.fetch;
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
                    socket: { remoteAddress: '127.0.0.3' },
                };
                const setPlanRes = makeRes();
                await setPlanHandler(setPlanReq, setPlanRes);
                const isOk = setPlanRes._status >= 200 && setPlanRes._status < 300;
                return {
                    ok: isOk,
                    status: setPlanRes._status,
                    json: async () => setPlanRes._body,
                };
            }

            if (urlStr.includes('api.clerk.com')) {
                clerkCallCount += 1;
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({ id: 'user_concurrent_001', public_metadata: { plan: 'starter' } }),
                };
            }

            throw new Error(`Unexpected fetch to: ${urlStr}`);
        });

        try {
            const sig1 = buildStripeSignature(rawBody);
            const sig2 = buildStripeSignature(rawBody);
            const req1 = makeStreamReq(sig1, rawBody);
            const req2 = makeStreamReq(sig2, rawBody);
            const res1 = makeRes();
            const res2 = makeRes();

            // Fire both deliveries concurrently.
            await Promise.all([
                webhookHandler(req1, res1),
                webhookHandler(req2, res2),
            ]);

            // Both responses are 200: the winner processes the payment normally,
            // the loser is short-circuited as an acknowledged duplicate. Only
            // one side actually reaches set-plan/Clerk, which is what matters
            // for correctness (no double-processing).
            expect(res1._status).toBe(200);
            expect(res2._status).toBe(200);
            const bodies = [res1._body, res2._body];
            const duplicateResponses = bodies.filter(b => b.reason === 'duplicate_event');
            const processedResponses = bodies.filter(b => b.reason !== 'duplicate_event');
            expect(duplicateResponses).toHaveLength(1);
            expect(processedResponses).toHaveLength(1);
            expect(processedResponses[0].userId).toBe('user_concurrent_001');
            expect(processedResponses[0].plan).toBe('starter');

            // Clerk must have been called exactly once - no duplicate upgrade.
            expect(clerkCallCount).toBe(1);
        } finally {
            global.fetch = realFetch;
        }
    });
});
