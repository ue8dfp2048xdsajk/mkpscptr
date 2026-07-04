const ALLOWED_ORIGINS = [
    'https://mockuprabbit.com',
    'https://www.mockuprabbit.com',
];

const DEV_ORIGIN_SUFFIXES = ['.vercel.app', '.replit.dev', '.repl.co'];

function setCorsHeaders(req, res) {
    const origin = req.headers.origin || '';
    const isProduction = process.env.NODE_ENV === 'production';

    const allowed =
        ALLOWED_ORIGINS.includes(origin) ||
        (!isProduction && DEV_ORIGIN_SUFFIXES.some(s => origin.endsWith(s)));

    if (allowed) {
        res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', '86400');
}

function handleOptions(req, res) {
    if (req.method === 'OPTIONS') {
        setCorsHeaders(req, res);
        res.status(204).end();
        return true;
    }
    return false;
}

module.exports = { setCorsHeaders, handleOptions };
