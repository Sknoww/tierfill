/*
 * spot-check tests — the live trade-listing tier check (issue #20).
 * Run: node tools/test-spot-check.mjs
 */
import { parseTier, spotCheck, baseTypeMap, report, SNIPPET } from './spot-check.mjs';

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) pass++; else { fail++; console.log(`✖ ${name}`); } };

const H = 'explicit.stat_1';
const stats = {
  life_ring: { display: '+# to maximum Life', tradeStatId: H, affix: 'prefix', family: 'Ring', types: ['ring'],
    tiers: [{ tier: 1, ilvl: 60, ranges: [[40, 49]] }, { tier: 2, ilvl: 30, ranges: [[30, 39]] }] },
  life_body: { display: '+# to maximum Life', tradeStatId: H, affix: 'prefix', family: 'Body Armour', types: ['body-armour'],
    tiers: [{ tier: 1, ilvl: 80, ranges: [[150, 174]] }] },
  added_fire: { display: 'Adds # to # Fire Damage', tradeStatId: 'explicit.stat_2', affix: 'prefix', family: 'Bow', types: ['bow'],
    isAveraged: true, tiers: [{ tier: 1, ilvl: 75, ranges: [[20, 24], [33, 36]] }] },
  charges: { display: '#% increased Charges per use', tradeStatId: 'explicit.stat_3', affix: 'suffix', family: 'Flask', types: ['life-flask'],
    inverted: true, tiers: [{ tier: 1, ilvl: 64, ranges: [[-29, -27]] }] },
};
const bases = new Map([['Gold Ring', 'ring'], ['Mail Vest', 'body-armour'], ['Short Bow', 'bow'], ['Flask', 'life-flask']]);
const band = (tier, base, magnitudes, extra = {}) => ({ tier, base, level: 60, name: 'x', magnitudes, ...extra });
const mag = (hash, min, max) => ({ hash, min, max });

const capture = { bands: [
  band('P1', 'Gold Ring', [mag(H, 40, 49)]),                                    // agrees, ring family
  band('P1', 'Mail Vest', [mag(H, 40, 49)]),                                    // ring band on a body armour: disagrees
  band('P1', 'Short Bow', [mag('explicit.stat_2', 20, 24), mag('explicit.stat_2', 33, 36)]), // averaged, agrees
  band('P2', 'Short Bow', [mag('explicit.stat_2', 18, 24), mag('explicit.stat_2', 33, 36)]), // off by 2
  band('S1', 'Flask', [mag('explicit.stat_3', -27, -29)]),                      // reversed + inverted, agrees
  band('P1', 'Gold Ring', [mag(H, 1, 2), mag('explicit.stat_2', 3, 4)]),       // hybrid
  band('P1', 'Gold Ring', [mag('explicit.stat_99', 1, 2)]),                     // not in snapshot
  band('S1', 'Gold Ring', [mag(H, 40, 49)]),                                    // wrong affix → not in snapshot
  band('P1', 'Short Bow', [mag(H, 40, 49)]),                                    // no bow family for life
  band(null, 'Gold Ring', [mag(H, 40, 49)]),                                    // untiered
] };
const r = spotCheck(capture, stats, bases);
const kinds = (k) => r.notes.filter((n) => n.kind === k).length;

check('parseTier reads P/S and rank', parseTier('S10').affix === 'suffix' && parseTier('S10').rank === 10);
check('parseTier rejects junk', parseTier('X1') === null && parseTier(null) === null);
check('three bands agree', r.agree.length === 3);
check('ring band agrees with the ring family', r.agree.some((a) => a.family === 'Ring' && a.tier === 1));
check('inverted reversed band agrees', r.agree.some((a) => a.display.includes('Charges')));
check('two bands disagree', r.disagree.length === 2);
check('body armour is checked against its own family', r.disagree.some((d) => d.family === 'Body Armour'));
check('nearest tier and distance are reported', r.disagree.some((d) => d.nearest && d.nearest.off === 2));
check('hybrid is noted, not judged', kinds('hybrid') === 1);
check('unknown stat and wrong affix are noted', kinds('no-stat') === 2);
check('missing family for the type is noted', kinds('no-family') === 1);
check('untiered is noted', kinds('untiered') === 1);

const anyFamily = spotCheck({ bands: [band('P1', 'Mystery Base', [mag(H, 150, 174)])] }, stats, new Map());
check('unknown base searches every family', anyFamily.agree.length === 1);

const map = baseTypeMap({ a: { name: 'Gold Ring', item_class: 'Ring' }, b: { name: 'Whetstone', item_class: 'StackableCurrency' } });
check('baseTypeMap maps RePoE classes to tokens', map.get('Gold Ring') === 'ring' && !map.has('Whetstone'));

const text = report({ _league: 'Fate%20of%20the%20Vaal', listings: 4, bands: capture.bands }, r);
check('report decodes the league', text.includes('Fate of the Vaal'));
check('report lists disagreements', text.includes('2 band(s) disagree'));

// Run the snippet against a stubbed page and feed it one /fetch response.
let saved = null;
// Current shape (one line per stat, hybrids split across lines) and the older extended.mods shape.
const line = (hash, mods) => ({ description: 'x', domain: 'explicit', hash: `stat.${hash}`, mods });
const response = { result: [
  { item: { baseType: 'Gold Ring', explicitMods: [
    line(H, [{ name: 'Hale', tier: 'P1', level: 60, magnitudes: [{ min: '40', max: '49' }] }]),
    line('explicit.stat_7', [{ name: 'Mixed', tier: 'S2', level: 30, magnitudes: [{ min: '5', max: '9' }] }]),
    line('explicit.stat_8', [{ name: 'Mixed', tier: 'S2', level: 30, magnitudes: [{ min: '1', max: '2' }] }]),
  ] } },
  { item: { baseType: 'Gold Ring', extended: { mods: { explicit: [
    { name: 'Hale', tier: 'P1', level: 60, magnitudes: [{ hash: H, min: '40', max: '49' }] },
  ] } } } },
  { item: { baseType: 'Gold Ring', explicitMods: ['+5 to Strength'] } },
] };
const win = {
  fetch: async () => ({ clone: () => ({ json: async () => response }) }),
};
const doc = { createElement: () => ({ click() { saved = this.href; } }) };
class XHR { open() {} }
const urlApi = { createObjectURL: (blob) => blob };
class FakeBlob { constructor(parts) { this.text = parts.join(''); } }
const quiet = { log() {} };
new Function('window', 'document', 'XMLHttpRequest', 'URL', 'Blob', 'location', 'console', SNIPPET)(
  win, doc, XHR, urlApi, FakeBlob, { pathname: '/trade2/search/poe2/Standard/abc' }, quiet);
await win.fetch('/api/trade2/fetch/1,2?query=abc');
await new Promise((res) => setTimeout(res, 0));
check('snippet installs tierfillSpot', win.tierfillSpot && win.tierfillSpot.count() === 2);
win.tierfillSpot.save();
const out = saved && JSON.parse(saved.text);
const hale = out && out.bands.find((b) => b.name === 'Hale');
const mixed = out && out.bands.find((b) => b.name === 'Mixed');
check('snippet saves deduped numeric bands with the line hash', hale && hale.magnitudes[0].min === 40 && hale.magnitudes[0].hash === H);
check('snippet merges a hybrid split across lines', mixed && mixed.magnitudes.length === 2 && mixed.magnitudes[1].hash === 'explicit.stat_8');
check('snippet counts listings with tiered mods only', out && out.listings === 2);
check('snippet saves the league', out && out._league === 'Standard');

if (fail) { console.log(`\n✖ ${fail} spot-check test(s) failed (${pass} passed)`); process.exit(1); }
console.log(`✅ all spot-check tests passed (${pass} passed)`);
