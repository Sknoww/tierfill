/*
 * fetch-poe2db-mods — pull tier ladders that the PoE2DB enhancer dataset is
 * missing, straight from PoE2DB's own item-class pages.
 *
 *   node tools/fetch-poe2db-mods.mjs           # fetch → tools/data-sources/poe2db-extra-mods.json
 *   node tools/fetch-poe2db-mods.mjs --dry      # fetch + print the parsed ladders, write nothing
 *
 * WHY this exists (HANDOFF issue #2 — "Deflection stat shows no tier option"):
 *   The PoE2DB-derived enhancer mods2-data.json predates the Deflection mechanic, so
 *   it carries ZERO deflection ladders — and the upstream mirror is byte-identical, so
 *   `tools/refresh.mjs` can't introduce them either. PoE2DB itself DOES have the
 *   ladders: single-material item-class pages (e.g. /us/Bucklers) embed the full mod
 *   pool as inline JSON (Name / Level / str-with-ranges / ModFamilyList / spawn tags).
 *   We scrape exactly the deflection mod we need from there and emit it in the SAME
 *   shape as a mods2-data bucket so build-data.mjs can ingest it with no special-casing.
 *
 * SCOPE (deliberately narrow — see HANDOFF + the session decision):
 *   Of the five GGG "deflection" explicits, only ONE actually rolls on real items —
 *   "Gain Deflection Rating equal to #% of Evasion Rating" (explicit.stat_3033371881),
 *   confirmed against the project's 531-observation trade capture. The other four are
 *   absent from every real item and live on JS-gated PoE2DB tables; we intentionally do
 *   NOT fabricate controls for mods players can't obtain. Add a TARGET entry below if a
 *   future patch makes another deflection mod real.
 *
 * Output (tools/data-sources/poe2db-extra-mods.json) is merged ALONGSIDE the enhancer
 * source by build-data.mjs. It is a SEPARATE file on purpose: refresh.mjs only rewrites
 * enhancer-mods2-data.json, so these hand-targeted ladders survive a per-patch refresh.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, 'data-sources');
const OUT = join(SRC, 'poe2db-extra-mods.json');
const DRY = process.argv.includes('--dry');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

// ── what to scrape ────────────────────────────────────────────────────────────
// Each target names a PoE2DB item-class page that embeds the mod pool as JSON, the
// ModFamily to pull, which generation type (1=prefix, 2=suffix), the bucket to emit
// into, and the `types` (trade slot tokens) the mod can appear on. `types` is derived
// from the mod's spawn tags: the deflection-from-evasion mod spawns on any evasion /
// hybrid-evasion armour base, i.e. every armour slot (verified on shield + gloves in
// the real trade capture; the rest follow from the spawn tags str/dex_armour …).
const TARGETS = [
  {
    page: 'Bucklers',
    family: 'EvasionAppliesToDeflection',
    genType: '2', // suffix
    bucket: 'suffix',
    types: ['shield', 'gloves', 'boots', 'helmet', 'body-armour'],
  },
];

// ── tiny HTML/JSON helpers ──────────────────────────────────────────────────────
// Return the smallest {...} object enclosing `pos`, by brace-matching outward then
// inward. PoE2DB embeds each mod as a flat JSON object; this lifts one out of the page.
function enclosingObject(s, pos) {
  let depth = 0;
  let start = -1;
  for (let i = pos; i >= 0; i--) {
    const c = s[i];
    if (c === '}') depth++;
    else if (c === '{') {
      if (depth === 0) { start = i; break; }
      depth--;
    }
  }
  if (start === -1) return null;
  depth = 0;
  for (let j = start; j < s.length; j++) {
    const c = s[j];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return s.slice(start, j + 1);
    }
  }
  return null;
}

const stripTags = (s) => (s || '').replace(/<[^>]+>/g, '');
const decode = (s) =>
  (s || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

// "(8—11)" / "(8-11)" → [8, 11]; "(8)" → [8, 8]. Dash-class covers -, –, —.
function parseValuePair(plain) {
  const range = plain.match(/\(\s*([\d.]+)\s*[-–—]\s*([\d.]+)\s*\)/);
  if (range) return [Number(range[1]), Number(range[2])];
  const single = plain.match(/\(\s*([\d.]+)\s*\)/);
  if (single) return [Number(single[1]), Number(single[1])];
  return null;
}

// Turn a mod object's `str` into { text, values } where `text` is the GGG-style
// placeholder ("… #% of Evasion Rating") and `values` is the list of [min,max] rolls.
function parseStr(str) {
  const plain = decode(stripTags(str)).replace(/\s+/g, ' ').trim();
  const values = [];
  // capture every parenthesised roll, in order, and blank each to "#"
  const text = plain.replace(/\(\s*[\d.]+\s*(?:[-–—]\s*[\d.]+\s*)?\)/g, (m) => {
    const pair = parseValuePair(m);
    if (pair) values.push(pair);
    return '#';
  });
  return { text: text.replace(/\s+/g, ' ').trim(), values };
}

async function fetchPage(slug) {
  const url = `https://poe2db.tw/us/${slug}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  return res.text();
}

// Pull every prefix/suffix mod object of `family` from a PoE2DB class page.
function extractFamilyMods(html, family, genType) {
  const out = [];
  const re = /"ModGenerationTypeID"/g;
  let m;
  const seen = new Set();
  while ((m = re.exec(html))) {
    const obj = enclosingObject(html, m.index);
    if (!obj || !obj.includes(family)) continue;
    let o;
    try { o = JSON.parse(obj); } catch { continue; }
    if (String(o.ModGenerationTypeID) !== String(genType)) continue;
    if (!(o.ModFamilyList || []).includes(family)) continue;
    const dedupe = `${o.Name}|${o.Level}|${o.str}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push(o);
  }
  return out;
}

async function main() {
  const result = { prefix: {}, suffix: {} };
  const report = [];

  for (const t of TARGETS) {
    const html = await fetchPage(t.page);
    const mods = extractFamilyMods(html, t.family, t.genType);
    if (!mods.length) {
      throw new Error(
        `No "${t.family}" gen-${t.genType} mods found on /us/${t.page}. ` +
          `PoE2DB's page shape may have changed — re-check the parser.`,
      );
    }

    // Group every tier of the family under its single placeholder stat text.
    const byText = new Map();
    for (const o of mods) {
      const { text, values } = parseStr(o.str);
      if (!values.length) continue;
      const els = byText.get(text) || [];
      els.push({
        affinities: ['normal'],
        key: decode(stripTags(o.str)).replace(/\s+/g, ' ').trim(),
        level: String(o.Level),
        values: values.map((p) => p.map(String)),
        types: t.types.slice(),
      });
      byText.set(text, els);
    }

    for (const [text, els] of byText) {
      // tiers high→low ilvl just for a stable, readable diff (build-data re-ranks anyway)
      els.sort((a, b) => Number(b.level) - Number(a.level));
      result[t.bucket][text] = els;
      report.push({ page: t.page, bucket: t.bucket, text, tiers: els.length });
    }
  }

  // ── report ──
  console.log('fetch-poe2db-mods');
  console.log('─'.repeat(60));
  for (const r of report) {
    console.log(`  ${r.bucket}: "${r.text}"  — ${r.tiers} tiers  (from /us/${r.page})`);
  }
  if (DRY) {
    console.log('\n--dry: parsed ladders below, nothing written.\n');
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const out = {
    _kind: 'poe2tf-poe2db-extra-mods',
    _note:
      'Tier ladders scraped from PoE2DB item-class pages for mods the enhancer source omits. ' +
      'Merged alongside enhancer-mods2-data.json by build-data.mjs. Regenerate with tools/fetch-poe2db-mods.mjs.',
    _source: 'https://poe2db.tw/us/<ItemClass> (inline ModifiersCalc JSON)',
    prefix: result.prefix,
    suffix: result.suffix,
  };
  await writeFile(OUT, JSON.stringify(out, null, 2) + '\n');
  console.log(`\n✅ wrote ${OUT}`);
}

main().catch((e) => {
  console.error('\n✖ fetch-poe2db-mods failed:', e.message);
  process.exit(1);
});
