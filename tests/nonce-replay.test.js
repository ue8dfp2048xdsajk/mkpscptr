/**
 * @jest-environment node
 *
 * Replay-attack protection — duplicate nonce rejection and recovery, exercised
 * end-to-end through the api/set-plan.js handler with a mocked MongoDB
 * backend (api/_nonce-store.js is Mongo-only — see tests/nonce-store.test.js
 * for store-level unit tests).
 *
 * Covers:
 *  - First request with a nonce succeeds; a second/third request with the
 *    same nonce is rejected with 400
 *  - Nonce is released when Clerk fails (network error or non-ok status) so
 *    a retry with the same nonce succeeds
 *  - Nonce stays blocked after a successful Clerk call (no double-processing)
 *  - Mongo completely unreachable → set-plan fails closed (500), and stays
 *    closed on retry; no replay ever slips through
 *  - Mid-request Mongo failure (recordNonce throws after isNonceSeen passed)
 *    → 500, not 200; a legitimate retry once Mongo recovers succeeds, and a
 *    subsequent replay of the same nonce is then correctly rejected
 *
 * No real MongoDB or Clerk connections are made — all external I/O is mocked.
 */

'use strict';

const { makeFakeDb, makeUnreachableDb } = require('./_helpers/mongo-mock');

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

function loadHandler(getDbImpl) {
    jest.resetModules();
    process.env.CLERK_SECRET_KEY = 'clerk-test-key';
    process.env.SET_PLAN_SECRET  = 'test-secret';

    jest.doMock('../api/_cors', () => ({
        setCorsHeaders: () => {},
        handleOptions:  () => false,
    }));
    jest.doMock('../api/_db', () => ({ getDb: getDbImpl }));

    return require('../api/set-plan');
}

afterEach(() => {
    delete process.env.CLERK_SECRET_KEY;
    delete process.env.SET_PLAN_SECRET;
    jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// 1. END-TO-END — duplicate nonce rejected
// ---------------------------------------------------------------------------

describe('set-plan handler — duplicate nonce rejected (MongoDB)', () => {
    let handler;

    beforeEach(() => {
        const fakeDb = makeFakeDb();
        handler = loadHandler(async () => fakeDb);
        global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    });

    test('first request with a nonce succeeds (200)', async () => {
        const { req, res } = makeReqRes({ nonce: 'e2e-nonce-1' });
        await handler(req, res);
        expect(res.statusCode).toBe(200);
        expect(res.body.ok).toBe(true);
    });

    test('second request with the same nonce is rejected (400)', async () => {
        const nonce = 'e2e-nonce-2';
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
        const nonce = 'e2e-nonce-3';
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

    test('unique nonces each succeed independently', async () => {
        const { req: req1, res: res1 } = makeReqRes({ nonce: 'e2e-unique-a' });
        const { req: req2, res: res2 } = makeReqRes({ nonce: 'e2e-unique-b' });

        await handler(req1, res1);
        await handler(req2, res2);

        expect(res1.statusCode).toBe(200);
        expect(res2.statusCode).toBe(200);
    });
});

// ---------------------------------------------------------------------------
// 2. RECOVERY — nonce released after Clerk failure
// ---------------------------------------------------------------------------

describe('set-plan handler — nonce released after Clerk failure (MongoDB)', () => {
    let handler, fetchMock;

    beforeEach(() => {
        const fakeDb = makeFakeDb();
        handler = loadHandler(async () => fakeDb);
        fetchMock = jest.fn();
        global.fetch = fetchMock;
    });

    test('nonce reusable after Clerk fetch throws (network error)', async () => {
        const nonce = 'recovery-network-nonce';

        fetchMock.mockRejectedValueOnce(new Error('network error'));
        const { req: req1, res: res1 } = makeReqRes({ nonce });
        await handler(req1, res1);
        expect(res1.statusCode).toBe(502);

        fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
        const { req: req2, res: res2 } = makeReqRes({ nonce });
        await handler(req2, res2);
        expect(res2.statusCode).toBe(200);
        expect(res2.body.ok).toBe(true);
    });

    test('nonce reusable after Clerk returns non-ok status', async () => {
        const nonce = 'recovery-clerk-error-nonce';

        fetchMock.mockResolvedValueOnce({
            ok: false,
            status: 500,
            json: async () => ({ errors: [{ message: 'Clerk internal error' }] }),
        });
        const { req: req1, res: res1 } = makeReqRes({ nonce });
        await handler(req1, res1);
        expect(res1.statusCode).toBe(502);

        fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
        const { req: req2, res: res2 } = makeReqRes({ nonce });
        await handler(req2, res2);
        expect(res2.statusCode).toBe(200);
        expect(res2.body.ok).toBe(true);
    });

    test('nonce still blocked after a successful Clerk call (no double-processing)', async () => {
        const nonce = 'recovery-success-then-dup-nonce';

        fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });

        const { req: req1, res: res1 } = makeReqRes({ nonce });
        await handler(req1, res1);
        expect(res1.statusCode).toBe(200);

        const { req: req2, res: res2 } = makeReqRes({ nonce });
        await handler(req2, res2);
        expect(res2.statusCode).toBe(400);
        expect(res2.body.error).toMatch(/duplicate nonce/i);
    });
});

// ---------------------------------------------------------------------------
// 3. MONGO COMPLETELY UNREACHABLE — recordNonce fails closed (no replay slip-through)
// ---------------------------------------------------------------------------

describe('set-plan handler — Mongo completely unreachable returns 500 (fails closed)', () => {
    let handler;

    beforeEach(() => {
        handler = loadHandler(makeUnreachableDb('ECONNREFUSED'));
        global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    });

    test('request returns 500 when Mongo recordNonce is unreachable (fails closed)', async () => {
        const { req, res } = makeReqRes({ nonce: 'mongo-down-e2e-nonce-1' });
        await handler(req, res);
        expect(res.statusCode).toBe(500);
        expect(res.body.ok).toBe(false);
        expect(res.body.error).toMatch(/Failed to record nonce/i);
    });

    test('a retry with the same nonce also returns 500 while Mongo stays down — no replay slip-through', async () => {
        const nonce = 'mongo-down-e2e-nonce-2';
        const { req: req1, res: res1 } = makeReqRes({ nonce });
        const { req: req2, res: res2 } = makeReqRes({ nonce });

        await handler(req1, res1);
        await handler(req2, res2);

        // Both return 500 — neither request was processed, so no double-billing
        // and no replay attack succeeded.
        expect(res1.statusCode).toBe(500);
        expect(res2.statusCode).toBe(500);
    });

    test('a different nonce also returns 500 while Mongo is down', async () => {
        const { req: req1, res: res1 } = makeReqRes({ nonce: 'mongo-down-nonce-alpha' });
        const { req: req2, res: res2 } = makeReqRes({ nonce: 'mongo-down-nonce-beta' });

        await handler(req1, res1);
        await handler(req2, res2);

        expect(res1.statusCode).toBe(500);
        expect(res2.statusCode).toBe(500);
    });
});

// ---------------------------------------------------------------------------
// 4. MID-REQUEST MONGO FAILURE, THEN RECOVERY — legitimate retry succeeds,
//    subsequent replay of the same nonce is rejected
// ---------------------------------------------------------------------------

describe('set-plan handler — same nonce cannot slip through after a transient Mongo failure', () => {
    test('attempt 1 fails closed (500); attempt 2 (legit retry) succeeds; attempt 3 (replay) is rejected', async () => {
        const fakeDb = makeFakeDb();
        let mongoRecovered = false;
        const realInsertOne = fakeDb.collection('nonce_seen').insertOne.bind(fakeDb.collection('nonce_seen'));
        fakeDb.collection('nonce_seen').insertOne = async (doc) => {
            if (!mongoRecovered) throw new Error('ECONNRESET');
            return realInsertOne(doc);
        };

        const handler = loadHandler(async () => fakeDb);
        global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) });

        const nonce = 'mid-flight-retry-nonce';

        // Attempt 1 — transient Mongo failure → 500, nonce committed nowhere.
        const { req: req1, res: res1 } = makeReqRes({ nonce });
        await handler(req1, res1);
        expect(res1.statusCode).toBe(500);

        // Mongo recovers.
        mongoRecovered = true;

        // Attempt 2 — legitimate retry (the original request was never
        // processed) → must succeed.
        const { req: req2, res: res2 } = makeReqRes({ nonce });
        await handler(req2, res2);
        expect(res2.statusCode).toBe(200);
        expect(res2.body.ok).toBe(true);

        // Attempt 3 — replay attack with the same nonce → rejected.
        const { req: req3, res: res3 } = makeReqRes({ nonce });
        await handler(req3, res3);
        expect(res3.statusCode).toBe(400);
        expect(res3.body.error).toMatch(/duplicate nonce/i);
    });

    test('Clerk is never called when recordNonce fails mid-flight', async () => {
        const fakeDb = makeFakeDb();
        fakeDb.collection('nonce_seen').insertOne = async () => { throw new Error('ECONNRESET'); };

        const handler = loadHandler(async () => fakeDb);
        const clerkCalls = [];
        global.fetch = jest.fn(async (url) => {
            clerkCalls.push(url);
            return { ok: true, json: async () => ({}) };
        });

        const { req, res } = makeReqRes({ nonce: 'mid-flight-no-clerk-nonce' });
        await handler(req, res);

        expect(res.statusCode).toBe(500);
        expect(clerkCalls).toHaveLength(0);
    });
});
