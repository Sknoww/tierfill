/*
 * capture-ggg tests — shape checks on the three GGG lists (issue #4).
 * Run: node tools/test-capture.mjs
 */
import { checkList, categoryOptions, SNIPPET } from './capture-ggg.mjs';

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) pass++; else { fail++; console.log(`✖ ${name}`); } };
const throws = (fn) => { try { fn(); return false; } catch { return true; } };

const stats = { result: [{ id: 'pseudo', entries: [{}] }, { id: 'explicit', entries: [{ id: 'a' }, { id: 'b' }] }] };
const filters = { result: [{ id: 'type_filters', filters: [{ id: 'category', option: { options: [{ id: 'weapon.bow', text: 'Bow' }] } }] }] };
const items = { result: [{ id: 'weapons', entries: [{ type: 'Short Bow' }] }] };

check('stats summary counts explicit', checkList('stats', stats) === '2 explicit stats');
check('filters summary counts categories', checkList('filters', filters) === '1 trade categories');
check('items summary counts entries', checkList('items', items) === '1 base items');
check('categoryOptions reads category options', categoryOptions(filters)[0].id === 'weapon.bow');
check('categoryOptions tolerates junk', categoryOptions(null).length === 0);
check('stats without explicit throws', throws(() => checkList('stats', { result: [{ id: 'pseudo', entries: [] }] })));
check('a Cloudflare HTML page throws', throws(() => checkList('stats', '<html>Just a moment…</html>')));
check('filters without categories throws', throws(() => checkList('filters', { result: [{ id: 'status_filters' }] })));
check('empty items throws', throws(() => checkList('items', { result: [{ id: 'x', entries: [] }] })));
check('snippet fetches all three lists', ['stats', 'items', 'filters'].every((n) => SNIPPET.includes(`"${n}"`)));
check('snippet is valid JavaScript', !throws(() => new Function(SNIPPET)));

if (fail) { console.log(`\n✖ ${fail} capture test(s) failed (${pass} passed)`); process.exit(1); }
console.log(`✅ all capture tests passed (${pass} passed)`);
