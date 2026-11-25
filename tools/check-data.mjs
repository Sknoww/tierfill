/*
 * check-data — hard gates and the patch-diff report for a freshly built snapshot.
 *
 *   node tools/check-data.mjs               # new snapshot vs the committed one (git HEAD)
 *   node tools/check-data.mjs --prev <file> # vs another snapshot file
 *
 * Runs after every build (tools/refresh.mjs calls it). Exit 1 if any hard gate fails.
 * Always writes tools/data-sources/patch-diff.md for a person to read before release.
 *
 * Every data bug TierFill has shipped was a source or classification error that nothing
 * compared against the previous build or against GGG's own lists. The gates catch the
 * structural ones outright; the report surfaces the value changes a person must judge.
 *
 * Hard gates:
 *   1. Every PoE2DB page in item-classes.json was scraped with at least MIN_ROWS rows.
 *   2. Every GGG weapon / armour / accessory / flask / jewel category maps to a class in
 *      item-classes.json or is listed in its `ignored`.
 *   3. Every item type in the snapshot is a class in item-classes.json.
 *   4. No trade stat id that the previous snapshot used is lost while GGG still lists it.
 *   5. No item type that the previous snapshot covered disappears entirely.
 *
 * Report items (patch-diff.md):
 *   • stats and families added or removed, and item types that moved between families
 *   • ladders whose tier count changed or whose T1 floor moved by more than 15%
 *   • ladders whose values don't improve with every tier (minus known cases)
 *   • new stats without a GGG trade id, and GGG explicit stats added since the last capture
 *   • T1 of the four added-damage prefixes per weapon class
 */
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { CLASSES, IGNORED } from './item-classes.mjs';
import { MIN_ROWS, previousRowCounts } from './scrape-poe2db.mjs';
import { categoryOptions } from './capture-ggg.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const SRC = join(here, 'data-sources');
const REPORT = join(SRC, 'patch-diff.md');

// A T1 floor moving by more than this share is flagged for review.
export const T1_SHIFT = 0.15;
// GGG category groups TierFill covers. Anything else (gems, maps, currency…) is out of scope.
const IN_SCOPE = /^(weapon|armour|accessory|flask)\.|^jewel$/;
// Ladders known not to improve with every tier, as "display [token]". Each needs an issue.
export const KNOWN_ORDER_EXCEPTIONS = new Set([
  '#% increased Spell Damage [amulet]', // two real ladders mixed into one (#12)
  '#% increased Exposure Effect [ring]', // two real ladders mixed into one (#12)
]);
export const ADDED_DAMAGE = ['Physical', 'Fire', 'Cold', 'Lightning'].map((e) => `Adds # to # ${e} Damage`);

// Same join key as build-data.mjs: lowercase, no "+", one dash style, collapsed spaces.
const normJoin = (t) => (t || '').toLowerCase().replace(/\+/g, '').replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();

// ── ladder helpers ─────────────────────────────────────────────────────────────
// A tier's comparable floor: the trade MIN for averaged mods, else the low roll.
export const floorOf = (t) => (t.ranges.length > 1 ? (t.ranges[0][0] + t.ranges[1][0]) / 2 : t.ranges[0][0]);
const fmtRanges = (t) => (t ? t.ranges.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join(' to ') : '—');
const famName = (types) => (types.length > 4 ? `${types.slice(0, 4).join(', ')} +${types.length - 4}` : types.join(', '));

// Does every tier beat the one below it? (T1 best. Inverted stats: lower is better.)
export function ladderImproves(entry) {
  const f = entry.tiers.map(floorOf);
  for (let i = 1; i < f.length; i++) {
    const better = entry.inverted ? f[i - 1] < f[i] : f[i - 1] > f[i];
    if (!better) return false;
  }
  return true;
}

// display → type → entry (each type sits in exactly one family per display).
export function byDisplayType(snap) {
  const map = new Map();
  for (const e of Object.values(snap.stats || {})) {
    if (!map.has(e.display)) map.set(e.display, new Map());
    for (const t of e.types || []) map.get(e.display).set(t, e);
  }
  return map;
}

const tokensOf = (snap) => new Set(Object.values(snap.stats || {}).flatMap((e) => e.types || []));
const idsOf = (snap) => new Set(Object.values(snap.stats || {}).map((e) => e.tradeStatId).filter(Boolean));
const explicitIds = (stats) =>
  new Map(((stats && stats.result) || []).filter((g) => g.id === 'explicit').flatMap((g) => g.entries).map((e) => [e.id, e.text]));

// ── gates ──────────────────────────────────────────────────────────────────────
export function runGates({ snap, prev, classes = CLASSES, ignored = IGNORED, scrape, filters, gggStats }) {
  const errors = [];
  const known = new Set(classes.map((c) => c.token));

  // 1. pages scraped
  if (!scrape) errors.push('No PoE2DB scrape found (tools/data-sources/poe2db-mods.json). Run node tools/refresh.mjs.');
  else {
    const rows = previousRowCounts(scrape);
    for (const c of classes) {
      for (const slug of c.pages) {
        const n = rows.get(slug);
        if (n == null) errors.push(`PoE2DB page ${slug} (${c.token}) is in item-classes.json but not in the scrape. Re-run node tools/refresh.mjs.`);
        else if (n < MIN_ROWS) errors.push(`PoE2DB page ${slug} (${c.token}) has only ${n} rows.`);
      }
    }
  }

  // 2. every in-scope GGG category is mapped or ignored
  if (!filters) {
    errors.push('No GGG category list (tools/data-sources/ggg-trade2-filters.json). Run node tools/capture-ggg.mjs.');
  } else {
    const mapped = new Set(classes.map((c) => c.category));
    for (const o of categoryOptions(filters)) {
      if (!o.id || !IN_SCOPE.test(o.id) || mapped.has(o.id) || o.id in ignored) continue;
      if (/^Any /.test(o.text)) continue; // group headers ("Any Two-Handed Melee Weapon")
      errors.push(
        `GGG trade category ${o.id} ("${o.text}") has no class. Add it to tools/item-classes.json, e.g.\n` +
          `      { "token": "${o.text.toLowerCase().replace(/[^a-z]+/g, '-')}", "category": "${o.id}", "text": "${o.text}", "kind": "…", "pages": ["<PoE2DB slug>"] }\n` +
          `    or list it under "ignored" with the reason.`,
      );
    }
  }

  // 3. every snapshot token is a known class
  for (const t of tokensOf(snap)) if (!known.has(t)) errors.push(`Snapshot item type "${t}" is not a class in tools/item-classes.json.`);

  if (prev) {
    // 4. lost trade ids. A stat the scrape still carries must keep its id; one the scrape
    //    dropped is a removal (listed in the report), since GGG keeps old ids for legacy items.
    const now = idsOf(snap);
    const ggg = explicitIds(gggStats);
    const scraped = new Set(['prefix', 'suffix'].flatMap((b) => Object.keys((scrape && scrape[b]) || {})).map(normJoin));
    for (const id of idsOf(prev)) {
      if (now.has(id) || (gggStats && !ggg.has(id))) continue;
      const was = Object.values(prev.stats).find((e) => e.tradeStatId === id);
      if (scraped.has(normJoin(was.display)) || Object.values(snap.stats).some((e) => e.display === was.display)) {
        errors.push(`Trade stat ${id} ("${was.display}") is still scraped but lost its trade id. Check the GGG join or ALIAS in build-data.mjs.`);
      }
    }
    // 5. vanished item types
    const nowTokens = tokensOf(snap);
    for (const t of tokensOf(prev)) if (!nowTokens.has(t)) errors.push(`Item type "${t}" had tier data before and has none now.`);
  }
  return errors;
}

// ── report ─────────────────────────────────────────────────────────────────────
export function buildReport({ snap, prev, gggStats, gggPrev, classes = CLASSES }) {
  const r = { addedStats: [], removedStats: [], moved: [], ladders: [], order: [], unjoined: [], gggAdded: [], weaponT1: [] };
  const now = byDisplayType(snap);
  const before = prev ? byDisplayType(prev) : new Map();

  for (const d of [...now.keys()].sort()) if (prev && !before.has(d)) r.addedStats.push(d);
  for (const d of [...before.keys()].sort()) if (!now.has(d)) r.removedStats.push(d);

  // per display: compare each item type's family and ladder
  for (const [d, types] of now) {
    const old = before.get(d);
    if (!old) continue;
    const gained = [], lost = [], regrouped = new Set(), seen = new Set();
    for (const [t, e] of types) {
      const o = old.get(t);
      if (!o) { gained.push(t); continue; }
      const famNow = e.types.join(','), famOld = o.types.join(',');
      if (famNow !== famOld) regrouped.add(`[${famName(o.types)}] → [${famName(e.types)}]`);
      const k = `${famOld}|${famNow}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const notes = [];
      if (o.tiers.length !== e.tiers.length) notes.push(`${o.tiers.length} → ${e.tiers.length} tiers`);
      const f0 = floorOf(o.tiers[0]), f1 = floorOf(e.tiers[0]);
      if (f0 !== 0 && Math.abs(f1 - f0) / Math.abs(f0) > T1_SHIFT) notes.push(`T1 floor ${f0} → ${f1}`);
      if (notes.length) r.ladders.push(`${d} [${famName(e.types)}]: ${notes.join('; ')}`);
    }
    for (const t of old.keys()) if (!types.has(t)) lost.push(t);
    const parts = [];
    if (gained.length) parts.push(`now also on ${gained.join(', ')}`);
    if (lost.length) parts.push(`no longer on ${lost.join(', ')}`);
    if (regrouped.size) parts.push(`families ${[...regrouped].join('; ')}`);
    if (parts.length) r.moved.push(`${d}: ${parts.join('. ')}`);
  }

  for (const e of Object.values(snap.stats)) {
    if (ladderImproves(e)) continue;
    const allowed = e.types.some((t) => KNOWN_ORDER_EXCEPTIONS.has(`${e.display} [${t}]`));
    r.order.push(`${e.display} [${famName(e.types)}]: ${e.tiers.map(floorOf).join(', ')}${allowed ? ' (known, see #12)' : ''}`);
  }

  const unjoinedBefore = new Set(Object.values((prev && prev.stats) || {}).filter((e) => !e.tradeStatId).map((e) => e.display));
  for (const e of Object.values(snap.stats)) {
    if (!e.tradeStatId && !unjoinedBefore.has(e.display)) r.unjoined.push(`${e.display} [${famName(e.types)}]`);
  }
  r.unjoined = [...new Set(r.unjoined)].sort();

  if (gggStats && gggPrev) {
    const old = explicitIds(gggPrev);
    const used = idsOf(snap);
    for (const [id, text] of explicitIds(gggStats)) {
      if (!old.has(id)) r.gggAdded.push(`${text} (${id})${used.has(id) ? ' — has a tier control' : ''}`);
    }
  }

  for (const c of classes.filter((x) => x.kind === 'weapon')) {
    const row = [c.token];
    for (const d of ADDED_DAMAGE) {
      const e = now.get(d)?.get(c.token);
      const o = before.get(d)?.get(c.token);
      const a = fmtRanges(o?.tiers[0]), b = fmtRanges(e?.tiers[0]);
      row.push(prev && a !== b ? `${a} → **${b}**` : b);
    }
    r.weaponT1.push(row);
  }
  return r;
}

export function renderMarkdown({ errors, report: r, prevLabel }) {
  const out = [];
  const list = (title, items, empty) => {
    out.push(`## ${title} (${items.length})`, '');
    if (!items.length) out.push(empty, '');
    else out.push(...items.map((i) => `- ${i}`), '');
  };
  out.push('# TierFill patch diff', '', `Compared against: ${prevLabel}.`, '');
  out.push(
    'For each flagged ladder, decide: expected (patch notes), source error (fix or hold the stat back), or our bug.',
    '',
  );
  list('Hard gate failures', errors, 'None. All gates passed.');
  list('Stats added', r.addedStats, 'None.');
  list('Stats removed', r.removedStats, 'None.');
  list('Stats whose item types or families changed', r.moved, 'None.');
  list(`Ladders whose tier count changed or whose T1 floor moved more than ${T1_SHIFT * 100}%`, r.ladders, 'None.');
  list("Ladders that don't improve with every tier", r.order, 'None.');
  list('New stats without a GGG trade id (no tier control)', r.unjoined, 'None.');
  list('GGG explicit stats added since the last capture', r.gggAdded, 'None, or no previous capture to compare.');
  out.push('## T1 of the added-damage prefixes per weapon class', '');
  out.push(`| Weapon | ${ADDED_DAMAGE.map((d) => d.replace('Adds # to # ', '').replace(' Damage', '')).join(' | ')} |`);
  out.push(`| --- | ${ADDED_DAMAGE.map(() => '---').join(' | ')} |`);
  for (const row of r.weaponT1) out.push(`| ${row.join(' | ')} |`);
  out.push('');
  return out.join('\n');
}

// ── main ───────────────────────────────────────────────────────────────────────
const readJson = async (p) => {
  try {
    return JSON.parse(await readFile(p, 'utf8'));
  } catch {
    return null;
  }
};

async function main() {
  const prevIdx = process.argv.indexOf('--prev');
  let prev = null, prevLabel;
  if (prevIdx !== -1) {
    prev = await readJson(resolve(process.argv[prevIdx + 1]));
    prevLabel = process.argv[prevIdx + 1];
    if (!prev) throw new Error(`can't read --prev ${prevLabel}`);
  } else {
    try {
      prev = JSON.parse(execFileSync('git', ['show', 'HEAD:assets/data-snapshot.json'], { cwd: root, encoding: 'utf8', maxBuffer: 64e6 }));
      prevLabel = 'the committed snapshot (git HEAD)';
    } catch {
      prevLabel = 'nothing (no committed snapshot found)';
    }
  }
  const snap = JSON.parse(await readFile(join(root, 'assets', 'data-snapshot.json'), 'utf8'));
  const inputs = {
    snap,
    prev,
    scrape: await readJson(join(SRC, 'poe2db-mods.json')),
    filters: await readJson(join(SRC, 'ggg-trade2-filters.json')),
    gggStats: await readJson(join(SRC, 'ggg-trade2-stats.json')),
    gggPrev: await readJson(join(SRC, 'ggg-trade2-stats.prev.json')),
  };
  const errors = runGates(inputs);
  const report = buildReport(inputs);
  await writeFile(REPORT, renderMarkdown({ errors, report, prevLabel }));

  console.log('check-data');
  console.log('─'.repeat(60));
  const n = (k) => report[k].length;
  console.log(`stats added / removed:        ${n('addedStats')} / ${n('removedStats')}`);
  console.log(`stats with type/family moves: ${n('moved')}`);
  console.log(`ladders changed (count/T1):   ${n('ladders')}`);
  console.log(`ladders out of order:         ${n('order')}`);
  console.log(`new stats without a trade id: ${n('unjoined')}`);
  console.log(`GGG explicit stats added:     ${n('gggAdded')}`);
  console.log(`report: ${REPORT}`);
  if (errors.length) {
    console.error(`\n✖ ${errors.length} hard gate failure(s):`);
    for (const e of errors) console.error(`  ✖ ${e}`);
    process.exitCode = 1;
  } else {
    console.log('\n✓ all hard gates passed');
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((e) => {
    console.error('✖ check-data failed:', e.message);
    process.exitCode = 1;
  });
}
