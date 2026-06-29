const { Pool } = require('pg');

const NONCE_TTL_MS = 300 * 1000;

function buildSslConfig() {
    const host = process.env.PGHOST || '';
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
        return false;
    }
    return true;
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: buildSslConfig(),
});

async function ensureTable() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS nonce_store (
            nonce TEXT PRIMARY KEY,
            expires_at BIGINT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS nonce_store_expires_idx ON nonce_store (expires_at);
    `);
}

const tableReady = ensureTable().catch((err) => {
    console.error('nonce-store: failed to ensure table', err);
});

/**
 * Atomically attempts to record the nonce.
 * Returns false if this is the first time the nonce is seen (insert succeeded).
 * Returns true if the nonce was already recorded (conflict = replay attempt).
 */
async function isNonceSeen(nonce) {
    await tableReady;
    const now = Date.now();
    const expiresAt = now + NONCE_TTL_MS;

    await pool.query('DELETE FROM nonce_store WHERE expires_at <= $1', [now]);

    const result = await pool.query(
        'INSERT INTO nonce_store (nonce, expires_at) VALUES ($1, $2) ON CONFLICT (nonce) DO NOTHING',
        [nonce, expiresAt]
    );

    return result.rowCount === 0;
}

/**
 * No-op: the atomic insert is performed inside isNonceSeen.
 * Kept for API compatibility.
 */
async function recordNonce(_nonce) {
    // Intentional no-op: isNonceSeen already performed the atomic insert.
}

module.exports = { isNonceSeen, recordNonce };
