/**
 * @jest-environment node
 *
 * subscription.deleted must not downgrade users with lifetime entitlement.
 */

'use strict';

const crypto = require('crypto');
const { makeFakeDb } = require('./_helpers/mongo-mock');

const SET_PLAN_SECRET = 'test_set_plan_secret_lifetime_guard';
const WEBHOOK_SECRET = 'whsec_test_lifetime_guard_secret';

function sign(body, secret) {
    const timestamp = Math.floor(Date.now() / 1000);
    const payload = `${timestamp}.${body}`;
    const sig = crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
    return `t=${timestamp},v1=${sig}`;
}

function makeStreamReq(rawBody, headers = {}) {
    const req = new (require('events').EventEmitter)();
    req.method = 'POST';
    req.headers = headers;
    process.nextTick(() => {
        req.emit('data', Buffer.from(rawBody));
        req.emit('end');
    });
    return req;
}

function makeRes() {
    return {
        _status: null,
        _body: null,
        status(code) { this._status = code; return this; },
        json(body) { this._body = body; return this; },
    };
}

describe('stripe webhook — lifetime downgrade guard', () => {
    let fakeDb;
    let webhookHandler;
    let setPlanCalls;

    beforeEach(() => {
        jest.resetModules();
        setPlanCalls = 0;
        fakeDb = makeFakeDb();
        process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
        process.env.SET_PLAN_SECRET = SET_PLAN_SECRET;
        process.env.BASE_URL = 'https://test.example.com';
        process.env.CLERK_SECRET_KEY = 'sk_test_clerk_lifetime';
        process.env.STRIPE_SECRET_KEY = 'sk_test_stripe_lifetime';
        process.env.STRIPE_PRICE_STARTER_MONTHLY = 'price_starter_monthly';

        jest.doMock('../api/_db', () => ({ getDb: async () => fakeDb }));

        webhookHandler = require('../api/webhooks/stripe');

        global.fetch = jest.fn(async (url) => {
            const urlStr = String(url);
            if (urlStr.includes('api.clerk.com/v1/users/')) {
                return {
                    ok: true,
                    json: async () => ({
                        public_metadata: { plan: 'starter', billingPeriod: 'lifetime' },
                    }),
                };
            }
            if (urlStr.includes('/api/set-plan')) {
                setPlanCalls++;
                return { ok: true, status: 200, json: async () => ({ ok: true }) };
            }
            throw new Error(`Unexpected fetch: ${urlStr}`);
        });
    });

    afterEach(() => {
        delete global.fetch;
    });

    test('customer.subscription.deleted is ignored when user has lifetime billingPeriod', async () => {
        await fakeDb.collection('customers').insertOne({
            stripeCustomerId: 'cus_lifetime_guard',
            clerkUserId: 'user_lifetime_guard',
        });

        const stripeEvent = {
            id: 'evt_lifetime_guard_del_001',
            type: 'customer.subscription.deleted',
            data: {
                object: {
                    id: 'sub_old_monthly_001',
                    customer: 'cus_lifetime_guard',
                    status: 'canceled',
                },
            },
        };
        const rawBody = JSON.stringify(stripeEvent);
        const res = makeRes();

        await webhookHandler(
            makeStreamReq(rawBody, { 'stripe-signature': sign(rawBody, WEBHOOK_SECRET) }),
            res
        );

        expect(res._status).toBe(200);
        expect(res._body.ok).toBe(true);
        expect(res._body.reason).toBe('retained_entitlement');
        expect(setPlanCalls).toBe(0);
    });
});
