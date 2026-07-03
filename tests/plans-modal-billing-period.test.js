/**
 * @jest-environment jsdom
 */

'use strict';

function buildDOM() {
    document.body.innerHTML = `
      <div id="plansModal">
        <div class="ms-billing-tab" data-period="monthly">Monthly</div>
        <div class="ms-billing-tab active" data-period="annual">Annual</div>
        <div class="ms-billing-tab" data-period="lifetime">Lifetime</div>
        <div class="ms-plan-card" data-plan="free">
          <button class="ms-plan-cta" data-plan="free">Free</button>
        </div>
        <div class="ms-plan-card" data-plan="starter">
          <button class="ms-plan-cta" data-plan="starter" data-period="annual">Upgrade</button>
        </div>
        <div class="ms-plan-card" data-plan="pro">
          <button class="ms-plan-cta" data-plan="pro" data-period="annual">Upgrade</button>
        </div>
      </div>
    `;
}

describe('plans-modal — billing period button states', () => {
    beforeEach(() => {
        jest.resetModules();
        buildDOM();
        global.fetch = jest.fn(() =>
            Promise.resolve({
                ok: true,
                json: () =>
                    Promise.resolve({
                        prices: {
                            starter_monthly: 'p1',
                            starter_annual: 'p2',
                            starter_lifetime: 'p3',
                            pro_monthly: 'p4',
                            pro_annual: 'p5',
                            pro_lifetime: 'p6',
                        },
                    }),
            })
        );
        global.API_BASE = '';
        require('../js/billing-period.js');
        require('../js/plans-modal.js');
    });

    afterEach(() => {
        delete global.fetch;
        delete global.API_BASE;
        delete window._userPlan;
        delete window._userBillingPeriod;
        delete window.openPlansModal;
    });

    function syncStarterAnnual() {
        document.querySelector('.ms-billing-tab[data-period="annual"]').click();
    }

    test('starter monthly user sees Switch to annual on annual tab', async () => {
        window._userPlan = 'starter';
        window._userBillingPeriod = 'monthly';
        window.openPlansModal();
        await new Promise((r) => setTimeout(r, 0));
        syncStarterAnnual();

        const btn = document.querySelector('.ms-plan-card[data-plan="starter"] .ms-plan-cta');
        expect(btn.disabled).toBe(false);
        expect(btn.textContent).toBe('Switch to annual');
    });

    test('starter monthly user sees Get lifetime on lifetime tab', async () => {
        window._userPlan = 'starter';
        window._userBillingPeriod = 'monthly';
        window.openPlansModal();
        await new Promise((r) => setTimeout(r, 0));
        document.querySelector('.ms-billing-tab[data-period="lifetime"]').click();

        const btn = document.querySelector('.ms-plan-card[data-plan="starter"] .ms-plan-cta');
        expect(btn.disabled).toBe(false);
        expect(btn.textContent).toBe('Get lifetime');
    });

    test('starter monthly user sees Current plan on monthly tab', async () => {
        window._userPlan = 'starter';
        window._userBillingPeriod = 'monthly';
        window.openPlansModal();
        await new Promise((r) => setTimeout(r, 0));
        document.querySelector('.ms-billing-tab[data-period="monthly"]').click();

        const btn = document.querySelector('.ms-plan-card[data-plan="starter"] .ms-plan-cta');
        expect(btn.disabled).toBe(true);
        expect(btn.textContent).toBe('Current plan');
    });

    test('starter monthly user can still upgrade to pro on annual tab', async () => {
        window._userPlan = 'starter';
        window._userBillingPeriod = 'monthly';
        window.openPlansModal();
        await new Promise((r) => setTimeout(r, 0));
        syncStarterAnnual();

        const btn = document.querySelector('.ms-plan-card[data-plan="pro"] .ms-plan-cta');
        expect(btn.disabled).toBe(false);
        expect(btn.textContent).toMatch(/Upgrade to Pro/i);
    });
});
