/**
 * @jest-environment node
 *
 * Tests focused on the promise-based singleton guard inside `ensureSchema`.
 *
 * Strategy
 * --------
 * Use a top-level jest.mock (hoisted) so the pg Pool is ALWAYS intercepted,
 * even after jest.resetModules() clears the module registry.
 *
 * Variables named with the "mock" prefix are permitted inside hoisted factory
 * functions - jest's babel transform allows them explicitly.
 *
 * `mockPgStore` acts as the shared "database".
 * `mockQueryInterceptor` lets individual tests control specific query types
 * (e.g., make CREATE TABLE slow or fail).
 *
 * Scenarios:
 *  1. Concurrent callers share the same ensureSchema promise → exactly ONE
 *     CREATE TABLE query issued regardless of concurrency.
 *  2. A failing schema creation clears _schemaPromise → the next call retries.
 *  3. End-to-end: isRateLimited / recordFailure / clearFailures behave
 *     correctly with the PG mock backend.
 */

'use strict';

const MAX_FAILURES   = 5;
const WINDOW_SECONDS = 15 * 60; // must match api/_rate-limiter.js

// ---------------------------------------------------------------------------
// Shared "database" - survives jest.resetModules() because it lives here,
// outside the module under test.
// Variables are prefixed "mock" so the hoisted jest.mock factory can access them.
// ---------------------------------------------------------------------------
let mockPgStore = new Map(); // ip → { failures, window_start }
let mockQueryInterceptor = null; // (sql, params) → result | undefined

// ---------------------------------------------------------------------------
// Top-level jest.mock - hoisted before any require(), persists across
// jest.resetModules() calls.
// ---------------------------------------------------------------------------
jest.mock('../api/node_modules/pg', () => {
    const mockPool = {
        query: jest.fn(async (sql, params = []) => {
            // Allow individual tests to intercept any query.
            if (mockQueryInterceptor) {
                const r = await mockQueryInterceptor(sql, params);
                if (r !== undefined) return r;
            }

            const s = sql.trim();

            // ensureSchema - CREATE TABLE IF NOT EXISTS rate_limit
            if (/CREATE TABLE/i.test(s)) return { rows: [] };

            // pgIsRateLimited - SELECT failures, window_start WHERE ip = $1
            if (/^SELECT/i.test(s)) {
                const ip  = params[0];
                const row = mockPgStore.get(ip);
                return { rows: row ? [{ failures: row.failures, window_start: row.window_start }] : [] };
            }

            // pgRecordFailure - INSERT … ON CONFLICT DO UPDATE
            if (/^INSERT/i.test(s)) {
                const [ip, now, windowCutoff] = params;
                const existing = mockPgStore.get(ip);
                if (!existing || Number(existing.window_start) < Number(windowCutoff)) {
                    mockPgStore.set(ip, { failures: 1, window_start: Number(now) });
                } else {
                    existing.failures += 1;
                }
                return { rows: [] };
            }

            // pgClearFailures - DELETE FROM rate_limit WHERE ip = $1
            // (not the prune DELETE, which references window_start)
            if (/^DELETE/i.test(s) && !/window_start/i.test(s)) {
                mockPgStore.delete(params[0]);
                return { rows: [] };
            }

            return { rows: [] };
        }),
    };

    return { Pool: jest.fn(() => mockPool), _mockPool: mockPool };
});

// ---------------------------------------------------------------------------
// Helper: load a fresh rate-limiter (clears _schemaPromise, _pool) with the
// PG mock active and no Redis.
// ---------------------------------------------------------------------------
function freshRateLimiter() {
    jest.resetModules();
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    process.env.DATABASE_URL = 'postgres://mock/db';
    return require('../api/_rate-limiter');
}

function getMockPool() {
    // Require via the same path that api/_rate-limiter.js resolves so we get
    // the mocked singleton, not the unmocked root node_modules/pg.
    return require('../api/node_modules/pg')._mockPool;
}

/** Create a deferred promise whose settle handles are exposed. */
function deferred() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

// ---------------------------------------------------------------------------
// Common setup / teardown
// ---------------------------------------------------------------------------
beforeEach(() => {
    mockPgStore = new Map();
    mockQueryInterceptor = null;
    // Clear call history on the shared pool mock so each test starts clean.
    getMockPool().query.mockClear();
});

afterEach(() => {
    mockQueryInterceptor = null;
    delete process.env.DATABASE_URL;
});

// ---------------------------------------------------------------------------
// Suite 1: Promise singleton - concurrent callers share one CREATE TABLE
// ---------------------------------------------------------------------------

describe('ensureSchema - promise singleton: concurrent callers share one CREATE TABLE', () => {
    test('N concurrent isRateLimited calls trigger exactly one CREATE TABLE query', async () => {
        const CONCURRENCY = 10;
        const rl   = freshRateLimiter();
        const pool = getMockPool();

        const results = await Promise.all(
            Array.from({ length: CONCURRENCY }, (_, i) =>
                rl.isRateLimited(`10.0.0.${i + 1}`)
            )
        );

        // All fresh IPs → not rate-limited.
        expect(results.every(r => r === false)).toBe(true);

        // Schema must have been requested exactly once regardless of concurrency.
        const createCalls = pool.query.mock.calls.filter(([sql]) =>
            /CREATE TABLE/i.test(sql)
        );
        expect(createCalls).toHaveLength(1);
    });

    test('concurrent calls while CREATE TABLE is in-flight wait for the same promise', async () => {
        const schemaDeferred = deferred();
        let selectCount = 0;

        mockQueryInterceptor = async (sql) => {
            if (/CREATE TABLE/i.test(sql)) return schemaDeferred.promise;
            if (/^SELECT/i.test(sql)) { selectCount += 1; return { rows: [] }; }
        };

        const rl   = freshRateLimiter();
        const pool = getMockPool();

        const promises = [
            rl.isRateLimited('1.0.0.1'),
            rl.isRateLimited('1.0.0.2'),
            rl.isRateLimited('1.0.0.3'),
            rl.isRateLimited('1.0.0.4'),
            rl.isRateLimited('1.0.0.5'),
        ];

        // Yield microtasks so async chains advance up to the first await.
        await Promise.resolve();
        await Promise.resolve();

        // CREATE TABLE must have been issued exactly once while in-flight.
        expect(pool.query.mock.calls.filter(([s]) => /CREATE TABLE/i.test(s))).toHaveLength(1);
        // SELECTs cannot proceed until schema resolves.
        expect(selectCount).toBe(0);

        // Release the schema - all 5 callers now proceed to their SELECTs.
        schemaDeferred.resolve({ rows: [] });
        await Promise.all(promises);

        expect(selectCount).toBe(5);
        // Still exactly one CREATE TABLE total.
        expect(pool.query.mock.calls.filter(([s]) => /CREATE TABLE/i.test(s))).toHaveLength(1);
    });

    test('second and subsequent calls reuse the resolved schema promise', async () => {
        const rl   = freshRateLimiter();
        const pool = getMockPool();

        // First call resolves the schema.
        await rl.isRateLimited('2.0.0.1');
        expect(pool.query.mock.calls.filter(([s]) => /CREATE TABLE/i.test(s))).toHaveLength(1);

        // Additional calls of all types must not re-create the table.
        await rl.isRateLimited('2.0.0.2');
        await rl.recordFailure('2.0.0.3');
        await rl.clearFailures('2.0.0.3');
        await rl.isRateLimited('2.0.0.4');

        expect(pool.query.mock.calls.filter(([s]) => /CREATE TABLE/i.test(s))).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// Suite 2: Retry after failure - _schemaPromise is cleared on rejection
// ---------------------------------------------------------------------------

describe('ensureSchema - retry after failure: _schemaPromise is cleared on rejection', () => {
    test('if CREATE TABLE rejects, the next call retries (issues a second CREATE TABLE)', async () => {
        let schemaAttempts = 0;

        mockQueryInterceptor = async (sql) => {
            if (/CREATE TABLE/i.test(sql)) {
                schemaAttempts += 1;
                if (schemaAttempts === 1) throw new Error('DDL error: permission denied');
                return { rows: [] };
            }
        };

        const rl = freshRateLimiter();

        // First call - CREATE TABLE fails → falls back to in-memory → returns false.
        await rl.isRateLimited('3.0.0.1');
        expect(schemaAttempts).toBe(1);

        // Second call - _schemaPromise was cleared → a new CREATE TABLE is issued.
        await rl.isRateLimited('3.0.0.2');
        expect(schemaAttempts).toBe(2);
    });

    test('after a failed schema the call falls back to in-memory without throwing', async () => {
        mockQueryInterceptor = async () => { throw new Error('DB unavailable'); };
        const rl = freshRateLimiter();

        await expect(rl.isRateLimited('3.1.0.1')).resolves.toBe(false);
        await expect(rl.recordFailure('3.1.0.1')).resolves.toBeUndefined();
    });

    test('recovered schema enables full PG-backed rate limiting', async () => {
        const ip = '3.2.0.1';
        let schemaAttempts = 0;

        mockQueryInterceptor = async (sql) => {
            if (/CREATE TABLE/i.test(sql)) {
                schemaAttempts += 1;
                if (schemaAttempts === 1) throw new Error('transient DDL error');
                return { rows: [] };
            }
        };

        const rl = freshRateLimiter();

        // First call - schema fails; in-memory fallback (not rate-limited).
        expect(await rl.isRateLimited(ip)).toBe(false);
        expect(schemaAttempts).toBe(1);

        // recordFailure calls - schema retries and succeeds; PG is now used.
        for (let i = 0; i < MAX_FAILURES; i++) await rl.recordFailure(ip);

        expect(schemaAttempts).toBe(2);              // exactly one retry
        expect(mockPgStore.has(ip)).toBe(true);
        expect(mockPgStore.get(ip).failures).toBe(MAX_FAILURES);

        // isRateLimited reads from PG → returns true.
        expect(await rl.isRateLimited(ip)).toBe(true);
    });

    test('concurrent calls during a failing schema share one promise and one retry', async () => {
        let schemaAttempts = 0;

        mockQueryInterceptor = async (sql) => {
            if (/CREATE TABLE/i.test(sql)) {
                schemaAttempts += 1;
                if (schemaAttempts === 1) throw new Error('DDL failed');
                return { rows: [] };
            }
        };

        const rl = freshRateLimiter();

        // 3 concurrent calls share the same (failing) schema promise.
        await Promise.all([
            rl.isRateLimited('4.0.0.1'),
            rl.isRateLimited('4.0.0.2'),
            rl.isRateLimited('4.0.0.3'),
        ]);
        expect(schemaAttempts).toBe(1); // only one CREATE TABLE for the whole batch

        // Retry call - a new CREATE TABLE must be issued.
        await rl.isRateLimited('4.0.0.4');
        expect(schemaAttempts).toBe(2);
    });
});

// ---------------------------------------------------------------------------
// Suite 3: Integration - isRateLimited / recordFailure / clearFailures with PG
// ---------------------------------------------------------------------------

describe('ensureSchema integration - rate-limiting logic with PG backend', () => {
    test('fresh IP is not rate-limited', async () => {
        const rl = freshRateLimiter();
        expect(await rl.isRateLimited('5.0.0.1')).toBe(false);
    });

    test('fewer than MAX_FAILURES → not rate-limited', async () => {
        const rl = freshRateLimiter();
        const ip = '5.0.0.2';
        for (let i = 0; i < MAX_FAILURES - 1; i++) await rl.recordFailure(ip);
        expect(await rl.isRateLimited(ip)).toBe(false);
    });

    test('exactly MAX_FAILURES → rate-limited', async () => {
        const rl = freshRateLimiter();
        const ip = '5.0.0.3';
        for (let i = 0; i < MAX_FAILURES; i++) await rl.recordFailure(ip);
        expect(await rl.isRateLimited(ip)).toBe(true);
    });

    test('clearFailures resets the counter - IP is no longer blocked', async () => {
        const rl = freshRateLimiter();
        const ip = '5.0.0.4';
        for (let i = 0; i < MAX_FAILURES; i++) await rl.recordFailure(ip);
        expect(await rl.isRateLimited(ip)).toBe(true);

        await rl.clearFailures(ip);
        expect(await rl.isRateLimited(ip)).toBe(false);
    });

    test('window expiry: row older than 15 min is not blocked', async () => {
        const ip = '5.0.0.5';
        mockPgStore.set(ip, {
            failures: MAX_FAILURES,
            window_start: Date.now() - (WINDOW_SECONDS + 60) * 1000,
        });
        const rl = freshRateLimiter();
        expect(await rl.isRateLimited(ip)).toBe(false);
    });

    test('window reset: recordFailure after expiry resets counter to 1', async () => {
        const ip = '5.0.0.6';
        const realNow = Date.now();
        const dateSpy = jest.spyOn(Date, 'now').mockReturnValue(realNow);

        const rl = freshRateLimiter();

        for (let i = 0; i < MAX_FAILURES; i++) await rl.recordFailure(ip);
        expect(await rl.isRateLimited(ip)).toBe(true);

        const futureNow = realNow + (WINDOW_SECONDS + 1) * 1000;
        dateSpy.mockReturnValue(futureNow);

        await rl.recordFailure(ip);

        dateSpy.mockRestore();

        const row = mockPgStore.get(ip);
        expect(row).toBeDefined();
        expect(row.failures).toBe(1);
        expect(row.window_start).toBe(futureNow);
        expect(await rl.isRateLimited(ip)).toBe(false);
    });

    test('different IPs are tracked independently', async () => {
        const rl  = freshRateLimiter();
        const ipA = '5.0.1.1';
        const ipB = '5.0.1.2';
        for (let i = 0; i < MAX_FAILURES; i++) await rl.recordFailure(ipA);
        expect(await rl.isRateLimited(ipA)).toBe(true);
        expect(await rl.isRateLimited(ipB)).toBe(false);
    });
});
