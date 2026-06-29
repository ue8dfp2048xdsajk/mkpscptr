(function () {

    var currentPeriod = 'monthly';

    function openPlansModal() {
        var modal = document.getElementById('plansModal');
        if (!modal) return;
        _syncPlanButtons();
        modal.classList.add('ms-plans-overlay--open');
        document.body.style.overflow = 'hidden';
    }

    function closePlansModal() {
        var modal = document.getElementById('plansModal');
        if (!modal) return;
        modal.classList.remove('ms-plans-overlay--open');
        document.body.style.overflow = '';
    }

    function setPeriod(period) {
        currentPeriod = period;

        document.querySelectorAll('.ms-billing-tab').forEach(function (tab) {
            tab.classList.toggle('active', tab.dataset.period === period);
        });

        document.querySelectorAll('.ms-plan-amount[data-' + period + ']').forEach(function (el) {
            el.textContent = el.getAttribute('data-' + period) || '';
        });

        document.querySelectorAll('.ms-plan-period[data-' + period + ']').forEach(function (el) {
            el.textContent = el.getAttribute('data-' + period) || '';
        });

        document.querySelectorAll('.ms-plan-billing-note[data-' + period + ']').forEach(function (el) {
            el.textContent = el.getAttribute('data-' + period) || '';
        });

        document.querySelectorAll('.ms-plan-cta[data-plan]').forEach(function (btn) {
            btn.dataset.period = period;
        });
    }

    function _syncPlanButtons() {
        var plan = (window._userPlan || 'free').toLowerCase();
        var rank = { free: 0, starter: 1, pro: 2 };

        document.querySelectorAll('.ms-plan-card').forEach(function (card) {
            var btn = card.querySelector('.ms-plan-cta');
            var cardPlan = card.dataset.plan || 'free';
            if (!btn) return;

            if (cardPlan === 'free') {
                btn.textContent = plan === 'free' ? 'Current plan' : 'Downgrade';
                btn.disabled = true;
                btn.className = 'ms-plan-cta ms-plan-cta--current';
                return;
            }

            if ((rank[plan] || 0) >= (rank[cardPlan] || 0) && plan !== 'free') {
                btn.textContent = plan === cardPlan ? 'Current plan' : 'Current plan';
                btn.disabled = true;
                btn.className = 'ms-plan-cta ms-plan-cta--current';
            } else {
                btn.disabled = false;
                btn.textContent = 'Upgrade to ' + cardPlan.charAt(0).toUpperCase() + cardPlan.slice(1);
                btn.className = 'ms-plan-cta ' + (cardPlan === 'pro' ? 'ms-plan-cta--pro' : 'ms-plan-cta--upgrade');
            }
        });
    }

    function init() {
        var modal = document.getElementById('plansModal');
        if (!modal) return;

        modal.addEventListener('click', function (e) {
            if (e.target === modal) closePlansModal();
        });

        var closeBtn = document.getElementById('plansModalClose');
        if (closeBtn) closeBtn.addEventListener('click', closePlansModal);

        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') closePlansModal();
        });

        document.querySelectorAll('.ms-billing-tab').forEach(function (tab) {
            tab.addEventListener('click', function () {
                setPeriod(tab.dataset.period);
            });
        });

        document.querySelectorAll('.ms-plan-cta[data-plan]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var plan = btn.dataset.plan;
                var period = btn.dataset.period || 'monthly';
                closePlansModal();
                if (typeof _startCheckout === 'function') {
                    _startCheckout(plan, period);
                }
            });
        });

        setPeriod('monthly');
    }

    window.openPlansModal = openPlansModal;
    window.closePlansModal = closePlansModal;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
