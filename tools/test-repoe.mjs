/*
 * RePoE cross-check tests on small fixtures (issue #18).
 * Run: node tools/test-repoe.mjs
 */
import { parseMod, spawnsOn, buildLadders, crossCheck } from './repoe.mjs';
import { runGates, buildReport, renderMarkdown } from './check-data.mjs';

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) pass++; else { fail++; console.log(`✖ ${name}`); } };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// text parsing
const st = (...vals) => vals.map(([min, max]) => ({ id: 's', min, max }));
check('link markup stripped, roll lifted', same(parseMod('+(5-8) to [Strength|Strength]', st([5, 8])), { key: '# to strength', values: [[5, 8]] }));
check('single-link markup', parseMod('(5-10)% increased [Accuracy] Rating', st([5, 10])).key === '#% increased accuracy rating');
check('averaged mod keeps both rolls', same(parseMod('Adds (3-5) to (6-9) Fire Damage', st([3, 5], [6, 9])).values, [[3, 5], [6, 9]]));
check('fixed bare roll counts', same(parseMod('Adds 1 to (4-6) Lightning Damage', st([1, 1], [4, 6])).values, [[1, 1], [4, 6]]));
check('fixed wording stays text', parseMod('(6-9)% increased Spell Damage per 100 maximum Life', st([6, 9])).key === '#% increased spell damage per 100 maximum life');
check('reversed range is sorted', same(parseMod('(60-56)% reduced Duration', st([-60, -56])).values, [[56, 60]]));
check('decimal is a scaled roll', parseMod('Gains 0.15 Charges per Second', st([9, 9])).key === 'gains # charges per second');
check('word rung becomes # additional', same(parseMod('Loads an additional bolt', st([1, 1])), { key: 'loads # additional bolts', values: [[1, 1]] }));
check('hybrid is skipped', parseMod('(10-15)% increased Armour\n+(5-8) to maximum Life', st([10, 15], [5, 8])) === null);
check('unrolled second line is fine', parseMod('(61-68)% increased Life Recovered\nCannot be used', st([61, 68])).key === '#% increased life recovered');
check('stat with no text makes a hybrid', parseMod('[Minion|Minions] have (4-8)% increased maximum Life', [{ id: 'aoe', min: 3, max: 6 }, { id: 'life', min: 4, max: 8 }]) === null);
check('fixed stat with no text is fine', parseMod('(10-15)% increased Charges', [{ id: 'a', min: 10, max: 15 }, { id: 'b', min: 1, max: 1 }]).key === '#% increased charges');
check('RePoE wording alias', parseMod('Grenade Skills have +1 Cooldown Use', st([1, 1])).key === 'grenade skills have # cooldown uses');

// spawn rule: first tag the base carries wins
const mod = { spawn_weights: [{ tag: 'str_armour', weight: 0 }, { tag: 'shield', weight: 1 }, { tag: 'default', weight: 0 }] };
check('first matching tag wins (0)', !spawnsOn(mod, new Set(['str_armour', 'shield', 'default'])));
check('first matching tag wins (1)', spawnsOn(mod, new Set(['shield', 'default'])));
check('no matching tag', !spawnsOn(mod, new Set(['ring'])));

// ladders
const classes = [
  { token: 'ring', repoe: ['Ring'] },
  { token: 'belt', repoe: ['Belt'] },
  { token: 'jewel', repoe: ['Jewel'] },
];
const base = (cls, tags, extra = {}) => ({ item_class: cls, domain: cls === 'Jewel' ? 'misc' : 'item', release_state: 'released', tags: [...tags, 'default'], ...extra });
const baseItems = {
  r: base('Ring', ['ring']),
  b: base('Belt', ['belt']),
  j: base('Jewel', ['jewel', 'strjewel']),
  tl: base('Jewel', ['jewel', 'radius_jewel', 'not_for_sale']),
  u: base('Ring', ['ring', 'not_for_sale'], { release_state: 'unique_only' }),
};
const m = (gen, level, text, stats, tags, extra = {}) => ({
  generation_type: gen, domain: 'item', is_essence_only: false, required_level: level, text, stats,
  spawn_weights: [...tags.map((tag) => ({ tag, weight: 1 })), { tag: 'default', weight: 0 }], ...extra,
});
const mods = {
  Life1: m('prefix', 1, '+(10-19) to maximum Life', st([10, 19]), ['ring', 'belt']),
  Life2: m('prefix', 20, '+(20-29) to maximum Life', st([20, 29]), ['ring', 'belt']),
  AbyssLife: m('prefix', 65, '+(40-50) to maximum Life', st([40, 50]), ['belt', 'kurgal_mod'], { domain: 'desecrated' }),
  Ess: m('prefix', 30, '+(30-35) to maximum Life', st([30, 35]), ['ring'], { is_essence_only: true }),
  Map: m('prefix', 1, '+(1-2) to maximum Life', st([1, 2]), ['default'], { domain: 'area' }),
  JewelStr: m('suffix', 1, '(2-4)% increased [Strength|Strength]', st([2, 4]), ['strjewel'], { domain: 'desecrated' }),
  Radius: m('suffix', 1, '(1-2)% increased Area', st([1, 2]), ['radius_jewel'], { domain: 'misc' }),
  Genesis: m('prefix', 1, '(5-9)% increased Spell Damage', st([5, 9]), ['genesis_tree_caster']),
  Hybrid: m('prefix', 1, '+(1-2) to Armour\n+(3-4) to Evasion', st([1, 2], [3, 4]), ['ring']),
};
const repoe = buildLadders({ mods, baseItems, classes });
check('item + desecrated tiers, essence/area skipped', same(repoe.prefix['# to maximum life'].map((r) => [r.level, r.types]), [[1, ['ring', 'belt']], [20, ['ring', 'belt']], [65, ['belt']]]));
check('desecrated jewel mod lands on jewel', same(repoe.suffix['#% increased strength'][0].types, ['jewel']));
check('not_for_sale radius base is not a jewel ladder', !repoe.suffix['#% increased area']);
check('radius tag is a base tag, not a mechanic', !repoe.mechanic['suffix|#% increased area']);
check('mechanic tag recorded', same(repoe.mechanic['prefix|#% increased spell damage'], ['genesis_tree_caster']));
check('hybrid skipped', !Object.keys(repoe.prefix).some((k) => /armour/.test(k)));

// cross-check
const row = (level, values, types) => ({ level: String(level), values: values.map((p) => p.map(String)), types });
const scrape = {
  prefix: {
    '# to maximum life': [row(1, [[10, 19]], ['ring', 'belt']), row(20, [[20, 30]], ['ring', 'belt']), row(65, [[40, 50]], ['belt'])],
    '#% increased spell damage': [row(1, [[5, 9]], ['ring'])],
    'only on poe2db': [row(1, [[1, 1]], ['ring'])],
  },
  suffix: { '#% increased strength': [row(1, [[2, 4]], ['jewel', 'belt'])] },
};
const x = crossCheck({ scrape, repoe, classes });
check('no gate when every class has mods on both sides', x.gate.length === 0);
check('range disagreement grouped across classes', same(x.ladders, ['# to maximum life (prefix) [ring, belt]: level 20: 20–30 vs 20–29']));
check('class disagreement', same(x.classes, ['#% increased strength (suffix): only PoE2DB has it on belt']));
check('PoE2DB-only stat', same(x.onlyPoe2db, ['only on poe2db (prefix) [ring]']));
check('mechanic stat is explained, not a disagreement', x.explained.length === 1 && /spell damage.*genesis_tree_caster/.test(x.explained[0]));
const lvl = crossCheck({ scrape: { prefix: { '# to maximum life': [row(1, [[10, 19]], ['ring']), row(5, [[12, 20]], ['ring'])] }, suffix: {} }, repoe, classes });
check('extra level reported', lvl.ladders.some((l) => /levels only on PoE2DB: 5; only on RePoE: 20/.test(l)));

const gone = crossCheck({ scrape: { prefix: { a: [row(1, [[1, 2]], ['ring', 'belt', 'jewel'])] }, suffix: {} }, repoe: { prefix: { a: [{ level: 1, values: [[1, 2]], types: ['ring', 'belt'] }] }, suffix: {} }, classes });
const two = (vals) => ({ prefix: { a: vals.map((v) => ({ level: 65, values: [v], types: ['belt'] })) }, suffix: {} });
const dup = crossCheck({ scrape: two([[10, 18]]), repoe: two([[10, 15], [10, 18]]), classes });
check('two mods at one level are one tier spanning both', dup.ladders.length === 0 && dup.classes.length === 0);
check('identical mods at one level are one tier', crossCheck({ scrape: two([[8, 15]]), repoe: two([[8, 15], [8, 15]]), classes }).ladders.length === 0);
check('whole class missing in RePoE is a gate', gone.gate.length === 1 && /"jewel"/.test(gone.gate[0]));

// check-data wiring
const snap = { stats: {} };
check('gate 6 runs only with RePoE', runGates({ snap, prev: null, classes, ignored: {}, scrape: null, filters: { result: [] } }).length === 1);
const report = buildReport({ snap, prev: null, classes: [], scrape, repoe });
const md = renderMarkdown({ errors: [], report, prevLabel: 't', repoeLabel: '2026-11-25 10:00 UTC' });
check('report has the RePoE section', /# RePoE cross-check/.test(md) && /fetched 2026-11-25/.test(md) && /## Stats only on PoE2DB \(1\)/.test(md));
check('report says when RePoE is missing', /No RePoE export/.test(renderMarkdown({ errors: [], report: buildReport({ snap, prev: null, classes: [] }), prevLabel: 't' })));

if (fail) { console.log(`\n✖ ${fail} RePoE test(s) failed (${pass} passed)`); process.exit(1); }
console.log(`✅ all RePoE tests passed (${pass} passed)`);
