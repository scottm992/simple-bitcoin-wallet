/**
 * make-placeholder-icons.mjs — one-off generator for the PWA's placeholder icons.
 *
 * WHY THIS EXISTS
 * ---------------
 * The app is a PWA (see public/manifest.webmanifest). A manifest that references
 * missing icons produces install warnings and an incomplete build, so we ship a
 * complete end-to-end set from day one. Rather than commit opaque binary blobs
 * with no provenance, we generate them here from a tiny, auditable, dependency-
 * free PNG encoder — solid bitcoin-orange squares.
 *
 * THESE ARE PLACEHOLDERS. A designer is choosing the real artwork in parallel.
 * The real icons drop in under the SAME filenames (public/icons/icon-192.png,
 * icon-512.png, icon-maskable-512.png, and public/apple-touch-icon.png) and this
 * script is not part of the build — it is run by hand when the placeholders need
 * regenerating:  `node scripts/make-placeholder-icons.mjs`
 *
 * CONSTRAINT: Node built-ins ONLY (no npm packages — no sharp, no pngjs). We
 * hand-roll the minimal PNG chunks (IHDR/IDAT/IEND) and use zlib for IDAT.
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Placeholder brand color — bitcoin orange, matches --accent / manifest theme_color.
// (The designer's real icons replace these files, so this value is intentionally
// local to the placeholder generator, not a shared design token.)
const ORANGE = [0xf7, 0x93, 0x1a]; // #F7931A

// ---- Minimal PNG encoder (truecolor, 8-bit, no alpha) ----------------------

// Standard PNG CRC-32 (polynomial 0xEDB88320), precomputed table.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Wrap a chunk payload with its length, 4-char type, and trailing CRC. */
function chunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, data, crc]);
}

/** Build a solid-color square PNG of `size`×`size` pixels. */
function solidPng(size, [r, g, b]) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR: width, height, bit depth 8, color type 2 (truecolor RGB), no
  // compression/filter/interlace flags.
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: 2 = truecolor (RGB)
  ihdr[10] = 0; // compression method (deflate)
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace: none

  // Raw image data: each scanline is a 1-byte filter tag (0 = none) followed by
  // `size` RGB pixels. A solid fill compresses to almost nothing via deflate.
  const rowLen = 1 + size * 3;
  const raw = Buffer.alloc(rowLen * size);
  for (let y = 0; y < size; y++) {
    const rowStart = y * rowLen;
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const p = rowStart + 1 + x * 3;
      raw[p] = r;
      raw[p + 1] = g;
      raw[p + 2] = b;
    }
  }
  const idat = deflateSync(raw);

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- Emit the files --------------------------------------------------------

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = resolve(repoRoot, 'public');
const iconsDir = resolve(publicDir, 'icons');
mkdirSync(iconsDir, { recursive: true });

const outputs = [
  [resolve(iconsDir, 'icon-192.png'), 192],
  [resolve(iconsDir, 'icon-512.png'), 512],
  [resolve(iconsDir, 'icon-maskable-512.png'), 512], // full-bleed solid fill satisfies the maskable safe zone
  [resolve(publicDir, 'apple-touch-icon.png'), 180], // iOS home-screen icon
];

for (const [path, size] of outputs) {
  writeFileSync(path, solidPng(size, ORANGE));
  console.log(`wrote ${path} (${size}x${size})`);
}
