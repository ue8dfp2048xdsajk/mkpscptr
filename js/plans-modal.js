(function () {

    var currentPeriod = 'monthly';

    function openPlansModal(opts) {
        var modal = document.getElementById('plansModal');
        if (!modal) return;

        var notice   = document.getElementById('plansModalNotice');
        var noticeTxt = document.getElementById('plansModalNoticeText');
        var skipBtn  = document.getElementById('plansModalSkipBtn');

        if (opts && opts.context && notice && noticeTxt) {
            noticeTxt.textContent = opts.context;
            notice.style.display = 'block';
        } else if (notice) {
            notice.style.display = 'none';
        }

        if (skipBtn) {
            if (opts && typeof opts.onSkip === 'function') {
                skipBtn.style.display = 'inline-block';
                var newSkip = skipBtn.cloneNode(true);
                skipBtn.parentNode.replaceChild(newSkip, skipBtn);
                newSkip.addEventListener('click', function () {
                    closePlansModal();
                    opts.onSkip();
                });
            } else {
                skipBtn.style.display = 'none';
            }
        }

        modal.classList.add('ms-plans-overlay--open');
        document.body.style.overflow = 'hidden';
        _fetchConfiguredPrices().then(function (prices) {
            _syncPlanButtons(prices);
        });
        if (_pricesLoading) {
            _setButtonsLoading();
        }
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

        if (_pricesLoading) {
            _setButtonsLoading();
        } else {
            _syncPlanButtons(_configuredPrices || {});
        }
    }

    var _configuredPrices = null;
    var _pricesLoading = false;
    var _fetchPromise = null;

    function _fetchConfiguredPrices() {
        if (_configuredPrices !== null) return Promise.resolve(_configuredPrices);
        if (_fetchPromise) return _fetchPromise;
        _pricesLoading = true;
        var base = (typeof API_BASE !== 'undefined' ? API_BASE : '').replace(/\/$/, '');
        _fetchPromise = fetch(base + '/api/admin/config-check')
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (data) {
                _configuredPrices = (data && data.prices) ? data.prices : {};
                _pricesLoading = false;
                _fetchPromise = null;
                return _configuredPrices;
            })
            .catch(function () {
                _configuredPrices = {};
                _pricesLoading = false;
                _fetchPromise = null;
                return _configuredPrices;
            });
        return _fetchPromise;
    }

    function _setButtonsLoading() {
        document.querySelectorAll('.ms-plan-card').forEach(function (card) {
            var btn = card.querySelector('.ms-plan-cta');
            var cardPlan = card.dataset.plan || 'free';
            if (!btn || cardPlan === 'free') return;
            btn.disabled = true;
            btn.textContent = 'Loading…';
            btn.className = 'ms-plan-cta ms-plan-cta--loading';
        });
    }

    function _syncPlanButtons(prices) {
        var plan = (window._userPlan || 'free').toLowerCase();
        var rank = { free: 0, starter: 1, pro: 2 };
        prices = prices || _configuredPrices || {};

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
                return;
            }

            var combo = cardPlan + '_' + currentPeriod;
            var priceAvailable = Object.keys(prices).length === 0 || prices[combo] !== false;
            if (!priceAvailable) {
                btn.disabled = true;
                btn.textContent = 'Not available';
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

        setPeriod('annual');
    }

    window.openPlansModal = openPlansModal;
    window.closePlansModal = closePlansModal;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
