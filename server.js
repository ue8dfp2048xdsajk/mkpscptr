const express = require('express');
const multer  = require('multer');
const path    = require('path');

const app    = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// Serve the static app
app.use(express.static(path.join(__dirname)));

// ── Background removal ──────────────────────────────────────────────────────
// Cache the function after first import so the ONNX model is only loaded once.
let _removeBackground = null;
let _loading          = false;
let _busy             = false;

async function getRemoveBg() {
    if (_removeBackground) return _removeBackground;
    if (_loading) {
        // Wait until the ongoing load finishes
        await new Promise(resolve => {
            const interval = setInterval(() => {
                if (_removeBackground) { clearInterval(interval); resolve(); }
            }, 200);
        });
        return _removeBackground;
    }
    _loading = true;
    const mod = await import('@imgly/background-removal-node');
    _removeBackground = mod.removeBackground;
    _loading = false;
    console.log('Background removal model ready.');
    return _removeBackground;
}

app.post('/api/remove-bg', upload.single('image'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No image provided' });
    if (_busy)    return res.status(503).json({ error: 'Server is already processing an image. Please wait.' });

    _busy = true;
    try {
        const removeBackground = await getRemoveBg();
        const inputBlob        = new Blob([req.file.buffer], { type: req.file.mimetype || 'image/png' });
        const resultBlob       = await removeBackground(inputBlob);
        const arrayBuffer      = await resultBlob.arrayBuffer();
        res.set('Content-Type', 'image/png');
        res.send(Buffer.from(arrayBuffer));
    } catch (err) {
        console.error('remove-bg error:', err);
        res.status(500).json({ error: err.message || String(err) });
    } finally {
        _busy = false;
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Mockup Scripter running on http://0.0.0.0:${PORT}`);
    // Warm up the model in the background so first real request is fast
    getRemoveBg().catch(err => console.error('Model pre-load failed:', err));
});
