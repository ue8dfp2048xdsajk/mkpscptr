const { createCanvas, loadImage } = require('canvas');
const fs = require('fs');
const path = require('path');

const publicDir = path.join(__dirname, '..');
const logoPath  = path.join(publicDir, 'logo.png');

async function resizeLogo(size, outPath) {
    const src = await loadImage(logoPath);
    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(src, 0, 0, size, size);
    fs.writeFileSync(outPath, canvas.toBuffer('image/png'));
    console.log(`Written: ${outPath}`);
}

async function generateOGImage(outPath) {
    const logo = await loadImage(logoPath);
    const w = 1200;
    const h = 630;
    const canvas = createCanvas(w, h);
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#0F1624';
    ctx.fillRect(0, 0, w, h);

    ctx.fillStyle = '#4F6EF7';
    ctx.fillRect(0, 0, 8, h);

    ctx.fillStyle = 'rgba(79,110,247,0.08)';
    for (let i = 0; i < 6; i++) {
        ctx.fillRect(120 + i * 180, 0, 1, h);
    }

    const iconSize = 88;
    const iconX = 80;
    const iconY = Math.round(h / 2) - 130;
    ctx.drawImage(logo, iconX, iconY, iconSize, iconSize);

    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 76px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('Mockup Rabbit', 80, Math.round(h / 2) + 38);

    ctx.fillStyle = '#94A3B8';
    ctx.font = '34px sans-serif';
    ctx.fillText('Batch mockup generation - faster than ever', 80, Math.round(h / 2) + 100);

    fs.writeFileSync(outPath, canvas.toBuffer('image/png'));
    console.log(`Written: ${outPath}`);
}

function pngToIco(pngPath, icoPath) {
    const pngBuf = fs.readFileSync(pngPath);
    const size = 32;
    const bpp = 32;
    const imageDataSize = size * size * 4;
    const andMaskSize = size * Math.ceil(size / 8);
    const dibSize = 40 + imageDataSize + andMaskSize;
    const totalSize = 6 + 16 + dibSize;

    const buf = Buffer.alloc(totalSize, 0);
    let pos = 0;

    buf.writeUInt16LE(0, pos); pos += 2;
    buf.writeUInt16LE(1, pos); pos += 2;
    buf.writeUInt16LE(1, pos); pos += 2;

    buf.writeUInt8(size, pos); pos += 1;
    buf.writeUInt8(size, pos); pos += 1;
    buf.writeUInt8(0, pos); pos += 1;
    buf.writeUInt8(0, pos); pos += 1;
    buf.writeUInt16LE(1, pos); pos += 2;
    buf.writeUInt16LE(bpp, pos); pos += 2;
    buf.writeUInt32LE(dibSize, pos); pos += 4;
    buf.writeUInt32LE(22, pos); pos += 4;

    buf.writeUInt32LE(40, pos); pos += 4;
    buf.writeInt32LE(size, pos); pos += 4;
    buf.writeInt32LE(size * 2, pos); pos += 4;
    buf.writeUInt16LE(1, pos); pos += 2;
    buf.writeUInt16LE(bpp, pos); pos += 2;
    buf.writeUInt32LE(0, pos); pos += 4;
    buf.writeUInt32LE(imageDataSize, pos); pos += 4;
    buf.writeInt32LE(0, pos); pos += 4;
    buf.writeInt32LE(0, pos); pos += 4;
    buf.writeUInt32LE(0, pos); pos += 4;
    buf.writeUInt32LE(0, pos); pos += 4;

    const png = require('pureimage');
    const { Readable } = require('stream');
    const stream = Readable.from(pngBuf);

    return new Promise((resolve) => {
        png.decodePNGFromStream(stream).then((img) => {
            for (let y = size - 1; y >= 0; y--) {
                for (let x = 0; x < size; x++) {
                    const pixel = img.getPixelRGBA(x, y);
                    buf[pos++] = (pixel >>> 8)  & 0xff;
                    buf[pos++] = (pixel >>> 16) & 0xff;
                    buf[pos++] = (pixel >>> 24) & 0xff;
                    buf[pos++] = pixel & 0xff;
                }
            }
            fs.writeFileSync(icoPath, buf);
            console.log(`Written: ${icoPath}`);
            resolve();
        });
    });
}

async function main() {
    if (!fs.existsSync(logoPath)) {
        console.error(`Missing ${logoPath} - add logo.png before running this script.`);
        process.exit(1);
    }

    const fav32Path  = path.join(publicDir, 'favicon-32.png');
    const fav180Path = path.join(publicDir, 'favicon-180.png');
    const ogPath     = path.join(publicDir, 'og-image.png');
    const icoPath    = path.join(publicDir, 'favicon.ico');

    await resizeLogo(32,  fav32Path);
    await resizeLogo(180, fav180Path);
    await generateOGImage(ogPath);
    await pngToIco(fav32Path, icoPath);

    console.log('All assets generated from logo.png.');
}

main().catch(console.error);
