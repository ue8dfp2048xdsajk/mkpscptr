const { setCorsHeaders, handleOptions } = require('../_cors');
const { getDb } = require('../_db');
const { verifyClerkToken } = require('../_verify-clerk-token');

const _deleteHits = new Map();
const DELETE_WINDOW_MS = 60_000;
const DELETE_MAX = 5;
function deleteRateLimited(userId) {
    const now = Date.now();
    const cutoff = now - DELETE_WINDOW_MS;
    const hits = (_deleteHits.get(userId) || []).filter(t => t > cutoff);
    if (hits.length >= DELETE_MAX) return true;
    hits.push(now);
    _deleteHits.set(userId, hits);
    return false;
}

module.exports = async function handler(req, res) {
    setCorsHeaders(req, res);
    if (handleOptions(req, res)) return;

    if (req.method !== 'DELETE') {
        return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }

    const clerkSecretKey = process.env.CLERK_SECRET_KEY;
    if (!clerkSecretKey) {
        return res.status(500).json({ ok: false, error: 'Server misconfigured' });
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

    if (deleteRateLimited(clerkUserId)) {
        return res.status(429).json({ ok: false, error: 'Too many requests. Please wait before trying again.' });
    }

    let db;
    try {
        db = await getDb();
    } catch {
        return res.status(503).json({ ok: false, error: 'Database unavailable' });
    }

    // ── Step 1: Read Stripe customer ID (non-destructive) ────────────────────
    // Fetch the mapping before any deletions so it's available for cleanup.
    let stripeCustomerId = null;
    try {
        const customerDoc = await db.collection('customers').findOne(
            { clerkUserId },
            { projection: { stripeCustomerId: 1 } }
        );
        stripeCustomerId = customerDoc?.stripeCustomerId || null;
    } catch (err) {
        console.error('account/delete: failed to look up customer record (non-fatal)', err);
    }

    // ── Step 2: Delete Clerk user — point of no return ───────────────────────
    // All destructive steps below only run after Clerk confirms the user is
    // deleted. If this call fails, we return immediately and nothing is lost.
    let clerkRes;
    try {
        clerkRes = await fetch(
            `https://api.clerk.com/v1/users/${encodeURIComponent(clerkUserId)}`,
            {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${clerkSecretKey}` },
                signal: AbortSignal.timeout(8000),
            }
        );
    } catch {
        return res.status(502).json({ ok: false, error: 'Failed to reach Clerk API' });
    }

    if (!clerkRes.ok) {
        let msg = 'Clerk user deletion failed';
        try {
            const d = await clerkRes.json();
            msg = d?.errors?.[0]?.message || msg;
        } catch {}
        return res.status(502).json({ ok: false, error: msg });
    }

    // Clerk account is confirmed gone. All remaining steps are cleanup.
    // Failures below are logged but non-fatal — the user cannot sign back in.

    // ── Step 3: Remove MongoDB customer mapping BEFORE cancelling Stripe ─────
    // Deleting this record first means the customer.subscription.deleted
    // webhook (fired when we delete the Stripe customer in step 4) will fail
    // the customer lookup and be gracefully ignored. Without this ordering, the
    // webhook would try to call set-plan for a user that no longer exists in
    // Clerk, causing Stripe to enter a retry loop.
    try {
        await db.collection('customers').deleteOne({ clerkUserId });
    } catch (err) {
        console.error('account/delete: failed to delete customer mapping (non-fatal — account already deleted)', err);
    }

    // ── Step 4: Delete Stripe customer ──────────────────────────────────────
    // Implicitly cancels all active subscriptions. Resulting webhook events
    // will be ignored because the customer mapping was removed in step 3.
    if (stripeCustomerId) {
        const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
        if (stripeSecretKey) {
            try {
                const stripeRes = await fetch(
                    `https://api.stripe.com/v1/customers/${encodeURIComponent(stripeCustomerId)}`,
                    {
                        method: 'DELETE',
                        headers: { Authorization: `Bearer ${stripeSecretKey}` },
                        signal: AbortSignal.timeout(8000),
                    }
                );
                if (!stripeRes.ok) {
                    const d = await stripeRes.json().catch(() => ({}));
                    console.error('account/delete: Stripe customer deletion failed (non-fatal)', d?.error?.message);
                }
            } catch (err) {
                console.error('account/delete: failed to reach Stripe API (non-fatal)', err);
            }
        } else {
            console.error('account/delete: STRIPE_SECRET_KEY not set — skipping Stripe cleanup for', stripeCustomerId);
        }
    }

    // ── Step 5: Delete all user projects ─────────────────────────────────────
    try {
        await db.collection('projects').deleteMany({ userId: clerkUserId });
    } catch (err) {
        console.error('account/delete: failed to delete projects (non-fatal — account already deleted)', err);
    }

    return res.status(200).json({ ok: true });
};
