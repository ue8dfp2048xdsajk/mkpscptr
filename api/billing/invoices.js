const { setCorsHeaders, handleOptions } = require('../_cors');
const { verifyClerkToken } = require('../_verify-clerk-token');

async function resolveStripeCustomer(clerkUserId, clerkSecretKey, stripeSecretKey) {
    let stripeCustomerId = null;
    let userEmail = null;

    if (clerkSecretKey) {
        try {
            const r = await fetch(
                `https://api.clerk.com/v1/users/${encodeURIComponent(clerkUserId)}`,
                { headers: { Authorization: `Bearer ${clerkSecretKey}` } }
            );
            if (r.ok) {
                const d = await r.json();
                stripeCustomerId = d?.public_metadata?.stripeCustomerId;
                userEmail = d?.email_addresses?.[0]?.email_address;
            }
        } catch {}
    }

    if (!stripeCustomerId && userEmail) {
        try {
            const search = await fetch(
                `https://api.stripe.com/v1/customers/search?query=${encodeURIComponent(`email:"${userEmail}"`)}&expand[]=data.subscriptions`,
                { headers: { Authorization: `Bearer ${stripeSecretKey}` } }
            );
            if (search.ok) {
                const sd = await search.json();
                const customers = sd?.data || [];
                const customer =
                    customers.find(c => c.subscriptions?.data?.some(s => s.status === 'active')) ||
                    customers[0];
                if (customer) stripeCustomerId = customer.id;
            }
        } catch {}
    }

    return stripeCustomerId;
}

module.exports = async function handler(req, res) {
    setCorsHeaders(req, res);
    if (handleOptions(req, res)) return;

    if (req.method !== 'GET') {
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
    const stripeCustomerId = await resolveStripeCustomer(clerkUserId, clerkSecretKey, stripeSecretKey);

    if (!stripeCustomerId) {
        return res.status(200).json({ ok: true, invoices: [] });
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
};
