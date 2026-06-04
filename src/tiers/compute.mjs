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
