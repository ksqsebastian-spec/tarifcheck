#!/usr/bin/env node
/**
 * Erzeugt src/lib/icons.generated.ts — das Zeichen als PNG und ICO.
 *
 * Warum: public/index.html traegt das Zeichen als data:-URI. Das reicht fuer den
 * Tab im Browser, sonst nirgends. Wer ein Icon abholt — Connector-Listen,
 * Lesezeichen, Startbildschirme — fragt nach favicon.ico oder einem PNG. Und weil
 * die Dateiauslieferung hier auf single-page-application steht, bekam er bisher
 * die Startseite als HTML zurueck statt eines Bildes.
 *
 * Gerastert wird mit Chromium; das Ergebnis wird eingecheckt. Das Skript laeuft
 * nicht im Build, sondern nur, wenn sich das Zeichen aendert.
 *
 *   node scripts/gen-icons.mjs
 */
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.error("Playwright fehlt. Einmalig: npm i -D playwright && npx playwright install chromium");
  process.exit(1);
}

/* Dasselbe Zeichen wie im <link rel="icon"> von public/index.html: zwei Blaetter
   mit Haekchen. Hier auf 512 hochgezogen, damit die Rasterfassungen scharf sind. */
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
  '<rect width="64" height="64" rx="14" fill="#0E7A55"/>' +
  '<g transform="translate(12.15 12.15) scale(.62)">' +
  '<rect x="9" y="9" width="32" height="40" rx="5" fill="#fff" opacity=".62"/>' +
  '<rect x="19" y="15" width="32" height="40" rx="5" fill="#fff"/>' +
  '<path fill="none" stroke="#0E7A55" stroke-width="6.5" stroke-linecap="round" ' +
  'stroke-linejoin="round" d="M26 35.5l6 6 12-12.5"/></g></svg>';

/* --------------------------------------------------------------- PNG-Kodierung */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

const crc32 = (buf) => {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // Bit je Kanal
  ihdr[9] = 6; // RGBA

  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // Filter "keiner"
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** ICO mit PNG im Rumpf. Breite/Hoehe 0 steht laut Format fuer 256. */
function ico(pngBuf) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2); // Typ: Icon
  header.writeUInt16LE(1, 4); // ein Bild
  const entry = Buffer.alloc(16);
  entry.writeUInt16LE(1, 4); // Ebenen
  entry.writeUInt16LE(32, 6); // Bit je Pixel
  entry.writeUInt32LE(pngBuf.length, 8);
  entry.writeUInt32LE(22, 12); // Offset hinter Header und Eintrag
  return Buffer.concat([header, entry, pngBuf]);
}

/* ------------------------------------------------------------------- Rastern */

const browser = await chromium.launch();

async function raster(size) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${SVG}`,
  );
  const shot = await page.screenshot({ omitBackground: true, type: "png" });
  const pixels = await page.evaluate(
    async ([dataUrl, s]) => {
      const img = new Image();
      img.src = dataUrl;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = s;
      c.height = s;
      c.getContext("2d").drawImage(img, 0, 0, s, s);
      return Array.from(c.getContext("2d").getImageData(0, 0, s, s).data);
    },
    [`data:image/png;base64,${shot.toString("base64")}`, size],
  );
  await page.close();
  return Buffer.from(pixels);
}

const p512 = png(await raster(512), 512);
const p180 = png(await raster(180), 180);
const i256 = ico(png(await raster(256), 256));
await browser.close();

writeFileSync(
  resolve(root, "src/lib/icons.generated.ts"),
  `/* Erzeugt von scripts/gen-icons.mjs - nicht von Hand aendern.\n` +
    `   Das Zeichen als PNG und ICO, base64. Siehe den Kopf des Skripts, warum es\n` +
    `   neben dem data:-URI in public/index.html noch gebraucht wird. */\n\n` +
    `export const ICON_SVG = ${JSON.stringify(SVG)};\n\n` +
    `export const ICON_PNG_512 = "${p512.toString("base64")}";\n\n` +
    `export const ICON_PNG_180 = "${p180.toString("base64")}";\n\n` +
    `export const ICON_ICO = "${i256.toString("base64")}";\n`,
);

const kb = (b) => (b.length / 1024).toFixed(1) + " kB";
console.log(`src/lib/icons.generated.ts  PNG 512 ${kb(p512)}, PNG 180 ${kb(p180)}, ICO ${kb(i256)}`);
