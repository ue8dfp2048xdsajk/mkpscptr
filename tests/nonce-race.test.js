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

const { FAKE_REDIS_URL, FAKE_REDIS_TOKEN, makeRedisFetchMock } = require('./_helpers/upstash-mock');

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

    test('when DB is unavailable, recordNonce fails closed — both requests return 5xx (no replay slip-through)', async () => {
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

        // Policy: recordNonce fails closed when PG is configured but unavailable.
        // Neither request is processed — no nonce is ever committed so no
        // double-billing and no replay attack can succeed.
        const { req: req1, res: res1 } = makeReqRes();
        await handler(req1, res1);
        expect(res1.statusCode).toBeGreaterThanOrEqual(500);
        expect(res1.body.ok).toBe(false);

        const { req: req2, res: res2 } = makeReqRes();
        await handler(req2, res2);
        expect(res2.statusCode).toBeGreaterThanOrEqual(500);
        expect(res2.body.ok).toBe(false);
    });

    test('all sequential requests return 5xx while DB is unavailable (fail-closed on every attempt)', async () => {
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
        expect(res1.statusCode).toBeGreaterThanOrEqual(500);
        expect(res1.body.ok).toBe(false);

        const { req: req2, res: res2 } = makeReqRes();
        await handler(req2, res2);
        expect(res2.statusCode).toBeGreaterThanOrEqual(500);
        expect(res2.body.ok).toBe(false);

        const { req: req3, res: res3 } = makeReqRes();
        await handler(req3, res3);
        expect(res3.statusCode).toBeGreaterThanOrEqual(500);
        expect(res3.body.ok).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Multi-instance serverless: Redis down then recovers
//
// Background (documented in api/_nonce-store.js, recordNonce):
//   In a Vercel (or similar) deployment each function invocation is an isolated
//   process with its own in-memory nonce Map.  When Redis goes down:
//     • isNonceSeen falls back to in-memory → returns false on every instance
//     • recordNonce FAILS CLOSED (throws, no in-memory fallback) → 500
//   So while Redis is down no request succeeds and no nonce is committed.
//
//   When Redis recovers the SET NX command is atomic on the Redis server.
//   Even if two instances both saw isNonceSeen return false (in-memory
//   fallback), only one SET NX can win — the other receives null (duplicate)
//   and throws.  Replay protection therefore holds in every phase:
//     - Redis fully down  → both instances return 500   (fail-closed)
//     - Redis recovers    → exactly one instance wins   (SET NX atomicity)
//
// We simulate two separate serverless instances by loading _nonce-store twice
// with jest.resetModules() between loads.  Each load gets its own empty
// in-memory Map.  Both share global.fetch as the Redis proxy so we can
// control Redis availability centrally.
// ---------------------------------------------------------------------------

describe('Multi-instance: Redis fully down — both instances fail closed', () => {
    afterEach(() => {
        delete process.env.UPSTASH_REDIS_REST_URL;
        delete process.env.UPSTASH_REDIS_REST_TOKEN;
        delete process.env.DATABASE_URL;
        jest.clearAllMocks();
    });

    function loadFreshStore() {
        jest.resetModules();
        process.env.UPSTASH_REDIS_REST_URL = FAKE_REDIS_URL;
        process.env.UPSTASH_REDIS_REST_TOKEN = FAKE_REDIS_TOKEN;
        delete process.env.DATABASE_URL;
        return require('../api/_nonce-store');
    }

    test('isNonceSeen falls back to in-memory (false) on both instances while Redis is down', async () => {
        global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

        const storeA = loadFreshStore();
        const storeB = loadFreshStore();

        const nonce = 'multi-instance-down-nonce-1';

        // Both instances: Redis EXISTS fails → in-memory fallback → false
        const [seenA, seenB] = await Promise.all([
            storeA.isNonceSeen(nonce),
            storeB.isNonceSeen(nonce),
        ]);

        expect(seenA).toBe(false);
        expect(seenB).toBe(false);
    });

    test('recordNonce on both instances throws (fail-closed) while Redis is down', async () => {
        global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

        const storeA = loadFreshStore();
        const storeB = loadFreshStore();

        const nonce = 'multi-instance-down-nonce-2';

        const [resultA, resultB] = await Promise.allSettled([
            storeA.recordNonce(nonce),
            storeB.recordNonce(nonce),
        ]);

        // Both must reject — no nonce is committed anywhere.
        expect(resultA.status).toBe('rejected');
        expect(resultB.status).toBe('rejected');
        expect(resultA.reason.message).toMatch(/Redis recordNonce failed/i);
        expect(resultB.reason.message).toMatch(/Redis recordNonce failed/i);
    });

    test('nonce is not committed to any store after both recordNonce calls fail', async () => {
        global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

        const storeA = loadFreshStore();
        const storeB = loadFreshStore();

        const nonce = 'multi-instance-down-nonce-3';

        // Both fail to record.
        await Promise.allSettled([storeA.recordNonce(nonce), storeB.recordNonce(nonce)]);

        // isNonceSeen still falls back to in-memory on both instances — nonce
        // was never written anywhere, so both should return false.
        const [seenA, seenB] = await Promise.all([
            storeA.isNonceSeen(nonce),
            storeB.isNonceSeen(nonce),
        ]);

        expect(seenA).toBe(false);
        expect(seenB).toBe(false);
    });
});

describe('Multi-instance: Redis recovers between isNonceSeen and recordNonce — SET NX atomicity blocks replay', () => {
    afterEach(() => {
        delete process.env.UPSTASH_REDIS_REST_URL;
        delete process.env.UPSTASH_REDIS_REST_TOKEN;
        delete process.env.DATABASE_URL;
        jest.clearAllMocks();
    });

    function loadFreshStore() {
        jest.resetModules();
        process.env.UPSTASH_REDIS_REST_URL = FAKE_REDIS_URL;
        process.env.UPSTASH_REDIS_REST_TOKEN = FAKE_REDIS_TOKEN;
        delete process.env.DATABASE_URL;
        return require('../api/_nonce-store');
    }

    test('exactly one of two racing recordNonce calls wins when Redis recovers mid-flight', async () => {
        // Shared Redis state — survives the Redis-down phase (empty while down,
        // populated atomically once up).
        const redisSeen = new Set();
        let redisUp = false;

        // Phase 1 (Redis down): EXISTS throws → isNonceSeen falls back to in-memory.
        // Phase 2 (Redis up):   SET NX is atomic → exactly one wins.
        global.fetch = jest.fn(async (url) => {
            const segments = url.split('/');
            const op = segments[3];
            const key = decodeURIComponent((segments[4] || '').split('?')[0]);

            if (op === 'exists') {
                if (!redisUp) throw new Error('ECONNREFUSED');
                return { ok: true, json: async () => ({ result: redisSeen.has(key) ? 1 : 0 }) };
            }

            if (op === 'set') {
                if (!redisUp) throw new Error('ECONNREFUSED');
                if (redisSeen.has(key)) {
                    return { ok: true, json: async () => ({ result: null }) };
                }
                redisSeen.add(key);
                return { ok: true, json: async () => ({ result: 'OK' }) };
            }

            if (op === 'del') {
                redisSeen.delete(key);
                return { ok: true, json: async () => ({ result: 1 }) };
            }

            return { ok: true, json: async () => ({ result: null }) };
        });

        const storeA = loadFreshStore();
        const storeB = loadFreshStore();

        const nonce = 'multi-instance-recover-nonce-1';

        // isNonceSeen while Redis is down → both fall back to in-memory → false.
        const [seenA, seenB] = await Promise.all([
            storeA.isNonceSeen(nonce),
            storeB.isNonceSeen(nonce),
        ]);
        expect(seenA).toBe(false);
        expect(seenB).toBe(false);

        // Redis recovers.
        redisUp = true;

        // Both instances race to commit the nonce — SET NX is atomic, so exactly
        // one must succeed and one must throw "Duplicate nonce".
        const [resultA, resultB] = await Promise.allSettled([
            storeA.recordNonce(nonce),
            storeB.recordNonce(nonce),
        ]);

        const successes  = [resultA, resultB].filter(r => r.status === 'fulfilled');
        const duplicates = [resultA, resultB].filter(
            r => r.status === 'rejected' && /Duplicate nonce/i.test(r.reason.message)
        );

        expect(successes).toHaveLength(1);
        expect(duplicates).toHaveLength(1);
    });

    test('after the race the nonce is visible in Redis and blocks a subsequent replay attempt', async () => {
        const redisSeen = new Set();

        global.fetch = jest.fn(async (url) => {
            const segments = url.split('/');
            const op = segments[3];
            const key = decodeURIComponent((segments[4] || '').split('?')[0]);

            if (op === 'exists')
                return { ok: true, json: async () => ({ result: redisSeen.has(key) ? 1 : 0 }) };

            if (op === 'set') {
                if (redisSeen.has(key))
                    return { ok: true, json: async () => ({ result: null }) };
                redisSeen.add(key);
                return { ok: true, json: async () => ({ result: 'OK' }) };
            }

            if (op === 'del') {
                redisSeen.delete(key);
                return { ok: true, json: async () => ({ result: 1 }) };
            }

            return { ok: true, json: async () => ({ result: null }) };
        });

        // Instance A records the nonce (simulates the instance that won the race).
        const storeA = loadFreshStore();
        const nonce = 'multi-instance-recover-nonce-2';
        await storeA.recordNonce(nonce);

        // Instance C represents a fresh cold start (a third serverless instance,
        // or an attacker replaying the nonce).  It must see the nonce as already
        // seen via Redis.
        const storeC = loadFreshStore();
        const seen = await storeC.isNonceSeen(nonce);
        expect(seen).toBe(true);

        // And if it tries to record, it gets "Duplicate nonce".
        await expect(storeC.recordNonce(nonce)).rejects.toThrow(/Duplicate nonce/i);
    });

    test('two concurrent requests through the full set-plan handler — only one succeeds, no replay', async () => {
        const redisSeen = new Set();
        let redisUp = false;

        function buildFetch() {
            return jest.fn(async (url) => {
                if (!url.startsWith(FAKE_REDIS_URL)) {
                    // Clerk
                    return { ok: true, json: async () => ({}) };
                }

                const segments = url.split('/');
                const op  = segments[3];
                const key = decodeURIComponent((segments[4] || '').split('?')[0]);

                if (op === 'exists') {
                    if (!redisUp) throw new Error('ECONNREFUSED');
                    return { ok: true, json: async () => ({ result: redisSeen.has(key) ? 1 : 0 }) };
                }

                if (op === 'set') {
                    if (!redisUp) throw new Error('ECONNREFUSED');
                    if (redisSeen.has(key))
                        return { ok: true, json: async () => ({ result: null }) };
                    redisSeen.add(key);
                    return { ok: true, json: async () => ({ result: 'OK' }) };
                }

                if (op === 'del') {
                    redisSeen.delete(key);
                    return { ok: true, json: async () => ({ result: 1 }) };
                }

                return { ok: true, json: async () => ({ result: null }) };
            });
        }

        function loadFreshHandler() {
            jest.resetModules();
            process.env.UPSTASH_REDIS_REST_URL   = FAKE_REDIS_URL;
            process.env.UPSTASH_REDIS_REST_TOKEN  = FAKE_REDIS_TOKEN;
            delete process.env.DATABASE_URL;
            process.env.CLERK_SECRET_KEY = 'clerk-test-key';
            process.env.SET_PLAN_SECRET  = SECRET;
            jest.doMock('../api/_cors', () => ({
                setCorsHeaders: () => {},
                handleOptions:  () => false,
            }));
            return require('../api/set-plan');
        }

        // --- Phase 1: Redis down — both instances isNonceSeen falls back to in-memory ---
        // We simulate this by having the handler handle requests while Redis is down.
        // Because recordNonce is fail-closed both should return 500.
        global.fetch = buildFetch();

        const handlerA = loadFreshHandler();
        const handlerB = loadFreshHandler();

        const nonce = 'multi-instance-e2e-nonce-1';

        const { req: reqA1, res: resA1 } = makeReqRes({ nonce });
        const { req: reqB1, res: resB1 } = makeReqRes({ nonce });

        await Promise.all([handlerA(reqA1, resA1), handlerB(reqB1, resB1)]);

        // Both fail closed — Redis down.
        expect(resA1.statusCode).toBe(500);
        expect(resB1.statusCode).toBe(500);

        // --- Phase 2: Redis recovers — exactly one request succeeds ---
        redisUp = true;

        const { req: reqA2, res: resA2 } = makeReqRes({ nonce });
        const { req: reqB2, res: resB2 } = makeReqRes({ nonce });

        await Promise.all([handlerA(reqA2, resA2), handlerB(reqB2, resB2)]);

        const codes = [resA2.statusCode, resB2.statusCode];
        const successes  = codes.filter(c => c === 200);
        const rejections = codes.filter(c => c >= 400);

        expect(successes).toHaveLength(1);
        expect(rejections).toHaveLength(1);

        // --- Phase 3: Replay attempt — must be blocked ---
        const { req: reqA3, res: resA3 } = makeReqRes({ nonce });
        await handlerA(reqA3, resA3);
        expect(resA3.statusCode).toBeGreaterThanOrEqual(400);
        expect(resA3.body.ok).toBe(false);

        delete process.env.CLERK_SECRET_KEY;
        delete process.env.SET_PLAN_SECRET;
    });
});
