/**
 * @jest-environment jsdom
 */

'use strict';

function buildDOM() {
    document.body.innerHTML = `
      <div id="plansModal">
        <h2 id="plansModalTitle">Choose your plan</h2>
        <p class="ms-plans-subtitle">Upgrade anytime. No hidden fees.</p>
        <div class="ms-billing-tab" data-period="monthly">Monthly</div>
        <div class="ms-billing-tab active" data-period="annual">Annual</div>
        <div class="ms-billing-tab" data-period="lifetime">Lifetime</div>
        <div class="ms-plans-grid">
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
        delete window.closePlansModal;
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

    test('starter user hides free card and uses 2-column grid', async () => {
        window._userPlan = 'starter';
        window._userBillingPeriod = 'monthly';
        window.openPlansModal();
        await new Promise((r) => setTimeout(r, 0));

        expect(document.getElementById('plansModalTitle').textContent).toBe('Upgrade your plan');
        expect(document.querySelector('.ms-plans-grid').classList.contains('ms-plans-grid--cols-2')).toBe(true);
        expect(document.querySelector('.ms-plan-card[data-plan="free"]').style.display).toBe('none');
        expect(document.querySelector('.ms-plan-card[data-plan="starter"]').style.display).not.toBe('none');
    });

    test('pro user hides free and starter cards and uses 1-column grid', async () => {
        window._userPlan = 'pro';
        window._userBillingPeriod = 'monthly';
        window.openPlansModal({ layout: 'pro', initialPeriod: 'annual' });
        await new Promise((r) => setTimeout(r, 0));

        expect(document.getElementById('plansModalTitle').textContent).toBe('Change billing');
        expect(document.querySelector('.ms-plans-grid').classList.contains('ms-plans-grid--cols-1')).toBe(true);
        expect(document.querySelector('.ms-plan-card[data-plan="free"]').style.display).toBe('none');
        expect(document.querySelector('.ms-plan-card[data-plan="starter"]').style.display).toBe('none');
    });

    test('closePlansModal resets hidden cards for the next open', async () => {
        window._userPlan = 'pro';
        window.openPlansModal({ layout: 'pro' });
        await new Promise((r) => setTimeout(r, 0));
        window.closePlansModal();

        expect(document.querySelector('.ms-plan-card[data-plan="free"]').style.display).toBe('');
        expect(document.querySelector('.ms-plans-grid').classList.contains('ms-plans-grid--cols-1')).toBe(false);
        expect(document.getElementById('plansModalTitle').textContent).toBe('Choose your plan');
    });
});
