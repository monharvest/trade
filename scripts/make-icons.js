'use strict';
// Generates the PWA/home-screen icons as PNGs, with no image dependencies.
// Run: node scripts/make-icons.js
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 3 + 1)); // filter byte + RGB per row
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pixel(x, y, size);
      raw[o++] = r;
      raw[o++] = g;
      raw[o++] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// A green up-triangle breaking through a threshold line: the whole app in one glyph.
const BG = [17, 17, 17];
const LINE = [58, 58, 58];
const UP = [61, 214, 140];

function inTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
  const a = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / d;
  const b = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / d;
  return a >= 0 && b >= 0 && a + b <= 1;
}

function pixel(x, y, s) {
  const u = x / s;
  const v = y / s;
  // Triangle wins over the line, so it reads as breaking through the threshold
  // rather than having the line painted across it.
  if (inTriangle(u, v, 0.5, 0.24, 0.24, 0.76, 0.76, 0.76)) return UP;
  if (v > 0.655 && v < 0.69 && u > 0.08 && u < 0.92) {
    const dash = Math.floor((u - 0.08) / 0.07) % 2 === 0;
    if (dash) return LINE;
  }
  return BG;
}

const out = path.join(__dirname, '..', 'public');
for (const [name, size] of [
  ['icon-192.png', 192],
  ['icon-512.png', 512],
  ['apple-touch-icon.png', 180], // iOS uses this one for the home screen
]) {
  const file = path.join(out, name);
  fs.writeFileSync(file, png(size, pixel));
  console.log(`${name.padEnd(22)} ${size}x${size}  ${fs.statSync(file).size} bytes`);
}
