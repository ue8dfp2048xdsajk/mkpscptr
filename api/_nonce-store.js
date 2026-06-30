const { Pool } = require('pg');

const NONCE_TTL_SECONDS = 300;

// --- Redis (Upstash) ---
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const USE_REDIS = Boolean(REDIS_URL && REDIS_TOKEN);

// --- PostgreSQL ---
const USE_PG = Boolean(process.env.DATABASE_URL);
let _pool = null;
let _pgReady = false;

function getPool() {
    if (!_pool) {
        _pool = new Pool({ connectionString: process.env.DATABASE_URL });
    }
    return _pool;
}

async function ensureSchema() {
    if (_pgReady) return;
    const pool = getPool();
    await pool.query(`
        CREATE TABLE IF NOT EXISTS nonce_seen (
            nonce      TEXT   PRIMARY KEY,
            expires_at BIGINT NOT NULL,
            user_id    TEXT,
            plan       TEXT
        )
    `);
    // Add columns if upgrading from the old schema (idempotent).
    await pool.query(`
        ALTER TABLE nonce_seen
            ADD COLUMN IF NOT EXISTS user_id TEXT,
            ADD COLUMN IF NOT EXISTS plan     TEXT
    `);
    _pgReady = true;
}

if (!USE_REDIS && !USE_PG) {
    console.warn(
        'nonce-store: UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set and DATABASE_URL not set — ' +
        'falling back to in-memory nonce store. Replay protection resets on every cold start and is not ' +
        'shared across serverless instances. Configure Redis or PostgreSQL for reliable replay protection.'
    );
}

function makeKey(nonce) {
    return `nonce:${nonce}`;
}

function makeUserPlanKey(userId, plan) {
    return `nonce_user:${userId}:${plan}`;
}

// SET key 1 EX <ttl> NX  — returns "OK" if inserted, null if key already existed
async function redisSetNx(key) {
    const url = `${REDIS_URL}/set/${encodeURIComponent(key)}/1?ex=${NONCE_TTL_SECONDS}&nx=true`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
    });
    if (!res.ok) throw new Error(`Upstash SET NX error: ${res.status}`);
    const json = await res.json();
    return json.result; // "OK" or null
}

async function redisSetEx(key, value) {
    const url = `${REDIS_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}?ex=${NONCE_TTL_SECONDS}`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
    });
    if (!res.ok) throw new Error(`Upstash SET EX error: ${res.status}`);
}

async function redisGet(key) {
    const res = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
    });
    if (!res.ok) throw new Error(`Upstash GET error: ${res.status}`);
    const json = await res.json();
    return json.result; // string value or null
}

async function redisExists(key) {
    const res = await fetch(`${REDIS_URL}/exists/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
    });
    if (!res.ok) throw new Error(`Upstash EXISTS error: ${res.status}`);
    const json = await res.json();
    return json.result === 1;
}

async function redisDel(...keys) {
    const encodedKeys = keys.map(k => encodeURIComponent(k)).join('/');
    const res = await fetch(`${REDIS_URL}/del/${encodedKeys}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
    });
    if (!res.ok) throw new Error(`Upstash DEL error: ${res.status}`);
}

// --- PostgreSQL helpers ---

async function pgPruneExpired() {
    try {
        const pool = getPool();
        await pool.query('DELETE FROM nonce_seen WHERE expires_at < $1', [Date.now()]);
    } catch (err) {
        console.error('nonce-store: PG prune failed:', err.message);
    }
}

async function pgIsNonceSeen(nonce) {
    await ensureSchema();
    if (Math.random() < 0.05) pgPruneExpired();
    const pool = getPool();
    const { rows } = await pool.query(
        'SELECT 1 FROM nonce_seen WHERE nonce = $1 AND expires_at > $2',
        [nonce, Date.now()]
    );
    return rows.length > 0;
}

// Returns true if inserted (first time), false if nonce already existed (duplicate).
async function pgRecordNonce(nonce, userId, plan) {
    await ensureSchema();
    const pool = getPool();
    const expiresAt = Date.now() + NONCE_TTL_SECONDS * 1000;
    const result = await pool.query(
        'INSERT INTO nonce_seen (nonce, expires_at, user_id, plan) VALUES ($1, $2, $3, $4) ON CONFLICT (nonce) DO NOTHING',
        [nonce, expiresAt, userId || null, plan || null]
    );
    return result.rowCount > 0; // true = inserted, false = duplicate
}

async function pgDeleteNonce(nonce) {
    await ensureSchema();
    const pool = getPool();
    await pool.query('DELETE FROM nonce_seen WHERE nonce = $1', [nonce]);
}

async function pgDeleteNonceByUserPlan(userId, plan) {
    await ensureSchema();
    const pool = getPool();
    const result = await pool.query(
        'DELETE FROM nonce_seen WHERE user_id = $1 AND plan = $2 AND expires_at > $3 RETURNING nonce',
        [userId, plan, Date.now()]
    );
    return result.rowCount;
}

// --- In-memory fallback ---
const seen = new Map();         // nonce → expiresAt
const seenMeta = new Map();     // nonce → { userId, plan }
const seenUserPlan = new Map(); // "userId:plan" → nonce

function pruneExpired() {
    const now = Date.now();
    for (const [nonce, expiresAt] of seen.entries()) {
        if (now >= expiresAt) {
            const meta = seenMeta.get(nonce);
            if (meta) seenUserPlan.delete(`${meta.userId}:${meta.plan}`);
            seenMeta.delete(nonce);
            seen.delete(nonce);
        }
    }
}

// --- Retry helper ---
async function withRetry(label, fn, { attempts = 3, baseDelayMs = 100 } = {}) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
        try {
            return await fn();
        } catch (err) {
            lastErr = err;
            if (i < attempts - 1) {
                const delay = baseDelayMs * Math.pow(2, i);
                console.warn(`nonce-store: ${label} attempt ${i + 1} failed, retrying in ${delay}ms:`, err.message);
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }
    throw lastErr;
}

// --- Public API ---

async function isNonceSeen(nonce) {
    if (USE_REDIS) {
        try {
            return await redisExists(makeKey(nonce));
        } catch (err) {
            console.error('nonce-store: Redis EXISTS failed, falling back to in-memory:', err.message);
        }
        pruneExpired();
        return seen.has(nonce);
    }
    if (USE_PG) {
        try {
            return await pgIsNonceSeen(nonce);
        } catch (err) {
            console.error('nonce-store: PG isNonceSeen failed, falling back to in-memory:', err.message);
            pruneExpired();
            return seen.has(nonce);
        }
    }
    pruneExpired();
    return seen.has(nonce);
}

// userId and plan are optional metadata stored alongside the nonce so that
// deleteNonceByUserPlan() can clear a stuck nonce without knowing its value.
async function recordNonce(nonce, userId, plan) {
    if (USE_REDIS) {
        // Fail closed: if the Redis write fails for any reason we must NOT fall
        // back to the in-memory store.  isNonceSeen() may have already read from
        // Redis (returning false), so writing the nonce to a different store
        // (in-memory) would leave Redis unaware of it.  A replay attempt could
        // then succeed once Redis recovers because Redis would still show the
        // nonce as unseen.  Returning a 500 is the safe choice: the caller can
        // retry the full request and the nonce will not have been committed.
        let result;
        try {
            result = await redisSetNx(makeKey(nonce));
        } catch (err) {
            console.error('nonce-store: Redis SET NX failed — failing closed (no in-memory fallback):', err.message);
            throw new Error(`Redis recordNonce failed: ${err.message}`);
        }
        if (result === null) {
            throw new Error('Duplicate nonce — already recorded');
        }
        // Store userId+plan secondary index (best-effort; non-fatal if it fails).
        if (userId && plan) {
            try {
                await redisSetEx(makeUserPlanKey(userId, plan), nonce);
            } catch (err) {
                console.warn('nonce-store: Redis secondary index write failed (non-fatal):', err.message);
            }
        }
        return;
    }
    if (USE_PG) {
        try {
            const inserted = await pgRecordNonce(nonce, userId, plan);
            if (!inserted) {
                throw new Error('Duplicate nonce — already recorded');
            }
            return;
        } catch (err) {
            if (err.message.includes('Duplicate nonce')) throw err;
            console.error('nonce-store: PG recordNonce failed, falling back to in-memory:', err.message);
            // Fall through to in-memory below
        }
    }
    const now = Date.now();
    pruneExpired();
    if (seen.has(nonce)) {
        throw new Error('Duplicate nonce — already recorded');
    }
    seen.set(nonce, now + NONCE_TTL_SECONDS * 1000);
    if (userId && plan) {
        seenMeta.set(nonce, { userId, plan });
        seenUserPlan.set(`${userId}:${plan}`, nonce);
    }
}

// deleteNonce retries up to 3 times with exponential backoff (100 → 200 → 400 ms)
// before giving up.  This handles transient Redis/PG connectivity blips that would
// otherwise leave the nonce recorded and block Stripe's next retry.
async function deleteNonce(nonce) {
    if (USE_REDIS) {
        try {
            await withRetry('Redis DEL', () => redisDel(makeKey(nonce)));
            return;
        } catch (err) {
            console.error('nonce-store: Redis DEL failed after retries, falling back to in-memory delete:', err.message);
        }
        seen.delete(nonce);
        return;
    }
    if (USE_PG) {
        try {
            await withRetry('PG deleteNonce', () => pgDeleteNonce(nonce));
            return;
        } catch (err) {
            console.error('nonce-store: PG deleteNonce failed after retries, falling back to in-memory delete:', err.message);
            seen.delete(nonce);
            return;
        }
    }
    seen.delete(nonce);
}

// deleteNonceByUserPlan finds and removes the unexpired nonce that was recorded
// for a specific userId+plan combination.  Useful when the nonce value itself is
// unknown (e.g. admin clearing a stuck checkout without access to webhook logs).
// Returns the number of nonces deleted (0 if none found).
async function deleteNonceByUserPlan(userId, plan) {
    if (USE_REDIS) {
        try {
            const nonce = await withRetry('Redis GET user-plan key', () => redisGet(makeUserPlanKey(userId, plan)));
            if (!nonce) return 0;
            await withRetry('Redis DEL nonce + user-plan key', () =>
                redisDel(makeKey(nonce), makeUserPlanKey(userId, plan))
            );
            return 1;
        } catch (err) {
            console.error('nonce-store: Redis deleteNonceByUserPlan failed after retries:', err.message);
            throw err;
        }
    }
    if (USE_PG) {
        try {
            return await withRetry('PG deleteNonceByUserPlan', () => pgDeleteNonceByUserPlan(userId, plan));
        } catch (err) {
            console.error('nonce-store: PG deleteNonceByUserPlan failed after retries:', err.message);
            throw err;
        }
    }
    // In-memory fallback
    pruneExpired();
    const key = `${userId}:${plan}`;
    const nonce = seenUserPlan.get(key);
    if (!nonce) return 0;
    seen.delete(nonce);
    seenMeta.delete(nonce);
    seenUserPlan.delete(key);
    return 1;
}

module.exports = { isNonceSeen, recordNonce, deleteNonce, deleteNonceByUserPlan };
