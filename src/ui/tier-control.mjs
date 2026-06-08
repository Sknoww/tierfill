/*
 * The per-row tier control (§11.6, "Left of MIN (inline)" placement).
 *
 * Renders:  [1H|2H?]  ≈ TIER ▾   ⓘ
 *   • optional 1H/2H family toggle — only when the page didn't disambiguate
 *   • a custom dropdown (matches the site's dark small-caps theme; a native
 *     <select> would render an OS-styled option list and break the look)
 *   • a threshold-mode bar inside the dropdown panel (§11.8) — Inclusive |
 *     Strict, per-control, defaulting to Inclusive
 *   • an ⓘ tooltip: exact sub-ranges, the computed MIN, the active mode, and
 *     the overlap caveat
 *
 * Picking a tier writes the computed MIN into the row's first .minmax input via
 * the spike-confirmed native-setter + input/change/blur (PLAN §10). It never
 * triggers the search — the user still clicks the native Search button.
 *
 * Sign-flipped (`inverted`) stats — e.g. "increased Charges per use", where a good
 * roll is NEGATIVE — fill the row's MAX box instead, with the tier's least-negative
 * bound. That fork is localized to a few helpers; the MIN path is otherwise unchanged.
 *
 * §11.8 threshold modes (UI only; the math lives in compute.mjs):
 *   • Inclusive (default) — min = tier average floor; never misses a T, but a
 *     lucky lower-tier roll can slip past.
 *   • Strict — min raised just above every lower tier's max average, so results
 *     are genuinely ≥ T (drops low-rolled Ts).
 *   Exact-band (which also writes MAX) is intentionally NOT exposed here.
 */

// Threshold modes surfaced on the control, in display order. Keys match
// compute.mjs MODES; labels are the user-facing segment text.
const MODES = [
  { key: 'inclusive', label: 'Inclusive' },
  { key: 'strict', label: 'Strict' },
];

function setNativeValue(input, value) {
  const proto = window.HTMLInputElement && window.HTMLInputElement.prototype;
  const setter = proto && Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(input, String(value));
  else input.value = String(value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  input.dispatchEvent(new Event('blur', { bubbles: true }));
}

const fmtMin = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
const fmtRanges = (ranges) => ranges.map((p) => `${p[0]}–${p[1]}`).join('  /  ');

// Build an element with class + text via safe DOM APIs (no innerHTML). Our
// content is all controlled (numbers, fixed glyphs, our own snapshot text), but
// we avoid innerHTML so nothing can ever be parsed as markup.
function mk(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}

// ── family labelling ──────────────────────────────────────────────────────────
// Both labels derive from a family's `types` array (the reliable source), so the
// collapsed button and the open panel can never disagree:
//   • familyUmbrella() — the short collapsed label (a category umbrella, a single
//     item's name, or, for cross-category bundles, "LeadItem +N");
//   • familyTypeList() — the full, alphabetical item-type list shown in the panel.
// The generated `family` string is deliberately NOT used: it was inconsistent (a
// lone Wand showed as "1-handed"; crossbow/bow — TWO-handed per PoE2DB — broke some
// hand-class checks, so sibling ladders rendered one generic, one item-list).
//
// Categories follow PoE2DB's item tree (poe2db.tw/us/Items). Caster weapons
// (wand/sceptre/staff) are split from the martial weapons so the caster bundles
// read "Caster" rather than a hand-class.
const CASTER_WEAPONS = new Set(['wand', 'sceptre', 'staff']);
const MELEE_1H = new Set(['claw', 'dagger', 'one-hand-sword', 'one-hand-axe', 'one-hand-mace', 'spear', 'flail']);
const WEAPON_2H = new Set(['two-hand-sword', 'two-hand-axe', 'two-hand-mace', 'quarterstaff', 'bow', 'crossbow']);
const OFFHAND = new Set(['quiver', 'shield', 'buckler', 'focus']);
const ARMOUR = new Set(['gloves', 'boots', 'body-armour', 'helmet']);
const JEWELLERY = new Set(['amulet', 'ring', 'belt']);
const FLASKS = new Set(['life-flask', 'mana-flask', 'charm']);

function categoryOf(type) {
  if (CASTER_WEAPONS.has(type)) return 'caster';
  if (MELEE_1H.has(type)) return 'm1';
  if (WEAPON_2H.has(type)) return 'm2';
  if (OFFHAND.has(type)) return 'offhand';
  if (ARMOUR.has(type)) return 'armour';
  if (JEWELLERY.has(type)) return 'jewellery';
  if (FLASKS.has(type)) return 'flask';
  return 'other';
}

// "two-hand-sword" → "Two Hand Sword" (PoE2DB spelling: spaces, title-case).
function prettyType(type) {
  return String(type || '').replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// Alphabetical, prettified item-type list — the dropdown panel text.
export function familyTypeList(f) {
  return (f.types || []).map(prettyType).sort((a, b) => a.localeCompare(b));
}

// Short collapsed label. Single item → its name; a one-category bundle → that
// category's umbrella; a pure weapon bundle → One-/Two-Handed by majority; anything
// spanning incompatible categories → the alphabetically-first item + "+N".
export function familyUmbrella(f) {
  const types = f.types || [];
  if (types.length <= 1) return types.length ? prettyType(types[0]) : '?';
  const cats = new Set(types.map(categoryOf));

  // Caster: a caster weapon plus only its off-hand / jewellery companions.
  if (types.some((t) => CASTER_WEAPONS.has(t)) &&
      [...cats].every((c) => c === 'caster' || c === 'offhand' || c === 'jewellery')) {
    return 'Caster';
  }
  // Pure martial-weapon bundle → hand-class by majority. (Bow/crossbow are 2H but
  // ride the 1H ladder for some mods; the dropdown still shows the true list.)
  if ([...cats].every((c) => c === 'm1' || c === 'm2')) {
    const n2 = types.filter((t) => WEAPON_2H.has(t)).length;
    return n2 > types.length / 2 ? 'Two-Handed' : 'One-Handed';
  }
  if (cats.size === 1) {
    const only = [...cats][0];
    if (only === 'jewellery') return 'Jewellery';
    if (only === 'armour') return 'Armour';
    if (only === 'flask') return 'Flasks';
    if (only === 'offhand') return 'Off-hand';
  }
  // Armour plus its shield/off-hand companion still reads as Armour.
  if ([...cats].every((c) => c === 'armour' || c === 'offhand')) return 'Armour';

  // Cross-category bundle: alphabetically-first item + count of the rest.
  const sorted = familyTypeList(f);
  return `${sorted[0]} +${sorted.length - 1}`;
}

export function createTierControl({ families, family, ambiguous, minInput, maxInput, computeAllTiers, computeThresholds, onChange }) {
  let current = family;
  let selectedKey = null; // chosen option key, remembered across family swaps so MIN re-fills
  let mode = 'inclusive'; // §11.8 threshold mode (per-control); default = inclusive

  // Single-range (jewel) families don't tier — they carry one range that the picker
  // renders as percentile MIN presets instead of a tier ladder (see compute.mjs).
  const isSingle = (fam) => (fam.tiers || []).length === 1;

  // Sign-flipped mods (e.g. "increased Charges per use", where better = more negative)
  // fill the row's MAX box with a negative value; every normal mod fills MIN. These
  // helpers localize that fork so the rest of the control reads the same for both.
  const isInverted = () => !!current.inverted;
  const fillOf = (t) => (isInverted() ? t.max : t.min);
  const targetInput = () => (isInverted() ? maxInput : minInput) || minInput;
  const boxLabel = () => (isInverted() ? 'MAX' : 'MIN');

  // root is a table-cell (the stat row's .filter-body is display:table, so we
  // must be a real cell to get our own column left of MIN). `inner` holds the
  // actual flex layout; `panel` is fixed-position so it can live anywhere.
  const root = document.createElement('span');
  root.className = 'poe2tf-control';
  // Keep our clicks from reaching the row's own (clickable) title handler.
  root.addEventListener('mousedown', (e) => e.stopPropagation());
  root.addEventListener('click', (e) => e.stopPropagation());

  const inner = document.createElement('span');
  inner.className = 'poe2tf-inner';
  root.appendChild(inner);

  // ── family dropdown (item-type selector; was an inline 1H/2H button row) ────
  // Built whenever there's more than one ladder, but only shown while `ambiguous`
  // (the page couldn't disambiguate). Collapsed shows the short umbrella; each open
  // panel row shows that umbrella over its full item-type list. Keeping it built —
  // just hidden — lets the live re-resolve (index.mjs) flip it on/off in place.
  let famBtn = null;   // collapsed trigger
  let famPanel = null; // option list (fixed-position, like the tier panel)
  let famLabel = null; // short label inside the trigger
  if (families.length > 1) {
    famBtn = document.createElement('button');
    famBtn.type = 'button';
    famBtn.className = 'poe2tf-fam-dd';
    famLabel = mk('span', 'poe2tf-fam-dd-label', familyUmbrella(current));
    famBtn.append(famLabel, mk('span', 'poe2tf-caret', '▾'));
    famBtn.title = familyTypeList(current).join(', ');
    famBtn.hidden = !ambiguous;
    inner.appendChild(famBtn);

    famPanel = document.createElement('div');
    famPanel.className = 'poe2tf-panel poe2tf-fam-panel';
    famPanel.hidden = true;
    families.forEach((f) => {
      const o = document.createElement('button');
      o.type = 'button';
      o.className = 'poe2tf-fam-opt';
      o._famRef = f; // map option → family for active-state updates
      o.append(mk('span', 'poe2tf-fam-opt-name', familyUmbrella(f)));
      // Single-item families: the name already IS the item, so skip the redundant list.
      if ((f.types || []).length > 1) {
        o.append(mk('span', 'poe2tf-fam-opt-types', familyTypeList(f).join(', ')));
      }
      if (f === current) o.classList.add('is-active');
      o.addEventListener('click', () => selectFamily(f));
      famPanel.appendChild(o);
    });
    root.appendChild(famPanel);
  }

  // ── dropdown button ───────────────────────────────────────────────────────
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'poe2tf-dd-btn';
  const label = mk('span', 'poe2tf-label', 'TIER');
  btn.append(mk('span', 'poe2tf-approx', '≈'), label, mk('span', 'poe2tf-caret', '▾'));
  inner.appendChild(btn);

  // ── dropdown panel ──────────────────────────────────────────────────────────
  const panel = document.createElement('div');
  panel.className = 'poe2tf-panel';
  panel.hidden = true;
  root.appendChild(panel);

  // ── info tooltip ─────────────────────────────────────────────────────────────
  const info = document.createElement('span');
  info.className = 'poe2tf-info';
  info.tabIndex = 0;
  info.setAttribute('aria-label', 'tier details');
  info.textContent = 'ⓘ';
  const tip = document.createElement('span');
  tip.className = 'poe2tf-tip';
  info.appendChild(tip);
  inner.appendChild(info);

  // Build the panel's option list as a uniform shape so select/apply/re-fill don't
  // care whether they're driving a tier ladder or a jewel percentile range:
  //   { key, fill, badge, ranges, tier?, pct?, range? }
  //     • key   — stable id used to re-apply the same pick after a family/mode swap
  //     • fill  — the value written into the row's MIN (or MAX, when inverted)
  //     • badge — the collapsed control's label once picked (e.g. "T3", "75%")
  function buildOptions() {
    if (isSingle(current)) {
      // Reversed to Max→Min so the BEST roll sits at the top, matching the tier
      // ladder (T1 best-first). computeThresholds stays canonical ascending.
      return computeThresholds(current).map((t) => ({
        key: `p${t.pct}`,
        fill: t.min,
        badge: t.label,
        pct: t.pct,
        range: t.range,
      })).reverse();
    }
    return computeAllTiers(current, mode).map((t) => ({
      key: `t${t.tier}`,
      fill: fillOf(t),
      badge: `T${t.tier}`,
      tier: t.tier,
      ranges: t.ranges,
    }));
  }

  function rebuild() {
    const single = isSingle(current);
    const options = buildOptions();
    // Strict tightens MIN above every lower tier — shift the collapsed control to the
    // amber accent so the active mode is visible without opening the panel. Jewels
    // have no Strict/Inclusive distinction, so never accent them.
    root.classList.toggle('is-strict', !single && mode === 'strict');
    root.classList.toggle('is-single', single);
    panel.replaceChildren();

    // ── threshold-mode bar (header of the panel) — tiered ladders only ──────────
    // A single-range jewel mod has one band, so Inclusive vs Strict is meaningless;
    // omit the bar entirely for it.
    if (!single) {
      const modeBar = document.createElement('div');
      modeBar.className = 'poe2tf-mode';
      MODES.forEach((m) => {
        const mb = document.createElement('button');
        mb.type = 'button';
        mb.className = 'poe2tf-mode-btn';
        mb.textContent = m.label;
        mb.classList.add(`poe2tf-mode-btn--${m.key}`);
        if (m.key === mode) mb.classList.add('is-active');
        mb.addEventListener('click', () => {
          if (mode === m.key) return;
          mode = m.key;
          rebuild(); // recompute mins for the new mode; re-fills MIN if a tier is set
        });
        modeBar.appendChild(mb);
      });
      panel.appendChild(modeBar);
    }

    options.forEach((o) => {
      const opt = document.createElement('button');
      opt.type = 'button';
      opt.className = 'poe2tf-opt';
      // Jewels read "75% · min 17"; tiers read "≈ T3 · min 42".
      opt.append(
        mk('span', 'poe2tf-opt-tier', single ? o.badge : `≈ ${o.badge}`),
        mk('span', 'poe2tf-opt-min', `${boxLabel().toLowerCase()} ${fmtMin(o.fill)}`),
      );
      opt.addEventListener('click', () => select(o));
      panel.appendChild(opt);
    });
    // Family or mode just changed — if an option was already chosen, re-fill MIN with
    // this family/mode's value for the same option key (no need to reopen).
    if (selectedKey != null) {
      const match = options.find((o) => o.key === selectedKey);
      if (match) {
        applyOption(match);
        return;
      }
    }
    // Nothing applied (first render, or a pick that doesn't carry across a gear↔jewel
    // swap) — reset the collapsed control to its placeholder. `selectedKey` is kept so
    // toggling back to the original family still re-applies the remembered pick.
    label.textContent = single ? 'ROLL' : 'TIER';
    root.classList.remove('is-set');
    updateTip(null);
  }

  function applyOption(o) {
    setNativeValue(targetInput(), o.fill);
    label.textContent = o.badge;
    root.classList.add('is-set');
    selectedKey = o.key;
    updateTip(o);
    // Publish the pick for the §9 results annotator. Tiered mods carry their target
    // tier (mode-independent — Strict only changes MIN); jewels carry the picked MIN
    // and percentile and flag themselves single-range so results badge roll quality.
    if (onChange) {
      onChange(current, o.pct != null
        ? { tier: 1, singleRange: true, min: o.fill, pct: o.pct }
        : { tier: o.tier });
    }
  }

  function select(o) {
    applyOption(o);
    tierDd.close();
  }

  function updateTip(o) {
    const single = isSingle(current);
    tip.textContent = '';
    tip.appendChild(mk('div', 'poe2tf-tip-title', current.display));
    if (current.types && current.types.length) {
      tip.appendChild(mk('div', 'poe2tf-tip-fam', familyTypeList(current).join(', ')));
    }
    if (current._note) tip.appendChild(mk('div', 'poe2tf-tip-affix', current._note));

    // Mode (Inclusive/Strict) only applies to tier ladders, not single-range jewels.
    if (!single) {
      const modeLabel = (MODES.find((m) => m.key === mode) || MODES[0]).label;
      const modeRow = mk('div', 'poe2tf-tip-row');
      modeRow.appendChild(document.createTextNode('mode: '));
      modeRow.appendChild(mk('b', null, modeLabel));
      tip.appendChild(modeRow);
    }

    if (o) {
      const d = mk('div', 'poe2tf-tip-row');
      d.appendChild(mk('b', null, single ? o.badge : `≈ ${o.badge}`));
      d.appendChild(document.createTextNode(` · fills ${boxLabel()} = ${fmtMin(o.fill)}`));
      tip.appendChild(d);
      tip.appendChild(mk('div', 'poe2tf-tip-row',
        single ? `range ${o.range[0]}–${o.range[1]}` : `rolls ${fmtRanges(o.ranges)}`));
    } else {
      tip.appendChild(mk('div', 'poe2tf-tip-row',
        single ? `Pick a roll % to fill ${boxLabel()}.` : `Pick a tier to fill ${boxLabel()}.`));
    }

    const note = single
      ? '≈ percentile cuts of this jewel mod’s single roll range — pick a higher % ' +
        'for a better-rolled jewel.'
      : mode === 'strict'
        ? 'Strict — MIN is raised above every lower tier’s top average, so ' +
          'lucky lower-tier rolls are excluded (may also drop a low-rolled T).'
        : '≈ approximate — adjacent tiers overlap, so a lucky lower-tier roll ' +
          'can slip past the filter. Switch to Strict to exclude them.';
    tip.appendChild(mk('div', 'poe2tf-tip-note', note));
  }

  // ── dropdown open/close (fixed-position panels so the row never clips them) ─
  // Shared by the tier dropdown and the family dropdown; opening one closes the
  // other. Each panel is re-anchored to its trigger on open, and a click outside
  // the whole control (or any scroll/resize) closes it.
  const dropdowns = [];
  function makeDropdown(trigger, panelEl) {
    function reposition() {
      const r = trigger.getBoundingClientRect();
      panelEl.style.left = `${Math.round(r.left)}px`;
      panelEl.style.top = `${Math.round(r.bottom + 4)}px`;
      panelEl.style.minWidth = `${Math.round(r.width)}px`;
    }
    function onDocDown(e) {
      if (!root.contains(e.target)) close();
    }
    // A scroll of the PAGE detaches the fixed panel from its trigger, so close it —
    // but ignore the panel's OWN scrolling (dragging its scrollbar or wheeling a long
    // list), which is capture-phase too and would otherwise snap it shut mid-drag.
    function onScroll(e) {
      if (!panelEl.contains(e.target)) close();
    }
    function open() {
      dropdowns.forEach((d) => d.close !== close && d.close()); // close the sibling
      reposition();
      panelEl.hidden = false;
      trigger.classList.add('is-open');
      document.addEventListener('mousedown', onDocDown, true);
      window.addEventListener('scroll', onScroll, true);
      window.addEventListener('resize', close, true);
    }
    function close() {
      panelEl.hidden = true;
      trigger.classList.remove('is-open');
      document.removeEventListener('mousedown', onDocDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', close, true);
    }
    function toggle() { panelEl.hidden ? open() : close(); }
    const api = { open, close, toggle };
    dropdowns.push(api);
    trigger.addEventListener('click', toggle);
    return api;
  }

  const tierDd = makeDropdown(btn, panel);
  const famDd = famBtn ? makeDropdown(famBtn, famPanel) : null;

  // Picking a family from the dropdown: swap the active ladder, refresh the
  // collapsed label + active marker, then rebuild (re-fills MIN for the same tier).
  function selectFamily(f) {
    current = f;
    syncFamilyUi();
    if (famDd) famDd.close();
    rebuild();
  }
  function syncFamilyUi() {
    if (!famBtn) return;
    famLabel.textContent = familyUmbrella(current);
    famBtn.title = familyTypeList(current).join(', ');
    famPanel.querySelectorAll('.poe2tf-fam-opt').forEach((o) =>
      o.classList.toggle('is-active', o._famRef === current));
  }

  // ── live re-resolve (index.mjs) ───────────────────────────────────────────
  // Called when the page's item-type context changes without the stat itself
  // changing (e.g. the user picks a category after adding the stat filter). Swaps
  // the active ladder + toggle visibility in place, preserving the chosen tier:
  // rebuild() re-fills MIN with the new family's value for the same tier.
  function update(newFamily, newAmbiguous) {
    current = newFamily || current;
    ambiguous = newAmbiguous;
    if (famBtn) {
      famBtn.hidden = !(ambiguous && families.length > 1);
      syncFamilyUi();
    }
    rebuild();
  }

  rebuild();
  return { root, update };
}
