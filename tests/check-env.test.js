/**
 * @jest-environment node
 *
 * Tests for scripts/check-env.js.
 *
 * Each test spawns the script as a real child process with a tightly
 * controlled environment so we exercise the actual exit-code behaviour,
 * MISSING/INVALID output, and the optional-variable warning path.
 *
 * Covered cases:
 *  1. All required vars present with valid values → exits 0
 *  2. One required var missing                   → exits 1
 *  3. STRIPE_WEBHOOK_SECRET with wrong prefix    → exits 1  (INVALID, not MISSING)
 *  4. Optional vars (UPSTASH_REDIS_REST_URL/TOKEN) absent → exits 0 with a warning,
 *     since the payment-to-plan nonce store is MongoDB-backed and no longer
 *     depends on Upstash (only the rate limiters do, and they fail open).
 */

'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'check-env.js');

const ALL_REQUIRED = {
    STRIPE_SECRET_KEY: 'sk_test_dummy',
    STRIPE_PRICE_STARTER_MONTHLY: 'price_starter_monthly',
    STRIPE_PRICE_STARTER_ANNUAL: 'price_starter_annual',
    STRIPE_PRICE_STARTER_LIFETIME: 'price_starter_lifetime',
    STRIPE_PRICE_PRO_MONTHLY: 'price_pro_monthly',
    STRIPE_PRICE_PRO_ANNUAL: 'price_pro_annual',
    STRIPE_PRICE_PRO_LIFETIME: 'price_pro_lifetime',
    BASE_URL: 'https://example.com',
    STRIPE_WEBHOOK_SECRET: 'whsec_test_dummy_secret',
    SET_PLAN_SECRET: 'set_plan_test_secret',
    CLERK_SECRET_KEY: 'sk_test_clerk_dummy',
    CLERK_JWKS_URL: 'https://clerk.example.com/.well-known/jwks.json',
    MONGODB_URI: 'mongodb+srv://user:pass@cluster.example.mongodb.net',
};

function run(env) {
    const result = spawnSync(process.execPath, [SCRIPT], {
        env: { ...env },
        encoding: 'utf8',
        timeout: 10000,
    });
    return {
        code: result.status,
        stdout: result.stdout || '',
        stderr: result.stderr || '',
    };
}

describe('scripts/check-env.js - child-process integration', () => {
    test('exits 0 when all required variables are present and valid', () => {
        const { code, stdout } = run(ALL_REQUIRED);
        expect(code).toBe(0);
        expect(stdout).toMatch(/all required environment variables are set/i);
    });

    test('exits 1 when a required variable is missing', () => {
        const env = { ...ALL_REQUIRED };
        delete env.SET_PLAN_SECRET;
        const { code, stderr } = run(env);
        expect(code).toBe(1);
        expect(stderr).toMatch(/MISSING/);
        expect(stderr).toMatch(/SET_PLAN_SECRET/);
    });

    test('exits 1 when STRIPE_WEBHOOK_SECRET has wrong prefix (INVALID, not MISSING)', () => {
        const env = { ...ALL_REQUIRED, STRIPE_WEBHOOK_SECRET: 'sk_live_wrong_type' };
        const { code, stderr } = run(env);
        expect(code).toBe(1);
        expect(stderr).toMatch(/INVALID/);
        expect(stderr).toMatch(/STRIPE_WEBHOOK_SECRET/);
        expect(stderr).toMatch(/whsec_/);
    });

    test('exits 1 when STRIPE_WEBHOOK_SECRET is an empty string', () => {
        const env = { ...ALL_REQUIRED, STRIPE_WEBHOOK_SECRET: '' };
        const { code, stderr } = run(env);
        expect(code).toBe(1);
        expect(stderr).toMatch(/MISSING/);
        expect(stderr).toMatch(/STRIPE_WEBHOOK_SECRET/);
    });

    test('exits 1 when STRIPE_WEBHOOK_SECRET is whitespace only', () => {
        const env = { ...ALL_REQUIRED, STRIPE_WEBHOOK_SECRET: '   ' };
        const { code, stderr } = run(env);
        expect(code).toBe(1);
        expect(stderr).toMatch(/MISSING/);
        expect(stderr).toMatch(/STRIPE_WEBHOOK_SECRET/);
    });

    test('exits 1 when STRIPE_SECRET_KEY has wrong prefix', () => {
        const env = { ...ALL_REQUIRED, STRIPE_SECRET_KEY: 'pk_live_wrong' };
        const { code, stderr } = run(env);
        expect(code).toBe(1);
        expect(stderr).toMatch(/INVALID/);
        expect(stderr).toMatch(/STRIPE_SECRET_KEY/);
    });

    test('exits 1 when CLERK_JWKS_URL is missing', () => {
        const env = { ...ALL_REQUIRED };
        delete env.CLERK_JWKS_URL;
        const { code, stderr } = run(env);
        expect(code).toBe(1);
        expect(stderr).toMatch(/MISSING/);
        expect(stderr).toMatch(/CLERK_JWKS_URL/);
    });

    test('exits 1 when CLERK_JWKS_URL has wrong prefix', () => {
        const env = { ...ALL_REQUIRED, CLERK_JWKS_URL: 'clerk.example.com/.well-known/jwks.json' };
        const { code, stderr } = run(env);
        expect(code).toBe(1);
        expect(stderr).toMatch(/INVALID/);
        expect(stderr).toMatch(/CLERK_JWKS_URL/);
        expect(stderr).toMatch(/https:\/\//);
    });

    test('exits 1 when MONGODB_URI is missing', () => {
        const env = { ...ALL_REQUIRED };
        delete env.MONGODB_URI;
        const { code, stderr } = run(env);
        expect(code).toBe(1);
        expect(stderr).toMatch(/MISSING/);
        expect(stderr).toMatch(/MONGODB_URI/);
    });

    test('exits 1 when MONGODB_URI has wrong prefix', () => {
        const env = { ...ALL_REQUIRED, MONGODB_URI: 'postgres://user:pass@host/db' };
        const { code, stderr } = run(env);
        expect(code).toBe(1);
        expect(stderr).toMatch(/INVALID/);
        expect(stderr).toMatch(/MONGODB_URI/);
        expect(stderr).toMatch(/mongodb/);
    });

    test('exits 0 when MONGODB_URI uses the mongodb:// (non-SRV) scheme', () => {
        const env = { ...ALL_REQUIRED, MONGODB_URI: 'mongodb://localhost:27017/mockupscripter' };
        const { code } = run(env);
        expect(code).toBe(0);
    });

    test('exits 1 when multiple required variables are missing', () => {
        const env = { ...ALL_REQUIRED };
        delete env.BASE_URL;
        delete env.CLERK_SECRET_KEY;
        const { code, stderr } = run(env);
        expect(code).toBe(1);
        expect(stderr).toMatch(/2 required variable/i);
    });

    test('exits 0 with a warning when UPSTASH_REDIS_REST_URL/TOKEN are absent (optional, not required)', () => {
        const { code, stdout, stderr } = run(ALL_REQUIRED);
        expect(code).toBe(0);
        expect(stdout).toMatch(/checking optional environment variables/i);
        // console.warn writes to stderr, not stdout.
        expect(stderr).toMatch(/MISSING\s+UPSTASH_REDIS_REST_URL \(optional\)/);
        expect(stderr).toMatch(/MISSING\s+UPSTASH_REDIS_REST_TOKEN \(optional\)/);
    });

    test('exits 0 with no optional warnings when UPSTASH_REDIS_REST_URL/TOKEN are present', () => {
        const env = {
            ...ALL_REQUIRED,
            UPSTASH_REDIS_REST_URL: 'https://redis.example.upstash.io',
            UPSTASH_REDIS_REST_TOKEN: 'token_dummy',
        };
        const { code, stderr } = run(env);
        expect(code).toBe(0);
        expect(stderr).not.toMatch(/MISSING.*optional/i);
    });
});
