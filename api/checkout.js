const { setCorsHeaders, handleOptions } = require('./_cors');

const PRICE_MAP = {
    starter_monthly:  process.env.STRIPE_PRICE_STARTER_MONTHLY,
    starter_annual:   process.env.STRIPE_PRICE_STARTER_ANNUAL,
    starter_lifetime: process.env.STRIPE_PRICE_STARTER_LIFETIME,
    pro_monthly:      process.env.STRIPE_PRICE_PRO_MONTHLY,
    pro_annual:       process.env.STRIPE_PRICE_PRO_ANNUAL,
    pro_lifetime:     process.env.STRIPE_PRICE_PRO_LIFETIME,
};

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

    const { plan, period = 'monthly', clerkUserId } = body || {};

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

    const isLifetime = period === 'lifetime';
    const mode = isLifetime ? 'payment' : 'subscription';

    const origin = req.headers.origin || 'https://mockupscripter.com';
    const successUrl = `${origin}/?payment=success`;
    const cancelUrl  = `${origin}/`;

    const params = new URLSearchParams();
    params.set('mode', mode);
    params.set('success_url', successUrl);
    params.set('cancel_url', cancelUrl);
    params.set('line_items[0][price]', priceId);
    params.set('line_items[0][quantity]', '1');
    if (!isLifetime) {
        params.set('allow_promotion_codes', 'true');
    }
    if (clerkUserId && typeof clerkUserId === 'string') {
        params.set('client_reference_id', clerkUserId);
    }
    params.set('metadata[plan]', plan);

    let stripeRes;
    try {
        stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${stripeSecretKey}`,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: params.toString(),
        });
    } catch (err) {
        return res.status(502).json({ ok: false, error: 'Failed to reach Stripe API' });
    }

    const stripeData = await stripeRes.json();
    if (!stripeRes.ok) {
        return res.status(502).json({ ok: false, error: stripeData.error?.message || 'Stripe API error' });
    }

    return res.status(200).json({ ok: true, url: stripeData.url });
};
