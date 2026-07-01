const { setCorsHeaders, handleOptions } = require('../_cors');
const { getDb } = require('../_db');
const { verifyClerkToken } = require('../_verify-clerk-token');

const MAX_NAME_LENGTH = 255;

module.exports = async function handler(req, res) {
    setCorsHeaders(req, res);
    if (handleOptions(req, res)) return;

    const { id } = req.query;
    if (!id || typeof id !== 'string') {
        return res.status(400).json({ ok: false, error: 'Missing project ID' });
    }

    let db;
    try {
        db = await getDb();
    } catch (err) {
        console.error('projects/[id]: DB connection failed', err);
        return res.status(503).json({ ok: false, error: 'Database unavailable — try again shortly' });
    }

    const col = db.collection('projects');

    if (req.method === 'GET') {
        const project = await col.findOne(
            { uuid: id },
            { projection: { _id: 0, snapshot: 1, schemaVersion: 1, updatedAt: 1, expiresAt: 1 } }
        );

        if (!project) {
            return res.status(404).json({ ok: false, error: 'Project not found' });
        }

        if (project.expiresAt && new Date() > new Date(project.expiresAt)) {
            return res.status(404).json({ ok: false, error: 'Project has expired' });
        }

        return res.status(200).json({ ok: true, snapshot: project.snapshot });
    }

    if (req.method === 'PATCH') {
        let userId;
        try {
            userId = await verifyClerkToken(req.headers.authorization);
        } catch {
            return res.status(502).json({ ok: false, error: 'Could not verify session' });
        }
        if (!userId) return res.status(401).json({ ok: false, error: 'Not authenticated' });

        let body;
        try {
            body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
        } catch {
            return res.status(400).json({ ok: false, error: 'Invalid JSON body' });
        }
        const { name } = body || {};

        if (name !== undefined && name !== null && typeof name !== 'string') {
            return res.status(400).json({ ok: false, error: 'name must be a string' });
        }
        const trimmedName = (name || '').trim();
        if (trimmedName.length > MAX_NAME_LENGTH) {
            return res.status(400).json({ ok: false, error: `name must be ${MAX_NAME_LENGTH} characters or fewer` });
        }

        const project = await col.findOne({ uuid: id }, { projection: { userId: 1, name: 1 } });
        if (!project) return res.status(404).json({ ok: false, error: 'Project not found' });
        if (project.userId !== userId) return res.status(403).json({ ok: false, error: 'Not your project' });

        const newName = trimmedName || project.name || 'Untitled';
        await col.updateOne({ uuid: id }, { $set: { name: newName, updatedAt: new Date() } });
        return res.status(200).json({ ok: true });
    }

    if (req.method === 'DELETE') {
        let userId;
        try {
            userId = await verifyClerkToken(req.headers.authorization);
        } catch {
            return res.status(502).json({ ok: false, error: 'Could not verify session' });
        }
        if (!userId) return res.status(401).json({ ok: false, error: 'Not authenticated' });

        const project = await col.findOne({ uuid: id }, { projection: { userId: 1 } });
        if (!project) return res.status(404).json({ ok: false, error: 'Project not found' });
        if (project.userId !== userId) return res.status(403).json({ ok: false, error: 'Not your project' });

        await col.deleteOne({ uuid: id });
        return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ ok: false, error: 'Method not allowed' });
};
