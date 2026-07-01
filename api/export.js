const { setCorsHeaders, handleOptions } = require('./_cors');
const { verifyClerkTokenFull } = require('./_verify-clerk-token');

module.exports = async function handler(req, res) {
    setCorsHeaders(req, res);
    if (handleOptions(req, res)) return;

    if (req.method !== 'POST') {
        return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }

    let result;
    try {
        result = await verifyClerkTokenFull(req.headers.authorization);
    } catch {
        return res.status(502).json({ ok: false, error: 'Could not verify session' });
    }
    if (!result) {
        return res.status(401).json({ ok: false, error: 'Not authenticated' });
    }

    // Clerk JWTs only include public_metadata when a custom JWT template embeds it.
    // If the field is present, trust it (plan may simply be absent → 'free').
    // If public_metadata is entirely missing from the payload, fall back to a
    // Clerk REST call so export works regardless of JWT template configuration.
    let plan;
    if (result.payload?.public_metadata != null) {
        plan = (result.payload.public_metadata.plan || 'free').toLowerCase();
    } else {
        const clerkSecretKey = process.env.CLERK_SECRET_KEY;
        if (!clerkSecretKey) {
            return res.status(500).json({ ok: false, error: 'Server misconfigured' });
        }
        try {
            const clerkRes = await fetch(
                `https://api.clerk.com/v1/users/${encodeURIComponent(result.userId)}`,
                {
                    headers: { Authorization: `Bearer ${clerkSecretKey}` },
                    signal: AbortSignal.timeout(8000),
                }
            );
            if (!clerkRes.ok) {
                return res.status(502).json({ ok: false, error: 'Could not verify plan' });
            }
            const clerkData = await clerkRes.json();
            plan = (clerkData?.public_metadata?.plan || 'free').toLowerCase();
        } catch {
            return res.status(502).json({ ok: false, error: 'Could not reach auth server' });
        }
    }

    if (plan === 'free') {
        return res.status(403).json({ ok: false, error: 'upgrade_required' });
    }

    return res.status(200).json({ ok: true, plan });
};
