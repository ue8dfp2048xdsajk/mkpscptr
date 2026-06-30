const { setCorsHeaders, handleOptions } = require('../_cors');
const { getDb } = require('../db');

module.exports = async function handler(req, res) {
    setCorsHeaders(req, res);
    if (handleOptions(req, res)) return;

    if (req.method !== 'GET') {
        return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }

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
    const project = await col.findOne(
        { uuid: id },
        { projection: { _id: 0, snapshot: 1, schemaVersion: 1, updatedAt: 1 } }
    );

    if (!project) {
        return res.status(404).json({ ok: false, error: 'Project not found' });
    }

    // Reject expired anonymous projects
    if (project.expiresAt && new Date() > new Date(project.expiresAt)) {
        return res.status(404).json({ ok: false, error: 'Project has expired' });
    }

    return res.status(200).json({ ok: true, snapshot: project.snapshot });
};
