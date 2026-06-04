/*
 * PoE2 Tier Filter — §10 snapshot↔GGG tier-range audit.
 *
 * Compares our generated snapshot's per-tier ranges (the numbers the core
 * MIN-fill is computed from) against GGG's authoritative `magnitudes` captured
 * live from `/api/trade2/fetch` (the spike's "Export audit" button → file).
 *
 * Why this matters: the MIN-fill for "tier T or better" is `tierFloor` —
 *   averaged mod:  (ranges[0][0] + ranges[1][0]) / 2   (avg of the two low mins)
 *   single mod:    ranges[0][0]
 * If our snapshot's tier band drifts from GGG's real band, every fill for that
 * tier is off by `fillDrift` = snapshotFloor − gggFloor. That is the headline.
 *
 * GGG's `magnitudes` ARE the full tier band (the `[lo—lo to hi—hi]` bracket),
 * so one captured item of a tier reveals that tier's whole range — no need to
 * aggregate many rolls.
 *
 * Join key: GGG `tier` = affix letter + rank (`P2` = prefix rank 2). Our snapshot
 * stat has `affix` (prefix|suffix), `tradeStatId`, and `tiers[].tier` (= rank).
 * Family-split stats share a `tradeStatId` (1H vs 2H) but have different bands;
 * we route each observation to the family whose band it best fits (min |fillDrift|).
 *
 * Usage:
 *   node tools/audit-ranges.mjs [--in <capture.json>] [--snapshot <snap.json>]
 *                               [--json] [--all] [--eps <n>]
 *   --in        captured dump (default tools/data-sources/ggg-audit-capture.json)
 *   --json      emit machine-readable JSON instead of the text report
 *   --all       list every matched row (default: only rows with drift)
 *   --eps <n>   treat |drift| <= n as "match" (default 0)
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');

function arg(flag, def) {
  const i = process.argv.indexOf(flag);
  if (i === -1) return def;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
}
const IN = resolve(REPO, arg('--in', 'tools/data-sources/ggg-audit-capture.json'));
const SNAP = resolve(REPO, arg('--snapshot', 'assets/data-snapshot.json'));
const AS_JSON = process.argv.includes('--json');
const SHOW_ALL = process.argv.includes('--all');
const EPS = Number(arg('--eps', 0)) || 0;

function load(p, label) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    console.error(`Could not read ${label} at ${p}\n  ${e.message}`);
    process.exit(1);
  }
}

const snapshot = load(SNAP, 'snapshot');
const capture = load(IN, 'capture');
const stats = snapshot.stats || {};
const observations = capture.observations || [];

// tradeStatId (primary + alts) → [{ key, stat }]
const byId = new Map();
for (const [key, stat] of Object.entries(stats)) {
  const ids = [stat.tradeStatId, ...(stat._tradeStatIdAlts || [])].filter(Boolean);
  for (const id of ids) {
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push({ key, stat });
  }
}

const AFFIX = { P: 'prefix', S: 'suffix' };

// tierFloor / band helpers mirroring src/tiers/compute.mjs.
const isAvg = (band) => band.length > 1;
const floorOf = (ranges) => (isAvg(ranges) ? (ranges[0][0] + ranges[1][0]) / 2 : ranges[0][0]);
const ceilOf = (ranges) => (isAvg(ranges) ? (ranges[0][1] + ranges[1][1]) / 2 : ranges[0][1]);

// Rank-INDEPENDENT match: find the snapshot tier whose band best fits the GGG
// band by VALUE (L1 distance over aligned sub-bands). Residual 0 ⇒ the snapshot
// holds this exact band somewhere — i.e. our numbers are right and any rank-join
// "drift" is purely a per-base tier-LABEL offset, not a data error.
function bestByValue(stat, gggBand) {
  let best = null;
  for (const t of stat.tiers || []) {
    if (t.ranges.length !== gggBand.length) continue;
    let r = 0;
    for (let i = 0; i < gggBand.length; i++) {
      r += Math.abs(t.ranges[i][0] - gggBand[i][0]) + Math.abs(t.ranges[i][1] - gggBand[i][1]);
    }
    if (!best || r < best.residual) best = { tier: t.tier, residual: r, ranges: t.ranges };
  }
  return best;
}

const rows = [];
const unmatched = []; // observations whose (id, affix, rank) found no snapshot tier

for (const obs of observations) {
  const tierStr = String(obs.tier || '');
  const letter = tierStr[0];
  const rank = parseInt(tierStr.slice(1), 10);
  const affix = AFFIX[letter];
  if (!affix || !Number.isFinite(rank)) {
    unmatched.push({ obs, reason: `unparseable tier "${obs.tier}"` });
    continue;
  }

  // Unique stat hashes present in this observation.
  const hashes = [...new Set(obs.magnitudes.map((m) => m.hash))];
  let matchedAny = false;

  for (const hash of hashes) {
    const candidates = (byId.get(hash) || []).filter(({ stat }) => stat.affix === affix);
    if (!candidates.length) continue;

    // GGG band for THIS stat = the obs magnitudes carrying this hash, in order.
    const gggBand = obs.magnitudes.filter((m) => m.hash === hash).map((m) => [m.min, m.max]);
    const gggFloor = floorOf(gggBand);
    const gggCeil = ceilOf(gggBand);

    // Among candidate families sharing this id+affix, score each by how well its
    // tier-`rank` band fits the observed band; attribute the obs to the best fit.
    let best = null;
    for (const { key, stat } of candidates) {
      const tier = (stat.tiers || []).find((t) => t.tier === rank);
      if (!tier) continue;
      const snapFloor = floorOf(tier.ranges);
      const fillDrift = +(snapFloor - gggFloor).toFixed(3);
      const score = Math.abs(fillDrift);
      if (!best || score < best.score) best = { key, stat, tier, snapFloor, fillDrift, score };
    }
    if (!best) continue; // id+affix matched but no tier with this rank
    matchedAny = true;

    const { key, stat, tier, snapFloor, fillDrift } = best;
    const snapCeil = ceilOf(tier.ranges);

    // Per-sub-band min/max deltas (snapshot − GGG), aligned by index.
    const subDeltas = gggBand.map((g, i) => {
      const s = tier.ranges[i] || [];
      return { dMin: (s[0] ?? 0) - g[0], dMax: (s[1] ?? 0) - g[1] };
    });

    // Rank-independent value match — isolates TRUE drift from rank-label offset.
    const vm = bestByValue(stat, gggBand);
    const valueResidual = vm ? +vm.residual.toFixed(3) : null;
    const trueDrift = valueResidual != null && valueResidual > EPS;
    const rankArtifact = !trueDrift && Math.abs(fillDrift) > EPS; // value right, only rank differs

    rows.push({
      key,
      display: stat.display,
      affix,
      tier: rank,
      gggTier: obs.tier,
      base: obs.base || null,
      gggLevel: obs.level,
      snapIlvl: tier.ilvl,
      gggBand,
      snapBand: tier.ranges,
      gggFloor,
      snapFloor,
      gggCeil,
      snapCeil,
      fillDrift,
      ceilDrift: +(snapCeil - gggCeil).toFixed(3),
      subDeltas,
      ambiguousFamilies: candidates.length > 1,
      valueTier: vm ? vm.tier : null,
      valueResidual,
      trueDrift,
      rankArtifact,
    });
  }

  if (!matchedAny) {
    unmatched.push({ obs, reason: `no snapshot ${affix} stat for hashes [${hashes.join(', ')}] at rank ${rank}` });
  }
}

// ---- Summary ----------------------------------------------------------------
const drifted = rows.filter((r) => Math.abs(r.fillDrift) > EPS);
const exact = rows.length - drifted.length;
const absDrifts = rows.map((r) => Math.abs(r.fillDrift)).sort((a, b) => a - b);
const mean = absDrifts.length ? absDrifts.reduce((a, b) => a + b, 0) / absDrifts.length : 0;
const median = absDrifts.length ? absDrifts[Math.floor(absDrifts.length / 2)] : 0;
const maxDrift = absDrifts.length ? absDrifts[absDrifts.length - 1] : 0;
// Bias: does the snapshot sit consistently ABOVE (over-fills) or BELOW GGG?
const signedMean = rows.length ? rows.reduce((a, r) => a + r.fillDrift, 0) / rows.length : 0;

// Rank-independent value accuracy: how many bands our snapshot holds EXACTLY
// (residual 0) vs genuine value drift. This is the real "are our numbers right".
const valueExact = rows.filter((r) => r.valueResidual != null && r.valueResidual <= EPS);
const trueDriftRows = rows.filter((r) => r.trueDrift);
const rankArtifactRows = rows.filter((r) => r.rankArtifact);
const residuals = rows.map((r) => r.valueResidual || 0);
const meanResidual = residuals.length ? residuals.reduce((a, b) => a + b, 0) / residuals.length : 0;

const summary = {
  capturedObservations: observations.length,
  matchedRows: rows.length,
  distinctStatsTouched: new Set(rows.map((r) => r.key)).size,
  exactFill: exact,
  driftedFill: drifted.length,
  unmatchedObservations: unmatched.length,
  meanAbsFillDrift: +mean.toFixed(3),
  medianAbsFillDrift: +median.toFixed(3),
  maxAbsFillDrift: +maxDrift.toFixed(3),
  signedMeanFillDrift: +signedMean.toFixed(3),
  snapshotStatsTotal: Object.keys(stats).length,
  // rank-independent
  valueExactBands: valueExact.length,
  trueDriftBands: trueDriftRows.length,
  rankArtifactBands: rankArtifactRows.length,
  meanValueResidual: +meanResidual.toFixed(3),
};

if (AS_JSON) {
  console.log(JSON.stringify({ summary, rows, unmatched }, null, 2));
  process.exit(0);
}

// ---- Text report ------------------------------------------------------------
const fmtBand = (b) => b.map(([lo, hi]) => `${lo}–${hi}`).join(' / ');
const pad = (s, n) => String(s).padEnd(n);

console.log(`\n§10 SNAPSHOT ↔ GGG TIER-RANGE AUDIT`);
console.log(`capture: ${IN}`);
console.log(`league:  ${capture._league || '?'}    observations: ${observations.length}\n`);

if (!rows.length) {
  console.log('No observations matched any snapshot stat. Check the capture file / ids.');
} else {
  const list = (SHOW_ALL ? rows : drifted).slice().sort((a, b) => Math.abs(b.fillDrift) - Math.abs(a.fillDrift));
  if (!list.length) {
    console.log(`All ${rows.length} matched tier bands fill EXACTLY (|drift| <= ${EPS}). 🎉\n`);
  } else {
    console.log(`${SHOW_ALL ? 'All matched' : 'Drifted'} tier bands (fillDrift = snapshotMIN − gggMIN), worst first:\n`);
    console.log(`  ${pad('fill∆', 7)}${pad('ceil∆', 7)}${pad('val‼', 6)}${pad('T', 3)}${pad('affix', 7)}${pad('GGG band', 20)}${pad('snapshot band', 20)}stat`);
    for (const r of list) {
      const flags = (r.ambiguousFamilies ? ' *' : '');
      // val‼ column: TRUE value drift residual, or '·' if the band exists exactly
      // (so the fill∆ is only a per-base rank-label offset, not a data error).
      const valCol = r.trueDrift ? String(r.valueResidual) : '·';
      console.log(
        `  ${pad(r.fillDrift > 0 ? '+' + r.fillDrift : r.fillDrift, 7)}` +
        `${pad(r.ceilDrift > 0 ? '+' + r.ceilDrift : r.ceilDrift, 7)}` +
        `${pad(valCol, 6)}` +
        `${pad(r.tier, 3)}${pad(r.affix, 7)}${pad(fmtBand(r.gggBand), 20)}${pad(fmtBand(r.snapBand), 20)}${r.display}${flags}`,
      );
    }
    console.log(`\n  fill∆ = snapshotMIN − gggMIN, joined on RANK: +∆ ⇒ MIN too HIGH → hides valid tier rolls; −∆ ⇒ MIN too LOW → leaks worse rolls.`);
    console.log(`  val‼  = rank-INDEPENDENT value residual. '·' ⇒ band is exact somewhere in our ladder, so fill∆ is only a per-base tier-LABEL offset (NOT a data error).`);
    console.log(`  *     = stat id maps to >1 family; obs routed to best-fit family.`);
  }
}

console.log(`\n── RANK-JOINED FILL DRIFT (GGG P/S rank → our tier number) ──`);
console.log(`  matched tier bands : ${summary.matchedRows}  (across ${summary.distinctStatsTouched} stats / ${summary.snapshotStatsTotal} in snapshot)`);
console.log(`  exact fill         : ${summary.exactFill}`);
console.log(`  drifted fill       : ${summary.driftedFill}`);
console.log(`  mean |fill∆|       : ${summary.meanAbsFillDrift}`);
console.log(`  median |fill∆|     : ${summary.medianAbsFillDrift}`);
console.log(`  max |fill∆|        : ${summary.maxAbsFillDrift}`);
console.log(`  signed mean fill∆  : ${summary.signedMeanFillDrift}  (${signedMean > 0 ? 'snapshot biases HIGH' : signedMean < 0 ? 'snapshot biases LOW' : 'balanced'})`);
console.log(`  unmatched obs      : ${summary.unmatchedObservations}`);

console.log(`\n── BAND-VALUE ACCURACY (rank-independent — "are our NUMBERS right") ──`);
console.log(`  exact-value bands  : ${summary.valueExactBands} / ${summary.matchedRows}  (band exists in our ladder; rank-join ∆ is only a per-base label offset)`);
console.log(`  rank-label-only ∆  : ${summary.rankArtifactBands}  (value correct, fill∆ ≠ 0 purely from per-base rank numbering)`);
console.log(`  TRUE value drift   : ${summary.trueDriftBands}  (band genuinely absent — real data drift)`);
console.log(`  mean value residual: ${summary.meanValueResidual}`);
if (trueDriftRows.length) {
  console.log(`  true-drift stats   : ${[...new Set(trueDriftRows.map((r) => r.display))].join('; ')}`);
}

if (unmatched.length && SHOW_ALL) {
  console.log(`\n── UNMATCHED OBSERVATIONS (no snapshot mapping) ──`);
  for (const u of unmatched.slice(0, 40)) {
    console.log(`  ${u.obs.tier}  ${u.reason}  ${u.obs.base || ''}`);
  }
  if (unmatched.length > 40) console.log(`  …and ${unmatched.length - 40} more`);
}
console.log('');
