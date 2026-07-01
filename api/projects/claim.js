const { setCorsHeaders, handleOptions } = require('../_cors');
const { getDb } = require('../_db');
const { verifyClerkToken } = require('../_verify-clerk-token');

module.exports = async function handler(req, res) {
    setCorsHeaders(req, res);
    if (handleOptions(req, res)) return;

    if (req.method !== 'POST') {
        return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }

    let body;
    try {
        body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch {
        return res.status(400).json({ ok: false, error: 'Invalid JSON body' });
    }

    const { uuid } = body || {};
    if (!uuid || typeof uuid !== 'string') {
        return res.status(400).json({ ok: false, error: 'Missing uuid' });
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)) {
        return res.status(400).json({ ok: false, error: 'Invalid uuid format' });
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

    // Look up plan for the claiming user
    const clerkSecretKey = process.env.CLERK_SECRET_KEY;
    let plan = 'free';
    if (clerkSecretKey) {
        try {
            const r = await fetch(
                `https://api.clerk.com/v1/users/${encodeURIComponent(clerkUserId)}`,
                {
                    headers: { Authorization: `Bearer ${clerkSecretKey}` },
                    signal: AbortSignal.timeout(8000),
                }
            );
            if (r.ok) {
                const d = await r.json();
                plan = (d?.public_metadata?.plan || 'free').toLowerCase();
            }
        } catch {
            return res.status(502).json({ ok: false, error: 'Could not reach authentication server — please try again' });
        }
    }

    let db;
    try {
        db = await getDb();
    } catch (err) {
        console.error('projects/claim: DB connection failed', err);
        return res.status(503).json({ ok: false, error: 'Database unavailable' });
    }

    const col = db.collection('projects');

    let project;
    try {
        project = await col.findOne({ uuid });
    } catch (err) {
        console.error('projects/claim: findOne failed', err);
        return res.status(500).json({ ok: false, error: 'Failed to look up project' });
    }

    if (!project) {
        return res.status(404).json({ ok: false, error: 'Project not found' });
    }
    if (project.userId && project.userId !== clerkUserId) {
        return res.status(403).json({ ok: false, error: 'Project belongs to another user' });
    }
    if (project.userId === clerkUserId) {
        return res.status(200).json({ ok: true, uuid, message: 'Already claimed' });
    }

    try {
        await col.updateOne({ uuid }, {
            $set: {
                userId: clerkUserId,
                plan,
                expiresAt: null,
                ip: null,
                updatedAt: new Date(),
            }
        });
    } catch (err) {
        console.error('projects/claim: updateOne failed', err);
        return res.status(500).json({ ok: false, error: 'Failed to claim project' });
    }

    return res.status(200).json({ ok: true, uuid });
};
