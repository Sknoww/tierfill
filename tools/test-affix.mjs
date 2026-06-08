/*
 * Affix-split tests — validates the combined (prefix+suffix) rarity ladder against
 * the shipped snapshot. Run: node tools/test-affix.mjs
 *
 * Rarity rolls one trade stat as both a prefix and a suffix; trade SUMS them, so the
 * combined ladder's tier floors are the per-tier sums (T1 = 28 + 26 = 54, …). The
 * tool fills that summed MIN into the single rarity filter.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isAffixSplit, buildCombinedFamily, sumRanges } from '../src/content/affix.mjs';
import { computeAllTiers } from '../src/tiers/compute.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const snap = JSON.parse(readFileSync(join(here, '..', 'assets', 'data-snapshot.json'), 'utf8'));

const rarity = Object.values(snap.stats).filter((s) => /rarity of items/i.test(s.display || ''));

let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? '✅' : '❌'} ${label} → ${JSON.stringify(got)}${ok ? '' : `  (expected ${JSON.stringify(want)})`}`);
  ok ? pass++ : fail++;
}

console.log('\nDetection + summation:');
check('rarity has two ladders', rarity.length, 2);
check('isAffixSplit(rarity) → true', isAffixSplit(rarity), true);
check('isAffixSplit(single) → false', isAffixSplit([rarity[0]]), false);
check('sumRanges single-roll', sumRanges([[28, 32]], [[26, 30]]), [[54, 62]]);

const combined = buildCombinedFamily(rarity);
check('combined is flagged', combined._combined, true);
check('combined covers all types', [...combined.types].sort(),
  ['amulet', 'boots', 'gloves', 'helmet', 'ring']);

console.log('\nCombined tier floors (inclusive MIN the control fills):');
const mins = computeAllTiers(combined, 'inclusive').map((t) => t.min);
// Top three are the per-tier sums (prefix+suffix); the bottom two extend down into
// single-affix territory (suffix T2=11, T3=6) so a lone-affix item (gloves) has low
// options. Values per PoE2DB: prefix 16/12/8, suffix 15/11/6 → sums 31/23/14.
check('floors = 31/23/14 + low 11/6', mins, [31, 23, 14, 11, 6]);
check('lowest combined floor reaches a single weak roll', mins[mins.length - 1], 6);

console.log('\nSingle-affix ladders still compute on their own:');
const prefix = rarity.find((s) => s.affix === 'prefix');
const suffix = rarity.find((s) => s.affix === 'suffix');
check('prefix floors (Hoarder/Collector/Magpie)', computeAllTiers(prefix, 'inclusive').map((t) => t.min), [16, 12, 8]);
check('suffix floors (Archaeology/Raiding/Plunder; gloves max 18)', computeAllTiers(suffix, 'inclusive').map((t) => t.min), [15, 11, 6]);

console.log(`\n${fail === 0 ? '✅ all affix tests passed' : `❌ ${fail} failed`} (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
