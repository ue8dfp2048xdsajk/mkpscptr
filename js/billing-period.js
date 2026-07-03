(function () {
    var PLAN_RANK = { free: 0, starter: 1, pro: 2 };
    var PERIOD_RANK = { monthly: 1, annual: 2, lifetime: 3 };

    function normalizePeriod(period) {
        return period ? String(period).toLowerCase() : null;
    }

    function isCheckoutBlocked(currentPlan, currentPeriod, requestedPlan, requestedPeriod) {
        var currentRank = PLAN_RANK[(currentPlan || 'free').toLowerCase()] || 0;
        var requestedRank = PLAN_RANK[(requestedPlan || 'free').toLowerCase()] || 0;
        if (currentRank === 0) return false;
        if (requestedRank < currentRank) return true;
        if (requestedRank > currentRank) return false;

        var reqPeriod = normalizePeriod(requestedPeriod) || 'monthly';
        var curPeriod = normalizePeriod(currentPeriod);
        if (!curPeriod) {
            return reqPeriod === 'monthly';
        }
        return curPeriod === reqPeriod;
    }

    function isCurrentPlanCombo(userPlan, userBillingPeriod, cardPlan, tabPeriod) {
        if ((userPlan || 'free').toLowerCase() !== (cardPlan || '').toLowerCase()) return false;
        var bp = normalizePeriod(userBillingPeriod);
        var tab = normalizePeriod(tabPeriod) || 'monthly';
        if (!bp) return tab === 'monthly';
        return bp === tab;
    }

    function isPeriodDowngrade(userBillingPeriod, tabPeriod) {
        var cur = PERIOD_RANK[normalizePeriod(userBillingPeriod) || 'monthly'] || 1;
        var tab = PERIOD_RANK[normalizePeriod(tabPeriod) || 'monthly'] || 1;
        return tab < cur;
    }

    function periodSwitchLabel(tabPeriod) {
        if (tabPeriod === 'annual') return 'Switch to annual';
        if (tabPeriod === 'lifetime') return 'Get lifetime';
        if (tabPeriod === 'monthly') return 'Switch to monthly';
        return 'Switch plan';
    }

    function modalLayoutForPlan(plan) {
        var p = (plan || 'free').toLowerCase();
        if (p === 'pro') return 'pro';
        if (p === 'starter') return 'starter';
        return 'full';
    }

    function proPeriodAvatarLabel(billingPeriod) {
        var bp = normalizePeriod(billingPeriod) || 'monthly';
        if (bp === 'lifetime') return null;
        if (bp === 'annual') return 'Switch to lifetime';
        return 'Switch to annual or lifetime';
    }

    function defaultPeriodForProUpsell(billingPeriod) {
        var bp = normalizePeriod(billingPeriod) || 'monthly';
        if (bp === 'annual') return 'lifetime';
        return 'annual';
    }

    window._billingPeriodUtils = {
        isCheckoutBlocked: isCheckoutBlocked,
        isCurrentPlanCombo: isCurrentPlanCombo,
        isPeriodDowngrade: isPeriodDowngrade,
        periodSwitchLabel: periodSwitchLabel,
        modalLayoutForPlan: modalLayoutForPlan,
        proPeriodAvatarLabel: proPeriodAvatarLabel,
        defaultPeriodForProUpsell: defaultPeriodForProUpsell,
    };
})();
