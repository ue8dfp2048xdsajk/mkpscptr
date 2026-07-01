const PImage = require('pureimage');
const fs = require('fs');
const path = require('path');

const publicDir = path.join(__dirname, '..');
const FONT_BOLD = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
const FONT_REG  = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';

function drawRoundRect(ctx, x, y, w, h, r, fillColor) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
    ctx.fillStyle = fillColor;
    ctx.fill();
}

async function generateFavicon(size, outPath) {
    const img = PImage.make(size, size);
    const ctx = img.getContext('2d');

    ctx.clearRect(0, 0, size, size);

    const r = Math.round(size * 0.19);
    drawRoundRect(ctx, 0, 0, size, size, r, '#4F6EF7');

    const fontSize = Math.round(size * 0.62);
    ctx.fillStyle = '#FFFFFF';
    ctx.font = `bold ${fontSize}px DejaVuSans`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('M', size / 2, size / 2);

    await PImage.encodePNGToStream(img, fs.createWriteStream(outPath));
    console.log(`Written: ${outPath}`);
}

async function generateOGImage(outPath) {
    const w = 1200;
    const h = 630;
    const img = PImage.make(w, h);
    const ctx = img.getContext('2d');

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
    drawRoundRect(ctx, iconX, iconY, iconSize, iconSize, 18, '#4F6EF7');

    ctx.fillStyle = '#FFFFFF';
    ctx.font = `bold 54px DejaVuSans`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('M', iconX + iconSize / 2, iconY + iconSize / 2);

    ctx.fillStyle = '#FFFFFF';
    ctx.font = `bold 76px DejaVuSans`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('Mockup Scripter', 80, Math.round(h / 2) + 38);

    ctx.fillStyle = '#94A3B8';
    ctx.font = `34px DejaVuSans`;
    ctx.fillText('Batch mockup generation \u2014 faster than ever', 80, Math.round(h / 2) + 100);

    await PImage.encodePNGToStream(img, fs.createWriteStream(outPath));
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
                    const r = (pixel >>> 24) & 0xff;
                    const g = (pixel >>> 16) & 0xff;
                    const b = (pixel >>> 8)  & 0xff;
                    const a = (pixel)        & 0xff;
                    buf[pos++] = b;
                    buf[pos++] = g;
                    buf[pos++] = r;
                    buf[pos++] = a;
                }
            }
            fs.writeFileSync(icoPath, buf);
            console.log(`Written: ${icoPath}`);
            resolve();
        });
    });
}

async function main() {
    const fntBold = PImage.registerFont(FONT_BOLD, 'DejaVuSans', 700, 'normal', 'normal');
    const fntReg  = PImage.registerFont(FONT_REG,  'DejaVuSans', 400, 'normal', 'normal');
    await fntBold.load();
    await fntReg.load();

    const fav32Path  = path.join(publicDir, 'favicon-32.png');
    const fav180Path = path.join(publicDir, 'favicon-180.png');
    const ogPath     = path.join(publicDir, 'og-image.png');
    const icoPath    = path.join(publicDir, 'favicon.ico');

    await generateFavicon(32,  fav32Path);
    await generateFavicon(180, fav180Path);
    await generateOGImage(ogPath);
    await pngToIco(fav32Path, icoPath);

    console.log('All assets generated.');
}

main().catch(console.error);
