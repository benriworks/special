#!/usr/bin/env node
/**
 * Generate placeholder PNG assets (PWA icons + OGP image) with a tiny
 * dependency-free PNG encoder. Run: node scripts/gen-assets.mjs
 * Outputs: public/icons/icon-192.png, public/icons/icon-512.png, public/og.png
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// minimal PNG encoder (RGBA8, filter 0)
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function encodePNG(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// painters
// ---------------------------------------------------------------------------
const BG = [5, 11, 20];        // #050b14
const ACCENT = [102, 255, 194]; // #66ffc2
const TEAL = [25, 211, 197];    // #19d3c5
const VIOLET = [138, 99, 255];  // #8a63ff
const BRIGHT = [232, 251, 255]; // #e8fbff

/**
 * App icon: luminous ring + bright core on #050b14, with a small satellite
 * dot riding the ring (echoes favicon.svg) and a faint violet aurora cast in
 * the lower-left. All content stays inside the maskable safe zone (r < 0.8).
 */
function glowDisc(size) {
  const px = Buffer.alloc(size * size * 4);
  const c = size / 2;
  const RING_R = 0.55; // ring radius, in units of half-size
  // satellite sits on the ring at 45° upper-right
  const sx = c + Math.cos(-Math.PI / 4) * RING_R * c;
  const sy = c + Math.sin(-Math.PI / 4) * RING_R * c;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - c;
      const dy = y - c;
      const d = Math.hypot(dx, dy) / c;
      const glow = Math.exp(-d * d * 4.5);                          // ambient accent glow
      const vio = Math.exp(-(((dx + c * 0.45) ** 2 + (dy - c * 0.45) ** 2) / (0.8 * c) ** 2)); // violet cast, lower-left
      const ring = Math.exp(-(((d - RING_R) / 0.030) ** 2));        // crisp ring
      const halo = Math.exp(-(((d - RING_R) / 0.11) ** 2)) * 0.30;  // soft halo around ring
      const core = Math.exp(-d * d * 40) * 1.25;                    // bright center
      const sd = Math.hypot(x - sx, y - sy) / c;
      const sat = Math.exp(-((sd / 0.05) ** 2));                    // satellite dot
      const satHalo = Math.exp(-((sd / 0.16) ** 2)) * 0.45;
      const o = (y * size + x) * 4;
      for (let i = 0; i < 3; i++) {
        const v =
          BG[i] +
          TEAL[i] * glow * 0.30 +
          VIOLET[i] * vio * 0.22 +
          ACCENT[i] * (ring * 0.95 + halo + satHalo) +
          BRIGHT[i] * (core + sat);
        px[o + i] = Math.max(0, Math.min(255, Math.round(v)));
      }
      px[o + 3] = 255;
    }
  }
  return px;
}

// 5x7 bitmap glyphs for the wordmark
const GLYPHS = {
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
};

function ogImage(width, height) {
  const px = Buffer.alloc(width * height * 4);
  const gcx = width * 0.5;
  const gcy = height * 0.44;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = Math.hypot(x - gcx, y - gcy) / (height * 0.85);
      const glow = Math.exp(-d * d * 3.2);
      const o = (y * width + x) * 4;
      for (let i = 0; i < 3; i++) {
        const v = BG[i] * (0.85 + 0.15 * (1 - y / height)) + ACCENT[i] * glow * 0.28;
        px[o + i] = Math.max(0, Math.min(255, Math.round(v)));
      }
      px[o + 3] = 255;
    }
  }
  // wordmark "LUMINA"
  const word = 'LUMINA';
  const cell = 16;
  const gap = 40;
  const letterW = 5 * cell;
  const totalW = word.length * letterW + (word.length - 1) * gap;
  const x0 = Math.round((width - totalW) / 2);
  const y0 = Math.round(height * 0.44 - (7 * cell) / 2);
  const setPx = (x, y, rgb, a) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const o = (y * width + x) * 4;
    for (let i = 0; i < 3; i++) px[o + i] = Math.max(0, Math.min(255, Math.round(px[o + i] * (1 - a) + rgb[i] * a)));
  };
  word.split('').forEach((ch, li) => {
    const rows = GLYPHS[ch];
    const lx = x0 + li * (letterW + gap);
    rows.forEach((row, ry) => {
      row.split('').forEach((bit, rx) => {
        if (bit !== '1') return;
        for (let dy = 0; dy < cell; dy++) {
          for (let dx = 0; dx < cell; dx++) {
            setPx(lx + rx * cell + dx, y0 + ry * cell + dy, BRIGHT, 0.95);
          }
        }
        // soft accent halo around each cell
        for (let dy = -4; dy < cell + 4; dy++) {
          for (let dx = -4; dx < cell + 4; dx++) {
            if (dx >= 0 && dx < cell && dy >= 0 && dy < cell) continue;
            const dist = Math.max(Math.abs(dx - cell / 2), Math.abs(dy - cell / 2)) - cell / 2;
            setPx(lx + rx * cell + dx, y0 + ry * cell + dy, ACCENT, Math.max(0, 0.18 - dist * 0.035));
          }
        }
      });
    });
  });
  return px;
}

// ---------------------------------------------------------------------------
// `--icons-only` regenerates the PWA icons without touching public/og.png
// (og.png is replaced by a real screenshot in a later phase).
const iconsOnly = process.argv.includes('--icons-only');

mkdirSync(resolve(root, 'public/icons'), { recursive: true });
for (const size of [192, 512]) {
  writeFileSync(resolve(root, `public/icons/icon-${size}.png`), encodePNG(size, size, glowDisc(size)));
  console.log(`wrote public/icons/icon-${size}.png`);
}
if (!iconsOnly) {
  writeFileSync(resolve(root, 'public/og.png'), encodePNG(1200, 630, ogImage(1200, 630)));
  console.log('wrote public/og.png');
}
