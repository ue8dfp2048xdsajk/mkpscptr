const express = require('express');
const path = require('path');

const app = express();
const PORT = 5000;

app.use(express.json({ limit: '50mb' }));

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

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Dev server running on http://0.0.0.0:${PORT}`);
});
