const ALLOWED_ORIGINS = [
    'https://mockupscripter.com',
    'https://www.mockupscripter.com',
];

function setCorsHeaders(req, res) {
    const origin = req.headers.origin || '';
    const allowed =
        ALLOWED_ORIGINS.includes(origin) ||
        origin.endsWith('.vercel.app') ||
        origin.endsWith('.replit.dev') ||
        origin.endsWith('.repl.co');

    if (allowed) {
        res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
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
