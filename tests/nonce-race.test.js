/**
 * @jest-environment node
 *
 * Regression test: two concurrent requests carrying the same nonce must not
 * both succeed.  Exactly one should get a 200 and the other a 4xx/5xx.
 *
 * The test uses the real in-memory nonce store (no Redis, no external deps)
 * so it runs in CI without any infrastructure.
 *
 * Why this matters: the check-then-record pattern in set-plan.js has a TOCTOU
 * window.  In a single-process Node server the JS event loop keeps Map
 * operations atomic, but this test acts as a regression guard — if the
 * store is ever changed (e.g. replaced with an async DB without SET NX) the
 * failure will be caught here before it ships.
 */

'use strict';

const SECRET = 'test-secret';
const SHARED_NONCE = 'race-test-nonce-abc123';

// ---------------------------------------------------------------------------
// Minimal mock req/res factory
// ---------------------------------------------------------------------------

function makeReqRes({ nonce = SHARED_NONCE } = {}) {
    const req = {
        method: 'POST',
        headers: {
            authorization: `Bearer ${SECRET}`,
            'x-timestamp': String(Math.floor(Date.now() / 1000)),
            'x-nonce': nonce,
            'x-forwarded-for': '127.0.0.1',
        },
        body: { userId: 'user_test_123', plan: 'pro' },
        socket: { remoteAddress: '127.0.0.1' },
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

// ---------------------------------------------------------------------------
// Load a fresh handler with:
//   - real _nonce-store (in-memory, no Redis)
//   - real _rate-limiter (in-memory, no Redis/PG)
//   - _cors stubbed out
//   - Clerk fetch mocked to succeed
// ---------------------------------------------------------------------------

function loadHandler() {
    jest.resetModules();

    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    delete process.env.DATABASE_URL;
    process.env.CLERK_SECRET_KEY = 'clerk-test-key';
    process.env.SET_PLAN_SECRET = SECRET;

    jest.doMock('../api/_cors', () => ({
        setCorsHeaders: () => {},
        handleOptions: () => false,
    }));

    global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({}),
    });

    return require('../api/set-plan');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Nonce deduplication — concurrent race', () => {
    let handler;

    beforeEach(() => {
        handler = loadHandler();
    });

    afterEach(() => {
        delete process.env.CLERK_SECRET_KEY;
        delete process.env.SET_PLAN_SECRET;
        jest.clearAllMocks();
    });

    test('exactly one of two simultaneous identical-nonce requests succeeds', async () => {
        const { req: req1, res: res1 } = makeReqRes();
        const { req: req2, res: res2 } = makeReqRes();

        await Promise.all([
            handler(req1, res1),
            handler(req2, res2),
        ]);

        const codes = [res1.statusCode, res2.statusCode].sort();

        const successes = codes.filter(c => c === 200);
        const rejections = codes.filter(c => c >= 400);

        expect(successes).toHaveLength(1);
        expect(rejections).toHaveLength(1);
    });

    test('the rejected request carries a nonce-related or server error status', async () => {
        const { req: req1, res: res1 } = makeReqRes();
        const { req: req2, res: res2 } = makeReqRes();

        await Promise.all([
            handler(req1, res1),
            handler(req2, res2),
        ]);

        const rejected = [res1, res2].find(r => r.statusCode !== 200);

        expect(rejected).toBeDefined();
        expect(rejected.statusCode).toBeGreaterThanOrEqual(400);
        expect(rejected.body.ok).toBe(false);
    });

    test('a third request with the same nonce is also rejected', async () => {
        const { req: req1, res: res1 } = makeReqRes();
        const { req: req2, res: res2 } = makeReqRes();
        const { req: req3, res: res3 } = makeReqRes();

        await Promise.all([
            handler(req1, res1),
            handler(req2, res2),
        ]);

        await handler(req3, res3);

        expect(res3.statusCode).toBeGreaterThanOrEqual(400);
        expect(res3.body.ok).toBe(false);
    });

    test('a request with a different nonce still succeeds', async () => {
        const { req: req1, res: res1 } = makeReqRes({ nonce: SHARED_NONCE });
        const { req: req2, res: res2 } = makeReqRes({ nonce: 'different-nonce-xyz' });

        await Promise.all([
            handler(req1, res1),
            handler(req2, res2),
        ]);

        expect(res1.statusCode).toBe(200);
        expect(res2.statusCode).toBe(200);
    });
});
