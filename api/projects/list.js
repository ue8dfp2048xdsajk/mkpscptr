const { setCorsHeaders, handleOptions } = require('../_cors');
const { getDb } = require('../db');

async function verifyClerkUser(clerkUserId, clerkSecretKey) {
    const res = await fetch(
        `https://api.clerk.com/v1/users/${encodeURIComponent(clerkUserId)}`,
        { headers: { Authorization: `Bearer ${clerkSecretKey}` } }
    );
    return res.ok;
}

module.exports = async function handler(req, res) {
    setCorsHeaders(req, res);
    if (handleOptions(req, res)) return;

    if (req.method !== 'GET') {
        return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }

    const clerkSecretKey = process.env.CLERK_SECRET_KEY;
    if (!clerkSecretKey) {
        return res.status(500).json({ ok: false, error: 'Server misconfiguration' });
    }

    const { clerkUserId } = req.query;
    if (!clerkUserId || typeof clerkUserId !== 'string') {
        return res.status(401).json({ ok: false, error: 'Not authenticated' });
    }

    let verified;
    try {
        verified = await verifyClerkUser(clerkUserId, clerkSecretKey);
    } catch {
        return res.status(502).json({ ok: false, error: 'Could not reach auth server' });
    }
    if (!verified) {
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
            { projection: { _id: 0, uuid: 1, updatedAt: 1, schemaVersion: 1 } }
        )
        .sort({ updatedAt: -1 })
        .limit(20)
        .toArray();

    return res.status(200).json({ ok: true, projects });
};
