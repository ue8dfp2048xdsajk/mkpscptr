const { setCorsHeaders, handleOptions } = require('../_cors');
const { getDb } = require('../db');

async function verifyClerkUser(clerkUserId, clerkSecretKey) {
    const res = await fetch(
        `https://api.clerk.com/v1/users/${encodeURIComponent(clerkUserId)}`,
        { headers: { Authorization: `Bearer ${clerkSecretKey}` } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return {
        plan: (data?.public_metadata?.plan || 'free').toLowerCase(),
    };
}

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

    let body;
    try {
        body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch {
        return res.status(400).json({ ok: false, error: 'Invalid JSON body' });
    }

    const { uuid, clerkUserId } = body || {};

    if (!uuid || typeof uuid !== 'string') {
        return res.status(400).json({ ok: false, error: 'Missing uuid' });
    }
    if (!clerkUserId || typeof clerkUserId !== 'string') {
        return res.status(401).json({ ok: false, error: 'Not authenticated' });
    }

    let clerkUser;
    try {
        clerkUser = await verifyClerkUser(clerkUserId, clerkSecretKey);
    } catch {
        return res.status(502).json({ ok: false, error: 'Could not reach auth server' });
    }
    if (!clerkUser) {
        return res.status(401).json({ ok: false, error: 'Not authenticated' });
    }

    let db;
    try {
        db = await getDb();
    } catch (err) {
        console.error('projects/claim: DB connection failed', err);
        return res.status(503).json({ ok: false, error: 'Database unavailable' });
    }

    const col = db.collection('projects');
    const project = await col.findOne({ uuid });

    if (!project) {
        return res.status(404).json({ ok: false, error: 'Project not found' });
    }
    if (project.userId && project.userId !== clerkUserId) {
        return res.status(403).json({ ok: false, error: 'Project belongs to another user' });
    }
    if (project.userId === clerkUserId) {
        return res.status(200).json({ ok: true, uuid, message: 'Already claimed' });
    }

    await col.updateOne({ uuid }, {
        $set: {
            userId: clerkUserId,
            plan: clerkUser.plan,
            expiresAt: null,
            ip: null,
            updatedAt: new Date(),
        }
    });

    return res.status(200).json({ ok: true, uuid });
};
