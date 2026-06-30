const { setCorsHeaders, handleOptions } = require('../_cors');
const { getDb } = require('../_db');
const { verifyClerkToken } = require('../_verify-clerk-token');

module.exports = async function handler(req, res) {
    setCorsHeaders(req, res);
    if (handleOptions(req, res)) return;

    if (req.method !== 'GET') {
        return res.status(405).json({ ok: false, error: 'Method not allowed' });
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
    } catch (err) {
        console.error('projects/list: DB connection failed', err);
        return res.status(503).json({ ok: false, error: 'Database unavailable — try again shortly' });
    }

    const col = db.collection('projects');
    const projects = await col
        .find(
            { userId: clerkUserId },
            { projection: { _id: 0, uuid: 1, name: 1, updatedAt: 1 } }
        )
        .sort({ updatedAt: -1 })
        .limit(20)
        .toArray();

    return res.status(200).json({ ok: true, projects });
};
