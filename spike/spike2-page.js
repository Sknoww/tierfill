/*
 * PoE2 Tier Filter — Spike 2 PAGE-WORLD script
 * -------------------------------------------------------------------------
 * Runs in the page's MAIN world (injected by spike2.js via a <script> tag) so
 * it can (a) see the page's `fetch`/`XMLHttpRequest` to passively MONITOR trade
 * searches, and (b) reach the AngularJS `angular` global for Track B + reading
 * the current query.
 *
 * It NEVER initiates a request. The monitor only observes the page's own calls
 * to `…/api/trade2/search/…` so we can answer the rate-limit question:
 * "does adding a stat fire a search?" — empirically, per mechanism.
 *
 * Talks to the isolated-world content script via window.postMessage. All
 * messages are namespaced { source:'poe2tf-page' | 'poe2tf-cs', ... }.
 */
(() => {
  'use strict';
  const TAG = '[poe2tf-spike2-page]';
  const SEARCH_RE = /\/api\/trade2\/search\//i;
  const FETCH_RE = /\/api\/trade2\/fetch\//i; // §9: result fetch carries GGG's tier data

  const state = {
    searchCount: 0,
    lastQuery: null,   // parsed JSON body of the most recent search POST
    lastUrl: null,
    lastFetch: null,   // §9: parsed JSON of the most recent /fetch/ response
    // §10 tier-range audit: accumulate every explicit-mod tier observation GGG
    // sends across ALL searches, deduped by tier+stat. GGG's `magnitudes` are
    // the FULL tier band (the `[lo—lo to hi—hi]` bracket), so one item of a
    // tier reveals that tier's whole range — first-seen wins.
    audit: Object.create(null),
  };

  const post = (msg) => window.postMessage(Object.assign({ source: 'poe2tf-page' }, msg), '*');

  function recordSearch(url, body) {
    state.searchCount += 1;
    state.lastUrl = url;
    let parsed = null;
    try { parsed = typeof body === 'string' ? JSON.parse(body) : body; } catch (_) { parsed = body || null; }
    if (parsed) state.lastQuery = parsed;
    console.log(`${TAG} SEARCH #${state.searchCount} →`, url, parsed);
    post({ type: 'search', count: state.searchCount, url, query: state.lastQuery });
  }

  // §9: capture a /fetch/ RESPONSE so we can inspect GGG's authoritative tier
  // data (the P2 [lo—lo to hi—hi] brackets seen in results). Clone first so we
  // never consume the body the page needs.
  // §10 audit: walk EVERY item's explicit mods and bank each (tier, stat) band.
  // Dedup key = tier + the magnitudes' stat hashes (handles hybrid/multi-hash
  // mods). First observation wins (the band is fixed per tier). Returns how many
  // NEW distinct observations this batch added.
  function accumulateAudit(data) {
    const items = (data && data.result) || [];
    let added = 0;
    for (const it of items) {
      const item = it && it.item;
      const ex = item && item.extended;
      const mods = ex && ex.mods && ex.mods.explicit;
      if (!Array.isArray(mods)) continue;
      const base = (item && (item.baseType || item.typeLine)) || null;
      for (const m of mods) {
        if (!m || !Array.isArray(m.magnitudes) || !m.magnitudes.length) continue;
        const mags = m.magnitudes.map((g) => ({ hash: g.hash, min: Number(g.min), max: Number(g.max) }));
        const hashKey = mags.map((g) => g.hash).join(',');
        // Dedup on tier + stats + BAND values: family-split stats (1H vs 2H share
        // a stat id but roll different bands) stay distinct; identical bands on
        // different bases collapse to one. `base` is kept as a human example only.
        const bandKey = mags.map((g) => `${g.min}-${g.max}`).join(',');
        const key = `${m.tier || '?'}|${hashKey}|${bandKey}`;
        if (!state.audit[key]) {
          state.audit[key] = { tier: m.tier || null, level: m.level != null ? m.level : null, name: m.name || null, base, magnitudes: mags };
          added += 1;
        }
      }
    }
    return added;
  }

  function recordFetch(url, data) {
    state.lastFetch = data;
    const items = (data && data.result) || [];
    const added = accumulateAudit(data);
    const auditTotal = Object.keys(state.audit).length;
    const sample = items.find((it) => it && it.item && it.item.extended && it.item.extended.mods);
    console.log(`${TAG} FETCH → ${items.length} item(s); audit +${added} (total ${auditTotal} distinct tier bands).`, url);
    if (!sample) {
      console.log(`${TAG} (no item with item.extended.mods in this batch)`);
    } else {
      const ex = sample.item.extended;
      console.log(`${TAG} extended keys:`, Object.keys(ex || {}));
      console.log(`${TAG} extended.mods keys:`, Object.keys(ex.mods || {}));
      console.log(`${TAG} explicit[0] =`, JSON.stringify((ex.mods.explicit || [])[0], null, 2));
      console.log(`${TAG} extended.hashes.explicit =`, JSON.stringify((ex.hashes && ex.hashes.explicit) || null));
      console.log(`${TAG} FULL sample extended (expand to inspect) →`, ex);
    }
    post({ type: 'fetch', count: items.length, auditTotal });
  }

  // ---- Passive monitor: wrap fetch + XHR (observe only) -------------------
  const origFetch = window.fetch;
  if (origFetch && !origFetch.__poe2tf) {
    window.fetch = function (input, init) {
      let url = '';
      try {
        url = typeof input === 'string' ? input : (input && input.url) || '';
        if (SEARCH_RE.test(url)) recordSearch(url, init && init.body);
      } catch (_) { /* never break the page */ }
      const ret = origFetch.apply(this, arguments);
      try {
        if (FETCH_RE.test(url)) {
          ret.then((res) => { res.clone().json().then((d) => recordFetch(url, d)).catch(() => {}); })
            .catch(() => {});
        }
      } catch (_) { /* ignore */ }
      return ret;
    };
    window.fetch.__poe2tf = true;
  }

  const XHR = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
  if (XHR && !XHR.open.__poe2tf) {
    const origOpen = XHR.open;
    const origSend = XHR.send;
    XHR.open = function (method, url) { this.__poe2tf_url = url; return origOpen.apply(this, arguments); };
    XHR.open.__poe2tf = true;
    XHR.send = function (body) {
      try {
        const url = this.__poe2tf_url || '';
        if (SEARCH_RE.test(url)) recordSearch(url, body);
        if (FETCH_RE.test(url)) {
          this.addEventListener('load', function () {
            try { recordFetch(url, JSON.parse(this.responseText)); } catch (_) { /* ignore */ }
          });
        }
      } catch (_) { /* ignore */ }
      return origSend.apply(this, arguments);
    };
  }

  // ---- Track B / discovery: Angular scope access --------------------------
  function ng() { return window.angular || null; }

  function scopeFor(selector) {
    const a = ng();
    if (!a) return { error: 'window.angular not found (is this the AngularJS trade2 page?)' };
    const node = selector ? document.querySelector(selector) : document.body;
    if (!node) return { error: `no element matched selector: ${selector}` };
    try {
      const scope = a.element(node).scope();
      if (!scope) return { error: 'angular.element(node).scope() returned null' };
      // Report a shallow, query-relevant view of the scope so we can find the
      // stats array / current query object without dumping huge cyclic graphs.
      const keys = Object.keys(scope).filter((k) => !k.startsWith('$'));
      const interesting = {};
      for (const k of keys) {
        const v = scope[k];
        const t = Array.isArray(v) ? `array[${v.length}]` : typeof v;
        if (/query|stat|filter|state|search/i.test(k) || t === 'array' || t === 'object') {
          interesting[k] = t;
        }
      }
      return { ok: true, selector, keys, interesting };
    } catch (e) {
      return { error: String(e) };
    }
  }

  function handle(cmd, payload) {
    switch (cmd) {
      case 'getMonitor':
        post({ type: 'monitor', count: state.searchCount, query: state.lastQuery, url: state.lastUrl, auditTotal: Object.keys(state.audit).length });
        break;
      case 'dumpScope':
        post({ type: 'scope', result: scopeFor(payload && payload.selector) });
        break;
      case 'logLastQuery':
        console.log(`${TAG} last captured query =`, state.lastQuery);
        post({ type: 'logged', what: 'lastQuery' });
        break;
      case 'dumpFetch':
        if (state.lastFetch) recordFetch(state.lastUrl || '(cached)', state.lastFetch);
        else console.log(`${TAG} no /fetch/ captured yet — open a search so results load.`);
        post({ type: 'logged', what: 'lastFetch' });
        break;
      case 'exportAudit': {
        const observations = Object.keys(state.audit).map((k) => state.audit[k]);
        console.log(`${TAG} §10 export → ${observations.length} distinct GGG tier band(s).`);
        post({ type: 'auditExport', observations });
        break;
      }
      case 'clearAudit':
        state.audit = Object.create(null);
        console.log(`${TAG} §10 audit accumulator cleared.`);
        post({ type: 'fetch', count: 0, auditTotal: 0 });
        break;
      default:
        post({ type: 'error', error: `unknown cmd: ${cmd}` });
    }
  }

  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (!d || d.source !== 'poe2tf-cs') return;
    handle(d.cmd, d.payload);
  });

  console.log(`${TAG} ready — monitoring ${SEARCH_RE}. angular present: ${!!ng()}`);
  post({ type: 'ready', angular: !!ng() });
})();
