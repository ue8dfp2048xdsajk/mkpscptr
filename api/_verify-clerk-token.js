const { createRemoteJWKSet, jwtVerify } = require('jose');

const JWKS_URL = process.env.CLERK_JWKS_URL
    || 'https://hip-koala-72.clerk.accounts.dev/.well-known/jwks.json';

const JWKS = createRemoteJWKSet(new URL(JWKS_URL));

/**
 * Verify a Clerk session JWT from an Authorization header value
 * (e.g. "Bearer eyJ...").  Returns the Clerk user ID (sub claim)
 * if valid, or null if the token is absent / invalid / expired.
 */
async function verifyClerkToken(authorizationHeader) {
    const token = (authorizationHeader || '').replace(/^Bearer\s+/i, '').trim();
    if (!token) return null;
    try {
        const { payload } = await jwtVerify(token, JWKS);
        return typeof payload.sub === 'string' ? payload.sub : null;
    } catch {
        return null;
    }
}

module.exports = { verifyClerkToken };
