/**
 * @jest-environment node
 */

'use strict';

function makeReqRes({ body = {}, env = {}, clerkMetadata = {} } = {}) {
    const saved = {};
    for (const [k, v] of Object.entries(env)) {
        saved[k] = process.env[k];
        process.env[k] = v;
    }

    const res = {
        _status: null,
        _body: null,
        status(code) { this._status = code; return this; },
        json(b) { this._body = b; return this; },
        setHeader() {},
    };

    const req = { method: 'POST', headers: {}, body };

    const restore = () => {
        for (const [k] of Object.entries(env)) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
    };

    return { req, res, restore, clerkMetadata };
}

const BASE_ENV = {
    STRIPE_SECRET_KEY: 'sk_test_checkout_period',
    STRIPE_PRICE_STARTER_MONTHLY: 'price_starter_monthly',
    STRIPE_PRICE_STARTER_ANNUAL: 'price_starter_annual',
    STRIPE_PRICE_STARTER_LIFETIME: 'price_starter_lifetime',
    STRIPE_PRICE_PRO_MONTHLY: 'price_pro_monthly',
    STRIPE_PRICE_PRO_ANNUAL: 'price_pro_annual',
    STRIPE_PRICE_PRO_LIFETIME: 'price_pro_lifetime',
    CLERK_SECRET_KEY: 'sk_test_clerk_checkout_period',
};

describe('POST /api/checkout — billing period upgrades', () => {
    let handler;

    beforeEach(() => {
        jest.resetModules();
        jest.doMock('../api/_verify-clerk-token', () => ({
            verifyClerkToken: jest.fn().mockResolvedValue('user_period_test'),
            verifyClerkTokenFull: jest.fn().mockResolvedValue(null),
            isConfigured: true,
        }));
        handler = require('../api/checkout');
    });

    function mockFetchForClerk(metadata, stripeOk = true) {
        global.fetch = jest.fn(async (url) => {
            if (String(url).includes('api.clerk.com')) {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        public_metadata: metadata,
                        email_addresses: [{ email_address: 'test@example.com' }],
                    }),
                };
            }
            if (String(url).includes('api.stripe.com')) {
                return {
                    ok: stripeOk,
                    status: stripeOk ? 200 : 502,
                    json: async () => (stripeOk ? { url: 'https://checkout.stripe.test/session' } : { error: { message: 'fail' } }),
                };
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });
    }

    test('allows starter monthly user to checkout starter annual', async () => {
        const { req, res, restore } = makeReqRes({
            body: { plan: 'starter', period: 'annual' },
            env: BASE_ENV,
        });
        mockFetchForClerk({ plan: 'starter', billingPeriod: 'monthly' });

        await handler(req, res);
        expect(res._status).toBe(200);
        expect(res._body.ok).toBe(true);
        restore();
    });

    test('returns 409 when starter monthly user checks out starter monthly again', async () => {
        const { req, res, restore } = makeReqRes({
            body: { plan: 'starter', period: 'monthly' },
            env: BASE_ENV,
        });
        mockFetchForClerk({ plan: 'starter', billingPeriod: 'monthly' });

        await handler(req, res);
        expect(res._status).toBe(409);
        expect(res._body.error).toMatch(/billing period/i);
        restore();
    });

    test('allows starter monthly user to checkout starter lifetime', async () => {
        const { req, res, restore } = makeReqRes({
            body: { plan: 'starter', period: 'lifetime' },
            env: BASE_ENV,
        });
        mockFetchForClerk({ plan: 'starter', billingPeriod: 'monthly', stripeCustomerId: 'cus_existing' });

        await handler(req, res);
        expect(res._status).toBe(200);
        expect(res._body.ok).toBe(true);
        restore();
    });
});
