/*
 * Result post-filtering / annotation (§9, the §7b precision unlock).
 *
 * The trade server only filters averaged mods on (low+high)/2, so lucky
 * lower-tier rolls leak past a tier filter. But every result listing prints its
 * real `Adds X to Y`, so we read both rolls, detect the listing's ACTUAL tier,
 * and annotate — precision the site itself can't offer.
 *
 * Behaviour (locked with the user):
 *   • Badge each searched explicit mod line with its detected ≈T{n} (✓ green =
 *     meets your tier, ▼ amber = a lucky lower-tier roll that slipped past).
 *   • Global on/off toggle, DEFAULT ON — a floating pill near the results that
 *     appears once results + at least one picked tier are present. The badges
 *     carry the verdict per line, so no row-level dimming is needed.
 *
 * Live DOM (FINDINGS §12): explicit mod line = `div.item-mod--explicit`;
 * desecrated = `div.item-mod--desecrated`, fractured = `div.item-mod--fractured`.
 * All three carry the same GGG tier-bracket shape and share the explicit stat
 * id + tier ladder, so the GGG-label parsers handle them unchanged — we just
 * widen the selector. One listing = `div.row` under `.results`/`.resultset`.
 * Additive-only, namespaced `poe2tf-`,
 * idempotent (re-applies on every results re-render). Coexists with TFT /
 * better-trading result decoration (PLAN §9).
 */

import { getSelections, subscribe } from './store.mjs';
import { templateToRegex, parseRolls, parseGggTier, parseGggRanges, rollQuality, rollPercentile } from './detect-tier.mjs';

const NS = 'poe2tf';
const DEBUG = false; // flip ON to log the per-match table while diagnosing.
const squish = (s) => (s || '').replace(/\s+/g, ' ').trim();

// Build an element with class + text via safe DOM APIs (no innerHTML). All of
// our injected content is controlled (fixed glyphs, numbers, our own snapshot
// text), but we still avoid innerHTML so nothing can ever be parsed as markup.
function mk(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}

let enabled = true; // default ON — badges carry the verdict, so show them by default
let toggleEl = null;  // the on/off button
let wrapEl = null;    // container holding the button + the ⓘ legend (docked together)
let obs = null;
let timer = null;

function clearAll() {
  document.querySelectorAll(`.${NS}-badge`).forEach((b) => b.remove());
  document.querySelectorAll(`.${NS}-host`).forEach((l) => l.classList.remove(`${NS}-host`));
}

function badgeLine(line, tier, quality, isOff) {
  // Two axes, kept visually distinct so they don't read as contradictory:
  //   • verdict (glyph + tier): ✓ green = meets searched tier, ▼ amber = below
  //   • roll quality (·low/·mid/·high): neutral gray — a footnote about the roll
  //     within its own tier, NOT a verdict (so "high" never fights the amber).
  const b = document.createElement('span');
  b.className = `${NS}-badge${isOff ? ` ${NS}-badge--off` : ''}`;
  const glyph = isOff ? '▼' : '✓';
  b.appendChild(mk('span', `${NS}-badge-v`, `${glyph} ≈T${tier}`));
  if (quality) b.appendChild(mk('span', `${NS}-badge-q`, ` ·${quality}`));
  b.title = isOff
    ? `Below your target tier — GGG tier ${tier}${quality ? ` (a ${quality} roll for its tier` : ''}` +
      (quality === 'high' ? ', which is how it slipped past your filter).' : quality ? ').' : '.')
    : `Meets your target — GGG tier ${tier}${quality ? ` (a ${quality} roll for its tier).` : '.'}`;
  // The mod line text is CENTERED in the item card, so any in-flow badge widens
  // the line and shifts the text. Mark the line as our positioning host and pin
  // the badge absolutely (out of flow) so the line's width — and centering —
  // never change. The host class is removed in clearAll (no lasting mutation).
  line.classList.add(`${NS}-host`);
  line.appendChild(b);
}

// Jewel (single-range) badge: jewel mods don't tier, so instead of a ≈T verdict we
// show WHERE the roll sits in its one range as a percentage (the §roll-quality
// unlock for jewels). Green ✓ when the roll meets the MIN you picked, amber ▼ when
// it's below — mirroring the tier badge's meets/below coloring on the percentile axis.
function badgeJewelLine(line, pct, isBelow) {
  const b = document.createElement('span');
  b.className = `${NS}-badge${isBelow ? ` ${NS}-badge--off` : ''}`;
  const glyph = isBelow ? '▼' : '✓';
  b.appendChild(mk('span', `${NS}-badge-v`, `${glyph} ${pct}%`));
  b.title = isBelow
    ? `Below your picked minimum — this roll is ${pct}% of the way up the mod's range.`
    : `Meets your picked minimum — this roll is ${pct}% of the way up the mod's range.`;
  line.classList.add(`${NS}-host`);
  line.appendChild(b);
}

function annotate() {
  updateToggleVisibility();
  clearAll();
  if (!enabled) return;

  const sels = getSelections().filter((s) => s.tier != null && s.entry);
  if (!sels.length) { if (DEBUG) console.log('[poe2tf §9] no selections with a tier'); return; }
  // Sign-flipped (inverted) mods print the OPPOSITE-polarity wording on results — e.g.
  // "28% reduced Charges per use" for the stat whose canonical text is "increased
  // Charges per use" — so we match against that wording. The GGG tier bracket (e.g.
  // "S2 [-29—-27]") stays authoritative for the verdict; only the regex and the roll's
  // sign need adjusting. Non-inverted selections are byte-for-byte unchanged.
  const matchDisplay = (s) =>
    s.entry && s.entry.inverted
      ? s.display.replace(/\bincreased\b/gi, 'reduced').replace(/\bmore\b/gi, 'less')
      : s.display;
  const compiled = sels.map((s) => ({ ...s, re: templateToRegex(matchDisplay(s)) }));

  const rows = document.querySelectorAll('.results .row, .resultset .row');
  const diag = [];
  if (DEBUG) {
    console.log(`[poe2tf §9] enabled. selections:`, compiled.map((s) =>
      `T${s.tier} "${s.display}" /${s.re.source}/`));
    console.log(`[poe2tf §9] rows matched by .results .row/.resultset .row = ${rows.length};` +
      ` .item-mod--explicit/--desecrated/--fractured page-wide = ${document.querySelectorAll('.item-mod--explicit, .item-mod--desecrated, .item-mod--fractured').length}`);
  }

  rows.forEach((row, ri) => {
    const lines = row.querySelectorAll('.item-mod--explicit, .item-mod--desecrated, .item-mod--fractured');
    lines.forEach((line) => {
      const text = squish(line.textContent);
      for (const s of compiled) {
        const m = s.re.exec(text);
        if (!m) continue;

        // Jewel (single-range) mods don't carry a tier — badge where the roll sits
        // in its range as a %. Prefer GGG's printed band; fall back to our snapshot
        // range when the result line has no bracket. Green/amber off the picked MIN.
        if (s.singleRange) {
          const jRanges = parseGggRanges(text) || (s.entry.tiers[0] && s.entry.tiers[0].ranges);
          const jRolls = parseRolls(m);
          const pct = jRanges ? rollPercentile(jRolls, jRanges) : null;
          if (pct == null) continue; // fixed band — nothing to grade
          badgeJewelLine(line, pct, s.min != null && jRolls[0] < s.min);
          break;
        }

        // GGG's own tier label + range, read straight off the result line.
        const ggg = parseGggTier(text);
        const ranges = parseGggRanges(text);
        // Inverted mods print a positive roll ("28% reduced") against a negative band
        // ([-29,-27]); flip the roll's sign so quality is graded on the same axis.
        const rolls = s.entry && s.entry.inverted ? parseRolls(m).map((v) => -v) : parseRolls(m);
        const quality = ggg && ranges ? rollQuality(rolls, ranges) : null;
        if (DEBUG) diag.push({ row: ri, target: `T${s.tier}`, gggTier: ggg ? `${ggg.affix}${ggg.tier}` : 'NONE', quality: quality || '', rolls: rolls.join('/'), text: text.slice(0, 44) });
        if (!ggg) continue; // no GGG tier label on this line → can't annotate accurately
        const isOff = ggg.tier > s.tier; // higher tier number = weaker than what you searched
        badgeLine(line, ggg.tier, quality, isOff);
        break; // one badge per line
      }
    });
  });

  if (DEBUG) {
    console.log(`[poe2tf §9] badged ${diag.length} line(s).`);
    if (diag.length && console.table) console.table(diag);
  }
}

// Run with the observer disconnected so our own badge/dim writes don't
// re-trigger the observer (which would loop).
function run() {
  if (obs) obs.disconnect();
  try { annotate(); } finally {
    if (obs) obs.observe(document.documentElement, { childList: true, subtree: true });
  }
}

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(run, 200);
}

// ── toggle pill — docked into the search-controls row, beside "Clear" ───────
function updateToggleLabel() {
  if (!toggleEl) return;
  // Constant-width label with an explicit status dot: filled green ● when on,
  // hollow gray ○ when off. The dot is the same width either way, so toggling
  // never resizes the button or wraps the search-controls row.
  toggleEl.textContent = '';
  toggleEl.appendChild(mk('span', `${NS}-dot`, enabled ? '●' : '○'));
  toggleEl.appendChild(document.createTextNode(' ≈ Tier badges'));
  toggleEl.classList.toggle('is-on', enabled);
}

// The native "Clear" button in the search-controls row (Search · Clear · Hide
// Filters). Found by text, preferring the one whose row also holds the search /
// hide-filters buttons, so we don't grab some other "Clear" elsewhere.
function findClearAnchor() {
  const clears = [...document.querySelectorAll('button')]
    .filter((b) => /^\s*clear\s*$/i.test(b.textContent || ''));
  return clears.find((b) => b.parentElement &&
    b.parentElement.querySelector('.search-btn, .toggle-search-btn, .livesearch-btn')) || clears[0] || null;
}

// The ⓘ legend that explains the badge colors/glyphs/dimming — a little key.
function buildLegend() {
  const info = document.createElement('span');
  info.className = `${NS}-legend`;
  info.tabIndex = 0;
  info.setAttribute('aria-label', 'tier badge legend');
  info.textContent = 'ⓘ';
  const tip = document.createElement('span');
  tip.className = `${NS}-legend-tip`;
  tip.appendChild(mk('div', `${NS}-legend-title`, 'Result tier badges'));
  const row = (boldEl, rest) => {
    const r = mk('div', `${NS}-legend-row`);
    r.appendChild(boldEl);
    r.appendChild(document.createTextNode(rest));
    tip.appendChild(r);
  };
  row(mk('b', `${NS}-lg-on`, '✓ ≈T1'), ' — meets the tier you searched (or better)');
  row(mk('b', `${NS}-lg-off`, '▼ ≈T2'), ' — below it: a lucky lower-tier roll');
  row(mk('span', `${NS}-lg-q`, '·low ·mid ·high'),
    ' — where the roll sits within its own tier (a high lower-tier roll is how it slipped past the filter)');
  row(mk('b', `${NS}-lg-on`, '✓ 82%'),
    ' — jewels: how far up the mod’s single range the roll sits (✓ meets your MIN, ▼ below)');
  info.appendChild(tip);
  return info;
}

function ensureToggle() {
  if (!document.body) return;
  if (!wrapEl) {
    toggleEl = document.createElement('button');
    toggleEl.type = 'button';
    toggleEl.id = `${NS}-results-toggle`;
    toggleEl.className = `${NS}-results-toggle`;
    toggleEl.title = 'Toggle tier-badge annotation on the results.';
    updateToggleLabel();
    toggleEl.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      enabled = !enabled;
      updateToggleLabel();
      run();
    });
    wrapEl = document.createElement('span');
    wrapEl.className = `${NS}-toggle-wrap`;
    wrapEl.appendChild(toggleEl);
    wrapEl.appendChild(buildLegend());
  }
  // Dock the button+legend just before "Clear" when we can find it; else float.
  const anchor = findClearAnchor();
  if (anchor && anchor.parentElement) {
    wrapEl.classList.add('is-docked');
    if (wrapEl.nextElementSibling !== anchor || wrapEl.parentElement !== anchor.parentElement) {
      anchor.parentElement.insertBefore(wrapEl, anchor);
    }
  } else {
    wrapEl.classList.remove('is-docked');
    if (wrapEl.parentElement !== document.body) document.body.appendChild(wrapEl);
  }
}

function updateToggleVisibility() {
  ensureToggle();
  if (!wrapEl) return;
  const hasResults = !!document.querySelector('.results .row, .resultset .row');
  const hasPick = getSelections().some((s) => s.tier != null);
  wrapEl.hidden = !(hasResults && hasPick);
}

export function initResults() {
  obs = new MutationObserver(schedule);
  obs.observe(document.documentElement, { childList: true, subtree: true });
  subscribe(schedule); // re-annotate when a tier pick changes
  run();
}
