#!/usr/bin/env node
// Generates Conjure's app icons as PNGs (no dependencies): a violet tile with a
// white four-point sparkle. Writes web icons to public/ and launcher icons to android/.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function png(size, { rounded = true } = {}) {
  const px = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  const r = size * 0.22; // corner radius
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      // Rounded-square mask (anti-aliased by distance).
      let a = 1;
      if (rounded) {
        const dx = Math.max(r - x, x - (size - 1 - r), 0);
        const dy = Math.max(r - y, y - (size - 1 - r), 0);
        a = Math.min(1, Math.max(0, r - Math.hypot(dx, dy) + 0.5));
      }
      // Diagonal violet gradient.
      const t = (x + y) / (2 * size);
      let R = 124 - 40 * t, G = 92 - 40 * t, B = 255 - 30 * t;
      // Four-point sparkle: |dx|^0.5 + |dy|^0.5 <= k
      const nx = Math.abs(x - c) / size, ny = Math.abs(y - c) / size;
      const s = Math.sqrt(nx) + Math.sqrt(ny);
      const k = 0.62;
      const edge = Math.min(1, Math.max(0, (k - s) * size * 0.25));
      R = R + (255 - R) * edge; G = G + (255 - G) * edge; B = B + (255 - B) * edge;
      px[i] = R; px[i + 1] = G; px[i + 2] = B; px[i + 3] = Math.round(a * 255);
    }
  }
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

const write = (rel, buf) => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, buf);
  console.log(`wrote ${rel} (${buf.length} B)`);
};

write("public/icon-192.png", png(192));
write("public/icon-512.png", png(512));
write("public/icon-maskable-512.png", png(512, { rounded: false }));
for (const [dpi, size] of [["mdpi", 48], ["hdpi", 72], ["xhdpi", 96], ["xxhdpi", 144], ["xxxhdpi", 192]]) {
  write(`android/res/mipmap-${dpi}/ic_launcher.png`, png(size));
}
