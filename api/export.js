const { setCorsHeaders, handleOptions } = require('./_cors');
const { verifyClerkToken } = require('./_verify-clerk-token');

module.exports = async function handler(req, res) {
    setCorsHeaders(req, res);
    if (handleOptions(req, res)) return;

    if (req.method !== 'POST') {
        return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }

    const clerkSecretKey = process.env.CLERK_SECRET_KEY;
    if (!clerkSecretKey) {
        return res.status(500).json({ ok: false, error: 'Server misconfiguration' });
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

    let clerkRes;
    try {
        clerkRes = await fetch(
            `https://api.clerk.com/v1/users/${encodeURIComponent(clerkUserId)}`,
            { headers: { Authorization: `Bearer ${clerkSecretKey}` } }
        );
    } catch {
        return res.status(502).json({ ok: false, error: 'Could not reach auth server' });
    }

    if (!clerkRes.ok) {
        return res.status(401).json({ ok: false, error: 'Not authenticated' });
    }

    const clerkData = await clerkRes.json();
    const plan = (clerkData?.public_metadata?.plan || 'free').toLowerCase();

    if (plan === 'free') {
        return res.status(403).json({ ok: false, error: 'upgrade_required' });
    }

    return res.status(200).json({ ok: true, plan });
};
