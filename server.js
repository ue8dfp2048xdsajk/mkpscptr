const express = require('express');
const path = require('path');

const app = express();
const PORT = 5000;

app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ limit: '500mb', extended: true }));

app.use((req, res, next) => {
    const start = Date.now();
    if (req.method === 'POST' || req.method === 'PUT') {
        const cl = req.headers['content-length'];
        if (cl) console.log(`${req.method} ${req.path} content-length: ${(parseInt(cl)/1024/1024).toFixed(2)} MB`);
    }
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

app.get('/api/debug/size', (req, res) => {
    console.log('[SNAPSHOT SIZE DEBUG]', req.query);
    res.json({ ok: true });
});

app.all('/api/projects/list',   apiHandler('./api/projects/list'));
app.all('/api/projects/save',   apiHandler('./api/projects/save'));
app.all('/api/projects/claim',  apiHandler('./api/projects/claim'));
app.all('/api/projects/:id', (req, res) => {
    req.query.id = req.params.id;
    require('./api/projects/[id]')(req, res);
});

app.all('/api/checkout',    apiHandler('./api/checkout'));
app.all('/api/export',      apiHandler('./api/export'));
app.all('/api/set-plan',    apiHandler('./api/set-plan'));
app.all('/api/config-check', apiHandler('./api/config-check'));
app.all('/api/clear-nonce', apiHandler('./api/clear-nonce'));

app.use(express.static('.'));

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

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
