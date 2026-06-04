/*
 * Content app — §11.6 picker (per-row inline form factor).
 *
 * Flow (PLAN §11.6, FINDINGS §3):
 *   1. find every Stats group via the "+ Add Stat Filter" anchor → .filter-group
 *   2. for each stat row (.filter.full-span), read .filter-title, strip the
 *      leading type token (explicit/pseudo/…) → the stat template (with #)
 *   3. exact-match the template against our snapshot's `display`
 *   4. resolve the weapon family (auto when the page tells us, toggle otherwise)
 *   5. inject a namespaced tier control LEFT of the row's first MIN input
 *
 * Additive-only, idempotent, debounced MutationObserver (PLAN §9 coexistence).
 */

import { computeAllTiers } from '../tiers/compute.mjs';
import { resolveFamily } from './detect.mjs';
import { createTierControl } from '../ui/tier-control.mjs';
import { setSelection, clearSelection, retainOnly } from './store.mjs';
import { initResults } from './results.mjs';

const RT = (typeof browser !== 'undefined' ? browser : chrome).runtime;

// Leading tokens the site prepends to a stat title (rendered as a badge but
// present in textContent — FINDINGS §3). Strip to get the raw template.
const TYPE_TOKENS = new Set([
  'explicit', 'implicit', 'pseudo', 'rune', 'crafted', 'enchant',
  'fractured', 'scourge', 'veiled', 'desecrated', 'sanctum', 'corrupted',
]);

let INDEX = null; // normalized display text → [stat entries] (one per family)
let idCounter = 0; // stable per-row id for the §9 selection store

const squish = (s) => (s || '').replace(/\s+/g, ' ').trim();

// Split a row title into its leading type token (explicit/implicit/pseudo/…) and the
// stat template text. The token gates which rows we touch (our data is explicit-only).
function stripTypeToken(title) {
  const t = squish(title);
  const sp = t.indexOf(' ');
  if (sp > 0 && TYPE_TOKENS.has(t.slice(0, sp).toLowerCase())) {
    return { token: t.slice(0, sp).toLowerCase(), text: t.slice(sp + 1).trim() };
  }
  return { token: null, text: t };
}

function buildIndex(data) {
  const idx = new Map();
  for (const [key, entry] of Object.entries(data.stats || {})) {
    const disp = squish(entry.display).toLowerCase();
    if (!idx.has(disp)) idx.set(disp, []);
    idx.get(disp).push({ key, ...entry });
  }
  return idx;
}

function getStatsGroups() {
  const groups = new Set();
  document
    .querySelectorAll('input.multiselect__input[placeholder="+ Add Stat Filter" i]')
    .forEach((anchor) => {
      const g = anchor.closest('.filter-group');
      if (g) groups.add(g);
    });
  return [...groups];
}

function processRow(row) {
  const titleEl = row.querySelector('.filter-title');
  if (!titleEl) return;

  const { token, text } = stripTypeToken(titleEl.textContent);
  const template = text.toLowerCase();
  const cacheKey = `${token || ''}::${template}`;
  if (row.dataset.poe2tfTpl === cacheKey) return; // unchanged → leave it (and the user's selection) alone

  // template/type changed (or first sighting) → reset any prior control + its
  // published selection (the old tier no longer describes this row's mod).
  row.querySelector(':scope .poe2tf-control')?.remove();
  if (row.dataset.poe2tfId) clearSelection(row.dataset.poe2tfId);
  row.dataset.poe2tfTpl = cacheKey;

  // explicit-only data: never attach to implicit/pseudo/rune/crafted/… rows (they'd
  // match by text but carry different — or no — tiers). token===null = no recognized
  // prefix, treated as best-effort explicit.
  if (token && token !== 'explicit') return;

  const families = INDEX.get(template);
  if (!families || !families.length) return; // no tier data → no control (silent)

  const minInput = row.querySelector('input.minmax, input.form-control.minmax');
  if (!minInput) return;

  const { family, ambiguous } = resolveFamily(families);
  if (!family) return;

  const id = row.dataset.poe2tfId || (row.dataset.poe2tfId = String(++idCounter));
  const control = createTierControl({
    families, family, ambiguous, minInput, computeAllTiers,
    // publish the pick to the §9 store so the results annotator can detect tiers.
    onChange: (entry, tier) => setSelection(id, { display: entry.display, entry, tier }),
  });
  minInput.parentNode.insertBefore(control, minInput); // left of MIN
}

function scan() {
  if (!INDEX) return;
  for (const group of getStatsGroups()) {
    group.querySelectorAll('.filter.full-span').forEach(processRow);
  }
  // Reconcile the §9 store: drop selections whose row/control is gone (e.g. the
  // user deleted the stat filter), so we stop annotating results for it.
  const live = new Set();
  document.querySelectorAll('.filter.full-span').forEach((row) => {
    if (row.dataset.poe2tfId && row.querySelector(':scope .poe2tf-control')) {
      live.add(row.dataset.poe2tfId);
    }
  });
  retainOnly(live);
}

let timer = null;
function scheduleScan() {
  clearTimeout(timer);
  timer = setTimeout(scan, 150);
}

async function init() {
  const res = await fetch(RT.getURL('assets/data-snapshot.json'));
  INDEX = buildIndex(await res.json());
  scan();
  initResults(); // §9 result annotator (own observer; default OFF until toggled)
  new MutationObserver(scheduleScan).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
}

init().catch((e) => console.error('[poe2tf] init failed:', e));
