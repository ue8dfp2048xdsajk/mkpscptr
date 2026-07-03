(function () {

    var currentPeriod = 'monthly';

    var MODAL_COPY = {
        full: {
            title: 'Choose your plan',
            subtitle: 'Upgrade anytime. No hidden fees.',
        },
        starter: {
            title: 'Upgrade your plan',
            subtitle: 'Switch billing period or upgrade to Pro.',
        },
        pro: {
            title: 'Change billing',
            subtitle: 'Switch to a longer billing period anytime.',
        },
    };

    function _billingUtils() {
        return window._billingPeriodUtils || {};
    }

    function _resolveLayout(opts) {
        if (opts && opts.layout) return opts.layout;
        var plan = (window._userPlan || 'free').toLowerCase();
        var utils = _billingUtils();
        if (utils.modalLayoutForPlan) return utils.modalLayoutForPlan(plan);
        if (plan === 'pro') return 'pro';
        if (plan === 'starter') return 'starter';
        return 'full';
    }

    function _applyModalLayout(layout) {
        var copy = MODAL_COPY[layout] || MODAL_COPY.full;
        var titleEl = document.getElementById('plansModalTitle');
        var subtitleEl = document.querySelector('.ms-plans-subtitle');
        var grid = document.querySelector('.ms-plans-grid');

        if (titleEl) titleEl.textContent = copy.title;
        if (subtitleEl) subtitleEl.textContent = copy.subtitle;

        if (grid) {
            grid.classList.remove('ms-plans-grid--cols-2', 'ms-plans-grid--cols-1');
            if (layout === 'starter') grid.classList.add('ms-plans-grid--cols-2');
            else if (layout === 'pro') grid.classList.add('ms-plans-grid--cols-1');
        }

        document.querySelectorAll('.ms-plan-card').forEach(function (card) {
            var cardPlan = card.dataset.plan || '';
            var show = true;
            if (layout === 'starter' && cardPlan === 'free') show = false;
            if (layout === 'pro' && (cardPlan === 'free' || cardPlan === 'starter')) show = false;
            card.style.display = show ? '' : 'none';
        });
    }

    function _resetModalLayout() {
        var grid = document.querySelector('.ms-plans-grid');
        if (grid) grid.classList.remove('ms-plans-grid--cols-2', 'ms-plans-grid--cols-1');
        document.querySelectorAll('.ms-plan-card').forEach(function (card) {
            card.style.display = '';
        });
        var titleEl = document.getElementById('plansModalTitle');
        var subtitleEl = document.querySelector('.ms-plans-subtitle');
        if (titleEl) titleEl.textContent = MODAL_COPY.full.title;
        if (subtitleEl) subtitleEl.textContent = MODAL_COPY.full.subtitle;
    }

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

        _applyModalLayout(_resolveLayout(opts));

        var initialPeriod = (opts && opts.initialPeriod) || 'annual';
        setPeriod(initialPeriod);

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
        _resetModalLayout();
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

        document.querySelectorAll('[data-lifetime-only]').forEach(function (el) {
            el.style.display = (period === 'lifetime') ? '' : 'none';
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
            if (card.style.display === 'none') return;
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
        var userBillingPeriod = window._userBillingPeriod || null;
        var rank = { free: 0, starter: 1, pro: 2 };
        var utils = _billingUtils();
        prices = prices || _configuredPrices || {};

        document.querySelectorAll('.ms-plan-card').forEach(function (card) {
            if (card.style.display === 'none') return;
            var btn = card.querySelector('.ms-plan-cta');
            var cardPlan = card.dataset.plan || 'free';
            if (!btn) return;

            if (cardPlan === 'free') {
                btn.textContent = plan === 'free' ? 'Current plan' : 'Downgrade';
                btn.disabled = true;
                btn.className = 'ms-plan-cta ms-plan-cta--current';
                return;
            }

            var userRank = rank[plan] || 0;
            var cardRank = rank[cardPlan] || 0;

            if (userRank > cardRank) {
                btn.textContent = 'Included';
                btn.disabled = true;
                btn.className = 'ms-plan-cta ms-plan-cta--current';
                return;
            }

            if (userRank < cardRank) {
                var upgradeCombo = cardPlan + '_' + currentPeriod;
                var upgradeAvailable = Object.keys(prices).length === 0 || prices[upgradeCombo] !== false;
                if (!upgradeAvailable) {
                    btn.disabled = true;
                    btn.textContent = 'Not available';
                    btn.className = 'ms-plan-cta ms-plan-cta--current';
                } else {
                    btn.disabled = false;
                    btn.textContent = 'Upgrade to ' + cardPlan.charAt(0).toUpperCase() + cardPlan.slice(1);
                    btn.className = 'ms-plan-cta ms-plan-cta--pro';
                }
                return;
            }

            if (userRank === cardRank && plan !== 'free') {
                if (utils.isCurrentPlanCombo && utils.isCurrentPlanCombo(plan, userBillingPeriod, cardPlan, currentPeriod)) {
                    btn.textContent = 'Current plan';
                    btn.disabled = true;
                    btn.className = 'ms-plan-cta ms-plan-cta--current';
                    return;
                }
                if (utils.isPeriodDowngrade && utils.isPeriodDowngrade(userBillingPeriod, currentPeriod)) {
                    btn.textContent = 'Current plan';
                    btn.disabled = true;
                    btn.className = 'ms-plan-cta ms-plan-cta--current';
                    return;
                }
                var switchCombo = cardPlan + '_' + currentPeriod;
                var switchAvailable = Object.keys(prices).length === 0 || prices[switchCombo] !== false;
                if (!switchAvailable) {
                    btn.disabled = true;
                    btn.textContent = 'Not available';
                    btn.className = 'ms-plan-cta ms-plan-cta--current';
                } else {
                    btn.disabled = false;
                    btn.textContent = (utils.periodSwitchLabel && utils.periodSwitchLabel(currentPeriod)) || 'Switch plan';
                    btn.className = 'ms-plan-cta ms-plan-cta--pro';
                }
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
                btn.className = 'ms-plan-cta ms-plan-cta--pro';
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
            if (e.key !== 'Escape') return;
            var modal = document.getElementById('plansModal');
            if (!modal || !modal.classList.contains('ms-plans-overlay--open')) return;
            e.preventDefault();
            e.stopPropagation();
            closePlansModal();
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
