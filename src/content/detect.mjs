/*
 * Item-type / weapon-family detection (live, DOM-first — no search fired).
 * Source of truth for the selectors: spike/FINDINGS.md §4.
 *
 * Purpose for §11.6: a stat like "Adds # to # Physical Damage" has TWO ladders
 * (1H/bow vs 2H/quarterstaff). When the page tells us the item family, we pick
 * the right ladder and hide the manual toggle; when it's unknown/ambiguous, the
 * caller shows a 1H/2H toggle instead.
 *
 * NOTE (heuristic): we match the *display* text the site exposes (category
 * placeholder like "Dagger", or a committed base name) against each family's
 * `types` tokens. A precise category.option → family map is §11.7 data work;
 * this is a best-effort first cut and is intentionally conservative — when it
 * can't tell, it reports `ambiguous` so the user decides.
 */

const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Collect the item-scoping tokens the page currently exposes.
 * @returns {{cats: Set<string>, base: string}}
 *   cats — hyphenated category tokens from Type Filters (e.g. "two-hand-sword")
 *   base — committed base-item text from the search bar (e.g. "obliterator bow")
 */
function collectDetectedTokens() {
  const cats = new Set();
  // Type Filters → ".multiselect.filter-select"; chosen option is the input
  // PLACEHOLDER plus a "modified" class on the container (FINDINGS §4 Mode 2).
  document.querySelectorAll('.multiselect.filter-select').forEach((sel) => {
    if (!sel.classList.contains('modified')) return;
    const ph = norm(sel.querySelector('input')?.getAttribute('placeholder'));
    if (ph && ph !== 'any') cats.add(ph.replace(/\s+/g, '-'));
  });

  // Search bar → ".multiselect.search-select"; committed base in input.value,
  // gated by the "modified" class (FINDINGS §4 Mode 1).
  let base = '';
  const sb = document.querySelector('.multiselect.search-select');
  if (sb && sb.classList.contains('modified')) {
    base = norm(sb.querySelector('input')?.value);
  }
  return { cats, base };
}

function tokenHit(type, { cats, base }) {
  const t = norm(type); // e.g. "two-hand-sword", "bow"
  if (cats.has(t)) return true;

  if (base) {
    // exact type as words ("one hand sword" / "one-hand-sword")
    const asWords = t.replace(/-/g, '[ -]');
    if (new RegExp(`\\b${asWords}\\b`).test(base)) return true;
    // last word of the type ("sword", "bow", "mace") as a standalone word —
    // word boundaries keep "greatsword" from matching "sword"
    const tail = t.split('-').pop();
    if (tail.length >= 3 && new RegExp(`\\b${tail}\\b`).test(base)) return true;
  }
  return false;
}

/**
 * Pick the family ladder for a set of same-named stat entries.
 * @param {Array} families - stat entries sharing one display text
 * @returns {{family: object, ambiguous: boolean}}
 */
export function resolveFamily(families) {
  if (!families || families.length === 0) return { family: null, ambiguous: false };
  if (families.length === 1) return { family: families[0], ambiguous: false };

  const tokens = collectDetectedTokens();
  const matched = families.filter((f) => (f.types || []).some((t) => tokenHit(t, tokens)));
  if (matched.length === 1) return { family: matched[0], ambiguous: false };

  // zero matches (no item set / group category like "weapon.ranged") OR
  // multiple matches (e.g. a base containing "sword") → let the user choose.
  return { family: families[0], ambiguous: true };
}
