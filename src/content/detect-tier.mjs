/*
 * Pure tier-detection helpers for the §9 result annotator (no DOM — unit-tested
 * in node via tools/validate.mjs). Given a result listing's printed mod text and
 * a snapshot stat entry, work out which tier the roll actually is — the §7b
 * precision the server's average-only filter can't provide.
 */

const squish = (s) => (s || '').replace(/\s+/g, ' ').trim();

/**
 * Build a capture regex from a snapshot display template:
 *   "Adds # to # Fire damage to Attacks"
 *     → /adds\s+([+\-]?\d+)\s+to\s+([+\-]?\d+)\s+fire\s+damage\s+to\s+attacks/i
 * Escape regex specials first, then turn each `#` into a number capture group
 * and collapse whitespace runs to \s+ (result text spacing varies).
 */
export function templateToRegex(display) {
  const esc = squish(display).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pat = esc.replace(/#/g, '([+\\-]?\\d+)').replace(/\s+/g, '\\s+');
  return new RegExp(pat, 'i');
}

// Pull the captured numbers ([low, high] for averaged, [val] for single) out of
// a regex match.
export function parseRolls(match) {
  const rolls = [];
  for (let i = 1; i < match.length; i++) {
    if (match[i] != null) rolls.push(parseInt(match[i], 10));
  }
  return rolls;
}

/**
 * Detect a roll's real tier by testing BOTH sub-rolls against each tier's ranges
 * (true §7b precision). When a lucky roll straddles tiers (low in T2, high in
 * T1) no single tier contains both — fall back to the average band and mark it
 * approximate (`exact:false`).
 * @returns {{tier:number, exact:boolean}|null}
 */
export function detectTier(entry, rolls) {
  const tiers = entry.tiers || [];
  if (entry.isAveraged) {
    const [lo, hi] = rolls;
    if (lo == null || hi == null) return null;
    for (const t of tiers) {
      if (lo >= t.ranges[0][0] && lo <= t.ranges[0][1] &&
          hi >= t.ranges[1][0] && hi <= t.ranges[1][1]) {
        return { tier: t.tier, exact: true };
      }
    }
    const avg = (lo + hi) / 2;
    for (const t of tiers) {
      const floor = (t.ranges[0][0] + t.ranges[1][0]) / 2;
      const ceil = (t.ranges[0][1] + t.ranges[1][1]) / 2;
      if (avg >= floor && avg <= ceil) return { tier: t.tier, exact: false };
    }
  } else {
    const v = rolls[0];
    if (v == null) return null;
    for (const t of tiers) {
      if (v >= t.ranges[0][0] && v <= t.ranges[0][1]) return { tier: t.tier, exact: true };
    }
  }
  return null;
}

// Convenience used by both the annotator and the tests: from a listing's mod
// text + a stat entry, return the detected tier (or null if the text doesn't
// match this stat / no tier fits).
export function detectFromText(entry, text) {
  const m = templateToRegex(entry.display).exec(squish(text));
  if (!m) return null;
  return detectTier(entry, parseRolls(m));
}

/* ──────────────────────────────────────────────────────────────────────────
 * §9 GGG-sourced parsing (the chosen approach: read GGG's OWN tier label +
 * range off the result mod line, e.g.  "P2 [20—24 to 33—36] Adds 22 to 35 …").
 * GGG's tier is authoritative — our snapshot drifts (see the §11.7 audit TODO),
 * so result annotation uses these, not detectTier().
 * ────────────────────────────────────────────────────────────────────────── */

// "P2 [20—24 to 33—36] Adds …" → { affix:'P', tier:2 }. The label sits at the
// very start, immediately before the range bracket (that `[` requirement keeps
// it from false-matching a mod that happens to start with a letter+digit).
export function parseGggTier(text) {
  const m = /^\s*([A-Za-z])(\d+)\s*\[/.exec(text || '');
  if (!m) return null;
  return { affix: m[1].toUpperCase(), tier: parseInt(m[2], 10) };
}

// The first [...] bracket is GGG's tier range. Averaged mods read as
// "lo1—lo2 to hi1—hi2" → [[lo1,lo2],[hi1,hi2]]; single-value as "x—y" → [[x,y]].
// Handles em-dash, en-dash and hyphen separators.
export function parseGggRanges(text) {
  const b = /\[([^\]]+)\]/.exec(text || '');
  if (!b) return null;
  const ranges = [];
  for (const part of b[1].split(/\s+to\s+/i)) {
    const pair = /(-?\d+)\s*[—–-]\s*(-?\d+)/.exec(part);
    if (pair) ranges.push([parseInt(pair[1], 10), parseInt(pair[2], 10)]);
    else {
      const one = /(-?\d+)/.exec(part);
      if (one) { const v = parseInt(one[1], 10); ranges.push([v, v]); }
    }
  }
  return ranges.length ? ranges : null;
}

// Where a roll sits inside its (GGG) tier band → 'low' | 'mid' | 'high', or null
// when the band is a fixed value (no spread to judge). For averaged mods we
// compare the roll's average to the tier's average band — the same axis the
// trade filter uses, so "high" is exactly what let a lower tier leak past it.
export function rollQuality(rolls, ranges) {
  let val; let floor; let ceil;
  if (ranges.length >= 2 && rolls.length >= 2) {
    val = (rolls[0] + rolls[1]) / 2;
    floor = (ranges[0][0] + ranges[1][0]) / 2;
    ceil = (ranges[0][1] + ranges[1][1]) / 2;
  } else {
    val = rolls[0];
    floor = ranges[0][0];
    ceil = ranges[0][1];
  }
  if (!(ceil > floor)) return null; // fixed band — nothing to grade
  const pos = (val - floor) / (ceil - floor);
  if (pos >= 0.66) return 'high';
  if (pos <= 0.34) return 'low';
  return 'mid';
}
