const { setCorsHeaders, handleOptions } = require('./_cors');
const { verifyClerkToken } = require('./_verify-clerk-token');
const { isRateLimited } = require('./_sliding-window');

const CHECKOUT_MAX        = 5;
const CHECKOUT_WINDOW_SEC = 60;

module.exports = async function handler(req, res) {
    setCorsHeaders(req, res);
    if (handleOptions(req, res)) return;

    if (req.method !== 'POST') {
        return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }

    const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeSecretKey) {
        return res.status(500).json({ ok: false, error: 'Stripe is not configured on this server' });
    }

    // Read price IDs at request time — not at module load — so that env-var
    // changes and test overrides (jest.resetModules + per-test env) are picked
    // up correctly without stale module-level values.
    const PRICE_MAP = {
        starter_monthly:  process.env.STRIPE_PRICE_STARTER_MONTHLY,
        starter_annual:   process.env.STRIPE_PRICE_STARTER_ANNUAL,
        starter_lifetime: process.env.STRIPE_PRICE_STARTER_LIFETIME,
        pro_monthly:      process.env.STRIPE_PRICE_PRO_MONTHLY,
        pro_annual:       process.env.STRIPE_PRICE_PRO_ANNUAL,
        pro_lifetime:     process.env.STRIPE_PRICE_PRO_LIFETIME,
    };

    let body;
    try {
        body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch {
        return res.status(400).json({ ok: false, error: 'Invalid JSON body' });
    }

    const { plan, period = 'monthly' } = body || {};

    if (!plan || !['starter', 'pro'].includes(plan)) {
        return res.status(400).json({ ok: false, error: 'plan must be "starter" or "pro"' });
    }
    if (!['monthly', 'annual', 'lifetime'].includes(period)) {
        return res.status(400).json({ ok: false, error: 'period must be "monthly", "annual", or "lifetime"' });
    }

    const planKey = `${plan}_${period}`;
    const priceId = PRICE_MAP[planKey];
    if (!priceId) {
        return res.status(400).json({
            ok: false,
            error: `No Stripe price configured for ${planKey}. Set STRIPE_PRICE_${planKey.toUpperCase()} in environment variables.`,
        });
    }

    // Require authentication — checkout without a verified user ID means the
    // webhook will have no client_reference_id and cannot upgrade the plan.
    let clerkUserId;
    try {
        clerkUserId = await verifyClerkToken(req.headers.authorization);
    } catch {
        return res.status(502).json({ ok: false, error: 'Could not verify session' });
    }
    if (!clerkUserId) {
        return res.status(401).json({ ok: false, error: 'Not authenticated' });
    }

    if (await isRateLimited(`ratelimit:checkout:${clerkUserId}`, CHECKOUT_MAX, CHECKOUT_WINDOW_SEC)) {
        return res.status(429).json({ ok: false, error: 'Too many checkout attempts. Please wait a moment and try again.' });
    }

    const clerkSecretKey = process.env.CLERK_SECRET_KEY;
    let customerEmail = null;
    if (clerkSecretKey) {
        let clerkRes;
        try {
            clerkRes = await fetch(`https://api.clerk.com/v1/users/${encodeURIComponent(clerkUserId)}`, {
                headers: { Authorization: `Bearer ${clerkSecretKey}` },
                signal: AbortSignal.timeout(8000),
            });
        } catch {
            return res.status(502).json({ ok: false, code: 'CLERK_UNREACHABLE', error: 'Failed to reach Clerk API' });
        }

        if (clerkRes.ok) {
            const clerkData = await clerkRes.json();
            const currentPlan = (clerkData?.public_metadata?.plan || 'free').toLowerCase();
            const PLAN_RANK = { free: 0, starter: 1, pro: 2 };
            const currentRank = PLAN_RANK[currentPlan] ?? 0;
            const requestedRank = PLAN_RANK[plan] ?? 0;
            if (currentRank >= requestedRank && currentRank > 0) {
                return res.status(409).json({
                    ok: false,
                    error: `You already have the ${currentPlan} plan. No charge has been made.`,
                });
            }
            // Pre-fill the checkout form with the user's verified email so they
            // don't have to type it, reducing abandonment and preventing a second
            // Stripe customer being created due to a mistyped email address.
            customerEmail = clerkData?.email_addresses?.[0]?.email_address || null;
        } else {
            return res.status(502).json({
                ok: false,
                code: 'CLERK_ERROR',
                error: `Could not verify your current plan (Clerk returned ${clerkRes.status}). Please try again.`,
            });
        }
    }

    const isLifetime = period === 'lifetime';
    const mode = isLifetime ? 'payment' : 'subscription';

    // Use the server-side BASE_URL — never trust the Origin request header here,
    // as it is user-controlled and would allow an attacker to set an arbitrary
    // success_url/cancel_url (open redirect after real payment).
    const baseUrl = process.env.BASE_URL || 'https://mockupscripter.com';
    const successUrl = `${baseUrl}/?payment=success`;
    const cancelUrl  = `${baseUrl}/`;

    const params = new URLSearchParams();
    params.set('mode', mode);
    params.set('success_url', successUrl);
    params.set('cancel_url', cancelUrl);
    params.set('line_items[0][price]', priceId);
    params.set('line_items[0][quantity]', '1');
    if (!isLifetime) {
        params.set('allow_promotion_codes', 'true');
    }
    params.set('client_reference_id', clerkUserId);
    params.set('metadata[plan]', plan);
    if (customerEmail) {
        params.set('customer_email', customerEmail);
    }

    let stripeRes;
    try {
        stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${stripeSecretKey}`,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: params.toString(),
            signal: AbortSignal.timeout(10000),
        });
    } catch (err) {
        return res.status(502).json({ ok: false, error: 'Failed to reach Stripe API' });
    }

    const stripeData = await stripeRes.json().catch(() => ({}));
    if (!stripeRes.ok) {
        return res.status(502).json({
            ok: false,
            code: 'STRIPE_ERROR',
            error: stripeData.error?.message || `Stripe returned status ${stripeRes.status} — please try again.`,
        });
    }

    return res.status(200).json({ ok: true, url: stripeData.url });
};
