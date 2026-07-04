/**
 * @jest-environment node
 *
 * Integration tests proving that a rate-limit lockout established via the
 * PostgreSQL backend survives a simulated cold server restart.
 *
 * Strategy
 * --------
 * - Mock `pg` so `Pool.query` delegates to a shared in-memory map that
 *   persists across jest.resetModules() calls (simulating the real DB).
 * - Record MAX_FAILURES (5) failures, then reset the module registry to
 *   clear all in-process state, re-require the module, and assert the
 *   lockout is still enforced.
 * - Also exercise the window-expiry path: a row whose window_start is
 *   older than WINDOW_SECONDS must NOT trigger a lockout after a restart.
 */

'use strict';

const MAX_FAILURES    = 5;
const WINDOW_SECONDS  = 15 * 60; // must match api/_rate-limiter.js

// ---------------------------------------------------------------------------
// Shared "database" - survives jest.resetModules() because it lives here,
// outside the module under test.
// ---------------------------------------------------------------------------
const pgStore = new Map(); // ip → { failures: number, window_start: number }

/**
 * Build a pg mock whose Pool.query interprets the four SQL shapes used by
 * api/_rate-limiter.js (CREATE TABLE, SELECT, INSERT … ON CONFLICT, DELETE).
 */
function makePgMock() {
    const pool = {
        query: jest.fn(async (sql, params = []) => {
            const s = sql.trim();

            // ensureSchema
            if (/CREATE TABLE/i.test(s)) return { rows: [] };

            // pgIsRateLimited - SELECT failures, window_start FROM rate_limit WHERE ip = $1
            if (/^SELECT/i.test(s)) {
                const ip  = params[0];
                const row = pgStore.get(ip);
                return { rows: row ? [{ failures: row.failures, window_start: row.window_start }] : [] };
            }

            // pgRecordFailure - INSERT … ON CONFLICT DO UPDATE
            if (/^INSERT/i.test(s)) {
                const [ip, now, windowCutoff] = params;
                const existing = pgStore.get(ip);
                if (!existing || Number(existing.window_start) < Number(windowCutoff)) {
                    pgStore.set(ip, { failures: 1, window_start: Number(now) });
                } else {
                    existing.failures += 1;
                }
                return { rows: [] };
            }

            // pgClearFailures - DELETE FROM rate_limit WHERE ip = $1
            if (/^DELETE/i.test(s)) {
                pgStore.delete(params[0]);
                return { rows: [] };
            }

            return { rows: [] };
        }),
    };

    return { Pool: jest.fn(() => pool), _pool: pool };
}

// ---------------------------------------------------------------------------
// Helper: load a fresh copy of the rate-limiter with PG enabled (no Redis).
// ---------------------------------------------------------------------------
function loadRateLimiter(pgMock) {
    jest.resetModules();

    jest.doMock('pg', () => pgMock);

    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    process.env.DATABASE_URL = 'postgres://mock/db';

    return require('../api/_rate-limiter');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Rate limiter - PostgreSQL path survives cold server restart', () => {
    let pgMock;

    beforeEach(() => {
        pgStore.clear();
        pgMock = makePgMock();
    });

    afterEach(() => {
        delete process.env.DATABASE_URL;
        jest.clearAllMocks();
    });

    test('lockout established before restart is still enforced after restart', async () => {
        // --- Phase 1: record MAX_FAILURES failures (pre-restart) ---
        const rl1 = loadRateLimiter(pgMock);
        const ip = '192.168.0.1';

        for (let i = 0; i < MAX_FAILURES; i++) {
            await rl1.recordFailure(ip);
        }
        expect(await rl1.isRateLimited(ip)).toBe(true);

        // Confirm the row is in the shared store (i.e., written to "DB")
        const row = pgStore.get(ip);
        expect(row).toBeDefined();
        expect(row.failures).toBe(MAX_FAILURES);

        // --- Phase 2: simulate cold server restart by resetting the module ---
        const rl2 = loadRateLimiter(pgMock);

        // The module's in-memory state is gone, but the DB row persists →
        // isRateLimited must still return true.
        expect(await rl2.isRateLimited(ip)).toBe(true);
    });

    test('window-expiry path: expired row does NOT cause lockout after restart', async () => {
        // Seed the shared store directly with a row whose window_start is
        // older than WINDOW_SECONDS - as if the lockout timed out.
        const ip = '192.168.0.2';
        const expiredStart = Date.now() - (WINDOW_SECONDS + 60) * 1000; // 1 min past window
        pgStore.set(ip, { failures: MAX_FAILURES, window_start: expiredStart });

        // Load a fresh module (simulating restart)
        const rl = loadRateLimiter(pgMock);

        // The window has elapsed → should NOT be rate-limited
        expect(await rl.isRateLimited(ip)).toBe(false);
    });

    test('active lockout (within window) is enforced after restart', async () => {
        const ip = '192.168.0.3';
        const recentStart = Date.now() - 30 * 1000; // 30 s ago, well inside window
        pgStore.set(ip, { failures: MAX_FAILURES, window_start: recentStart });

        const rl = loadRateLimiter(pgMock);
        expect(await rl.isRateLimited(ip)).toBe(true);
    });

    test('fewer-than-max failures in DB → not rate-limited after restart', async () => {
        const ip = '192.168.0.4';
        const recentStart = Date.now() - 30 * 1000;
        pgStore.set(ip, { failures: MAX_FAILURES - 1, window_start: recentStart });

        const rl = loadRateLimiter(pgMock);
        expect(await rl.isRateLimited(ip)).toBe(false);
    });

    test('clearFailures removes the lockout; restart confirms it is gone', async () => {
        // Build up a lockout
        const rl1 = loadRateLimiter(pgMock);
        const ip = '192.168.0.5';
        for (let i = 0; i < MAX_FAILURES; i++) await rl1.recordFailure(ip);
        expect(await rl1.isRateLimited(ip)).toBe(true);

        // Clear (e.g., after a successful auth)
        await rl1.clearFailures(ip);
        expect(pgStore.has(ip)).toBe(false);

        // Simulate restart - should still be clear
        const rl2 = loadRateLimiter(pgMock);
        expect(await rl2.isRateLimited(ip)).toBe(false);
    });

    test('multiple restarts: each reload continues to read from shared DB', async () => {
        const ip = '192.168.0.6';

        // First pass: record failures
        const rl1 = loadRateLimiter(pgMock);
        for (let i = 0; i < MAX_FAILURES; i++) await rl1.recordFailure(ip);

        // Second restart
        const rl2 = loadRateLimiter(pgMock);
        expect(await rl2.isRateLimited(ip)).toBe(true);

        // Third restart
        const rl3 = loadRateLimiter(pgMock);
        expect(await rl3.isRateLimited(ip)).toBe(true);
    });

    test('window reset mid-lockout: recordFailure after window expiry starts a fresh counter', async () => {
        const ip = '192.168.0.7';
        const realNow = Date.now();

        // --- Phase 1: build up a full lockout at t=0 ---
        const dateSpy = jest.spyOn(Date, 'now').mockReturnValue(realNow);

        const rl = loadRateLimiter(pgMock);
        for (let i = 0; i < MAX_FAILURES; i++) {
            await rl.recordFailure(ip);
        }
        expect(await rl.isRateLimited(ip)).toBe(true);

        // Confirm the DB row has exactly MAX_FAILURES
        const rowBefore = pgStore.get(ip);
        expect(rowBefore).toBeDefined();
        expect(rowBefore.failures).toBe(MAX_FAILURES);

        // --- Phase 2: advance time past the window boundary ---
        const futureNow = realNow + (WINDOW_SECONDS + 1) * 1000;
        dateSpy.mockReturnValue(futureNow);

        // recordFailure must detect the expired window and reset the counter to 1
        await rl.recordFailure(ip);

        const rowAfter = pgStore.get(ip);
        expect(rowAfter).toBeDefined();
        expect(rowAfter.failures).toBe(1);             // reset, not MAX_FAILURES + 1
        expect(rowAfter.window_start).toBe(futureNow); // new window starts now

        // Only 1 failure in the new window → not yet rate-limited
        expect(await rl.isRateLimited(ip)).toBe(false);

        // --- Phase 3: accumulate MAX_FAILURES in the new window → lockout again ---
        for (let i = 1; i < MAX_FAILURES; i++) {
            await rl.recordFailure(ip);
        }
        expect(pgStore.get(ip).failures).toBe(MAX_FAILURES);
        expect(await rl.isRateLimited(ip)).toBe(true);

        dateSpy.mockRestore();
    });
});

// ---------------------------------------------------------------------------
// In-memory fallback warning emitted at module load time
// ---------------------------------------------------------------------------

describe('Rate limiter - in-memory fallback warning', () => {
    let warnSpy;

    beforeEach(() => {
        warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        delete process.env.UPSTASH_REDIS_REST_URL;
        delete process.env.UPSTASH_REDIS_REST_TOKEN;
        delete process.env.DATABASE_URL;
        jest.resetModules();
        warnSpy.mockRestore();
    });

    test('emits a console.warn when neither Redis nor PG is configured', () => {
        delete process.env.UPSTASH_REDIS_REST_URL;
        delete process.env.UPSTASH_REDIS_REST_TOKEN;
        delete process.env.DATABASE_URL;

        jest.resetModules();
        require('../api/_rate-limiter');

        expect(warnSpy).toHaveBeenCalledTimes(1);
        const [msg] = warnSpy.mock.calls[0];
        expect(msg).toMatch(/in-memory|process memory/i);
        expect(msg).toMatch(/cold start|restart/i);
    });

    test('does NOT emit the warning when Redis is configured', () => {
        process.env.UPSTASH_REDIS_REST_URL   = 'https://mock-redis.upstash.io';
        process.env.UPSTASH_REDIS_REST_TOKEN = 'mock-token';
        delete process.env.DATABASE_URL;

        jest.resetModules();
        require('../api/_rate-limiter');

        expect(warnSpy).not.toHaveBeenCalled();
    });

    test('does NOT emit the warning when PostgreSQL is configured', () => {
        delete process.env.UPSTASH_REDIS_REST_URL;
        delete process.env.UPSTASH_REDIS_REST_TOKEN;
        process.env.DATABASE_URL = 'postgres://mock/db';

        jest.resetModules();
        jest.doMock('pg', () => ({ Pool: jest.fn(() => ({ query: jest.fn().mockResolvedValue({ rows: [] }) })) }));
        require('../api/_rate-limiter');

        expect(warnSpy).not.toHaveBeenCalled();
    });

    test('lockout built on in-memory counters is lost after a simulated restart', async () => {
        delete process.env.UPSTASH_REDIS_REST_URL;
        delete process.env.UPSTASH_REDIS_REST_TOKEN;
        delete process.env.DATABASE_URL;

        // Phase 1: accumulate MAX_FAILURES in one module instance
        jest.resetModules();
        const rl1 = require('../api/_rate-limiter');
        const ip = '10.99.0.1';
        for (let i = 0; i < MAX_FAILURES; i++) await rl1.recordFailure(ip);
        expect(await rl1.isRateLimited(ip)).toBe(true);

        // Phase 2: "restart" - fresh module load loses the counters
        jest.resetModules();
        const rl2 = require('../api/_rate-limiter');
        expect(await rl2.isRateLimited(ip)).toBe(false);
    });
});
