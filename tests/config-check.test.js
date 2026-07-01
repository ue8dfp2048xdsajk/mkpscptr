/**
 * @jest-environment node
 *
 * Tests for the rate_limiter section of api/admin/[action].js (config-check action).
 *
 * Three scenarios are covered:
 *  1. No backend configured (no Redis, no PG) → warning present, durable=false
 *  2. Redis configured → warning null, durable=true
 *  3. PG configured    → warning null, durable=true
 *
 * The handler is imported directly; _cors and _nonce-store are stubbed.
 */

'use strict';

jest.mock('../api/_cors', () => ({
    setCorsHeaders: () => {},
    handleOptions: () => false,
}));

jest.mock('../api/_nonce-store', () => ({
    deleteNonce: async () => {},
    deleteNonceByUserPlan: async () => 0,
}));

function makeRes() {
    return {
        _status: null,
        _body: null,
        status(code) { this._status = code; return this; },
        json(body) { this._body = body; return this; },
    };
}

function makeReq(method = 'GET') {
    return { method, headers: {}, query: { action: 'config-check' } };
}

function withEnv(overrides, fn) {
    const saved = {};
    const REDIS_KEYS = ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'];
    const PG_KEYS = ['DATABASE_URL'];
    const ALL_MANAGED = [...REDIS_KEYS, ...PG_KEYS];

    for (const k of ALL_MANAGED) {
        saved[k] = process.env[k];
        delete process.env[k];
    }
    for (const [k, v] of Object.entries(overrides)) {
        process.env[k] = v;
    }

    try {
        return fn();
    } finally {
        for (const k of ALL_MANAGED) {
            if (saved[k] === undefined) {
                delete process.env[k];
            } else {
                process.env[k] = saved[k];
            }
        }
    }
}

describe('GET /api/admin/config-check — rate_limiter section', () => {
    test('no backend: warning is present and durable is false', async () => {
        let handler;
        withEnv({}, () => {
            jest.resetModules();
            jest.mock('../api/_cors', () => ({
                setCorsHeaders: () => {},
                handleOptions: () => false,
            }));
            jest.mock('../api/_nonce-store', () => ({
                deleteNonce: async () => {},
                deleteNonceByUserPlan: async () => 0,
            }));
            handler = require('../api/admin/[action]');
        });

        const req = makeReq();
        const res = makeRes();
        await handler(req, res);

        expect(res._status).toBe(200);
        expect(res._body.ok).toBe(true);
        expect(res._body.rate_limiter.durable).toBe(false);
        expect(res._body.rate_limiter.backend).toBe('in-memory');
        expect(typeof res._body.rate_limiter.warning).toBe('string');
        expect(res._body.rate_limiter.warning.length).toBeGreaterThan(0);
        expect(res._body.rate_limiter.warning).toMatch(/in.memory|process memory/i);
    });

    test('Redis configured: warning is null and durable is true', async () => {
        let handler;
        withEnv(
            {
                UPSTASH_REDIS_REST_URL: 'https://redis.example.com',
                UPSTASH_REDIS_REST_TOKEN: 'token_test',
            },
            () => {
                jest.resetModules();
                jest.mock('../api/_cors', () => ({
                    setCorsHeaders: () => {},
                    handleOptions: () => false,
                }));
                jest.mock('../api/_nonce-store', () => ({
                    deleteNonce: async () => {},
                    deleteNonceByUserPlan: async () => 0,
                }));
                handler = require('../api/admin/[action]');
            },
        );

        const req = makeReq();
        const res = makeRes();
        await handler(req, res);

        expect(res._status).toBe(200);
        expect(res._body.ok).toBe(true);
        expect(res._body.rate_limiter.durable).toBe(true);
        expect(res._body.rate_limiter.backend).toBe('redis');
        expect(res._body.rate_limiter.warning).toBeNull();
    });

    test('PG configured: warning is null and durable is true', async () => {
        let handler;
        withEnv(
            { DATABASE_URL: 'postgresql://user:pass@localhost/db' },
            () => {
                jest.resetModules();
                jest.mock('../api/_cors', () => ({
                    setCorsHeaders: () => {},
                    handleOptions: () => false,
                }));
                jest.mock('../api/_nonce-store', () => ({
                    deleteNonce: async () => {},
                    deleteNonceByUserPlan: async () => 0,
                }));
                handler = require('../api/admin/[action]');
            },
        );

        const req = makeReq();
        const res = makeRes();
        await handler(req, res);

        expect(res._status).toBe(200);
        expect(res._body.ok).toBe(true);
        expect(res._body.rate_limiter.durable).toBe(true);
        expect(res._body.rate_limiter.backend).toBe('postgresql');
        expect(res._body.rate_limiter.warning).toBeNull();
    });
});
