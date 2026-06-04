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

// Short toggle label for a family. Weapon ladders collapse to 1H/2H; everything else
// (caster gear, armour bases, …) takes the first item-type of its coverage, with an
// ellipsis when the family spans more than one type. The full coverage shows on hover
// (button title = f.family). Handles both the generator's labels ("1-handed", "Staff",
// "Wand / Shield / Focus +2") and the older hand-snapshot ones ("1-handed + bow/crossbow").
function familyLabel(f) {
  const fam = (f.family || '').toLowerCase();
  if (/(^|\W)(2-hand|two-hand|2h)\b/.test(fam)) return '2H';
  if (/(^|\W)(1-hand|one-hand|1h)\b/.test(fam)) return '1H';
  const t = (f.types && f.types[0]) || fam || '?';
  const word = String(t).split(/[-\s]/)[0];
  const cap = word.charAt(0).toUpperCase() + word.slice(1);
  return f.types && f.types.length > 1 ? `${cap}…` : cap;
}

export function createTierControl({ families, family, ambiguous, minInput, computeAllTiers, onChange }) {
  let current = family;
  let selectedTier = null; // remembered across family swaps so MIN re-fills automatically
  let mode = 'inclusive'; // §11.8 threshold mode (per-control); default = inclusive

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

  // ── family toggle (only when ambiguous) ──────────────────────────────────
  if (ambiguous && families.length > 1) {
    const fam = document.createElement('span');
    fam.className = 'poe2tf-fam';
    families.forEach((f) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'poe2tf-fam-btn';
      b.textContent = familyLabel(f);
      b.title = f.family || '';
      if (f === current) b.classList.add('is-active');
      b.addEventListener('click', () => {
        current = f;
        fam.querySelectorAll('.poe2tf-fam-btn').forEach((x) => x.classList.toggle('is-active', x === b));
        rebuild();
      });
      fam.appendChild(b);
    });
    inner.appendChild(fam);
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

  function rebuild() {
    const tiers = computeAllTiers(current, mode);
    // Strict tightens MIN above every lower tier — shift the collapsed control
    // to the amber accent so the active mode is visible without opening the panel.
    root.classList.toggle('is-strict', mode === 'strict');
    panel.replaceChildren();

    // ── threshold-mode bar (header of the panel) ────────────────────────────
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

    tiers.forEach((t) => {
      const o = document.createElement('button');
      o.type = 'button';
      o.className = 'poe2tf-opt';
      o.append(
        mk('span', 'poe2tf-opt-tier', `≈ T${t.tier}`),
        mk('span', 'poe2tf-opt-min', `min ${fmtMin(t.min)}`),
      );
      o.addEventListener('click', () => select(t));
      panel.appendChild(o);
    });
    // Family or mode just changed — if a tier was already chosen, re-fill MIN
    // with this family/mode's value for the same tier (no need to reopen).
    if (selectedTier != null) {
      const match = tiers.find((t) => t.tier === selectedTier);
      if (match) {
        applyTier(match);
        return;
      }
    }
    updateTip(null);
  }

  function applyTier(t) {
    setNativeValue(minInput, t.min);
    label.textContent = `T${t.tier}`;
    root.classList.add('is-set');
    selectedTier = t.tier;
    updateTip(t);
    // Publish the pick (target tier + resolved family entry) for the §9 results
    // annotator. The target tier is mode-independent — Strict only changes MIN.
    if (onChange) onChange(current, t.tier);
  }

  function select(t) {
    applyTier(t);
    close();
  }

  function updateTip(t) {
    const modeLabel = (MODES.find((m) => m.key === mode) || MODES[0]).label;
    const note =
      mode === 'strict'
        ? 'Strict — MIN is raised above every lower tier’s top average, so ' +
          'lucky lower-tier rolls are excluded (may also drop a low-rolled T).'
        : '≈ approximate — adjacent tiers overlap, so a lucky lower-tier roll ' +
          'can slip past the filter. Switch to Strict to exclude them.';
    tip.textContent = '';
    tip.appendChild(mk('div', 'poe2tf-tip-title', current.display));
    if (current.family) tip.appendChild(mk('div', 'poe2tf-tip-fam', current.family));
    const modeRow = mk('div', 'poe2tf-tip-row');
    modeRow.appendChild(document.createTextNode('mode: '));
    modeRow.appendChild(mk('b', null, modeLabel));
    tip.appendChild(modeRow);
    if (t) {
      const d = mk('div', 'poe2tf-tip-row');
      d.appendChild(mk('b', null, `≈ T${t.tier}`));
      d.appendChild(document.createTextNode(` · fills MIN = ${fmtMin(t.min)}`));
      tip.appendChild(d);
      tip.appendChild(mk('div', 'poe2tf-tip-row', `rolls ${fmtRanges(t.ranges)}`));
    } else {
      tip.appendChild(mk('div', 'poe2tf-tip-row', 'Pick a tier to fill MIN.'));
    }
    tip.appendChild(mk('div', 'poe2tf-tip-note', note));
  }

  // ── open / close (fixed-position panel so the row never clips it) ──────────
  function reposition() {
    const r = btn.getBoundingClientRect();
    panel.style.left = `${Math.round(r.left)}px`;
    panel.style.top = `${Math.round(r.bottom + 4)}px`;
    panel.style.minWidth = `${Math.round(r.width)}px`;
  }
  function onDocDown(e) {
    if (!root.contains(e.target)) close();
  }
  function open() {
    reposition();
    panel.hidden = false;
    root.classList.add('is-open');
    document.addEventListener('mousedown', onDocDown, true);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close, true);
  }
  function close() {
    panel.hidden = true;
    root.classList.remove('is-open');
    document.removeEventListener('mousedown', onDocDown, true);
    window.removeEventListener('scroll', close, true);
    window.removeEventListener('resize', close, true);
  }
  btn.addEventListener('click', () => (panel.hidden ? open() : close()));

  rebuild();
  return root;
}
