'use strict';

/**
 * Shared Upstash REST API test helpers.
 *
 * Centralises the fetch mock factories and fake-credential constants so that
 * every test suite that exercises Redis-backed code paths imports from here
 * instead of defining its own copy.
 */

const FAKE_REDIS_URL   = 'https://fake-redis.upstash.io';
const FAKE_REDIS_TOKEN = 'fake-token';

/**
 * Build a fetch mock that simulates the Upstash REST API.
 *
 * State is kept in a plain JS Set so that SET NX is "atomic" within a single
 * Node event-loop tick (Map/Set operations are synchronous).  The mock
 * returns resolved Promises so that both racing handlers can interleave at
 * each `await` point — reproducing the TOCTOU window that SET NX must close.
 *
 * URL patterns handled:
 *   POST  <REDIS_URL>/set/<key>/1?ex=...&nx=true  → SET NX
 *   GET   <REDIS_URL>/exists/<key>                → EXISTS
 *   POST  <REDIS_URL>/del/<key>                   → DEL
 *   PATCH https://api.clerk.com/...               → Clerk (always ok)
 */
function makeRedisFetchMock() {
    const store = new Set();

    return jest.fn((url, opts = {}) => {
        if (url.startsWith(FAKE_REDIS_URL) && url.includes('/set/') && url.includes('nx=true')) {
            const keyEncoded = url.split('/set/')[1].split('/')[0];
            const key = decodeURIComponent(keyEncoded);
            if (store.has(key)) {
                return Promise.resolve({
                    ok: true,
                    json: async () => ({ result: null }),
                });
            }
            store.add(key);
            return Promise.resolve({
                ok: true,
                json: async () => ({ result: 'OK' }),
            });
        }

        if (url.startsWith(FAKE_REDIS_URL) && url.includes('/exists/')) {
            const keyEncoded = url.split('/exists/')[1].split('?')[0];
            const key = decodeURIComponent(keyEncoded);
            return Promise.resolve({
                ok: true,
                json: async () => ({ result: store.has(key) ? 1 : 0 }),
            });
        }

        if (url.startsWith(FAKE_REDIS_URL) && url.includes('/del/')) {
            const keyEncoded = url.split('/del/')[1].split('?')[0];
            const key = decodeURIComponent(keyEncoded);
            store.delete(key);
            return Promise.resolve({
                ok: true,
                json: async () => ({ result: 1 }),
            });
        }

        return Promise.resolve({
            ok: true,
            json: async () => ({}),
        });
    });
}

/**
 * Build a stateful Upstash REST fetch mock using URL-segment parsing.
 *
 * Upstash REST URL shapes we care about:
 *   SET NX  → POST  {base}/set/{encodedKey}/1?ex={ttl}&nx=true
 *   EXISTS  → GET   {base}/exists/{encodedKey}
 *   DEL     → POST  {base}/del/{encodedKey}
 *
 * The operation name is always at path-segment index 3 (0-based after the
 * empty string produced by the leading slash):
 *   ['https:', '', 'host', 'set'|'exists'|'del', '{encodedKey}', ...]
 *
 * Any other URL (e.g. rate-limiter /get, /incrby) returns {result:null}
 * so the caller's error handling falls back to in-memory without crashing.
 *
 * @param {Set} [seen] - Optional pre-populated Set of already-recorded keys.
 */
function makeUpstashFetch(seen = new Set()) {
    return jest.fn(async (url) => {
        const segments = url.split('/');
        const op  = segments[3];
        const raw = (segments[4] || '').split('?')[0];
        const key = decodeURIComponent(raw);

        if (op === 'set') {
            if (seen.has(key)) {
                return { ok: true, json: async () => ({ result: null }) };
            }
            seen.add(key);
            return { ok: true, json: async () => ({ result: 'OK' }) };
        }

        if (op === 'exists') {
            return { ok: true, json: async () => ({ result: seen.has(key) ? 1 : 0 }) };
        }

        if (op === 'del') {
            seen.delete(key);
            return { ok: true, json: async () => ({ result: 1 }) };
        }

        return { ok: true, json: async () => ({ result: null }) };
    });
}

module.exports = { FAKE_REDIS_URL, FAKE_REDIS_TOKEN, makeRedisFetchMock, makeUpstashFetch };
