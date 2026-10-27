// Makes the images of fixtures/figures and the two data files that embed them as data URLs. Run from the
// repository root (playwright and sharp come from its node_modules):
//   node experiments/paramdoc/notes/make-figure-images.mjs
// chart.png is drawn on a canvas in Chromium, as the demo application draws its charts (8-bit RGBA, transparent
// background); chart.jpg is the same chart on white; photo.jpg and tall.png come from sharp; icon.png (grey with a
// tRNS colour key), logo.png (8-bit palette) and dot.png (one RGB pixel) are written by hand.
import { chromium } from 'playwright';
import sharp from 'sharp';
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'figures');

const browser = await chromium.launch();
const page = await browser.newPage();
const { png, jpg } = await page.evaluate(() => {
  const canvas = document.createElement('canvas');
  canvas.width = 480; canvas.height = 160;
  const ctx = canvas.getContext('2d');
  const scores = [62, 71, 68, 80, 77, 85, 90, 88];
  ctx.strokeStyle = '#c9d2cb'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(40, 20); ctx.lineTo(40, 130); ctx.lineTo(460, 130); ctx.stroke();
  ctx.fillStyle = '#2f6f4f';
  scores.forEach((s, i) => { const h = s * 1.1; ctx.fillRect(60 + i * 50, 130 - h, 30, h); });
  ctx.fillStyle = '#17211b'; ctx.font = '14px serif';
  scores.forEach((s, i) => ctx.fillText(`W${i + 1}`, 64 + i * 50, 148));
  const png = canvas.toDataURL('image/png');
  const jc = document.createElement('canvas'); jc.width = 480; jc.height = 160;
  const j = jc.getContext('2d'); j.fillStyle = '#ffffff'; j.fillRect(0, 0, 480, 160); j.drawImage(canvas, 0, 0);
  return { png, jpg: jc.toDataURL('image/jpeg', 0.85) };
});
await browser.close();
const fromUrl = (url) => Buffer.from(url.split(',')[1], 'base64');
const images = { 'chart.png': fromUrl(png), 'chart.jpg': fromUrl(jpg) };

// A 300 x 200 "photograph": gradients and a disc, 3 channels, no metadata.
const [w, h] = [300, 200], raw = Buffer.alloc(w * h * 3);
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
  const i = (y * w + x) * 3, d = Math.hypot(x - 110, y - 90);
  raw[i] = d < 50 ? 230 : 40 + (x / w) * 120; raw[i + 1] = d < 50 ? 190 : 80 + (y / h) * 100; raw[i + 2] = d < 50 ? 60 : 110;
}
images['photo.jpg'] = await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 80 }).toBuffer();
// A 100 x 300 RGB PNG: tall, so `cover` crops it vertically in a wide box.
const [tw, th] = [100, 300], traw = Buffer.alloc(tw * th * 3);
for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) { const i = (y * tw + x) * 3; traw[i] = 20 + (y / th) * 200; traw[i + 1] = 120; traw[i + 2] = 220 - (x / tw) * 150; }
images['tall.png'] = await sharp(traw, { raw: { width: tw, height: th, channels: 3 } }).png({ compressionLevel: 9, palette: false }).toBuffer();

// Hand-written PNGs.
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (kind, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(kind, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
const pngFile = (width, height, colorType, rows, extra = []) => {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = colorType;
  const rawRows = Buffer.concat(rows.flatMap(r => [Buffer.from([0]), r]));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), ...extra, chunk('IDAT', deflateSync(rawRows, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
};
// icon: 32 x 32 grey ring; grey 255 is the transparent key.
const iconRows = [];
for (let y = 0; y < 32; y++) { const row = Buffer.alloc(32); for (let x = 0; x < 32; x++) { const d = Math.hypot(x - 15.5, y - 15.5); row[x] = d >= 9 && d <= 14 ? 60 : d < 9 ? 180 : 255; } iconRows.push(row); }
const trns = Buffer.alloc(2); trns.writeUInt16BE(255);
images['icon.png'] = pngFile(32, 32, 0, iconRows, [chunk('tRNS', trns)]);
// logo: 120 x 40, four palette entries, "TYP" in blocks with a frame.
const palette = Buffer.from([0xee, 0xf2, 0xed, 0x2f, 0x6f, 0x4f, 0x17, 0x21, 0x1b, 0xc9, 0xd2, 0xcb]);
const logoRows = [];
for (let y = 0; y < 40; y++) {
  const row = Buffer.alloc(120);
  for (let x = 0; x < 120; x++) {
    let c = 0;
    if (y >= 6 && y <= 33) {
      if (x >= 8 && x <= 32 && (y <= 12 || (x >= 16 && x <= 24))) c = 1;
      else if (x >= 40 && x <= 64 && ((y <= 20 && (x <= 46 || x >= 58)) || (y > 18 && x >= 48 && x <= 56))) c = 2;
      else if (x >= 72 && x <= 96 && (x <= 78 || (y <= 20 && (y <= 12 || x >= 90)))) c = 1;
    }
    if (y === 0 || y === 39 || x === 0 || x === 119) c = 3;
    row[x] = c;
  }
  logoRows.push(row);
}
images['logo.png'] = pngFile(120, 40, 3, logoRows, [chunk('PLTE', palette)]);
images['dot.png'] = pngFile(1, 1, 2, [Buffer.from([0x2f, 0x6f, 0x4f])]);

writeFileSync(join(dir, 'logo.png'), images['logo.png']);
const url = (name) => `data:${name.endsWith('.jpg') ? 'image/jpeg' : 'image/png'};base64,${images[name].toString('base64')}`;
const data = {
  title: 'Learning outcomes, autumn term',
  summary: 'Weekly scores climbed from the low sixties to the high eighties once the revision sessions started; the dip in week three follows the field trip.',
  chart: { src: url('chart.png'), alt: 'Bar chart of weekly scores rising from 62 in week one to 88 in week eight' },
  photo: url('photo.jpg'),
  caption: 'The cohort photographed after the final presentations. Twenty-four students completed the module; three joined in week two and caught up by the midterm.',
  icon: url('icon.png'),
  badge: 'Completion badge awarded to 21 of 24 students',
};
const tall = {
  title: 'Learning outcomes, spring term',
  summary: 'A quieter term: scores held between seventy and eighty with no field trip to disturb them.',
  chart: { src: url('tall.png'), alt: 'A tall gradient test image standing in for the chart' },
  photo: url('chart.jpg'),
  caption: "The chart again, this time as a JPEG letterboxed into the photograph's frame.",
  icon: url('dot.png'),
  badge: 'One green pixel, stretched',
};
writeFileSync(join(dir, 'data.json'), JSON.stringify(data, null, 2) + '\n');
writeFileSync(join(dir, 'data-tall.json'), JSON.stringify(tall, null, 2) + '\n');
for (const [name, bytes] of Object.entries(images)) console.log(`${name}: ${bytes.length} bytes`);
