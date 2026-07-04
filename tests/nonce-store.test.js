/**
 * @jest-environment node
 *
 * Tests for the nonce store (api/_nonce-store.js), which is backed
 * exclusively by MongoDB - see the "Consolidate nonce store onto MongoDB"
 * plan. There is deliberately no Redis/Postgres/in-memory-fallback matrix
 * here anymore: Mongo is already a hard requirement for the whole
 * payment-to-plan pipeline (customers / idempotency_keys collections), so
 * there is only one backend to test.
 *
 * Covered:
 *  1. isNonceSeen - fresh vs. seen nonce
 *  2. recordNonce - first call succeeds, second call for the same nonce
 *     throws "Duplicate nonce" (simulating MongoDB's unique _id constraint,
 *     error code 11000)
 *  3. recordNonce - stores userId/plan alongside the nonce
 *  4. deleteNonce - removes a nonce so it can be re-recorded; no-op on an
 *     unknown nonce; retries on transient failure and logs [ALERT] if it
 *     never succeeds
 *  5. deleteNonceByUserPlan - deletes by userId+plan, returns count
 *  6. TTL index - created once via createIndex({ createdAt: 1 }, { expireAfterSeconds })
 *  7. Mongo unreachable - recordNonce fails closed (throws); isNonceSeen
 *     fails open (returns false, since recordNonce's unique index is the
 *     actual replay guard)
 */

'use strict';

const { makeFakeDb, makeUnreachableDb } = require('./_helpers/mongo-mock');

function loadStoreWithDb(getDbImpl) {
    jest.resetModules();
    jest.doMock('../api/_db', () => ({ getDb: getDbImpl }));
    return require('../api/_nonce-store');
}

describe('_nonce-store (MongoDB) - isNonceSeen / recordNonce', () => {
    let store, fakeDb;

    beforeEach(() => {
        fakeDb = makeFakeDb();
        store = loadStoreWithDb(async () => fakeDb);
    });

    test('isNonceSeen returns false for a fresh nonce', async () => {
        expect(await store.isNonceSeen('brand-new-nonce-1')).toBe(false);
    });

    test('isNonceSeen returns true after recordNonce is called', async () => {
        const nonce = 'fresh-nonce-2';
        expect(await store.isNonceSeen(nonce)).toBe(false);
        await store.recordNonce(nonce);
        expect(await store.isNonceSeen(nonce)).toBe(true);
    });

    test('recordNonce resolves without throwing for a new nonce', async () => {
        await expect(store.recordNonce('new-nonce')).resolves.toBeUndefined();
    });

    test('recordNonce throws "Duplicate nonce" on the second call with the same nonce', async () => {
        const nonce = 'dup-nonce-3';
        await store.recordNonce(nonce);
        await expect(store.recordNonce(nonce)).rejects.toThrow(/Duplicate nonce/i);
    });

    test('different nonces can each be recorded independently', async () => {
        await store.recordNonce('alpha-nonce');
        await store.recordNonce('beta-nonce');
        expect(await store.isNonceSeen('alpha-nonce')).toBe(true);
        expect(await store.isNonceSeen('beta-nonce')).toBe(true);
        expect(await store.isNonceSeen('gamma-nonce')).toBe(false);
    });

    test('recordNonce stores userId and plan alongside the nonce document', async () => {
        await store.recordNonce('meta-nonce', 'user_abc', 'pro');
        const doc = await fakeDb.collection('nonce_seen').findOne({ _id: 'meta-nonce' });
        expect(doc).toMatchObject({ _id: 'meta-nonce', userId: 'user_abc', plan: 'pro' });
        expect(doc.createdAt).toBeInstanceOf(Date);
    });

    test('recordNonce defaults userId/plan to null when not provided', async () => {
        await store.recordNonce('no-meta-nonce');
        const doc = await fakeDb.collection('nonce_seen').findOne({ _id: 'no-meta-nonce' });
        expect(doc.userId).toBeNull();
        expect(doc.plan).toBeNull();
    });
});

describe('_nonce-store (MongoDB) - deleteNonce', () => {
    let store, fakeDb;

    beforeEach(() => {
        fakeDb = makeFakeDb();
        store = loadStoreWithDb(async () => fakeDb);
    });

    test('deleteNonce removes a recorded nonce so it can be re-recorded', async () => {
        const nonce = 'delete-nonce-1';
        await store.recordNonce(nonce);
        expect(await store.isNonceSeen(nonce)).toBe(true);
        await store.deleteNonce(nonce);
        expect(await store.isNonceSeen(nonce)).toBe(false);
        await expect(store.recordNonce(nonce)).resolves.toBeUndefined();
        expect(await store.isNonceSeen(nonce)).toBe(true);
    });

    test('deleteNonce on an unknown nonce does not throw', async () => {
        await expect(store.deleteNonce('never-recorded-nonce')).resolves.toBeUndefined();
    });

    test('deleteNonce retries on transient failure and eventually succeeds', async () => {
        const nonce = 'retry-nonce';
        await store.recordNonce(nonce);

        let attempts = 0;
        const realDeleteOne = fakeDb.collection('nonce_seen').deleteOne.bind(fakeDb.collection('nonce_seen'));
        fakeDb.collection('nonce_seen').deleteOne = async (filter) => {
            attempts++;
            if (attempts < 2) throw new Error('transient Mongo blip');
            return realDeleteOne(filter);
        };

        await store.deleteNonce(nonce);
        expect(attempts).toBe(2);
        expect(await store.isNonceSeen(nonce)).toBe(false);
    });

    test('deleteNonce logs [ALERT] and does not throw when Mongo is permanently unreachable', async () => {
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

        const brokenStore = loadStoreWithDb(makeUnreachableDb('Mongo down for delete'));
        await expect(brokenStore.deleteNonce('doomed-nonce', { userId: 'user_x', plan: 'pro' }))
            .resolves.toBeUndefined();

        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('[ALERT]'));
        expect(errorSpy.mock.calls[0][0]).toMatch(/doomed-nonce/);
        expect(errorSpy.mock.calls[0][0]).toMatch(/user_x/);

        errorSpy.mockRestore();
        warnSpy.mockRestore();
    });
});

describe('_nonce-store (MongoDB) - deleteNonceByUserPlan', () => {
    let store, fakeDb;

    beforeEach(() => {
        fakeDb = makeFakeDb();
        store = loadStoreWithDb(async () => fakeDb);
    });

    test('deletes the nonce matching userId+plan and returns 1', async () => {
        await store.recordNonce('up-nonce-1', 'user_1', 'starter');
        const deleted = await store.deleteNonceByUserPlan('user_1', 'starter');
        expect(deleted).toBe(1);
        expect(await store.isNonceSeen('up-nonce-1')).toBe(false);
    });

    test('returns 0 when no nonce matches the given userId+plan', async () => {
        await store.recordNonce('up-nonce-2', 'user_2', 'pro');
        const deleted = await store.deleteNonceByUserPlan('user_nobody', 'pro');
        expect(deleted).toBe(0);
        // The unrelated nonce is untouched.
        expect(await store.isNonceSeen('up-nonce-2')).toBe(true);
    });

    test('does not delete a nonce recorded for a different plan', async () => {
        await store.recordNonce('up-nonce-3', 'user_3', 'starter');
        const deleted = await store.deleteNonceByUserPlan('user_3', 'pro');
        expect(deleted).toBe(0);
        expect(await store.isNonceSeen('up-nonce-3')).toBe(true);
    });
});

describe('_nonce-store (MongoDB) - TTL index', () => {
    test('createIndex is called once with a TTL on createdAt', async () => {
        const fakeDb = makeFakeDb();
        const createIndexSpy = jest.spyOn(fakeDb.collection('nonce_seen'), 'createIndex');
        const store = loadStoreWithDb(async () => fakeDb);

        await store.recordNonce('index-nonce-1');
        await store.recordNonce('index-nonce-2');

        expect(createIndexSpy).toHaveBeenCalledWith(
            { createdAt: 1 },
            expect.objectContaining({ expireAfterSeconds: 900 })
        );
        // Only ensured once per process lifetime, even across multiple recordNonce calls.
        expect(createIndexSpy).toHaveBeenCalledTimes(1);
    });
});

describe('_nonce-store (MongoDB) - Mongo unreachable', () => {
    let store;

    beforeEach(() => {
        store = loadStoreWithDb(makeUnreachableDb('Mongo unreachable in test'));
    });

    test('recordNonce throws (fails closed) when Mongo is unreachable', async () => {
        await expect(store.recordNonce('unreachable-record-1')).rejects.toThrow();
    });

    test('isNonceSeen returns false (fails open) when Mongo is unreachable', async () => {
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        expect(await store.isNonceSeen('unreachable-fresh-1')).toBe(false);
        expect(warnSpy).toHaveBeenCalled();
        warnSpy.mockRestore();
    });

    test('a non-duplicate-key insertOne error is wrapped with a descriptive message', async () => {
        const fakeDb = makeFakeDb();
        fakeDb.collection('nonce_seen').insertOne = async () => {
            throw new Error('connection reset');
        };
        const localStore = loadStoreWithDb(async () => fakeDb);
        await expect(localStore.recordNonce('mid-flight-nonce')).rejects.toThrow(/Mongo recordNonce failed/i);
    });
});
