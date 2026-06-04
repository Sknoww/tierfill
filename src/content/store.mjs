/*
 * Shared selection store (§9).
 *
 * The per-row tier controls publish the user's current pick here; the results
 * annotator subscribes and re-draws. A tiny in-memory pub/sub bus decouples the
 * two — neither module imports the other, and the annotator never has to reach
 * into a control's closure to learn what tier was chosen.
 *
 * Keyed by a stable per-row id (assigned in index.mjs). `entry` is the resolved
 * snapshot family object (carries `display`, `isAveraged`, `tiers[].ranges`) so
 * the annotator can detect each listing's real tier without re-looking-up data.
 */

const selections = new Map(); // rowId → { display, entry, tier }
const listeners = new Set();

function emit() {
  for (const fn of listeners) {
    try { fn(); } catch (e) { console.error('[poe2tf] store listener failed:', e); }
  }
}

export function setSelection(id, sel) {
  selections.set(id, sel);
  emit();
}

export function clearSelection(id) {
  if (selections.delete(id)) emit();
}

// Drop entries whose row is no longer live (reconciled each scan in index.mjs),
// so a deleted stat-filter row stops driving result annotation.
export function retainOnly(ids) {
  let changed = false;
  for (const key of [...selections.keys()]) {
    if (!ids.has(key)) { selections.delete(key); changed = true; }
  }
  if (changed) emit();
}

export function getSelections() {
  return [...selections.values()];
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
