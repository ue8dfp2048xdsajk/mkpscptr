const MAX_FAILURES = 5;
const WINDOW_SECONDS = 15 * 60;

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const USE_REDIS = Boolean(REDIS_URL && REDIS_TOKEN);

// In-memory fallback — resets on every cold start (use Redis env vars for durability)
const failureStore = new Map();

function makeKey(ip) {
    return `ratelimit:${ip}`;
}

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

// --- In-memory helpers ---

function pruneExpired() {
    const now = Date.now();
    for (const [key, record] of failureStore.entries()) {
        if (now - record.windowStart >= WINDOW_SECONDS * 1000) {
            failureStore.delete(key);
        }
    }
}

// --- Public API (all async) ---

async function isRateLimited(ip) {
    if (USE_REDIS) {
        try {
            const count = await redisGet(makeKey(ip));
            return count !== null && Number(count) >= MAX_FAILURES;
        } catch (err) {
            console.error('rate-limiter: Redis read failed, falling back to allow:', err.message);
            return false;
        }
    }
    pruneExpired();
    const now = Date.now();
    const record = failureStore.get(ip);
    if (!record || now - record.windowStart >= WINDOW_SECONDS * 1000) return false;
    return record.failures >= MAX_FAILURES;
}

async function recordFailure(ip) {
    if (USE_REDIS) {
        try {
            const key = makeKey(ip);
            await redisPipeline([
                ['INCR', key],
                ['EXPIRE', key, WINDOW_SECONDS],
            ]);
        } catch (err) {
            console.error('rate-limiter: Redis write failed, failure not persisted:', err.message);
        }
        return;
    }
    const now = Date.now();
    const record = failureStore.get(ip);
    if (!record || now - record.windowStart >= WINDOW_SECONDS * 1000) {
        failureStore.set(ip, { windowStart: now, failures: 1 });
    } else {
        record.failures += 1;
    }
}

async function clearFailures(ip) {
    if (USE_REDIS) {
        try {
            await redisDel(makeKey(ip));
        } catch (err) {
            console.error('rate-limiter: Redis delete failed:', err.message);
        }
        return;
    }
    failureStore.delete(ip);
}

module.exports = { isRateLimited, recordFailure, clearFailures };
