/*
 * Affix-split stats (e.g. "increased Rarity of Items found").
 *
 * A few stats roll the SAME trade stat as both a prefix AND a suffix, and the trade
 * search SUMS the two instances into one filter — so the filterable quantity is the
 * total. Rather than a prefix/suffix picker (which adds no search power, since any
 * value we fill is matched against the sum either way), we present a single
 * item-type-aware ladder: the item's achievable affix(es) decide which ladder shows,
 * and when both are possible we use a synthesized COMBINED ladder of summed tiers.
 *
 * These helpers are pure (no DOM) so they can be unit-tested; the DOM-coupled
 * resolution (which reads the live item-type context) lives in index.mjs.
 */

// A stat is affix-split when its families each carry a DISTINCT affix (prefix vs
// suffix) — as opposed to the usual item-type split where every family shares one.
export function isAffixSplit(families) {
  if (!families || families.length < 2) return false;
  const affixes = families.map((f) => f.affix).filter(Boolean);
  return affixes.length === families.length && new Set(affixes).size === affixes.length;
}

// Element-wise sum of two range lists ([[lo,hi], …]); shapes are expected to match.
export const sumRanges = (a, b) =>
  (a || []).map((pair, i) => {
    const other = (b && b[i]) || pair;
    return [pair[0] + other[0], pair[1] + other[1]];
  });

// Synthesize the combined ladder shown when both affixes are possible (or the item
// type is unknown). The top is the per-tier SUM (both affixes present); the bottom is
// extended with the low single-affix tiers the sums don't reach — an item may carry
// only ONE of the two affixes (e.g. gloves roll Rarity as a suffix only), so the
// achievable total can fall below the smallest both-affix sum. Without this, a
// single-affix search with no item type set is stuck at the high tiers.
export function buildCombinedFamily(families) {
  const base = families[0];
  const isAveraged = ((base.tiers || [])[0]?.ranges || []).length === 2;
  const floorOf = (ranges) => (isAveraged && ranges[1] ? (ranges[0][0] + ranges[1][0]) / 2 : ranges[0][0]);

  // Top: per-tier sums (matched by tier number; a tier missing from a ladder is skipped).
  const summed = [];
  for (const { tier: n } of base.tiers || []) {
    const perFam = families.map((f) => (f.tiers || []).find((t) => t.tier === n));
    if (perFam.some((t) => !t)) continue;
    const ranges = perFam.slice(1).reduce((acc, t) => sumRanges(acc, t.ranges), perFam[0].ranges);
    const ilvl = Math.max(...perFam.map((t) => Number(t.ilvl) || 0)) || null;
    summed.push({ ilvl, ranges });
  }

  // Bottom: single-affix tiers below the smallest sum, taken from the most permissive
  // (lowest-floor) ladder so the low end reaches a lone weak roll.
  const minFloor = (f) => Math.min(...(f.tiers || []).map((t) => floorOf(t.ranges)));
  const lowerFam = families.reduce((a, b) => (minFloor(a) <= minFloor(b) ? a : b));
  const minSum = summed.length ? Math.min(...summed.map((t) => floorOf(t.ranges))) : Infinity;
  const extras = (lowerFam.tiers || [])
    .filter((t) => floorOf(t.ranges) < minSum)
    .map((t) => ({ ilvl: t.ilvl ?? null, ranges: t.ranges }));

  const tiers = [...summed, ...extras].map((t, i) => ({ tier: i + 1, ilvl: t.ilvl, ranges: t.ranges }));
  return {
    ...base,
    affix: 'total',
    family: 'Combined (prefix + suffix)',
    types: [...new Set(families.flatMap((f) => f.types || []))],
    tiers,
    _combined: true,
    _note: 'Combined prefix + suffix — the trade search sums both into one filter.',
  };
}
