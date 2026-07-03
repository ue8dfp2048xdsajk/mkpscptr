'use strict';

const PLAN_RANK = { free: 0, starter: 1, pro: 2 };
const PERIOD_RANK = { monthly: 1, annual: 2, lifetime: 3 };

function getPriceEntries() {
    return {
        starter_monthly:  process.env.STRIPE_PRICE_STARTER_MONTHLY,
        starter_annual:   process.env.STRIPE_PRICE_STARTER_ANNUAL,
        starter_lifetime: process.env.STRIPE_PRICE_STARTER_LIFETIME,
        pro_monthly:      process.env.STRIPE_PRICE_PRO_MONTHLY,
        pro_annual:       process.env.STRIPE_PRICE_PRO_ANNUAL,
        pro_lifetime:     process.env.STRIPE_PRICE_PRO_LIFETIME,
    };
}

function getPriceId(planKey) {
    return getPriceEntries()[planKey] || null;
}

function getPlanRank(plan) {
    return PLAN_RANK[(plan || 'free').toLowerCase()] ?? 0;
}

function resolvePriceId(priceId) {
    if (!priceId) return null;
    for (const [key, id] of Object.entries(getPriceEntries())) {
        if (id && id === priceId) {
            const underscore = key.lastIndexOf('_');
            return {
                plan: key.slice(0, underscore),
                period: key.slice(underscore + 1),
            };
        }
    }
    return null;
}

function getPlanFromPriceId(priceId) {
    const resolved = resolvePriceId(priceId);
    return resolved ? resolved.plan : null;
}

function getPriceMap() {
    const map = {};
    for (const [key, id] of Object.entries(getPriceEntries())) {
        if (!id) continue;
        const underscore = key.lastIndexOf('_');
        map[id] = key.slice(0, underscore);
    }
    return map;
}

function isCheckoutBlocked(currentPlan, currentPeriod, requestedPlan, requestedPeriod) {
    const currentRank = getPlanRank(currentPlan);
    const requestedRank = getPlanRank(requestedPlan);
    if (currentRank === 0) return false;
    if (requestedRank < currentRank) return true;
    if (requestedRank > currentRank) return false;

    const reqPeriod = (requestedPeriod || 'monthly').toLowerCase();
    const curPeriod = currentPeriod ? String(currentPeriod).toLowerCase() : null;
    if (!curPeriod) {
        return reqPeriod === 'monthly';
    }
    return curPeriod === reqPeriod;
}

async function stripeApiGet(stripeSecretKey, path) {
    const res = await fetch(`https://api.stripe.com/v1/${path}`, {
        headers: { Authorization: `Bearer ${stripeSecretKey}` },
        signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error?.message || `Stripe HTTP ${res.status}`);
    }
    return res.json();
}

async function stripeApiPost(stripeSecretKey, path, params) {
    const res = await fetch(`https://api.stripe.com/v1/${path}`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${stripeSecretKey}`,
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
        signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error?.message || `Stripe HTTP ${res.status}`);
    }
    return res.json();
}

async function stripeApiDelete(stripeSecretKey, path) {
    const res = await fetch(`https://api.stripe.com/v1/${path}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${stripeSecretKey}` },
        signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error?.message || `Stripe HTTP ${res.status}`);
    }
    return res.json();
}

async function customerHasActiveSubscription(stripeCustomerId, stripeSecretKey) {
    const subs = await stripeApiGet(
        stripeSecretKey,
        `subscriptions?customer=${encodeURIComponent(stripeCustomerId)}&status=active&limit=10`
    );
    return (subs.data || []).length > 0;
}

async function customerHasPaidLifetimeCheckout(stripeCustomerId, stripeSecretKey) {
    const sessions = await stripeApiGet(
        stripeSecretKey,
        `checkout/sessions?customer=${encodeURIComponent(stripeCustomerId)}&limit=100`
    );
    for (const session of sessions.data || []) {
        if (session.payment_status === 'paid' && session.mode === 'payment') {
            return true;
        }
    }
    return false;
}

async function shouldDowngradeToFree(stripeCustomerId, clerkUserId, clerkSecretKey, stripeSecretKey, clerkBillingPeriod) {
    if (clerkBillingPeriod === 'lifetime') return false;

    if (stripeSecretKey && stripeCustomerId) {
        try {
            if (await customerHasActiveSubscription(stripeCustomerId, stripeSecretKey)) {
                return false;
            }
            if (await customerHasPaidLifetimeCheckout(stripeCustomerId, stripeSecretKey)) {
                return false;
            }
        } catch (err) {
            console.error('stripe-prices: entitlement check failed — skipping downgrade to be safe', err);
            return false;
        }
    }

    return true;
}

async function cancelActiveSubscriptionsExcept(stripeCustomerId, keepSubscriptionId, stripeSecretKey) {
    const subs = await stripeApiGet(
        stripeSecretKey,
        `subscriptions?customer=${encodeURIComponent(stripeCustomerId)}&status=active&limit=100`
    );
    for (const sub of subs.data || []) {
        if (keepSubscriptionId && sub.id === keepSubscriptionId) continue;
        try {
            await stripeApiDelete(
                stripeSecretKey,
                `subscriptions/${encodeURIComponent(sub.id)}`
            );
            console.log(`stripe-prices: canceled subscription ${sub.id} for customer ${stripeCustomerId}`);
        } catch (err) {
            console.error(`stripe-prices: failed to cancel subscription ${sub.id}`, err);
            throw err;
        }
    }
}

module.exports = {
    PLAN_RANK,
    PERIOD_RANK,
    getPriceEntries,
    getPriceId,
    getPlanRank,
    resolvePriceId,
    getPlanFromPriceId,
    getPriceMap,
    isCheckoutBlocked,
    shouldDowngradeToFree,
    cancelActiveSubscriptionsExcept,
};
