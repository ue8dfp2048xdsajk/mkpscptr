/**
 * @jest-environment node
 *
 * Cold-start + backend-outage scenario tests for api/_rate-limiter.js
 *
 * Background
 * ----------
 * The deny cache (denyCache in _rate-limiter.js) is stored in process memory.
 * In a serverless environment each new instance starts with an empty deny cache.
 * These tests pin down the expected behaviour for the two cases that matter:
 *
 *  Case A - Cold-start, backend UP
 *    The shared backend (Redis or PostgreSQL) is the authoritative source.
 *    A new instance has no deny cache, but isRateLimited() queries the backend
 *    and correctly returns true for a previously-blocked IP.  This is the
 *    normal production path and must never regress.
 *
 *  Case B - Cold-start, backend DOWN (accepted limitation)
 *    If the backend is completely unreachable at the moment a new instance
 *    handles its first request, the deny cache is empty and there is no
 *    secondary store to consult.  The rate limiter falls back to the
 *    in-memory counter store (also empty) and returns false - meaning the
 *    block is NOT enforced on that instance until the backend recovers.
 *
 *    This is a known, accepted architectural limitation of any solution that
 *    uses per-instance memory as a cache.  The risk is bounded:
 *      • It requires a total backend outage AND a concurrent cold-start.
 *      • Failures recorded locally during the outage are written to the
 *        backend once it recovers, so the counter catches up.
 *      • If the backend recovers mid-request-stream the deny cache is
 *        repopulated on the first successful isRateLimited() call.
 *    Mitigation options (not implemented here): a secondary low-latency KV
 *    store (e.g. Vercel Edge Config, Cloudflare KV) that is more resilient
 *    than the primary backend and is populated whenever an IP is confirmed
 *    blocked.
 */

'use strict';

const MAX_FAILURES   = 5;
const WINDOW_SECONDS = 15 * 60; // must match api/_rate-limiter.js

// ---------------------------------------------------------------------------
// Shared "Redis" store - survives jest.resetModules() because it lives here.
// Simulates the real Upstash KV: holds per-key integer counters + TTL info.
// ---------------------------------------------------------------------------
const redisStore = new Map(); // key -> { value: number, expiresAt: number }

function redisClear() { redisStore.clear(); }

function redisGet(key) {
    const entry = redisStore.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
        redisStore.delete(key);
        return null;
    }
    return String(entry.value);
}

function redisIncr(key) {
    const entry = redisStore.get(key);
    const newVal = (entry && Date.now() <= entry.expiresAt) ? entry.value + 1 : 1;
    redisStore.set(key, { value: newVal, expiresAt: entry ? entry.expiresAt : Infinity });
    return newVal;
}

function redisExpire(key, ttlSeconds) {
    const entry = redisStore.get(key);
    if (entry) entry.expiresAt = Date.now() + ttlSeconds * 1000;
}

function redisDel(key) { redisStore.delete(key); }

/**
 * Build a fetch mock that delegates to the in-memory redisStore above,
 * faithfully implementing the Upstash REST API subsets used by the limiter:
 *   GET /get/:key
 *   POST /pipeline  (INCR + EXPIRE)
 *   POST /del/:key
 */
function makeRedisFetchMock() {
    return jest.fn(async (url, opts = {}) => {
        const u = String(url);

        // GET /get/:encodedKey
        const getMatch = u.match(/\/get\/([^?/]+)/);
        if (getMatch) {
            const key = decodeURIComponent(getMatch[1]);
            const val = redisGet(key);
            return { ok: true, json: async () => ({ result: val }) };
        }

        // POST /del/:encodedKey
        const delMatch = u.match(/\/del\/([^?/]+)/);
        if (delMatch && opts.method === 'POST') {
            const key = decodeURIComponent(delMatch[1]);
            redisDel(key);
            return { ok: true, json: async () => ({ result: 1 }) };
        }

        // POST /pipeline - array of commands
        if (u.endsWith('/pipeline') && opts.method === 'POST') {
            const commands = JSON.parse(opts.body);
            const results = commands.map(([cmd, ...args]) => {
                if (cmd === 'INCR')   return { result: redisIncr(args[0]) };
                if (cmd === 'EXPIRE') { redisExpire(args[0], args[1]); return { result: 1 }; }
                return { result: null };
            });
            return { ok: true, json: async () => results };
        }

        return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
    });
}

// ---------------------------------------------------------------------------
// Helper: load a fresh rate-limiter with Redis configured (no PG).
// jest.resetModules() clears the module registry (= simulated cold-start).
// ---------------------------------------------------------------------------
function loadRateLimiterWithRedis(fetchMock) {
    jest.resetModules();

    process.env.UPSTASH_REDIS_REST_URL   = 'https://mock-redis.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'mock-token';
    delete process.env.DATABASE_URL;

    global.fetch = fetchMock;

    return require('../api/_rate-limiter');
}

// ---------------------------------------------------------------------------
// Case A: Cold-start, backend UP
// The shared Redis store holds the block - a fresh instance must honour it.
// ---------------------------------------------------------------------------

describe('Rate limiter - cold-start with Redis UP (block persists across instances)', () => {
    beforeEach(() => redisClear());

    afterEach(() => {
        delete process.env.UPSTASH_REDIS_REST_URL;
        delete process.env.UPSTASH_REDIS_REST_TOKEN;
        jest.clearAllMocks();
    });

    test('block established on instance-1 is enforced on fresh instance-2 (Redis UP throughout)', async () => {
        const fetchMock = makeRedisFetchMock();
        const ip = '10.1.0.1';

        // --- Instance 1: accumulate MAX_FAILURES ---
        const rl1 = loadRateLimiterWithRedis(fetchMock);
        for (let i = 0; i < MAX_FAILURES; i++) {
            await rl1.recordFailure(ip);
        }
        expect(await rl1.isRateLimited(ip)).toBe(true);

        // Confirm the counter is in the shared Redis store
        const key = `ratelimit:${ip}`;
        expect(Number(redisGet(key))).toBe(MAX_FAILURES);

        // --- Instance 2: cold-start (module reset) - deny cache is gone ---
        const rl2 = loadRateLimiterWithRedis(fetchMock);
        // isRateLimited must still return true because it reads from Redis
        expect(await rl2.isRateLimited(ip)).toBe(true);
    });

    test('block enforced across multiple successive cold-starts while Redis is UP', async () => {
        const fetchMock = makeRedisFetchMock();
        const ip = '10.1.0.2';

        const rl1 = loadRateLimiterWithRedis(fetchMock);
        for (let i = 0; i < MAX_FAILURES; i++) await rl1.recordFailure(ip);

        for (let restart = 0; restart < 3; restart++) {
            const rl = loadRateLimiterWithRedis(fetchMock);
            expect(await rl.isRateLimited(ip)).toBe(true);
        }
    });

    test('clearFailures on instance-1 means fresh instance-2 sees the IP as unblocked', async () => {
        const fetchMock = makeRedisFetchMock();
        const ip = '10.1.0.3';

        const rl1 = loadRateLimiterWithRedis(fetchMock);
        for (let i = 0; i < MAX_FAILURES; i++) await rl1.recordFailure(ip);
        expect(await rl1.isRateLimited(ip)).toBe(true);

        await rl1.clearFailures(ip);

        const rl2 = loadRateLimiterWithRedis(fetchMock);
        expect(await rl2.isRateLimited(ip)).toBe(false);
    });

    test('unblocked IP (count < MAX_FAILURES) is not blocked on fresh instance', async () => {
        const fetchMock = makeRedisFetchMock();
        const ip = '10.1.0.4';

        const rl1 = loadRateLimiterWithRedis(fetchMock);
        for (let i = 0; i < MAX_FAILURES - 1; i++) await rl1.recordFailure(ip);
        expect(await rl1.isRateLimited(ip)).toBe(false);

        const rl2 = loadRateLimiterWithRedis(fetchMock);
        expect(await rl2.isRateLimited(ip)).toBe(false);
    });

    test('deny cache is repopulated on first hit after cold-start (backend UP)', async () => {
        // After a cold-start isRateLimited call succeeds, the deny cache
        // is populated so subsequent in-process fallback checks still work.
        const fetchMock = makeRedisFetchMock();
        const ip = '10.1.0.5';

        // Set up the block in Redis directly
        const key = `ratelimit:${ip}`;
        redisStore.set(key, { value: MAX_FAILURES, expiresAt: Date.now() + WINDOW_SECONDS * 1000 });

        const rl = loadRateLimiterWithRedis(fetchMock);

        // First call hits Redis successfully and adds to deny cache
        expect(await rl.isRateLimited(ip)).toBe(true);

        // Now simulate Redis going down mid-session (not a cold-start -
        // deny cache was already populated from the first successful call)
        global.fetch = jest.fn().mockRejectedValue(new Error('Redis down mid-session'));

        // Deny cache still covers the IP for its TTL
        expect(await rl.isRateLimited(ip)).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Case B: Cold-start, backend DOWN - accepted limitation
//
// When both the primary backend (Redis) and the in-process deny cache are
// unavailable/empty at the moment of a cold-start, the rate limiter cannot
// enforce a block established on a previous instance.
//
// This is a KNOWN, ACCEPTED LIMITATION.  The tests below document the
// behaviour explicitly so it cannot regress undetected and any future
// mitigation (e.g. an Edge KV layer) has a clear baseline to compare against.
// ---------------------------------------------------------------------------

describe('Rate limiter - cold-start with Redis DOWN (known limitation: block not enforced)', () => {
    afterEach(() => {
        delete process.env.UPSTASH_REDIS_REST_URL;
        delete process.env.UPSTASH_REDIS_REST_TOKEN;
        jest.clearAllMocks();
    });

    /**
     * KNOWN LIMITATION - documented, not a bug to fix without a secondary store.
     *
     * Scenario:
     *   1. IP is blocked on a running instance (deny cache populated, Redis holds count).
     *   2. A new serverless instance cold-starts.
     *   3. At that exact moment Redis is fully unreachable.
     *   4. Result: the new instance's deny cache is empty, Redis read fails,
     *      in-memory counter is also empty → isRateLimited returns false.
     *
     * Mitigation options (not yet implemented):
     *   - Persist confirmed-blocked IPs to a secondary, more-resilient store
     *     (e.g. Vercel Edge Config, Cloudflare KV) that cold-start instances
     *     can consult even when the primary Redis is down.
     *   - Accept the risk: requires a total Redis outage AND a concurrent
     *     cold-start, and the block self-heals once Redis recovers.
     */
    test('KNOWN LIMITATION: blocked IP is not enforced on cold-start instance when Redis is down', async () => {
        const ip = '10.2.0.1';

        // --- Instance 1: block the IP while Redis is working ---
        const workingFetch = makeRedisFetchMock();
        redisClear();
        const rl1 = loadRateLimiterWithRedis(workingFetch);
        for (let i = 0; i < MAX_FAILURES; i++) await rl1.recordFailure(ip);
        expect(await rl1.isRateLimited(ip)).toBe(true);

        // --- Instance 2: cold-start while Redis is down ---
        // (module reset clears deny cache; Redis fetch now always rejects)
        const downFetch = jest.fn().mockRejectedValue(new Error('Redis unreachable'));
        const rl2 = loadRateLimiterWithRedis(downFetch);

        // The block cannot be enforced: deny cache is empty, Redis is down,
        // in-memory counter is empty.  This is the accepted limitation.
        const result = await rl2.isRateLimited(ip);
        expect(result).toBe(false); // documents the gap - not the desired long-term behaviour
    });

    test('KNOWN LIMITATION: deny cache on a running instance does NOT transfer to a new cold-start instance', async () => {
        const ip = '10.2.0.2';

        // Populate the deny cache on instance 1
        redisClear();
        const workingFetch = makeRedisFetchMock();
        redisStore.set(`ratelimit:${ip}`, { value: MAX_FAILURES, expiresAt: Date.now() + WINDOW_SECONDS * 1000 });

        const rl1 = loadRateLimiterWithRedis(workingFetch);
        expect(await rl1.isRateLimited(ip)).toBe(true); // deny cache populated on rl1

        // Instance 2 is a completely separate process - it has no access to rl1's deny cache
        const downFetch = jest.fn().mockRejectedValue(new Error('Redis down'));
        const rl2 = loadRateLimiterWithRedis(downFetch);

        // Even though rl1 cached this block, rl2's deny cache is empty
        const result = await rl2.isRateLimited(ip);
        expect(result).toBe(false); // documents the per-process nature of the deny cache
    });

    test('once Redis recovers mid-session, the deny cache is repopulated and blocks the IP', async () => {
        const ip = '10.2.0.3';
        redisClear();

        // Cold-start with Redis down - block not enforced (known limitation)
        const downFetch = jest.fn().mockRejectedValue(new Error('Redis down at startup'));
        const rl = loadRateLimiterWithRedis(downFetch);
        expect(await rl.isRateLimited(ip)).toBe(false);

        // Redis recovers - seed it with the block state
        redisStore.set(`ratelimit:${ip}`, { value: MAX_FAILURES, expiresAt: Date.now() + WINDOW_SECONDS * 1000 });
        global.fetch = makeRedisFetchMock();

        // Next call hits Redis successfully → deny cache is repopulated → block enforced
        expect(await rl.isRateLimited(ip)).toBe(true);

        // Even if Redis goes down again, the deny cache now covers this instance
        global.fetch = jest.fn().mockRejectedValue(new Error('Redis down again'));
        expect(await rl.isRateLimited(ip)).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Case B (no-backend variant): documents the same cold-start limitation
// without requiring PG mocking.
//
// The PostgreSQL-specific cold-start + outage behaviour is more thoroughly
// exercised in tests/rate-limiter-pg-restart.test.js ("in-memory fallback
// warning" describe block), specifically:
//   "lockout built on in-memory counters is lost after a simulated restart"
// That test uses jest.resetModules() to simulate a restart and confirms that
// in-memory state does not cross the process boundary - the same root cause
// as the Redis cold-start + outage limitation documented above.
//
// The test below uses the no-backend (pure in-memory) path to document the
// accepted limitation in a backend-agnostic way, exercising the same code
// path that the cold-start + total-backend-outage scenario falls into.
// ---------------------------------------------------------------------------

describe('Rate limiter - cold-start limitation (no backend, any-path variant)', () => {
    afterEach(() => {
        delete process.env.UPSTASH_REDIS_REST_URL;
        delete process.env.UPSTASH_REDIS_REST_TOKEN;
        delete process.env.DATABASE_URL;
        jest.clearAllMocks();
    });

    /**
     * KNOWN LIMITATION - backend-agnostic summary.
     *
     * When no backend is configured (or when the backend is completely down on
     * cold-start), isRateLimited() uses the in-memory counter store which is
     * empty on every new process.  A block established in a previous instance
     * is NOT carried over.
     *
     * This test uses the no-backend path because it is the simplest way to
     * reproduce the code path entered by any backend during a total outage on
     * cold-start (Redis: fetch rejects → denyCacheCheck → memIsRateLimited;
     * PG: query rejects → denyCacheCheck → memIsRateLimited).  In both cases
     * the deny cache and the in-memory counter are empty → returns false.
     */
    test('KNOWN LIMITATION: in-memory block is not carried across a cold-start (process reset)', async () => {
        // Suppress the expected "no backend" warning for this test.
        jest.spyOn(console, 'warn').mockImplementation(() => {});

        // Phase 1: record MAX_FAILURES on one module instance.
        jest.resetModules();
        delete process.env.UPSTASH_REDIS_REST_URL;
        delete process.env.UPSTASH_REDIS_REST_TOKEN;
        delete process.env.DATABASE_URL;
        const rl1 = require('../api/_rate-limiter');
        const ip = '10.3.0.1';
        for (let i = 0; i < MAX_FAILURES; i++) await rl1.recordFailure(ip);
        expect(await rl1.isRateLimited(ip)).toBe(true);

        // Phase 2: cold-start - all in-process state is gone.
        jest.resetModules();
        const rl2 = require('../api/_rate-limiter');

        // Block not enforced on the new instance - accepted limitation.
        expect(await rl2.isRateLimited(ip)).toBe(false);
    });

    test('KNOWN LIMITATION: deny cache does not transfer to a new cold-start instance', async () => {
        // This confirms the deny cache (populated when a backend confirms a
        // block) is also lost on cold-start - it is purely per-process.
        // Even if Redis was reachable and the deny cache was warm on instance-1,
        // instance-2 starts with an empty deny cache and must re-query the
        // backend.  If the backend is also down at that moment, the block is
        // not enforced.  This is the "cold-start + total outage" gap.

        // Use the Redis path: seed the block in the shared store, warm the
        // deny cache on rl1, then cold-start with Redis down.
        redisClear();
        redisStore.set(`ratelimit:10.3.0.2`, {
            value: MAX_FAILURES,
            expiresAt: Date.now() + WINDOW_SECONDS * 1000,
        });

        const fetchMock = makeRedisFetchMock();
        const rl1 = loadRateLimiterWithRedis(fetchMock);
        expect(await rl1.isRateLimited('10.3.0.2')).toBe(true); // deny cache warmed

        // Cold-start: new instance, Redis now down.
        const downFetch = jest.fn().mockRejectedValue(new Error('Redis down'));
        const rl2 = loadRateLimiterWithRedis(downFetch);

        // Deny cache is empty; Redis unreachable; in-memory empty → false.
        // Accepted limitation: requires simultaneous cold-start + total outage.
        expect(await rl2.isRateLimited('10.3.0.2')).toBe(false);
    });
});
