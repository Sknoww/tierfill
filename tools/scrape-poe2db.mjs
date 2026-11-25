/*
 * scrape-poe2db — Phase 1 of the PoE2DB-direct overhaul.
 *
 *   node tools/scrape-poe2db.mjs              # scrape ALL pages → tools/data-sources/poe2db-mods.json
 *   node tools/scrape-poe2db.mjs --dry        # scrape + print report, write nothing
 *   node tools/scrape-poe2db.mjs --page Bows  # scrape ONE page (debug); implies --dry
 *   node tools/scrape-poe2db.mjs --allow-drop # accept pages whose row count fell by half
 *
 * FAIL-FAST: any page that errors, returns fewer than MIN_ROWS mod rows, or returns less
 * than half the rows it had in the last good scrape stops the run with exit 1 and writes
 * NOTHING. A renamed, 404'd or JS-gated PoE2DB page would otherwise silently drop that
 * item class from the snapshot. --allow-drop downgrades only the "fell by half" check
 * (for a patch that really trims a pool); HTTP errors and near-empty pages always fail.
 *
 * WHY this exists:
 *   The shipped pipeline's PRIMARY value source is a third party's PoE2DB-derived dump
 *   (enhancer-mods2-data.json). It's stale (predates Deflection/flasks) and — worse — its
 *   item-type tagging is unreliable: it lumped bows & crossbows into the one-hand melee
 *   added-damage ladder, badly understating their rolls (commit 9f4a3e3). We've since
 *   proven PoE2DB's own single-material item-class pages embed the FULL mod pool as inline
 *   JSON, scrapeable with a plain fetch. This scrapes every relevant class page directly,
 *   making PoE2DB the authoritative source and deriving each mod's `types` from WHICH pages
 *   it appears on — the structural fix for the bow/crossbow class of bug, generalized.
 *
 * OUTPUT is the SAME bucket shape build-data.mjs already ingests from the enhancer file:
 *   { prefix|suffix: { "<lowercased stat text with #>": [ {affinities, key, level, values, types} ] } }
 * so build-data's GGG-join / family-split / override machinery treats it identically. It is
 * written to a SEPARATE file (poe2db-mods.json) on purpose — Phase 2 builds a snapshot from
 * it and DIFFS against the live enhancer-based snapshot before anything flips. Nothing here
 * touches enhancer-mods2-data.json or assets/data-snapshot.json.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, 'data-sources');
const OUT = join(SRC, 'poe2db-mods.json');
const DRY = process.argv.includes('--dry');
const PAGE_FLAG = process.argv.indexOf('--page');
const ONLY_PAGE = PAGE_FLAG !== -1 ? process.argv[PAGE_FLAG + 1] : null;
const ALLOW_DROP = process.argv.includes('--allow-drop');
// A real class page carries 50+ explicit tier rows; anything under this is a broken page.
export const MIN_ROWS = 20;
// A page keeping less than this share of its last good row count is treated as broken.
export const DROP_RATIO = 0.5;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

// ── page → trade `types` token map ──────────────────────────────────────────────
// Every token here matches the vocabulary build-data.mjs and the enhancer source use.
// Armour is reachable ONLY via the single-material sub-pages (<Slot>_<attr>); the
// aggregate pages (Gloves, Body_Armours, …) are JS-gated and serve 0 inline mods.
// Shields split str / str_dex / str_int + Bucklers (the pure-dex shield class).
const ARMOUR_MATERIALS = ['str', 'dex', 'int', 'str_dex', 'str_int', 'dex_int'];
const PAGES = [
  // one-handed weapons
  ['Claws', 'claw'], ['Daggers', 'dagger'], ['Wands', 'wand'], ['Sceptres', 'sceptre'],
  ['Spears', 'spear'], ['Flails', 'flail'],
  ['One_Hand_Swords', 'one-hand-sword'], ['One_Hand_Axes', 'one-hand-axe'], ['One_Hand_Maces', 'one-hand-mace'],
  // two-handed weapons
  ['Two_Hand_Swords', 'two-hand-sword'], ['Two_Hand_Axes', 'two-hand-axe'], ['Two_Hand_Maces', 'two-hand-mace'],
  ['Quarterstaves', 'quarterstaff'], ['Staves', 'staff'], ['Bows', 'bow'], ['Crossbows', 'crossbow'],
  // off-hands
  ['Quivers', 'quiver'], ['Foci', 'focus'],
  // armour (single-material matrix)
  ...ARMOUR_MATERIALS.flatMap((m) => [
    [`Body_Armours_${m}`, 'body-armour'], [`Helmets_${m}`, 'helmet'],
    [`Gloves_${m}`, 'gloves'], [`Boots_${m}`, 'boots'],
  ]),
  ['Shields_str', 'shield'], ['Shields_str_dex', 'shield'], ['Shields_str_int', 'shield'], ['Bucklers', 'shield'],
  // jewellery
  ['Amulets', 'amulet'], ['Rings', 'ring'], ['Belts', 'belt'],
  // jewels (generic — one shared pool, single-tier rolls), flasks, charms
  ['Emerald', 'jewel'], ['Ruby', 'jewel'], ['Sapphire', 'jewel'],
  ['Life_Flasks', 'life-flask'], ['Mana_Flasks', 'mana-flask'], ['Charms', 'charm'],
];

// Canonical token order for stable, readable `types` arrays (purely cosmetic; build-data
// treats `types` as a set). Weapons → off-hands → armour → jewellery → jewel/flask/charm.
const TOKEN_ORDER = [
  'claw', 'dagger', 'one-hand-sword', 'one-hand-axe', 'one-hand-mace', 'spear', 'flail', 'sceptre', 'wand',
  'two-hand-sword', 'two-hand-axe', 'two-hand-mace', 'quarterstaff', 'staff', 'bow', 'crossbow',
  'quiver', 'focus', 'shield', 'gloves', 'boots', 'body-armour', 'helmet', 'amulet', 'ring', 'belt',
  'jewel', 'life-flask', 'mana-flask', 'charm',
];
const tokenRank = (t) => { const i = TOKEN_ORDER.indexOf(t); return i === -1 ? TOKEN_ORDER.length : i; };

// ── HTML/JSON helpers ───────────────────────────────────────────────────────────
// Smallest {...} object enclosing `pos`, by brace-matching outward then inward — lifts
// one flat mod object out of the inline page JSON. (Same trick as fetch-poe2db-mods.)
function enclosingObject(s, pos) {
  let depth = 0, start = -1;
  for (let i = pos; i >= 0; i--) {
    const c = s[i];
    if (c === '}') depth++;
    else if (c === '{') { if (depth === 0) { start = i; break; } depth--; }
  }
  if (start === -1) return null;
  depth = 0;
  for (let j = start; j < s.length; j++) {
    const c = s[j];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return s.slice(start, j + 1); }
  }
  return null;
}

const stripTags = (s) => (s || '').replace(/<[^>]+>/g, '');
const decode = (s) =>
  (s || '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"');

// Parse the roll inside one <span class='mod-value'> → [lo,hi] strings. PoE2DB marks EVERY
// roll with this span, whether a range "(5—6)" / "(88—101)", a fixed "15", or a signed
// "+2". (A parens-only pass misses the fixed/bare forms — that was a false-park bug.)
function parseSpanRoll(inner) {
  const nums = (decode(stripTags(inner)).match(/[\d.]+/g) || []).map(String);
  if (!nums.length) return null;
  return nums.length === 1 ? [nums[0], nums[0]] : [nums[0], nums[1]];
}

// Parse one stat clause (raw HTML) → { text:"…#…", values:[[lo,hi]…] } by blanking each
// mod-value span to "#" and lifting its roll. Span-based, so "Adds <1> to <(4—6)>" yields
// two operands and a clean "Adds # to #" text with no special-casing.
function parseClause(html) {
  const values = [];
  const blanked = html.replace(/<span class=['"]mod-value['"]>([\s\S]*?)<\/span>/gi, (_m, inner) => {
    const pair = parseSpanRoll(inner);
    if (pair) values.push(pair);
    return '#';
  });
  let text = decode(stripTags(blanked)).replace(/\s+/g, ' ').trim();
  // Word-value tier: the bottom rung spells its "1" as a word with no mod-value span
  // ("Loads an additional bolt", "fire an additional Arrow"). Treat as 1 and rewrite to the
  // plural "# additional <noun>s" so it merges with the higher, digit-valued tiers.
  if (!values.length && /\b(an|a)\s+additional\s+[A-Za-z]+\b/i.test(text)) {
    values.push(['1', '1']);
    text = text.replace(/\b(an|a)\s+additional\s+([A-Za-z]+)\b/i, (_x, _a, noun) => `# additional ${/s$/i.test(noun) ? noun : noun + 's'}`);
  }
  return { text, values };
}

// Normalize a clause's display text to the enhancer's KEY convention: drop "+", lowercase,
// collapse whitespace. So "+(5–8) to Strength" → key "# to strength".
const bucketKey = (text) => text.replace(/\+/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

// Parse a full mod `str` (may be multi-clause, separated by <br>) into a normalized record.
// Multi-clause mods are PARKED as a single "|||||"-joined key — the same representation the
// enhancer uses for two-stat hybrids, which build-data deliberately skips (can't map one
// control to two trade stats). Returns { key, valueList, parked, hadDigit }.
function parseMod(str) {
  // Flatten the nested range dash span first: a ranged roll is
  // "<span class='mod-value'>(5<span class="ndash">—</span>6)</span>" — the inner ndash
  // </span> would otherwise terminate the non-greedy mod-value match early, splitting "(5—6)".
  const clauses = String(str)
    .replace(/<span class=['"]ndash['"]>([\s\S]*?)<\/span>/gi, '$1')
    .split(/<br\s*\/?>/i)
    .map((seg) => parseClause(seg))
    .filter((c) => c.text);
  // Park a mod as a hybrid only when ONE control genuinely can't map to it:
  //   • 2+ clauses that each carry a roll (e.g. "% increased Physical Damage" <br> "to
  //     Accuracy Rating") — two distinct trade stats.
  //   • a single line PoE2DB glued two non-adjacent rolls into (some jewel mods: "…% increased
  //     Armour…% increased Attack Damage").
  // A lone numeric clause with NON-numeric riders (flask "…Life Recovered" <br> "Removes
  // Bleeding…") is single-stat — keep it; the trade site filters only the first clause.
  // An averaged "# to #" mod (two rolls joined by "to") is single-stat — keep it.
  // Drop non-searchable rider clauses before judging hybrids: PoE2DB glues a fixed flask
  // drawback ("Removes 15% of Life Recovered from Mana when used") onto "% increased Life
  // Recovered" via <br>. The rider carries its own span but isn't a tradeable stat, so it
  // would falsely make the mod look like a two-stat hybrid. The trade site filters only the
  // real first clause.
  const RIDER = /^removes\b/i;
  const real = clauses.filter((c) => !RIDER.test(c.text));
  const clausesForHybrid = real.length ? real : clauses;
  const numeric = clausesForHybrid.filter((c) => c.values.length);
  const single = numeric.length === 1 ? numeric[0] : null;
  const glued = single && single.values.length > 1 && !/# to #/.test(single.text);
  const parked = numeric.length >= 2 || glued;
  if (parked) {
    const parts = numeric.length >= 2 ? numeric : clausesForHybrid;
    return {
      key: parts.map((c) => bucketKey(c.text)).join('|||||'),
      valueList: numeric.flatMap((c) => c.values),
      parked: true,
      why: numeric.length >= 2 ? 'multi-line' : 'glued-clause',
    };
  }
  const c = single || clausesForHybrid[0] || { text: '', values: [] };
  return { key: bucketKey(c.text), valueList: c.values, parked: false, why: '' };
}

async function fetchPage(slug) {
  const url = `https://poe2db.tw/us/${slug}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  return res.text();
}

// Pull every explicit prefix/suffix tier row from a class page. Filters:
//   • gen type 1 (prefix) / 2 (suffix) only — skips implicits, corruptions, enchants.
//   • rows carrying a `Code` (essence / currency-stamped variants) — they duplicate a
//     normal tier's values and would double up the ladder.
//   • rows with no numeric roll — no ladder to build.
// Dedupes within the page by Name|Level|str. Returns [{bucket, key, level, values, raw}].
function extractRows(html, report) {
  const rows = [];
  const re = /"ModGenerationTypeID"/g;
  const seen = new Set();
  let m;
  while ((m = re.exec(html))) {
    const objText = enclosingObject(html, m.index);
    if (!objText) continue;
    let o;
    try { o = JSON.parse(objText); } catch { continue; }
    const gen = String(o.ModGenerationTypeID);
    if (gen !== '1' && gen !== '2') continue;
    if (o.Code) continue; // essence / currency variant — duplicate values
    const dedupe = `${o.Name}|${o.Level}|${o.str}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);

    const { key, valueList, parked, why } = parseMod(o.str);
    if (!valueList.length) continue;          // non-numeric → no ladder
    if (parked) {
      report.parked.push({ key, why });
      continue;
    }
    rows.push({
      bucket: gen === '1' ? 'prefix' : 'suffix',
      key,
      level: String(o.Level),
      values: valueList.map((p) => p.map(String)),
      raw: decode(stripTags(o.str)).replace(/\s+/g, ' ').trim(),
    });
  }
  return rows;
}

// Row counts per slug from the last good scrape's `_pages` ("Slug→token (n)").
export function previousRowCounts(prev) {
  const counts = new Map();
  for (const line of (prev && prev._pages) || []) {
    const m = /^(.+?)→.*\((\d+)\)$/.exec(line);
    if (m) counts.set(m[1], Number(m[2]));
  }
  return counts;
}

// Pure gate: returns { errors, warnings } for this run's page results.
//   pages:    [{ slug, rows }] that fetched OK
//   pageFail: ["slug: message"] that threw
//   prev:     Map slug → row count from the last good scrape
export function pageGate(pages, pageFail, prev, { allowDrop = false } = {}) {
  const errors = pageFail.map((f) => `fetch failed — ${f}`);
  const warnings = [];
  for (const { slug, rows } of pages) {
    if (rows < MIN_ROWS) {
      errors.push(`${slug}: only ${rows} mod rows (minimum ${MIN_ROWS}) — page renamed, JS-gated or redesigned?`);
      continue;
    }
    const before = prev.get(slug);
    if (before && rows < before * DROP_RATIO) {
      const msg = `${slug}: ${rows} mod rows, down from ${before} last scrape`;
      (allowDrop ? warnings : errors).push(allowDrop ? `${msg} (accepted by --allow-drop)` : `${msg} — re-run with --allow-drop if the patch really cut this pool`);
    }
  }
  return { errors, warnings };
}

async function readPrevious() {
  try {
    return JSON.parse(await readFile(OUT, 'utf8'));
  } catch {
    return null; // first run
  }
}

// ── build ───────────────────────────────────────────────────────────────────────
async function main() {
  const pages = ONLY_PAGE ? PAGES.filter(([slug]) => slug === ONLY_PAGE) : PAGES;
  if (ONLY_PAGE && !pages.length) {
    // allow probing a slug not in the map (debug)
    pages.push([ONLY_PAGE, ONLY_PAGE.toLowerCase()]);
  }

  // identity → element. A tier row is the SAME mod across pages iff bucket + stat key +
  // level + value signature match; we union the page tokens into its `types`. Different
  // values at the same key/level (e.g. bow vs melee added-damage) stay distinct elements,
  // which is exactly what keeps their ladders in separate families downstream.
  const elements = new Map(); // sig -> { bucket, key, level, values, raw, types:Set }
  const report = { pages: [], parked: [], pageFail: [] };
  let pageOk = 0;

  for (const [slug, token] of pages) {
    let html;
    try {
      html = await fetchPage(slug);
    } catch (e) {
      report.pageFail.push(`${slug}: ${e.message}`);
      continue;
    }
    const rows = extractRows(html, report);
    pageOk += 1;
    report.pages.push({ slug, token, rows: rows.length });
    for (const r of rows) {
      const sig = `${r.bucket}::${r.key}::${r.level}::${JSON.stringify(r.values)}`;
      let el = elements.get(sig);
      if (!el) {
        el = { bucket: r.bucket, key: r.key, level: r.level, values: r.values, raw: r.raw, types: new Set() };
        elements.set(sig, el);
      }
      el.types.add(token);
    }
  }

  // assemble enhancer-shaped buckets
  const result = { prefix: {}, suffix: {} };
  for (const el of elements.values()) {
    const types = [...el.types].sort((a, b) => tokenRank(a) - tokenRank(b));
    (result[el.bucket][el.key] ||= []).push({
      affinities: ['normal'],
      key: el.raw,
      level: el.level,
      values: el.values,
      types,
    });
  }
  // tiers high→low ilvl for a stable, readable diff (build-data re-ranks anyway)
  for (const bucket of ['prefix', 'suffix']) {
    for (const els of Object.values(result[bucket])) els.sort((a, b) => Number(b.level) - Number(a.level));
  }

  // ── report ──────────────────────────────────────────────────────────────────
  const prefixKeys = Object.keys(result.prefix).length;
  const suffixKeys = Object.keys(result.suffix).length;
  const totalEls = [...Object.values(result.prefix), ...Object.values(result.suffix)].reduce((n, a) => n + a.length, 0);
  console.log('scrape-poe2db');
  console.log('─'.repeat(64));
  console.log(`pages scraped:    ${pageOk}/${pages.length}`);
  if (report.pageFail.length) {
    console.log(`page failures:    ${report.pageFail.length}`);
    for (const f of report.pageFail) console.log(`  ✖ ${f}`);
  }
  console.log(`prefix keys:      ${prefixKeys}`);
  console.log(`suffix keys:      ${suffixKeys}`);
  console.log(`tier elements:    ${totalEls}  (after cross-page type union)`);
  console.log(`parked (hybrid):  ${report.parked.length}`);
  if (ONLY_PAGE) {
    console.log(`\n--page ${ONLY_PAGE}: per-row dump`);
    for (const bucket of ['prefix', 'suffix']) {
      for (const [k, els] of Object.entries(result[bucket])) {
        console.log(`  [${bucket}] ${k}  (${els.length} tiers, types=${els[0].types.join(',')})`);
      }
    }
  }

  const gate = pageGate(report.pages, report.pageFail, previousRowCounts(await readPrevious()), {
    allowDrop: ALLOW_DROP,
  });
  for (const w of gate.warnings) console.log(`  ⚠ ${w}`);
  if (gate.errors.length) {
    console.error(`\n✖ ${gate.errors.length} page(s) failed the scrape gate — nothing written:`);
    for (const e of gate.errors) console.error(`  ✖ ${e}`);
    // exitCode, not exit(): exiting with fetch sockets still open trips a libuv assert on Windows.
    process.exitCode = 1;
    return;
  }

  if (DRY || ONLY_PAGE) {
    console.log('\n--dry: nothing written.');
    return;
  }

  const out = {
    _kind: 'poe2tf-poe2db-mods',
    _note:
      'FULL PoE2DB-direct mod scrape (Phase 1 of the overhaul). Same bucket shape as ' +
      'enhancer-mods2-data.json so build-data.mjs ingests it identically. `types` is derived ' +
      'from which item-class pages each tier appears on. Regenerate with tools/scrape-poe2db.mjs.',
    _source: 'https://poe2db.tw/us/<ItemClass>[_<material>] (inline mod JSON)',
    _pages: report.pages.map((p) => `${p.slug}→${p.token} (${p.rows})`),
    prefix: result.prefix,
    suffix: result.suffix,
  };
  await writeFile(OUT, JSON.stringify(out, null, 2) + '\n');
  console.log(`\n✅ wrote ${OUT}  (${prefixKeys + suffixKeys} keys, ${totalEls} tier elements)`);
}

// Run only as a script, so the tests can import the gate without scraping.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((e) => {
    console.error('\n✖ scrape-poe2db failed:', e.message);
    process.exit(1);
  });
}
