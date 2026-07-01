const { setCorsHeaders, handleOptions } = require('../_cors');
const { verifyClerkToken } = require('../_verify-clerk-token');

// Per-user rate limit: max 10 billing requests per minute (in-memory)
const _billingHits = new Map();
const BILLING_WINDOW_MS = 60_000;
const BILLING_MAX = 10;
function billingRateLimited(userId) {
    const now = Date.now();
    const cutoff = now - BILLING_WINDOW_MS;
    const hits = (_billingHits.get(userId) || []).filter(t => t > cutoff);
    if (hits.length >= BILLING_MAX) return true;
    hits.push(now);
    _billingHits.set(userId, hits);
    return false;
}

// Resolve the Stripe customer ID for a Clerk user from their Clerk public_metadata.
// The stripeCustomerId is stored there by the webhook when checkout.session.completed
// fires. We do NOT fall back to an email-based Stripe search — that lookup can
// resolve to a different customer with the same email address, which would expose
// another user's invoices or let them manage an unrelated subscription via the portal.
async function resolveStripeCustomer(clerkUserId, clerkSecretKey) {
    if (!clerkSecretKey) return null;
    try {
        const r = await fetch(
            `https://api.clerk.com/v1/users/${encodeURIComponent(clerkUserId)}`,
            { headers: { Authorization: `Bearer ${clerkSecretKey}` } }
        );
        if (!r.ok) return null;
        const d = await r.json();
        return d?.public_metadata?.stripeCustomerId || null;
    } catch {
        return null;
    }
}

async function handleInvoices(req, res, stripeCustomerId, stripeSecretKey) {
    if (req.method !== 'GET') {
        return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }

    let invoiceRes;
    try {
        invoiceRes = await fetch(
            `https://api.stripe.com/v1/invoices?customer=${encodeURIComponent(stripeCustomerId)}&limit=100&status=paid`,
            { headers: { Authorization: `Bearer ${stripeSecretKey}` } }
        );
    } catch {
        return res.status(502).json({ ok: false, error: 'Failed to reach Stripe API' });
    }

    const invData = await invoiceRes.json();
    if (!invoiceRes.ok) {
        return res.status(502).json({ ok: false, error: invData.error?.message || 'Stripe error' });
    }

    const invoices = (invData.data || []).map(inv => ({
        id: inv.id,
        date: inv.created,
        amount: inv.amount_paid,
        currency: inv.currency,
        pdfUrl: inv.invoice_pdf || null,
        hostedUrl: inv.hosted_invoice_url || null,
    }));

    return res.status(200).json({ ok: true, invoices });
}

async function handlePortal(req, res, stripeCustomerId, stripeSecretKey) {
    if (req.method !== 'POST') {
        return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }

    // Use server-side BASE_URL — never trust the Origin header here, as it is
    // user-controlled and would constitute an open redirect after portal actions.
    const baseUrl = process.env.BASE_URL || 'https://mockupscripter.com';
    const params = new URLSearchParams();
    params.set('customer', stripeCustomerId);
    params.set('return_url', `${baseUrl}/`);

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
        return res.status(502).json({ ok: false, error: data.error?.message || 'Stripe portal error' });
    }

    return res.status(200).json({ ok: true, url: data.url });
}

module.exports = async function handler(req, res) {
    setCorsHeaders(req, res);
    if (handleOptions(req, res)) return;

    const { action } = req.query;

    if (action !== 'invoices' && action !== 'portal') {
        return res.status(404).json({ ok: false, error: 'Not found' });
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

    if (billingRateLimited(clerkUserId)) {
        return res.status(429).json({ ok: false, error: 'Too many requests. Please wait before trying again.' });
    }

    const clerkSecretKey = process.env.CLERK_SECRET_KEY;
    const stripeCustomerId = await resolveStripeCustomer(clerkUserId, clerkSecretKey);

    if (action === 'invoices') {
        if (!stripeCustomerId) {
            return res.status(200).json({ ok: true, invoices: [] });
        }
        return handleInvoices(req, res, stripeCustomerId, stripeSecretKey);
    }

    if (action === 'portal') {
        if (!stripeCustomerId) {
            return res.status(404).json({
                ok: false,
                error: 'No billing account found. Please make a purchase first.',
            });
        }
        return handlePortal(req, res, stripeCustomerId, stripeSecretKey);
    }
};
