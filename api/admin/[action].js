const { setCorsHeaders, handleOptions } = require('../_cors');
const { deleteNonce, deleteNonceByUserPlan } = require('../_nonce-store');

const USE_REDIS = Boolean(
    process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
);
const USE_PG = Boolean(process.env.DATABASE_URL);

const PRICE_KEYS = [
    'STRIPE_PRICE_STARTER_MONTHLY',
    'STRIPE_PRICE_STARTER_ANNUAL',
    'STRIPE_PRICE_STARTER_LIFETIME',
    'STRIPE_PRICE_PRO_MONTHLY',
    'STRIPE_PRICE_PRO_ANNUAL',
    'STRIPE_PRICE_PRO_LIFETIME',
];

async function handleConfigCheck(req, res) {
    if (req.method !== 'GET') {
        return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }

    const setPlanSecret = process.env.SET_PLAN_SECRET;
    if (setPlanSecret) {
        const authHeader = req.headers.authorization || '';
        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
        if (!token || token !== setPlanSecret) {
            return res.status(401).json({ ok: false, error: 'Unauthorized' });
        }
    }

    const prices = {};
    for (const key of PRICE_KEYS) {
        const parts = key.replace('STRIPE_PRICE_', '').toLowerCase().split('_');
        const period = parts.pop();
        const plan = parts.join('_');
        const combo = `${plan}_${period}`;
        prices[combo] = !!process.env[key];
    }

    const missing = Object.entries(prices)
        .filter(([, set]) => !set)
        .map(([combo]) => `STRIPE_PRICE_${combo.toUpperCase()}`);

    const rateLimiterBackend = USE_REDIS ? 'redis' : USE_PG ? 'postgresql' : 'in-memory';
    const rateLimiterWarning = (!USE_REDIS && !USE_PG)
        ? 'WARNING: Rate-limit counters are stored in process memory only. ' +
          'Lockouts will not survive a cold start and will not be shared across ' +
          'serverless instances. Configure UPSTASH_REDIS_REST_URL/TOKEN or ' +
          'DATABASE_URL for reliable rate limiting in production.'
        : null;

    return res.status(200).json({
        ok: true,
        stripe_configured: !!process.env.STRIPE_SECRET_KEY,
        prices,
        missing,
        all_configured: missing.length === 0,
        rate_limiter: {
            backend: rateLimiterBackend,
            durable: USE_REDIS || USE_PG,
            warning: rateLimiterWarning,
        },
    });
}

// POST /api/admin/clear-nonce
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
async function handleClearNonce(req, res) {
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
}

module.exports = async function handler(req, res) {
    setCorsHeaders(req, res);
    if (handleOptions(req, res)) return;

    const { action } = req.query;

    if (action === 'config-check') return handleConfigCheck(req, res);
    if (action === 'clear-nonce') return handleClearNonce(req, res);

    return res.status(404).json({ ok: false, error: 'Not found' });
};
