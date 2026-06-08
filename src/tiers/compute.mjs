/*
 * PoE2 Tier Filter — tier → value computation (pure, framework-agnostic ESM).
 *
 * Source of truth: docs/PLAN.md §6–§7.
 *  • Single-value mod  → min = tier.ranges[0][0]   (the tier's floor)
 *  • Averaged mod (two sub-rolls, e.g. "Adds # to #") → the trade min box compares
 *    against (lowRoll + highRoll) / 2, so for "tier T or better":
 *        inclusive min = (loMin + hiMin) / 2
 *    Confirmed live (PLAN §4): item "Adds 14 to 26" → average 20; min 19 shows, 21 hides.
 *
 * `ranges` shape (per PLAN §5):
 *   single  : [[min, max]]
 *   averaged: [[loMin, loMax], [hiMin, hiMax]]
 *
 * Tiers are ordered with tier 1 = BEST (reverse of item-level order). "Lower tiers"
 * (numerically larger `tier`) are weaker and have lower average bands.
 */

export const MODES = ['inclusive', 'strict', 'exact-band'];

export function getTier(stat, tierNum) {
  return (stat.tiers || []).find((t) => t.tier === tierNum) || null;
}

// Inclusive floor for a tier — the smallest average that tier can roll.
export function tierFloor(stat, tier) {
  return stat.isAveraged ? (tier.ranges[0][0] + tier.ranges[1][0]) / 2 : tier.ranges[0][0];
}

// Inclusive ceiling — the largest average that tier can roll.
export function tierCeil(stat, tier) {
  return stat.isAveraged ? (tier.ranges[0][1] + tier.ranges[1][1]) / 2 : tier.ranges[0][1];
}

/**
 * Compute the trade filter for "tier T or better" of a stat.
 * @returns {{min:number, max?:number}|null}
 *
 *  inclusive (default) — never misses a T, but leaks lucky lower-tier rolls.
 *  exact-band          — { min: floor, max: ceil } → "roughly this tier, not higher".
 *  strict              — min just above the highest average any LOWER tier can reach,
 *                        so every result is genuinely ≥ T (drops low-rolled Ts).
 */
export function computeFilter(stat, tierNum, mode = 'inclusive') {
  const tier = getTier(stat, tierNum);
  if (!tier) return null;

  // Sign-flipped stats (e.g. "reduced Charges per use" → the trade stat "increased
  // Charges per use", where better = more negative). The whole axis mirrors: we fill
  // MAX instead of MIN, with the tier's least-negative bound (ceil), so "T or better"
  // captures this tier and every more-negative one. A self-contained branch — the
  // default path below is byte-for-byte unchanged for every normal mod.
  if (stat.inverted) return computeInvertedFilter(stat, tierNum, mode);

  const floor = tierFloor(stat, tier);

  if (mode === 'exact-band') return { min: floor, max: tierCeil(stat, tier) };

  if (mode === 'strict') {
    const lower = (stat.tiers || []).filter((t) => t.tier > tierNum);
    let maxLowerCeil = -Infinity;
    for (const lt of lower) maxLowerCeil = Math.max(maxLowerCeil, tierCeil(stat, lt));
    if (maxLowerCeil === -Infinity) return { min: floor }; // no lower tier
    // Averages step by 0.5 (two integer sub-rolls), so +0.5 is the smallest value
    // strictly above the worst lower-tier average. Never go below the tier's own
    // floor — when tiers don't overlap the floor already excludes lower tiers.
    return { min: Math.max(floor, maxLowerCeil + 0.5) };
  }

  return { min: floor }; // inclusive
}

// Sign-flipped variant of computeFilter (see the `stat.inverted` note above). The axis is
// mirrored: better = more negative, so we return a `max` (the value the trade MAX box gets)
// rather than a `min`. Inverted mods are single-roll, so strict steps by 1.
function computeInvertedFilter(stat, tierNum, mode) {
  const tier = getTier(stat, tierNum);
  if (!tier) return null;
  const floor = tierFloor(stat, tier); // most-negative bound (best within tier)
  const ceil = tierCeil(stat, tier); // least-negative bound (worst within tier)

  if (mode === 'exact-band') return { min: floor, max: ceil };

  if (mode === 'strict') {
    const lower = (stat.tiers || []).filter((t) => t.tier > tierNum);
    let minLowerFloor = Infinity;
    for (const lt of lower) minLowerFloor = Math.min(minLowerFloor, tierFloor(stat, lt));
    if (minLowerFloor === Infinity) return { max: ceil }; // no lower tier
    // Largest value strictly below the most-negative roll any lower tier can reach.
    // Never loosen past this tier's own ceil (when tiers don't overlap, ceil already excludes them).
    return { max: Math.min(ceil, minLowerFloor - 1) };
  }

  return { max: ceil }; // inclusive: this tier + every more-negative (better) one
}

// Convenience: every tier's computed min for a mode (UI dropdown / validation table).
export function computeAllTiers(stat, mode = 'inclusive') {
  return (stat.tiers || []).map((t) => ({
    tier: t.tier,
    name: t.name,
    ilvl: t.ilvl,
    ranges: t.ranges,
    ...computeFilter(stat, t.tier, mode),
  }));
}
