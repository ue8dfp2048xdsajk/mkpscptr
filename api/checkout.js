const { setCorsHeaders, handleOptions } = require('./_cors');
const { verifyClerkToken, isConfigured: isClerkConfigured } = require('./_verify-clerk-token');
const { isRateLimited } = require('./_sliding-window');
const { getPriceId, isCheckoutBlocked } = require('./_stripe-prices');

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
    const priceId = getPriceId(planKey);
    if (!priceId) {
        return res.status(400).json({
            ok: false,
            error: `No Stripe price configured for ${planKey}. Set STRIPE_PRICE_${planKey.toUpperCase()} in environment variables.`,
        });
    }

    if (!isClerkConfigured || !process.env.CLERK_SECRET_KEY) {
        return res.status(503).json({
            ok: false,
            error: 'Authentication is not configured on this server. Please contact support.',
        });
    }

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
    let stripeCustomerId = null;
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
            const currentBillingPeriod = clerkData?.public_metadata?.billingPeriod || null;
            if (isCheckoutBlocked(currentPlan, currentBillingPeriod, plan, period)) {
                return res.status(409).json({
                    ok: false,
                    error: `You already have the ${currentPlan} plan on this billing period. No charge has been made.`,
                });
            }
            customerEmail = clerkData?.email_addresses?.[0]?.email_address || null;
            stripeCustomerId = clerkData?.public_metadata?.stripeCustomerId || null;
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

    const baseUrl = process.env.BASE_URL || 'https://mockupscripter.com';
    const successUrl = `${baseUrl}/app.html?payment=success`;
    const cancelUrl  = `${baseUrl}/app.html`;

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
    params.set('metadata[period]', period);
    if (stripeCustomerId) {
        params.set('customer', stripeCustomerId);
    } else if (customerEmail) {
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
