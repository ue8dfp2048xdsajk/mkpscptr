const { setCorsHeaders, handleOptions } = require('./_cors');
const { deleteNonce, deleteNonceByUserPlan } = require('./_nonce-store');

// POST /api/clear-nonce
//
// Admin-only endpoint for clearing a stuck nonce when the nonce store had a
// connectivity problem mid-checkout and deleteNonce() could not complete even
// after retries.  Without this, Stripe's next retry would be rejected with
// "Duplicate nonce — request already processed", leaving the user on the free
// plan indefinitely.
//
// Authentication: Bearer <SET_PLAN_SECRET>  (same secret as set-plan)
//
// Body (one of):
//   { "nonce": "<exact nonce value>" }            — clear by nonce value
//   { "userId": "<clerk userId>", "plan": "pro" } — clear by userId + plan
//
// Responses:
//   200  { ok: true,  deleted: <number> }
//   400  { ok: false, error: "..." }     — bad input
//   401  { ok: false, error: "Unauthorized" }
//   405  { ok: false, error: "Method not allowed" }
//   500  { ok: false, error: "..." }     — store error

module.exports = async function handler(req, res) {
    setCorsHeaders(req, res);

    if (handleOptions(req, res)) return;

    if (req.method !== 'POST') {
        return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }

    const setPlanSecret = process.env.SET_PLAN_SECRET;
    if (!setPlanSecret) {
        console.error('clear-nonce: SET_PLAN_SECRET env var is not set');
        return res.status(500).json({ ok: false, error: 'Server misconfiguration' });
    }

    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token || token !== setPlanSecret) {
        return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    let body;
    try {
        body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch {
        return res.status(400).json({ ok: false, error: 'Invalid JSON body' });
    }

    const { nonce, userId, plan, reason } = body || {};

    const reasonStr = (typeof reason === 'string' && reason.trim()) ? reason.trim() : 'not provided';

    // --- Mode 1: clear by nonce value ---
    if (nonce != null) {
        if (typeof nonce !== 'string' || nonce.trim() === '') {
            return res.status(400).json({ ok: false, error: 'nonce must be a non-empty string' });
        }
        try {
            await deleteNonce(nonce.trim());
            console.log(JSON.stringify({
                event: 'clear-nonce',
                mode: 'by-value',
                nonce: nonce.trim(),
                userId: userId || null,
                plan: plan || null,
                reason: reasonStr,
                deleted: 1,
            }));
            return res.status(200).json({ ok: true, deleted: 1 });
        } catch (err) {
            console.error('clear-nonce: deleteNonce failed:', err);
            return res.status(500).json({ ok: false, error: `Failed to delete nonce: ${err.message}` });
        }
    }

    // --- Mode 2: clear by userId + plan ---
    if (userId != null || plan != null) {
        if (typeof userId !== 'string' || userId.trim() === '') {
            return res.status(400).json({ ok: false, error: 'userId must be a non-empty string' });
        }
        if (typeof plan !== 'string' || plan.trim() === '') {
            return res.status(400).json({ ok: false, error: 'plan must be a non-empty string' });
        }
        try {
            const deleted = await deleteNonceByUserPlan(userId.trim(), plan.trim());
            console.log(JSON.stringify({
                event: 'clear-nonce',
                mode: 'by-user-plan',
                nonce: null,
                userId: userId.trim(),
                plan: plan.trim(),
                reason: reasonStr,
                deleted,
            }));
            return res.status(200).json({ ok: true, deleted });
        } catch (err) {
            console.error('clear-nonce: deleteNonceByUserPlan failed:', err);
            return res.status(500).json({ ok: false, error: `Failed to delete nonce: ${err.message}` });
        }
    }

    return res.status(400).json({
        ok: false,
        error: 'Provide either { "nonce": "..." } or { "userId": "...", "plan": "..." }',
    });
};
