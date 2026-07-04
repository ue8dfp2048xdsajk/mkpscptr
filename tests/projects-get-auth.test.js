/**
 * @jest-environment node
 *
 * GET /api/projects/:id requires auth and ownership.
 */

'use strict';

const { makeFakeDb } = require('./_helpers/mongo-mock');

function makeReqRes({ method = 'GET', id = 'proj-uuid-1', authorization } = {}) {
    const req = {
        method,
        headers: authorization ? { authorization } : {},
        query: { id },
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

describe('GET /api/projects/:id', () => {
    let handler;
    let fakeDb;

    beforeEach(() => {
        jest.resetModules();
        fakeDb = makeFakeDb();

        jest.doMock('../api/_cors', () => ({
            setCorsHeaders: () => {},
            handleOptions: () => false,
        }));

        jest.doMock('../api/_db', () => ({ getDb: async () => fakeDb }));

        jest.doMock('../api/_verify-clerk-token', () => ({
            verifyClerkToken: jest.fn(async (auth) => {
                if (auth === 'Bearer owner') return 'user_owner';
                if (auth === 'Bearer other') return 'user_other';
                return null;
            }),
        }));

        handler = require('../api/projects/[id]');
    });

    test('returns 401 without Authorization', async () => {
        const { req, res } = makeReqRes();
        await handler(req, res);
        expect(res.statusCode).toBe(401);
        expect(res.body.error).toMatch(/sign in/i);
    });

    test('returns 403 when project belongs to another user', async () => {
        await fakeDb.collection('projects').insertOne({
            _id: 'p1',
            uuid: 'proj-uuid-1',
            userId: 'user_owner',
            name: 'Mine',
            snapshot: { schemaVersion: 1, windows: [] },
        });

        const { req, res } = makeReqRes({ authorization: 'Bearer other' });
        await handler(req, res);

        expect(res.statusCode).toBe(403);
        expect(res.body.error).toBe('Not your project');
    });

    test('returns snapshot for owner', async () => {
        const snapshot = { schemaVersion: 1, windows: [{ id: 'w1' }] };
        await fakeDb.collection('projects').insertOne({
            _id: 'p1',
            uuid: 'proj-uuid-1',
            userId: 'user_owner',
            name: 'Board',
            snapshot,
        });

        const { req, res } = makeReqRes({ authorization: 'Bearer owner' });
        await handler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ ok: true, snapshot, name: 'Board' });
    });
});
