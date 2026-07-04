const { setCorsHeaders, handleOptions } = require('./_cors');
const { isRateLimited, recordFailure, clearFailures } = require('./_rate-limiter');
const { isNonceSeen, recordNonce, deleteNonce } = require('./_nonce-store');

const VALID_PLANS = ['free', 'starter', 'pro'];

// Use x-real-ip when available (set by Vercel/Nginx from the verified edge
// connection and cannot be spoofed by the client). Fall back to the RIGHTMOST
// value in x-forwarded-for, which is appended by the most-trusted proxy rather
// than the leftmost value which is attacker-controlled in non-Vercel setups.
function getClientIp(req) {
    const realIp = req.headers['x-real-ip'];
    if (realIp && typeof realIp === 'string') return realIp.trim();
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
        const parts = forwarded.split(',');
        return parts[parts.length - 1].trim();
    }
    return req.socket?.remoteAddress || 'unknown';
}

module.exports = async function handler(req, res) {
    setCorsHeaders(req, res);

    if (handleOptions(req, res)) return;

    if (req.method !== 'POST') {
        return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }

    const clientIp = getClientIp(req);

    if (await isRateLimited(clientIp)) {
        return res.status(429).json({
            ok: false,
            error: 'Too many failed attempts. Please try again later.',
        });
    }

    const timestampHeader = req.headers['x-timestamp'];
    if (!timestampHeader) {
        return res.status(400).json({ ok: false, error: 'Missing X-Timestamp header' });
    }
    const timestamp = Number(timestampHeader);
    if (!Number.isFinite(timestamp)) {
        return res.status(400).json({ ok: false, error: 'Invalid X-Timestamp header' });
    }
    const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - timestamp);
    if (ageSeconds > 300) {
        return res.status(400).json({ ok: false, error: 'Request timestamp is too old or too far in the future (max 300 s)' });
    }

    const clerkSecretKey = process.env.CLERK_SECRET_KEY;
    const setPlanSecret = process.env.SET_PLAN_SECRET;

    if (!clerkSecretKey || !setPlanSecret) {
        console.error('set-plan: missing env vars CLERK_SECRET_KEY or SET_PLAN_SECRET');
        return res.status(503).json({
            ok: false,
            error: 'Authentication is not configured on this server. Please contact support.',
        });
    }

    let body;
    try {
        body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch {
        return res.status(400).json({ ok: false, error: 'Invalid JSON body' });
    }

    const { userId, plan } = body || {};

    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

    if (!token || token !== setPlanSecret) {
        await recordFailure(clientIp);
        return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    await clearFailures(clientIp);

    const nonce = req.headers['x-nonce'];
    if (!nonce || typeof nonce !== 'string' || nonce.trim() === '') {
        return res.status(400).json({ ok: false, error: 'Missing X-Nonce header' });
    }
    if (await isNonceSeen(nonce)) {
        return res.status(400).json({ ok: false, error: 'Duplicate nonce - request already processed' });
    }
    if (!userId || typeof userId !== 'string') {
        return res.status(400).json({ ok: false, error: 'Missing or invalid userId' });
    }
    if (!/^user_[A-Za-z0-9_]+$/.test(userId)) {
        return res.status(400).json({ ok: false, error: 'Invalid userId format' });
    }

    if (!plan || !VALID_PLANS.includes(plan)) {
        return res.status(400).json({
            ok: false,
            error: `Invalid plan. Must be one of: ${VALID_PLANS.join(', ')}`,
        });
    }

    try {
        await recordNonce(nonce, userId, plan);
    } catch (err) {
        console.error('set-plan: failed to record nonce', err);
        return res.status(500).json({ ok: false, error: 'Failed to record nonce; request not processed' });
    }

    // Test hook - only active when ENABLE_WEBHOOK_TEST_HOOKS=true (never set in production).
    // Simulates a Clerk API failure AFTER the nonce has been recorded so that the
    // deleteNonce-on-error branch is exercised by scripts/test-webhook-retry.js.
    if (process.env.ENABLE_WEBHOOK_TEST_HOOKS === 'true' &&
            req.headers['x-test-force-clerk-error'] === '1') {
        console.log('set-plan: [TEST HOOK] simulating Clerk failure to exercise deleteNonce path');
        try { await deleteNonce(nonce, { userId, plan }); } catch (delErr) {
            console.error('set-plan: failed to delete nonce after [TEST] simulated Clerk error', delErr);
        }
        return res.status(502).json({ ok: false, error: '[TEST] Simulated Clerk failure' });
    }

    const clerkUrl = `https://api.clerk.com/v1/users/${encodeURIComponent(userId)}/metadata`;

    let clerkRes;
    try {
        clerkRes = await fetch(clerkUrl, {
            method: 'PATCH',
            headers: {
                Authorization: `Bearer ${clerkSecretKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ public_metadata: { plan } }),
            signal: AbortSignal.timeout(8000),
        });
    } catch (err) {
        console.error('set-plan: Clerk API fetch error', err);
        try { await deleteNonce(nonce, { userId, plan }); } catch (delErr) {
            console.error('set-plan: failed to delete nonce after Clerk fetch error', delErr);
        }
        return res.status(502).json({ ok: false, error: 'Failed to reach Clerk API' });
    }

    if (!clerkRes.ok) {
        let clerkError = 'Clerk API error';
        try {
            const clerkBody = await clerkRes.json();
            clerkError = clerkBody?.errors?.[0]?.message || clerkError;
        } catch {}
        console.error('set-plan: Clerk returned', clerkRes.status, clerkError);
        try { await deleteNonce(nonce, { userId, plan }); } catch (delErr) {
            console.error('set-plan: failed to delete nonce after Clerk error response', delErr);
        }
        return res.status(502).json({ ok: false, error: clerkError });
    }

    return res.status(200).json({ ok: true, userId, plan });
};
