/**
 * @jest-environment jsdom
 *
 * Tests that plan upgrade buttons are disabled (btn.disabled === true) between
 * modal open and fetch resolution, and that the HTML disabled attribute makes
 * them click-proof regardless of any CSS override (pointer-events, opacity, etc.).
 *
 * Relevant source: js/plans-modal.js - openPlansModal, _setButtonsLoading, _syncPlanButtons
 */

'use strict';

function buildDOM() {
    document.body.innerHTML = `
      <div id="plansModal">
        <button id="plansModalClose">X</button>
        <div id="plansModalNotice" style="display:none">
          <span id="plansModalNoticeText"></span>
        </div>
        <button id="plansModalSkipBtn" style="display:none">Skip</button>
        <div class="ms-billing-tab active" data-period="monthly">Monthly</div>
        <div class="ms-billing-tab" data-period="annual">Annual</div>
        <div class="ms-plan-card" data-plan="free">
          <button class="ms-plan-cta" data-plan="free">Free</button>
        </div>
        <div class="ms-plan-card" data-plan="starter">
          <button class="ms-plan-cta" data-plan="starter" data-period="monthly">Upgrade to Starter</button>
        </div>
        <div class="ms-plan-card" data-plan="pro">
          <button class="ms-plan-cta" data-plan="pro" data-period="monthly">Upgrade to Pro</button>
        </div>
      </div>
    `;
}

describe('plans-modal - button disabled state during and after fetch', () => {
    let resolveFetch;

    beforeEach(() => {
        jest.resetModules();
        buildDOM();

        global.fetch = jest.fn(
            () =>
                new Promise((res) => {
                    resolveFetch = res;
                }),
        );

        window._userPlan = 'free';
        global.API_BASE = '';

        require('../js/plans-modal');
    });

    afterEach(() => {
        delete global.fetch;
        delete window._userPlan;
        delete global.API_BASE;
        delete window.openPlansModal;
        delete window.closePlansModal;
    });

    test('upgrade buttons are immediately disabled after modal opens, before fetch resolves', () => {
        window.openPlansModal();

        const starterBtn = document.querySelector('.ms-plan-card[data-plan="starter"] .ms-plan-cta');
        const proBtn = document.querySelector('.ms-plan-card[data-plan="pro"] .ms-plan-cta');

        expect(starterBtn.disabled).toBe(true);
        expect(proBtn.disabled).toBe(true);
        expect(starterBtn.textContent).toBe('Loading\u2026');
        expect(proBtn.textContent).toBe('Loading\u2026');
    });

    test('upgrade buttons carry the HTML disabled attribute, making them click-proof regardless of CSS', () => {
        window.openPlansModal();

        const starterBtn = document.querySelector('.ms-plan-card[data-plan="starter"] .ms-plan-cta');
        const proBtn = document.querySelector('.ms-plan-card[data-plan="pro"] .ms-plan-cta');

        expect(starterBtn.hasAttribute('disabled')).toBe(true);
        expect(proBtn.hasAttribute('disabled')).toBe(true);

        let clickFired = false;
        starterBtn.addEventListener('click', () => {
            clickFired = true;
        });

        starterBtn.click();
        expect(clickFired).toBe(false);
    });

    test('upgrade buttons become enabled after fetch resolves with available prices', async () => {
        window.openPlansModal();

        const starterBtn = document.querySelector('.ms-plan-card[data-plan="starter"] .ms-plan-cta');
        const proBtn = document.querySelector('.ms-plan-card[data-plan="pro"] .ms-plan-cta');

        expect(starterBtn.disabled).toBe(true);
        expect(proBtn.disabled).toBe(true);

        resolveFetch({
            ok: true,
            json: () =>
                Promise.resolve({
                    prices: {
                        starter_monthly: 'price_starter',
                        starter_annual: 'price_starter_annual',
                        pro_monthly: 'price_pro',
                        pro_annual: 'price_pro_annual',
                    },
                }),
        });

        await new Promise((r) => setTimeout(r, 0));

        expect(starterBtn.disabled).toBe(false);
        expect(proBtn.disabled).toBe(false);
        expect(starterBtn.textContent).toMatch(/upgrade/i);
        expect(proBtn.textContent).toMatch(/upgrade/i);
    });

    test('upgrade buttons stay disabled (not available) after fetch resolves with prices set to false', async () => {
        window.openPlansModal();

        const starterBtn = document.querySelector('.ms-plan-card[data-plan="starter"] .ms-plan-cta');
        const proBtn = document.querySelector('.ms-plan-card[data-plan="pro"] .ms-plan-cta');

        expect(starterBtn.disabled).toBe(true);
        expect(proBtn.disabled).toBe(true);

        resolveFetch({
            ok: true,
            json: () =>
                Promise.resolve({
                    prices: {
                        starter_monthly: false,
                        starter_annual: false,
                        pro_monthly: false,
                        pro_annual: false,
                    },
                }),
        });

        await new Promise((r) => setTimeout(r, 0));

        expect(starterBtn.disabled).toBe(true);
        expect(proBtn.disabled).toBe(true);
        expect(starterBtn.textContent).toBe('Not available');
        expect(proBtn.textContent).toBe('Not available');
    });

    test('upgrade buttons become enabled after a failed fetch (graceful fallback - treat all prices as available)', async () => {
        window.openPlansModal();

        const starterBtn = document.querySelector('.ms-plan-card[data-plan="starter"] .ms-plan-cta');
        expect(starterBtn.disabled).toBe(true);

        resolveFetch({
            ok: false,
            json: () => Promise.resolve(null),
        });

        await new Promise((r) => setTimeout(r, 0));

        expect(starterBtn.disabled).toBe(false);
        expect(starterBtn.textContent).toMatch(/upgrade/i);
    });

    test('free plan button remains disabled throughout (it is never an upgrade target)', () => {
        window.openPlansModal();

        const freeBtn = document.querySelector('.ms-plan-card[data-plan="free"] .ms-plan-cta');

        expect(freeBtn.disabled).toBe(true);
    });
});
