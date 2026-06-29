/**
 * @jest-environment node
 *
 * Replay-attack protection — duplicate nonce rejection.
 *
 * Covers:
 *  - isNonceSeen / recordNonce unit behaviour on the in-memory fallback path
 *  - isNonceSeen / recordNonce unit behaviour on the Redis (Upstash) path (mocked fetch)
 *  - End-to-end set-plan handler returns 400 on a second request with the same nonce
 *    for both paths
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
        const op  = segments[3];              // 'set', 'exists', 'get', 'del', …
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

        // Rate-limiter or any other Redis op — return neutral result so the
        // caller's error handling falls back to in-memory without crashing.
        return { ok: true, json: async () => ({ result: null }) };
    });
}

// ---------------------------------------------------------------------------
// 1. IN-MEMORY FALLBACK — unit tests for _nonce-store
// ---------------------------------------------------------------------------

describe('_nonce-store (in-memory fallback) — unit', () => {
    let isNonceSeen, recordNonce;

    beforeEach(() => {
        jest.resetModules();
        delete process.env.UPSTASH_REDIS_REST_URL;
        delete process.env.UPSTASH_REDIS_REST_TOKEN;
        ({ isNonceSeen, recordNonce } = require('../api/_nonce-store'));
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
});

// ---------------------------------------------------------------------------
// 2. REDIS PATH — unit tests for _nonce-store (mocked Upstash fetch)
// ---------------------------------------------------------------------------

describe('_nonce-store (Redis path) — unit', () => {
    let isNonceSeen, recordNonce;

    beforeEach(() => {
        jest.resetModules();
        process.env.UPSTASH_REDIS_REST_URL   = 'https://fake-redis.upstash.io';
        process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';

        global.fetch = makeUpstashFetch();

        ({ isNonceSeen, recordNonce } = require('../api/_nonce-store'));
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
