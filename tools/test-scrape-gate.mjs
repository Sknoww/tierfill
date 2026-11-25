/*
 * Scrape-gate tests — the fail-fast rules in scrape-poe2db.mjs (issue #1).
 * Run: node tools/test-scrape-gate.mjs
 */
import { pageGate, previousRowCounts, MIN_ROWS } from './scrape-poe2db.mjs';

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) pass++; else { fail++; console.log(`✖ ${name}`); } };

const prev = previousRowCounts({ _pages: ['Bows→bow (143)', 'Body_Armours_str→body-armour (142)', 'junk line'] });
check('parses previous counts', prev.get('Bows') === 143 && prev.get('Body_Armours_str') === 142 && prev.size === 2);
check('no previous file → empty map', previousRowCounts(null).size === 0);

let g = pageGate([{ slug: 'Bows', rows: 140 }], [], prev);
check('healthy page passes', g.errors.length === 0 && g.warnings.length === 0);

g = pageGate([], ['Talismans: GET … → HTTP 404'], prev);
check('fetch failure is an error', g.errors.length === 1 && /404/.test(g.errors[0]));

g = pageGate([{ slug: 'Bows', rows: 0 }], [], prev);
check('empty page is an error', g.errors.length === 1);

g = pageGate([{ slug: 'Talismans', rows: MIN_ROWS - 1 }], [], prev);
check('new page under MIN_ROWS is an error', g.errors.length === 1);

g = pageGate([{ slug: 'Talismans', rows: 400 }], [], prev);
check('new page with no history passes', g.errors.length === 0);

g = pageGate([{ slug: 'Bows', rows: 60 }], [], prev);
check('row count halved is an error', g.errors.length === 1 && /down from 143/.test(g.errors[0]));

g = pageGate([{ slug: 'Bows', rows: 60 }], [], prev, { allowDrop: true });
check('--allow-drop turns a halved page into a warning', g.errors.length === 0 && g.warnings.length === 1);

g = pageGate([{ slug: 'Bows', rows: 5 }], ['Rings: timeout'], prev, { allowDrop: true });
check('--allow-drop never excuses near-empty or failed pages', g.errors.length === 2);

if (fail) { console.log(`\n✖ ${fail} scrape-gate test(s) failed (${pass} passed)`); process.exit(1); }
console.log(`✅ all scrape-gate tests passed (${pass} passed)`);
