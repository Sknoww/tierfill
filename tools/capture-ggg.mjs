/*
 * capture-ggg — save GGG's trade lists (stats, items, filters) into tools/data-sources/.
 *
 *   node tools/capture-ggg.mjs                 # print the browser snippet and these steps
 *   node tools/capture-ggg.mjs <file>          # split a downloaded tierfill-ggg-capture.json
 *   node tools/capture-ggg.mjs --downloads     # same, using ~/Downloads/tierfill-ggg-capture.json
 *
 * GGG's /api/trade2/data/* lists are Cloudflare-blocked to server-side fetches, but any
 * browser tab on pathofexile.com can read them with no login. The trade page's CSP blocks
 * posting them to a local server, so the snippet downloads one file instead:
 *   1. Open https://www.pathofexile.com/trade2 (a Cloudflare "Just a moment…" page works too).
 *   2. Paste the snippet into its devtools console. It fetches the three lists and saves
 *      tierfill-ggg-capture.json.
 *   3. Run this script on that file. It checks each list's shape and writes:
 *        tools/data-sources/ggg-trade2-stats.json    (build-data's GGG join)
 *        tools/data-sources/ggg-trade2-items.json    (base items, for reference)
 *        tools/data-sources/ggg-trade2-filters.json  (trade categories, for check-data)
 *      The previous stats file is kept as ggg-trade2-stats.prev.json so check-data can list
 *      the explicit stats GGG added since the last capture.
 */
import { readFile, writeFile, copyFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, 'data-sources');
const NAMES = ['stats', 'items', 'filters'];
const FILE_NAME = 'tierfill-ggg-capture.json';

export const SNIPPET = `(async () => {
  const all = {};
  for (const n of ${JSON.stringify(NAMES)}) {
    const r = await fetch('/api/trade2/data/' + n);
    if (!r.ok) throw new Error(n + ': HTTP ' + r.status);
    all[n] = await r.json();
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(all)], { type: 'application/json' }));
  a.download = '${FILE_NAME}';
  a.click();
  console.log('TierFill: saved ${FILE_NAME}');
})();`;

// Shape check per list; returns a one-line summary or throws.
export function checkList(name, data) {
  const groups = data && data.result;
  if (!Array.isArray(groups) || !groups.length) throw new Error(`${name}: no "result" array`);
  if (name === 'stats') {
    const explicit = groups.find((g) => g.id === 'explicit');
    if (!explicit || !(explicit.entries || []).length) throw new Error('stats: no explicit stats');
    return `${explicit.entries.length} explicit stats`;
  }
  if (name === 'filters') {
    const options = categoryOptions(data);
    if (!options.length) throw new Error('filters: no type_filters → category options');
    return `${options.length} trade categories`;
  }
  const n = groups.reduce((s, g) => s + (g.entries || []).length, 0);
  if (!n) throw new Error('items: no entries');
  return `${n} base items`;
}

// The trade site's item categories: [{ id, text }] from /filters → type_filters → category.
export function categoryOptions(filters) {
  const tf = ((filters && filters.result) || []).find((g) => g.id === 'type_filters');
  const cat = ((tf && tf.filters) || []).find((f) => f.id === 'category');
  return (cat && cat.option && cat.option.options) || [];
}

const fileFor = (name) => join(SRC, `ggg-trade2-${name}.json`);

async function save(name, data) {
  const summary = checkList(name, data);
  if (name === 'stats') {
    try {
      await access(fileFor('stats'));
      await copyFile(fileFor('stats'), join(SRC, 'ggg-trade2-stats.prev.json'));
    } catch { /* first capture */ }
  }
  await writeFile(fileFor(name), JSON.stringify(data, null, 2) + '\n');
  console.log(`  ✓ ${name}: ${summary} → ${fileFor(name)}`);
}

async function split(path) {
  const all = JSON.parse(await readFile(path, 'utf8'));
  // check all three before writing any, so a bad file changes nothing
  for (const n of NAMES) checkList(n, all[n]);
  for (const n of NAMES) await save(n, all[n]);
  console.log('\nNext: node tools/refresh.mjs --no-fetch');
}

async function main() {
  const arg = process.argv[2];
  if (arg === '--downloads') return split(join(homedir(), 'Downloads', FILE_NAME));
  if (arg) return split(resolve(arg));
  console.log('1. Open https://www.pathofexile.com/trade2 (no login needed).');
  console.log(`2. Paste this into its devtools console; it saves ${FILE_NAME}:\n`);
  console.log(SNIPPET);
  console.log(`\n3. Run: node tools/capture-ggg.mjs --downloads   (or pass the file's path)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((e) => {
    console.error('✖ capture-ggg failed:', e.message);
    process.exitCode = 1;
  });
}
