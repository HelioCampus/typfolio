// Pixel diff of two binary PPM files (P6, as pdftoppm writes them). Prints the number of differing pixels and
// the largest channel difference; exits 1 when more than `tolerance` pixels differ (default 0). With `ignore`,
// a pixel whose channels differ by at most that much is not counted (anti-aliasing of a glyph a fraction of a
// pixel off), though the largest difference is still reported.
// Usage: node ppmdiff.mjs a.ppm b.ppm [tolerance] [ignore]
import { readFileSync } from 'node:fs';

function ppm(path) {
  const bytes = readFileSync(path);
  const space = b => b === 0x20 || b === 0x0a || b === 0x0d || b === 0x09;
  let i = 0;
  const tokens = [];
  while (tokens.length < 4) {
    while (space(bytes[i])) i++;
    const start = i;
    while (!space(bytes[i])) i++;
    tokens.push(bytes.subarray(start, i).toString());
  }
  if (tokens[0] !== 'P6') throw new Error(`${path}: not a binary PPM`);
  return { width: +tokens[1], height: +tokens[2], data: bytes.subarray(i + 1) };
}

const [aPath, bPath, tolerance = '0', ignore = '0'] = process.argv.slice(2);
if (!aPath || !bPath) { console.error('usage: ppmdiff.mjs a.ppm b.ppm [tolerance]'); process.exit(2); }
const a = ppm(aPath), b = ppm(bPath);
if (a.width !== b.width || a.height !== b.height) { console.log(`size differs: ${a.width}x${a.height} vs ${b.width}x${b.height}`); process.exit(1); }
let differing = 0, max = 0;
for (let p = 0; p < a.width * a.height * 3; p += 3) {
  const d = Math.max(Math.abs(a.data[p] - b.data[p]), Math.abs(a.data[p + 1] - b.data[p + 1]), Math.abs(a.data[p + 2] - b.data[p + 2]));
  if (d) { if (d > Number(ignore)) differing++; if (d > max) max = d; }
}
console.log(`${differing} of ${a.width * a.height} px differ (max channel delta ${max})`);
process.exit(differing > Number(tolerance) ? 1 : 0);
