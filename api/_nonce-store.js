const NONCE_TTL_MS = 300 * 1000;

const seen = new Map();

function pruneExpired() {
    const now = Date.now();
    for (const [nonce, expiresAt] of seen.entries()) {
        if (now >= expiresAt) seen.delete(nonce);
    }
}

async function isNonceSeen(nonce) {
    pruneExpired();
    const now = Date.now();
    if (seen.has(nonce)) return true;
    seen.set(nonce, now + NONCE_TTL_MS);
    return false;
}

async function recordNonce(_nonce) {
    // no-op: isNonceSeen handles recording atomically
}

module.exports = { isNonceSeen, recordNonce };
