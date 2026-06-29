const { setCorsHeaders, handleOptions } = require('./_cors');

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

    return res.status(200).json({
        ok: true,
        stripe_configured: !!process.env.STRIPE_SECRET_KEY,
        prices,
        missing,
        all_configured: missing.length === 0,
    });
};
