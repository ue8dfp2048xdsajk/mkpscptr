/**
 * @jest-environment node
 */

'use strict';

function makeReqRes({ body = {}, env = {} } = {}) {
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

    return { req, res, restore };
}

const BASE_ENV = {
    STRIPE_SECRET_KEY: 'sk_test_upgrade_flow',
    STRIPE_PRICE_STARTER_MONTHLY: 'price_starter_monthly',
    STRIPE_PRICE_STARTER_ANNUAL: 'price_starter_annual',
    STRIPE_PRICE_STARTER_LIFETIME: 'price_starter_lifetime',
    STRIPE_PRICE_PRO_MONTHLY: 'price_pro_monthly',
    STRIPE_PRICE_PRO_ANNUAL: 'price_pro_annual',
    STRIPE_PRICE_PRO_LIFETIME: 'price_pro_lifetime',
    CLERK_SECRET_KEY: 'sk_test_clerk_upgrade_flow',
    BASE_URL: 'https://mockupscripter.com',
};

describe('POST /api/checkout — prorated subscription upgrades', () => {
    let handler;
    let stripeCalls;

    beforeEach(() => {
        jest.resetModules();
        stripeCalls = [];
        jest.doMock('../api/_verify-clerk-token', () => ({
            verifyClerkToken: jest.fn().mockResolvedValue('user_upgrade_test'),
            verifyClerkTokenFull: jest.fn().mockResolvedValue(null),
            isConfigured: true,
        }));
        handler = require('../api/checkout');
    });

    function mockFetchStarterWithActiveSub() {
        global.fetch = jest.fn(async (url, options) => {
            const urlStr = String(url);
            if (urlStr.includes('api.clerk.com')) {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        public_metadata: {
                            plan: 'starter',
                            billingPeriod: 'monthly',
                            stripeCustomerId: 'cus_upgrade_test',
                        },
                        email_addresses: [{ email_address: 'test@example.com' }],
                    }),
                };
            }
            if (urlStr.includes('/v1/subscriptions?')) {
                stripeCalls.push({ type: 'list_subscriptions', url: urlStr });
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        data: [{
                            id: 'sub_starter_monthly',
                            created: 1000,
                            items: {
                                data: [{
                                    id: 'si_starter_monthly',
                                    price: { id: 'price_starter_monthly' },
                                }],
                            },
                        }],
                    }),
                };
            }
            if (urlStr.includes('/v1/billing_portal/sessions')) {
                stripeCalls.push({ type: 'portal', body: options && options.body });
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({ url: 'https://billing.stripe.test/portal-upgrade' }),
                };
            }
            if (urlStr.includes('/v1/checkout/sessions')) {
                stripeCalls.push({ type: 'checkout', body: options && options.body });
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({ url: 'https://checkout.stripe.test/new-sub' }),
                };
            }
            throw new Error(`Unexpected fetch: ${urlStr}`);
        });
    }

    test('starter monthly → pro monthly uses portal subscription_update_confirm', async () => {
        const { req, res, restore } = makeReqRes({
            body: { plan: 'pro', period: 'monthly' },
            env: BASE_ENV,
        });
        mockFetchStarterWithActiveSub();

        await handler(req, res);
        expect(res._status).toBe(200);
        expect(res._body.ok).toBe(true);
        expect(res._body.flow).toBe('subscription_update_confirm');
        expect(res._body.url).toBe('https://billing.stripe.test/portal-upgrade');

        const portalCall = stripeCalls.find((c) => c.type === 'portal');
        expect(portalCall).toBeTruthy();
        expect(String(portalCall.body)).toContain('subscription_update_confirm');
        expect(String(portalCall.body)).toContain('price_pro_monthly');
        expect(stripeCalls.some((c) => c.type === 'checkout')).toBe(false);

        restore();
    });

    test('free user → starter monthly still uses Checkout', async () => {
        const { req, res, restore } = makeReqRes({
            body: { plan: 'starter', period: 'monthly' },
            env: BASE_ENV,
        });
        global.fetch = jest.fn(async (url) => {
            if (String(url).includes('api.clerk.com')) {
                return {
                    ok: true,
                    json: async () => ({
                        public_metadata: { plan: 'free' },
                        email_addresses: [{ email_address: 'free@example.com' }],
                    }),
                };
            }
            if (String(url).includes('/v1/checkout/sessions')) {
                stripeCalls.push({ type: 'checkout' });
                return {
                    ok: true,
                    json: async () => ({ url: 'https://checkout.stripe.test/new-sub' }),
                };
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });

        await handler(req, res);
        expect(res._status).toBe(200);
        expect(res._body.flow).toBe('checkout');
        expect(stripeCalls.some((c) => c.type === 'checkout')).toBe(true);
        expect(stripeCalls.some((c) => c.type === 'portal')).toBe(false);

        restore();
    });

    test('starter → pro lifetime still uses Checkout payment mode', async () => {
        const { req, res, restore } = makeReqRes({
            body: { plan: 'pro', period: 'lifetime' },
            env: BASE_ENV,
        });
        mockFetchStarterWithActiveSub();

        await handler(req, res);
        expect(res._status).toBe(200);
        expect(res._body.flow).toBe('checkout');
        expect(stripeCalls.some((c) => c.type === 'checkout')).toBe(true);
        expect(stripeCalls.some((c) => c.type === 'portal')).toBe(false);

        restore();
    });
});
