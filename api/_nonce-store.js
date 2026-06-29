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
    return seen.has(nonce);
}

async function recordNonce(nonce) {
    const now = Date.now();
    if (seen.has(nonce)) {
        throw new Error('Duplicate nonce — already recorded');
    }
    seen.set(nonce, now + NONCE_TTL_MS);
}

module.exports = { isNonceSeen, recordNonce };
