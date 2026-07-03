/**
 * @jest-environment node
 */

'use strict';

describe('api/_stripe-prices — billing period checkout rules', () => {
    const envBackup = {};

    beforeEach(() => {
        jest.resetModules();
        for (const key of Object.keys(process.env)) {
            if (key.startsWith('STRIPE_PRICE_')) {
                envBackup[key] = process.env[key];
                delete process.env[key];
            }
        }
        process.env.STRIPE_PRICE_STARTER_MONTHLY = 'price_starter_monthly';
        process.env.STRIPE_PRICE_STARTER_ANNUAL = 'price_starter_annual';
        process.env.STRIPE_PRICE_STARTER_LIFETIME = 'price_starter_lifetime';
        process.env.STRIPE_PRICE_PRO_MONTHLY = 'price_pro_monthly';
        process.env.STRIPE_PRICE_PRO_ANNUAL = 'price_pro_annual';
        process.env.STRIPE_PRICE_PRO_LIFETIME = 'price_pro_lifetime';
    });

    afterEach(() => {
        for (const key of Object.keys(envBackup)) {
            process.env[key] = envBackup[key];
        }
        for (const key of Object.keys(process.env)) {
            if (key.startsWith('STRIPE_PRICE_') && !(key in envBackup)) {
                delete process.env[key];
            }
        }
    });

    function load() {
        return require('../api/_stripe-prices');
    }

    test('isCheckoutBlocked allows same tier with different billing period', () => {
        const { isCheckoutBlocked } = load();
        expect(isCheckoutBlocked('starter', 'monthly', 'starter', 'annual')).toBe(false);
        expect(isCheckoutBlocked('starter', 'monthly', 'starter', 'lifetime')).toBe(false);
        expect(isCheckoutBlocked('pro', 'annual', 'pro', 'lifetime')).toBe(false);
    });

    test('isCheckoutBlocked rejects same tier and same billing period', () => {
        const { isCheckoutBlocked } = load();
        expect(isCheckoutBlocked('starter', 'monthly', 'starter', 'monthly')).toBe(true);
        expect(isCheckoutBlocked('pro', 'lifetime', 'pro', 'lifetime')).toBe(true);
    });

    test('legacy unknown billing period only blocks monthly repurchase', () => {
        const { isCheckoutBlocked } = load();
        expect(isCheckoutBlocked('starter', null, 'starter', 'monthly')).toBe(true);
        expect(isCheckoutBlocked('starter', null, 'starter', 'annual')).toBe(false);
        expect(isCheckoutBlocked('starter', null, 'starter', 'lifetime')).toBe(false);
    });

    test('resolvePriceId maps env price IDs to plan and period', () => {
        const { resolvePriceId } = load();
        expect(resolvePriceId('price_starter_annual')).toEqual({ plan: 'starter', period: 'annual' });
        expect(resolvePriceId('price_pro_lifetime')).toEqual({ plan: 'pro', period: 'lifetime' });
    });

    test('shouldDowngradeToFree returns false for lifetime billingPeriod', async () => {
        const { shouldDowngradeToFree } = load();
        const result = await shouldDowngradeToFree(
            'cus_lifetime_001',
            'user_lifetime_001',
            null,
            null,
            'lifetime'
        );
        expect(result).toBe(false);
    });

    test('shouldDowngradeToFree returns false when active subscription exists', async () => {
        const { shouldDowngradeToFree } = load();
        global.fetch = jest.fn(async (url) => {
            if (String(url).includes('/subscriptions?')) {
                return {
                    ok: true,
                    json: async () => ({ data: [{ id: 'sub_active_001' }] }),
                };
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });
        const result = await shouldDowngradeToFree(
            'cus_active_001',
            'user_active_001',
            null,
            'sk_test',
            'monthly'
        );
        expect(result).toBe(false);
    });
});
