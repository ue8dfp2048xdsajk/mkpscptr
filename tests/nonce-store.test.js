/**
 * @jest-environment node
 *
 * Tests for the nonce store (api/_nonce-store.js) covering the PostgreSQL
 * path, Redis path, and retry durability for deleteNonce.
 *
 * Scenarios covered:
 *  1. PG path — isNonceSeen returns false for an unseen nonce
 *  2. PG path — isNonceSeen returns true after recordNonce is called
 *  3. PG path — duplicate nonce is correctly rejected (INSERT ON CONFLICT returns 0 rows)
 *  4. PG path — deleteNonce removes the nonce so it can be re-recorded
 *  5. PG path — isNonceSeen PG error falls back to in-memory gracefully (no crash)
 *  6. PG path — recordNonce PG error FAILS CLOSED (no in-memory fallback) — TOCTOU policy
 *  7. PG path — TOCTOU: PG up for isNonceSeen, down for recordNonce → fail closed (throws)
 *  8. PG path — schema creation (CREATE TABLE IF NOT EXISTS) is issued once per module load
 *  9. PG path — pgRecordNonce issues INSERT … ON CONFLICT DO NOTHING
 * 10. PG path — pgDeleteNonce issues a DELETE query for the correct nonce
 * 11. PG path — deleteNonce retry: transient DEL failure → retry succeeds, nonce cleaned up
 * 12. PG path — deleteNonce retry: webhook retry admitted after cleanup
 * 13. PG path — deleteNonce: all retries exhausted → resolves (logs alert, nonce stranded)
 * 14. Redis path — deleteNonce retry: transient DEL failure → retry succeeds, nonce cleaned up
 * 15. Redis path — deleteNonce retry: webhook retry admitted after cleanup
 * 16. Redis path — deleteNonce: all retries exhausted → resolves (logs alert, nonce stranded)
 */

'use strict';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Load a fresh nonce-store module with a mocked pg Pool.
 *
 * `queryImpl` is the jest.fn() that backs pool.query — callers can chain
 * .mockResolvedValueOnce() calls on it before requiring the module.
 *
 * Returns { store, mockQuery }.
 */
function loadPgStore(queryImpl) {
    jest.resetModules();

    // No Redis — force the PG path
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    process.env.DATABASE_URL = 'postgres://mock/nonce_db';

    const mockQuery = queryImpl || jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });

    jest.doMock('pg', () => ({
        Pool: jest.fn().mockImplementation(() => ({ query: mockQuery })),
    }));

    const store = require('../api/_nonce-store');
    return { store, mockQuery };
}

/**
 * Load a fresh nonce-store module for PG retry tests using _setPgPoolForTest.
 *
 * Unlike loadPgStore, this helper does NOT try to mock the pg module.
 * Instead it uses the store's _setPgPoolForTest export to inject a plain
 * mock pool object after the module is loaded.  pgReady=true skips the
 * ensureSchema calls so the test's mockQuery sequence begins at the first
 * real operation (e.g. the DELETE in deleteNonce).
 *
 * Returns { store, mockQuery }.
 */
function loadPgStoreWithPool(queryImpl, { pgReady = true } = {}) {
    jest.resetModules();

    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    process.env.DATABASE_URL = 'postgres://mock/nonce_db';

    const mockQuery = queryImpl || jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const store = require('../api/_nonce-store');
    store._setPgPoolForTest({ query: mockQuery }, pgReady);
    return { store, mockQuery };
}

// ---------------------------------------------------------------------------
// 1. PG path — basic unit tests
// ---------------------------------------------------------------------------

describe('_nonce-store — PostgreSQL path (mocked pg Pool)', () => {
    let store;
    let mockQuery;

    beforeEach(() => {
        ({ store, mockQuery } = loadPgStore());
    });

    afterEach(() => {
        delete process.env.DATABASE_URL;
        jest.clearAllMocks();
    });

    // -----------------------------------------------------------------------
    // isNonceSeen
    // -----------------------------------------------------------------------

    test('isNonceSeen returns false when no row exists for the nonce', async () => {
        // ensureSchema issues TWO queries: CREATE TABLE + ALTER TABLE (idempotent column add).
        // Call 1: CREATE TABLE
        // Call 2: ALTER TABLE
        // Call 3: SELECT → no rows
        mockQuery
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // CREATE TABLE
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // ALTER TABLE
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // SELECT
        expect(await store.isNonceSeen('pg-fresh-nonce')).toBe(false);
    });

    test('isNonceSeen returns true when a matching unexpired row exists', async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [], rowCount: 0 })             // CREATE TABLE
            .mockResolvedValueOnce({ rows: [], rowCount: 0 })             // ALTER TABLE
            .mockResolvedValueOnce({ rows: [{ '?column?': 1 }], rowCount: 1 }); // SELECT hit
        expect(await store.isNonceSeen('pg-seen-nonce')).toBe(true);
    });

    test('isNonceSeen returns false for an expired nonce (no row returned by the WHERE clause)', async () => {
        // The WHERE clause filters out expired rows; an expired nonce returns no rows.
        mockQuery
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // CREATE TABLE
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // ALTER TABLE
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // SELECT — expired, filtered out
        expect(await store.isNonceSeen('pg-expired-nonce')).toBe(false);
    });

    // -----------------------------------------------------------------------
    // recordNonce
    // -----------------------------------------------------------------------

    test('recordNonce resolves without throwing for a new nonce', async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // CREATE TABLE
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // ALTER TABLE
            .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // INSERT → 1 row inserted
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // DELETE (prune expired)
        await expect(store.recordNonce('pg-new-nonce')).resolves.toBeUndefined();
    });

    test('recordNonce throws "Duplicate nonce" when INSERT ON CONFLICT returns rowCount 0', async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // CREATE TABLE
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // ALTER TABLE
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // INSERT → 0 rows (conflict)
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // DELETE (prune expired)
        await expect(store.recordNonce('pg-dup-nonce')).rejects.toThrow(/Duplicate nonce/i);
    });

    test('duplicate nonce is rejected end-to-end via the PG path', async () => {
        // ensureSchema runs once (CREATE TABLE + ALTER TABLE); subsequent calls skip it.
        // First recordNonce: CREATE TABLE, ALTER TABLE, INSERT (rowCount 1), DELETE prune.
        // Second recordNonce: ensureSchema skipped (_pgReady=true), INSERT (rowCount 0), DELETE prune.
        mockQuery
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // CREATE TABLE
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // ALTER TABLE
            .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // INSERT → first nonce inserted
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // DELETE (prune expired)
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // INSERT → duplicate
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // DELETE (prune expired)
        await store.recordNonce('pg-e2e-dup-nonce');
        await expect(store.recordNonce('pg-e2e-dup-nonce')).rejects.toThrow(/Duplicate nonce/i);
    });

    // -----------------------------------------------------------------------
    // deleteNonce
    // -----------------------------------------------------------------------

    test('deleteNonce resolves without throwing', async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // CREATE TABLE
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // ALTER TABLE
            .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // DELETE
        await expect(store.deleteNonce('pg-del-nonce')).resolves.toBeUndefined();
    });

    test('deleteNonce on an unknown nonce does not throw', async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // CREATE TABLE
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // ALTER TABLE
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // DELETE — 0 rows affected
        await expect(store.deleteNonce('pg-del-unknown')).resolves.toBeUndefined();
    });

    // -----------------------------------------------------------------------
    // SQL shape checks
    // -----------------------------------------------------------------------

    test('recordNonce issues an INSERT … ON CONFLICT DO NOTHING query', async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // CREATE TABLE
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // ALTER TABLE
            .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // INSERT
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // DELETE (prune expired)
        await store.recordNonce('pg-sql-check-nonce');

        const sqlCalls = mockQuery.mock.calls.map(c => c[0]);
        expect(sqlCalls.some(q => /INSERT INTO nonce_seen/i.test(q))).toBe(true);
        expect(sqlCalls.some(q => /ON CONFLICT.*DO NOTHING/i.test(q))).toBe(true);
    });

    test('recordNonce issues a DELETE to prune expired rows on every write', async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // CREATE TABLE
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // ALTER TABLE
            .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // INSERT
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // DELETE (prune expired)
        await store.recordNonce('pg-prune-check-nonce');

        const sqlCalls = mockQuery.mock.calls.map(c => c[0]);
        expect(sqlCalls.some(q => /DELETE FROM nonce_seen WHERE expires_at/i.test(q))).toBe(true);
    });

    test('recordNonce prunes on duplicate writes too (prune fires even when INSERT is a no-op)', async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // CREATE TABLE
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // ALTER TABLE
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // INSERT → conflict (0 rows)
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // DELETE (prune expired)
        // recordNonce throws for duplicates — we only care that the prune DELETE was issued
        await expect(store.recordNonce('pg-prune-dup-nonce')).rejects.toThrow(/Duplicate nonce/i);

        const sqlCalls = mockQuery.mock.calls.map(c => c[0]);
        expect(sqlCalls.some(q => /DELETE FROM nonce_seen WHERE expires_at/i.test(q))).toBe(true);
    });

    test('isNonceSeen does NOT issue a prune DELETE (pruning moved to write path)', async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // CREATE TABLE
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // ALTER TABLE
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // SELECT
        await store.isNonceSeen('pg-no-prune-on-read');

        const sqlCalls = mockQuery.mock.calls.map(c => c[0]);
        expect(sqlCalls.some(q => /DELETE FROM nonce_seen WHERE expires_at/i.test(q))).toBe(false);
    });

    test('expired nonce rows are not returned by isNonceSeen (WHERE expires_at > now filters them)', async () => {
        // Simulate: nonce was written with an expires_at in the past; the SELECT
        // WHERE expires_at > $2 returns no rows — the nonce appears unseen even
        // without an explicit DELETE, and the prune on the next write will clean it up.
        mockQuery
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // CREATE TABLE
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // ALTER TABLE
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // SELECT — expired row filtered by WHERE clause
        expect(await store.isNonceSeen('pg-expired-prune-nonce')).toBe(false);

        // Confirm the SELECT used the expires_at filter (not just the nonce equality).
        const selectCall = mockQuery.mock.calls.find(c => /SELECT/i.test(c[0]));
        expect(selectCall).toBeDefined();
        expect(selectCall[0]).toMatch(/expires_at/i);
    });

    test('deleteNonce issues a DELETE FROM nonce_seen WHERE nonce = query', async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // CREATE TABLE
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // ALTER TABLE
            .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // DELETE
        await store.deleteNonce('pg-sql-del-nonce');

        const sqlCalls = mockQuery.mock.calls.map(c => c[0]);
        expect(sqlCalls.some(q => /DELETE FROM nonce_seen WHERE nonce/i.test(q))).toBe(true);
    });

    test('isNonceSeen queries nonce_seen with a nonce = $1 AND expires_at > $2 filter', async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // CREATE TABLE
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // ALTER TABLE
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // SELECT
        await store.isNonceSeen('pg-sql-select-nonce');

        const sqlCalls = mockQuery.mock.calls.map(c => c[0]);
        expect(sqlCalls.some(q => /nonce_seen/i.test(q) && /expires_at/i.test(q))).toBe(true);
    });

    test('ensureSchema runs CREATE TABLE IF NOT EXISTS nonce_seen only once across multiple calls', async () => {
        // Three operations — schema creation should appear exactly once.
        mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });
        await store.recordNonce('pg-schema-once-a');
        await store.recordNonce('pg-schema-once-b');

        const createCalls = mockQuery.mock.calls.filter(c =>
            /CREATE TABLE IF NOT EXISTS nonce_seen/i.test(c[0])
        );
        expect(createCalls).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// 2. PG write error → fail closed (TOCTOU policy)
// ---------------------------------------------------------------------------
//
// POLICY: recordNonce() must NOT fall back to in-memory when PG is configured.
//
// isNonceSeen() reads from PG.  If that read succeeds (returns false) but the
// subsequent INSERT fails and falls back to in-memory, a concurrent serverless
// instance cannot see the in-memory write.  A replay of the original request
// on another instance would pass the duplicate check and succeed — the same
// TOCTOU window that the Redis path guards against by failing closed.
//
// The PG path applies the same policy: when pgRecordNonce() throws for any
// reason other than a duplicate-nonce conflict, recordNonce() re-throws so
// the caller receives a 500.  No nonce is committed to any store, so a safe
// retry is possible once PG recovers.
//
// isNonceSeen() and deleteNonce() continue to fall back gracefully because
// they do not create the read/write store-split.

describe('_nonce-store — PG write errors fail closed (TOCTOU policy)', () => {
    afterEach(() => {
        delete process.env.DATABASE_URL;
        jest.clearAllMocks();
    });

    test('isNonceSeen does not throw when PG SELECT fails — returns false (in-memory fallback ok for reads)', async () => {
        const q = jest.fn()
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // CREATE TABLE succeeds
            .mockRejectedValue(new Error('PG connection lost'));
        const { store } = loadPgStore(q);
        await expect(store.isNonceSeen('pg-err-fresh')).resolves.toBe(false);
    });

    test('recordNonce THROWS when PG INSERT fails — fails closed, no in-memory fallback', async () => {
        // Schema creation succeeds; INSERT rejects — simulates PG down mid-request.
        const q = jest.fn()
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // CREATE TABLE succeeds
            .mockRejectedValue(new Error('PG connection lost'));
        const { store } = loadPgStore(q);
        await expect(store.recordNonce('pg-err-record')).rejects.toThrow(/PG recordNonce failed/i);
    });

    test('deleteNonce does not throw when PG DELETE fails — falls back to in-memory no-op', async () => {
        const q = jest.fn()
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // CREATE TABLE succeeds
            .mockRejectedValue(new Error('PG connection lost'));
        const { store } = loadPgStore(q);
        await expect(store.deleteNonce('pg-err-delete')).resolves.toBeUndefined();
    });

    // -----------------------------------------------------------------------
    // TOCTOU scenario — PG up for reads, down for writes
    // -----------------------------------------------------------------------
    //
    // This test documents the exact mid-request failure case described in the
    // task: isNonceSeen succeeds against PG (returns false), then PG goes down
    // and recordNonce's INSERT fails.  The correct behaviour is to fail closed:
    // recordNonce throws, the caller receives a 500, and no nonce is committed
    // to any store.  A replay on a different serverless instance therefore
    // cannot succeed because the nonce was never persisted.

    test('TOCTOU: PG up for isNonceSeen but down for recordNonce — recordNonce fails closed', async () => {
        // Exact mid-request failure: PG responds to the SELECT (read) but then
        // goes down before the INSERT (write).
        //
        // ensureSchema issues TWO queries on first call: CREATE TABLE + ALTER TABLE.
        // On subsequent calls _pgReady=true so ensureSchema is a no-op.
        //
        // Calls in order:
        //   1. CREATE TABLE      → succeeds (ensureSchema, first query)
        //   2. ALTER TABLE       → succeeds (ensureSchema, second query)
        //   3. SELECT            → succeeds, returns 0 rows (nonce unseen) — PG is up
        //   4. INSERT            → throws (PG went down mid-request)
        //   5+. any further PG  → throws (PG still down — in-memory fallback for isNonceSeen)
        const q = jest.fn()
            .mockResolvedValueOnce({ rows: [], rowCount: 0 })              // 1. CREATE TABLE
            .mockResolvedValueOnce({ rows: [], rowCount: 0 })              // 2. ALTER TABLE
            .mockResolvedValueOnce({ rows: [], rowCount: 0 })              // 3. SELECT → not seen
            .mockRejectedValue(new Error('connection terminated unexpectedly')); // 4+. PG down

        const { store } = loadPgStore(q);

        // Step A: read succeeds — PG correctly reports the nonce as unseen.
        const seen = await store.isNonceSeen('toctou-nonce');
        expect(seen).toBe(false);

        // Step B: write fails — PG went down between the read and the write.
        // Policy: fail closed.  A 500 is safer than a cross-instance split where
        // one instance records in-memory and a concurrent instance never sees it.
        await expect(store.recordNonce('toctou-nonce')).rejects.toThrow(/PG recordNonce failed/i);

        // Step C: confirm the nonce was NOT silently committed to in-memory.
        // isNonceSeen() falls back to in-memory when PG is still down.  The
        // in-memory store must be empty because recordNonce failed closed and
        // never wrote anything — so a replay on any other instance would also
        // find an empty in-memory store and still be blocked by the fail-closed
        // recordNonce on that instance too.
        const seenAfter = await store.isNonceSeen('toctou-nonce');
        expect(seenAfter).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// 3. PG path preferred over in-memory when DATABASE_URL is set (no Redis)
// ---------------------------------------------------------------------------

describe('_nonce-store — PG path is selected when DATABASE_URL is set and Redis is absent', () => {
    let store;
    let mockQuery;

    beforeEach(() => {
        ({ store, mockQuery } = loadPgStore());
        // Default mockQuery returns { rows: [], rowCount: 1 } for everything
        mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });
    });

    afterEach(() => {
        delete process.env.DATABASE_URL;
        jest.clearAllMocks();
    });

    test('recordNonce calls pool.query (not just in-memory) when PG is configured', async () => {
        await store.recordNonce('pg-preferred-nonce');
        // At minimum: CREATE TABLE + INSERT
        expect(mockQuery).toHaveBeenCalled();
    });

    test('isNonceSeen calls pool.query (not just in-memory) when PG is configured', async () => {
        mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
        await store.isNonceSeen('pg-preferred-seen');
        expect(mockQuery).toHaveBeenCalled();
    });

    test('deleteNonce calls pool.query (not just in-memory) when PG is configured', async () => {
        await store.deleteNonce('pg-preferred-del');
        expect(mockQuery).toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// 4. Redis credentials present → PG path is NOT used (Redis takes priority)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 5. deleteNonce retry durability — PG backend
// ---------------------------------------------------------------------------
//
// deleteNonce wraps pgDeleteNonce in withRetry (up to 3 attempts, 100 ms
// base back-off).  These tests verify that a transient failure on the first
// attempt does not strand the nonce: the second attempt succeeds and the nonce
// is cleaned up so Stripe's webhook retry can be re-admitted.
//
// Implementation note: these tests use loadPgStoreWithPool (which calls
// store._setPgPoolForTest) instead of loadPgStore.  loadPgStore relies on
// jest.doMock('pg', …) which does not survive jest.resetModules() in Jest 30,
// causing the real pg Pool to be used and all DELETE calls to fail with
// getaddrinfo ENOTFOUND.  _setPgPoolForTest injects a plain mock pool object
// directly into the module after it loads, bypassing the module-mock issue.
//
// With pgReady=true, ensureSchema is a no-op and the mock sequence starts
// at the first real operation (the DELETE inside pgDeleteNonce), keeping the
// query sequences short and focused on the retry behaviour.

describe('_nonce-store — deleteNonce retry durability (PG backend)', () => {
    afterEach(() => {
        delete process.env.DATABASE_URL;
        jest.clearAllMocks();
    });

    test('deleteNonce succeeds after one transient PG failure (retry on second attempt)', async () => {
        // pgReady=true → ensureSchema is a no-op; mock starts at first DELETE.
        // Query sequence:
        //   1. DELETE nonce — attempt 1 → transient connection error
        //   2. DELETE nonce — attempt 2 (retry) → succeeds
        const q = jest.fn()
            .mockRejectedValueOnce(new Error('connection reset by peer')) // 1. DEL attempt 1
            .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // 2. DEL attempt 2 (retry)

        const { store } = loadPgStoreWithPool(q, { pgReady: true });

        // Must resolve — the retry succeeded and the nonce is cleaned up
        await expect(store.deleteNonce('retry-nonce-pg')).resolves.toBeUndefined();

        // The DELETE nonce query must have been issued exactly twice
        const deleteCalls = q.mock.calls.filter(([sql]) =>
            /DELETE FROM nonce_seen WHERE nonce/i.test(sql)
        );
        expect(deleteCalls).toHaveLength(2);
    });

    test('after deleteNonce retry success the nonce can be re-recorded (webhook retry admitted)', async () => {
        // Full webhook retry flow (pgReady=true — schema assumed ready):
        //   Phase 1 — first Stripe delivery: recordNonce succeeds
        //   Phase 2 — handler work fails: deleteNonce called to release the nonce
        //             ↳ DEL attempt 1 → transient PG error
        //             ↳ DEL attempt 2 → succeeds (nonce removed from store)
        //   Phase 3 — Stripe retries: second recordNonce must succeed
        //
        // Query sequence (no ensureSchema calls — pgReady=true):
        //   1. INSERT nonce_seen      → rowCount 1   (first recordNonce OK)
        //   2. DELETE WHERE expires_at               (pgPruneExpired)
        //   3. DELETE WHERE nonce = $1 → reject      (deleteNonce attempt 1)
        //   4. DELETE WHERE nonce = $1 → rowCount 1  (deleteNonce attempt 2)
        //   5. INSERT nonce_seen      → rowCount 1   (second recordNonce — retry admitted)
        //   6. DELETE WHERE expires_at               (pgPruneExpired)
        const q = jest.fn()
            .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // 1. INSERT (first record)
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // 2. prune DELETE
            .mockRejectedValueOnce(new Error('connection reset by peer')) // 3. deleteNonce attempt 1
            .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // 4. deleteNonce attempt 2
            .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // 5. INSERT (second record)
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // 6. prune DELETE

        const { store } = loadPgStoreWithPool(q, { pgReady: true });

        // Phase 1: first webhook delivery records the nonce
        await expect(store.recordNonce('webhook-retry-nonce-pg')).resolves.toBeUndefined();

        // Phase 2: handler fails; deleteNonce released via retry
        await expect(store.deleteNonce('webhook-retry-nonce-pg')).resolves.toBeUndefined();

        // Phase 3: Stripe retries — second recordNonce must not throw
        await expect(store.recordNonce('webhook-retry-nonce-pg')).resolves.toBeUndefined();
    });

    test('deleteNonce resolves (logs alert) when all PG retry attempts are exhausted', async () => {
        // All three DELETE attempts fail permanently.  deleteNonce must NOT throw:
        // it logs an [ALERT] and returns gracefully so the caller can still
        // respond to Stripe.  The nonce is left in the store (stranded) until TTL.
        const q = jest.fn()
            .mockRejectedValue(new Error('PG completely down')); // all DEL attempts

        const { store } = loadPgStoreWithPool(q, { pgReady: true });
        await expect(store.deleteNonce('stranded-nonce-pg')).resolves.toBeUndefined();

        // withRetry exhausts all 3 attempts before giving up
        const deleteCalls = q.mock.calls.filter(([sql]) =>
            /DELETE FROM nonce_seen WHERE nonce/i.test(sql)
        );
        expect(deleteCalls).toHaveLength(3);
    });
});

// ---------------------------------------------------------------------------
// 6. deleteNonce retry durability — Redis backend
// ---------------------------------------------------------------------------
//
// deleteNonce wraps redisDel in withRetry (up to 3 attempts).  These tests
// verify the same retry-durability guarantee for the Redis (Upstash) path.
//
// The Redis path uses global.fetch directly (no pg module mock needed), so
// the simpler loadRedisStore helper (jest.resetModules + env var setup) works.

function loadRedisStore(fetchImpl) {
    jest.resetModules();

    process.env.UPSTASH_REDIS_REST_URL   = 'https://fake-redis.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
    delete process.env.DATABASE_URL;

    const fetchMock = fetchImpl || jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ result: 'OK' }),
    });
    global.fetch = fetchMock;

    const store = require('../api/_nonce-store');
    return { store, fetchMock };
}

describe('_nonce-store — deleteNonce retry durability (Redis backend)', () => {
    let originalFetch;

    beforeEach(() => {
        originalFetch = global.fetch;
    });

    afterEach(() => {
        global.fetch = originalFetch;
        delete process.env.UPSTASH_REDIS_REST_URL;
        delete process.env.UPSTASH_REDIS_REST_TOKEN;
        jest.clearAllMocks();
    });

    test('deleteNonce succeeds after one transient Redis DEL failure (retry on second attempt)', async () => {
        // fetch call sequence for deleteNonce:
        //   1. POST /del — non-ok 503 → redisDel throws (attempt 1)
        //   2. POST /del — ok 200     → redisDel resolves (attempt 2 / retry)
        const fetchMock = jest.fn()
            .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) }) // attempt 1
            .mockResolvedValueOnce({ ok: true, json: async () => ({ result: 1 }) });   // attempt 2

        const { store } = loadRedisStore(fetchMock);
        await expect(store.deleteNonce('retry-nonce-redis')).resolves.toBeUndefined();

        // The /del/ endpoint must have been called exactly twice (two DEL attempts)
        const delCalls = fetchMock.mock.calls.filter(([url]) => /\/del\//i.test(url));
        expect(delCalls).toHaveLength(2);
    });

    test('after Redis deleteNonce retry success the nonce can be re-recorded (webhook retry admitted)', async () => {
        // Full webhook retry flow:
        //   Phase 1 — recordNonce  → SET NX → "OK"   (first webhook attempt)
        //   Phase 2 — deleteNonce  → DEL attempt 1 → transient 503
        //                            DEL attempt 2 → succeeds
        //   Phase 3 — recordNonce  → SET NX → "OK"   (Stripe retry admitted)
        //
        // fetch call sequence:
        //   1. POST /set (SET NX)  → { result: "OK" }   — first recordNonce
        //   2. POST /del           → { ok: false, 503 } — deleteNonce attempt 1
        //   3. POST /del           → { ok: true }        — deleteNonce attempt 2
        //   4. POST /set (SET NX)  → { result: "OK" }   — second recordNonce (retry)
        const fetchMock = jest.fn()
            .mockResolvedValueOnce({ ok: true, json: async () => ({ result: 'OK' }) })  // 1. SET NX
            .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) })  // 2. DEL attempt 1
            .mockResolvedValueOnce({ ok: true, json: async () => ({ result: 1 }) })     // 3. DEL attempt 2
            .mockResolvedValueOnce({ ok: true, json: async () => ({ result: 'OK' }) }); // 4. SET NX retry

        const { store } = loadRedisStore(fetchMock);

        // Phase 1: first webhook delivery records the nonce
        await expect(store.recordNonce('webhook-retry-nonce-redis')).resolves.toBeUndefined();

        // Phase 2: handler fails; deleteNonce released via retry
        await expect(store.deleteNonce('webhook-retry-nonce-redis')).resolves.toBeUndefined();

        // Phase 3: Stripe retries — second recordNonce must not throw
        await expect(store.recordNonce('webhook-retry-nonce-redis')).resolves.toBeUndefined();
    });

    test('deleteNonce resolves (logs alert) when all Redis retry attempts are exhausted', async () => {
        // All three DEL attempts return 503 — nonce is stranded but deleteNonce
        // must NOT throw; it logs [ALERT] and returns gracefully.
        const fetchMock = jest.fn()
            .mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });

        const { store } = loadRedisStore(fetchMock);
        await expect(store.deleteNonce('stranded-nonce-redis')).resolves.toBeUndefined();

        // withRetry must have exhausted all 3 DEL attempts before giving up
        const delCalls = fetchMock.mock.calls.filter(([url]) => /\/del\//i.test(url));
        expect(delCalls).toHaveLength(3);
    });
});

describe('_nonce-store — Redis takes priority over PG when both are configured', () => {
    let store;
    let mockQuery;
    let fetchMock;

    beforeEach(() => {
        jest.resetModules();
        process.env.UPSTASH_REDIS_REST_URL   = 'https://fake-redis.upstash.io';
        process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
        process.env.DATABASE_URL = 'postgres://mock/nonce_db';

        mockQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
        jest.doMock('pg', () => ({
            Pool: jest.fn().mockImplementation(() => ({ query: mockQuery })),
        }));

        fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ result: 'OK' }),
        });
        global.fetch = fetchMock;

        store = require('../api/_nonce-store');
    });

    afterEach(() => {
        delete process.env.UPSTASH_REDIS_REST_URL;
        delete process.env.UPSTASH_REDIS_REST_TOKEN;
        delete process.env.DATABASE_URL;
        jest.clearAllMocks();
    });

    test('recordNonce uses Redis fetch (not pg.query) when Redis is configured', async () => {
        await store.recordNonce('redis-priority-nonce');
        expect(fetchMock).toHaveBeenCalled();
        expect(mockQuery).not.toHaveBeenCalled();
    });

    test('isNonceSeen uses Redis fetch (not pg.query) when Redis is configured', async () => {
        // EXISTS returns 0 (unseen)
        fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ result: 0 }) });
        await store.isNonceSeen('redis-priority-check');
        expect(fetchMock).toHaveBeenCalled();
        expect(mockQuery).not.toHaveBeenCalled();
    });
});
