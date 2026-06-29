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
            expires_at BIGINT NOT NULL
        )
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

async function redisExists(key) {
    const res = await fetch(`${REDIS_URL}/exists/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
    });
    if (!res.ok) throw new Error(`Upstash EXISTS error: ${res.status}`);
    const json = await res.json();
    return json.result === 1;
}

async function redisDel(key) {
    const res = await fetch(`${REDIS_URL}/del/${encodeURIComponent(key)}`, {
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
async function pgRecordNonce(nonce) {
    await ensureSchema();
    const pool = getPool();
    const expiresAt = Date.now() + NONCE_TTL_SECONDS * 1000;
    const result = await pool.query(
        'INSERT INTO nonce_seen (nonce, expires_at) VALUES ($1, $2) ON CONFLICT (nonce) DO NOTHING',
        [nonce, expiresAt]
    );
    return result.rowCount > 0; // true = inserted, false = duplicate
}

async function pgDeleteNonce(nonce) {
    await ensureSchema();
    const pool = getPool();
    await pool.query('DELETE FROM nonce_seen WHERE nonce = $1', [nonce]);
}

// --- In-memory fallback ---
const seen = new Map();

function pruneExpired() {
    const now = Date.now();
    for (const [nonce, expiresAt] of seen.entries()) {
        if (now >= expiresAt) seen.delete(nonce);
    }
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

async function recordNonce(nonce) {
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
        return;
    }
    if (USE_PG) {
        try {
            const inserted = await pgRecordNonce(nonce);
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
}

async function deleteNonce(nonce) {
    if (USE_REDIS) {
        try {
            await redisDel(makeKey(nonce));
            return;
        } catch (err) {
            console.error('nonce-store: Redis DEL failed, falling back to in-memory delete:', err.message);
        }
        seen.delete(nonce);
        return;
    }
    if (USE_PG) {
        try {
            await pgDeleteNonce(nonce);
            return;
        } catch (err) {
            console.error('nonce-store: PG deleteNonce failed, falling back to in-memory delete:', err.message);
            seen.delete(nonce);
            return;
        }
    }
    seen.delete(nonce);
}

module.exports = { isNonceSeen, recordNonce, deleteNonce };
