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

console.log('\nCollapsed umbrellas:');
// Single items keep their real name (no more "a lone Wand is 1-handed").
check('Cold Spell Skills · Wand', familyUmbrella(famFor('# to Level of all Cold Spell Skills', 'wand')), 'Wand');
check('Cold Spell Skills · Staff', familyUmbrella(famFor('# to Level of all Cold Spell Skills', 'staff')), 'Staff');
check('Cold Damage · Ring', familyUmbrella(famFor('#% increased Cold Damage', 'ring')), 'Ring');
// Caster bundle (weapon + off-hands / jewellery).
check('Cold Damage · wand/shield/focus', familyUmbrella(famFor('#% increased Cold Damage', 'wand', 'shield', 'focus')), 'Caster');
check('Cast Speed · wand/shield/focus/amulet/ring',
  familyUmbrella(famFor('#% increased Cast Speed', 'wand', 'shield', 'focus', 'amulet', 'ring')), 'Caster');
// Weapon bundles → hand-class by majority (bow rides the 1H ladder here).
check('Elem Dmg w/ Attacks · 1H (incl bow)',
  familyUmbrella(famFor('#% increased Elemental Damage with Attacks', 'claw', 'dagger', 'one-hand-sword', 'one-hand-axe', 'one-hand-mace', 'spear', 'flail', 'bow')), 'One-Handed');
check('Elem Dmg w/ Attacks · 2H (incl crossbow)',
  familyUmbrella(famFor('#% increased Elemental Damage with Attacks', 'two-hand-sword', 'two-hand-axe', 'two-hand-mace', 'quarterstaff', 'crossbow')), 'Two-Handed');
// One-category gear/jewellery/flask bundles.
check('Armour · shield+armour bundle',
  familyUmbrella(famFor('# to Armour', 'shield', 'gloves', 'boots', 'body-armour', 'helmet')), 'Armour');
check('Charge · life+mana flask', familyUmbrella(famFor('#% Chance to gain a Charge when you kill an enemy', 'life-flask', 'mana-flask')), 'Flasks');
// Cross-category bundles → alphabetically-first item + count.
check('Rarity · prefix (helmet/amulet/ring)',
  familyUmbrella(famFor('#% increased Rarity of Items found', 'helmet', 'amulet', 'ring')), 'Amulet +2');
check('Max Mana · everything', familyUmbrella(famFor('# to maximum Mana', 'wand', 'sceptre', 'shield', 'focus', 'gloves', 'boots', 'helmet', 'amulet', 'ring', 'belt')), 'Amulet +9');

console.log('\nDropdown lists (alphabetical):');
check('wand/shield/focus → alphabetical',
  familyTypeList(famFor('#% increased Cold Damage', 'wand', 'shield', 'focus')), ['Focus', 'Shield', 'Wand']);
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
