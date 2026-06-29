const MAX_FAILURES = 5;
const WINDOW_MS = 15 * 60 * 1000;

const failureStore = new Map();

function pruneExpired() {
    const now = Date.now();
    for (const [key, record] of failureStore.entries()) {
        if (now - record.windowStart >= WINDOW_MS) {
            failureStore.delete(key);
        }
    }
}

function isRateLimited(ip) {
    pruneExpired();
    const now = Date.now();
    const record = failureStore.get(ip);

    if (!record || now - record.windowStart >= WINDOW_MS) {
        return false;
    }

    return record.failures >= MAX_FAILURES;
}

function recordFailure(ip) {
    const now = Date.now();
    const record = failureStore.get(ip);

    if (!record || now - record.windowStart >= WINDOW_MS) {
        failureStore.set(ip, { windowStart: now, failures: 1 });
    } else {
        record.failures += 1;
    }
}

function clearFailures(ip) {
    failureStore.delete(ip);
}

module.exports = { isRateLimited, recordFailure, clearFailures };
