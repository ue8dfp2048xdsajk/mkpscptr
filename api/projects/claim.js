const { setCorsHeaders, handleOptions } = require('../_cors');

module.exports = function handler(req, res) {
    setCorsHeaders(req, res);
    if (handleOptions(req, res)) return;
    return res.status(404).json({ ok: false, error: 'Not found' });
};
