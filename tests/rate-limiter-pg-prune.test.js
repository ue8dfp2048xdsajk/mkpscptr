/**
 * @jest-environment node
 *
 * Integration tests confirming that stale rate_limit rows are actually removed
 * by pgPruneExpired - the cleanup function fired probabilistically (5 % of
 * requests) inside pgIsRateLimited.
 *
 * Strategy
 * --------
 * - Mock `pg` so Pool.query delegates to a shared in-process map (pgStore).
 * - The mock handles BOTH DELETE shapes emitted by the module:
 *     • DELETE FROM rate_limit WHERE ip = $1                                  (pgClearFailures)
 *     • DELETE … WHERE window_start < (EXTRACT(EPOCH FROM NOW()) * 1000 - $1) (pgPruneExpired)
 *   For the prune shape $1 is the window duration in ms; the mock resolves
 *   the cutoff as Date.now() - $1, mirroring what the DB NOW() would produce.
 * - Mock Math.random to return 0 so the 5 % gate always fires.
 * - pgPruneExpired is fire-and-forget (no await), so after calling
 *   isRateLimited we flush the microtask queue with a setImmediate promise
 *   before asserting the store state.
 */

'use strict';

const WINDOW_SECONDS = 15 * 60; // must match api/_rate-limiter.js

// ---------------------------------------------------------------------------
// Shared "database" - lives outside the module so it survives resetModules().
// ---------------------------------------------------------------------------
const pgStore = new Map(); // ip → { failures: number, window_start: number }

// ---------------------------------------------------------------------------
// Build a pg mock whose Pool.query handles all four SQL shapes plus the
// window_start-based prune DELETE.
// ---------------------------------------------------------------------------
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

            // pgPruneExpired - DELETE … WHERE window_start < (EXTRACT(EPOCH FROM NOW()) * 1000 - $1)
            // $1 is the window duration in ms; resolve cutoff using Date.now() to mirror DB NOW().
            if (/^DELETE/i.test(s) && /window_start/i.test(s)) {
                const cutoff = Date.now() - Number(params[0]);
                for (const [ip, row] of pgStore.entries()) {
                    if (row.window_start < cutoff) {
                        pgStore.delete(ip);
                    }
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
// Helper: load a fresh rate-limiter module backed by PG only (no Redis).
// ---------------------------------------------------------------------------
function loadRateLimiter(pgMock) {
    jest.resetModules();
    jest.doMock('pg', () => pgMock);
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    process.env.DATABASE_URL = 'postgres://mock/db';
    return require('../api/_rate-limiter');
}

// Flush all pending microtasks/promises (needed because pgPruneExpired is
// called without await inside pgIsRateLimited).
function flushAsync() {
    return new Promise(resolve => setImmediate(resolve));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('pgPruneExpired - stale rows are deleted on schedule', () => {
    let pgMock;
    let randomSpy;

    beforeEach(() => {
        pgStore.clear();
        pgMock = makePgMock();
        // Force the 5 % gate to always fire so every isRateLimited call prunes.
        randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0);
    });

    afterEach(() => {
        randomSpy.mockRestore();
        delete process.env.DATABASE_URL;
        jest.clearAllMocks();
    });

    test('a row whose window_start is older than WINDOW_SECONDS is deleted after isRateLimited', async () => {
        const ip = '10.1.0.1';
        const staleStart = Date.now() - (WINDOW_SECONDS + 60) * 1000; // 1 min past window
        pgStore.set(ip, { failures: 3, window_start: staleStart });

        const rl = loadRateLimiter(pgMock);

        // Trigger isRateLimited - the prune fires as a side-effect
        await rl.isRateLimited(ip);
        await flushAsync(); // let the fire-and-forget pgPruneExpired complete

        expect(pgStore.has(ip)).toBe(false);
    });

    test('a row exactly at the window boundary (window_start === cutoff) is NOT pruned', async () => {
        const ip = '10.1.0.2';
        // Place window_start exactly at the cutoff - it must NOT be deleted
        // because the query is `window_start < cutoff` (strict less-than).
        const dateSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000_000_000_000);
        const cutoff  = 1_000_000_000_000 - WINDOW_SECONDS * 1000;
        pgStore.set(ip, { failures: 3, window_start: cutoff });

        const rl = loadRateLimiter(pgMock);

        await rl.isRateLimited(ip);
        await flushAsync();

        expect(pgStore.has(ip)).toBe(true); // boundary row survives

        dateSpy.mockRestore();
    });

    test('a row one millisecond inside the window is NOT pruned', async () => {
        const ip = '10.1.0.3';
        const T = 1_000_000_000_000;
        const dateSpy = jest.spyOn(Date, 'now').mockReturnValue(T);
        const recentStart = T - (WINDOW_SECONDS * 1000 - 1); // 1 ms inside window
        pgStore.set(ip, { failures: 5, window_start: recentStart });

        const rl = loadRateLimiter(pgMock);

        await rl.isRateLimited(ip);
        await flushAsync();

        dateSpy.mockRestore();
        expect(pgStore.has(ip)).toBe(true); // still within window → must survive
    });

    test('only expired rows are pruned; fresh rows for other IPs are untouched', async () => {
        const staleIp  = '10.1.0.4';
        const freshIp  = '10.1.0.5';
        const staleStart = Date.now() - (WINDOW_SECONDS + 120) * 1000;
        const freshStart = Date.now() - 30 * 1000; // 30 s ago

        pgStore.set(staleIp, { failures: 3, window_start: staleStart });
        pgStore.set(freshIp, { failures: 2, window_start: freshStart });

        const rl = loadRateLimiter(pgMock);

        await rl.isRateLimited(staleIp);
        await flushAsync();

        expect(pgStore.has(staleIp)).toBe(false); // expired → gone
        expect(pgStore.has(freshIp)).toBe(true);  // fresh   → intact
    });

    test('multiple stale rows are all pruned in a single pass', async () => {
        const ips = ['10.1.1.1', '10.1.1.2', '10.1.1.3'];
        const staleStart = Date.now() - (WINDOW_SECONDS + 300) * 1000;

        for (const ip of ips) {
            pgStore.set(ip, { failures: 5, window_start: staleStart });
        }

        const rl = loadRateLimiter(pgMock);

        // One isRateLimited call triggers a single prune that clears all expired rows
        await rl.isRateLimited(ips[0]);
        await flushAsync();

        for (const ip of ips) {
            expect(pgStore.has(ip)).toBe(false);
        }
    });

    test('isRateLimited returns false for the pruned IP on the same call', async () => {
        // pgIsRateLimited SELECTs before the prune fires; a stale row is outside
        // the window so it returns false regardless.  After flushing, the row
        // is also removed from the store.
        const ip = '10.1.0.6';
        const staleStart = Date.now() - (WINDOW_SECONDS + 60) * 1000;
        pgStore.set(ip, { failures: 99, window_start: staleStart });

        const rl = loadRateLimiter(pgMock);

        const limited = await rl.isRateLimited(ip);
        await flushAsync();

        expect(limited).toBe(false);          // window expired → not blocked
        expect(pgStore.has(ip)).toBe(false);  // row cleaned up by prune
    });

    test('DELETE query issued by prune uses DB clock (EXTRACT(EPOCH FROM NOW())) not Date.now()', async () => {
        const ip = '10.1.0.7';
        const staleStart = Date.now() - (WINDOW_SECONDS + 60) * 1000;
        pgStore.set(ip, { failures: 2, window_start: staleStart });

        const { _pool: pool } = pgMock;
        const rl = loadRateLimiter(pgMock);

        await rl.isRateLimited(ip);
        await flushAsync();

        // Find the prune DELETE call - it must reference window_start
        const deleteCalls = pool.query.mock.calls.filter(
            ([sql]) => /^DELETE/i.test(sql.trim()) && /window_start/i.test(sql)
        );
        expect(deleteCalls.length).toBeGreaterThanOrEqual(1);

        const [pruneSQL, pruneParams] = deleteCalls[0];

        // SQL must delegate the cutoff computation to the DB clock
        expect(pruneSQL).toMatch(/EXTRACT\s*\(\s*EPOCH\s+FROM\s+NOW\s*\(\s*\)/i);

        // $1 is the window duration in ms - a fixed positive integer, never a
        // Unix timestamp (which would be ~13 digits and > 1 trillion).
        expect(pruneParams[0]).toBe(WINDOW_SECONDS * 1000);
    });
});

// ---------------------------------------------------------------------------
// pgPruneExpired non-blocking - a slow/hanging prune must not delay isRateLimited
// ---------------------------------------------------------------------------

/**
 * This describe block guards against a future refactor that accidentally adds
 * `await` before `pgPruneExpired()` inside `pgIsRateLimited`.  If that happens,
 * a never-resolving prune query would stall every 5th isRateLimited call
 * indefinitely.  The test enforces a strict 50 ms wall-clock budget.
 */
describe('pgPruneExpired - fire-and-forget: slow prune does not block isRateLimited', () => {
    let randomSpy;

    afterEach(() => {
        randomSpy.mockRestore();
        delete process.env.DATABASE_URL;
        jest.clearAllMocks();
    });

    test('isRateLimited resolves within 50 ms even when the prune query never resolves', async () => {
        // Build a pool where:
        //   • CREATE TABLE  → resolves immediately
        //   • SELECT        → resolves immediately (no row → not rate-limited)
        //   • prune DELETE  → never resolves (simulates a hanging DB connection)
        const hangingPromise = new Promise(() => {}); // intentionally never settles

        const pool = {
            query: jest.fn((sql) => {
                const s = sql.trim();
                if (/CREATE TABLE/i.test(s)) return Promise.resolve({ rows: [] });
                if (/^SELECT/i.test(s))      return Promise.resolve({ rows: [] });
                if (/^DELETE/i.test(s) && /window_start/i.test(s)) return hangingPromise;
                return Promise.resolve({ rows: [] });
            }),
        };

        const pgMockSlow = { Pool: jest.fn(() => pool), _pool: pool };

        // Force the 5 % gate to always fire so pgPruneExpired is always called.
        randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0);

        const rl = loadRateLimiter(pgMockSlow);

        const start = Date.now();
        const result = await rl.isRateLimited('10.2.0.1');
        const elapsed = Date.now() - start;

        expect(result).toBe(false);          // no row → not rate-limited
        expect(elapsed).toBeLessThan(50);    // prune must not have been awaited
    });
});
