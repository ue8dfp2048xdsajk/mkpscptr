/**
 * @jest-environment node
 */

'use strict';

describe('api/_stripe-prices — subscription update routing', () => {
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
        process.env.STRIPE_PRICE_PRO_MONTHLY = 'price_pro_monthly';
    });

    afterEach(() => {
        for (const [key, val] of Object.entries(envBackup)) {
            process.env[key] = val;
        }
    });

    function load() {
        return require('../api/_stripe-prices');
    }

    test('isSubscriptionUpdateCandidate is false for lifetime and free users', () => {
        const { isSubscriptionUpdateCandidate } = load();
        expect(isSubscriptionUpdateCandidate('free', 'monthly')).toBe(false);
        expect(isSubscriptionUpdateCandidate('starter', 'lifetime')).toBe(false);
        expect(isSubscriptionUpdateCandidate('starter', 'monthly')).toBe(true);
    });

    test('buildPortalSubscriptionUpdateParams includes subscription_update_confirm flow', () => {
        const { buildPortalSubscriptionUpdateParams } = load();
        const params = buildPortalSubscriptionUpdateParams({
            stripeCustomerId: 'cus_test_001',
            subscriptionId: 'sub_test_001',
            subscriptionItemId: 'si_test_001',
            newPriceId: 'price_pro_monthly',
            baseUrl: 'https://mockupscripter.com',
        });
        const encoded = params.toString();
        expect(encoded).toContain('flow_data%5Btype%5D=subscription_update_confirm');
        expect(encoded).toContain('sub_test_001');
        expect(encoded).toContain('si_test_001');
        expect(encoded).toContain('price_pro_monthly');
        expect(encoded).toContain('payment%3Dsuccess');
    });
});
