// Genera build/icon.png (512×512) — el icono de la app y del instalador
// (electron-builder lo convierte a .ico). Sin dependencias: dibuja los
// píxeles a mano y escribe el PNG con zlib. Se ejecuta con
// `npm run icon`; el PNG resultante se versiona, así que solo hace falta
// volver a ejecutarlo si se cambia el diseño.
//
// Diseño: cuadrado redondeado con degradado naranja (el acento del tema
// oscuro), una "tira de película" en la base y un triángulo de play.
import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const SIZE = 512;
const pixels = new Uint8Array(SIZE * SIZE * 4);

function insideRoundRect(x, y, x0, y0, x1, y1, r) {
  const cx = Math.max(x0 + r, Math.min(x1 - r, x));
  const cy = Math.max(y0 + r, Math.min(y1 - r, y));
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function insideTriangle(px, py, [ax, ay], [bx, by], [cx, cy]) {
  const s1 = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
  const s2 = (cx - bx) * (py - by) - (cy - by) * (px - bx);
  const s3 = (ax - cx) * (py - cy) - (ay - cy) * (px - cx);
  return (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
}

const SAMPLES = 4; // supermuestreo para bordes suaves
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SAMPLES; sy++) {
      for (let sx = 0; sx < SAMPLES; sx++) {
        const px = x + (sx + 0.5) / SAMPLES;
        const py = y + (sy + 0.5) / SAMPLES;
        if (!insideRoundRect(px, py, 24, 24, 488, 488, 104)) continue;
        // Degradado diagonal naranja → rojo anaranjado.
        const t = (px + py) / (2 * SIZE);
        let cr = 255, cg = Math.round(138 - 70 * t), cb = Math.round(61 - 40 * t);
        // Tira de película: banda oscura con perforaciones.
        if (py > 372 && py < 440) {
          const hole = py > 392 && py < 420 && Math.floor((px - 40) / 44) % 2 === 0 && px > 40 && px < 472;
          if (!hole) { cr = 40; cg = 42; cb = 52; }
        }
        // Play.
        if (insideTriangle(px, py, [196, 132], [196, 332], [366, 232])) { cr = 255; cg = 255; cb = 255; }
        r += cr; g += cg; b += cb; a += 255;
      }
    }
    const n = SAMPLES * SAMPLES;
    const i = (y * SIZE + x) * 4;
    const coverage = a / 255 / n;
    pixels[i] = coverage ? Math.round(r / (coverage * n)) : 0;
    pixels[i + 1] = coverage ? Math.round(g / (coverage * n)) : 0;
    pixels[i + 2] = coverage ? Math.round(b / (coverage * n)) : 0;
    pixels[i + 3] = Math.round(a / n);
  }
}

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // filtro "none"
  Buffer.from(pixels.buffer, y * SIZE * 4, SIZE * 4).copy(raw, y * (SIZE * 4 + 1) + 1);
}
const header = Buffer.alloc(13);
header.writeUInt32BE(SIZE, 0);
header.writeUInt32BE(SIZE, 4);
header[8] = 8; // bits por canal
header[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", header),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);
mkdirSync("build", { recursive: true });
writeFileSync("build/icon.png", png);
console.log(`build/icon.png (${png.length} bytes)`);
