/**
 * @jest-environment node
 *
 * Starter cloud save — findOneAndUpdate must not put `name` in both $set and $setOnInsert.
 */

'use strict';

function makeReqRes({ body, authorization = 'Bearer test-token' } = {}) {
    const req = {
        method: 'POST',
        headers: authorization ? { authorization } : {},
        body,
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

function makeSnapshot() {
    return { schemaVersion: 1, windows: [], imageMap: {} };
}

function makeProjectsCollection() {
    const docs = new Map();

    function matches(doc, filter) {
        return Object.entries(filter).every(([key, value]) => doc[key] === value);
    }

    function findDoc(filter) {
        for (const doc of docs.values()) {
            if (matches(doc, filter)) return doc;
        }
        return null;
    }

    return {
        async findOne(filter) {
            return findDoc(filter) || null;
        },

        async findOneAndUpdate(filter, update, options = {}) {
            const setFields = update.$set || {};
            const setOnInsert = update.$setOnInsert || {};

            for (const key of Object.keys(setFields)) {
                if (Object.prototype.hasOwnProperty.call(setOnInsert, key)) {
                    const err = new Error(`Updating the path '${key}' would create a conflict at '${key}'`);
                    err.name = 'MongoServerError';
                    throw err;
                }
            }

            const existing = findDoc(filter);
            if (existing) {
                Object.assign(existing, setFields);
                existing.updatedAt = setFields.updatedAt;
                return existing;
            }

            if (!options.upsert) return null;

            const doc = {
                _id: `doc_${docs.size + 1}`,
                ...filter,
                ...setOnInsert,
                ...setFields,
            };
            docs.set(doc._id, doc);
            return doc;
        },
    };
}

describe('projects/save — starter plan', () => {
    let handler;
    let projectsCol;
    const originalFetch = global.fetch;

    beforeEach(() => {
        jest.resetModules();
        projectsCol = makeProjectsCollection();

        jest.doMock('../api/_cors', () => ({
            setCorsHeaders: () => {},
            handleOptions: () => false,
        }));

        jest.doMock('../api/_db', () => ({
            getDb: async () => ({
                collection: (name) => {
                    if (name !== 'projects') throw new Error(`unexpected collection ${name}`);
                    return projectsCol;
                },
            }),
        }));

        jest.doMock('../api/_verify-clerk-token', () => ({
            verifyClerkToken: jest.fn().mockResolvedValue('user_starter_1'),
        }));

        process.env.CLERK_SECRET_KEY = 'sk_test';

        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ public_metadata: { plan: 'starter' } }),
        });

        handler = require('../api/projects/save');
    });

    afterEach(() => {
        global.fetch = originalFetch;
        delete process.env.CLERK_SECRET_KEY;
        jest.clearAllMocks();
    });

    test('upsert with project name returns 200 (no $set/$setOnInsert name conflict)', async () => {
        const { req, res } = makeReqRes({
            body: {
                snapshot: makeSnapshot(),
                name: 'My mockup board',
            },
        });

        await handler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ ok: true, uuid: expect.any(String) });
    });

    test('upsert without project name returns 200 and defaults name on insert', async () => {
        const { req, res } = makeReqRes({
            body: { snapshot: makeSnapshot() },
        });

        await handler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.ok).toBe(true);
    });

    test('second save with new name updates existing starter project', async () => {
        const first = makeReqRes({
            body: { snapshot: makeSnapshot(), name: 'First name' },
        });
        await handler(first.req, first.res);

        const uuid = first.res.body.uuid;
        expect(uuid).toBeTruthy();

        const second = makeReqRes({
            body: { snapshot: makeSnapshot(), name: 'Renamed board' },
        });
        await handler(second.req, second.res);

        expect(second.res.statusCode).toBe(200);
        expect(second.res.body.uuid).toBe(uuid);
    });
});
