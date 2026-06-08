/*
 * §11.7 — build-data: regenerate assets/data-snapshot.json from source data.
 *
 *   node tools/build-data.mjs                 # build → assets/data-snapshot.json
 *   node tools/build-data.mjs --dry           # print report only, write nothing
 *   node tools/build-data.mjs --out <path>    # write to <path> instead (preview/verify)
 *
 * Inputs (tools/data-sources/):
 *   • enhancer-mods2-data.json   REQUIRED. PoE2DB-derived, pre-tiered, by stat text.
 *       Shape: { prefix|suffix|implicit: { "<stat text with #>": [ {level, values, types}... ] } }
 *   • poe2db-extra-mods.json     OPTIONAL. Same prefix/suffix shape, holding ladders the
 *       enhancer source omits (it predates some mechanics). Scraped from PoE2DB by
 *       tools/fetch-poe2db-mods.mjs and MERGED into the enhancer buckets here, so the GGG
 *       join / family-split / override machinery treats them identically. Kept separate
 *       from the enhancer file so a per-patch `refresh.mjs` (which only rewrites the
 *       enhancer file) never clobbers these hand-targeted additions.
 *   • ggg-trade2-stats.json      OPTIONAL (one-time browser capture of
 *       https://www.pathofexile.com/api/trade2/data/stats). Authoritative source of the
 *       EXACT display text the trade site renders + each mod's stat_id. Needed so injected
 *       rows actually match (enhancer keys are lowercased and drop the leading "+").
 *       Shape: { result: [ { id, label, entries: [ {id, text, type}... ] } ] }
 *
 * Decisions baked in (PLAN §11.7, this session):
 *   • Explicit only — ingest the `prefix` + `suffix` buckets (both render as "explicit"
 *     on trade); SKIP `implicit` (implicits aren't tier-searched). [user call]
 *   • Hybrid `|||||` two-stat affixes are PARKED (need GGG to disambiguate). [user call]
 *   • Family split is generalized off the `types` signature: within one stat text, tier
 *     elements carrying different `types` sets become separate family ladders (§11.5).
 *
 * Output schema is unchanged from the hand-built snapshot so compute.mjs, validate.mjs
 * and the content script keep working:
 *   stats[<key>] = { display, tradeStatId, affix, affixType, isAveraged, family, types, tiers:[{tier,ilvl,ranges}] }
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const SRC = join(here, 'data-sources');
const DRY = process.argv.includes('--dry');
const OUT_FLAG = process.argv.indexOf('--out');
const OUT_PATH = OUT_FLAG !== -1 ? process.argv[OUT_FLAG + 1] : join(root, 'assets', 'data-snapshot.json');
// --report <path>: also dump the machine-readable build report (counts + the
// unmatched-vs-GGG list) so tools/refresh.mjs can flag newly-added mods that
// didn't join to a GGG id. Written even under --dry.
const REPORT_FLAG = process.argv.indexOf('--report');
const REPORT_PATH = REPORT_FLAG !== -1 ? process.argv[REPORT_FLAG + 1] : null;

// ── normalization ───────────────────────────────────────────────────────────
// Join key between enhancer stat text and GGG display text: lowercase, drop "+",
// unify dashes, collapse whitespace. Both sides use "#" placeholders already.
const normJoin = (s) =>
  (s || '')
    .toLowerCase()
    .replace(/\+/g, '')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();

const slug = (s) =>
  normJoin(s)
    .replace(/#/g, 'x')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'stat';

// Family label from a types set (the UNION across a family's tiers). A family that is
// purely 1H or purely 2H weapons gets the readable weapon label; everything else
// (caster gear, armour bases, …) falls back to a faithful humanized list of its types.
// The UI only surfaces this when a stat is multi-family, so single-family stats don't
// depend on it being pretty — but it must be UNIQUE per family within a stat.
const ONE_H = new Set([
  'claw', 'dagger', 'one-hand-sword', 'one-hand-axe', 'one-hand-mace',
  'spear', 'flail', 'sceptre', 'wand', 'bow', 'crossbow',
]);
const TWO_H = new Set([
  'two-hand-sword', 'two-hand-axe', 'two-hand-mace', 'quarterstaff', 'staff',
]);
const ALL_WEAPON = new Set([...ONE_H, ...TWO_H]);
const pretty = (t) => t.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
function familyLabelFromTypes(types) {
  const set = new Set(types);
  if ([...set].every((t) => ALL_WEAPON.has(t))) {
    const has2 = [...set].some((t) => TWO_H.has(t));
    const has1 = [...set].some((t) => ONE_H.has(t));
    if (has2 && !has1) return '2-handed';
    if (has1 && !has2) return '1-handed';
  }
  const list = types.slice(0, 3).map(pretty).join(' / ');
  return types.length > 3 ? `${list} +${types.length - 3}` : list || 'all';
}

// Family detection: union-find by SHARED item type. Two tier-elements belong to the
// same ladder if their `types` sets intersect; a family's coverage is the union of its
// members' types. (Grouping by exact `types` signature over-splits ladders whose type
// availability shrinks at higher tiers, e.g. caster cast-speed: wand/shield/focus/…→wand.)
function splitFamilies(tierEls) {
  const n = tierEls.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  for (let i = 0; i < n; i++) {
    const a = new Set(tierEls[i].types || []);
    for (let j = i + 1; j < n; j++) {
      if ((tierEls[j].types || []).some((t) => a.has(t))) parent[find(i)] = find(j);
    }
  }
  const groups = new Map();
  tierEls.forEach((el, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(el);
  });
  return [...groups.values()];
}

// Curated aliases — enhancer stat text → exact GGG display text — for the handful of
// mods whose PoE2DB wording differs from the trade site's. Verified 1:1 against the GGG
// capture; patch-stable. (The remaining unmatched mods are genuine sign-flips / non-
// numeric / not-searchable and are intentionally left without a control.)
const ALIAS = {
  'allies in your presence deal # to # additional attack physical damage':
    'Allies in your Presence deal # to # added Attack Physical Damage',
  'allies in your presence deal # to # additional attack fire damage':
    'Allies in your Presence deal # to # added Attack Fire Damage',
  'allies in your presence deal # to # additional attack cold damage':
    'Allies in your Presence deal # to # added Attack Cold Damage',
  'allies in your presence deal # to # additional attack lightning damage':
    'Allies in your Presence deal # to # added Attack Lightning Damage',
  '#% increased duration': '#% increased Skill Effect Duration',
  // Sign-flipped flask/charm mod: PoE2DB lists it as "reduced Charges per use", but the
  // trade site's searchable stat is the positive-axis "#% increased Charges per use"
  // (a reduction is a NEGATIVE roll there). Aliased here so it joins the GGG id, and
  // inverted below (see INVERTED) so the control fills MAX with the negative value.
  '#% reduced charges per use': '#% increased Charges per use',
};

// Sign-flipped stats (keyed by normalized SOURCE stat text). For these, a "good" roll is
// the most NEGATIVE value on the trade stat's axis, so we negate the source ranges and
// tag the entry `inverted:true`; the UI then fills the row's MAX box instead of MIN.
// Kept deliberately tiny — the default (MIN-filling) path is untouched for every other mod.
const INVERTED = new Set(['#% reduced charges per use']);
const negateRanges = (ranges) => ranges.map(([lo, hi]) => [-hi, -lo]);

// ── GGG stats lookup (optional) ───────────────────────────────────────────────
async function loadGggLookup() {
  let raw;
  try {
    raw = await readFile(join(SRC, 'ggg-trade2-stats.json'), 'utf8');
  } catch {
    return null; // capture not present yet
  }
  const data = JSON.parse(raw);
  // normalizedText -> [ {id, text, type} ] for type === "explicit"
  const map = new Map();
  for (const group of data.result || []) {
    for (const e of group.entries || []) {
      if (e.type !== 'explicit') continue;
      const k = normJoin(e.text);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push({ id: e.id, text: e.text, type: e.type });
    }
  }
  return map;
}

// ── GGG override ladders (optional) ───────────────────────────────────────────
// §10: where the enhancer source ladder is structurally wrong (FINDINGS §13a), a
// GGG-authoritative ladder (built by tools/build-overrides.mjs from /fetch capture)
// REPLACES the source tiers for that stat id. Keyed by tradeStatId.
async function loadOverrides() {
  let raw;
  try {
    raw = await readFile(join(SRC, 'ggg-overrides.json'), 'utf8');
  } catch {
    return null; // none yet
  }
  const data = JSON.parse(raw);
  const map = new Map();
  for (const o of data.overrides || []) {
    if (o.tradeStatId) map.set(o.tradeStatId, o);
  }
  return map;
}

// ── extra mods (optional) ─────────────────────────────────────────────────────
// Merge tools/data-sources/poe2db-extra-mods.json (PoE2DB-scraped ladders the enhancer
// source lacks) into the enhancer prefix/suffix buckets. A new stat text is added; a
// colliding one has its tier elements appended (so the family-split still sees them).
async function mergeExtraMods(enhancer) {
  let raw;
  try {
    raw = await readFile(join(SRC, 'poe2db-extra-mods.json'), 'utf8');
  } catch {
    return 0; // none present
  }
  const extra = JSON.parse(raw);
  let added = 0;
  for (const bucket of ['prefix', 'suffix']) {
    for (const [text, els] of Object.entries(extra[bucket] || {})) {
      if (!enhancer[bucket]) enhancer[bucket] = {};
      enhancer[bucket][text] = (enhancer[bucket][text] || []).concat(els);
      added += 1;
    }
  }
  return added;
}

// ── build ─────────────────────────────────────────────────────────────────────
async function main() {
  const enhancer = JSON.parse(await readFile(join(SRC, 'enhancer-mods2-data.json'), 'utf8'));
  const extraMods = await mergeExtraMods(enhancer);
  const ggg = await loadGggLookup();
  const overrides = await loadOverrides();
  const overridden = [];

  const stats = {};
  const report = {
    parkedHybrid: [],
    multiFamily: [],
    unmatchedGgg: [],
    ambiguousGgg: [],
    dupLevel: [],
    skippedOverride: [],
    counts: { keys: 0, entries: 0, families: 0 },
  };
  const usedKeys = new Set();

  for (const bucket of ['prefix', 'suffix']) {
    const affix = bucket; // metadata; both are trade-type "explicit"
    for (const [statText, tierEls] of Object.entries(enhancer[bucket] || {})) {
      if (statText.includes('|||||')) {
        report.parkedHybrid.push(`${bucket}:${statText}`);
        continue;
      }
      report.counts.keys += 1;

      // split into family ladders (union-find by shared item type)
      const groups = splitFamilies(tierEls);
      if (groups.length > 1) report.multiFamily.push(`${statText} (${groups.length})`);

      // GGG canonical text + id (explicit). Try a curated alias first, then the raw text.
      // If the text collides with >1 explicit GGG entry (same display, different ids —
      // e.g. "#% increased Spirit"), keep the first as primary and record the alternates
      // (matching is by display text, so any is correct now; alts help the future add-stat).
      const aliasTarget = ALIAS[statText.toLowerCase()];
      const lookupText = normJoin(aliasTarget || statText);
      const gggHits = ggg ? ggg.get(lookupText) : null;
      if (ggg && !gggHits) report.unmatchedGgg.push(`${bucket}:${statText}`);
      if (gggHits && gggHits.length > 1) report.ambiguousGgg.push(`${statText} → ${gggHits.length}`);
      const display = gggHits ? gggHits[0].text : (aliasTarget || statText);
      const tradeStatId = gggHits ? gggHits[0].id : null;
      const tradeStatIdAlts = gggHits && gggHits.length > 1 ? gggHits.slice(1).map((h) => h.id) : null;

      // each family's coverage = union of its tiers' types
      const families = groups.map((els) => ({ els, types: [...new Set(els.flatMap((e) => e.types || []))] }));
      // stable family order: broader coverage first (e.g. 1H group before 2H), then by label
      families.sort((a, b) => (b.types.length - a.types.length) || familyLabelFromTypes(a.types).localeCompare(familyLabelFromTypes(b.types)));

      families.forEach(({ els, types }, famIdx) => {
        report.counts.families += 1;
        // Dedupe by ilvl: messy source data can bundle a secondary base set (e.g. quiver/
        // gloves attack speed) into the same union-find family at some levels. Keep one
        // element per level — the broadest-coverage variant (most item types) — so the
        // ladder is the primary one and tier numbering stays 1-per-level.
        const byLevel = new Map();
        for (const el of els) {
          const lvl = Number(el.level);
          const cur = byLevel.get(lvl);
          if (!cur || (el.types || []).length > (cur.types || []).length) byLevel.set(lvl, el);
        }
        if (byLevel.size !== els.length) report.dupLevel.push(`${statText} [${familyLabelFromTypes(types)}]`);
        // tier 1 = best = highest ilvl requirement. Sort by level desc.
        const sorted = [...byLevel.values()].sort((a, b) => Number(b.level) - Number(a.level));

        let tiers = sorted.map((el, i) => ({
          tier: i + 1,
          ilvl: Number(el.level),
          // A value pair is [min,max]; the enhancer abbreviates a FIXED sub-roll to a
          // single element (e.g. lightning's low roll ["1"] = always 1) — expand to [1,1].
          ranges: (el.values || []).map((pair) => {
            const n = pair.map(Number);
            return n.length === 1 ? [n[0], n[0]] : [n[0], n[1]];
          }),
        }));

        // §10: GGG-authoritative override REPLACES this ladder when the stat id (and
        // family, if specified) matches. Re-rank best→worst by the tier floor so the
        // tier numbers stay 1=best regardless of the override file's ordering.
        const ov = overrides && tradeStatId ? overrides.get(tradeStatId) : null;
        const famLabel = familyLabelFromTypes(types);
        let isOverridden = false;
        if (ov && (ov.family == null || ov.family === famLabel) && Array.isArray(ov.tiers) && ov.tiers.length) {
          // SAFETY: full-ladder replacement drops any source tier the override
          // doesn't carry. If the override has FEWER tiers than the source ladder
          // it's likely an incomplete capture → skip (keep source) unless the entry
          // is explicitly `force:true`. Prevents silent tier loss (FINDINGS §13a).
          const incomplete = ov.tiers.length < tiers.length;
          if (incomplete && !ov.force) {
            report.skippedOverride.push(`${ov.display} [${famLabel}] — override ${ov.tiers.length} < source ${tiers.length} tiers (incomplete; set "force":true to apply)`);
          } else {
            const tierFloor = (ranges) => (ranges.length > 1 ? (ranges[0][0] + ranges[1][0]) / 2 : ranges[0][0]);
            tiers = ov.tiers
              .slice()
              .sort((a, b) => tierFloor(b.ranges) - tierFloor(a.ranges))
              .map((t, i) => ({ tier: i + 1, ilvl: t.ilvl != null ? Number(t.ilvl) : null, ranges: t.ranges }));
            overridden.push(`${ov.display} [${famLabel}] → ${tiers.length} GGG tiers${incomplete ? ' (FORCED, partial)' : ''}`);
            isOverridden = true;
          }
        }
        report.counts.entries += tiers.length;

        // Sign-flip: negate the ranges onto the trade stat's positive axis (a reduction
        // is a negative roll). tier 1 stays "best" = most negative, since the source's
        // best (highest) value becomes the lowest (most negative) here.
        const isInverted = INVERTED.has(statText.toLowerCase());
        if (isInverted) tiers = tiers.map((t) => ({ ...t, ranges: negateRanges(t.ranges) }));

        const isAveraged = (tiers[0].ranges || []).length === 2;

        // unique snapshot key
        let key = slug(statText);
        if (families.length > 1) key += `__${famIdx + 1}`;
        let uniq = key;
        let n = 2;
        while (usedKeys.has(uniq)) uniq = `${key}_${n++}`;
        usedKeys.add(uniq);

        stats[uniq] = {
          display,
          tradeStatId,
          affix,
          affixType: 'explicit',
          isAveraged,
          family: familyLabelFromTypes(types),
          types,
          tiers,
          ...(isInverted ? { inverted: true } : {}),
          ...(tradeStatIdAlts ? { _tradeStatIdAlts: tradeStatIdAlts } : {}),
          ...(tradeStatId ? {} : { _needsCanonicalText: true }),
          ...(isOverridden ? { _src: 'ggg-override' } : {}),
        };
      });
    }
  }

  // sort keys for clean diffs
  const sortedStats = {};
  for (const k of Object.keys(stats).sort()) sortedStats[k] = stats[k];

  const out = {
    version: `PoE2 — explicit mods from enhancer mods2-data${ggg ? ' + GGG trade2 stats' : ' (NO GGG capture — display text/ids unresolved)'}`,
    _source: 'tools/build-data.mjs — enhancer prefix+suffix (PoE2DB-derived) joined to GGG /api/trade2/data/stats (explicit).',
    _generated: true,
    stats: sortedStats,
  };

  // ── report ──────────────────────────────────────────────────────────────────
  const c = report.counts;
  console.log('build-data report');
  console.log('─'.repeat(60));
  console.log(`extra mods:       ${extraMods ? `${extraMods} stat text(s) merged from poe2db-extra-mods.json` : 'none (tools/data-sources/poe2db-extra-mods.json absent)'}`);
  console.log(`GGG capture:      ${ggg ? `present (${ggg.size} explicit texts)` : 'MISSING — run the one-time browser capture'}`);
  console.log(`GGG overrides:    ${overrides ? `${overrides.size} stat(s); applied to ${overridden.length} ladder(s)` : 'none (tools/data-sources/ggg-overrides.json absent)'}`);
  if (overridden.length) for (const o of overridden) console.log(`  ↪ ${o}`);
  if (report.skippedOverride.length) {
    console.log(`overrides skipped: ${report.skippedOverride.length} (incomplete capture — kept source)`);
    for (const s of report.skippedOverride) console.log(`  ⚠ ${s}`);
  }
  console.log(`stat texts:       ${c.keys}`);
  console.log(`family ladders:   ${c.families}  (entries written: ${Object.keys(stats).length})`);
  console.log(`total tiers:      ${c.entries}`);
  console.log(`multi-family:     ${report.multiFamily.length}`);
  console.log(`parked hybrids:   ${report.parkedHybrid.length}`);
  if (ggg) {
    console.log(`unmatched vs GGG: ${report.unmatchedGgg.length}`);
    console.log(`ambiguous vs GGG: ${report.ambiguousGgg.length}`);
  }
  if (report.dupLevel.length) console.log(`dup level/family: ${report.dupLevel.length}  → ${report.dupLevel.join(', ')}`);
  if (ggg && report.unmatchedGgg.length) {
    console.log('\nunmatched against GGG (will ship with raw enhancer text, tradeStatId=null):');
    for (const u of report.unmatchedGgg) console.log(`  · ${u}`);
  }

  if (REPORT_PATH) {
    await writeFile(
      REPORT_PATH,
      JSON.stringify(
        {
          gggPresent: !!ggg,
          entriesWritten: Object.keys(stats).length,
          counts: report.counts,
          unmatchedGgg: report.unmatchedGgg, // ["prefix:<stat text>", ...]
          ambiguousGgg: report.ambiguousGgg,
          parkedHybrid: report.parkedHybrid,
          multiFamily: report.multiFamily,
          skippedOverride: report.skippedOverride,
          overridden,
        },
        null,
        2,
      ) + '\n',
    );
  }

  if (DRY) {
    console.log('\n--dry: snapshot NOT written.');
    return;
  }
  await writeFile(OUT_PATH, JSON.stringify(out, null, 2) + '\n');
  console.log(`\n✅ wrote ${OUT_PATH} (${Object.keys(stats).length} entries)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
