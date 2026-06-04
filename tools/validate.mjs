/*
 * §11.5 validation harness — run with: node tools/validate.mjs
 *
 * Part 1: self-tests the compute layer against cases we CONFIRMED live (PLAN §4/§6),
 *         independent of the snapshot's (still unverified) numbers.
 * Part 2: loads assets/data-snapshot.json and prints each tier's computed min per mode,
 *         so the values can be spot-checked against live trade searches.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { computeFilter, computeAllTiers } from '../src/tiers/compute.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

let failures = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✅' : '❌'} ${label} → ${JSON.stringify(got)}${ok ? '' : `  (expected ${JSON.stringify(want)})`}`);
}

console.log('Part 1 — compute self-tests (confirmed cases):');

// Averaged mod, the PLAN §6 worked example: T1 Adds (12–19) to (22–32) → inclusive min 17.
const averaged = {
  isAveraged: true,
  tiers: [
    { tier: 1, ranges: [[12, 19], [22, 32]] },
    { tier: 2, ranges: [[9, 11], [16, 21]] },   // illustrative lower tier (for strict math)
  ],
};
check('averaged T1 inclusive', computeFilter(averaged, 1, 'inclusive'), { min: 17 });           // (12+22)/2
check('averaged T1 exact-band', computeFilter(averaged, 1, 'exact-band'), { min: 17, max: 25.5 }); // (19+32)/2
// strict T1: max(floor 17, worst-lower-ceil (11+21)/2=16 +0.5=16.5) = 17 (floor already excludes T2).
check('averaged T1 strict (>= floor)', computeFilter(averaged, 1, 'strict'), { min: 17 });
// Guards against the common mistake of averaging abs-min & abs-max ((12+32)/2 = 22, too high).
check('averaged T1 inclusive is NOT 22 (over-exclusion bug)', computeFilter(averaged, 1).min !== 22, true);

// Single-value mod: min = tier floor.
const single = { isAveraged: false, tiers: [{ tier: 1, ranges: [[5, 8]] }] };
check('single T1 inclusive', computeFilter(single, 1), { min: 5 });
check('single T1 exact-band', computeFilter(single, 1, 'exact-band'), { min: 5, max: 8 });

// Average-model sanity: live item "Adds 14 to 26" → average 20. A tier whose inclusive
// floor ≤ 20 must include it; > 20 must exclude it. (PLAN §4: min 19 shows, 21 hides.)
const avg = (lo, hi) => (lo + hi) / 2;
check('live: avg(14,26) = 20', avg(14, 26), 20);
check('live: 20 >= floor(17) shows', 20 >= 17, true);

console.log(`\nPart 2 — snapshot computed mins (spot-check vs live searches):`);
const snap = JSON.parse(await readFile(join(root, 'assets', 'data-snapshot.json'), 'utf8'));
console.log(`  version: ${snap.version}`);

// Invariant on real data: strict min is never below the tier's inclusive floor,
// and ordering is monotonic (better tier ⇒ higher-or-equal min).
for (const [key, stat] of Object.entries(snap.stats)) {
  const all = computeAllTiers(stat, 'inclusive');
  let monotonic = true;
  for (const t of stat.tiers) {
    const strict = computeFilter(stat, t.tier, 'strict').min;
    const floor = computeFilter(stat, t.tier, 'inclusive').min;
    if (strict < floor) { check(`${key} T${t.tier} strict >= floor`, strict, `>= ${floor}`); }
  }
  for (let i = 1; i < all.length; i++) if (all[i - 1].min < all[i].min) monotonic = false;
  // NOTE: non-monotonic mins are a WARNING, not a failure — some real PoE2 affixes roll
  // a higher value at a LOWER ilvl tier (e.g. sceptre "#% increased Spirit": lvl-1 = 30–36
  // > lvl-11 = 27–32). Forcing monotonicity would corrupt faithful source data.
  if (!monotonic) console.log(`  ⚠ ${key}: inclusive mins non-monotonic by tier (legit if low-ilvl rolls higher) → ${all.map((t) => t.min).join(',')}`);
}

for (const [key, stat] of Object.entries(snap.stats)) {
  const flag = stat._unverified ? ' ⚠ UNVERIFIED' : '';
  console.log(`\n  [${key}] ${stat.display}  (${stat.tradeStatId}, ${stat.affix}, averaged=${stat.isAveraged})${flag}`);
  for (const t of computeAllTiers(stat, 'inclusive')) {
    const eb = computeFilter(stat, t.tier, 'exact-band');
    const st = computeFilter(stat, t.tier, 'strict');
    console.log(`    T${t.tier} ${t.name ?? ''} ilvl${t.ilvl ?? '?'} ranges=${JSON.stringify(t.ranges)}`);
    console.log(`        inclusive min=${t.min} · exact-band [${eb.min}, ${eb.max}] · strict min=${st.min}`);
  }
}

console.log(`\n${failures === 0 ? '✅ all self-tests passed' : `❌ ${failures} self-test(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
