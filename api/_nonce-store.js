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
        try {
            const result = await redisSetNx(makeKey(nonce));
            if (result === null) {
                throw new Error('Duplicate nonce — already recorded');
            }
            return;
        } catch (err) {
            // Re-throw duplicate errors; only fall back on Redis connectivity failures
            if (err.message.startsWith('Duplicate nonce')) throw err;
            console.error('nonce-store: Redis SET NX failed, falling back to in-memory:', err.message);
        }
    }
    const now = Date.now();
    pruneExpired();
    if (seen.has(nonce)) {
        throw new Error('Duplicate nonce — already recorded');
    }
    seen.set(nonce, now + NONCE_TTL_SECONDS * 1000);
}

module.exports = { isNonceSeen, recordNonce };
