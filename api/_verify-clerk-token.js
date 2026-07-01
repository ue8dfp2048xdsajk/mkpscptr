const { createRemoteJWKSet, jwtVerify } = require('jose');

const JWKS_URL = process.env.CLERK_JWKS_URL;
if (!JWKS_URL) {
    console.error(
        '_verify-clerk-token: CLERK_JWKS_URL is not set. ' +
        'All token verification will fail. Set this to your Clerk JWKS endpoint ' +
        '(e.g. https://clerks.yourdomain.com/.well-known/jwks.json).'
    );
}

const JWKS = JWKS_URL ? createRemoteJWKSet(new URL(JWKS_URL)) : null;

/**
 * Verify a Clerk session JWT from an Authorization header value
 * (e.g. "Bearer eyJ...").  Returns the Clerk user ID (sub claim)
 * if valid, or null if the token is absent / invalid / expired.
 */
async function verifyClerkToken(authorizationHeader) {
    if (!JWKS) return null;
    const token = (authorizationHeader || '').replace(/^Bearer\s+/i, '').trim();
    if (!token) return null;
    try {
        const { payload } = await jwtVerify(token, JWKS);
        return typeof payload.sub === 'string' ? payload.sub : null;
    } catch {
        return null;
    }
}

/**
 * Verify a Clerk session JWT and return both the user ID and the full
 * verified payload.  Returns { userId, payload } if valid, or null if the
 * token is absent / invalid / expired.
 *
 * Use this variant when you need claims beyond sub — e.g. public_metadata —
 * so you can avoid a second round-trip to the Clerk REST API.
 */
async function verifyClerkTokenFull(authorizationHeader) {
    if (!JWKS) return null;
    const token = (authorizationHeader || '').replace(/^Bearer\s+/i, '').trim();
    if (!token) return null;
    try {
        const { payload } = await jwtVerify(token, JWKS);
        if (typeof payload.sub !== 'string') return null;
        return { userId: payload.sub, payload };
    } catch {
        return null;
    }
}

module.exports = { verifyClerkToken, verifyClerkTokenFull };
