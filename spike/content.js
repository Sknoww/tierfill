/*
 * PoE2 Tier Filter — Spike content script
 * -------------------------------------------------------------------------
 * Goal (PLAN.md §11.1): prove we can (a) locate a stat-filter row's min input
 * on the live /trade2/ page and (b) write a value into it that the AngularJS
 * binding actually registers.
 *
 * It injects a small floating panel with two actions:
 *   • Scan   — find candidate min/max inputs, log details to the console, and
 *              report what selectors actually work (record these in FINDINGS.md).
 *   • Write  — write the chosen value into the Nth discovered min input using
 *              the native-setter + event-dispatch technique (PLAN.md §10).
 *
 * Nothing here is production code; it's a throwaway probe. Everything is
 * namespaced `poe2tf-` per the coexistence rules so it can't clash with
 * better-trading / TFT.
 */

(() => {
  'use strict';

  const NS = 'poe2tf';
  const log = (...args) => console.log('%c[poe2tf-spike]', 'color:#c8a', ...args);

  // ---- Candidate selectors for the min input -----------------------------
  // The official trade site historically uses placeholder="min"/"max" on the
  // stat-filter number inputs. We try a few strategies and report which hit.
  const MIN_SELECTORS = [
    'input[placeholder="min" i]',
    '.filter-group input[placeholder="min" i]',
    'input[type="text"][placeholder="min" i]',
  ];

  function firstMatchingSelector(selectors) {
    for (const sel of selectors) {
      const els = document.querySelectorAll(sel);
      if (els.length) return { sel, els: Array.from(els) };
    }
    return { sel: null, els: [] };
  }

  // ---- The AngularJS-safe value write (PLAN.md §10) ----------------------
  function setNativeValue(input, value) {
    const proto = Object.getPrototypeOf(input);
    const protoDesc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    const ownDesc = Object.getOwnPropertyDescriptor(proto, 'value');
    const protoSetter = protoDesc && protoDesc.set;
    const ownSetter = ownDesc && ownDesc.set;

    if (ownSetter && ownSetter !== protoSetter) {
      ownSetter.call(input, String(value));
    } else if (protoSetter) {
      protoSetter.call(input, String(value));
    } else {
      input.value = String(value);
    }

    // AngularJS ng-model binds on 'input'; dispatch the others to be safe.
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  // ---- Describe a discovered input so we can record real selectors -------
  function describeInput(input, i) {
    // Walk up to find the row + the stat label text near this input.
    let row = input;
    for (let depth = 0; depth < 6 && row.parentElement; depth++) {
      row = row.parentElement;
      const txt = (row.textContent || '').trim().replace(/\s+/g, ' ');
      if (txt.length > 4 && txt.length < 120) {
        return { i, label: txt, rowClass: row.className, inputClass: input.className };
      }
    }
    return { i, label: '(no nearby label found)', rowClass: '', inputClass: input.className };
  }

  function scan() {
    log('--- SCAN START ---');
    const { sel, els } = firstMatchingSelector(MIN_SELECTORS);
    if (!sel) {
      log('No min inputs matched any candidate selector. Tried:', MIN_SELECTORS);
      log('TRY: in this console run  document.querySelectorAll(\'input\')  and inspect a stat-filter min box to find its real attributes, then paste them into FINDINGS.md.');
      return [];
    }
    log(`Matched selector: ${sel}  →  ${els.length} input(s)`);
    const described = els.map(describeInput);
    described.forEach((d) => log(`  [${d.i}] "${d.label}"  (input.class="${d.inputClass}")`));
    log('--- SCAN END --- record the working selector + a sample label in FINDINGS.md');
    window[`__${NS}_minInputs`] = els; // expose for manual poking in console
    return els;
  }

  function writeToIndex(index, value) {
    const els = window[`__${NS}_minInputs`] || scan();
    const input = els[index];
    if (!input) {
      log(`No min input at index ${index} (found ${els.length}). Run Scan first.`);
      return;
    }
    const before = input.value;
    setNativeValue(input, value);
    log(`Wrote ${value} to min input [${index}]. value: "${before}" → "${input.value}"`);
    log('VERIFY: did the search re-run / the value stick after Angular processed it? Note result in FINDINGS.md.');
  }

  // ---- Spike 1b: trigger the search after a write ------------------------
  // Plan A: synthetic Enter on the min input. Plan B: find + click Search btn.
  function pressEnter(index) {
    const els = window[`__${NS}_minInputs`] || scan();
    const input = els[index];
    if (!input) { log(`No min input at index ${index}. Run Scan first.`); return; }
    const opts = { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter' };
    input.focus();
    ['keydown', 'keypress', 'keyup'].forEach((type) =>
      input.dispatchEvent(new KeyboardEvent(type, opts)));
    log(`Dispatched Enter on min input [${index}]. Did results refresh?`);
  }

  function findSearchControls() {
    const out = [];
    document.querySelectorAll('button, a, .btn, [class*="search" i]').forEach((el) => {
      const txt = (el.textContent || '').trim().replace(/\s+/g, ' ');
      const cls = (el.className && el.className.toString()) || '';
      if ((/search/i.test(txt) || /search/i.test(cls)) && txt.length < 40) {
        out.push({ el, txt, cls, tag: el.tagName.toLowerCase() });
      }
    });
    return out;
  }

  function scanSearch() {
    const c = findSearchControls();
    log(`Found ${c.length} search-ish control(s):`);
    c.forEach((x, i) => log(`  <btn ${i}> <${x.tag} class="${x.cls}"> "${x.txt}"`));
    window[`__${NS}_searchBtns`] = c;
    return c;
  }

  function clickSearch() {
    const c = window[`__${NS}_searchBtns`] || scanSearch();
    // Prefer a control whose text is exactly "Search".
    const target = c.find((x) => /^search$/i.test(x.txt)) || c[0];
    if (!target) { log('No search-button candidate found. Click "Find Search" and inspect.'); return; }
    log(`Clicking <${target.tag} class="${target.cls}"> "${target.txt}"`);
    target.el.click();
    log('Did results refresh? If wrong element clicked, see the "Find Search" list and tell me the right index.');
  }

  // ---- Floating control panel -------------------------------------------
  function buildPanel() {
    if (document.getElementById(`${NS}-panel`)) return;

    const panel = document.createElement('div');
    panel.id = `${NS}-panel`;
    panel.style.cssText = [
      'position:fixed', 'bottom:16px', 'right:16px', 'z-index:2147483647',
      'background:#1b1b1f', 'color:#eee', 'border:1px solid #5a4', 'border-radius:8px',
      'padding:10px 12px', 'font:12px/1.4 monospace', 'box-shadow:0 4px 18px rgba(0,0,0,.5)',
      'width:230px',
    ].join(';');

    panel.innerHTML = `
      <div style="font-weight:bold;margin-bottom:6px;color:#bda">PoE2 Tier Spike</div>
      <div style="display:flex;gap:6px;margin-bottom:6px">
        <label style="flex:1">idx <input id="${NS}-idx" type="number" value="0" style="width:46px"></label>
        <label style="flex:1">val <input id="${NS}-val" type="number" value="17" style="width:54px"></label>
      </div>
      <div style="display:flex;gap:6px;margin-bottom:6px">
        <button id="${NS}-scan" style="flex:1">Scan</button>
        <button id="${NS}-write" style="flex:1">Write</button>
      </div>
      <div style="display:flex;gap:6px">
        <button id="${NS}-enter" style="flex:1">Enter</button>
        <button id="${NS}-findsearch" style="flex:1">Find Search</button>
        <button id="${NS}-clicksearch" style="flex:1">Click Search</button>
      </div>
      <div id="${NS}-status" style="margin-top:6px;color:#9b9">open devtools console</div>
    `;
    document.body.appendChild(panel);

    const status = panel.querySelector(`#${NS}-status`);
    panel.querySelector(`#${NS}-scan`).addEventListener('click', () => {
      const n = scan().length;
      status.textContent = `scanned: ${n} min input(s)`;
    });
    panel.querySelector(`#${NS}-write`).addEventListener('click', () => {
      const idx = parseInt(panel.querySelector(`#${NS}-idx`).value, 10) || 0;
      const val = parseInt(panel.querySelector(`#${NS}-val`).value, 10) || 0;
      writeToIndex(idx, val);
      status.textContent = `wrote ${val} → idx ${idx} (check console)`;
    });
    panel.querySelector(`#${NS}-enter`).addEventListener('click', () => {
      const idx = parseInt(panel.querySelector(`#${NS}-idx`).value, 10) || 0;
      pressEnter(idx);
      status.textContent = `sent Enter → idx ${idx} (did results refresh?)`;
    });
    panel.querySelector(`#${NS}-findsearch`).addEventListener('click', () => {
      const n = scanSearch().length;
      status.textContent = `found ${n} search control(s) (see console)`;
    });
    panel.querySelector(`#${NS}-clicksearch`).addEventListener('click', () => {
      clickSearch();
      status.textContent = `clicked Search (did results refresh?)`;
    });

    log('Panel ready. The trade site is a SPA, so add a stat filter first, then Scan.');
  }

  // The trade site renders late and re-renders; keep the panel alive.
  function ensurePanel() {
    if (document.body) buildPanel();
  }
  const observer = new MutationObserver(() => ensurePanel());
  observer.observe(document.documentElement, { childList: true, subtree: true });
  ensurePanel();
})();
