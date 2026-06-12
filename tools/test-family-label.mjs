/*
 * Family-label tests — validates the item-type selector's collapsed umbrella and
 * dropdown list against the shipped snapshot. Run: node tools/test-family-label.mjs
 *
 * The labels derive purely from each family's `types` array (PoE2DB categories),
 * so they're testable without a DOM. Covers the cases that motivated the rework:
 * single items keep their name, weapon bundles collapse to One-/Two-Handed, caster
 * bundles read "Caster", and cross-category bundles use "LeadItem +N" (alphabetical).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { familyUmbrella, familyTypeList } from '../src/ui/tier-control.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const snap = JSON.parse(readFileSync(join(here, '..', 'assets', 'data-snapshot.json'), 'utf8'));

const groups = new Map();
for (const v of Object.values(snap.stats || {})) {
  const d = String(v.display || '');
  if (!groups.has(d)) groups.set(d, []);
  groups.get(d).push(v);
}
const famFor = (display, ...types) => {
  const fams = groups.get(display) || [];
  const want = new Set(types);
  return fams.find((f) => (f.types || []).length === want.size && (f.types || []).every((t) => want.has(t)));
};

let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? '✅' : '❌'} ${label} → ${JSON.stringify(got)}${ok ? '' : `  (expected ${JSON.stringify(want)})`}`);
  ok ? pass++ : fail++;
}
// Resolve a family by its exact type-set and fail cleanly (not a crash) if the snapshot
// no longer groups those types together — per-type reconstruction can re-shape families.
function umbrellaOf(display, ...types) {
  const f = famFor(display, ...types);
  if (!f) { console.log(`  ❌ no family [${types.join(',')}] for "${display}" — update the test to the snapshot`); fail++; return null; }
  return familyUmbrella(f);
}

console.log('\nCollapsed umbrellas:');
// Single items keep their real name (no more "a lone Wand is 1-handed").
check('Cold Spell Skills · Wand', umbrellaOf('# to Level of all Cold Spell Skills', 'wand'), 'Wand');
check('Cold Spell Skills · Staff', umbrellaOf('# to Level of all Cold Spell Skills', 'staff'), 'Staff');
check('Cold Damage · Ring', umbrellaOf('#% increased Cold Damage', 'ring'), 'Ring');
// Caster bundle (caster weapon + off-hand): maximum Mana groups sceptre/wand/focus.
check('Max Mana · sceptre/wand/focus', umbrellaOf('# to maximum Mana', 'sceptre', 'wand', 'focus'), 'Caster');
// Weapon bundles → hand-class by majority (bow rides the 1H ladder, crossbow the 2H).
check('Elem Dmg w/ Attacks · 1H (incl bow)',
  umbrellaOf('#% increased Elemental Damage with Attacks', 'claw', 'dagger', 'one-hand-sword', 'one-hand-axe', 'one-hand-mace', 'spear', 'flail', 'bow'), 'One-Handed');
check('Elem Dmg w/ Attacks · 2H (incl crossbow)',
  umbrellaOf('#% increased Elemental Damage with Attacks', 'two-hand-sword', 'two-hand-axe', 'two-hand-mace', 'quarterstaff', 'crossbow'), 'Two-Handed');
// One-category gear / flask bundles (per-type split groups same-ladder slots).
check('Armour · gloves+boots bundle', umbrellaOf('# to Armour', 'gloves', 'boots'), 'Armour');
check('Charge · life/mana flask + charm', umbrellaOf('#% Chance to gain a Charge when you kill an enemy', 'life-flask', 'mana-flask', 'charm'), 'Flasks');
// Cross-category bundles → alphabetically-first item + count.
check('Rarity · prefix (helmet/amulet/ring)',
  umbrellaOf('#% increased Rarity of Items found', 'helmet', 'amulet', 'ring'), 'Amulet +2');
check('Max Mana · gloves/boots/belt', umbrellaOf('# to maximum Mana', 'gloves', 'boots', 'belt'), 'Belt +2');

console.log('\nDropdown lists (alphabetical):');
check('caster bundle → alphabetical',
  familyTypeList(famFor('# to maximum Mana', 'sceptre', 'wand', 'focus')), ['Focus', 'Sceptre', 'Wand']);
check('two-hand bundle → alphabetical',
  familyTypeList(famFor('#% increased Elemental Damage with Attacks', 'two-hand-sword', 'two-hand-axe', 'two-hand-mace', 'quarterstaff', 'crossbow')),
  ['Crossbow', 'Quarterstaff', 'Two Hand Axe', 'Two Hand Mace', 'Two Hand Sword']);

console.log('\nInvariants across every multi-family stat:');
for (const [display, fams] of groups) {
  if (fams.length < 2) continue;
  for (const f of fams) {
    const u = familyUmbrella(f);
    if (!u || u === '?') { console.log(`  ❌ empty umbrella for ${display} ${JSON.stringify(f.types)}`); fail++; }
    const list = familyTypeList(f);
    const sorted = [...list].sort((a, b) => a.localeCompare(b));
    if (JSON.stringify(list) !== JSON.stringify(sorted)) { console.log(`  ❌ list not sorted for ${display}`); fail++; }
  }
}
console.log(`  (checked ${[...groups.values()].filter((g) => g.length > 1).length} multi-family stats)`);

console.log(`\n${fail === 0 ? '✅ all family-label tests passed' : `❌ ${fail} failed`} (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
