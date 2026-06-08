/*
 * §9 detection self-tests — validates src/content/detect-tier.mjs against the
 * real shipped snapshot. Run: node tools/test-detect.mjs
 *
 * These cover the lucky-roll case that motivates §9: a max-rolled lower tier
 * that the server's average filter lets through must be detected as its TRUE
 * (lower) tier so the annotator can flag/dim it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  detectFromText, templateToRegex,
  parseGggTier, parseGggRanges, rollQuality, parseRolls,
} from '../src/content/detect-tier.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const snap = JSON.parse(readFileSync(join(here, '..', 'assets', 'data-snapshot.json'), 'utf8'));

function findByDisplay(display) {
  const want = display.toLowerCase();
  for (const [key, entry] of Object.entries(snap.stats || {})) {
    if ((entry.display || '').toLowerCase() === want) return { key, ...entry };
  }
  throw new Error(`snapshot has no stat with display "${display}"`);
}

let pass = 0;
let fail = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? '✅' : '❌'} ${label} → ${JSON.stringify(got)}${ok ? '' : `  (expected ${JSON.stringify(want)})`}`);
  ok ? pass++ : fail++;
}

const fire = findByDisplay('Adds # to # Fire damage to Attacks');
console.log(`\n[${fire.key}] ${fire.display}  (averaged=${fire.isAveraged})`);
fire.tiers.forEach((t) => console.log(`    T${t.tier} ranges=${JSON.stringify(t.ranges)}`));

console.log('\nDetection:');
// Expectations track the GGG-authoritative fire ladder (§13b override): T1 25-29/
// 37-45, T2 20-24/33-36, T3 13-19/27-32, … Adds 17 to 27 → 17∈[13,19], 27∈[27,32] = T3.
check('"Adds 17 to 27 Fire damage to Attacks" (the probed lucky roll)',
  detectFromText(fire, 'Adds 17 to 27 Fire damage to Attacks'), { tier: 3, exact: true });
// A genuine T1: 25∈[25,29], 40∈[37,45].
check('"Adds 25 to 40 …" (true T1)',
  detectFromText(fire, 'Adds 25 to 40 Fire damage to Attacks'), { tier: 1, exact: true });
// A weak low roll: 5∈[3,5], 9∈[6,9] = T8 (bottom-but-one).
check('"Adds 5 to 9 …" (low tier)',
  detectFromText(fire, 'Adds 5 to 9 Fire damage to Attacks'), { tier: 8, exact: true });
// Case/spacing independence (lowercase, extra spaces).
check('case + spacing insensitive',
  detectFromText(fire, 'adds   17   to   27   fire   damage   to   attacks'), { tier: 3, exact: true });
// Wrong mod text → no match.
check('non-matching mod text → null',
  detectFromText(fire, 'Adds 17 to 27 Cold damage to Attacks'), null);
// The regex must NOT match the local "Adds # to # Fire Damage" (no "to Attacks").
check('does not match the local (no "to Attacks") variant',
  templateToRegex(fire.display).test('Adds 17 to 27 Fire Damage'), false);

// ── §9 GGG-sourced parsing (the chosen approach) — strings from the live probe ──
console.log('\nGGG tier parsing (from result mod text):');
// Exact line captured from a result (em-dash separators, no space before "Adds").
const LINE = 'P2 [20—24 to 33—36]Adds 22 to 35 Fire damage to Attacks';
check('parseGggTier → P2', parseGggTier(LINE), { affix: 'P', tier: 2 });
check('parseGggRanges → [[20,24],[33,36]]', parseGggRanges(LINE), [[20, 24], [33, 36]]);
check('parseGggTier ignores a label-less line',
  parseGggTier('Adds 22 to 35 Fire damage to Attacks'), null);

// Roll quality: pull the real rolls via the stat regex, grade vs GGG's band.
const rolls = parseRolls(templateToRegex(fire.display).exec(LINE));
check('rolls extracted past the bracket → [22,35]', rolls, [22, 35]);
check('22/35 in P2 band [[20,24],[33,36]] → mid', rollQuality(rolls, [[20, 24], [33, 36]]), 'mid');
check('24/35 → high', rollQuality([24, 35], [[20, 24], [33, 36]]), 'high');
check('20/33 → low', rollQuality([20, 33], [[20, 24], [33, 36]]), 'low');
// Single-value mod line (the "of Valour" S3 shape).
check('single-value parseGggTier → S3', parseGggTier('S3 [41—53] +47 to maximum Life'), { affix: 'S', tier: 3 });
check('single-value parseGggRanges → [[41,53]]', parseGggRanges('S3 [41—53] +47 to maximum Life'), [[41, 53]]);
check('single-value 47 in [41,53] → mid', rollQuality([47], [[41, 53]]), 'mid');

// Desecrated mod line — carries GGG's tier bracket exactly like an explicit one,
// so the class-agnostic parsers handle it unchanged (the §9 fix only widens the
// DOM selector). Exact textContent captured from a desecrated result line.
const DESECRATED = 'P4 [6—10 to 12—17]Adds 6 to 16 Physical Damage to AttacksAnnealed (≥54)';
check('desecrated parseGggTier → P4', parseGggTier(DESECRATED), { affix: 'P', tier: 4 });
check('desecrated parseGggRanges → [[6,10],[12,17]]', parseGggRanges(DESECRATED), [[6, 10], [12, 17]]);
const desRolls = parseRolls(templateToRegex('Adds # to # Physical Damage to Attacks').exec(DESECRATED));
check('desecrated rolls extracted (trailing suffix ignored) → [6,16]', desRolls, [6, 16]);
check('desecrated 6/16 in [[6,10],[12,17]] → mid', rollQuality(desRolls, [[6, 10], [12, 17]]), 'mid');

// Fractured mod line — same story as desecrated: shares the explicit stat id +
// ladder, carries GGG's tier bracket, parsed unchanged. Captured textContent.
const FRACTURED = 'P1 [12—19 to 22—32]Adds 16 to 25 Physical Damage to AttacksFlaring (≥75)';
check('fractured parseGggTier → P1', parseGggTier(FRACTURED), { affix: 'P', tier: 1 });
check('fractured parseGggRanges → [[12,19],[22,32]]', parseGggRanges(FRACTURED), [[12, 19], [22, 32]]);
const fracRolls = parseRolls(templateToRegex('Adds # to # Physical Damage to Attacks').exec(FRACTURED));
check('fractured rolls extracted (trailing suffix ignored) → [16,25]', fracRolls, [16, 25]);
check('fractured 16/25 in [[12,19],[22,32]] → mid', rollQuality(fracRolls, [[12, 19], [22, 32]]), 'mid');

// Inverted (sign-flipped) mod line — the result prints the opposite-polarity wording
// ("reduced") and a positive roll against GGG's NEGATIVE band. The annotator matches
// the inverted wording and flips the roll's sign before grading. Captured textContent.
console.log('\nInverted (sign-flipped) mod line:');
const INVERTED = 'S2 [-29—-27]28% reduced Charges per useof the Brewer (≥64)';
check('inverted parseGggTier → S2', parseGggTier(INVERTED), { affix: 'S', tier: 2 });
check('inverted parseGggRanges → [[-29,-27]]', parseGggRanges(INVERTED), [[-29, -27]]);
// The annotator builds the match regex from the inverted wording (increased→reduced).
const invRe = templateToRegex('#% increased Charges per use'.replace(/\bincreased\b/gi, 'reduced'));
const invRolls = parseRolls(invRe.exec(INVERTED)).map((v) => -v); // sign-flipped to the band's axis
check('inverted rolls extracted + negated → [-28]', invRolls, [-28]);
check('inverted -28 in [[-29,-27]] → mid', rollQuality(invRolls, [[-29, -27]]), 'mid');

console.log(`\n${fail === 0 ? '✅ all §9 detection tests passed' : `❌ ${fail} failed`} (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
