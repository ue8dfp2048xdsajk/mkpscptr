const { Pool } = require('pg');

const MAX_FAILURES = 5;
const WINDOW_SECONDS = 15 * 60;

// --- Redis (Upstash) ---
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const USE_REDIS = Boolean(REDIS_URL && REDIS_TOKEN);

// --- PostgreSQL ---
const USE_PG = Boolean(process.env.DATABASE_URL);
let _pool = null;
let _schemaPromise = null;

function getPool() {
    if (!_pool) {
        _pool = new Pool({ connectionString: process.env.DATABASE_URL });
    }
    return _pool;
}

function ensureSchema() {
    if (_schemaPromise) return _schemaPromise;
    _schemaPromise = getPool().query(`
        CREATE TABLE IF NOT EXISTS rate_limit (
            ip          TEXT    PRIMARY KEY,
            failures    INTEGER NOT NULL DEFAULT 0,
            window_start BIGINT  NOT NULL,
            updated_at  BIGINT  NOT NULL
        )
    `).catch(err => {
        _schemaPromise = null;
        throw err;
    });
    return _schemaPromise;
}

// --- Local deny cache (survives backend outages) ---
const DENY_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const denyCache = new Map(); // ip -> expiresAt timestamp

function denyCacheAdd(ip) {
    denyCache.set(ip, Date.now() + DENY_CACHE_TTL);
}

function denyCacheCheck(ip) {
    const exp = denyCache.get(ip);
    if (exp === undefined) return false;
    if (Date.now() > exp) {
        denyCache.delete(ip);
        return false;
    }
    return true;
}

function denyCacheRemove(ip) {
    denyCache.delete(ip);
}

// --- In-memory fallback ---
const failureStore = new Map();

if (!USE_REDIS && !USE_PG) {
    console.warn(
        'rate-limiter: No persistent backend configured (UPSTASH_REDIS_REST_URL/TOKEN and DATABASE_URL are all unset). ' +
        'Rate-limit counters are stored in process memory only — they will not be shared across serverless instances ' +
        'and will reset on every cold start. Configure Redis or PostgreSQL for reliable rate limiting in production.'
    );
}

function makeKey(ip) {
    return `ratelimit:${ip}`;
}

// --- Redis helpers ---

async function redisPipeline(commands) {
    const res = await fetch(`${REDIS_URL}/pipeline`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${REDIS_TOKEN}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(commands),
    });
    if (!res.ok) throw new Error(`Upstash pipeline error: ${res.status}`);
    return res.json();
}

async function redisGet(key) {
    const res = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
    });
    if (!res.ok) throw new Error(`Upstash get error: ${res.status}`);
    const json = await res.json();
    return json.result;
}

async function redisDel(key) {
    const res = await fetch(`${REDIS_URL}/del/${encodeURIComponent(key)}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
    });
    if (!res.ok) throw new Error(`Upstash del error: ${res.status}`);
}

// --- PostgreSQL helpers ---

async function pgPruneExpired() {
    try {
        const pool = getPool();
        await pool.query(
            'DELETE FROM rate_limit WHERE window_start < (EXTRACT(EPOCH FROM NOW()) * 1000 - $1)',
            [WINDOW_SECONDS * 1000]
        );
    } catch (err) {
        console.error('rate-limiter: PG prune failed:', err.message);
    }
}

async function pgIsRateLimited(ip) {
    await ensureSchema();
    if (Math.random() < 0.05) pgPruneExpired();
    const pool = getPool();
    const now = Date.now();
    const windowCutoff = now - WINDOW_SECONDS * 1000;
    const { rows } = await pool.query(
        'SELECT failures, window_start FROM rate_limit WHERE ip = $1',
        [ip]
    );
    if (rows.length === 0) return false;
    const { failures, window_start } = rows[0];
    if (Number(window_start) < windowCutoff) return false;
    return Number(failures) >= MAX_FAILURES;
}

async function pgRecordFailure(ip) {
    await ensureSchema();
    const pool = getPool();
    const now = Date.now();
    const windowCutoff = now - WINDOW_SECONDS * 1000;
    await pool.query(
        `INSERT INTO rate_limit (ip, failures, window_start, updated_at)
         VALUES ($1, 1, $2, $2)
         ON CONFLICT (ip) DO UPDATE SET
           failures     = CASE WHEN rate_limit.window_start < $3
                               THEN 1
                               ELSE rate_limit.failures + 1
                          END,
           window_start = CASE WHEN rate_limit.window_start < $3
                               THEN $2
                               ELSE rate_limit.window_start
                          END,
           updated_at   = $2`,
        [ip, now, windowCutoff]
    );
}

async function pgClearFailures(ip) {
    await ensureSchema();
    const pool = getPool();
    await pool.query('DELETE FROM rate_limit WHERE ip = $1', [ip]);
}

// --- In-memory helpers ---

function pruneExpired() {
    const now = Date.now();
    for (const [key, record] of failureStore.entries()) {
        if (now - record.windowStart >= WINDOW_SECONDS * 1000) {
            failureStore.delete(key);
        }
    }
}

function memIsRateLimited(ip) {
    pruneExpired();
    const now = Date.now();
    const record = failureStore.get(ip);
    if (!record || now - record.windowStart >= WINDOW_SECONDS * 1000) return false;
    return record.failures >= MAX_FAILURES;
}

function memRecordFailure(ip) {
    const now = Date.now();
    const record = failureStore.get(ip);
    if (!record || now - record.windowStart >= WINDOW_SECONDS * 1000) {
        failureStore.set(ip, { windowStart: now, failures: 1 });
    } else {
        record.failures += 1;
    }
}

function memClearFailures(ip) {
    failureStore.delete(ip);
}

// --- Public API (all async) ---

async function isRateLimited(ip) {
    if (USE_REDIS) {
        try {
            const count = await redisGet(makeKey(ip));
            const limited = count !== null && Number(count) >= MAX_FAILURES;
            if (limited) denyCacheAdd(ip);
            return limited;
        } catch (err) {
            console.error('rate-limiter: Redis read failed, falling back to PG/memory:', err.message);
            if (denyCacheCheck(ip)) return true;
        }
    }
    if (USE_PG) {
        try {
            const limited = await pgIsRateLimited(ip);
            if (limited) denyCacheAdd(ip);
            return limited;
        } catch (err) {
            console.error('rate-limiter: PG read failed, falling back to in-memory:', err.message);
            if (denyCacheCheck(ip)) return true;
            return memIsRateLimited(ip);
        }
    }
    return memIsRateLimited(ip);
}

async function recordFailure(ip) {
    if (USE_REDIS) {
        try {
            const key = makeKey(ip);
            await redisPipeline([
                ['INCR', key],
                ['EXPIRE', key, WINDOW_SECONDS],
            ]);
            return;
        } catch (err) {
            console.error('rate-limiter: Redis write failed, falling back to PG/memory:', err.message);
        }
    }
    if (USE_PG) {
        try {
            await pgRecordFailure(ip);
            return;
        } catch (err) {
            console.error('rate-limiter: PG write failed, falling back to in-memory:', err.message);
            memRecordFailure(ip);
            return;
        }
    }
    memRecordFailure(ip);
}

async function clearFailures(ip) {
    denyCacheRemove(ip);
    if (USE_REDIS) {
        try {
            await redisDel(makeKey(ip));
            return;
        } catch (err) {
            console.error('rate-limiter: Redis delete failed, falling back to PG/memory:', err.message);
        }
    }
    if (USE_PG) {
        try {
            await pgClearFailures(ip);
            return;
        } catch (err) {
            console.error('rate-limiter: PG delete failed, falling back to in-memory:', err.message);
            memClearFailures(ip);
            return;
        }
    }
    memClearFailures(ip);
}

module.exports = { isRateLimited, recordFailure, clearFailures };
