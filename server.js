const express = require('express');
const path = require('path');
const fs = require('fs');

// ── Startup configuration checks ─────────────────────────────────────────────
const _missingVars = [];
if (!process.env.CLERK_JWKS_URL) _missingVars.push('CLERK_JWKS_URL');
if (!process.env.CLERK_SECRET_KEY) _missingVars.push('CLERK_SECRET_KEY');
if (_missingVars.length) {
    console.error(
        '[CONFIG ERROR] The following required environment variables are not set: ' +
        _missingVars.join(', ') + '. ' +
        'Authentication will not work and the /api/checkout endpoint will return 503. ' +
        'Set these variables in the Replit Secrets panel or your .env file.'
    );
}

const app = express();
const PORT = 5000;

// ── Clerk key injection ───────────────────────────────────────────────────────
// Allows a pk_test_... dev key to be used in non-production environments while
// production continues to use the pk_live_... key via the same env var.
const CLERK_PUBLISHABLE_KEY =
    process.env.CLERK_PUBLISHABLE_KEY ||
    'pk_live_Y2xlcmsubW9ja3Vwc2NyaXB0ZXIuY29tJA';

function serveHtmlWithClerkKey(filePath, res) {
    fs.readFile(path.join(__dirname, filePath), 'utf8', (err, html) => {
        if (err) return res.status(404).send('Not found');
        const injected = html.replace(
            /pk_live_Y2xlcmsubW9ja3Vwc2NyaXB0ZXIuY29tJA/g,
            CLERK_PUBLISHABLE_KEY
        );
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(injected);
    });
}

// ── Stripe webhook MUST be registered before express.json() ─────────────────
// The handler reads the raw request body via req.on('data') for HMAC signature
// verification. express.json() would consume the stream and leave nothing to read.
app.all('/api/webhooks/stripe', (req, res) => {
    require('./api/webhooks/stripe')(req, res);
});

app.use(express.json({ limit: '16mb' }));
app.use(express.urlencoded({ limit: '16mb', extended: true }));

app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        console.log(`${req.method} ${req.path} → ${res.statusCode} (${Date.now() - start}ms)`);
    });
    next();
});

function apiHandler(handlerPath) {
    const handler = require(handlerPath);
    return async (req, res) => {
        try {
            await handler(req, res);
        } catch (err) {
            console.error(`[ERROR] ${req.method} ${req.path}:`, err);
            if (!res.headersSent) res.status(500).json({ ok: false, error: 'Internal server error' });
        }
    };
}

app.all('/api/projects/list',   apiHandler('./api/projects/list'));
app.all('/api/projects/save',   apiHandler('./api/projects/save'));
app.all('/api/projects/:id', (req, res) => {
    req.query.id = req.params.id;
    require('./api/projects/[id]')(req, res);
});

app.all('/api/checkout',    apiHandler('./api/checkout'));
app.all('/api/export',      apiHandler('./api/export'));
app.all('/api/set-plan',    apiHandler('./api/set-plan'));
app.all('/api/billing/:action', (req, res) => {
    const h = require('./api/billing/[action]');
    return h({ ...req, query: { ...req.query, action: req.params.action } }, res);
});
app.all('/api/account/delete', apiHandler('./api/account/delete'));
app.all('/api/admin/:action', (req, res) => {
    const h = require('./api/admin/[action]');
    return h({ ...req, query: { ...req.query, action: req.params.action } }, res);
});

// Block direct requests to sensitive server-side paths before the static handler.
// In production Vercel routes all /api/* to serverless functions, so this guard
// is dev-only but avoids exposing source files on the dev server.
app.use((req, res, next) => {
    const p = req.path.toLowerCase();
    const blocked =
        p === '/server.js' ||
        p.startsWith('/api/') ||
        p.startsWith('/scripts/') ||
        p.startsWith('/tests/') ||
        p.startsWith('/node_modules/') ||
        p === '/package.json' ||
        p === '/package-lock.json' ||
        p === '/.env' ||
        p.endsWith('.env');
    if (blocked) return res.status(403).json({ ok: false, error: 'Forbidden' });
    next();
});

// ── HTML pages with Clerk key injected ───────────────────────────────────────
app.get('/',              (req, res) => serveHtmlWithClerkKey('index.html',   res));
app.get('/index.html',   (req, res) => serveHtmlWithClerkKey('index.html',   res));
app.get('/app.html',     (req, res) => serveHtmlWithClerkKey('app.html',     res));
app.get('/settings.html',(req, res) => serveHtmlWithClerkKey('settings.html', res));

app.use(express.static('.'));

// SPA catch-all — serves app.html for any non-API path
app.get('*', (req, res) => serveHtmlWithClerkKey('app.html', res));

// Catch-all error handler (handles PayloadTooLargeError and others)
app.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') {
        const mb = err.length ? (err.length / 1024 / 1024).toFixed(1) : '?';
        console.error(`[PAYLOAD TOO LARGE] ${req.method} ${req.path}: ${mb} MB`);
        return res.status(413).json({ ok: false, error: `Snapshot too large (${mb} MB). Compression may have failed — try again.` });
    }
    console.error(`[ERROR] ${req.method} ${req.path}:`, err);
    if (!res.headersSent) res.status(500).json({ ok: false, error: 'Internal server error' });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Dev server running on http://0.0.0.0:${PORT}`);
});
