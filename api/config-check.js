const { setCorsHeaders, handleOptions } = require('./_cors');

const USE_REDIS = Boolean(
    process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
);
const USE_PG = Boolean(process.env.DATABASE_URL);

const PRICE_KEYS = [
    'STRIPE_PRICE_STARTER_MONTHLY',
    'STRIPE_PRICE_STARTER_ANNUAL',
    'STRIPE_PRICE_STARTER_LIFETIME',
    'STRIPE_PRICE_PRO_MONTHLY',
    'STRIPE_PRICE_PRO_ANNUAL',
    'STRIPE_PRICE_PRO_LIFETIME',
];

module.exports = async function handler(req, res) {
    setCorsHeaders(req, res);
    if (handleOptions(req, res)) return;

    if (req.method !== 'GET') {
        return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }

    const prices = {};
    for (const key of PRICE_KEYS) {
        const parts = key.replace('STRIPE_PRICE_', '').toLowerCase().split('_');
        const period = parts.pop();
        const plan = parts.join('_');
        const combo = `${plan}_${period}`;
        prices[combo] = !!process.env[key];
    }

    const missing = Object.entries(prices)
        .filter(([, set]) => !set)
        .map(([combo]) => `STRIPE_PRICE_${combo.toUpperCase()}`);

    const rateLimiterBackend = USE_REDIS ? 'redis' : USE_PG ? 'postgresql' : 'in-memory';
    const rateLimiterWarning = (!USE_REDIS && !USE_PG)
        ? 'WARNING: Rate-limit counters are stored in process memory only. ' +
          'Lockouts will not survive a cold start and will not be shared across ' +
          'serverless instances. Configure UPSTASH_REDIS_REST_URL/TOKEN or ' +
          'DATABASE_URL for reliable rate limiting in production.'
        : null;

    return res.status(200).json({
        ok: true,
        stripe_configured: !!process.env.STRIPE_SECRET_KEY,
        prices,
        missing,
        all_configured: missing.length === 0,
        rate_limiter: {
            backend: rateLimiterBackend,
            durable: USE_REDIS || USE_PG,
            warning: rateLimiterWarning,
        },
    });
};
