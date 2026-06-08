/*
 * Jewel (single-range) tests — the percentile MIN picker + the "Any Jewel" category
 * detection. Run: node tools/test-jewel.mjs
 *
 * Jewel mods carry ONE wide range instead of a tier ladder, so the picker slices that
 * range into Min/25/50/75/90/Max MIN presets (computeThresholds), results badge where
 * a roll sits in its range (rollPercentile), and detection resolves the trade site's
 * sole "Any Jewel" category to our `jewel` family token.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { computeThresholds, isSingleRange } from '../src/tiers/compute.mjs';
import { rollPercentile } from '../src/content/detect-tier.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const snap = JSON.parse(readFileSync(join(here, '..', 'assets', 'data-snapshot.json'), 'utf8'));

let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? '✅' : '❌'} ${label} → ${JSON.stringify(got)}${ok ? '' : `  (expected ${JSON.stringify(want)})`}`);
  ok ? pass++ : fail++;
}

const jewel = (ranges) => ({ display: 'jewel mod', tiers: [{ tier: 1, ranges }] });

console.log('\nisSingleRange (one tier ⇒ jewel/percentile mode):');
check('one tier → true', isSingleRange(jewel([[10, 20]])), true);
check('two tiers → false', isSingleRange({ tiers: [{ tier: 1 }, { tier: 2 }] }), false);
check('no tiers → false', isSingleRange({ tiers: [] }), false);

console.log('\ncomputeThresholds (Min·25·50·75·90·Max cuts of the single range):');
const wide = computeThresholds(jewel([[10, 20]]));
check('wide range labels', wide.map((t) => t.label), ['Min', '25%', '50%', '75%', '90%', 'Max']);
check('wide range mins', wide.map((t) => t.min), [10, 13, 15, 18, 19, 20]);
check('every option carries the full range', wide.every((t) => JSON.stringify(t.range) === '[10,20]'), true);

// Narrow range: adjacent cuts round to the same MIN. Dups collapse keeping the
// HIGHEST-% label, so Max(11) always survives and Min(10) yields to 25%(10).
const narrow = computeThresholds(jewel([[10, 11]]));
check('narrow range dedups', narrow.map((t) => t.min), [10, 11]);
check('narrow keeps Max, drops Min for 25%', narrow.map((t) => t.label), ['25%', 'Max']);

console.log('\nrollPercentile (where a roll sits in its band, 0–100):');
check('floor → 0%', rollPercentile([10], [[10, 20]]), 0);
check('ceil → 100%', rollPercentile([20], [[10, 20]]), 100);
check('mid → 50%', rollPercentile([15], [[10, 20]]), 50);
check('below floor clamps to 0', rollPercentile([5], [[10, 20]]), 0);
check('above ceil clamps to 100', rollPercentile([25], [[10, 20]]), 100);
check('two-sub-roll uses the average axis', rollPercentile([15, 35], [[10, 20], [30, 40]]), 50);
check('fixed band (no spread) → null', rollPercentile([10], [[10, 10]]), null);

// ── "Any Jewel" category detection ────────────────────────────────────────────
// The trade site exposes the chosen category as the dropdown's PLACEHOLDER text.
// resolveFamily reads it live off the DOM, so stub a minimal document exposing a
// single set "Item Category" filter-select. Re-imported fresh per placeholder.
function stubDocument(placeholder) {
  const sel = {
    classList: { contains: (c) => c === 'modified' },
    querySelector: () => ({
      getAttribute: (a) => (a === 'placeholder' ? placeholder : null),
      value: '',
    }),
  };
  globalThis.document = {
    querySelectorAll: (q) => (q.includes('filter-select') ? [sel] : []),
    querySelector: () => null, // no committed base item in the search bar
  };
}

const { resolveFamily } = await import('../src/content/detect.mjs');
const jewelFam = { display: '#% increased Armour', types: ['jewel'], tiers: [{ tier: 1, ranges: [[5, 10]] }] };
const gearFam = { display: '#% increased Armour', types: ['body-armour'], tiers: [{ tier: 1, ranges: [[1, 2]] }, { tier: 2, ranges: [[3, 4]] }] };

console.log('\nresolveFamily for a gear-overlap mod under the live category:');
stubDocument('Any Jewel');
check('"Any Jewel" → resolves to the jewel family', resolveFamily([jewelFam, gearFam]).family.types, ['jewel']);
check('"Any Jewel" → not ambiguous', resolveFamily([jewelFam, gearFam]).ambiguous, false);

stubDocument('Body Armour');
check('"Body Armour" → resolves to the gear family', resolveFamily([jewelFam, gearFam]).family.types, ['body-armour']);

stubDocument('Any Ranged Weapon'); // group category — matches neither, stays ambiguous
check('group category → ambiguous (user picks)', resolveFamily([jewelFam, gearFam]).ambiguous, true);

// ── shipped snapshot sanity ───────────────────────────────────────────────────
console.log('\nShipped snapshot:');
const jewelEntries = Object.values(snap.stats).filter((s) => (s.types || []).includes('jewel'));
check('jewel families exist in the snapshot', jewelEntries.length > 0, true);
check('every jewel family is single-range (one tier)', jewelEntries.every(isSingleRange), true);

console.log(`\n${fail === 0 ? '✅ all jewel tests passed' : `❌ ${fail} failed`} (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
