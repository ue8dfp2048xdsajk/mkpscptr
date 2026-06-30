const { setCorsHeaders, handleOptions } = require('../_cors');
const { getDb } = require('../_db');
const { verifyClerkToken } = require('../_verify-clerk-token');

module.exports = async function handler(req, res) {
    setCorsHeaders(req, res);
    if (handleOptions(req, res)) return;

    if (req.method !== 'POST') {
        return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }

    let userId;
    try {
        userId = await verifyClerkToken(req.headers.authorization);
    } catch {
        return res.status(502).json({ ok: false, error: 'Could not verify session' });
    }
    if (!userId) return res.status(401).json({ ok: false, error: 'Not authenticated' });

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { uuid, name } = body || {};
    if (!uuid || typeof uuid !== 'string') {
        return res.status(400).json({ ok: false, error: 'Missing uuid' });
    }

    let db;
    try {
        db = await getDb();
    } catch (err) {
        return res.status(503).json({ ok: false, error: 'Database unavailable' });
    }

    const col = db.collection('projects');
    const project = await col.findOne({ uuid }, { projection: { userId: 1 } });
    if (!project) return res.status(404).json({ ok: false, error: 'Project not found' });
    if (project.userId !== userId) return res.status(403).json({ ok: false, error: 'Not your project' });

    const newName = (name || '').trim() || 'Untitled';
    await col.updateOne({ uuid }, { $set: { name: newName, updatedAt: new Date() } });
    return res.status(200).json({ ok: true });
};
