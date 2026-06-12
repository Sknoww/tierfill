/*
 * audit-diff — Phase 2 of the PoE2DB-direct overhaul: diff a PoE2DB-direct snapshot
 * against the live (enhancer-based) snapshot. THIS DIFF IS THE AUDIT.
 *
 *   # build the PoE2DB-direct snapshot first (raw — no override layer):
 *   node tools/build-data.mjs --base tools/data-sources/poe2db-mods.json --no-overrides \
 *        --out tools/data-sources/.poe2db-snapshot.json
 *   node tools/audit-diff.mjs                  # console summary + .audit-report.json
 *   node tools/audit-diff.mjs --show diff      # also print every DIFFering ladder
 *   node tools/audit-diff.mjs --show live-only # print coverage the direct scrape lost
 *
 * Matching: group both snapshots by tradeStatId+affix (or display text if no id), then pair
 * families within a group by item-type overlap — so a family that merged differently across
 * the two sources (e.g. bow folded into the melee added-damage ladder it shares values with)
 * still lines up. Each matched pair's tier ladder is normalized (single roll → [n,n]) and
 * compared best→worst. Output buckets:
 *   IDENTICAL    — ladders agree (the bulk; the migration is safe here)
 *   DIFF         — ladders disagree → needs a verdict (enhancer-wrong / poe2db-wrong / override)
 *   LIVE_ONLY    — present live, absent in the direct scrape → a coverage REGRESSION to explain
 *   POE2DB_ONLY  — new coverage the stale enhancer lacked
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const LIVE = join(root, 'assets', 'data-snapshot.json');
const POE2DB = join(here, 'data-sources', '.poe2db-snapshot.json');
const REPORT = join(here, 'data-sources', '.audit-report.json');
const SHOW_FLAG = process.argv.indexOf('--show');
const SHOW = SHOW_FLAG !== -1 ? process.argv[SHOW_FLAG + 1] : null;

// Normalize one tier's ranges to a comparable signature. A range pair is [lo,hi]; a fixed
// sub-roll may arrive as [n] — expand to [n,n]. Numbers coerced; pairs kept in order.
function tierSig(tiers) {
  return (tiers || [])
    .map((t) =>
      (t.ranges || [])
        .map((r) => (r.length === 1 ? [Number(r[0]), Number(r[0])] : [Number(r[0]), Number(r[1])]))
        .map((r) => r.join('-'))
        .join('|'),
    )
    .join(' , ');
}

// Stat identity shared across the two snapshots: the trade stat id (preferred) or the
// display text, plus the affix bucket. Families live UNDER this identity.
const statId = (e) => `${e.tradeStatId || 'TXT:' + (e.display || '').toLowerCase()}::${e.affix}`;

function indexBySid(snap) {
  const m = new Map();
  for (const [key, e] of Object.entries(snap.stats || {})) {
    const sid = statId(e);
    if (!m.has(sid)) m.set(sid, []);
    m.get(sid).push({
      key,
      family: e.family,
      display: e.display,
      types: new Set(e.types || []),
      tierCount: (e.tiers || []).length,
      sig: tierSig(e.tiers),
      overridden: e._src === 'ggg-override',
      tiersTop: (e.tiers || [])[0]?.ranges,
    });
  }
  return m;
}

const overlap = (a, b) => { let n = 0; for (const t of a) if (b.has(t)) n++; return n; };

// Greedily pair live families to poe2db families within one stat by max type overlap.
function pairFamilies(liveFams, poeFams) {
  const pairs = [];
  const usedPoe = new Set();
  const liveLeft = [];
  // sort live by descending best-overlap for stable greedy matching
  for (const lf of liveFams) {
    let best = -1, bestIdx = -1;
    poeFams.forEach((pf, i) => {
      if (usedPoe.has(i)) return;
      const ov = overlap(lf.types, pf.types);
      if (ov > best) { best = ov; bestIdx = i; }
    });
    if (bestIdx !== -1 && best > 0) { usedPoe.add(bestIdx); pairs.push([lf, poeFams[bestIdx]]); }
    else liveLeft.push(lf);
  }
  const poeLeft = poeFams.filter((_, i) => !usedPoe.has(i));
  return { pairs, liveLeft, poeLeft };
}

async function main() {
  const live = JSON.parse(await readFile(LIVE, 'utf8'));
  const poe = JSON.parse(await readFile(POE2DB, 'utf8'));
  const liveIdx = indexBySid(live);
  const poeIdx = indexBySid(poe);
  const allSids = new Set([...liveIdx.keys(), ...poeIdx.keys()]);

  const out = { identical: [], diff: [], liveOnly: [], poe2dbOnly: [] };

  for (const sid of allSids) {
    const lf = liveIdx.get(sid) || [];
    const pf = poeIdx.get(sid) || [];
    if (!lf.length) { for (const p of pf) out.poe2dbOnly.push(famRec(sid, p)); continue; }
    if (!pf.length) { for (const l of lf) out.liveOnly.push(famRec(sid, l)); continue; }
    const { pairs, liveLeft, poeLeft } = pairFamilies(lf, pf);
    for (const [l, p] of pairs) {
      const rec = {
        sid, display: l.display, family: `${l.family} ↔ ${p.family}`,
        liveTiers: l.tierCount, poeTiers: p.tierCount,
        overridden: l.overridden, liveSig: l.sig, poeSig: p.sig,
        liveTop: l.tiersTop, poeTop: p.tiersTop,
      };
      if (l.sig === p.sig) out.identical.push(rec); else out.diff.push(rec);
    }
    for (const l of liveLeft) out.liveOnly.push(famRec(sid, l));
    for (const p of poeLeft) out.poe2dbOnly.push(famRec(sid, p));
  }

  await writeFile(REPORT, JSON.stringify(out, null, 2) + '\n');

  // ── summary ───────────────────────────────────────────────────────────────
  const overriddenDiffs = out.diff.filter((d) => d.overridden).length;
  console.log('audit-diff  (PoE2DB-direct  vs  live enhancer-based snapshot)');
  console.log('─'.repeat(64));
  console.log(`live families:      ${[...liveIdx.values()].reduce((n, a) => n + a.length, 0)}`);
  console.log(`poe2db families:    ${[...poeIdx.values()].reduce((n, a) => n + a.length, 0)}`);
  console.log(`IDENTICAL:          ${out.identical.length}`);
  console.log(`DIFF:               ${out.diff.length}   (of which ${overriddenDiffs} are on live's GGG-override ladders)`);
  console.log(`LIVE_ONLY:          ${out.liveOnly.length}   (coverage the direct scrape didn't reproduce)`);
  console.log(`POE2DB_ONLY:        ${out.poe2dbOnly.length}   (new coverage the enhancer lacked)`);
  console.log(`\nfull detail → ${REPORT}`);

  if (SHOW === 'diff') {
    console.log(`\n── DIFF ladders (${out.diff.length}) ──`);
    for (const d of out.diff.sort((a, b) => Number(b.overridden) - Number(a.overridden))) {
      console.log(`\n• ${d.display}  [${d.family}]${d.overridden ? '  (live=GGG-override)' : ''}`);
      console.log(`    live  (${d.liveTiers}t): ${d.liveSig}`);
      console.log(`    poe2db(${d.poeTiers}t): ${d.poeSig}`);
    }
  }
  if (SHOW === 'live-only') {
    console.log(`\n── LIVE_ONLY (${out.liveOnly.length}) ──`);
    for (const l of out.liveOnly) console.log(`  · ${l.display}  [${l.family}]  (${l.tierCount}t, types=${[...l.types].join(',')})`);
  }
  if (SHOW === 'poe2db-only') {
    console.log(`\n── POE2DB_ONLY (${out.poe2dbOnly.length}) ──`);
    for (const p of out.poe2dbOnly) console.log(`  · ${p.display}  [${p.family}]  (${p.tierCount}t, types=${[...p.types].join(',')})`);
  }
}

function famRec(sid, f) {
  return { sid, display: f.display, family: f.family, tierCount: f.tierCount, types: [...f.types], sig: f.sig };
}

main().catch((e) => { console.error(e); process.exit(1); });
