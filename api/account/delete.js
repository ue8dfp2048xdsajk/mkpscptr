const { setCorsHeaders, handleOptions } = require('../_cors');
const { getDb } = require('../_db');
const { verifyClerkToken } = require('../_verify-clerk-token');

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

    let db;
    try {
        db = await getDb();
    } catch {
        return res.status(503).json({ ok: false, error: 'Database unavailable' });
    }

    try {
        await db.collection('projects').deleteMany({ userId: clerkUserId });
    } catch (err) {
        console.error('account/delete: failed to delete projects', err);
        return res.status(500).json({ ok: false, error: 'Failed to delete projects' });
    }

    try {
        await db.collection('customers').deleteOne({ clerkUserId });
    } catch (err) {
        console.error('account/delete: failed to delete customer record', err);
        return res.status(500).json({ ok: false, error: 'Failed to delete customer record' });
    }

    let clerkRes;
    try {
        clerkRes = await fetch(
            `https://api.clerk.com/v1/users/${encodeURIComponent(clerkUserId)}`,
            {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${clerkSecretKey}` },
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

    return res.status(200).json({ ok: true });
};
