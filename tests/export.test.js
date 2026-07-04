/**
 * @jest-environment node
 *
 * Export gate - end-to-end handler tests.
 *
 * Covers:
 *  - No Authorization header → 401
 *  - Invalid / expired token → 401
 *  - Valid token, plan = 'free' (missing) → 403 upgrade_required
 *  - Valid token, plan = 'starter' → 200
 *  - Valid token, plan = 'pro' → 200
 *  - Plan value is case-normalised (e.g. 'PRO' → accepted)
 *  - Non-POST method → 405
 *
 * No real Clerk or network connections are made - verifyClerkTokenFull is mocked.
 */

'use strict';

function makeReqRes({ method = 'POST', authorization } = {}) {
    const req = {
        method,
        headers: authorization ? { authorization } : {},
    };

    let statusCode = 200;
    const res = {
        statusCode: null,
        body: null,
        status(code) { statusCode = code; return res; },
        json(b)      { res.statusCode = statusCode; res.body = b; return res; },
    };

    return { req, res };
}

function makeTokenResult(plan) {
    return {
        userId: 'user_test123',
        payload: {
            sub: 'user_test123',
            public_metadata: plan !== undefined ? { plan } : {},
        },
    };
}

describe('export handler - authentication', () => {
    let handler;
    let mockVerifyFull;

    beforeEach(() => {
        jest.resetModules();

        mockVerifyFull = jest.fn();

        jest.doMock('../api/_cors', () => ({
            setCorsHeaders: () => {},
            handleOptions:  () => false,
        }));

        jest.doMock('../api/_verify-clerk-token', () => ({
            verifyClerkToken:     jest.fn(),
            verifyClerkTokenFull: mockVerifyFull,
        }));

        handler = require('../api/export');
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    test('no Authorization header → 401 Not authenticated', async () => {
        mockVerifyFull.mockResolvedValue(null);
        const { req, res } = makeReqRes();
        await handler(req, res);
        expect(res.statusCode).toBe(401);
        expect(res.body.ok).toBe(false);
        expect(res.body.error).toBe('Not authenticated');
    });

    test('invalid / expired token → 401 Not authenticated', async () => {
        mockVerifyFull.mockResolvedValue(null);
        const { req, res } = makeReqRes({ authorization: 'Bearer bad.token.value' });
        await handler(req, res);
        expect(res.statusCode).toBe(401);
        expect(res.body.ok).toBe(false);
    });

    test('verifyClerkTokenFull throws → 502', async () => {
        mockVerifyFull.mockRejectedValue(new Error('JWKS fetch failed'));
        const { req, res } = makeReqRes({ authorization: 'Bearer sometoken' });
        await handler(req, res);
        expect(res.statusCode).toBe(502);
        expect(res.body.ok).toBe(false);
        expect(res.body.error).toBe('Could not verify session');
    });
});

describe('export handler - plan gating', () => {
    let handler;
    let mockVerifyFull;

    beforeEach(() => {
        jest.resetModules();

        mockVerifyFull = jest.fn();

        jest.doMock('../api/_cors', () => ({
            setCorsHeaders: () => {},
            handleOptions:  () => false,
        }));

        jest.doMock('../api/_verify-clerk-token', () => ({
            verifyClerkToken:     jest.fn(),
            verifyClerkTokenFull: mockVerifyFull,
        }));

        handler = require('../api/export');
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    test('plan = "free" → 403 upgrade_required', async () => {
        mockVerifyFull.mockResolvedValue(makeTokenResult('free'));
        const { req, res } = makeReqRes({ authorization: 'Bearer valid.free.token' });
        await handler(req, res);
        expect(res.statusCode).toBe(403);
        expect(res.body.ok).toBe(false);
        expect(res.body.error).toBe('upgrade_required');
    });

    test('no plan in public_metadata defaults to free → 403 upgrade_required', async () => {
        mockVerifyFull.mockResolvedValue(makeTokenResult(undefined));
        const { req, res } = makeReqRes({ authorization: 'Bearer valid.noPlan.token' });
        await handler(req, res);
        expect(res.statusCode).toBe(403);
        expect(res.body.error).toBe('upgrade_required');
    });

    test('plan = "starter" → 200 ok', async () => {
        mockVerifyFull.mockResolvedValue(makeTokenResult('starter'));
        const { req, res } = makeReqRes({ authorization: 'Bearer valid.starter.token' });
        await handler(req, res);
        expect(res.statusCode).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.plan).toBe('starter');
    });

    test('plan = "pro" → 200 ok', async () => {
        mockVerifyFull.mockResolvedValue(makeTokenResult('pro'));
        const { req, res } = makeReqRes({ authorization: 'Bearer valid.pro.token' });
        await handler(req, res);
        expect(res.statusCode).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.plan).toBe('pro');
    });

    test('plan value is case-normalised - "PRO" is accepted → 200', async () => {
        mockVerifyFull.mockResolvedValue(makeTokenResult('PRO'));
        const { req, res } = makeReqRes({ authorization: 'Bearer valid.PRO.token' });
        await handler(req, res);
        expect(res.statusCode).toBe(200);
        expect(res.body.plan).toBe('pro');
    });
});

describe('export handler - method guard', () => {
    let handler;

    beforeEach(() => {
        jest.resetModules();

        jest.doMock('../api/_cors', () => ({
            setCorsHeaders: () => {},
            handleOptions:  () => false,
        }));

        jest.doMock('../api/_verify-clerk-token', () => ({
            verifyClerkToken:     jest.fn(),
            verifyClerkTokenFull: jest.fn(),
        }));

        handler = require('../api/export');
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    test('GET request → 405 Method not allowed', async () => {
        const { req, res } = makeReqRes({ method: 'GET' });
        await handler(req, res);
        expect(res.statusCode).toBe(405);
        expect(res.body.ok).toBe(false);
        expect(res.body.error).toBe('Method not allowed');
    });

    test('PUT request → 405 Method not allowed', async () => {
        const { req, res } = makeReqRes({ method: 'PUT' });
        await handler(req, res);
        expect(res.statusCode).toBe(405);
    });
});
