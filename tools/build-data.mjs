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
// SOURCE: the PoE2DB-direct scrape (tools/data-sources/poe2db-mods.json) is now the DEFAULT,
// authoritative source. The legacy third-party enhancer dump is opt-in via --base <path>,
// which also re-enables its supplements (mergeExtraMods, the dedicateWeaponLadders hack) and
// the §10 GGG overrides — all of which the direct scrape made redundant (each was a patch for
// an enhancer error; the audit confirmed PoE2DB-raw matches every one). See tools/audit-diff.mjs.
const BASE_FLAG = process.argv.indexOf('--base');
const LEGACY = BASE_FLAG !== -1;
const BASE_PATH = LEGACY ? process.argv[BASE_FLAG + 1] : join(SRC, 'poe2db-mods.json');
// --no-overrides: skip the §10 GGG override layer (legacy path only; off by default now).
const NO_OVERRIDES = process.argv.includes('--no-overrides');

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
// Hand-class per PoE2DB's item tree (poe2db.tw/us/Items): Bows and Crossbows are
// TWO-handed (a prior version listed them as one-handed, which mislabeled some
// mixed weapon bundles).
const ONE_H = new Set([
  'claw', 'dagger', 'one-hand-sword', 'one-hand-axe', 'one-hand-mace',
  'spear', 'flail', 'sceptre', 'wand',
]);
const TWO_H = new Set([
  'two-hand-sword', 'two-hand-axe', 'two-hand-mace', 'quarterstaff', 'staff',
  'bow', 'crossbow',
]);
const ALL_WEAPON = new Set([...ONE_H, ...TWO_H]);
const pretty = (t) => t.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
function familyLabelFromTypes(types) {
  const set = new Set(types);
  // Bow & Crossbow are mechanically two-handed but each carry their OWN added-damage
  // ladder, distinct from the 2-handed melee umbrella (see dedicateWeaponLadders). A
  // pure bow/crossbow family is therefore labeled by weapon, not hand-class — otherwise
  // three families ("2-handed", Bow, Crossbow) would collide on one added-damage stat.
  if (set.size === 1 && (set.has('bow') || set.has('crossbow'))) return pretty([...set][0]);
  if ([...set].every((t) => ALL_WEAPON.has(t))) {
    const has2 = [...set].some((t) => TWO_H.has(t));
    const has1 = [...set].some((t) => ONE_H.has(t));
    if (has2 && !has1) return '2-handed';
    if (has1 && !has2) return '1-handed';
  }
  const list = types.slice(0, 3).map(pretty).join(' / ');
  return types.length > 3 ? `${list} +${types.length - 3}` : list || 'all';
}

// Family detection: PER-TYPE LADDER RECONSTRUCTION. Build each item type's own complete
// ladder (level → ranges, drawn from every tier-element that includes that type), then group
// types whose ladders are IDENTICAL into one family. This is correct where the old union-find
// (group by shared type, dedup-by-level keeping broadest) silently lost data: two weapon
// classes that share their low tiers but DIVERGE higher (wand caps +5 / staff +7 spell-skill
// levels; bow vs crossbow added damage) were bridged into one family by the shared rungs, then
// the per-level dedup dropped the divergent values. Per-type reconstruction keeps them apart,
// folds a type into the ladder it actually matches (bow → the 1H added-damage ladder it shares),
// and makes the old dedicateWeaponLadders hack unnecessary. A type that carries an extra top
// tier the others lack (e.g. belt attribute) legitimately becomes its own family.
function splitFamilies(tierEls) {
  const allTypes = [...new Set(tierEls.flatMap((e) => e.types || []))];
  // type → (level → representative element). On a (type,level) collision, keep the broadest-
  // coverage element (most types); the values agree by construction so the choice is cosmetic.
  const perType = new Map();
  for (const t of allTypes) {
    const byLevel = new Map();
    for (const el of tierEls) {
      if (!(el.types || []).includes(t)) continue;
      const lvl = Number(el.level);
      const cur = byLevel.get(lvl);
      if (!cur || (el.types || []).length > (cur.types || []).length) byLevel.set(lvl, el);
    }
    perType.set(t, byLevel);
  }
  // ladder signature: levels high→low with their value ranges. Identical signature ⇒ same family.
  const sig = (byLevel) =>
    [...byLevel.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([lvl, el]) => `${lvl}=${JSON.stringify(el.values)}`)
      .join(';');
  const bySig = new Map();
  for (const t of allTypes) {
    const bl = perType.get(t);
    const s = sig(bl);
    if (!bySig.has(s)) bySig.set(s, { types: [], byLevel: bl });
    bySig.get(s).types.push(t);
  }
  // emit one synthetic tier-element per level per family, carrying the family's full type set.
  return [...bySig.values()].map(({ types, byLevel }) =>
    [...byLevel.values()].map((el) => ({ ...el, types: types.slice() })),
  );
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
  // Same sign-flip shape: the body-armour mod reads "reduced Duration of Bleeding on You",
  // but the trade stat is the positive-axis "increased Duration of Bleeding on You" (a
  // reduction is a NEGATIVE roll). Aliased to join + inverted below to fill MAX.
  '#% reduced duration of bleeding on you': '#% increased Duration of Bleeding on You',
};

// Sign-flipped stats (keyed by normalized SOURCE stat text). For these, a "good" roll is
// the most NEGATIVE value on the trade stat's axis, so we negate the source ranges and
// tag the entry `inverted:true`; the UI then fills the row's MAX box instead of MIN.
// Kept deliberately tiny — the default (MIN-filling) path is untouched for every other mod.
const INVERTED = new Set(['#% reduced charges per use', '#% reduced duration of bleeding on you']);
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
  // tradeStatId → list of overrides. A stat that rolls the SAME trade stat as both a
  // prefix and a suffix (e.g. Rarity) shares one id across two families, so we key by
  // id but keep every entry and disambiguate by `family` at apply time.
  const map = new Map();
  for (const o of data.overrides || []) {
    if (!o.tradeStatId) continue;
    if (!map.has(o.tradeStatId)) map.set(o.tradeStatId, []);
    map.get(o.tradeStatId).push(o);
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

// ── dedicated weapon ladders (Bow / Crossbow added damage) ─────────────────────
// The enhancer source lumps bow & crossbow into the ONE-HAND melee group for the four
// "Adds # to #" damage prefixes, giving them badly understated rolls. fetch-poe2db-mods
// scrapes each weapon's real (much higher) ladder into poe2db-extra-mods.json as a
// single-type bow/crossbow family. Once those are merged, this strips bow/crossbow from
// the multi-type melee ladders of the SAME stat text — so the union-find family split
// (which groups by shared type) keeps the dedicated ladders separate instead of folding
// them back into the 1H group. Self-gating: a token is only stripped where a dedicated
// single-type ladder for it exists, so a build with no extra-mods file is unchanged.
const WEAPON_ADD_TEXTS = new Set([
  'adds # to # physical damage',
  'adds # to # fire damage',
  'adds # to # cold damage',
  'adds # to # lightning damage',
]);
function dedicateWeaponLadders(enhancer) {
  let stripped = 0;
  for (const [text, els] of Object.entries(enhancer.prefix || {})) {
    if (!WEAPON_ADD_TEXTS.has(text.toLowerCase())) continue;
    const dedicated = new Set();
    for (const el of els) if ((el.types || []).length === 1) dedicated.add(el.types[0]);
    if (!dedicated.size) continue;
    for (const el of els) {
      if ((el.types || []).length > 1) {
        const before = el.types.length;
        el.types = el.types.filter((t) => !dedicated.has(t));
        if (el.types.length !== before) stripped += 1;
      }
    }
  }
  return stripped;
}

// ── build ─────────────────────────────────────────────────────────────────────
async function main() {
  const enhancer = JSON.parse(await readFile(BASE_PATH, 'utf8'));
  // Supplements + overrides apply ONLY to the legacy enhancer base; the default PoE2DB-direct
  // scrape is self-complete (carries flasks/jewels/weapon ladders with correct per-page types).
  const extraMods = LEGACY ? await mergeExtraMods(enhancer) : 0;
  if (LEGACY) dedicateWeaponLadders(enhancer);
  const ggg = await loadGggLookup();
  const overrides = LEGACY && !NO_OVERRIDES ? await loadOverrides() : null;
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
        const ovList = (overrides && tradeStatId && overrides.get(tradeStatId)) || [];
        const famLabel = familyLabelFromTypes(types);
        // Prefer a family-specific override; fall back to a family-agnostic one.
        const ov = ovList.find((o) => o.family === famLabel) || ovList.find((o) => o.family == null) || null;
        let isOverridden = false;
        if (ov && Array.isArray(ov.tiers) && ov.tiers.length) {
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
