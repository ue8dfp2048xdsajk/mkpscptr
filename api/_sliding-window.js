// Fixed-window rate limiter backed by Upstash Redis (REST API).
// Falls back to an in-memory Map when Redis is not configured (dev / test).
//
// KEY DESIGN — fixed window with time-bucket key
// ──────────────────────────────────────────────
// Redis key: `${prefix}:${Math.floor(Date.now()/1000/windowSecs)}`
// This gives each user a fresh counter every windowSecs seconds aligned to
// clock boundaries, which is identical to the in-memory sliding-window for
// burst detection purposes and is simple to reason about.
//
// Pipeline (INCR + EXPIRE) runs server-side as a single round-trip.
// EXPIRE is set to 2×windowSecs so keys auto-clean after the window closes.
//
// Failure policy: fail OPEN — Redis errors allow the request rather than
// blocking all users during an outage. The real payment gate (409 plan-rank
// check) and JWT auth remain active even when rate limiting degrades.

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const USE_REDIS   = Boolean(REDIS_URL && REDIS_TOKEN);

const _mem = new Map();

function _memCheck(key, maxHits, windowMs) {
    const now    = Date.now();
    const cutoff = now - windowMs;
    const hits   = (_mem.get(key) || []).filter(t => t > cutoff);
    if (hits.length >= maxHits) return true;
    hits.push(now);
    _mem.set(key, hits);
    return false;
}

/**
 * Returns true if `keyPrefix` has exceeded `maxHits` in the last `windowSecs`
 * seconds, and records the current request.  Returns false (allow) otherwise.
 *
 * @param {string} keyPrefix  e.g. 'ratelimit:checkout:user_abc123'
 * @param {number} maxHits    maximum allowed hits per window
 * @param {number} windowSecs window duration in seconds
 */
async function isRateLimited(keyPrefix, maxHits, windowSecs) {
    if (!USE_REDIS) {
        return _memCheck(keyPrefix, maxHits, windowSecs * 1000);
    }

    const bucket   = Math.floor(Date.now() / 1000 / windowSecs);
    const redisKey = `${keyPrefix}:${bucket}`;

    try {
        const res = await fetch(`${REDIS_URL}/pipeline`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${REDIS_TOKEN}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify([
                ['INCR', redisKey],
                ['EXPIRE', redisKey, windowSecs * 2],
            ]),
            signal: AbortSignal.timeout(3000),
        });

        if (!res.ok) {
            console.error(`sliding-window: Redis pipeline HTTP ${res.status} for key=${keyPrefix} — failing open`);
            return false;
        }

        const results = await res.json();
        const count   = results?.[0]?.result;

        if (typeof count !== 'number') {
            console.error('sliding-window: unexpected Redis response', JSON.stringify(results));
            return false;
        }

        return count > maxHits;
    } catch (err) {
        console.error(`sliding-window: Redis error for key=${keyPrefix} — failing open:`, err.message);
        return false;
    }
}

module.exports = { isRateLimited };
