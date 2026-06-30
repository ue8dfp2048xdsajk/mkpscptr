const { setCorsHeaders, handleOptions } = require('../_cors');
const { verifyClerkToken } = require('../_verify-clerk-token');

module.exports = async function handler(req, res) {
    setCorsHeaders(req, res);
    if (handleOptions(req, res)) return;

    if (req.method !== 'POST') {
        return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }

    const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeSecretKey) {
        return res.status(500).json({ ok: false, error: 'Stripe not configured' });
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

    const clerkSecretKey = process.env.CLERK_SECRET_KEY;
    let stripeCustomerId;
    if (clerkSecretKey) {
        try {
            const r = await fetch(
                `https://api.clerk.com/v1/users/${encodeURIComponent(clerkUserId)}`,
                { headers: { Authorization: `Bearer ${clerkSecretKey}` } }
            );
            if (r.ok) {
                const d = await r.json();
                stripeCustomerId = d?.public_metadata?.stripeCustomerId;
            }
        } catch {}
    }

    if (!stripeCustomerId) {
        return res.status(404).json({
            ok: false,
            error: 'No billing account found. Please make a purchase first.',
        });
    }

    const origin = req.headers.origin || 'https://mockupscripter.com';

    const params = new URLSearchParams();
    params.set('customer', stripeCustomerId);
    params.set('return_url', `${origin}/`);

    let portalRes;
    try {
        portalRes = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${stripeSecretKey}`,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: params.toString(),
        });
    } catch {
        return res.status(502).json({ ok: false, error: 'Failed to reach Stripe API' });
    }

    const data = await portalRes.json();
    if (!portalRes.ok) {
        return res.status(502).json({
            ok: false,
            error: data.error?.message || 'Stripe portal error',
        });
    }

    return res.status(200).json({ ok: true, url: data.url });
};
