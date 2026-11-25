/*
 * spot-check — compare GGG's own tier bands, read off live trade listings, with the snapshot.
 *
 *   node tools/spot-check.mjs                 # print the browser snippet and these steps
 *   node tools/spot-check.mjs <file>          # check a saved tierfill-spot-capture.json
 *   node tools/spot-check.mjs --downloads     # same, using ~/Downloads/tierfill-spot-capture.json
 *   add --all to list every matched band, not only the disagreements
 *
 * Every trade listing carries GGG's tier and range for each explicit mod (`P2 [20—24 to
 * 33—36]`), the only first-party tier data. The trade page loads them from
 * /api/trade2/fetch/, so the snippet wraps fetch and XHR and keeps a copy of each response
 * the page already asked for. It sends no requests of its own and never runs a search:
 *   1. Open https://www.pathofexile.com/trade2 and paste the snippet into the devtools console.
 *   2. Search by hand for 10-20 high-value mods (the list it prints), clicking Search as usual.
 *      Scrolling loads more listings, and every one is recorded.
 *   3. Run `tierfillSpot.save()` in the console. It saves tierfill-spot-capture.json.
 *   4. Run this script on that file.
 *
 * GGG ranks tiers per base (a quiver's P1 can be our T2), so bands are matched by value, not
 * by rank: a band agrees when the snapshot family for that item type holds the exact same
 * ranges at some tier. The base's item type comes from RePoE's base_items.json
 * (tools/data-sources/repoe/, fetched by refresh.mjs); without it every family is searched.
 * Exit code 1 when any band disagrees.
 */
import { readFile } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { CLASSES } from './item-classes.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const FILE_NAME = 'tierfill-spot-capture.json';

// High-value mods to search, one per line of the printed checklist: an averaged added
// damage mod, flat and percent defences, resistances, Rarity, a jewel and a flask.
export const SUGGESTED = [
  'Adds # to # Physical Damage (one-hand weapon)',
  'Adds # to # Fire Damage (bow or two-hand weapon)',
  '#% increased Physical Damage (two-hand weapon)',
  '+# to maximum Life (body armour)',
  '+# to maximum Energy Shield (helmet)',
  '+#% to Fire Resistance (boots)',
  '+#% to all Elemental Resistances (amulet or ring)',
  '#% increased Rarity of Items found (gloves or ring)',
  '#% increased Movement Speed (boots)',
  '#% increased Attack Speed (gloves or one-hand weapon)',
  '#% increased Critical Hit Chance for Spells (focus or wand)',
  '+# to Level of all Spell Skills (wand or staff)',
  '#% increased maximum Life (amulet)',
  '#% increased Spell Damage (jewel)',
  '#% increased Charges gained (flask or charm)',
];

// Runs in the trade page. Wraps fetch and XHR, observing only; never changes a response.
export const SNIPPET = `(() => {
  if (window.tierfillSpot) return console.log('TierFill spot-check already running:', window.tierfillSpot.count(), 'bands');
  const RE = /\\/api\\/trade2\\/fetch\\//;
  const bands = new Map();
  let listings = 0;
  const GROUPS = ['explicit', 'fractured', 'desecrated'];
  // One item's tiered mods as [{ group, name, tier, level, magnitudes:[{hash,min,max}] }].
  // Current shape: item.explicitMods[] lines, each with its stat hash and the mods behind it,
  // so a hybrid mod appears under two lines and is merged back by name, tier and level.
  // Older shape (2026-06): item.extended.mods[group][] with a hash on each magnitude.
  const modsOf = (it) => {
    const out = new Map();
    for (const group of GROUPS) {
      for (const line of it[group + 'Mods'] || []) {
        if (!line || typeof line !== 'object') continue;
        const hash = String(line.hash || '').replace(/^stat\\./, '');
        for (const m of line.mods || []) {
          if (!m || !m.tier || !(m.magnitudes || []).length) continue;
          const key = [group, m.name, m.tier, m.level].join('|');
          if (!out.has(key)) out.set(key, { group, name: m.name, tier: m.tier, level: m.level, magnitudes: [] });
          out.get(key).magnitudes.push(...m.magnitudes.map((g) => ({ hash: g.hash || hash, min: g.min, max: g.max })));
        }
      }
      const old = it.extended && it.extended.mods && it.extended.mods[group];
      for (const m of old || []) {
        if (m && m.tier && (m.magnitudes || []).length) out.set(out.size + '|old', { group, name: m.name, tier: m.tier, level: m.level, magnitudes: m.magnitudes });
      }
    }
    return [...out.values()];
  };
  const record = (data) => {
    for (const r of (data && data.result) || []) {
      const it = r && r.item;
      if (!it) continue;
      const mods = modsOf(it);
      if (!mods.length) continue;
      listings++;
      for (const m of mods) {
        const magnitudes = m.magnitudes.map((g) => ({ hash: g.hash, min: Number(g.min), max: Number(g.max) }));
        const key = [it.baseType, m.tier, m.level, JSON.stringify(magnitudes)].join('|');
        if (!bands.has(key)) bands.set(key, { base: it.baseType, group: m.group, tier: m.tier, level: m.level, name: m.name, magnitudes });
      }
    }
    console.log('TierFill spot-check:', bands.size, 'bands from', listings, 'listings');
  };
  const origFetch = window.fetch;
  window.fetch = function (input) {
    const p = origFetch.apply(this, arguments);
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (RE.test(url)) p.then((res) => res.clone().json()).then(record).catch(() => {});
    } catch (_) {}
    return p;
  };
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try { if (RE.test(String(url))) this.addEventListener('load', function () { try { record(JSON.parse(this.responseText)); } catch (_) {} }); } catch (_) {}
    return open.apply(this, arguments);
  };
  window.tierfillSpot = {
    count: () => bands.size,
    save() {
      const league = decodeURIComponent((location.pathname.match(/\\/trade2\\/search\\/poe2\\/([^/]+)/) || [])[1] || '');
      const out = { _league: league, _captured: new Date().toISOString(), listings, bands: [...bands.values()] };
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(out)], { type: 'application/json' }));
      a.download = '${FILE_NAME}';
      a.click();
      console.log('TierFill: saved ${FILE_NAME} with', bands.size, 'bands');
    },
  };
  console.log('TierFill spot-check: recording. Search as usual, then run tierfillSpot.save()');
})();`;

// GGG tier "P2" / "S10" → { affix, rank }.
export function parseTier(s) {
  const m = /^([PS])(\d+)$/.exec(String(s || ''));
  return m ? { affix: m[1] === 'P' ? 'prefix' : 'suffix', rank: Number(m[2]) } : null;
}

const sameBand = (a, b) =>
  a.length === b.length && a.every((r, i) => r[0] === b[i][0] && r[1] === b[i][1]);
const flip = (band) => band.map(([lo, hi]) => [-hi, -lo]);
const distance = (a, b) =>
  a.length !== b.length ? Infinity : a.reduce((s, r, i) => s + Math.abs(r[0] - b[i][0]) + Math.abs(r[1] - b[i][1]), 0);
const fmt = (band) => band.map(([lo, hi]) => (lo === hi ? `${lo}` : `${lo}–${hi}`)).join(' to ');

// Base name → snapshot type token, from RePoE base_items.json (null when unavailable).
export function baseTypeMap(baseItems) {
  const byClass = new Map();
  for (const c of CLASSES) for (const ic of c.repoe || []) byClass.set(ic, c.token);
  const out = new Map();
  for (const b of Object.values(baseItems || {})) {
    const token = byClass.get(b.item_class);
    if (token && b.name && !out.has(b.name)) out.set(b.name, token);
  }
  return out;
}

/**
 * Check captured bands against snapshot stats.
 * @returns {{ agree, disagree, notes }} — `disagree` rows are what a person must look at;
 *   `notes` are bands that can't be judged (hybrid mods, unknown stats, uncovered types).
 */
export function spotCheck(capture, stats, baseToType = new Map()) {
  const byId = new Map();
  for (const e of Object.values(stats)) {
    for (const id of [e.tradeStatId, ...(e._tradeStatIdAlts || [])].filter(Boolean)) {
      if (!byId.has(id)) byId.set(id, []);
      byId.get(id).push(e);
    }
  }
  const agree = [];
  const disagree = [];
  const notes = [];
  for (const obs of capture.bands || []) {
    const t = parseTier(obs.tier);
    // Desecrated and fractured lines carry their own hash prefix but the explicit stat id.
    const magnitudes = obs.magnitudes.map((m) => ({ ...m, hash: String(m.hash).replace(/^(desecrated|fractured)\./, 'explicit.') }));
    const hashes = [...new Set(magnitudes.map((m) => m.hash))];
    const where = `${obs.tier} ${obs.base}`;
    if (!t) { notes.push({ kind: 'untiered', where, text: obs.name }); continue; }
    if (hashes.length > 1) { notes.push({ kind: 'hybrid', where, text: `${obs.name} (${hashes.length} stats)` }); continue; }
    const hash = hashes[0];
    // GGG writes "reduced" ranges high-to-low (19–17); compare as low-to-high.
    const band = magnitudes.map((m) => [Math.min(m.min, m.max), Math.max(m.min, m.max)]);
    const candidates = (byId.get(hash) || []).filter((e) => e.affix === t.affix);
    if (!candidates.length) { notes.push({ kind: 'no-stat', where, text: `${obs.name} ${hash} [${fmt(band)}]` }); continue; }
    const type = baseToType.get(obs.base) || null;
    const families = type ? candidates.filter((e) => (e.types || []).includes(type)) : candidates;
    if (!families.length) {
      notes.push({ kind: 'no-family', where, text: `${candidates[0].display}: no ${type} family [${fmt(band)}]` });
      continue;
    }
    let hit = null;
    for (const e of families) {
      for (const tier of e.tiers || []) {
        if (sameBand(tier.ranges, band) || (e.inverted && sameBand(tier.ranges, flip(band)))) { hit = { e, tier }; break; }
      }
      if (hit) break;
    }
    const row = { where, type, display: families[0].display, gggTier: obs.tier, gggLevel: obs.level, band };
    if (hit) {
      agree.push({ ...row, family: hit.e.family, tier: hit.tier.tier, ilvl: hit.tier.ilvl });
      continue;
    }
    // Nearest tier, so the report says how far off the snapshot is.
    let near = null;
    for (const e of families) {
      for (const tier of e.tiers || []) {
        const d = Math.min(distance(tier.ranges, band), e.inverted ? distance(tier.ranges, flip(band)) : Infinity);
        if (!near || d < near.d) near = { d, e, tier };
      }
    }
    disagree.push({
      ...row,
      family: near ? near.e.family : families[0].family,
      nearest: near ? { tier: near.tier.tier, ilvl: near.tier.ilvl, band: near.tier.ranges, off: near.d } : null,
      typeKnown: !!type,
    });
  }
  return { agree, disagree, notes };
}

export function report(capture, result, { all = false } = {}) {
  const { agree, disagree, notes } = result;
  const lines = [];
  let league = capture._league || 'unknown league';
  try { league = decodeURIComponent(league); } catch { /* keep as is */ }
  lines.push(`TierFill spot-check: ${league}, captured ${capture._captured || '?'}`);
  lines.push(`${capture.listings ?? '?'} listings, ${(capture.bands || []).length} distinct tier bands, ` +
    `${new Set(agree.concat(disagree).map((r) => r.display)).size} stats judged`);
  lines.push('');
  if (disagree.length) {
    lines.push(`✖ ${disagree.length} band(s) disagree with the snapshot:`);
    for (const r of disagree) {
      const near = r.nearest ? `nearest T${r.nearest.tier} (ilvl ${r.nearest.ilvl}) [${fmt(r.nearest.band)}], off by ${r.nearest.off}` : 'no comparable tier';
      lines.push(`  ${r.display} — ${r.where}${r.typeKnown ? '' : ' (type unknown, all families searched)'}`);
      lines.push(`    GGG [${fmt(r.band)}] lvl ${r.gggLevel}; snapshot "${r.family}" ${near}`);
    }
  } else {
    lines.push(`✓ all ${agree.length} judged bands match the snapshot exactly`);
  }
  const ilvlOff = agree.filter((r) => r.gggLevel != null && r.ilvl != null && r.gggLevel !== r.ilvl);
  if (ilvlOff.length) {
    lines.push('');
    lines.push(`ℹ ${ilvlOff.length} matching band(s) where GGG's mod level differs from the snapshot ilvl:`);
    for (const r of ilvlOff) lines.push(`  ${r.display} T${r.tier} [${fmt(r.band)}]: GGG lvl ${r.gggLevel}, snapshot ${r.ilvl} (${r.where})`);
  }
  if (all && agree.length) {
    lines.push('');
    lines.push('Matching bands:');
    for (const r of agree) lines.push(`  ✓ ${r.display} T${r.tier} [${fmt(r.band)}] — ${r.where} → "${r.family}"`);
  }
  if (notes.length) {
    lines.push('');
    const count = (k) => notes.filter((n) => n.kind === k).length;
    lines.push(`Not judged: ${count('hybrid')} hybrid, ${count('no-stat')} not in snapshot, ` +
      `${count('no-family')} no family for that item type, ${count('untiered')} untiered`);
    for (const n of notes.filter((x) => x.kind === 'no-family' || (all && x.kind !== 'hybrid'))) lines.push(`  ${n.kind}: ${n.text} — ${n.where}`);
  }
  return lines.join('\n');
}

async function run(path, all) {
  const capture = JSON.parse(await readFile(path, 'utf8'));
  if (!Array.isArray(capture.bands)) throw new Error(`${path} has no "bands" array; is it a spot-check capture?`);
  const snapshot = JSON.parse(await readFile(join(ROOT, 'assets', 'data-snapshot.json'), 'utf8'));
  const basesPath = join(here, 'data-sources', 'repoe', 'base_items.json');
  let bases = new Map();
  if (existsSync(basesPath)) bases = baseTypeMap(JSON.parse(readFileSync(basesPath, 'utf8')));
  else console.log('⚠ no RePoE base_items.json; every family is searched. Run node tools/refresh.mjs to fetch it.\n');
  const result = spotCheck(capture, snapshot.stats, bases);
  console.log(report(capture, result, { all }));
  if (result.disagree.length) process.exitCode = 1;
}

async function main() {
  const args = process.argv.slice(2);
  const all = args.includes('--all');
  const arg = args.find((a) => a !== '--all');
  if (arg === '--downloads') return run(join(homedir(), 'Downloads', FILE_NAME), all);
  if (arg) return run(resolve(arg), all);
  console.log('1. Open https://www.pathofexile.com/trade2 and paste this into its devtools console:\n');
  console.log(SNIPPET);
  console.log('\n2. Search by hand for these (any mix of 10-20 is enough), clicking Search as usual:');
  for (const s of SUGGESTED) console.log(`   - ${s}`);
  console.log(`\n3. Run tierfillSpot.save() in the console; it saves ${FILE_NAME}.`);
  console.log('4. Run: node tools/spot-check.mjs --downloads   (or pass the file\'s path)');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((e) => {
    console.error('✖ spot-check failed:', e.message);
    process.exitCode = 1;
  });
}
