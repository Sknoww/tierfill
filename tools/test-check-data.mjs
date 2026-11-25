/*
 * check-data tests — hard gates and diff report on small fixtures (issue #3).
 * Run: node tools/test-check-data.mjs
 */
import { runGates, buildReport, renderMarkdown, ladderImproves, floorOf } from './check-data.mjs';

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) pass++; else { fail++; console.log(`✖ ${name}`); } };

const classes = [
  { token: 'bow', category: 'weapon.bow', text: 'Bow', kind: 'weapon', hand: '2h', pages: ['Bows'] },
  { token: 'ring', category: 'accessory.ring', text: 'Ring', kind: 'jewellery', pages: ['Rings'] },
];
const ignored = { 'weapon.rod': 'Fishing Rod' };
const scrape = { _pages: ['Bows→bow (140)', 'Rings→ring (300)'], prefix: { 'adds # to # fire damage': [] }, suffix: {} };
const filters = (extra = []) => ({
  result: [{ id: 'type_filters', filters: [{ id: 'category', option: { options: [
    { id: null, text: 'Any' }, { id: 'weapon', text: 'Any Weapon' }, { id: 'weapon.ranged', text: 'Any Ranged Weapon' },
    { id: 'weapon.bow', text: 'Bow' }, { id: 'weapon.rod', text: 'Fishing Rod' }, { id: 'accessory.ring', text: 'Ring' },
    { id: 'gem.activegem', text: 'Skill Gem' }, ...extra,
  ] } }] }],
});
const ladder = (...floors) => floors.map((f, i) => ({ tier: i + 1, ilvl: 80 - i, ranges: [[f, f + 1]] }));
const entry = (display, types, tiers, id) => ({ display, types, tiers, tradeStatId: id === undefined ? `explicit.${display.length}` : id });
const snapOf = (...es) => ({ stats: Object.fromEntries(es.map((e, i) => [`k${i}`, e])) });
const ggg = (...ids) => ({ result: [{ id: 'explicit', entries: ids.map((id) => ({ id, text: id })) }] });

const fire = entry('Adds # to # Fire Damage', ['bow'], ladder(50, 30, 10), 'explicit.fire');
const life = entry('+# to maximum Life', ['ring'], ladder(40, 20), 'explicit.life');
const base = { classes, ignored, scrape, filters: filters(), gggStats: ggg('explicit.fire', 'explicit.life') };

// gates
check('clean build passes every gate', runGates({ ...base, snap: snapOf(fire, life), prev: snapOf(fire, life) }).length === 0);
let errs = runGates({ ...base, snap: snapOf(fire), prev: null, filters: filters([{ id: 'weapon.talisman', text: 'Talisman' }]) });
check('unmapped GGG category fails with the line to add', errs.length === 1 && /weapon\.talisman/.test(errs[0]) && /"token": "talisman"/.test(errs[0]));
check('missing filters capture fails', runGates({ ...base, snap: snapOf(fire), prev: null, filters: null }).length === 1);
errs = runGates({ ...base, snap: snapOf(fire, entry('X', ['talisman'], ladder(1))), prev: null });
check('unknown snapshot token fails', errs.length === 1 && /talisman/.test(errs[0]));
errs = runGates({ ...base, scrape: { _pages: ['Bows→bow (140)'] }, snap: snapOf(fire), prev: null });
check('a class page missing from the scrape fails', errs.length === 1 && /Rings/.test(errs[0]));
errs = runGates({ ...base, snap: snapOf({ ...fire, tradeStatId: null }, life), prev: snapOf(fire, life) });
check('a still-scraped stat losing its id fails', errs.length === 1 && /explicit\.fire/.test(errs[0]));
errs = runGates({ ...base, snap: snapOf(fire), prev: snapOf(fire, life) });
check('a whole item type vanishing fails', errs.some((e) => /"ring"/.test(e)));
errs = runGates({ ...base, snap: snapOf(fire, entry('Other', ['ring'], ladder(5))), prev: snapOf(fire, life) });
check('a stat dropped from the scrape is a removal, not a gate failure', errs.length === 0);

// ladder helpers
check('averaged floor is the mean of the lows', floorOf({ ranges: [[10, 12], [20, 30]] }) === 15);
check('rising ladder improves', ladderImproves(entry('a', [], ladder(30, 20, 10))));
check('scrambled ladder does not', !ladderImproves(entry('a', [], ladder(30, 40, 10))));
check('inverted ladder improves downward', ladderImproves({ inverted: true, tiers: ladder(-30, -20) }));

// report
const prev = snapOf(fire, life, entry('Gone', ['ring'], ladder(3)));
const now = snapOf(
  entry('Adds # to # Fire Damage', ['bow'], ladder(80, 30, 10, 5), 'explicit.fire'),
  entry('+# to maximum Life', ['ring', 'bow'], ladder(40, 20), 'explicit.life'),
  entry('New stat', ['ring'], ladder(9), null),
  entry('Scrambled', ['ring'], ladder(1, 3)),
);
const r = buildReport({ snap: now, prev, gggStats: ggg('a', 'b'), gggPrev: ggg('a'), classes });
check('added and removed stats', r.addedStats.join() === 'New stat,Scrambled' && r.removedStats.join() === 'Gone');
check('type gained and family change reported once', r.moved.length === 1 && /now also on bow/.test(r.moved[0]));
check('tier count and T1 shift flagged', r.ladders.length === 1 && /3 → 4 tiers/.test(r.ladders[0]) && /T1 floor 50 → 80/.test(r.ladders[0]));
check('out-of-order ladder flagged', r.order.length === 1 && /Scrambled/.test(r.order[0]));
check('new unjoined stat listed', r.unjoined.join() === 'New stat [ring]');
check('GGG additions listed', r.gggAdded.length === 1 && /^b/.test(r.gggAdded[0]));
check('weapon T1 table marks the change', r.weaponT1[0][0] === 'bow' && /50–51 → \*\*80–81\*\*/.test(r.weaponT1[0][2]));
const md = renderMarkdown({ errors: ['boom'], report: r, prevLabel: 'test' });
check('markdown lists gate failures and sections', /## Hard gate failures \(1\)/.test(md) && /\| bow \|/.test(md));

if (fail) { console.log(`\n✖ ${fail} check-data test(s) failed (${pass} passed)`); process.exit(1); }
console.log(`✅ all check-data tests passed (${pass} passed)`);
