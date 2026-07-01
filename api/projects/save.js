const { setCorsHeaders, handleOptions } = require('../_cors');
const { getDb } = require('../_db');
const { verifyClerkToken } = require('../_verify-clerk-token');
const crypto = require('crypto');

const MAX_BODY_BYTES  = 15 * 1024 * 1024; // 15 MB
const MAX_NAME_LENGTH = 255;
const ANON_TTL_MS     = 48 * 60 * 60 * 1000; // 48 hours
const ANON_RATE_MS    = 10 * 60 * 1000; // 10 minutes between new anon saves

// Hash client IPs before storing them so raw addresses never land in MongoDB.
// A static app-specific prefix makes generic rainbow tables useless.
// Set IP_HASH_SALT in env for a secret salt that prevents targeted precomputation.
const IP_HASH_SALT = process.env.IP_HASH_SALT || 'mockupscripter-ip-v1';
function hashIp(ip) {
    return crypto.createHash('sha256').update(IP_HASH_SALT + ip).digest('hex').slice(0, 16);
}

function getClientIp(req) {
    // x-real-ip is set by Vercel's edge and cannot be spoofed by the client.
    // Fall back to the rightmost value in x-forwarded-for (appended by the
    // most-trusted proxy), NOT the leftmost (which is attacker-controlled).
    const realIp = req.headers['x-real-ip'];
    if (realIp && typeof realIp === 'string') return realIp.trim();
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
        const parts = forwarded.split(',');
        return parts[parts.length - 1].trim();
    }
    return req.socket?.remoteAddress || 'unknown';
}

async function getClerkUserPlan(clerkUserId, clerkSecretKey) {
    const res = await fetch(
        `https://api.clerk.com/v1/users/${encodeURIComponent(clerkUserId)}`,
        {
            headers: { Authorization: `Bearer ${clerkSecretKey}` },
            signal: AbortSignal.timeout(8000),
        }
    );
    if (!res.ok) throw new Error(`Clerk returned ${res.status}`);
    const data = await res.json();
    return (data?.public_metadata?.plan || 'free').toLowerCase();
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

    const { uuid, snapshot, name } = body || {};

    // ── Input validation ─────────────────────────────────────────────────────

    if (name != null) {
        if (typeof name !== 'string') {
            return res.status(400).json({ ok: false, error: 'name must be a string' });
        }
        if (name.trim().length > MAX_NAME_LENGTH) {
            return res.status(400).json({ ok: false, error: `name must be ${MAX_NAME_LENGTH} characters or fewer` });
        }
    }

    if (!snapshot || typeof snapshot !== 'object') {
        return res.status(400).json({ ok: false, error: 'Missing snapshot' });
    }
    // Use null-check instead of truthiness so schemaVersion: 0 is accepted.
    if (snapshot.schemaVersion == null) {
        return res.status(400).json({ ok: false, error: 'Missing schemaVersion in snapshot' });
    }

    const bodySize = Buffer.byteLength(JSON.stringify(snapshot), 'utf8');
    if (bodySize > MAX_BODY_BYTES) {
        return res.status(413).json({ ok: false, error: 'Snapshot exceeds 15 MB limit' });
    }

    const clerkSecretKey = process.env.CLERK_SECRET_KEY;
    const clientIp = getClientIp(req);
    const ipHash = hashIp(clientIp);
    const now = new Date();

    // Validate uuid format when provided (both authenticated and anonymous overwrite paths)
    if (uuid !== undefined && uuid !== null) {
        if (typeof uuid !== 'string' ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)) {
            return res.status(400).json({ ok: false, error: 'Invalid uuid format' });
        }
    }

    // ── Authenticated save — derive user ID from verified JWT ────────────────
    let clerkUserId = null;
    if (req.headers.authorization) {
        try {
            clerkUserId = await verifyClerkToken(req.headers.authorization);
        } catch {
            return res.status(502).json({ ok: false, error: 'Could not verify session' });
        }
        if (!clerkUserId) {
            return res.status(401).json({ ok: false, error: 'Invalid or expired session — please sign in again' });
        }
    }

    let db;
    try {
        db = await getDb();
    } catch (err) {
        console.error('projects/save: DB connection failed', err);
        return res.status(503).json({ ok: false, error: 'Database unavailable — try again shortly' });
    }

    const col = db.collection('projects');

    if (clerkUserId) {
        // Look up plan from Clerk (needed for limit enforcement).
        // Default to 'free' — not 'pro' — so that a missing or misconfigured
        // CLERK_SECRET_KEY fails safe rather than granting unlimited saves.
        let plan = 'free';
        if (clerkSecretKey) {
            try {
                plan = await getClerkUserPlan(clerkUserId, clerkSecretKey) || 'free';
            } catch {
                return res.status(502).json({ ok: false, error: 'Could not reach auth server' });
            }
        } else {
            console.warn('projects/save: CLERK_SECRET_KEY not set — plan defaults to free (no saves allowed for unauthenticated dev)');
        }

        const PLAN_RANK = { free: 0, starter: 1, pro: 2 };

        // Overwrite existing project
        if (uuid) {
            let existing;
            try {
                existing = await col.findOne({ uuid });
            } catch (err) {
                console.error('projects/save: findOne (overwrite) failed', err);
                return res.status(500).json({ ok: false, error: 'Failed to load project' });
            }

            if (!existing) {
                return res.status(404).json({ ok: false, error: 'Project not found' });
            }

            // Prevent any authenticated user from silently overwriting an anonymous
            // project. Anonymous projects must be claimed via /api/projects/claim
            // before they can be saved to. Without this check, knowing any UUID is
            // sufficient to hijack another user's unsaved work.
            if (existing.userId !== clerkUserId) {
                if (!existing.userId) {
                    return res.status(403).json({
                        ok: false,
                        error: 'Anonymous project — use /api/projects/claim to take ownership first',
                    });
                }
                return res.status(403).json({ ok: false, error: 'Not your project' });
            }

            const nameToSet = (name || '').trim() || existing.name || 'Untitled';
            try {
                await col.updateOne({ uuid }, {
                    $set: { snapshot, name: nameToSet, updatedAt: now, userId: clerkUserId, expiresAt: null }
                });
            } catch (err) {
                console.error('projects/save: updateOne (overwrite) failed', err);
                return res.status(500).json({ ok: false, error: 'Failed to save project' });
            }
            return res.status(200).json({ ok: true, uuid });
        }

        // New project — check plan limits
        if ((PLAN_RANK[plan] ?? 0) === 0) {
            return res.status(403).json({ ok: false, error: 'upgrade_required' });
        }
        if (plan === 'starter') {
            // Atomic find-or-create: avoids race where two concurrent requests
            // both see no existing project and both insert.
            const starterUuid = crypto.randomUUID();
            let result;
            try {
                result = await col.findOneAndUpdate(
                    { userId: clerkUserId },
                    {
                        $set: { snapshot, updatedAt: now, plan, userId: clerkUserId, expiresAt: null },
                        $setOnInsert: {
                            uuid: starterUuid,
                            schemaVersion: snapshot.schemaVersion,
                            createdAt: now,
                            name: (name || '').trim() || 'Untitled',
                        },
                    },
                    { upsert: true, returnDocument: 'after' }
                );
            } catch (err) {
                console.error('projects/save: findOneAndUpdate (starter) failed', err);
                return res.status(500).json({ ok: false, error: 'Failed to save project' });
            }
            return res.status(200).json({ ok: true, uuid: result.uuid });
        }
        if (plan === 'pro') {
            let proCount;
            try {
                proCount = await col.countDocuments({ userId: clerkUserId });
            } catch (err) {
                console.error('projects/save: countDocuments (pro) failed', err);
                return res.status(500).json({ ok: false, error: 'Failed to count projects' });
            }
            if (proCount >= 50) {
                return res.status(403).json({ ok: false, error: 'project_limit_reached' });
            }
        }

        const newUuid = crypto.randomUUID();
        try {
            await col.insertOne({
                uuid: newUuid,
                userId: clerkUserId,
                plan,
                name: (name || '').trim() || 'Untitled',
                snapshot,
                schemaVersion: snapshot.schemaVersion,
                createdAt: now,
                updatedAt: now,
                expiresAt: null,
            });
        } catch (err) {
            console.error('projects/save: insertOne (pro) failed', err);
            return res.status(500).json({ ok: false, error: 'Failed to save project' });
        }

        // Post-insert guard: if two concurrent Pro requests both passed the
        // count check, the one that pushed the total over 50 is rolled back.
        if (plan === 'pro') {
            let postCount;
            try {
                postCount = await col.countDocuments({ userId: clerkUserId });
            } catch (err) {
                console.error('projects/save: post-insert countDocuments failed', err);
                // Non-fatal — project was inserted; we just can't verify the cap.
                return res.status(200).json({ ok: true, uuid: newUuid });
            }
            if (postCount > 50) {
                try {
                    await col.deleteOne({ uuid: newUuid });
                } catch (err) {
                    console.error('projects/save: rollback deleteOne failed', err);
                }
                return res.status(403).json({ ok: false, error: 'project_limit_reached' });
            }
        }

        return res.status(200).json({ ok: true, uuid: newUuid });
    }

    // ── Anonymous save ───────────────────────────────────────────────────────
    if (uuid) {
        let existing;
        try {
            existing = await col.findOne({ uuid });
        } catch (err) {
            console.error('projects/save: findOne (anon overwrite) failed', err);
            return res.status(500).json({ ok: false, error: 'Failed to load project' });
        }

        if (!existing) {
            return res.status(404).json({ ok: false, error: 'Project not found' });
        }
        if (existing.userId) {
            return res.status(403).json({ ok: false, error: 'Sign in to edit this project' });
        }
        const newExpiry = new Date(now.getTime() + ANON_TTL_MS);
        try {
            await col.updateOne({ uuid }, {
                $set: { snapshot, updatedAt: now, expiresAt: newExpiry }
            });
        } catch (err) {
            console.error('projects/save: updateOne (anon overwrite) failed', err);
            return res.status(500).json({ ok: false, error: 'Failed to save project' });
        }
        return res.status(200).json({ ok: true, uuid });
    }

    // New anonymous save — rate limit by hashed IP
    let recentAnon;
    try {
        recentAnon = await col.findOne({
            ip: ipHash,
            userId: null,
            createdAt: { $gte: new Date(now.getTime() - ANON_RATE_MS) }
        });
    } catch (err) {
        console.error('projects/save: rate-limit findOne (anon) failed', err);
        return res.status(500).json({ ok: false, error: 'Failed to check rate limit' });
    }

    if (recentAnon) {
        return res.status(429).json({
            ok: false,
            error: 'You can create one anonymous save per 10 minutes. Sign in to save more.'
        });
    }

    const newUuid = crypto.randomUUID();
    const expiresAt = new Date(now.getTime() + ANON_TTL_MS);
    try {
        await col.insertOne({
            uuid: newUuid,
            userId: null,
            ip: ipHash,
            plan: 'anon',
            name: 'Untitled',
            snapshot,
            schemaVersion: snapshot.schemaVersion,
            createdAt: now,
            updatedAt: now,
            expiresAt,
        });
    } catch (err) {
        console.error('projects/save: insertOne (anon) failed', err);
        return res.status(500).json({ ok: false, error: 'Failed to save project' });
    }

    return res.status(200).json({ ok: true, uuid: newUuid });
};
