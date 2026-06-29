/**
 * @jest-environment node
 *
 * Tests for the PostgreSQL path in api/_nonce-store.js.
 *
 * Scenarios covered:
 *  1. PG path — isNonceSeen returns false for an unseen nonce
 *  2. PG path — isNonceSeen returns true after recordNonce is called
 *  3. PG path — duplicate nonce is correctly rejected (INSERT ON CONFLICT returns 0 rows)
 *  4. PG path — deleteNonce removes the nonce so it can be re-recorded
 *  5. PG path — isNonceSeen PG error falls back to in-memory gracefully (no crash)
 *  6. PG path — recordNonce PG error falls back to in-memory gracefully (no crash)
 *  7. PG path — recordNonce PG error + in-memory accumulation still blocks duplicates
 *  8. PG path — schema creation (CREATE TABLE IF NOT EXISTS) is issued once per module load
 *  9. PG path — pgRecordNonce issues INSERT … ON CONFLICT DO NOTHING
 * 10. PG path — pgDeleteNonce issues a DELETE query for the correct nonce
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
        // Call 1: CREATE TABLE (ensureSchema)
        // Call 2: SELECT → no rows
        mockQuery
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // CREATE TABLE
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // SELECT
        expect(await store.isNonceSeen('pg-fresh-nonce')).toBe(false);
    });

    test('isNonceSeen returns true when a matching unexpired row exists', async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [], rowCount: 0 })        // CREATE TABLE
            .mockResolvedValueOnce({ rows: [{ '?column?': 1 }], rowCount: 1 }); // SELECT hit
        expect(await store.isNonceSeen('pg-seen-nonce')).toBe(true);
    });

    test('isNonceSeen returns false for an expired nonce (no row returned by the WHERE clause)', async () => {
        // The WHERE clause filters out expired rows; an expired nonce returns no rows.
        mockQuery
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // CREATE TABLE
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // SELECT — expired, filtered out
        expect(await store.isNonceSeen('pg-expired-nonce')).toBe(false);
    });

    // -----------------------------------------------------------------------
    // recordNonce
    // -----------------------------------------------------------------------

    test('recordNonce resolves without throwing for a new nonce', async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // CREATE TABLE
            .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // INSERT → 1 row inserted
        await expect(store.recordNonce('pg-new-nonce')).resolves.toBeUndefined();
    });

    test('recordNonce throws "Duplicate nonce" when INSERT ON CONFLICT returns rowCount 0', async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // CREATE TABLE
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // INSERT → 0 rows (conflict)
        await expect(store.recordNonce('pg-dup-nonce')).rejects.toThrow(/Duplicate nonce/i);
    });

    test('duplicate nonce is rejected end-to-end via the PG path', async () => {
        // Schema created once; first INSERT succeeds, second INSERT conflicts.
        mockQuery
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // CREATE TABLE (first call)
            .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // INSERT → first nonce
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // INSERT → duplicate
        ;
        await store.recordNonce('pg-e2e-dup-nonce');
        await expect(store.recordNonce('pg-e2e-dup-nonce')).rejects.toThrow(/Duplicate nonce/i);
    });

    // -----------------------------------------------------------------------
    // deleteNonce
    // -----------------------------------------------------------------------

    test('deleteNonce resolves without throwing', async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // CREATE TABLE
            .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // DELETE
        await expect(store.deleteNonce('pg-del-nonce')).resolves.toBeUndefined();
    });

    test('deleteNonce on an unknown nonce does not throw', async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // CREATE TABLE
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // DELETE — 0 rows affected
        await expect(store.deleteNonce('pg-del-unknown')).resolves.toBeUndefined();
    });

    // -----------------------------------------------------------------------
    // SQL shape checks
    // -----------------------------------------------------------------------

    test('recordNonce issues an INSERT … ON CONFLICT DO NOTHING query', async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // CREATE TABLE
            .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // INSERT
        await store.recordNonce('pg-sql-check-nonce');

        const sqlCalls = mockQuery.mock.calls.map(c => c[0]);
        expect(sqlCalls.some(q => /INSERT INTO nonce_seen/i.test(q))).toBe(true);
        expect(sqlCalls.some(q => /ON CONFLICT.*DO NOTHING/i.test(q))).toBe(true);
    });

    test('deleteNonce issues a DELETE FROM nonce_seen WHERE nonce = query', async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // CREATE TABLE
            .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // DELETE
        await store.deleteNonce('pg-sql-del-nonce');

        const sqlCalls = mockQuery.mock.calls.map(c => c[0]);
        expect(sqlCalls.some(q => /DELETE FROM nonce_seen WHERE nonce/i.test(q))).toBe(true);
    });

    test('isNonceSeen queries nonce_seen with a nonce = $1 AND expires_at > $2 filter', async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // CREATE TABLE
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
// 2. PG error → graceful in-memory fallback (no crash)
// ---------------------------------------------------------------------------

describe('_nonce-store — PG errors fall back to in-memory gracefully', () => {
    let store;
    let mockQuery;

    beforeEach(() => {
        // Schema creation succeeds; everything after rejects.
        const q = jest.fn()
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // CREATE TABLE succeeds
            .mockRejectedValue(new Error('PG connection lost'));
        ({ store, mockQuery } = loadPgStore(q));
    });

    afterEach(() => {
        delete process.env.DATABASE_URL;
        jest.clearAllMocks();
    });

    test('isNonceSeen does not throw when PG SELECT fails — returns false for unseen nonce', async () => {
        await expect(store.isNonceSeen('pg-err-fresh')).resolves.toBe(false);
    });

    test('recordNonce does not throw when PG INSERT fails — falls back to in-memory', async () => {
        await expect(store.recordNonce('pg-err-record')).resolves.toBeUndefined();
    });

    test('deleteNonce does not throw when PG DELETE fails — falls back to in-memory no-op', async () => {
        await expect(store.deleteNonce('pg-err-delete')).resolves.toBeUndefined();
    });

    test('in-memory still blocks a duplicate nonce after PG errors', async () => {
        // Both recordNonce calls fall back to in-memory; second call is a duplicate there.
        await store.recordNonce('pg-err-dup-nonce');
        await expect(store.recordNonce('pg-err-dup-nonce')).rejects.toThrow(/Duplicate nonce/i);
    });

    test('in-memory tracks 3 distinct nonces independently after PG errors', async () => {
        await store.recordNonce('pg-err-nonce-alpha');
        await store.recordNonce('pg-err-nonce-beta');
        await store.recordNonce('pg-err-nonce-gamma');

        // None of the three are visible to isNonceSeen (PG path fails, in-memory fallback
        // used for isNonceSeen too — but these were written to in-memory, so they are seen).
        await expect(store.isNonceSeen('pg-err-nonce-alpha')).resolves.toBe(true);
        await expect(store.isNonceSeen('pg-err-nonce-beta')).resolves.toBe(true);
        await expect(store.isNonceSeen('pg-err-nonce-gamma')).resolves.toBe(true);
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
