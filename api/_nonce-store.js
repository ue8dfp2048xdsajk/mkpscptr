const { getDb } = require('./_db');

// 15 minutes — covers typical Stripe checkout session duration and matches
// the X-Timestamp freshness window enforced by api/set-plan.js.
const NONCE_TTL_SECONDS = 900;

const COLLECTION = 'nonce_seen';

// TTL index is created once per process lifetime, mirroring the pattern
// already proven in api/webhooks/stripe.js's idempotency_keys collection.
let _indexEnsured = false;

function ensureIndex(db) {
    if (_indexEnsured) return;
    _indexEnsured = true;
    db.collection(COLLECTION)
        .createIndex({ createdAt: 1 }, { expireAfterSeconds: NONCE_TTL_SECONDS })
        .catch(err => console.warn('nonce-store: TTL index creation failed (non-fatal):', err.message));
}

// --- Retry helper for deletes (transient Mongo blips should not permanently
// strand a nonce that a legitimate Stripe retry needs cleared). ---
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

// isNonceSeen is a fast, best-effort pre-check used only to return a nicer
// 400 error message before doing any work. It is safe for this to fail open
// (return false) on a transient error: the actual replay-protection
// guarantee comes from recordNonce()'s atomic unique-_id insert below, which
// still correctly rejects a true duplicate even if this check missed it.
async function isNonceSeen(nonce) {
    try {
        const db = await getDb();
        const doc = await db.collection(COLLECTION).findOne({ _id: nonce });
        return Boolean(doc);
    } catch (err) {
        console.warn('nonce-store: isNonceSeen failed, treating as unseen:', err.message);
        return false;
    }
}

// recordNonce is the actual replay guard. MongoDB's unique _id index makes
// the insert atomic even across concurrent serverless instances — exactly
// one concurrent insertOne() for the same nonce succeeds; every other one
// throws a duplicate-key error (code 11000). Any other error (e.g. Mongo
// unreachable) also throws — this fails closed by design: the caller
// returns 500, no nonce is committed anywhere, and a legitimate retry is
// safe once Mongo recovers. Mongo is already a hard requirement for this
// entire pipeline (see api/webhooks/stripe.js's idempotency_keys and
// customers collections), so this introduces no new dependency.
async function recordNonce(nonce, userId, plan) {
    const db = await getDb();
    ensureIndex(db);
    try {
        await db.collection(COLLECTION).insertOne({
            _id: nonce,
            userId: userId || null,
            plan: plan || null,
            createdAt: new Date(),
        });
    } catch (err) {
        if (err && err.code === 11000) {
            throw new Error('Duplicate nonce — already recorded');
        }
        throw new Error(`Mongo recordNonce failed: ${err.message}`);
    }
}

// deleteNonce retries up to 3 times with exponential backoff (100 -> 200 ->
// 400 ms) before giving up. This handles transient Mongo connectivity blips
// that would otherwise leave the nonce recorded and block Stripe's next retry.
async function deleteNonce(nonce, { userId, plan } = {}) {
    try {
        await withRetry('Mongo deleteNonce', async () => {
            const db = await getDb();
            await db.collection(COLLECTION).deleteOne({ _id: nonce });
        });
    } catch (err) {
        console.error(
            `[ALERT] nonce-store: deleteNonce failed permanently for nonce=${nonce} userId=${userId || 'unknown'} plan=${plan || 'unknown'} — ` +
            `the nonce is still recorded; Stripe retries will be rejected with 400 until the nonce expires (${NONCE_TTL_SECONDS}s) or is manually cleared via POST /api/admin/clear-nonce. ` +
            `Last error: ${err.message}`
        );
    }
}

// deleteNonceByUserPlan finds and removes any unexpired nonce recorded for a
// specific userId+plan combination. Useful when the nonce value itself is
// unknown (e.g. admin clearing a stuck checkout without access to webhook
// logs). Returns the number of nonces deleted (0 if none found).
async function deleteNonceByUserPlan(userId, plan) {
    return withRetry('Mongo deleteNonceByUserPlan', async () => {
        const db = await getDb();
        const result = await db.collection(COLLECTION).deleteMany({ userId, plan });
        return result.deletedCount || 0;
    });
}

module.exports = { isNonceSeen, recordNonce, deleteNonce, deleteNonceByUserPlan };
