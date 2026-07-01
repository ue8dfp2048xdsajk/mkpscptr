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

    const plan = ((result.payload?.public_metadata?.plan) || 'free').toLowerCase();

    if (plan === 'free') {
        return res.status(403).json({ ok: false, error: 'upgrade_required' });
    }

    return res.status(200).json({ ok: true, plan });
};
