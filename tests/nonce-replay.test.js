/**
 * @jest-environment node
 *
 * Replay-attack protection — duplicate nonce rejection and recovery.
 *
 * Covers:
 *  - isNonceSeen / recordNonce / deleteNonce unit behaviour on the in-memory fallback path
 *  - isNonceSeen / recordNonce / deleteNonce unit behaviour on the Redis (Upstash) path (mocked fetch)
 *  - End-to-end set-plan handler returns 400 on a second request with the same nonce
 *    for both paths
 *  - End-to-end: nonce is released when Clerk fails so a retry with the same nonce succeeds
 *
 * No real Redis or Clerk connections are made — all external I/O is mocked.
 */

'use strict';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Build a minimal mock req/res pair for the set-plan handler. */
function makeReqRes({ nonce, plan = 'pro' } = {}) {
    const req = {
        method: 'POST',
        headers: {
            authorization: 'Bearer test-secret',
            'x-timestamp': String(Math.floor(Date.now() / 1000)),
            'x-nonce': nonce || `nonce-${Math.random()}-${Date.now()}`,
            'x-forwarded-for': '10.0.0.1',
        },
        body: { userId: 'user_abc', plan },
        socket: { remoteAddress: '10.0.0.1' },
    };

    let statusCode = 200;
    const res = {
        statusCode: null,
        body: null,
        status(code) { statusCode = code; return res; },
        json(b)     { res.statusCode = statusCode; res.body = b; return res; },
    };

    return { req, res };
}

/**
 * Build a stateful Upstash REST fetch mock.
 *
 * Upstash REST URL shapes we care about:
 *   SET NX  → POST  {base}/set/{encodedKey}/1?ex={ttl}&nx=true
 *   EXISTS  → GET   {base}/exists/{encodedKey}
 *
 * The key is always at path-segment index 4 (0-based after the empty string
 * produced by the leading slash):
 *   ['https:', '', 'host', 'set'|'exists', '{encodedKey}', ...]
 *
 * Any other URL (e.g. rate-limiter /get, /del, /incrby) returns {result:null}
 * so the rate-limiter falls back to in-memory without throwing.
 */
function makeUpstashFetch(seen = new Set()) {
    return jest.fn(async (url) => {
        const segments = url.split('/');
        const op  = segments[3];              // 'set', 'exists', 'del', 'get', …
        const raw = (segments[4] || '').split('?')[0];
        const key = decodeURIComponent(raw);

        if (op === 'set') {
            if (seen.has(key)) {
                return { ok: true, json: async () => ({ result: null }) };
            }
            seen.add(key);
            return { ok: true, json: async () => ({ result: 'OK' }) };
        }

        if (op === 'exists') {
            return { ok: true, json: async () => ({ result: seen.has(key) ? 1 : 0 }) };
        }

        if (op === 'del') {
            seen.delete(key);
            return { ok: true, json: async () => ({ result: 1 }) };
        }

        // Rate-limiter or any other Redis op — return neutral result so the
        // caller's error handling falls back to in-memory without crashing.
        return { ok: true, json: async () => ({ result: null }) };
    });
}

// ---------------------------------------------------------------------------
// 1. IN-MEMORY FALLBACK — unit tests for _nonce-store
// ---------------------------------------------------------------------------

describe('_nonce-store (in-memory fallback) — unit', () => {
    let isNonceSeen, recordNonce, deleteNonce;

    beforeEach(() => {
        jest.resetModules();
        delete process.env.UPSTASH_REDIS_REST_URL;
        delete process.env.UPSTASH_REDIS_REST_TOKEN;
        ({ isNonceSeen, recordNonce, deleteNonce } = require('../api/_nonce-store'));
    });

    test('isNonceSeen returns false for a fresh nonce', async () => {
        expect(await isNonceSeen('brand-new-nonce-1')).toBe(false);
    });

    test('isNonceSeen returns true after recordNonce is called', async () => {
        const nonce = 'fresh-nonce-2';
        expect(await isNonceSeen(nonce)).toBe(false);
        await recordNonce(nonce);
        expect(await isNonceSeen(nonce)).toBe(true);
    });

    test('recordNonce throws on the second call with the same nonce', async () => {
        const nonce = 'dup-nonce-3';
        await recordNonce(nonce);
        await expect(recordNonce(nonce)).rejects.toThrow(/Duplicate nonce/i);
    });

    test('different nonces can each be recorded independently', async () => {
        await recordNonce('alpha-nonce');
        await recordNonce('beta-nonce');
        expect(await isNonceSeen('alpha-nonce')).toBe(true);
        expect(await isNonceSeen('beta-nonce')).toBe(true);
        expect(await isNonceSeen('gamma-nonce')).toBe(false);
    });

    test('deleteNonce removes a recorded nonce so it can be re-recorded', async () => {
        const nonce = 'delete-nonce-mem-1';
        await recordNonce(nonce);
        expect(await isNonceSeen(nonce)).toBe(true);
        await deleteNonce(nonce);
        expect(await isNonceSeen(nonce)).toBe(false);
        await expect(recordNonce(nonce)).resolves.toBeUndefined();
        expect(await isNonceSeen(nonce)).toBe(true);
    });

    test('deleteNonce on an unknown nonce does not throw', async () => {
        await expect(deleteNonce('never-recorded-nonce')).resolves.toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// 2. REDIS PATH — unit tests for _nonce-store (mocked Upstash fetch)
// ---------------------------------------------------------------------------

describe('_nonce-store (Redis path) — unit', () => {
    let isNonceSeen, recordNonce, deleteNonce;

    beforeEach(() => {
        jest.resetModules();
        process.env.UPSTASH_REDIS_REST_URL   = 'https://fake-redis.upstash.io';
        process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';

        global.fetch = makeUpstashFetch();

        ({ isNonceSeen, recordNonce, deleteNonce } = require('../api/_nonce-store'));
    });

    afterEach(() => {
        delete process.env.UPSTASH_REDIS_REST_URL;
        delete process.env.UPSTASH_REDIS_REST_TOKEN;
    });

    test('isNonceSeen returns false for a nonce that was never recorded', async () => {
        expect(await isNonceSeen('redis-fresh-nonce')).toBe(false);
    });

    test('isNonceSeen returns true after recordNonce is called (Redis)', async () => {
        const nonce = 'redis-nonce-a';
        await recordNonce(nonce);
        expect(await isNonceSeen(nonce)).toBe(true);
    });

    test('recordNonce throws on duplicate via Redis SET NX returning null', async () => {
        const nonce = 'redis-dup-nonce';
        await recordNonce(nonce);
        await expect(recordNonce(nonce)).rejects.toThrow(/Duplicate nonce/i);
    });

    test('isNonceSeen reflects the Redis EXISTS result', async () => {
        expect(await isNonceSeen('unseen-redis-nonce')).toBe(false);
        await recordNonce('unseen-redis-nonce');
        expect(await isNonceSeen('unseen-redis-nonce')).toBe(true);
    });

    test('deleteNonce removes a recorded nonce via Redis DEL so it can be re-recorded', async () => {
        const nonce = 'delete-nonce-redis-1';
        await recordNonce(nonce);
        expect(await isNonceSeen(nonce)).toBe(true);
        await deleteNonce(nonce);
        expect(await isNonceSeen(nonce)).toBe(false);
        await expect(recordNonce(nonce)).resolves.toBeUndefined();
        expect(await isNonceSeen(nonce)).toBe(true);
    });

    test('deleteNonce on an unknown nonce does not throw (Redis)', async () => {
        await expect(deleteNonce('redis-never-recorded')).resolves.toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// 3. END-TO-END via set-plan handler — in-memory fallback
// ---------------------------------------------------------------------------

describe('set-plan handler — duplicate nonce rejected (in-memory fallback)', () => {
    const SECRET = 'test-secret';
    let handler;

    beforeEach(() => {
        jest.resetModules();
        delete process.env.UPSTASH_REDIS_REST_URL;
        delete process.env.UPSTASH_REDIS_REST_TOKEN;
        delete process.env.DATABASE_URL;
        process.env.CLERK_SECRET_KEY = 'clerk-test-key';
        process.env.SET_PLAN_SECRET  = SECRET;

        jest.doMock('../api/_cors', () => ({
            setCorsHeaders: () => {},
            handleOptions:  () => false,
        }));

        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => ({}),
        });

        handler = require('../api/set-plan');
    });

    afterEach(() => {
        delete process.env.CLERK_SECRET_KEY;
        delete process.env.SET_PLAN_SECRET;
        jest.clearAllMocks();
    });

    test('first request with a nonce succeeds (200)', async () => {
        const { req, res } = makeReqRes({ nonce: 'e2e-in-mem-nonce-1' });
        await handler(req, res);
        expect(res.statusCode).toBe(200);
        expect(res.body.ok).toBe(true);
    });

    test('second request with the same nonce is rejected (400)', async () => {
        const nonce = 'e2e-in-mem-nonce-2';
        const { req: req1, res: res1 } = makeReqRes({ nonce });
        const { req: req2, res: res2 } = makeReqRes({ nonce });

        await handler(req1, res1);
        await handler(req2, res2);

        expect(res1.statusCode).toBe(200);
        expect(res2.statusCode).toBe(400);
        expect(res2.body.ok).toBe(false);
        expect(res2.body.error).toMatch(/duplicate nonce/i);
    });

    test('third sequential request with the same nonce is also rejected (400)', async () => {
        const nonce = 'e2e-in-mem-nonce-3';
        const { req: req1, res: res1 } = makeReqRes({ nonce });
        const { req: req2, res: res2 } = makeReqRes({ nonce });
        const { req: req3, res: res3 } = makeReqRes({ nonce });

        await handler(req1, res1);
        await handler(req2, res2);
        await handler(req3, res3);

        expect(res1.statusCode).toBe(200);
        expect(res2.statusCode).toBe(400);
        expect(res3.statusCode).toBe(400);
    });
});

// ---------------------------------------------------------------------------
// 4. END-TO-END via set-plan handler — Redis path (mocked)
// ---------------------------------------------------------------------------

describe('set-plan handler — duplicate nonce rejected (Redis path)', () => {
    const SECRET = 'test-secret';
    let handler;

    beforeEach(() => {
        jest.resetModules();
        process.env.UPSTASH_REDIS_REST_URL   = 'https://fake-redis.upstash.io';
        process.env.UPSTASH_REDIS_REST_TOKEN  = 'fake-token';
        delete process.env.DATABASE_URL;
        process.env.CLERK_SECRET_KEY = 'clerk-test-key';
        process.env.SET_PLAN_SECRET  = SECRET;

        jest.doMock('../api/_cors', () => ({
            setCorsHeaders: () => {},
            handleOptions:  () => false,
        }));

        // Shared state for the stateful Upstash nonce mock.
        // Clerk PATCH (non-Redis URL) returns a generic success.
        const redisSeen = new Set();
        const upstashFetch = makeUpstashFetch(redisSeen);

        global.fetch = jest.fn(async (url, opts) => {
            if (!url.includes('fake-redis')) {
                return { ok: true, json: async () => ({}) };
            }
            return upstashFetch(url, opts);
        });

        handler = require('../api/set-plan');
    });

    afterEach(() => {
        delete process.env.UPSTASH_REDIS_REST_URL;
        delete process.env.UPSTASH_REDIS_REST_TOKEN;
        delete process.env.CLERK_SECRET_KEY;
        delete process.env.SET_PLAN_SECRET;
        jest.clearAllMocks();
    });

    test('first request with a nonce succeeds via Redis (200)', async () => {
        const { req, res } = makeReqRes({ nonce: 'redis-e2e-nonce-1' });
        await handler(req, res);
        expect(res.statusCode).toBe(200);
        expect(res.body.ok).toBe(true);
    });

    test('second request with the same nonce is rejected via Redis (400)', async () => {
        const nonce = 'redis-e2e-nonce-2';
        const { req: req1, res: res1 } = makeReqRes({ nonce });
        const { req: req2, res: res2 } = makeReqRes({ nonce });

        await handler(req1, res1);
        await handler(req2, res2);

        expect(res1.statusCode).toBe(200);
        expect(res2.statusCode).toBe(400);
        expect(res2.body.ok).toBe(false);
        expect(res2.body.error).toMatch(/duplicate nonce/i);
    });

    test('third sequential request with the same nonce is also rejected via Redis (400)', async () => {
        const nonce = 'redis-e2e-nonce-3';
        const { req: req1, res: res1 } = makeReqRes({ nonce });
        const { req: req2, res: res2 } = makeReqRes({ nonce });
        const { req: req3, res: res3 } = makeReqRes({ nonce });

        await handler(req1, res1);
        await handler(req2, res2);
        await handler(req3, res3);

        expect(res1.statusCode).toBe(200);
        expect(res2.statusCode).toBe(400);
        expect(res3.statusCode).toBe(400);
    });

    test('unique nonces each succeed independently (Redis)', async () => {
        const { req: req1, res: res1 } = makeReqRes({ nonce: 'redis-unique-a' });
        const { req: req2, res: res2 } = makeReqRes({ nonce: 'redis-unique-b' });

        await handler(req1, res1);
        await handler(req2, res2);

        expect(res1.statusCode).toBe(200);
        expect(res2.statusCode).toBe(200);
    });
});

// ---------------------------------------------------------------------------
// 5. RECOVERY — nonce released after Clerk failure (in-memory fallback)
// ---------------------------------------------------------------------------

describe('set-plan handler — nonce released after Clerk failure (in-memory fallback)', () => {
    const SECRET = 'test-secret';
    let handler;
    let fetchMock;

    beforeEach(() => {
        jest.resetModules();
        delete process.env.UPSTASH_REDIS_REST_URL;
        delete process.env.UPSTASH_REDIS_REST_TOKEN;
        delete process.env.DATABASE_URL;
        process.env.CLERK_SECRET_KEY = 'clerk-test-key';
        process.env.SET_PLAN_SECRET  = SECRET;

        jest.doMock('../api/_cors', () => ({
            setCorsHeaders: () => {},
            handleOptions:  () => false,
        }));

        fetchMock = jest.fn();
        global.fetch = fetchMock;

        handler = require('../api/set-plan');
    });

    afterEach(() => {
        delete process.env.CLERK_SECRET_KEY;
        delete process.env.SET_PLAN_SECRET;
        jest.clearAllMocks();
    });

    test('nonce reusable after Clerk fetch throws (network error)', async () => {
        const nonce = 'recovery-mem-network-nonce';

        // First call: Clerk fetch throws (network blip)
        fetchMock.mockRejectedValueOnce(new Error('network error'));
        const { req: req1, res: res1 } = makeReqRes({ nonce });
        await handler(req1, res1);
        expect(res1.statusCode).toBe(502);

        // Retry with same nonce: Clerk succeeds
        fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
        const { req: req2, res: res2 } = makeReqRes({ nonce });
        await handler(req2, res2);
        expect(res2.statusCode).toBe(200);
        expect(res2.body.ok).toBe(true);
    });

    test('nonce reusable after Clerk returns non-ok status', async () => {
        const nonce = 'recovery-mem-clerk-error-nonce';

        // First call: Clerk returns 500
        fetchMock.mockResolvedValueOnce({
            ok: false,
            status: 500,
            json: async () => ({ errors: [{ message: 'Clerk internal error' }] }),
        });
        const { req: req1, res: res1 } = makeReqRes({ nonce });
        await handler(req1, res1);
        expect(res1.statusCode).toBe(502);

        // Retry with same nonce: Clerk succeeds
        fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
        const { req: req2, res: res2 } = makeReqRes({ nonce });
        await handler(req2, res2);
        expect(res2.statusCode).toBe(200);
        expect(res2.body.ok).toBe(true);
    });

    test('nonce still blocked after a successful Clerk call', async () => {
        const nonce = 'recovery-mem-success-then-dup-nonce';

        fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });

        const { req: req1, res: res1 } = makeReqRes({ nonce });
        await handler(req1, res1);
        expect(res1.statusCode).toBe(200);

        const { req: req2, res: res2 } = makeReqRes({ nonce });
        await handler(req2, res2);
        expect(res2.statusCode).toBe(400);
        expect(res2.body.error).toMatch(/duplicate nonce/i);
    });
});

// ---------------------------------------------------------------------------
// 6. REDIS COMPLETELY UNREACHABLE — recordNonce fails closed (no silent fallback)
//
// Scenario: Redis credentials ARE configured (USE_REDIS=true) but every Redis
// HTTP call throws a network-level error.
//
// isNonceSeen still falls back to in-memory (reading is safe: a false-negative
// only means a duplicate check is missed, not that a duplicate is accepted).
//
// recordNonce does NOT fall back to in-memory.  If it did, isNonceSeen (which
// read from Redis) and recordNonce (which wrote to in-memory) would use
// different stores.  Once Redis recovers, isNonceSeen would return false for
// the nonce that was only stored in-memory, letting a replay slip through.
// Failing closed (500) is the safe choice: the caller can retry the full
// request knowing the nonce was never committed anywhere.
// ---------------------------------------------------------------------------

describe('_nonce-store — Redis completely unreachable (unit)', () => {
    let isNonceSeen, recordNonce, deleteNonce;

    beforeEach(() => {
        jest.resetModules();

        process.env.UPSTASH_REDIS_REST_URL   = 'https://unreachable-redis.example.com';
        process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';

        global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

        ({ isNonceSeen, recordNonce, deleteNonce } = require('../api/_nonce-store'));
    });

    afterEach(() => {
        delete process.env.UPSTASH_REDIS_REST_URL;
        delete process.env.UPSTASH_REDIS_REST_TOKEN;
        jest.clearAllMocks();
    });

    test('isNonceSeen falls back to in-memory and returns false for an unseen nonce', async () => {
        expect(await isNonceSeen('unreachable-fresh-1')).toBe(false);
    });

    test('recordNonce throws a network error when Redis SET NX is unreachable (fails closed)', async () => {
        await expect(recordNonce('unreachable-record-1')).rejects.toThrow(/Redis recordNonce failed/i);
    });

    test('recordNonce does not silently record in in-memory: isNonceSeen stays false after a failed recordNonce', async () => {
        const nonce = 'unreachable-no-mem-fallback';
        await expect(recordNonce(nonce)).rejects.toThrow();
        // isNonceSeen falls back to in-memory and should return false because
        // recordNonce never committed the nonce anywhere.
        expect(await isNonceSeen(nonce)).toBe(false);
    });

    test('deleteNonce does not throw when Redis is unreachable (falls back to in-memory no-op)', async () => {
        await expect(deleteNonce('unreachable-del-1')).resolves.toBeUndefined();
    });
});

describe('set-plan handler — Redis completely unreachable returns 500 (fails closed)', () => {
    const SECRET = 'test-secret';
    let handler;

    beforeEach(() => {
        jest.resetModules();

        process.env.UPSTASH_REDIS_REST_URL   = 'https://unreachable-redis.example.com';
        process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
        delete process.env.DATABASE_URL;
        process.env.CLERK_SECRET_KEY = 'clerk-test-key';
        process.env.SET_PLAN_SECRET  = SECRET;

        jest.doMock('../api/_cors', () => ({
            setCorsHeaders: () => {},
            handleOptions:  () => false,
        }));

        // All Redis fetches fail; Clerk (non-Redis URL) succeeds.
        // recordNonce will throw before Clerk is ever called, so every
        // request returns 500 — replay protection holds because no nonce
        // is ever committed.
        global.fetch = jest.fn(async (url) => {
            if (url.includes('unreachable-redis')) throw new Error('ECONNREFUSED');
            return { ok: true, json: async () => ({}) };
        });

        handler = require('../api/set-plan');
    });

    afterEach(() => {
        delete process.env.UPSTASH_REDIS_REST_URL;
        delete process.env.UPSTASH_REDIS_REST_TOKEN;
        delete process.env.CLERK_SECRET_KEY;
        delete process.env.SET_PLAN_SECRET;
        jest.clearAllMocks();
    });

    test('request returns 500 when Redis recordNonce is unreachable (fails closed)', async () => {
        const { req, res } = makeReqRes({ nonce: 'redis-down-e2e-nonce-1' });
        await handler(req, res);
        expect(res.statusCode).toBe(500);
        expect(res.body.ok).toBe(false);
        expect(res.body.error).toMatch(/Failed to record nonce/i);
    });

    test('a retry with the same nonce also returns 500 while Redis stays down — no replay slip-through', async () => {
        const nonce = 'redis-down-e2e-nonce-2';
        const { req: req1, res: res1 } = makeReqRes({ nonce });
        const { req: req2, res: res2 } = makeReqRes({ nonce });

        await handler(req1, res1);
        await handler(req2, res2);

        // Both return 500 — neither request was processed, so no double-billing
        // and no replay attack succeeded.
        expect(res1.statusCode).toBe(500);
        expect(res2.statusCode).toBe(500);
    });

    test('a different nonce also returns 500 while Redis is down', async () => {
        const { req: req1, res: res1 } = makeReqRes({ nonce: 'redis-down-nonce-alpha' });
        const { req: req2, res: res2 } = makeReqRes({ nonce: 'redis-down-nonce-beta' });

        await handler(req1, res1);
        await handler(req2, res2);

        expect(res1.statusCode).toBe(500);
        expect(res2.statusCode).toBe(500);
    });
});

// ---------------------------------------------------------------------------
// 7. MID-REQUEST REDIS FAILURE — isNonceSeen succeeds, recordNonce fails
//
// Scenario: Redis is up when isNonceSeen (EXISTS) is called and returns false,
// but the connection drops before recordNonce (SET NX) can complete.
//
// This is the window of vulnerability in a naive fallback implementation:
// - isNonceSeen reads from Redis → "not seen"
// - recordNonce write to Redis fails → old code fell back to in-memory
// - Handler returned 200 (nonce only in in-memory, not in Redis)
// - On retry: isNonceSeen reads from Redis (which recovered) → "not seen" again
// - recordNonce writes to Redis → succeeds → second 200 for the same nonce
//
// The fix (fail closed): recordNonce must throw on Redis connectivity failure
// so the handler returns 500.  The nonce is never committed anywhere, so a
// legitimate retry (once Redis recovers) is safe and will succeed.
// ---------------------------------------------------------------------------

describe('_nonce-store — mid-request Redis failure (unit)', () => {
    let isNonceSeen, recordNonce;

    beforeEach(() => {
        jest.resetModules();
        process.env.UPSTASH_REDIS_REST_URL   = 'https://fake-redis.upstash.io';
        process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';

        // EXISTS (isNonceSeen) succeeds; SET NX (recordNonce) throws mid-flight.
        global.fetch = jest.fn(async (url) => {
            if (url.includes('/exists/')) {
                return { ok: true, json: async () => ({ result: 0 }) };
            }
            if (url.includes('/set/')) {
                throw new Error('ECONNRESET');
            }
            return { ok: true, json: async () => ({ result: null }) };
        });

        ({ isNonceSeen, recordNonce } = require('../api/_nonce-store'));
    });

    afterEach(() => {
        delete process.env.UPSTASH_REDIS_REST_URL;
        delete process.env.UPSTASH_REDIS_REST_TOKEN;
        jest.clearAllMocks();
    });

    test('isNonceSeen returns false when Redis EXISTS succeeds', async () => {
        expect(await isNonceSeen('mid-flight-nonce-1')).toBe(false);
    });

    test('recordNonce throws when Redis SET NX fails mid-flight (fails closed)', async () => {
        await expect(recordNonce('mid-flight-nonce-2')).rejects.toThrow(/Redis recordNonce failed/i);
    });

    test('isNonceSeen stays false after a mid-flight recordNonce failure — nonce not committed anywhere', async () => {
        const nonce = 'mid-flight-nonce-3';
        await expect(recordNonce(nonce)).rejects.toThrow();
        // EXISTS still returns 0 (nonce was never written to Redis).
        // isNonceSeen must not return true from an in-memory fallback either,
        // because recordNonce did not commit there.
        expect(await isNonceSeen(nonce)).toBe(false);
    });
});

describe('set-plan handler — mid-request Redis failure returns 500, not 200', () => {
    const SECRET = 'test-secret';
    let handler;

    beforeEach(() => {
        jest.resetModules();
        process.env.UPSTASH_REDIS_REST_URL   = 'https://fake-redis.upstash.io';
        process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
        delete process.env.DATABASE_URL;
        process.env.CLERK_SECRET_KEY = 'clerk-test-key';
        process.env.SET_PLAN_SECRET  = SECRET;

        jest.doMock('../api/_cors', () => ({
            setCorsHeaders: () => {},
            handleOptions:  () => false,
        }));

        handler = require('../api/set-plan');
    });

    afterEach(() => {
        delete process.env.UPSTASH_REDIS_REST_URL;
        delete process.env.UPSTASH_REDIS_REST_TOKEN;
        delete process.env.CLERK_SECRET_KEY;
        delete process.env.SET_PLAN_SECRET;
        jest.clearAllMocks();
    });

    test('returns 500 (not 200) when isNonceSeen succeeds but recordNonce fails mid-flight', async () => {
        // EXISTS succeeds (Redis up); SET NX throws (Redis drops mid-flight).
        global.fetch = jest.fn(async (url) => {
            if (url.includes('fake-redis') && url.includes('/exists/'))
                return { ok: true, json: async () => ({ result: 0 }) };
            if (url.includes('fake-redis') && url.includes('/set/'))
                throw new Error('ECONNRESET');
            // Clerk — should never be reached because recordNonce throws first.
            return { ok: true, json: async () => ({}) };
        });

        const { req, res } = makeReqRes({ nonce: 'mid-flight-e2e-nonce-1' });
        await handler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body.ok).toBe(false);
        expect(res.body.error).toMatch(/Failed to record nonce/i);
    });

    test('Clerk is never called when recordNonce fails mid-flight', async () => {
        const clerkCalls = [];
        global.fetch = jest.fn(async (url) => {
            if (url.includes('fake-redis') && url.includes('/exists/'))
                return { ok: true, json: async () => ({ result: 0 }) };
            if (url.includes('fake-redis') && url.includes('/set/'))
                throw new Error('ECONNRESET');
            // Other Redis ops (rate-limiter /get, /del, /incrby) — return neutral
            // result so the rate-limiter falls back without crashing.
            if (url.includes('fake-redis'))
                return { ok: true, json: async () => ({ result: null }) };
            // Only non-Redis URLs are Clerk calls.
            clerkCalls.push(url);
            return { ok: true, json: async () => ({}) };
        });

        const { req, res } = makeReqRes({ nonce: 'mid-flight-no-clerk-nonce' });
        await handler(req, res);

        expect(res.statusCode).toBe(500);
        expect(clerkCalls).toHaveLength(0);
    });

    test('same nonce cannot slip through on retry after transient Redis failure', async () => {
        // Attempt 1: isNonceSeen (EXISTS → not seen), recordNonce (SET NX → fails)
        // → handler returns 500; nonce committed nowhere.
        //
        // Attempt 2: Redis recovers; isNonceSeen (EXISTS → not seen), recordNonce
        // (SET NX → OK).  This is a LEGITIMATE retry (the original request was
        // never processed), so it must succeed.  The nonce is now in Redis.
        //
        // Attempt 3: Replay attack with the same nonce; isNonceSeen → already seen
        // → 400.  Replay protection holds.

        const redisSeen = new Set();
        let redisRecovered = false;

        global.fetch = jest.fn(async (url) => {
            if (url.includes('fake-redis')) {
                const segments = url.split('/');
                const op  = segments[3];
                const raw = (segments[4] || '').split('?')[0];
                const key = decodeURIComponent(raw);

                if (op === 'exists')
                    return { ok: true, json: async () => ({ result: redisSeen.has(key) ? 1 : 0 }) };

                if (op === 'set') {
                    if (!redisRecovered) throw new Error('ECONNRESET');
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
            }
            // Clerk
            return { ok: true, json: async () => ({}) };
        });

        const nonce = 'mid-flight-retry-nonce';

        // Attempt 1 — transient Redis failure → 500
        const { req: req1, res: res1 } = makeReqRes({ nonce });
        await handler(req1, res1);
        expect(res1.statusCode).toBe(500);

        // Redis recovers
        redisRecovered = true;

        // Attempt 2 — legitimate retry → 200
        const { req: req2, res: res2 } = makeReqRes({ nonce });
        await handler(req2, res2);
        expect(res2.statusCode).toBe(200);
        expect(res2.body.ok).toBe(true);

        // Attempt 3 — replay attack → 400
        const { req: req3, res: res3 } = makeReqRes({ nonce });
        await handler(req3, res3);
        expect(res3.statusCode).toBe(400);
        expect(res3.body.error).toMatch(/duplicate nonce/i);
    });
});

// ---------------------------------------------------------------------------
// 8. RECOVERY — nonce released after Clerk failure (Redis path)
// ---------------------------------------------------------------------------

describe('set-plan handler — nonce released after Clerk failure (Redis path)', () => {
    const SECRET = 'test-secret';
    let handler;
    let redisSeen;

    beforeEach(() => {
        jest.resetModules();
        process.env.UPSTASH_REDIS_REST_URL   = 'https://fake-redis.upstash.io';
        process.env.UPSTASH_REDIS_REST_TOKEN  = 'fake-token';
        delete process.env.DATABASE_URL;
        process.env.CLERK_SECRET_KEY = 'clerk-test-key';
        process.env.SET_PLAN_SECRET  = SECRET;

        jest.doMock('../api/_cors', () => ({
            setCorsHeaders: () => {},
            handleOptions:  () => false,
        }));

        redisSeen = new Set();
        const upstashFetch = makeUpstashFetch(redisSeen);

        // clerkCallCount tracks how many times Clerk has been called
        let clerkCallCount = 0;
        global.fetch = jest.fn(async (url, opts) => {
            if (url.includes('fake-redis')) return upstashFetch(url, opts);
            // Clerk calls — controlled per-test via clerkResponses
            return global.__clerkResponse(clerkCallCount++);
        });

        handler = require('../api/set-plan');
    });

    afterEach(() => {
        delete process.env.UPSTASH_REDIS_REST_URL;
        delete process.env.UPSTASH_REDIS_REST_TOKEN;
        delete process.env.CLERK_SECRET_KEY;
        delete process.env.SET_PLAN_SECRET;
        delete global.__clerkResponse;
        jest.clearAllMocks();
    });

    test('nonce reusable via Redis after Clerk returns non-ok status', async () => {
        const nonce = 'recovery-redis-clerk-error-nonce';

        // Call 0: Clerk fails; call 1: Clerk succeeds
        global.__clerkResponse = (n) => n === 0
            ? { ok: false, status: 500, json: async () => ({ errors: [{ message: 'oops' }] }) }
            : { ok: true, json: async () => ({}) };

        const { req: req1, res: res1 } = makeReqRes({ nonce });
        await handler(req1, res1);
        expect(res1.statusCode).toBe(502);

        // Nonce should have been deleted from Redis
        expect(redisSeen.has(`nonce:${nonce}`)).toBe(false);

        const { req: req2, res: res2 } = makeReqRes({ nonce });
        await handler(req2, res2);
        expect(res2.statusCode).toBe(200);
        expect(res2.body.ok).toBe(true);
    });

    test('nonce stays in Redis after a successful Clerk call', async () => {
        const nonce = 'recovery-redis-success-blocks-replay';

        global.__clerkResponse = () => ({ ok: true, json: async () => ({}) });

        const { req: req1, res: res1 } = makeReqRes({ nonce });
        await handler(req1, res1);
        expect(res1.statusCode).toBe(200);

        // Nonce must still be in Redis
        expect(redisSeen.has(`nonce:${nonce}`)).toBe(true);

        const { req: req2, res: res2 } = makeReqRes({ nonce });
        await handler(req2, res2);
        expect(res2.statusCode).toBe(400);
        expect(res2.body.error).toMatch(/duplicate nonce/i);
    });
});
