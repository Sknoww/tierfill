/*
 * §10 — build-overrides: turn GGG `/fetch` capture(s) into a reviewable
 * GGG-authoritative tier-ladder override file for the build pipeline.
 *
 * WHY full-ladder replacement (not per-tier patch): the audit (FINDINGS §13a)
 * showed the enhancer/PoE2DB source ladder is STRUCTURALLY wrong for some stats
 * — different tier count and breakpoints than GGG, and bands too wide on the low
 * end. A per-(stat,tier) patch can't fix a different tier STRUCTURE. So for a
 * targeted stat we discard the source ladder and rebuild it from GGG's bands.
 *
 * Base-independence: GGG's `tier` rank and `level` are per-item-base (noisy), but
 * the `magnitudes` BAND is the mod tier's own range. So we key tiers by the BAND
 * (dedup distinct bands), sort best→worst, and number them T1..Tn. `level` is kept
 * only as a representative ilvl (the min required level observed for that band).
 *
 * SAFETY: only stats whose display matches a --stats target are touched (default =
 * the known-broken set). Overriding a multi-base stat (e.g. Life) with one base's
 * bands would be WRONG, so this never runs blanket. Output is written for REVIEW;
 * apply it by running build-data.mjs (which reads ggg-overrides.json).
 *
 * Usage:
 *   node tools/build-overrides.mjs --in cap1.json [--in cap2.json ...]
 *        [--stats "damage to Attacks,Physical Thorns"] [--out <path>] [--merge]
 *   --in     capture file(s) from the spike "Export audit" button (repeatable)
 *   --stats  comma-separated display SUBSTRINGS to target (default below)
 *   --merge  union new tiers into an existing overrides file instead of replacing
 *   --out    output path (default tools/data-sources/ggg-overrides.json)
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');

function argAll(flag) {
  const out = [];
  process.argv.forEach((a, i) => { if (a === flag) out.push(process.argv[i + 1]); });
  return out.filter(Boolean);
}
function arg(flag, def) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
}

const INS = argAll('--in');
if (!INS.length) { console.error('Need at least one --in <capture.json>.'); process.exit(1); }
const SNAP = resolve(REPO, arg('--snapshot', 'assets/data-snapshot.json'));
const OUT = resolve(REPO, arg('--out', 'tools/data-sources/ggg-overrides.json'));
const MERGE = process.argv.includes('--merge');
// Default targets = the stats the audit (FINDINGS §13a) flagged as genuine source
// drift. Elemental "to Attacks" (hi-band too wide) + Physical Thorns (~2× low).
// Physical Damage to Attacks is EXCLUDED — it audited exact; don't touch it.
const TARGETS = String(arg('--stats',
  'fire damage to attacks,cold damage to attacks,lightning damage to attacks,physical thorns'))
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

const snapshot = JSON.parse(readFileSync(SNAP, 'utf8'));
const stats = snapshot.stats || {};

// stat id → { display, affix, family, sourceTierCount } for targeted stats only.
const targeted = new Map();
for (const s of Object.values(stats)) {
  if (!s.tradeStatId) continue;
  if (!TARGETS.some((t) => (s.display || '').toLowerCase().includes(t))) continue;
  // If a stat id spans multiple families with DIFFERENT ladders, a single override
  // is ambiguous — record family so we can warn.
  const prev = targeted.get(s.tradeStatId);
  if (!prev) targeted.set(s.tradeStatId, { display: s.display, affix: s.affix, families: [s.family], sourceTierCount: s.tiers.length });
  else prev.families.push(s.family);
}
if (!targeted.size) {
  console.error(`No snapshot stats match --stats targets [${TARGETS.join(', ')}].`);
  process.exit(1);
}

const floorOf = (ranges) => (ranges.length > 1 ? (ranges[0][0] + ranges[1][0]) / 2 : ranges[0][0]);

// Collect distinct GGG bands per targeted stat id, across all captures.
// bandKey → { ranges, minLevel }
const banks = new Map(); // id → Map(bandKey → {ranges, minLevel})
let totalObs = 0;
for (const file of INS) {
  const cap = JSON.parse(readFileSync(resolve(REPO, file), 'utf8'));
  for (const obs of cap.observations || []) {
    const ids = [...new Set(obs.magnitudes.map((m) => m.hash))];
    for (const id of ids) {
      if (!targeted.has(id)) continue;
      const band = obs.magnitudes.filter((m) => m.hash === id).map((m) => [m.min, m.max]);
      const bandKey = JSON.stringify(band);
      if (!banks.has(id)) banks.set(id, new Map());
      const m = banks.get(id);
      const lvl = Number(obs.level);
      if (!m.has(bandKey)) m.set(bandKey, { ranges: band, minLevel: Number.isFinite(lvl) ? lvl : null });
      else if (Number.isFinite(lvl)) {
        const cur = m.get(bandKey);
        cur.minLevel = cur.minLevel == null ? lvl : Math.min(cur.minLevel, lvl);
      }
      totalObs += 1;
    }
  }
}

// Build override entries: distinct bands → tiers sorted best→worst.
const overrides = [];
for (const [id, bandMap] of banks) {
  const meta = targeted.get(id);
  const tiers = [...bandMap.values()]
    .sort((a, b) => floorOf(b.ranges) - floorOf(a.ranges))
    .map((t) => ({ ilvl: t.minLevel, ranges: t.ranges }));
  const uniqFamilies = [...new Set(meta.families)];
  overrides.push({
    tradeStatId: id,
    display: meta.display,
    family: uniqFamilies.length === 1 ? uniqFamilies[0] : null,
    _ambiguousFamilies: uniqFamilies.length > 1 ? uniqFamilies : undefined,
    _distinctTiers: tiers.length,
    _sourceTierCount: meta.sourceTierCount,
    tiers,
  });
}
overrides.sort((a, b) => a.display.localeCompare(b.display));

// Merge with existing file if asked.
let final = overrides;
if (MERGE && existsSync(OUT)) {
  const existing = JSON.parse(readFileSync(OUT, 'utf8')).overrides || [];
  const byId = new Map(existing.map((o) => [o.tradeStatId, o]));
  for (const o of overrides) {
    const prev = byId.get(o.tradeStatId);
    if (!prev) { byId.set(o.tradeStatId, o); continue; }
    // union tiers by band, re-sort/re-rank
    const seen = new Map(prev.tiers.map((t) => [JSON.stringify(t.ranges), t]));
    for (const t of o.tiers) seen.set(JSON.stringify(t.ranges), t);
    const merged = [...seen.values()].sort((a, b) => floorOf(b.ranges) - floorOf(a.ranges));
    byId.set(o.tradeStatId, { ...prev, ...o, _distinctTiers: merged.length, tiers: merged });
  }
  final = [...byId.values()].sort((a, b) => a.display.localeCompare(b.display));
}

const out = {
  _kind: 'poe2tf-ggg-overrides',
  _note: 'GGG-authoritative tier ladders (from /fetch magnitudes) that REPLACE the source ladder for the listed stats. Reviewable; applied by build-data.mjs. See FINDINGS §13a.',
  _captures: INS,
  overrides: final,
};
writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');

// ── report ──
console.log(`build-overrides — ${totalObs} targeted obs across ${INS.length} capture(s)`);
console.log('─'.repeat(64));
for (const o of final) {
  const completeness = o._distinctTiers >= o._sourceTierCount ? '✓' : `⚠ ${o._distinctTiers}/${o._sourceTierCount} (incomplete — capture more tiers)`;
  console.log(`  ${o.display}`);
  console.log(`    id=${o.tradeStatId}  tiers=${o._distinctTiers}  vs source ${o._sourceTierCount}  ${completeness}`);
  if (o._ambiguousFamilies) console.log(`    ⚠ stat id spans families ${JSON.stringify(o._ambiguousFamilies)} — override applies to ALL; verify they share bands.`);
  o.tiers.forEach((t, i) => console.log(`      T${i + 1} ilvl~${t.ilvl}  ${t.ranges.map((r) => r.join('-')).join(' / ')}`));
}
console.log(`\n→ wrote ${OUT}  (review, then run: node tools/build-data.mjs)`);
