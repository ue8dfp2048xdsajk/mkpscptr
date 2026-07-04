/**
 * @jest-environment node
 *
 * Tests for the STRIPE_ERROR code path:
 *
 *  Server-side (api/checkout.js):
 *   - When the Stripe API returns a 4xx/5xx the handler must reply with
 *     HTTP 502, ok:false, and code:'STRIPE_ERROR'.
 *   - The Stripe error message is forwarded; a generic fallback is used when
 *     Stripe's body has no message field.
 *
 *  Client-side (_startCheckout in js/app.js):
 *   - When the /api/checkout response carries code:'STRIPE_ERROR', alert()
 *     must be called with the server-supplied error text (not the generic
 *     "Could not start checkout" fallback).
 *   - When the server supplies no error text, the Stripe-specific fallback
 *     ("Our payment provider returned an error…") is used instead of the
 *     generic one.
 */

'use strict';

const fs  = require('fs');
const vm  = require('vm');

// ---------------------------------------------------------------------------
// Helpers - server-side
// ---------------------------------------------------------------------------

function makeReqRes({ body = {}, env = {}, headers = {} } = {}) {
    const saved = {};
    for (const [k, v] of Object.entries(env)) {
        saved[k] = process.env[k];
        process.env[k] = v;
    }

    const res = {
        _status: null,
        _body:   null,
        status(code) { this._status = code; return this; },
        json(b)      { this._body   = b;    return this; },
        setHeader()  {},
    };

    const req = { method: 'POST', headers, body };

    const restore = () => {
        for (const [k] of Object.entries(env)) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
    };

    return { req, res, restore };
}

const GOOD_ENV = {
    STRIPE_SECRET_KEY:             'sk_test_dummy_for_checkout_tests',
    STRIPE_PRICE_STARTER_MONTHLY:  'price_test_starter_monthly',
    // checkout.js's "is auth configured" guard requires CLERK_SECRET_KEY to be
    // truthy (it reuses the same var for that guard AND for the optional
    // Clerk plan-upgrade lookup below), so it must stay set here. The Clerk
    // lookup itself is handled by mockFetchClerkThenStripe(), which returns a
    // benign "free plan" response for the Clerk call and only simulates the
    // Stripe error for the actual Stripe request - otherwise the Clerk call
    // would consume the mocked error response first and short-circuit with
    // CLERK_ERROR before the Stripe call under test is ever reached.
    CLERK_SECRET_KEY: 'sk_test_dummy_clerk_for_checkout_tests',
};

// checkout.js calls fetch() twice on the happy path: once to look up the
// Clerk user (to check their current plan / email), then once to create the
// Stripe checkout session. Route each call to the right canned response so
// the Clerk lookup always succeeds and only the Stripe call fails the way
// each test expects.
function mockFetchClerkThenStripe(stripeResponse) {
    return jest.fn().mockImplementation((url) => {
        if (typeof url === 'string' && url.includes('api.clerk.com')) {
            return Promise.resolve({
                ok:     true,
                status: 200,
                json:   async () => ({ public_metadata: {}, email_addresses: [] }),
            });
        }
        return Promise.resolve(stripeResponse);
    });
}

// ---------------------------------------------------------------------------
// Server-side tests
// ---------------------------------------------------------------------------

describe('POST /api/checkout - STRIPE_ERROR branch (server)', () => {
    let handler;

    beforeAll(() => {
        jest.resetModules();
        // checkout.js now requires a verified Clerk user ID. Use jest.doMock
        // (after resetModules) so the fresh require picks up the mock correctly.
        jest.doMock('../api/_verify-clerk-token', () => ({
            verifyClerkToken:     jest.fn().mockResolvedValue('user_test_checkout'),
            verifyClerkTokenFull: jest.fn().mockResolvedValue(null),
            // checkout.js gates on this flag before ever calling verifyClerkToken -
            // without it the handler always short-circuits to the 503
            // "auth not configured" branch and the Stripe-error path under test
            // (mocked via global.fetch below) is never reached.
            isConfigured:         true,
        }));
        handler = require('../api/checkout');
    });

    test('returns 502 + code STRIPE_ERROR when Stripe returns a 4xx with an error message', async () => {
        const { req, res, restore } = makeReqRes({
            body: { plan: 'starter', period: 'monthly' },
            env:  GOOD_ENV,
        });

        const realFetch = global.fetch;
        global.fetch = mockFetchClerkThenStripe({
            ok:     false,
            status: 402,
            json:   async () => ({ error: { message: 'Your card was declined.' } }),
        });

        try {
            await handler(req, res);
        } finally {
            global.fetch = realFetch;
            restore();
        }

        expect(res._status).toBe(502);
        expect(res._body.ok).toBe(false);
        expect(res._body.code).toBe('STRIPE_ERROR');
        expect(res._body.error).toBe('Your card was declined.');
    });

    test('returns 502 + code STRIPE_ERROR when Stripe returns a 5xx with an error message', async () => {
        const { req, res, restore } = makeReqRes({
            body: { plan: 'starter', period: 'monthly' },
            env:  GOOD_ENV,
        });

        const realFetch = global.fetch;
        global.fetch = mockFetchClerkThenStripe({
            ok:     false,
            status: 503,
            json:   async () => ({ error: { message: 'Service temporarily unavailable.' } }),
        });

        try {
            await handler(req, res);
        } finally {
            global.fetch = realFetch;
            restore();
        }

        expect(res._status).toBe(502);
        expect(res._body.ok).toBe(false);
        expect(res._body.code).toBe('STRIPE_ERROR');
        expect(res._body.error).toBe('Service temporarily unavailable.');
    });

    test('falls back to a generic message when Stripe body has no error.message', async () => {
        const { req, res, restore } = makeReqRes({
            body: { plan: 'starter', period: 'monthly' },
            env:  GOOD_ENV,
        });

        const realFetch = global.fetch;
        global.fetch = mockFetchClerkThenStripe({
            ok:     false,
            status: 500,
            json:   async () => ({}),
        });

        try {
            await handler(req, res);
        } finally {
            global.fetch = realFetch;
            restore();
        }

        expect(res._status).toBe(502);
        expect(res._body.ok).toBe(false);
        expect(res._body.code).toBe('STRIPE_ERROR');
        expect(res._body.error).toMatch(/stripe returned status 500/i);
    });
});

// ---------------------------------------------------------------------------
// Helpers - client-side
// ---------------------------------------------------------------------------
// _startCheckout is a plain top-level async function at the end of js/app.js.
// Extract its source once, then run it in a minimal vm sandbox per test so we
// can control fetch, alert, and window without loading the full browser script.

const _appSrc = fs.readFileSync('./js/app.js', 'utf8');
const _fnStart = _appSrc.indexOf('async function _startCheckout');
if (_fnStart === -1) throw new Error('Could not locate _startCheckout in js/app.js');
const _startCheckoutSrc = _appSrc.slice(_fnStart);

function buildSandbox({ fetchImpl, alertMock } = {}) {
    const sandbox = {
        window: {
            Clerk: {
                user:       { id: 'user_test_123' },
                openSignIn: () => {},
            },
            _userPlan: 'free',
            location:  {},
        },
        fetch:        fetchImpl || (() => Promise.reject(new Error('fetch not mocked'))),
        alert:        alertMock || (() => {}),
        console:      { error: () => {}, log: () => {} },
        sessionStorage: { setItem: () => {}, getItem: () => null },
        JSON,
        Promise,
    };
    vm.createContext(sandbox);
    return sandbox;
}

// ---------------------------------------------------------------------------
// Client-side tests
// ---------------------------------------------------------------------------

describe('_startCheckout - client-side STRIPE_ERROR alert', () => {
    test('alert fires with the Stripe-supplied error text when code is STRIPE_ERROR', async () => {
        const alerts = [];
        const sandbox = buildSandbox({
            fetchImpl: () => Promise.resolve({
                ok:     false,
                status: 502,
                json:   async () => ({
                    ok:    false,
                    code:  'STRIPE_ERROR',
                    error: 'Your card has insufficient funds.',
                }),
            }),
            alertMock: (msg) => alerts.push(msg),
        });

        vm.runInContext(_startCheckoutSrc, sandbox);
        await sandbox._startCheckout('starter', 'monthly');

        expect(alerts).toHaveLength(1);
        expect(alerts[0]).toBe('Your card has insufficient funds.');
    });

    test('alert fires with the Stripe-specific fallback when error field is absent', async () => {
        const alerts = [];
        const sandbox = buildSandbox({
            fetchImpl: () => Promise.resolve({
                ok:     false,
                status: 502,
                json:   async () => ({ ok: false, code: 'STRIPE_ERROR' }),
            }),
            alertMock: (msg) => alerts.push(msg),
        });

        vm.runInContext(_startCheckoutSrc, sandbox);
        await sandbox._startCheckout('starter', 'monthly');

        expect(alerts).toHaveLength(1);
        expect(alerts[0]).toMatch(/payment provider/i);
        expect(alerts[0]).not.toMatch(/Could not start checkout/i);
    });

    test('generic fallback alert fires for unrecognised error codes (not STRIPE_ERROR text)', async () => {
        const alerts = [];
        const sandbox = buildSandbox({
            fetchImpl: () => Promise.resolve({
                ok:     false,
                status: 500,
                json:   async () => ({ ok: false, error: 'Internal server error' }),
            }),
            alertMock: (msg) => alerts.push(msg),
        });

        vm.runInContext(_startCheckoutSrc, sandbox);
        await sandbox._startCheckout('starter', 'monthly');

        expect(alerts).toHaveLength(1);
        expect(alerts[0]).toMatch(/Could not start checkout/i);
        expect(alerts[0]).not.toMatch(/payment provider/i);
    });
});
