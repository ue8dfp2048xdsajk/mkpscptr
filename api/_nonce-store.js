const NONCE_TTL_MS = 300 * 1000;

const nonceStore = new Map();

function pruneExpired() {
    const now = Date.now();
    for (const [nonce, expiresAt] of nonceStore.entries()) {
        if (now >= expiresAt) {
            nonceStore.delete(nonce);
        }
    }
}

function isNonceSeen(nonce) {
    pruneExpired();
    return nonceStore.has(nonce);
}

function recordNonce(nonce) {
    nonceStore.set(nonce, Date.now() + NONCE_TTL_MS);
}

module.exports = { isNonceSeen, recordNonce };
