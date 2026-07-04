const { setCorsHeaders, handleOptions } = require('../_cors');
const { verifyClerkToken } = require('../_verify-clerk-token');
const { isRateLimited } = require('../_sliding-window');

const BILLING_MAX        = 10;
const BILLING_WINDOW_SEC = 60;

// Resolve the Stripe customer ID for a Clerk user from their Clerk public_metadata.
// Returns { customerId, error } where:
//   customerId - the Stripe customer ID, or null if none is stored
//   error      - non-null string if Clerk was unreachable or returned an error,
//                so callers can distinguish "no account" from "Clerk is down"
//
// We do NOT fall back to an email-based Stripe search - that lookup can
// resolve to a different customer with the same email address, exposing
// another user's invoices or granting portal access to an unrelated subscription.
async function resolveStripeCustomer(clerkUserId, clerkSecretKey) {
    if (!clerkSecretKey) return { customerId: null, error: null };
    let customerId = null;
    try {
        const r = await fetch(
            `https://api.clerk.com/v1/users/${encodeURIComponent(clerkUserId)}`,
            {
                headers: { Authorization: `Bearer ${clerkSecretKey}` },
                signal: AbortSignal.timeout(8000),
            }
        );
        if (!r.ok) {
            return { customerId: null, error: `Clerk returned ${r.status}` };
        }
        const d = await r.json();
        customerId = d?.public_metadata?.stripeCustomerId || null;
    } catch {
        return { customerId: null, error: 'Clerk unreachable' };
    }

    // Clerk metadata may be missing stripeCustomerId if the post-checkout
    // storeStripeCustomerInClerk write failed transiently.  Fall back to the
    // authoritative MongoDB customers collection so paying users can always
    // reach their billing portal and invoice history.
    if (!customerId) {
        try {
            const { getDb } = require('../_db');
            const db = await getDb();
            const doc = await db.collection('customers').findOne(
                { clerkUserId },
                { projection: { stripeCustomerId: 1 } }
            );
            customerId = doc?.stripeCustomerId || null;
        } catch {
            // Non-fatal - if MongoDB is also unavailable, return null (no customer found).
        }
    }

    return { customerId, error: null };
}

async function handleInvoices(req, res, stripeCustomerId, stripeSecretKey) {
    if (req.method !== 'GET') {
        return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }

    let invoiceRes;
    try {
        invoiceRes = await fetch(
            `https://api.stripe.com/v1/invoices?customer=${encodeURIComponent(stripeCustomerId)}&limit=100&status=paid`,
            {
                headers: { Authorization: `Bearer ${stripeSecretKey}` },
                signal: AbortSignal.timeout(8000),
            }
        );
    } catch {
        return res.status(502).json({ ok: false, error: 'Failed to reach Stripe API' });
    }

    const invData = await invoiceRes.json().catch(() => ({}));
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

    // Use server-side BASE_URL - never trust the Origin header here, as it is
    // user-controlled and would constitute an open redirect after portal actions.
    const baseUrl = process.env.BASE_URL || 'https://mockuprabbit.com';
    const params = new URLSearchParams();
    params.set('customer', stripeCustomerId);
    params.set('return_url', `${baseUrl}/app.html`);

    let portalRes;
    try {
        portalRes = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${stripeSecretKey}`,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: params.toString(),
            signal: AbortSignal.timeout(8000),
        });
    } catch {
        return res.status(502).json({ ok: false, error: 'Failed to reach Stripe API' });
    }

    const data = await portalRes.json().catch(() => ({}));
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

    if (await isRateLimited(`ratelimit:billing:${clerkUserId}`, BILLING_MAX, BILLING_WINDOW_SEC)) {
        return res.status(429).json({ ok: false, error: 'Too many requests. Please wait before trying again.' });
    }

    const clerkSecretKey = process.env.CLERK_SECRET_KEY;
    const { customerId: stripeCustomerId, error: clerkError } = await resolveStripeCustomer(clerkUserId, clerkSecretKey);

    // If Clerk is reachable but returned an error, surface it - do not silently
    // return an empty invoice list or a misleading "no billing account" message.
    if (clerkError) {
        return res.status(502).json({ ok: false, error: 'Could not reach authentication server. Please try again.' });
    }

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
