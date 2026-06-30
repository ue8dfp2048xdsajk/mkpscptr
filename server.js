const express = require('express');
const path = require('path');

const app = express();
const PORT = 5000;

app.use(express.json({ limit: '50mb' }));

function apiHandler(handlerPath) {
    const handler = require(handlerPath);
    return (req, res) => handler(req, res);
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
