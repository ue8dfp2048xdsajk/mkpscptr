/**
 * @jest-environment jsdom
 */

'use strict';

describe('billing-period UI helpers', () => {
    beforeEach(() => {
        require('../js/billing-period.js');
    });

    test('proPeriodAvatarLabel by billing period', () => {
        var u = window._billingPeriodUtils;
        expect(u.proPeriodAvatarLabel('monthly')).toBe('Switch to annual or lifetime');
        expect(u.proPeriodAvatarLabel(null)).toBe('Switch to annual or lifetime');
        expect(u.proPeriodAvatarLabel('annual')).toBe('Switch to lifetime');
        expect(u.proPeriodAvatarLabel('lifetime')).toBeNull();
    });

    test('defaultPeriodForProUpsell opens the right tab', () => {
        var u = window._billingPeriodUtils;
        expect(u.defaultPeriodForProUpsell('monthly')).toBe('annual');
        expect(u.defaultPeriodForProUpsell(null)).toBe('annual');
        expect(u.defaultPeriodForProUpsell('annual')).toBe('lifetime');
    });

    test('modalLayoutForPlan maps user tiers', () => {
        var u = window._billingPeriodUtils;
        expect(u.modalLayoutForPlan('free')).toBe('full');
        expect(u.modalLayoutForPlan('starter')).toBe('starter');
        expect(u.modalLayoutForPlan('pro')).toBe('pro');
    });
});
