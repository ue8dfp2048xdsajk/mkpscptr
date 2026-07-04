/**
 * @jest-environment node
 *
 * Lifetime checkout.session.completed must store stripeCustomerId even when
 * the webhook event payload omits session.customer (Guest / pre-fix sessions).
 */

'use strict';

const crypto = require('crypto');
const { EventEmitter } = require('events');
const { makeFakeDb } = require('./_helpers/mongo-mock');

const WEBHOOK_SECRET = 'whsec_test_lifetime_customer';
const SET_PLAN_SECRET = 'set_plan_secret_lifetime_customer';

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

describe('stripe webhook - lifetime customer resolution', () => {
    let webhookHandler;
    let fakeDb;
    let clerkPatches;

    beforeEach(() => {
        jest.resetModules();
        clerkPatches = [];
        fakeDb = makeFakeDb();
        process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
        process.env.SET_PLAN_SECRET = SET_PLAN_SECRET;
        process.env.BASE_URL = 'https://test.example.com';
        process.env.CLERK_SECRET_KEY = 'sk_test_clerk_lifetime_customer';
        process.env.STRIPE_SECRET_KEY = 'sk_test_stripe_lifetime_customer';

        jest.doMock('../api/_db', () => ({ getDb: async () => fakeDb }));
        webhookHandler = require('../api/webhooks/stripe');

        global.fetch = jest.fn(async (url, options) => {
            const urlStr = String(url);
            const method = ((options && options.method) || 'GET').toUpperCase();

            if (urlStr.includes('/api/set-plan')) {
                return { ok: true, status: 200, json: async () => ({ ok: true }) };
            }

            if (urlStr.includes('api.stripe.com/v1/checkout/sessions/cs_lifetime_no_cust')) {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        id: 'cs_lifetime_no_cust',
                        customer: 'cus_from_expanded_session',
                        line_items: { data: [] },
                    }),
                };
            }

            if (urlStr.includes('api.stripe.com')) {
                return { ok: true, status: 200, json: async () => ({ data: [] }) };
            }

            if (urlStr.includes('api.clerk.com') && method === 'PATCH') {
                clerkPatches.push(JSON.parse(options.body));
                return { ok: true, status: 200, json: async () => ({}) };
            }

            if (urlStr.includes('api.clerk.com')) {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({ public_metadata: { plan: 'free' } }),
                };
            }

            throw new Error(`Unexpected fetch: ${urlStr}`);
        });
    });

    afterEach(() => {
        delete global.fetch;
    });

    test('checkout.session.completed stores customer fetched from Stripe when event omits it', async () => {
        const stripeEvent = {
            id: 'evt_lifetime_customer_001',
            type: 'checkout.session.completed',
            data: {
                object: {
                    id: 'cs_lifetime_no_cust',
                    client_reference_id: 'user_lifetime_customer_001',
                    customer: null,
                    mode: 'payment',
                    metadata: { plan: 'starter', period: 'lifetime' },
                },
            },
        };
        const rawBody = JSON.stringify(stripeEvent);
        const res = makeRes();

        await webhookHandler(makeStreamReq(rawBody), res);

        expect(res._status).toBe(200);
        expect(res._body.ok).toBe(true);

        const mapping = await fakeDb.collection('customers').findOne({ clerkUserId: 'user_lifetime_customer_001' });
        expect(mapping).toBeTruthy();
        expect(mapping.stripeCustomerId).toBe('cus_from_expanded_session');

        const stripeCustomerPatch = clerkPatches.find(
            (p) => p.public_metadata && p.public_metadata.stripeCustomerId === 'cus_from_expanded_session'
        );
        expect(stripeCustomerPatch).toBeTruthy();
    });
});
