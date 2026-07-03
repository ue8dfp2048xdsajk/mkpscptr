/**
 * @jest-environment node
 *
 * Regression test: two concurrent requests carrying the same nonce must not
 * both succeed. Exactly one should get a 200 and the other a 4xx/5xx.
 *
 * The nonce store (api/_nonce-store.js) is MongoDB-only. Replay protection
 * relies on MongoDB's unique `_id` index: a second insertOne() for an
 * existing `_id` always throws a duplicate-key error (code 11000), even
 * under concurrent writes from separate serverless instances — this is
 * enforced atomically by MongoDB itself, not by application code. The fake
 * collection in tests/_helpers/mongo-mock.js reproduces exactly this
 * behavior so this suite runs in CI without any real infrastructure.
 *
 * Why this matters: if the store were ever changed to a check-then-write
 * pattern without an atomic uniqueness constraint, this test would catch the
 * regression before it ships.
 */

'use strict';

const { makeFakeDb } = require('./_helpers/mongo-mock');

const SECRET = 'test-secret';
const SHARED_NONCE = 'race-test-nonce-abc123';

function makeReqRes({ nonce = SHARED_NONCE } = {}) {
    const req = {
        method: 'POST',
        headers: {
            authorization: `Bearer ${SECRET}`,
            'x-timestamp': String(Math.floor(Date.now() / 1000)),
            'x-nonce': nonce,
            'x-forwarded-for': '127.0.0.1',
        },
        body: { userId: 'user_test_123', plan: 'pro' },
        socket: { remoteAddress: '127.0.0.1' },
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

function loadHandler(getDbImpl) {
    jest.resetModules();

    process.env.CLERK_SECRET_KEY = 'clerk-test-key';
    process.env.SET_PLAN_SECRET = SECRET;

    jest.doMock('../api/_cors', () => ({
        setCorsHeaders: () => {},
        handleOptions: () => false,
    }));
    jest.doMock('../api/_db', () => ({ getDb: getDbImpl }));

    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) });

    return require('../api/set-plan');
}

describe('Nonce deduplication — concurrent race (MongoDB unique-index)', () => {
    let handler;

    beforeEach(() => {
        const fakeDb = makeFakeDb();
        handler = loadHandler(async () => fakeDb);
    });

    afterEach(() => {
        delete process.env.CLERK_SECRET_KEY;
        delete process.env.SET_PLAN_SECRET;
        jest.clearAllMocks();
    });

    test('exactly one of two simultaneous identical-nonce requests succeeds', async () => {
        const { req: req1, res: res1 } = makeReqRes();
        const { req: req2, res: res2 } = makeReqRes();

        await Promise.all([
            handler(req1, res1),
            handler(req2, res2),
        ]);

        const codes = [res1.statusCode, res2.statusCode];
        const successes = codes.filter(c => c === 200);
        const rejections = codes.filter(c => c >= 400);

        expect(successes).toHaveLength(1);
        expect(rejections).toHaveLength(1);
    });

    test('the rejected request carries a nonce-related error status and ok:false', async () => {
        const { req: req1, res: res1 } = makeReqRes();
        const { req: req2, res: res2 } = makeReqRes();

        await Promise.all([
            handler(req1, res1),
            handler(req2, res2),
        ]);

        const rejected = [res1, res2].find(r => r.statusCode !== 200);

        expect(rejected).toBeDefined();
        expect(rejected.statusCode).toBeGreaterThanOrEqual(400);
        expect(rejected.body.ok).toBe(false);
    });

    test('a third request with the same nonce is also rejected', async () => {
        const { req: req1, res: res1 } = makeReqRes();
        const { req: req2, res: res2 } = makeReqRes();
        const { req: req3, res: res3 } = makeReqRes();

        await Promise.all([
            handler(req1, res1),
            handler(req2, res2),
        ]);

        await handler(req3, res3);

        expect(res3.statusCode).toBeGreaterThanOrEqual(400);
        expect(res3.body.ok).toBe(false);
    });

    test('a request with a different nonce still succeeds', async () => {
        const { req: req1, res: res1 } = makeReqRes({ nonce: SHARED_NONCE });
        const { req: req2, res: res2 } = makeReqRes({ nonce: 'different-nonce-xyz' });

        await Promise.all([
            handler(req1, res1),
            handler(req2, res2),
        ]);

        expect(res1.statusCode).toBe(200);
        expect(res2.statusCode).toBe(200);
    });
});

describe('Nonce deduplication — _nonce-store unit-level race', () => {
    test('two concurrent recordNonce calls for the same nonce: exactly one succeeds, one throws Duplicate nonce', async () => {
        jest.resetModules();
        const fakeDb = makeFakeDb();
        jest.doMock('../api/_db', () => ({ getDb: async () => fakeDb }));
        const store = require('../api/_nonce-store');

        const [resultA, resultB] = await Promise.allSettled([
            store.recordNonce('unit-race-nonce'),
            store.recordNonce('unit-race-nonce'),
        ]);

        const fulfilled = [resultA, resultB].filter(r => r.status === 'fulfilled');
        const duplicates = [resultA, resultB].filter(
            r => r.status === 'rejected' && /Duplicate nonce/i.test(r.reason.message)
        );

        expect(fulfilled).toHaveLength(1);
        expect(duplicates).toHaveLength(1);
    });

    test('sequential recordNonce for the same nonce: second call always throws Duplicate nonce', async () => {
        jest.resetModules();
        const fakeDb = makeFakeDb();
        jest.doMock('../api/_db', () => ({ getDb: async () => fakeDb }));
        const store = require('../api/_nonce-store');

        await store.recordNonce('unit-test-nonce');
        await expect(store.recordNonce('unit-test-nonce')).rejects.toThrow('Duplicate nonce');
    });
});

// ---------------------------------------------------------------------------
// Mongo fails mid-flight — fail-closed guarantees no replay bypass
//
// Scenario: MongoDB is reachable for the isNonceSeen pre-check (returns "not
// seen"), but the subsequent insertOne (recordNonce) throws — e.g. the
// connection drops between the check and the write. recordNonce must NOT
// silently succeed or fall back to any other store: it throws, the handler
// returns 500, and no nonce is ever committed. Every request carrying the
// contested nonce is rejected while this failure persists — the safe
// outcome, since no replay can succeed if nothing was ever recorded.
// ---------------------------------------------------------------------------

describe('Nonce deduplication — Mongo insertOne fails mid-flight (fail-closed, no replay bypass)', () => {
    afterEach(() => {
        delete process.env.CLERK_SECRET_KEY;
        delete process.env.SET_PLAN_SECRET;
        jest.clearAllMocks();
    });

    test('when findOne succeeds but insertOne throws, both concurrent requests are blocked', async () => {
        const fakeDb = makeFakeDb();
        fakeDb.collection('nonce_seen').insertOne = async () => {
            throw new Error('connection reset mid-flight');
        };

        const handler = loadHandler(async () => fakeDb);
        const { req: req1, res: res1 } = makeReqRes();
        const { req: req2, res: res2 } = makeReqRes();

        await Promise.all([handler(req1, res1), handler(req2, res2)]);

        expect(res1.statusCode).toBeGreaterThanOrEqual(500);
        expect(res2.statusCode).toBeGreaterThanOrEqual(500);
        expect(res1.body.ok).toBe(false);
        expect(res2.body.ok).toBe(false);
    });

    test('when Mongo is entirely unreachable (getDb rejects), no request succeeds', async () => {
        const handler = loadHandler(() => Promise.reject(new Error('Mongo network timeout')));
        const { req: req1, res: res1 } = makeReqRes();
        const { req: req2, res: res2 } = makeReqRes();

        await Promise.all([handler(req1, res1), handler(req2, res2)]);

        expect(res1.statusCode).toBeGreaterThanOrEqual(500);
        expect(res2.statusCode).toBeGreaterThanOrEqual(500);
        expect(res1.body.ok).toBe(false);
        expect(res2.body.ok).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Separate serverless instances sharing one MongoDB — atomicity holds
//
// Unlike the old Redis/in-memory design, there is no "which instance saw
// what" concern: every instance (module load) talks to the same MongoDB, so
// two independently-loaded set-plan handlers racing on the same nonce behave
// identically to two concurrent requests within a single instance.
// ---------------------------------------------------------------------------

describe('Two independently-loaded set-plan handlers sharing one MongoDB backend', () => {
    afterEach(() => {
        delete process.env.CLERK_SECRET_KEY;
        delete process.env.SET_PLAN_SECRET;
        jest.clearAllMocks();
    });

    test('two concurrent requests through separately-loaded handlers — only one succeeds, replay then rejected', async () => {
        const fakeDb = makeFakeDb();

        function loadFreshHandler() {
            jest.resetModules();
            process.env.CLERK_SECRET_KEY = 'clerk-test-key';
            process.env.SET_PLAN_SECRET = SECRET;
            jest.doMock('../api/_cors', () => ({
                setCorsHeaders: () => {},
                handleOptions: () => false,
            }));
            jest.doMock('../api/_db', () => ({ getDb: async () => fakeDb }));
            global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
            return require('../api/set-plan');
        }

        const handlerA = loadFreshHandler();
        const handlerB = loadFreshHandler();

        const nonce = 'multi-instance-e2e-nonce-1';

        const { req: reqA1, res: resA1 } = makeReqRes({ nonce });
        const { req: reqB1, res: resB1 } = makeReqRes({ nonce });

        await Promise.all([handlerA(reqA1, resA1), handlerB(reqB1, resB1)]);

        const codes = [resA1.statusCode, resB1.statusCode];
        expect(codes.filter(c => c === 200)).toHaveLength(1);
        expect(codes.filter(c => c >= 400)).toHaveLength(1);

        // Replay attempt — must be blocked regardless of which handler instance.
        const { req: reqA2, res: resA2 } = makeReqRes({ nonce });
        await handlerA(reqA2, resA2);
        expect(resA2.statusCode).toBeGreaterThanOrEqual(400);
        expect(resA2.body.ok).toBe(false);
    });
});
