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
    // Prune expired rows on every write so expired nonces never accumulate.
    await pgPruneExpired();
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
//
// COLD-START REPLAY GAP — READ BEFORE CHANGING THIS SECTION
// ----------------------------------------------------------
// The in-memory Maps below are module-level state.  They are reset to empty
// on every process start (cold start), including serverless function cold
// starts.  This creates a bounded replay window:
//
//   Attack scenario
//   ───────────────
//   1. Attacker obtains a valid nonce N that was used at time T.
//   2. The serverless process restarts (cold start) before T + NONCE_TTL_SECONDS.
//   3. The new process has no memory of N, so isNonceSeen(N) returns false.
//   4. A replay of the original request with nonce N and timestamp T succeeds
//      — IF the replayed request arrives before T + 300 s (the timestamp window).
//
//   Bounding factor
//   ───────────────
//   set-plan.js enforces a hard timestamp window of 300 seconds (same as
//   NONCE_TTL_SECONDS).  Any request whose X-Timestamp is older than 300 s is
//   rejected with 400 before the nonce is even checked.  This means:
//
//   • The cold-start replay window is at most 300 seconds.
//   • After 300 s the timestamp check closes the gate regardless of nonce state.
//
//   Recommended mitigation
//   ──────────────────────
//   Configure Redis (UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN) or
//   PostgreSQL (DATABASE_URL).  Both stores survive process restarts and are
//   shared across serverless instances, eliminating the cold-start gap.
//
//   When NEITHER external store is configured (USE_REDIS=false, USE_PG=false)
//   the module logs a warning at startup (see top of file) and this in-memory
//   fallback is used.  The fallback is acceptable ONLY for local development
//   or single-instance, always-on deployments where cold starts do not occur.
//   It must NOT be relied upon in a multi-instance or serverless environment.
//
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
        //
        // MULTI-INSTANCE SERVERLESS RACE — Redis goes down then recovers
        // ----------------------------------------------------------------
        // In a multi-instance deployment (e.g. Vercel) two independent
        // serverless instances can handle concurrent requests carrying the
        // same nonce at the same time.  The timeline that appears dangerous:
        //
        //   1. Redis goes down.
        //   2. Instance A: isNonceSeen → Redis fails → in-memory fallback → false.
        //   3. Instance B: isNonceSeen → Redis fails → in-memory fallback → false.
        //      (Each instance has its own empty in-memory Map — they cannot see
        //       each other's state.)
        //   4. Both instances pass the duplicate check and reach recordNonce.
        //   5. Redis recovers.
        //   6. Both instances call redisSetNx (SET NX) concurrently.
        //
        // The SET NX command is atomic on the Redis server.  Exactly one
        // instance receives "OK" and the other receives null (duplicate).
        // The losing instance throws "Duplicate nonce — already recorded",
        // so only one request can ever succeed with a given nonce.
        //
        // If Redis is still down at step 6, redisSetNx throws and this
        // function re-throws (fail-closed), returning a 500.  No nonce is
        // committed to any store, so the caller can retry safely once Redis
        // recovers and the retry will then succeed via SET NX.
        //
        // Trade-off acknowledged:
        //   • While Redis is fully down every request returns 500 — safe but
        //     disruptive.  Configuring a PostgreSQL fallback (DATABASE_URL)
        //     provides a secondary durable store.  The PG INSERT … ON CONFLICT
        //     DO NOTHING is also atomic (primary-key constraint), giving the
        //     same multi-instance safety guarantee as Redis SET NX.
        //   • The in-memory fallback intentionally has NO multi-instance
        //     safety — it is documented as local-dev / single-instance only.
        //     See the comment block above the `seen` Map declaration.
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
        // POLICY: fail closed on PG write errors — do NOT fall back to in-memory.
        //
        // TOCTOU gap — why in-memory fallback here is unsafe
        // ----------------------------------------------------
        // isNonceSeen() reads from PG.  If PG comes up after that read but then
        // goes down before this INSERT, writing the nonce to the per-instance
        // in-memory store creates a TOCTOU split:
        //
        //   1. isNonceSeen()  → PG responds → false  (nonce not seen in PG)
        //   2. pgRecordNonce() → PG goes down → throws
        //   3. In-memory fallback records the nonce locally.
        //   4. A concurrent serverless instance has its own empty in-memory Map,
        //      so it will never see step 3.
        //   5. The attacker replays the request on a different instance;
        //      that instance checks PG (still down → in-memory fallback → false)
        //      and then records in its own in-memory Map — replay succeeds.
        //
        // Failing closed (returning 500) avoids the split entirely.  The caller
        // can retry once PG recovers; the nonce has not been committed to any
        // store so the retry is safe.  This mirrors the Redis fail-closed policy
        // documented above.
        //
        // Trade-off: while PG is fully down, every request returns 500.  This is
        // acceptable — consistency over availability — because a successful replay
        // attack could grant unearned plan access.  Configure Redis
        // (UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN) as the primary store
        // for higher availability; PG serves as the durable secondary.
        try {
            const inserted = await pgRecordNonce(nonce, userId, plan);
            if (!inserted) {
                throw new Error('Duplicate nonce — already recorded');
            }
            return;
        } catch (err) {
            if (err.message.includes('Duplicate nonce')) throw err;
            console.error('nonce-store: PG recordNonce failed — failing closed (no in-memory fallback):', err.message);
            throw new Error(`PG recordNonce failed: ${err.message}`);
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
async function deleteNonce(nonce, { userId, plan } = {}) {
    if (USE_REDIS) {
        try {
            await withRetry('Redis DEL', () => redisDel(makeKey(nonce)));
            return;
        } catch (err) {
            console.error(
                `[ALERT] nonce-store: deleteNonce failed permanently for nonce=${nonce} userId=${userId || 'unknown'} plan=${plan || 'unknown'} — ` +
                `the nonce is still recorded; Stripe retries will be rejected with 400 until the nonce expires or is manually cleared via POST /api/clear-nonce. ` +
                `Last error: ${err.message}`
            );
        }
        seen.delete(nonce);
        return;
    }
    if (USE_PG) {
        try {
            await withRetry('PG deleteNonce', () => pgDeleteNonce(nonce));
            return;
        } catch (err) {
            console.error(
                `[ALERT] nonce-store: deleteNonce failed permanently for nonce=${nonce} userId=${userId || 'unknown'} plan=${plan || 'unknown'} — ` +
                `the nonce is still recorded; Stripe retries will be rejected with 400 until the nonce expires or is manually cleared via POST /api/clear-nonce. ` +
                `Last error: ${err.message}`
            );
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
