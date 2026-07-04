/**
 * @jest-environment node
 *
 * Billing invoices merges paid Stripe Invoices with one-time charge receipts.
 */

'use strict';

function makeReqRes({ method = 'GET', authorization = 'Bearer test-token' } = {}) {
    const req = {
        method,
        headers: authorization ? { authorization } : {},
        query: { action: 'invoices' },
    };

    let statusCode = 200;
    const res = {
        statusCode: null,
        body: null,
        status(code) { statusCode = code; return res; },
        json(b) { res.statusCode = statusCode; res.body = b; return res; },
    };

    return { req, res };
}

describe('GET /api/billing/invoices', () => {
    let handler;
    const originalFetch = global.fetch;

    beforeEach(() => {
        jest.resetModules();

        jest.doMock('../api/_cors', () => ({
            setCorsHeaders: () => {},
            handleOptions: () => false,
        }));

        jest.doMock('../api/_sliding-window', () => ({
            isRateLimited: jest.fn().mockResolvedValue(false),
        }));

        jest.doMock('../api/_verify-clerk-token', () => ({
            verifyClerkToken: jest.fn().mockResolvedValue('user_billing_1'),
        }));

        jest.doMock('../api/_db', () => ({
            getDb: async () => ({
                collection: () => ({
                    findOne: async () => null,
                }),
            }),
        }));

        process.env.STRIPE_SECRET_KEY = 'sk_test_billing';
        process.env.CLERK_SECRET_KEY = 'sk_test_clerk_billing';

        handler = require('../api/billing/[action]');
    });

    afterEach(() => {
        global.fetch = originalFetch;
        delete process.env.STRIPE_SECRET_KEY;
        delete process.env.CLERK_SECRET_KEY;
        jest.clearAllMocks();
    });

    test('returns paid invoices and charge receipts without duplicates', async () => {
        global.fetch = jest.fn(async (url) => {
            const urlStr = String(url);
            if (urlStr.includes('api.clerk.com')) {
                return {
                    ok: true,
                    json: async () => ({
                        public_metadata: { stripeCustomerId: 'cus_billing_1' },
                    }),
                };
            }
            if (urlStr.includes('/v1/invoices?')) {
                return {
                    ok: true,
                    json: async () => ({
                        data: [{
                            id: 'in_sub_001',
                            created: 1700000100,
                            amount_paid: 900,
                            currency: 'gbp',
                            invoice_pdf: 'https://stripe.test/in_sub_001.pdf',
                            hosted_invoice_url: 'https://stripe.test/in_sub_001',
                            charge: 'ch_sub_001',
                        }],
                    }),
                };
            }
            if (urlStr.includes('/v1/charges?')) {
                return {
                    ok: true,
                    json: async () => ({
                        data: [
                            {
                                id: 'ch_sub_001',
                                created: 1700000100,
                                amount: 900,
                                currency: 'gbp',
                                paid: true,
                                receipt_url: 'https://stripe.test/receipt/ch_sub_001',
                            },
                            {
                                id: 'ch_lifetime_001',
                                created: 1700000200,
                                amount: 50,
                                currency: 'usd',
                                paid: true,
                                receipt_url: 'https://stripe.test/receipt/ch_lifetime_001',
                            },
                        ],
                    }),
                };
            }
            throw new Error(`Unexpected fetch: ${urlStr}`);
        });

        const { req, res } = makeReqRes();
        await handler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.invoices).toHaveLength(2);
        expect(res.body.invoices[0].id).toBe('ch_lifetime_001');
        expect(res.body.invoices[0].hostedUrl).toBe('https://stripe.test/receipt/ch_lifetime_001');
        expect(res.body.invoices[0].pdfUrl).toBeNull();
        expect(res.body.invoices[1].id).toBe('in_sub_001');
        expect(res.body.invoices[1].pdfUrl).toBe('https://stripe.test/in_sub_001.pdf');
    });

    test('returns empty list when no Stripe customer is linked', async () => {
        global.fetch = jest.fn(async (url) => {
            if (String(url).includes('api.clerk.com')) {
                return {
                    ok: true,
                    json: async () => ({ public_metadata: { plan: 'starter' } }),
                };
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });

        const { req, res } = makeReqRes();
        await handler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ ok: true, invoices: [] });
    });
});
