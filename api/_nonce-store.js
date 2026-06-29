const NONCE_TTL_SECONDS = 300;

// --- Redis (Upstash) ---
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const USE_REDIS = Boolean(REDIS_URL && REDIS_TOKEN);

if (!USE_REDIS) {
    console.warn(
        'nonce-store: UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set — ' +
        'falling back to in-memory nonce store. Replay protection resets on every cold start.'
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
    }
    seen.delete(nonce);
}

module.exports = { isNonceSeen, recordNonce, deleteNonce };
