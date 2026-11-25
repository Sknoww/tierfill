/*
 * PoE2 Tier Filter — Spike 2 content script (isolated world)
 * -------------------------------------------------------------------------
 * Goal (PLAN.md §11.3): prove a way to ADD a stat filter without firing a
 * search on every add (rate-limit safe), and decide between:
 *   • Track A — drive the Angular autocomplete UI (add a real stat row in place)
 *   • Track B — manipulate the AngularJS scope directly (via the page-world helper)
 *   • Track C — build a `?q=` URL and navigate once (PoB's method; one search)
 *
 * The linchpin is the SEARCH MONITOR (in spike2-page.js): it passively counts
 * every `POST …/api/trade2/search/…` the page makes, so each action below can
 * report "did this fire a search?" — the direct answer to the rate-limit worry.
 *
 * Throwaway probe. Everything namespaced `poe2tf-`. Nothing here POSTs anything.
 */
(() => {
  'use strict';
  const NS = 'poe2tf';
  const log = (...a) => console.log('%c[poe2tf-spike2]', 'color:#6cf', ...a);

  // Live mirror of the page-world monitor. The page helper (spike2-page.js)
  // runs as a MAIN-world content script (see manifest) and is installed at
  // document_start, so its search monitor is armed before any page request.

  const mon = { count: 0, lastQuery: null };
  let statusEl = null;

  // ---- Talk to the page-world helper -------------------------------------
  const toPage = (cmd, payload) => window.postMessage({ source: 'poe2tf-cs', cmd, payload }, '*');

  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (!d || d.source !== 'poe2tf-page') return;
    switch (d.type) {
      case 'ready':
        log(`page helper ready. angular present: ${d.angular}`);
        setStatus(`monitor armed (angular: ${d.angular})`);
        break;
      case 'search':
      case 'monitor':
        mon.count = d.count != null ? d.count : mon.count;
        if (d.query) mon.lastQuery = d.query;
        if (d.auditTotal != null) renderAudit(d.auditTotal);
        renderMonitor();
        if (d.type === 'search') log(`⚠ SEARCH FIRED (total ${d.count})`, d.url);
        break;
      case 'fetch':
        if (d.auditTotal != null) renderAudit(d.auditTotal);
        break;
      case 'auditExport': {
        const league = leaguePathFromLocation() || 'unknown';
        const obs = d.observations || [];
        downloadJson('ggg-audit-capture.json', {
          _kind: 'poe2tf-ggg-audit-capture',
          _league: league,
          _count: obs.length,
          observations: obs,
        });
        log(`§10 exported ${obs.length} GGG tier band(s) → ggg-audit-capture.json`);
        setStatus(`exported ${obs.length} tier bands (downloaded)`);
        break;
      }
      case 'scope':
        log('scope dump →', d.result);
        setStatus('scope dumped (see console)');
        break;
      case 'logged':
        log('page logged', d.what, '(see console)');
        break;
      case 'error':
        log('page error:', d.error);
        break;
    }
  });

  // ---- Shared: AngularJS-safe value write (from Spike 1) ------------------
  function setNativeValue(input, value) {
    const proto = Object.getPrototypeOf(input);
    const protoDesc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    const ownDesc = Object.getOwnPropertyDescriptor(proto, 'value');
    const setter = (ownDesc && ownDesc.set && ownDesc.set !== protoDesc.set) ? ownDesc.set : (protoDesc && protoDesc.set);
    if (setter) setter.call(input, String(value)); else input.value = String(value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  // ---- TRACK A: drive the "add stat" autocomplete ------------------------
  // The add-stat box is an Angular typeahead. We don't know its exact selector
  // yet, so first SCAN to find candidate text inputs by placeholder, then try.
  function scanAddStatInputs() {
    const inputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type])'));
    const rows = inputs.map((el, i) => ({
      i, ph: el.getAttribute('placeholder') || '', cls: el.className,
      vis: el.offsetParent !== null,
    }));
    log('--- add-stat input candidates (look for placeholder like "+ Add Stat Filter") ---');
    rows.forEach((r) => log(`  [${r.i}] ph="${r.ph}" vis=${r.vis} cls="${r.cls}"`));
    window[`__${NS}_inputs`] = inputs;
    setStatus(`scanned ${inputs.length} text inputs (see console)`);
    return inputs;
  }

  // Try: set the chosen input's value, fire the typeahead, click the first
  // matching option. Records search-count delta so we see if it auto-searches.
  async function tryAutocompleteAdd(inputIdx, text) {
    const inputs = window[`__${NS}_inputs`] || scanAddStatInputs();
    const box = inputs[inputIdx];
    if (!box) { log(`no input at idx ${inputIdx}`); return; }
    const before = mon.count;
    box.focus();
    setNativeValue(box, text);
    box.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: text.slice(-1) }));
    box.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: text.slice(-1) }));
    log(`typed "${text}" into input[${inputIdx}]; waiting for dropdown…`);
    await sleep(500);
    // trade2 uses vue-multiselect. The clickable option is `.multiselect__option`.
    const opts = Array.from(document.querySelectorAll('.multiselect__option'))
      .filter((o) => o.offsetParent !== null);
    log(`dropdown candidates: ${opts.length}`);
    const norm = (s) => (s || '').toLowerCase().trim();
    const want = norm(text);
    // Prefer a real (explicit/implicit) match over the "pseudo" group entries.
    const matches = opts.filter((o) => norm(o.textContent).includes(want));
    const match = matches.find((o) => !norm(o.textContent).startsWith('pseudo')) || matches[0];
    if (!match) { log('no matching option — refine the search text or selector.'); reportDelta('Track A', before); return; }
    log(`selecting option "${(match.textContent || '').trim().slice(0, 60)}" via mousedown (vue-multiselect)`);
    // vue-multiselect selects on mousedown (it prevents click to keep focus).
    ['pointerdown', 'mousedown', 'mouseup', 'click'].forEach((type) =>
      match.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window })));
    await sleep(400);
    const rows = document.querySelectorAll('.filter .filter-title, .search-advanced-pane .filter');
    log(`stat-filter rows now present: ${rows.length} (verify the new row was added)`);
    reportDelta('Track A (autocomplete add)', before);
  }

  // ---- TRACK B: add via Angular scope (page world) -----------------------
  function dumpScope(selector) { toPage('dumpScope', { selector }); }

  // ---- TRACK C: build a `?q=` URL and navigate once ----------------------
  // Uses the last query the monitor captured from a real manual search as the
  // base (so existing filters are preserved), tweaks/append a stat min, then
  // navigates exactly once.
  function leaguePathFromLocation() {
    // e.g. /trade2/search/poe2/Standard  → "poe2/Standard"
    const m = location.pathname.match(/\/trade2\/search\/([^/]+)\/([^/]+)/i);
    return m ? `${m[1]}/${m[2]}` : null;
  }

  function buildQUrl(queryObj) {
    const lp = leaguePathFromLocation();
    if (!lp) { log('could not parse realm/league from URL — open a /trade2/search/poe2/<league> page first.'); return null; }
    const json = JSON.stringify(queryObj);
    return `${location.origin}/trade2/search/${lp}?q=${encodeURIComponent(json)}`;
  }

  // Take the captured query, bump the first stat filter's min (or build a
  // minimal one) and produce a navigable URL — WITHOUT navigating yet.
  function previewQFromCapture(testMin) {
    const base = mon.lastQuery;
    if (!base) { log('No captured query yet. Run a manual single-stat search first so the monitor captures it.'); return null; }
    const clone = JSON.parse(JSON.stringify(base));
    try {
      const f = clone.query.stats[0].filters[0];
      f.value = Object.assign({}, f.value, { min: Number(testMin) });
      log(`preview: set stats[0].filters[0].value.min = ${testMin} on stat id "${f.id}"`);
    } catch (e) {
      log('captured query has no stats[0].filters[0] to tweak:', e);
    }
    const url = buildQUrl(clone);
    log('built ?q= URL (NOT navigated):', url);
    window[`__${NS}_lastUrl`] = url;
    setStatus('built ?q= URL (console). Click "Navigate q=" to load it.');
    return url;
  }

  function navigateLastUrl() {
    const url = window[`__${NS}_lastUrl`];
    if (!url) { log('No URL built yet — click "Build q=" first.'); return; }
    const before = mon.count;
    log(`navigating to ?q= URL (expect exactly ONE search). count before = ${before}`);
    location.href = url;
  }

  // ---- ITEM-TYPE PROBE (PLAN §11.4 / FINDINGS §4) -------------------------
  // Detect the searched item, LIVE and without firing a search, from the DOM
  // (the source the real picker will use), then cross-check against the
  // captured query JSON (ground truth via the search monitor). Two constraint
  // inputs must both be handled:
  //   (1) specific item typed into "Search Items..."  → query.name / query.type
  //   (2) generic category in the Type Filters dropdown → query.filters.type_filters
  // The picker needs whichever is set (or neither/both) to scope the mod list.

  // Read the selected value of a vue-multiselect. trade2 uses TWO renderings:
  //   • status/league selects → selection lives in `.multiselect__single`
  //   • Type Filters selects   → selection shown as the input `placeholder`,
  //                              with a `modified` class flagging "changed from default"
  function readMultiselectValue(ms) {
    if (!ms) return null;
    const single = ms.querySelector('.multiselect__single');
    const sTxt = single ? (single.textContent || '').trim() : '';
    if (sTxt) return sTxt;
    // Only the Type Filters (`filter-select`) selects render the CHOSEN option as
    // the input placeholder + a `modified` class. The search-select's placeholder
    // ("Search Items...") is a static hint, NOT a value — don't read it here.
    if (ms.classList.contains('filter-select') && ms.classList.contains('modified')) {
      const input = ms.querySelector('.multiselect__input');
      const ph = input ? (input.getAttribute('placeholder') || '').trim() : '';
      if (ph) return ph;
    }
    return null;
  }
  // Raw bits behind the value — for the probe dump so we can verify the rendering.
  function rawMultiselectBits(ms) {
    if (!ms) return null;
    const single = ms.querySelector('.multiselect__single');
    const input = ms.querySelector('.multiselect__input');
    return {
      single: single ? (single.textContent || '').trim() || null : null,
      placeholder: input ? input.getAttribute('placeholder') : null,
      typed: input ? (input.value || '') : null,   // live text being typed (uncommitted)
      modified: ms.classList.contains('modified'),
    };
  }

  // -- search bar (specific item → name/type) --
  function searchBarInput() {
    return document.querySelector('input[placeholder="Search Items..." i]');
  }
  function readSearchBarSelection() {
    const inp = searchBarInput();
    if (!inp) return { found: false, selected: null };
    const ms = inp.closest('.multiselect');
    // search-select keeps a STATIC placeholder ("Search Items..."); the committed
    // item lands in the input's `.value` and the widget gets a `modified` class.
    const single = ms && ms.querySelector('.multiselect__single');
    const sTxt = single ? (single.textContent || '').trim() : '';
    let selected = sTxt || null;
    if (!selected && ms && ms.classList.contains('modified')) {
      const v = (inp.value || '').trim();
      if (v) selected = v;   // NB: also reflects mid-typing text (uncommitted)
    }
    return { found: true, selected, container: ms ? ms.className : null, raw: rawMultiselectBits(ms) };
  }

  // -- Type Filters group (generic category/rarity → filters.type_filters) --
  // Best-effort: find a leaf element whose text is exactly "Type Filters", then
  // climb to the nearest ancestor that actually contains a .multiselect — that
  // ancestor is the group container holding Category / Rarity / etc.
  function findTypeFiltersGroup() {
    const candidates = Array.from(document.querySelectorAll('*')).filter((el) => {
      if (el.children.length > 2) return false;            // want a label-ish leaf
      return /^type filters$/i.test((el.textContent || '').trim());
    });
    for (const title of candidates) {
      let node = title.parentElement;
      for (let up = 0; up < 5 && node; up++, node = node.parentElement) {
        if (node.querySelector('.multiselect')) return node;
      }
    }
    return null;
  }
  // Guess a label for a multiselect by walking preceding siblings up the row.
  function guessLabel(ms) {
    let prev = ms.previousElementSibling;
    while (prev) {
      const t = (prev.textContent || '').trim();
      if (t && t.length < 40) return t;
      prev = prev.previousElementSibling;
    }
    const row = ms.closest('.filter, [class*="filter"]');
    const title = row && row.querySelector('.filter-title, [class*="title"]');
    return title ? (title.textContent || '').trim() : null;
  }
  function readTypeFiltersSelections(group) {
    if (!group) return [];
    return Array.from(group.querySelectorAll('.multiselect')).map((ms, i) => ({
      i,
      label: guessLabel(ms),
      value: readMultiselectValue(ms),
      raw: rawMultiselectBits(ms),
      cls: ms.className,
    }));
  }

  // Exploratory: every multiselect on the page that currently has a selection
  // (either rendering). Surfaces the search bar + type filters regardless of
  // grouping (also catches stat-filter multiselects — useful for eyeballing).
  function scanSelectedMultiselects() {
    return Array.from(document.querySelectorAll('.multiselect')).map((ms, i) => {
      const val = readMultiselectValue(ms);
      if (!val) return null;
      return { i, value: val, label: guessLabel(ms), cls: ms.className };
    }).filter(Boolean);
  }

  // -- captured query JSON cross-check (ground truth) --
  function readQueryItem() {
    const q = mon.lastQuery && mon.lastQuery.query;
    if (!q) return null;
    return {
      name: q.name != null ? q.name : null,
      type: q.type != null ? q.type : null,
      type_filters: (q.filters && q.filters.type_filters) || null,
    };
  }

  // -- short summary used by the live readout --
  function currentItemSummary() {
    const bar = readSearchBarSelection();
    const tf = readTypeFiltersSelections(findTypeFiltersGroup()).filter((x) => x.value);
    const tfStr = tf.length ? tf.map((x) => `${x.label || '?'}=${x.value}`).join(', ') : '—';
    return `item: ${bar.selected || '—'} · type filters: ${tfStr}`;
  }

  // -- the consolidated, on-demand probe --
  function probeItemType() {
    log('%c=== Item-type probe ===', 'color:#fc9;font-weight:bold');

    const bar = readSearchBarSelection();
    log('[DOM] Search bar  selector=input[placeholder="Search Items..." i]',
      `found=${bar.found} selected=${JSON.stringify(bar.selected)} container="${bar.container || ''}" raw=`, bar.raw);

    const group = findTypeFiltersGroup();
    const tf = readTypeFiltersSelections(group);
    log(`[DOM] Type Filters group: ${group ? 'FOUND' : 'NOT FOUND'}; ${tf.length} multiselect(s) inside:`);
    tf.forEach((r) => log(`   [${r.i}] label="${r.label || ''}" value=${JSON.stringify(r.value)} cls="${r.cls}" raw=`, r.raw));

    const sel = scanSelectedMultiselects();
    log(`[DOM] All currently-selected multiselects on page: ${sel.length}`);
    sel.forEach((r) => log(`   [${r.i}] "${r.value}" (label="${r.label || ''}" cls="${r.cls}")`));

    const q = readQueryItem();
    if (q) {
      log('[QUERY] from captured query JSON:',
        `name=${JSON.stringify(q.name)} type=${JSON.stringify(q.type)}`);
      log('[QUERY] query.filters.type_filters =', JSON.stringify(q.type_filters));
    } else {
      log('[QUERY] no captured query yet — run a manual search first to populate the JSON cross-check.');
    }

    // Informal agreement note (DOM-first is what the picker will use).
    const domItem = bar.selected;
    const qItem = q && (q.name || q.type);
    if (q) {
      log(`[CHECK] DOM item="${domItem || '—'}" vs query name/type="${qItem || '—'}"` +
        (domItem && qItem ? (String(qItem).includes(domItem) || domItem.includes(String(qItem)) ? ' (consistent)' : ' (⚠ differ — inspect)') : ''));
    }
    setStatus(`item probe: ${currentItemSummary()}`);
    updateItemReadout();
  }

  // ---- STAT-FILTER GROUP PROBE (PLAN §11.4 leftover) ---------------------
  // Find the container holding the ADDED STAT ROWS (anchored on the "+ Add Stat
  // Filter" control), distinct from the [0]–[36] property panel (FINDINGS §1),
  // so the real extension can scope row injection + read each row's stat text.
  function addStatControls() {
    return Array.from(document.querySelectorAll('input.multiselect__input'))
      .filter((el) => /\+\s*add stat/i.test(el.getAttribute('placeholder') || ''));
  }
  function elDesc(el) {
    if (!el) return '(none)';
    const cls = (el.getAttribute && el.getAttribute('class')) || '';
    return `${el.tagName.toLowerCase()}${cls ? '.' + cls.trim().split(/\s+/).join('.') : ''}`;
  }
  const minSel = 'input.minmax, input[placeholder="min" i]';
  function ancestorChain(el, depth) {
    const out = [];
    let n = el;
    for (let i = 0; i < depth && n; i++, n = n.parentElement) {
      out.push({
        i,
        desc: elDesc(n),
        ms: n.querySelectorAll('.multiselect').length,
        minmax: n.querySelectorAll(minSel).length,
      });
    }
    return out;
  }
  function minBoxBreadcrumbs() {
    return Array.from(document.querySelectorAll(minSel)).map((b, i) => {
      const parts = [];
      let n = b.parentElement;
      for (let k = 0; k < 4 && n; k++, n = n.parentElement) parts.push(elDesc(n));
      return { i, ph: b.getAttribute('placeholder'), crumb: parts.join(' < ') };
    });
  }
  // Anchor: the stats group is the .filter-group that contains "+ Add Stat Filter".
  function findStatsGroup() {
    const add = document.querySelector('input.multiselect__input[placeholder="+ Add Stat Filter" i]');
    return add ? add.closest('.filter-group') : null;
  }
  // Dump each .filter row inside the stats group, flagging add-control vs stat row,
  // and reading the stat-name multiselect + min/max inputs per row.
  function dumpStatRows(group) {
    if (!group) { log('[ROWS] no stats group found.'); return; }
    log(`[ROWS] stats group = ${elDesc(group)}`);
    const rows = Array.from(group.querySelectorAll('.filter'));
    rows.forEach((row, i) => {
      const isProp = row.classList.contains('filter-property');
      const isAddCtl = !!row.querySelector('.filter-select-mutate, .filter-group-select');
      const isStatRow = row.classList.contains('full-span') && !isProp && !isAddCtl;
      const mins = row.querySelectorAll(minSel).length;
      const kind = isAddCtl ? 'ADD-CTL' : isProp ? 'property' : isStatRow ? 'STAT-ROW' : 'other';
      log(`   [${i}] ${kind} ${elDesc(row)} minmax:${mins} text="${(row.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 70)}"`);
      if (isStatRow) {
        const mss = Array.from(row.querySelectorAll('.multiselect'));
        if (mss.length) {
          mss.forEach((ms, j) => log(`        ms[${j}] ${elDesc(ms)} raw=`, rawMultiselectBits(ms)));
        } else {
          log('        (no .multiselect — stat rendered as text; dumping 2-level element tree)');
          Array.from(row.children).forEach((c) => {
            const t = (c.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 45);
            log(`        ├ ${elDesc(c)} text="${t}"`);
            Array.from(c.children).forEach((g) => {
              const gt = (g.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 45);
              log(`        │  └ ${elDesc(g)} text="${gt}"`);
            });
          });
        }
      }
    });
  }
  function probeStatGroup() {
    log('%c=== Stat-group probe ===', 'color:#fc9;font-weight:bold');
    const adds = addStatControls();
    log(`[ADD] "+ Add Stat …" controls: ${adds.length}`);
    adds.forEach((el, i) => log(`   [${i}] ph="${el.getAttribute('placeholder')}" container=${elDesc(el.closest('.multiselect'))}`));
    if (adds.length) {
      log('[ANCESTRY] of first add-stat control (group container = where .minmax count rises but property panel is excluded):');
      ancestorChain(adds[0], 8).forEach((a) => log(`   ^${a.i} ${a.desc}  (multiselect:${a.ms} minmax:${a.minmax})`));
    } else {
      log('   (none found — is the search panel expanded? toggle-search-btn)');
    }
    dumpStatRows(findStatsGroup());
    setStatus(`stat-group probe: ${adds.length} add-control(s) (see console)`);
  }

  // ---- RESULTS PROBE (§9 / §7b post-filter) ------------------------------
  // The §7b annotator needs three live facts the PLAN only has from
  // better-trading's source (UNVERIFIED on PoE2): (a) the repeating result-row
  // container, (b) the explicit-mod line node + its class (badge injection
  // point), (c) the exact mod text so the `Adds # to #` → capture regex is
  // right. We find a real "Adds X to Y" line by CONTENT (class-independent),
  // then report its class + ancestor chain. Run on an open search WITH results.
  function probeResults() {
    log('%c=== Results probe (§9) ===', 'color:#fc9;font-weight:bold');

    // (a) which candidate mod-line selectors actually hit on PoE2.
    const MOD_SELECTORS = [
      '.explicitMod', '.pseudoMod', '.implicitMod', '.craftedMod',
      '.enchantMod', '.fracturedMod', '.runeMod', '[class*="Mod" i]',
    ];
    log('[SEL] candidate mod-line selectors that match:');
    let anyHit = false;
    MOD_SELECTORS.forEach((sel) => {
      const n = document.querySelectorAll(sel).length;
      if (n) { anyHit = true; log(`   ${sel} → ${n} node(s)`); }
    });
    if (!anyHit) log('   (none of the better-trading selectors matched — content probe below is authoritative)');

    // (b) find a flat-damage mod line by content — independent of class names.
    const re = /adds\s+\d+\s+to\s+\d+/i;
    const leaf = Array.from(document.querySelectorAll('span, div, p')).find(
      (el) => re.test(el.textContent || '') &&
        el.querySelectorAll('*').length <= 3 &&
        (el.textContent || '').trim().length < 90,
    );
    if (!leaf) {
      log('[HIT] no "Adds X to Y" mod line found. Open a search returning a');
      log('      flat-damage mod (e.g. Adds # to # Fire Damage) with results, then retry.');
      setStatus('results probe: no "Adds X to Y" line (open a search with results)');
      return;
    }
    log(`[HIT] mod line: ${elDesc(leaf)}  text="${leaf.textContent.trim()}"`);

    // (c) ancestor chain — reveals the repeating result-row container.
    log('[CHAIN] mod line → up (look for where one listing repeats):');
    let n = leaf;
    for (let d = 0; d < 9 && n; d++, n = n.parentElement) {
      log(`   ^${d} ${elDesc(n)}`);
    }

    // (d) how many lines share the leaf's class = injection-target count.
    const raw = (leaf.className || '').toString().trim();
    if (raw) {
      const sel = '.' + raw.split(/\s+/).join('.');
      log(`[SEL] leaf class "${sel}" → ${document.querySelectorAll(sel).length} node(s) page-wide`);
    } else {
      log('[SEL] leaf has NO class — we will match mod lines by text content instead.');
    }
    window[`__${NS}_resLeaf`] = leaf; // expose for manual console poking
    setStatus('results probe done (paste console block into FINDINGS §9)');
  }

  // -- live readout: update as the user changes constraints (no search) --
  function updateItemReadout() {
    const el = document.getElementById(`${NS}-item`);
    if (el) el.textContent = `detected: ${currentItemSummary()}`;
  }
  let itemTimer = null;
  function startItemObserver() {
    const obs = new MutationObserver(() => {
      clearTimeout(itemTimer);
      itemTimer = setTimeout(updateItemReadout, 300);
    });
    obs.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    updateItemReadout();
  }

  // ---- helpers ------------------------------------------------------------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function reportDelta(label, before) {
    const delta = mon.count - before;
    const verdict = delta === 0 ? '✅ NO search fired (rate-limit safe)' : `⚠ fired ${delta} search(es)`;
    log(`${label}: ${verdict} (count ${before} → ${mon.count})`);
    setStatus(`${label}: ${verdict}`);
  }
  function setStatus(t) { if (statusEl) statusEl.textContent = t; }
  function renderMonitor() {
    const el = document.getElementById(`${NS}-mon`);
    if (el) el.textContent = `searches fired: ${mon.count} · captured query: ${mon.lastQuery ? 'yes' : 'no'}`;
  }
  function renderAudit(total) {
    const el = document.getElementById(`${NS}-audit`);
    if (el) el.textContent = `GGG tier bands captured: ${total}`;
  }
  // §10: download accumulated audit data as a file (content-world Blob is fine).
  function downloadJson(filename, obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
  }

  // ---- Panel --------------------------------------------------------------
  function buildPanel() {
    if (document.getElementById(`${NS}-panel2`)) return;
    const p = document.createElement('div');
    p.id = `${NS}-panel2`;
    p.style.cssText = [
      'position:fixed', 'bottom:16px', 'right:16px', 'z-index:2147483647',
      'background:#15171c', 'color:#eee', 'border:1px solid #46c', 'border-radius:8px',
      'padding:10px 12px', 'font:11px/1.45 monospace', 'box-shadow:0 4px 18px rgba(0,0,0,.6)',
      'width:280px',
    ].join(';');
    p.innerHTML = `
      <div style="font-weight:bold;margin-bottom:4px;color:#bcf">PoE2 Tier — Spike 2</div>
      <div id="${NS}-mon" style="margin-bottom:6px;color:#fc9">searches fired: 0 · captured query: no</div>

      <div style="border-top:1px solid #333;margin:4px 0;padding-top:4px;color:#9bd">Track A — autocomplete</div>
      <div style="display:flex;gap:4px;margin-bottom:4px">
        <button id="${NS}-scanA" style="flex:1">Scan inputs</button>
      </div>
      <div style="display:flex;gap:4px;margin-bottom:6px">
        <label>idx <input id="${NS}-aIdx" type="number" value="0" style="width:40px"></label>
        <input id="${NS}-aText" type="text" value="Adds # to # Physical" style="flex:1;min-width:0">
        <button id="${NS}-aGo">Add</button>
      </div>

      <div style="border-top:1px solid #333;margin:4px 0;padding-top:4px;color:#9bd">Track B — angular scope</div>
      <div style="display:flex;gap:4px;margin-bottom:6px">
        <input id="${NS}-bSel" type="text" value="body" placeholder="selector" style="flex:1;min-width:0">
        <button id="${NS}-bDump">Dump scope</button>
      </div>

      <div style="border-top:1px solid #333;margin:4px 0;padding-top:4px;color:#9bd">Track C — ?q= URL</div>
      <div style="display:flex;gap:4px;margin-bottom:4px">
        <label>test min <input id="${NS}-cMin" type="number" value="17" style="width:50px"></label>
        <button id="${NS}-cBuild" style="flex:1">Build q=</button>
      </div>
      <div style="display:flex;gap:4px;margin-bottom:4px">
        <button id="${NS}-cLog" style="flex:1">Log captured query</button>
        <button id="${NS}-cNav" style="flex:1">Navigate q=</button>
      </div>

      <div style="border-top:1px solid #333;margin:4px 0;padding-top:4px;color:#9bd">Item type (§11.4)</div>
      <div style="display:flex;gap:4px;margin-bottom:4px">
        <button id="${NS}-itemProbe" style="flex:1">Probe item type</button>
        <button id="${NS}-statProbe" style="flex:1">Probe stat group</button>
      </div>
      <div id="${NS}-item" style="margin-bottom:4px;color:#cf9;word-break:break-word">detected: —</div>

      <div style="border-top:1px solid #333;margin:4px 0;padding-top:4px;color:#9bd">Results (§9)</div>
      <div style="display:flex;gap:4px;margin-bottom:4px">
        <button id="${NS}-resProbe" style="flex:1">Probe results</button>
        <button id="${NS}-fetchDump" style="flex:1">Dump fetch tiers</button>
      </div>

      <div style="border-top:1px solid #333;margin:4px 0;padding-top:4px;color:#9bd">Tier audit (§10)</div>
      <div id="${NS}-audit" style="margin-bottom:4px;color:#fc9">GGG tier bands captured: 0</div>
      <div style="display:flex;gap:4px;margin-bottom:4px">
        <button id="${NS}-auditExport" style="flex:1">Export audit</button>
        <button id="${NS}-auditClear" style="flex:1">Clear</button>
      </div>

      <div id="${NS}-status" style="margin-top:6px;color:#9b9;min-height:14px">open devtools console</div>
    `;
    document.body.appendChild(p);
    statusEl = p.querySelector(`#${NS}-status`);

    const v = (id) => p.querySelector(`#${NS}-${id}`).value;
    p.querySelector(`#${NS}-scanA`).onclick = () => scanAddStatInputs();
    p.querySelector(`#${NS}-aGo`).onclick = () => tryAutocompleteAdd(parseInt(v('aIdx'), 10) || 0, v('aText'));
    p.querySelector(`#${NS}-bDump`).onclick = () => dumpScope(v('bSel'));
    p.querySelector(`#${NS}-cBuild`).onclick = () => previewQFromCapture(parseInt(v('cMin'), 10) || 0);
    p.querySelector(`#${NS}-cLog`).onclick = () => toPage('logLastQuery');
    p.querySelector(`#${NS}-cNav`).onclick = () => navigateLastUrl();
    p.querySelector(`#${NS}-itemProbe`).onclick = () => probeItemType();
    p.querySelector(`#${NS}-statProbe`).onclick = () => probeStatGroup();
    p.querySelector(`#${NS}-resProbe`).onclick = () => probeResults();
    p.querySelector(`#${NS}-fetchDump`).onclick = () => { toPage('dumpFetch'); setStatus('dumped last /fetch/ tiers (see console)'); };
    p.querySelector(`#${NS}-auditExport`).onclick = () => { toPage('exportAudit'); setStatus('exporting audit data…'); };
    p.querySelector(`#${NS}-auditClear`).onclick = () => { toPage('clearAudit'); setStatus('audit accumulator cleared'); };
    startItemObserver();
    log('Spike 2 panel ready.');
  }

  function ensure() { if (document.body) buildPanel(); }
  new MutationObserver(ensure).observe(document.documentElement, { childList: true, subtree: true });
  ensure();
  // Poll the monitor once after load in case searches happened pre-panel.
  setTimeout(() => toPage('getMonitor'), 1500);
})();
