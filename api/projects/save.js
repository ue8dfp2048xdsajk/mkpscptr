const { setCorsHeaders, handleOptions } = require('../_cors');
const { getDb } = require('../db');
const crypto = require('crypto');

const MAX_BODY_BYTES = 15 * 1024 * 1024; // 15 MB
const ANON_TTL_MS   = 48 * 60 * 60 * 1000; // 48 hours
const ANON_RATE_MS  = 10 * 60 * 1000; // 10 minutes between new anon saves

function getClientIp(req) {
    const fwd = req.headers['x-forwarded-for'];
    return fwd ? fwd.split(',')[0].trim() : (req.socket?.remoteAddress || 'unknown');
}

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

    let body;
    try {
        body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch {
        return res.status(400).json({ ok: false, error: 'Invalid JSON body' });
    }

    const { uuid, clerkUserId, snapshot } = body || {};

    if (!snapshot || typeof snapshot !== 'object') {
        return res.status(400).json({ ok: false, error: 'Missing snapshot' });
    }
    if (!snapshot.schemaVersion) {
        return res.status(400).json({ ok: false, error: 'Missing schemaVersion in snapshot' });
    }

    const bodySize = Buffer.byteLength(JSON.stringify(snapshot), 'utf8');
    if (bodySize > MAX_BODY_BYTES) {
        return res.status(413).json({ ok: false, error: 'Snapshot exceeds 15 MB limit' });
    }

    const clerkSecretKey = process.env.CLERK_SECRET_KEY;
    const clientIp = getClientIp(req);
    const now = new Date();

    let db;
    try {
        db = await getDb();
    } catch (err) {
        console.error('projects/save: DB connection failed', err);
        return res.status(503).json({ ok: false, error: 'Database unavailable — try again shortly' });
    }

    const col = db.collection('projects');

    // ── Authenticated save ──────────────────────────────────────────────────
    if (clerkUserId && clerkSecretKey) {
        let clerkUser;
        try {
            clerkUser = await verifyClerkUser(clerkUserId, clerkSecretKey);
        } catch {
            return res.status(502).json({ ok: false, error: 'Could not reach auth server' });
        }
        if (!clerkUser) {
            return res.status(401).json({ ok: false, error: 'Not authenticated' });
        }

        const plan = clerkUser.plan;
        const PLAN_RANK = { free: 0, starter: 1, pro: 2 };

        // Overwrite existing project
        if (uuid) {
            const existing = await col.findOne({ uuid });
            if (!existing) {
                return res.status(404).json({ ok: false, error: 'Project not found' });
            }
            if (existing.userId && existing.userId !== clerkUserId) {
                return res.status(403).json({ ok: false, error: 'Not your project' });
            }
            await col.updateOne({ uuid }, {
                $set: { snapshot, updatedAt: now, userId: clerkUserId, expiresAt: null }
            });
            return res.status(200).json({ ok: true, uuid });
        }

        // New project — check plan limits
        if (PLAN_RANK[plan] === 0) {
            // Free users: no save
            return res.status(403).json({ ok: false, error: 'upgrade_required' });
        }
        if (plan === 'starter') {
            // Starter: max 1 project — find and overwrite existing one
            const existing = await col.findOne({ userId: clerkUserId });
            if (existing) {
                await col.updateOne({ uuid: existing.uuid }, {
                    $set: { snapshot, updatedAt: now }
                });
                return res.status(200).json({ ok: true, uuid: existing.uuid });
            }
        }

        // Pro or first Starter save: create new
        const newUuid = crypto.randomUUID();
        await col.insertOne({
            uuid: newUuid,
            userId: clerkUserId,
            plan,
            snapshot,
            schemaVersion: snapshot.schemaVersion,
            createdAt: now,
            updatedAt: now,
            expiresAt: null,
        });
        return res.status(200).json({ ok: true, uuid: newUuid });
    }

    // ── Anonymous save ──────────────────────────────────────────────────────
    if (uuid) {
        // Overwrite anonymous project — anyone with the UUID can update it
        const existing = await col.findOne({ uuid });
        if (!existing) {
            return res.status(404).json({ ok: false, error: 'Project not found' });
        }
        if (existing.userId) {
            return res.status(403).json({ ok: false, error: 'Sign in to edit this project' });
        }
        const newExpiry = new Date(now.getTime() + ANON_TTL_MS);
        await col.updateOne({ uuid }, {
            $set: { snapshot, updatedAt: now, expiresAt: newExpiry }
        });
        return res.status(200).json({ ok: true, uuid });
    }

    // New anonymous save — rate limit by IP
    const recentAnon = await col.findOne({
        ip: clientIp,
        userId: null,
        createdAt: { $gte: new Date(now.getTime() - ANON_RATE_MS) }
    });
    if (recentAnon) {
        return res.status(429).json({
            ok: false,
            error: 'You can create one anonymous save per 10 minutes. Sign in to save more.'
        });
    }

    const newUuid = crypto.randomUUID();
    const expiresAt = new Date(now.getTime() + ANON_TTL_MS);
    await col.insertOne({
        uuid: newUuid,
        userId: null,
        ip: clientIp,
        plan: 'anon',
        snapshot,
        schemaVersion: snapshot.schemaVersion,
        createdAt: now,
        updatedAt: now,
        expiresAt,
    });

    return res.status(200).json({ ok: true, uuid: newUuid });
};
