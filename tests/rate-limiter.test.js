/**
 * @jest-environment node
 *
 * Tests for api/_rate-limiter.js and its integration with api/set-plan.js.
 *
 * Scenarios covered:
 *  1. 5 failures inside the window → isRateLimited returns true / handler returns 429
 *  2. Good-auth request clears the counter → subsequent request is not blocked
 *  3. Redis errors fall back gracefully (no crash; in-memory used instead)
 *
 * Both the Redis path (mocked fetch) and the in-memory fallback path are exercised.
 */

'use strict';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal mock req/res pair for the set-plan handler.
 * Each call gets a unique nonce so duplicate-nonce checks don't interfere.
 */
function makeReqRes({ authToken = '', ip = '1.2.3.4', body = {} } = {}) {
    const req = {
        method: 'POST',
        headers: {
            authorization: authToken ? `Bearer ${authToken}` : '',
            'x-timestamp': String(Math.floor(Date.now() / 1000)),
            'x-nonce': `nonce-${Math.random()}-${Date.now()}`,
            'x-forwarded-for': ip,
        },
        body,
        socket: { remoteAddress: ip },
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
// 1. IN-MEMORY path
// ---------------------------------------------------------------------------

describe('Rate limiter — in-memory path (no Redis, no PG)', () => {
    let rl;

    beforeEach(() => {
        delete process.env.UPSTASH_REDIS_REST_URL;
        delete process.env.UPSTASH_REDIS_REST_TOKEN;
        delete process.env.DATABASE_URL;
        jest.resetModules();
        rl = require('../api/_rate-limiter');
    });

    test('not rate-limited for a fresh IP', async () => {
        expect(await rl.isRateLimited('10.0.0.1')).toBe(false);
    });

    test('5 failures within the window → isRateLimited returns true', async () => {
        const ip = '10.0.0.2';
        for (let i = 0; i < 5; i++) await rl.recordFailure(ip);
        expect(await rl.isRateLimited(ip)).toBe(true);
    });

    test('fewer than 5 failures → not rate-limited', async () => {
        const ip = '10.0.0.3';
        for (let i = 0; i < 4; i++) await rl.recordFailure(ip);
        expect(await rl.isRateLimited(ip)).toBe(false);
    });

    test('clearFailures after 5 failures → no longer rate-limited', async () => {
        const ip = '10.0.0.4';
        for (let i = 0; i < 5; i++) await rl.recordFailure(ip);
        expect(await rl.isRateLimited(ip)).toBe(true);

        await rl.clearFailures(ip);
        expect(await rl.isRateLimited(ip)).toBe(false);
    });

    test('different IPs are tracked independently', async () => {
        const ipA = '10.0.0.5';
        const ipB = '10.0.0.6';
        for (let i = 0; i < 5; i++) await rl.recordFailure(ipA);
        expect(await rl.isRateLimited(ipA)).toBe(true);
        expect(await rl.isRateLimited(ipB)).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// 2. REDIS path (fetch mocked)
// ---------------------------------------------------------------------------

describe('Rate limiter — Redis path (mocked fetch)', () => {
    let rl;
    let mockFetch;

    beforeEach(() => {
        mockFetch = jest.fn();
        global.fetch = mockFetch;

        jest.resetModules();
        process.env.UPSTASH_REDIS_REST_URL = 'https://mock-redis.upstash.io';
        process.env.UPSTASH_REDIS_REST_TOKEN = 'mock-token';
        delete process.env.DATABASE_URL;
        rl = require('../api/_rate-limiter');
    });

    afterEach(() => {
        delete process.env.UPSTASH_REDIS_REST_URL;
        delete process.env.UPSTASH_REDIS_REST_TOKEN;
        jest.clearAllMocks();
    });

    test('isRateLimited returns false when Redis count is null', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ result: null }),
        });
        expect(await rl.isRateLimited('1.1.1.1')).toBe(false);
    });

    test('isRateLimited returns false when Redis count < 5', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ result: '4' }),
        });
        expect(await rl.isRateLimited('1.1.1.2')).toBe(false);
    });

    test('isRateLimited returns true when Redis count >= 5', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ result: '5' }),
        });
        expect(await rl.isRateLimited('1.1.1.3')).toBe(true);
    });

    test('recordFailure sends INCR + EXPIRE via pipeline', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ([{ result: 1 }, { result: 1 }]),
        });
        await rl.recordFailure('1.1.1.4');

        expect(mockFetch).toHaveBeenCalledTimes(1);
        const [url, opts] = mockFetch.mock.calls[0];
        expect(url).toContain('/pipeline');
        const body = JSON.parse(opts.body);
        expect(body).toContainEqual(['INCR', expect.stringContaining('ratelimit:1.1.1.4')]);
        expect(body).toContainEqual(['EXPIRE', expect.stringContaining('ratelimit:1.1.1.4'), expect.any(Number)]);
    });

    test('clearFailures sends DEL on the correct key', async () => {
        mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ result: 1 }) });
        await rl.clearFailures('1.1.1.5');

        expect(mockFetch).toHaveBeenCalledTimes(1);
        const [url] = mockFetch.mock.calls[0];
        expect(url).toContain('del/');
        expect(url).toContain('ratelimit%3A1.1.1.5');
    });
});

// ---------------------------------------------------------------------------
// 3. Redis error → graceful in-memory fallback (no crash)
// ---------------------------------------------------------------------------

describe('Rate limiter — Redis errors fall back to in-memory gracefully', () => {
    let rl;

    beforeEach(() => {
        jest.resetModules();
        process.env.UPSTASH_REDIS_REST_URL = 'https://mock-redis.upstash.io';
        process.env.UPSTASH_REDIS_REST_TOKEN = 'bad-token';
        delete process.env.DATABASE_URL;

        global.fetch = jest.fn().mockRejectedValue(new Error('Network failure'));

        rl = require('../api/_rate-limiter');
    });

    afterEach(() => {
        delete process.env.UPSTASH_REDIS_REST_URL;
        delete process.env.UPSTASH_REDIS_REST_TOKEN;
        jest.clearAllMocks();
    });

    test('isRateLimited does not throw when Redis is down', async () => {
        await expect(rl.isRateLimited('2.2.2.1')).resolves.toBe(false);
    });

    test('recordFailure does not throw when Redis is down', async () => {
        await expect(rl.recordFailure('2.2.2.2')).resolves.toBeUndefined();
    });

    test('clearFailures does not throw when Redis is down', async () => {
        await expect(rl.clearFailures('2.2.2.3')).resolves.toBeUndefined();
    });

    test('in-memory path still tracks 5 failures after Redis errors', async () => {
        const ip = '2.2.2.4';
        for (let i = 0; i < 5; i++) await rl.recordFailure(ip);
        expect(await rl.isRateLimited(ip)).toBe(true);
    });

    test('in-memory clear works after Redis errors', async () => {
        const ip = '2.2.2.5';
        for (let i = 0; i < 5; i++) await rl.recordFailure(ip);
        expect(await rl.isRateLimited(ip)).toBe(true);

        await rl.clearFailures(ip);
        expect(await rl.isRateLimited(ip)).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// 4. Integration: set-plan.js handler + rate limiter (end-to-end via real modules)
// ---------------------------------------------------------------------------

describe('set-plan handler — rate limiting integration (in-memory)', () => {
    const SECRET = 'correct-secret';

    beforeEach(() => {
        delete process.env.UPSTASH_REDIS_REST_URL;
        delete process.env.UPSTASH_REDIS_REST_TOKEN;
        delete process.env.DATABASE_URL;
        process.env.CLERK_SECRET_KEY = 'clerk-key';
        process.env.SET_PLAN_SECRET = SECRET;
    });

    afterEach(() => {
        jest.clearAllMocks();
        delete process.env.CLERK_SECRET_KEY;
        delete process.env.SET_PLAN_SECRET;
    });

    /**
     * Load a fresh set-plan handler + fresh rate-limiter module, with
     * all unrelated dependencies stubbed.  Uses jest.doMock (not hoisted)
     * so it can be called from within describe/test bodies.
     */
    function loadHandler() {
        jest.resetModules();

        jest.doMock('../api/_cors', () => ({
            setCorsHeaders: () => {},
            handleOptions: () => false,
        }));

        jest.doMock('../api/_nonce-store', () => ({
            isNonceSeen: jest.fn().mockResolvedValue(false),
            recordNonce: jest.fn().mockResolvedValue(undefined),
        }));

        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => ({}),
        });

        return require('../api/set-plan');
    }

    test('5 bad-token requests → 6th request from same IP gets 429', async () => {
        const handler = loadHandler();
        const ip = '3.3.3.1';

        for (let i = 0; i < 5; i++) {
            const { req, res } = makeReqRes({ authToken: 'wrong', ip });
            await handler(req, res);
            expect(res.statusCode).toBe(401);
        }

        const { req, res } = makeReqRes({ authToken: 'wrong', ip });
        await handler(req, res);
        expect(res.statusCode).toBe(429);
        expect(res.body.error).toMatch(/too many/i);
    });

    test('good-auth clears failures → same IP not blocked after successful request', async () => {
        const handler = loadHandler();
        const ip = '3.3.3.2';

        for (let i = 0; i < 4; i++) {
            const { req, res } = makeReqRes({ authToken: 'wrong', ip });
            await handler(req, res);
            expect(res.statusCode).toBe(401);
        }

        const { req: goodReq, res: goodRes } = makeReqRes({
            authToken: SECRET,
            ip,
            body: { userId: 'user_abc', plan: 'pro' },
        });
        await handler(goodReq, goodRes);
        expect(goodRes.statusCode).toBe(200);

        for (let i = 0; i < 4; i++) {
            const { req, res } = makeReqRes({ authToken: 'wrong', ip });
            await handler(req, res);
            expect(res.statusCode).toBe(401);
        }

        const { req: notYetBlocked, res: notYetBlockedRes } = makeReqRes({ authToken: 'wrong', ip });
        await handler(notYetBlocked, notYetBlockedRes);
        expect(notYetBlockedRes.statusCode).toBe(401);

        const { req: nowBlocked, res: nowBlockedRes } = makeReqRes({ authToken: 'wrong', ip });
        await handler(nowBlocked, nowBlockedRes);
        expect(nowBlockedRes.statusCode).toBe(429);
    });

    test('a blocked IP gets 429 before reaching any auth logic', async () => {
        const handler = loadHandler();
        const ip = '3.3.3.3';

        for (let i = 0; i < 5; i++) {
            const { req, res } = makeReqRes({ authToken: 'wrong', ip });
            await handler(req, res);
        }

        const { req, res } = makeReqRes({ authToken: SECRET, ip, body: { userId: 'u', plan: 'pro' } });
        await handler(req, res);
        expect(res.statusCode).toBe(429);
    });
});
