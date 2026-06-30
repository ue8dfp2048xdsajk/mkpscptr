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
 *
 * A second suite ("Redis-backed") mocks the Upstash REST API (fetch) to
 * exercise the redisSetNx / redisExists code paths without real infrastructure.
 * It verifies that the atomic SET NX semantics correctly reject a duplicate
 * nonce even when both requests race past the initial isNonceSeen check.
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

// ---------------------------------------------------------------------------
// Redis-backed nonce store — Upstash REST API mocked via fetch
// ---------------------------------------------------------------------------

const FAKE_REDIS_URL = 'https://fake-upstash.upstash.io';
const FAKE_REDIS_TOKEN = 'fake-token-redis';

/**
 * Build a fetch mock that simulates the Upstash REST API.
 *
 * State is kept in a plain JS Set so that SET NX is "atomic" within a single
 * Node event-loop tick (Map/Set operations are synchronous).  The mock
 * returns resolved Promises so that both racing handlers can interleave at
 * each `await` point — reproducing the TOCTOU window that SET NX must close.
 *
 * URL patterns handled:
 *   POST  <REDIS_URL>/set/<key>/1?ex=...&nx=true  → SET NX
 *   GET   <REDIS_URL>/exists/<key>                → EXISTS
 *   POST  <REDIS_URL>/del/<key>                   → DEL
 *   PATCH https://api.clerk.com/...               → Clerk (always ok)
 */
function makeRedisFetchMock() {
    const store = new Set(); // tracks keys that have been SET NX'd

    return jest.fn((url, opts = {}) => {
        // ---- Upstash SET NX ----
        if (url.startsWith(FAKE_REDIS_URL) && url.includes('/set/') && url.includes('nx=true')) {
            const keyEncoded = url.split('/set/')[1].split('/')[0];
            const key = decodeURIComponent(keyEncoded);
            if (store.has(key)) {
                // Key already exists — simulate atomic NX rejection
                return Promise.resolve({
                    ok: true,
                    json: async () => ({ result: null }),
                });
            }
            store.add(key);
            return Promise.resolve({
                ok: true,
                json: async () => ({ result: 'OK' }),
            });
        }

        // ---- Upstash EXISTS ----
        if (url.startsWith(FAKE_REDIS_URL) && url.includes('/exists/')) {
            const keyEncoded = url.split('/exists/')[1].split('?')[0];
            const key = decodeURIComponent(keyEncoded);
            return Promise.resolve({
                ok: true,
                json: async () => ({ result: store.has(key) ? 1 : 0 }),
            });
        }

        // ---- Upstash DEL ----
        if (url.startsWith(FAKE_REDIS_URL) && url.includes('/del/')) {
            const keyEncoded = url.split('/del/')[1].split('?')[0];
            const key = decodeURIComponent(keyEncoded);
            store.delete(key);
            return Promise.resolve({
                ok: true,
                json: async () => ({ result: 1 }),
            });
        }

        // ---- Clerk API (always succeeds) ----
        return Promise.resolve({
            ok: true,
            json: async () => ({}),
        });
    });
}

function loadRedisHandler() {
    jest.resetModules();

    // Provide fake Upstash credentials so USE_REDIS becomes true
    process.env.UPSTASH_REDIS_REST_URL = FAKE_REDIS_URL;
    process.env.UPSTASH_REDIS_REST_TOKEN = FAKE_REDIS_TOKEN;
    delete process.env.DATABASE_URL;
    process.env.CLERK_SECRET_KEY = 'clerk-test-key';
    process.env.SET_PLAN_SECRET = SECRET;

    jest.doMock('../api/_cors', () => ({
        setCorsHeaders: () => {},
        handleOptions: () => false,
    }));

    global.fetch = makeRedisFetchMock();

    return require('../api/set-plan');
}

describe('Nonce deduplication — Redis-backed (Upstash SET NX)', () => {
    let handler;

    beforeEach(() => {
        handler = loadRedisHandler();
    });

    afterEach(() => {
        delete process.env.UPSTASH_REDIS_REST_URL;
        delete process.env.UPSTASH_REDIS_REST_TOKEN;
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
        expect(codes.filter(c => c === 200)).toHaveLength(1);
        expect(codes.filter(c => c >= 400)).toHaveLength(1);
    });

    test('the rejected request carries ok:false in the body', async () => {
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

    test('a subsequent request with the same nonce is also rejected', async () => {
        const { req: req1, res: res1 } = makeReqRes();
        const { req: req2, res: res2 } = makeReqRes();
        const { req: req3, res: res3 } = makeReqRes();

        await Promise.all([handler(req1, res1), handler(req2, res2)]);
        await handler(req3, res3);

        expect(res3.statusCode).toBeGreaterThanOrEqual(400);
        expect(res3.body.ok).toBe(false);
    });

    test('a request with a different nonce still succeeds', async () => {
        const { req: req1, res: res1 } = makeReqRes({ nonce: SHARED_NONCE });
        const { req: req2, res: res2 } = makeReqRes({ nonce: 'redis-different-nonce-xyz' });

        await Promise.all([handler(req1, res1), handler(req2, res2)]);

        expect(res1.statusCode).toBe(200);
        expect(res2.statusCode).toBe(200);
    });

    test('SET NX null result causes recordNonce to throw and return 500', async () => {
        // Load a fresh nonce-store directly (not through set-plan) to unit-test
        // the redisSetNx → null → throw path in isolation.
        jest.resetModules();
        process.env.UPSTASH_REDIS_REST_URL = FAKE_REDIS_URL;
        process.env.UPSTASH_REDIS_REST_TOKEN = FAKE_REDIS_TOKEN;

        // First call returns OK, second returns null (duplicate)
        let callCount = 0;
        global.fetch = jest.fn(() => {
            callCount++;
            const result = callCount === 1 ? 'OK' : null;
            return Promise.resolve({ ok: true, json: async () => ({ result }) });
        });

        const store = require('../api/_nonce-store');
        await store.recordNonce('unit-test-nonce'); // first: OK
        await expect(store.recordNonce('unit-test-nonce')).rejects.toThrow('Duplicate nonce');
    });
});

// ---------------------------------------------------------------------------
// Redis SET NX fails mid-flight — fail-closed guarantees no replay
//
// Scenario: Redis is configured (USE_REDIS=true), the EXISTS check succeeds
// (returns "not seen"), but the subsequent SET NX call throws (Redis goes down
// mid-flight, after the check but before the write commits).
//
// The nonce-store must NOT fall back to in-memory when USE_REDIS=true — it
// fails closed and returns a 500 so that no nonce is silently committed to a
// different store.  This means every request carrying the contested nonce is
// rejected, which is the safe outcome: no replay can succeed.
// ---------------------------------------------------------------------------

describe('Nonce deduplication — Redis SET NX fails mid-flight (fail-closed, no replay bypass)', () => {
    afterEach(() => {
        delete process.env.UPSTASH_REDIS_REST_URL;
        delete process.env.UPSTASH_REDIS_REST_TOKEN;
        delete process.env.DATABASE_URL;
        delete process.env.CLERK_SECRET_KEY;
        delete process.env.SET_PLAN_SECRET;
        jest.clearAllMocks();
    });

    function loadHandlerWithFetch(fetchImpl) {
        jest.resetModules();
        process.env.UPSTASH_REDIS_REST_URL = FAKE_REDIS_URL;
        process.env.UPSTASH_REDIS_REST_TOKEN = FAKE_REDIS_TOKEN;
        delete process.env.DATABASE_URL;
        process.env.CLERK_SECRET_KEY = 'clerk-test-key';
        process.env.SET_PLAN_SECRET = SECRET;
        jest.doMock('../api/_cors', () => ({
            setCorsHeaders: () => {},
            handleOptions: () => false,
        }));
        global.fetch = fetchImpl;
        return require('../api/set-plan');
    }

    test('when EXISTS succeeds but SET NX throws, both requests are blocked (fail-closed)', async () => {
        // EXISTS always returns "not seen" so both requests pass the duplicate
        // check; SET NX then throws to simulate Redis failing mid-flight.
        const fetchMock = jest.fn((url) => {
            if (url.includes('/exists/')) {
                return Promise.resolve({ ok: true, json: async () => ({ result: 0 }) });
            }
            if (url.includes('/set/') && url.includes('nx=true')) {
                return Promise.resolve({ ok: false, status: 503 }); // triggers throw in redisSetNx
            }
            return Promise.resolve({ ok: true, json: async () => ({}) }); // Clerk (never reached)
        });

        const handler = loadHandlerWithFetch(fetchMock);
        const { req: req1, res: res1 } = makeReqRes();
        const { req: req2, res: res2 } = makeReqRes();

        await Promise.all([handler(req1, res1), handler(req2, res2)]);

        // Fail-closed: neither request succeeds, so the duplicate cannot slip through.
        expect(res1.statusCode).toBeGreaterThanOrEqual(400);
        expect(res2.statusCode).toBeGreaterThanOrEqual(400);
        expect(res1.body.ok).toBe(false);
        expect(res2.body.ok).toBe(false);
    });

    test('when both Redis and DB are unavailable (Redis SET NX throws), no request succeeds', async () => {
        // Both UPSTASH and DATABASE_URL are set, but both fail at runtime.
        // Since USE_REDIS=true takes precedence, the code fails closed on the
        // Redis SET NX error and never reaches the PG path.
        const fetchMock = jest.fn((url) => {
            if (url.includes('/exists/')) {
                return Promise.resolve({ ok: true, json: async () => ({ result: 0 }) });
            }
            if (url.includes('/set/') && url.includes('nx=true')) {
                return Promise.reject(new Error('Redis network timeout'));
            }
            return Promise.resolve({ ok: true, json: async () => ({}) });
        });

        jest.resetModules();
        process.env.UPSTASH_REDIS_REST_URL = FAKE_REDIS_URL;
        process.env.UPSTASH_REDIS_REST_TOKEN = FAKE_REDIS_TOKEN;
        // DB is also "configured" but Redis is tried first and fails closed.
        process.env.DATABASE_URL = 'postgres://fake-host/fakedb';
        process.env.CLERK_SECRET_KEY = 'clerk-test-key';
        process.env.SET_PLAN_SECRET = SECRET;
        jest.doMock('../api/_cors', () => ({
            setCorsHeaders: () => {},
            handleOptions: () => false,
        }));
        jest.doMock('pg', () => ({
            Pool: jest.fn().mockImplementation(() => ({
                query: jest.fn().mockRejectedValue(new Error('PG connection refused')),
            })),
        }));
        global.fetch = fetchMock;

        const handler = require('../api/set-plan');
        const { req: req1, res: res1 } = makeReqRes();
        const { req: req2, res: res2 } = makeReqRes();

        await Promise.all([handler(req1, res1), handler(req2, res2)]);

        expect(res1.statusCode).toBeGreaterThanOrEqual(400);
        expect(res2.statusCode).toBeGreaterThanOrEqual(400);
        expect(res1.body.ok).toBe(false);
        expect(res2.body.ok).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// DB unavailable — in-memory fallback blocks duplicate
//
// Scenario: no Redis is configured (USE_REDIS=false), PostgreSQL is configured
// (USE_PG=true) but is unavailable at runtime.  The nonce-store falls back to
// the in-memory Map for both isNonceSeen and recordNonce.  The first request
// succeeds and the duplicate is correctly rejected.
// ---------------------------------------------------------------------------

describe('Nonce deduplication — DB unavailable, in-memory fallback blocks duplicate', () => {
    afterEach(() => {
        delete process.env.DATABASE_URL;
        delete process.env.UPSTASH_REDIS_REST_URL;
        delete process.env.UPSTASH_REDIS_REST_TOKEN;
        delete process.env.CLERK_SECRET_KEY;
        delete process.env.SET_PLAN_SECRET;
        jest.clearAllMocks();
    });

    test('when DB is unavailable, in-memory fallback records the nonce and rejects the duplicate', async () => {
        jest.resetModules();
        delete process.env.UPSTASH_REDIS_REST_URL;
        delete process.env.UPSTASH_REDIS_REST_TOKEN;
        process.env.DATABASE_URL = 'postgres://fake-host/fakedb';
        process.env.CLERK_SECRET_KEY = 'clerk-test-key';
        process.env.SET_PLAN_SECRET = SECRET;

        jest.doMock('../api/_cors', () => ({
            setCorsHeaders: () => {},
            handleOptions: () => false,
        }));
        jest.doMock('pg', () => ({
            Pool: jest.fn().mockImplementation(() => ({
                query: jest.fn().mockRejectedValue(new Error('connection refused')),
            })),
        }));

        // Clerk always succeeds.
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => ({}),
        });

        const handler = require('../api/set-plan');

        // First request: PG fails → in-memory records nonce → Clerk succeeds → 200.
        const { req: req1, res: res1 } = makeReqRes();
        await handler(req1, res1);
        expect(res1.statusCode).toBe(200);

        // Second request: same nonce → in-memory fallback sees it → 400 (duplicate blocked).
        const { req: req2, res: res2 } = makeReqRes();
        await handler(req2, res2);
        expect(res2.statusCode).toBeGreaterThanOrEqual(400);
        expect(res2.body.ok).toBe(false);
    });

    test('a third sequential request with the same nonce is also rejected by in-memory store', async () => {
        jest.resetModules();
        delete process.env.UPSTASH_REDIS_REST_URL;
        delete process.env.UPSTASH_REDIS_REST_TOKEN;
        process.env.DATABASE_URL = 'postgres://fake-host/fakedb';
        process.env.CLERK_SECRET_KEY = 'clerk-test-key';
        process.env.SET_PLAN_SECRET = SECRET;

        jest.doMock('../api/_cors', () => ({
            setCorsHeaders: () => {},
            handleOptions: () => false,
        }));
        jest.doMock('pg', () => ({
            Pool: jest.fn().mockImplementation(() => ({
                query: jest.fn().mockRejectedValue(new Error('connection refused')),
            })),
        }));

        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => ({}),
        });

        const handler = require('../api/set-plan');

        const { req: req1, res: res1 } = makeReqRes();
        await handler(req1, res1);
        expect(res1.statusCode).toBe(200);

        const { req: req2, res: res2 } = makeReqRes();
        await handler(req2, res2);

        const { req: req3, res: res3 } = makeReqRes();
        await handler(req3, res3);
        expect(res3.statusCode).toBeGreaterThanOrEqual(400);
        expect(res3.body.ok).toBe(false);
    });
});
