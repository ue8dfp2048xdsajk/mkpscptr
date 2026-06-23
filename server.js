const express = require('express');
const multer  = require('multer');
const path    = require('path');

const app    = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// Serve the static app
app.use(express.static(path.join(__dirname)));

// Background removal endpoint
app.post('/api/remove-bg', upload.single('image'), async (req, res) => {
    if(!req.file) return res.status(400).json({ error: 'No image provided' });
    try {
        const { removeBackground } = await import('@imgly/background-removal-node');
        const inputBlob   = new Blob([req.file.buffer], { type: req.file.mimetype || 'image/png' });
        const resultBlob  = await removeBackground(inputBlob);
        const arrayBuffer = await resultBlob.arrayBuffer();
        res.set('Content-Type', 'image/png');
        res.send(Buffer.from(arrayBuffer));
    } catch(err) {
        console.error('remove-bg error:', err);
        res.status(500).json({ error: err.message || String(err) });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Mockup Scripter running on http://0.0.0.0:${PORT}`);
});
