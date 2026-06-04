/*
 * Build the store-ready extension packages — zero dependencies.
 *
 *   node tools/package.mjs
 *
 * Produces:
 *   dist/tierfill-firefox.zip   manifest as-is (keeps browser_specific_settings.gecko)
 *   dist/tierfill-chrome.zip    manifest with the Firefox-only gecko key stripped
 *
 * Only the runtime files are bundled (manifest, src/, assets/data-snapshot.json,
 * icons/, LICENSE) — never tools/, docs/, spike/, or the data-source inputs.
 *
 * The ZIP is written by a tiny built-in writer (deflate via node:zlib) so there
 * is no build dependency to install, locally or in CI. Timestamps are fixed for
 * reproducible, byte-stable archives.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, rmSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const DIST = join(ROOT, 'dist');

// ── tiny ZIP writer ──────────────────────────────────────────────────────────
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
})();

// fixed DOS date/time (2020-01-01 00:00:00) for deterministic output
const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1;
const DOS_TIME = 0;

function zip(entries) {
  // entries: [{ name, data: Buffer }]
  const locals = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = CRC(data);
    const comp = deflateRawSync(data, { level: 9 });
    const usz = data.length;
    const csz = comp.length;

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4); // version needed
    lh.writeUInt16LE(0, 6); // flags
    lh.writeUInt16LE(8, 8); // method = deflate
    lh.writeUInt16LE(DOS_TIME, 10);
    lh.writeUInt16LE(DOS_DATE, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(csz, 18);
    lh.writeUInt32LE(usz, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28); // extra len
    locals.push(lh, nameBuf, comp);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4); // version made by
    ch.writeUInt16LE(20, 6); // version needed
    ch.writeUInt16LE(0, 8); // flags
    ch.writeUInt16LE(8, 10); // method
    ch.writeUInt16LE(DOS_TIME, 12);
    ch.writeUInt16LE(DOS_DATE, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(csz, 20);
    ch.writeUInt32LE(usz, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30); // extra
    ch.writeUInt16LE(0, 32); // comment
    ch.writeUInt16LE(0, 34); // disk start
    ch.writeUInt16LE(0, 36); // internal attrs
    ch.writeUInt32LE(0, 38); // external attrs
    ch.writeUInt32LE(offset, 42); // local header offset
    central.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + comp.length;
  }
  const localBuf = Buffer.concat(locals);
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([localBuf, centralBuf, eocd]);
}

// ── collect runtime files ────────────────────────────────────────────────────
function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

const toEntry = (absPath, data) => ({
  name: relative(ROOT, absPath).split('\\').join('/'),
  data,
});

function runtimeEntries(manifestData) {
  const entries = [];
  entries.push({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifestData, null, 2) + '\n', 'utf8') });
  for (const p of walk(join(ROOT, 'src'))) entries.push(toEntry(p, readFileSync(p)));
  entries.push(toEntry(join(ROOT, 'assets', 'data-snapshot.json'), readFileSync(join(ROOT, 'assets', 'data-snapshot.json'))));
  for (const n of ['icon-16.png', 'icon-48.png', 'icon-128.png']) {
    const p = join(ROOT, 'icons', n);
    entries.push(toEntry(p, readFileSync(p)));
  }
  entries.push(toEntry(join(ROOT, 'LICENSE'), readFileSync(join(ROOT, 'LICENSE'))));
  // deterministic order
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return entries;
}

// ── build ────────────────────────────────────────────────────────────────────
const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
const version = manifest.version;

const firefox = JSON.parse(JSON.stringify(manifest)); // keep gecko key
const chrome = JSON.parse(JSON.stringify(manifest));
delete chrome.browser_specific_settings; // Chrome Web Store dislikes the gecko key

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

for (const [target, data] of [['firefox', firefox], ['chrome', chrome]]) {
  const out = join(DIST, `tierfill-${target}.zip`);
  const entries = runtimeEntries(data);
  writeFileSync(out, zip(entries));
  const kb = (statSync(out).size / 1024).toFixed(1);
  console.log(`✓ ${relative(ROOT, out).split('\\').join('/')}  (${entries.length} files, ${kb} KB)`);
}
console.log(`\nPackaged TierFill v${version}.`);
