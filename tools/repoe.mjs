/*
 * repoe — the second data source: tier ladders built from the RePoE game-file export,
 * cross-checked against the PoE2DB scrape (issue #18).
 *
 *   node tools/repoe.mjs           # download the RePoE files into tools/data-sources/repoe/
 *
 * RePoE (https://repoe-fork.github.io/poe2/) reads the game's Mods and BaseItemTypes
 * tables directly, so it disagrees with PoE2DB only when one of them is wrong or behind.
 * tools/check-data.mjs calls crossCheck() and writes the result into patch-diff.md. It is
 * a report for a person, not a gate, except when a whole item class has mods on one side
 * and none on the other.
 *
 * How a RePoE ladder is built, to match what scrape-poe2db.mjs keeps:
 *   • Mods with generation_type prefix/suffix, not essence-only, on the item, desecrated
 *     (Abyss), flask or misc (jewel) domain.
 *   • Item class: a mod can roll on a base when the FIRST spawn_weights tag the base
 *     carries has weight > 0 (the game's rule). A class token (tools/item-classes.json,
 *     `repoe`) gets the mod if any released, for-sale base of its item_class(es) can roll it. The
 *     weights in the export are 0/1 eligibility; real weights aren't in the client.
 *   • Text: "[Link|Shown]" markup becomes "Shown", each number or "(lo-hi)" roll becomes
 *     "#", then the same key as the scrape (no "+", lowercase). Mods with two rolled lines
 *     are hybrids and skipped, as the scraper parks them.
 *
 * RePoE has lagged 10–22h behind past launches (4h cron), so on launch day it may be a
 * patch behind; the report says when the files were fetched.
 */
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { CLASSES } from './item-classes.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const REPOE_DIR = join(here, 'data-sources', 'repoe');
export const REPOE_BASE = 'https://repoe-fork.github.io/poe2/';
// mods.json ≈ 14 MB, base_items.json ≈ 8 MB.
export const REPOE_FILES = ['mods.json', 'base_items.json'];
// Mod domain → the base domains it rolls on. Desecrated (Abyss) mods are on PoE2DB's class
// pages too, for equipment and jewels; their lord tag (kurgal_mod…) comes from the
// desecration, not the base.
const DOMAINS = { item: ['item'], desecrated: ['item', 'misc'], flask: ['flask'], misc: ['misc'] };
// RePoE wording → PoE2DB wording, where the two render the same stat differently.
const TEXT_ALIAS = { 'grenade skills have # cooldown use': 'grenade skills have # cooldown uses' };

// Same key as scrape-poe2db.mjs bucketKey + check-data normJoin.
export const keyOf = (t) => (t || '').replace(/\+/g, '').toLowerCase().replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();

// One rendered clause → { text with #, values [[lo, hi]…] }. A "(lo-hi)" range is always
// a roll; a bare integer is a roll only when it is one of the mod's stat values, so fixed
// wording ("per 100 maximum Life", "at least 10 Combo") stays text, as on PoE2DB. Numbers
// glued to a letter ("6m") are wording too. Pairs are low-high ("reduced" stats render
// as "(60-56)").
const ROLL = /\((-?\d+(?:\.\d+)?)-(-?\d+(?:\.\d+)?)\)|(?<![\w.])(-?\d+(?:\.\d+)?)(?![\w.])/g;
export function parseClause(line, statValues = null) {
  const values = [];
  let text = line.replace(/\[([^\]|]*)\|([^\]]*)\]/g, '$2').replace(/\[([^\]]*)\]/g, '$1');
  text = text.replace(ROLL, (m, lo, hi, one) => {
    if (one != null) {
      // decimals are scaled rolls ("0.15 Charges per Second" from a per-minute stat of 9)
      if (statValues && Number.isInteger(Number(one)) && !statValues.has(Math.abs(Number(one)))) return m;
      values.push([Number(one), Number(one)]);
    } else {
      values.push([Math.min(lo, hi), Math.max(lo, hi)]);
    }
    return '#';
  });
  // Bottom rung written as a word ("fire an additional Arrow"), as the scraper rewrites it.
  if (!values.length && /\b(an|a)\s+additional\s+[A-Za-z]+\b/i.test(text)) {
    values.push([1, 1]);
    text = text.replace(/\b(an|a)\s+additional\s+([A-Za-z]+)\b/i, (_x, _a, noun) => `# additional ${/s$/i.test(noun) ? noun : noun + 's'}`);
  }
  return { text: text.replace(/\s+/g, ' ').trim(), values };
}

// Rendered mod text (+ its stats) → { key, values } or null (no roll, or a hybrid).
export function parseMod(text, stats = null) {
  const statValues = stats ? new Set(stats.flatMap((st) => [Math.abs(st.min), Math.abs(st.max)])) : null;
  const clauses = String(text || '').split('\n').map((l) => parseClause(l, statValues)).filter((c) => c.text);
  const rolled = clauses.filter((c) => c.values.length);
  if (rolled.length !== 1) return null;
  const key = keyOf(rolled[0].text);
  return { key: TEXT_ALIAS[key] || key, values: rolled[0].values };
}

// Does the game allow this mod on a base with these tags?
export function spawnsOn(mod, tags) {
  for (const w of mod.spawn_weights || []) if (tags.has(w.tag)) return w.weight > 0;
  return false;
}

// { prefix|suffix: { key: [{ level, values, types, id }] }, mechanic: { "bucket|key": [tags] } }.
// The buckets are in the scrape's shape. `mechanic` lists, per stat, the spawn tags that no
// covered base carries (genesis_tree_caster…): a crafting mechanic adds them, so RePoE can't
// say which item classes those tiers roll on.
export function buildLadders({ mods, baseItems, classes = CLASSES }) {
  // distinct tag sets per class token (bases mostly share tags, so this stays small)
  const tagSets = new Map(classes.map((c) => [c.token, new Map()]));
  const byClass = new Map(classes.flatMap((c) => (c.repoe || []).map((ic) => [ic, c.token])));
  const baseTags = new Set(); // every tag a base of a covered class carries
  for (const b of Object.values(baseItems)) {
    const token = byClass.get(b.item_class);
    if (!token) continue;
    for (const t of b.tags) baseTags.add(t);
    // not_for_sale drops unique-only bases and the Time-Lost/Diamond jewels, whose radius
    // mods are different trade stats than the Emerald/Ruby/Sapphire pages PoE2DB lists.
    if (b.release_state !== 'released' || b.tags.includes('not_for_sale')) continue;
    tagSets.get(token).set([...b.tags].sort().join(','), { domain: b.domain, tags: new Set(b.tags) });
  }
  const out = { prefix: {}, suffix: {}, mechanic: {} };
  for (const [id, m] of Object.entries(mods)) {
    if (!['prefix', 'suffix'].includes(m.generation_type) || m.is_essence_only || !(m.domain in DOMAINS)) continue;
    const parsed = parseMod(m.text, m.stats);
    if (!parsed) continue;
    const k = `${m.generation_type}|${parsed.key}`;
    for (const w of m.spawn_weights || []) {
      if (w.weight > 0 && !baseTags.has(w.tag) && !/_mod$/.test(w.tag)) (out.mechanic[k] ??= new Set()).add(w.tag);
    }
    const types = classes
      .filter((c) => [...tagSets.get(c.token).values()].some((b) => DOMAINS[m.domain].includes(b.domain) && spawnsOn(m, b.tags)))
      .map((c) => c.token);
    if (!types.length) continue;
    (out[m.generation_type][parsed.key] ??= []).push({ id, level: m.required_level, values: parsed.values, types });
  }
  for (const k of Object.keys(out.mechanic)) out.mechanic[k] = [...out.mechanic[k]].sort();
  return out;
}

// bucket → key → token → [{ level, values }] sorted best (highest level) first.
function index(data) {
  const idx = new Map();
  for (const bucket of ['prefix', 'suffix']) {
    for (const [key, rows] of Object.entries((data && data[bucket]) || {})) {
      for (const r of rows) {
        const row = { level: Number(r.level), values: r.values.map((p) => p.map(Number)) };
        for (const t of r.types || []) {
          const k = `${bucket}|${key}`;
          if (!idx.has(k)) idx.set(k, new Map());
          const m = idx.get(k);
          if (!m.has(t)) m.set(t, []);
          m.get(t).push(row);
        }
      }
    }
  }
  for (const m of idx.values()) for (const rows of m.values()) rows.sort((a, b) => b.level - a.level);
  return idx;
}

const fmtVals = (v) => v.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join(' to ');
const sameVals = (a, b) => a.length === b.length && a.every((p, i) => p[0] === b[i][0] && p[1] === b[i][1]);

// Compare one ladder (same stat, same item class). Tiers pair up by required level.
export function ladderDiff(p, r) {
  const notes = [];
  const rBy = new Map(r.map((x) => [x.level, x]));
  const pBy = new Map(p.map((x) => [x.level, x]));
  const onlyP = p.filter((x) => !rBy.has(x.level)).map((x) => x.level);
  const onlyR = r.filter((x) => !pBy.has(x.level)).map((x) => x.level);
  if (!onlyP.length && !onlyR.length && p.length !== r.length) notes.push(`${p.length} tiers on PoE2DB, ${r.length} on RePoE`);
  if (onlyP.length || onlyR.length) {
    notes.push(`levels ${onlyP.length ? `only on PoE2DB: ${onlyP.join(', ')}` : ''}${onlyP.length && onlyR.length ? '; ' : ''}${onlyR.length ? `only on RePoE: ${onlyR.join(', ')}` : ''}`);
  }
  for (const x of p) {
    const y = rBy.get(x.level);
    if (y && !sameVals(x.values, y.values)) notes.push(`level ${x.level}: ${fmtVals(x.values)} vs ${fmtVals(y.values)}`);
  }
  return notes;
}

// The cross-check. Returns { gate, classes, ladders, onlyPoe2db, onlyRepoe, explained }:
// lists of display lines, grouped so one line covers the item classes that share an
// identical difference. `explained` holds what PoE2DB has beyond RePoE where RePoE rolls
// that stat through a mechanic tag (see buildLadders), so the two can't be compared.
export function crossCheck({ scrape, repoe, classes = CLASSES }) {
  const P = index(scrape), R = index(repoe);
  const mechanic = (repoe && repoe.mechanic) || {};
  const out = { gate: [], classes: [], ladders: [], onlyPoe2db: [], onlyRepoe: [], explained: [] };
  const order = new Map(classes.map((c, i) => [c.token, i]));
  const sortT = (ts) => [...ts].sort((a, b) => order.get(a) - order.get(b));
  const label = (k) => {
    const [bucket, key] = k.split('|');
    return `${key} (${bucket})`;
  };

  // whole class missing on one side
  const tokens = (idx) => new Set([...idx.values()].flatMap((m) => [...m.keys()]));
  const pT = tokens(P), rT = tokens(R);
  for (const c of classes) {
    if (pT.has(c.token) && !rT.has(c.token)) out.gate.push(`Item class "${c.token}" has mods on PoE2DB but none in RePoE. Check its "repoe" item_class in tools/item-classes.json.`);
    if (!pT.has(c.token) && rT.has(c.token)) out.gate.push(`Item class "${c.token}" has mods in RePoE but none on PoE2DB.`);
  }

  for (const k of [...new Set([...P.keys(), ...R.keys()])].sort()) {
    const p = P.get(k), r = R.get(k);
    const mech = mechanic[k] ? ` (RePoE rolls it via ${mechanic[k].join(', ')})` : '';
    if (!r) { (mech ? out.explained : out.onlyPoe2db).push(`${label(k)} [${sortT(p.keys()).join(', ')}]${mech}`); continue; }
    if (!p) { out.onlyRepoe.push(`${label(k)} [${sortT(r.keys()).join(', ')}]`); continue; }
    const onlyP = sortT([...p.keys()].filter((t) => !r.has(t)));
    const onlyR = sortT([...r.keys()].filter((t) => !p.has(t)));
    if (onlyP.length) (mech ? out.explained : out.classes).push(`${label(k)}: only PoE2DB has it on ${onlyP.join(', ')}${mech}`);
    if (onlyR.length) out.classes.push(`${label(k)}: only RePoE has it on ${onlyR.join(', ')}`);
    const groups = new Map(), extra = new Map();
    for (const [t, rows] of p) {
      if (!r.has(t)) continue;
      let mine = rows;
      if (mech) {
        // PoE2DB tiers at levels RePoE doesn't place on this class are the mechanic's.
        const lv = new Set(r.get(t).map((x) => x.level));
        mine = rows.filter((x) => lv.has(x.level));
        const gone = rows.filter((x) => !lv.has(x.level)).map((x) => x.level);
        if (gone.length) {
          const g = gone.join(', ');
          if (!extra.has(g)) extra.set(g, []);
          extra.get(g).push(t);
        }
      }
      const notes = ladderDiff(mine, r.get(t));
      if (!notes.length) continue;
      const g = notes.join('; ');
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(t);
    }
    for (const [g, ts] of groups) out.ladders.push(`${label(k)} [${sortT(ts).join(', ')}]: ${g}`);
    for (const [g, ts] of extra) out.explained.push(`${label(k)} [${sortT(ts).join(', ')}]: PoE2DB tiers at level ${g}${mech}`);
  }
  return out;
}

// ── download ───────────────────────────────────────────────────────────────────
export async function fetchRepoe({ dir = REPOE_DIR, log = console.log } = {}) {
  await mkdir(dir, { recursive: true });
  for (const f of REPOE_FILES) {
    const res = await fetch(REPOE_BASE + f);
    if (!res.ok) throw new Error(`${REPOE_BASE}${f}: HTTP ${res.status}`);
    const body = await res.text();
    JSON.parse(body); // refuse to save a truncated or HTML error page
    await writeFile(join(dir, f), body);
    log(`  ${f}: ${(body.length / 1e6).toFixed(1)} MB (RePoE last modified ${res.headers.get('last-modified') || 'unknown'})`);
  }
}

// When the local copy was fetched, for the report.
export async function fetchedAt(dir = REPOE_DIR) {
  try {
    return (await stat(join(dir, 'mods.json'))).mtime.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  } catch {
    return null;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  console.log(`downloading RePoE into ${REPOE_DIR}…`);
  fetchRepoe().catch((e) => {
    console.error('✖ RePoE download failed:', e.message);
    process.exitCode = 1;
  });
}
