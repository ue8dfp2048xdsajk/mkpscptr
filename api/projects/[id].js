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
        return res.status(503).json({ ok: false, error: 'Database unavailable - try again shortly' });
    }

    const col = db.collection('projects');

    if (req.method === 'GET') {
        let project;
        try {
            project = await col.findOne(
                { uuid: id },
                { projection: { _id: 0, snapshot: 1, name: 1, schemaVersion: 1, updatedAt: 1, expiresAt: 1 } }
            );
        } catch (err) {
            console.error('projects/[id]: GET findOne failed', err);
            return res.status(500).json({ ok: false, error: 'Failed to load project' });
        }

        if (!project) {
            return res.status(404).json({ ok: false, error: 'Project not found' });
        }

        if (project.expiresAt && new Date() > new Date(project.expiresAt)) {
            return res.status(404).json({ ok: false, error: 'Project has expired' });
        }

        return res.status(200).json({ ok: true, snapshot: project.snapshot, name: project.name || null });
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

        let project;
        try {
            project = await col.findOne({ uuid: id }, { projection: { userId: 1, name: 1 } });
        } catch (err) {
            console.error('projects/[id]: PATCH findOne failed', err);
            return res.status(500).json({ ok: false, error: 'Failed to load project' });
        }

        if (!project) return res.status(404).json({ ok: false, error: 'Project not found' });
        if (project.userId !== userId) return res.status(403).json({ ok: false, error: 'Not your project' });

        const newName = trimmedName || project.name || 'Untitled';
        try {
            await col.updateOne({ uuid: id }, { $set: { name: newName, updatedAt: new Date() } });
        } catch (err) {
            console.error('projects/[id]: PATCH updateOne failed', err);
            return res.status(500).json({ ok: false, error: 'Failed to update project' });
        }

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

        let project;
        try {
            project = await col.findOne({ uuid: id }, { projection: { userId: 1 } });
        } catch (err) {
            console.error('projects/[id]: DELETE findOne failed', err);
            return res.status(500).json({ ok: false, error: 'Failed to load project' });
        }

        if (!project) return res.status(404).json({ ok: false, error: 'Project not found' });
        if (project.userId !== userId) return res.status(403).json({ ok: false, error: 'Not your project' });

        try {
            await col.deleteOne({ uuid: id });
        } catch (err) {
            console.error('projects/[id]: DELETE deleteOne failed', err);
            return res.status(500).json({ ok: false, error: 'Failed to delete project' });
        }

        return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ ok: false, error: 'Method not allowed' });
};
