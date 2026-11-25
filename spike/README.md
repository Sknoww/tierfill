# Spike harness (throwaway probe)

Loaded as a temporary Firefox add-on against the live `/trade2/` page to confirm DOM
facts. The manifest currently loads **Spike 2** (`spike2.js` + `spike2-page.js`). The
Spike 1 probe (`content.js`) is kept for reference but is no longer loaded.

## Load it in Firefox

1. `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…**
2. Select `spike/manifest.json`. (Temporary add-ons vanish on restart — fine for a spike.)
3. Open `https://www.pathofexile.com/trade2/search/poe2/<league>` and open DevTools (F12).

---

## Spike 1 (DONE — see FINDINGS.md)
Writing a value into a min input + dispatching `input`/`change`/`blur` fills the box but
does **not** auto-search; clicking `button.search-btn` is the only search trigger.

## Spike 2 — add a stat without firing a search (CURRENT)

Goal: prove a **rate-limit-safe** way to ADD a stat filter, and decide between Track A
(autocomplete), Track B (angular scope), and Track C (`?q=` URL). The panel's
**"searches fired: N"** counter (a passive monitor on the page's own
`POST …/api/trade2/search/…`) is the key instrument — every action reports whether it
fired a search.

### Step 0 — capture a real query (feeds Track C + gives us a real `stat_id`)
1. Add **one** stat manually (e.g. `Adds # to # Physical Damage to Attacks`), put a number
   in its `min`, hit **Search**.
2. The panel should now show `searches fired: 1 · captured query: yes`. The monitor logged
   the full POST body to the console — that's the exact JSON schema + the real `stat_id`.
   Click **"Log captured query"** to re-print it, and paste it into `FINDINGS.md`.

### Track A — autocomplete add (in-place, expect NO search)
1. **Scan inputs** → console lists text inputs with placeholders. Find the "+ Add Stat
   Filter" box and note its index.
2. Set **idx**, type a stat fragment, click **Add**. The console logs dropdown candidates
   and clicks the match; the panel reports **"✅ NO search fired"** or **"⚠ fired N"**.
3. Record: did a real stat row appear? Did it search? Was the option selector reliable?

### Track B — angular scope (page world)
1. Put a selector in the box (start with `body`, then try a stat-row element) and click
   **Dump scope**. The console shows the scope's query-relevant keys.
2. Goal: locate the live `query`/`stats` object so we know whether scope-push + `$apply()`
   is viable (and whether it would auto-search).

### Track C — `?q=` URL (one search, on demand)
1. After Step 0 captured a query, set **test min** and click **Build q=** — it clones the
   captured query, tweaks `stats[0].filters[0].value.min`, and logs a navigable URL
   **without navigating**.
2. Click **Navigate q=** → the page loads that URL. Confirm: the stat row hydrates with the
   min filled, and **exactly one** search fires (watch the counter after reload).

## Item-type probe (FINDINGS §4 — CURRENT)

Goal: detect the searched item **live and without firing a search**, from the DOM (the
source the real picker will use), and validate it against the captured query JSON. Two
constraint inputs must both be handled:
- **specific item** typed into `"Search Items..."` → `query.name` / `query.type`
- **generic category** in the **Type Filters** dropdown → `query.filters.type_filters`

The panel's **"detected: …"** line is a live readout (debounced MutationObserver) that
updates as you change constraints — confirms the no-search detection path works.

1. With nothing constrained, note the readout shows `item: — · type filters: —`.
2. **Type Filters path:** open Type Filters, pick a **Category** (e.g. "Ring"). Watch the
   readout update. Click **"Probe item type"** and read the console block:
   - `[DOM] Type Filters group: FOUND/NOT FOUND` + each multiselect's label/value/selector.
   - `[DOM] All currently-selected multiselects` (fallback scan to eyeball the right node).
3. **Search-bar path:** type a specific item into `"Search Items..."` and select it. Watch
   the readout; **Probe item type** again — `[DOM] Search bar … selected="…"`.
4. **Cross-check:** hit **Search** once (so the monitor captures the query), then **Probe
   item type** — the `[QUERY]` lines dump `name` / `type` / full `filters.type_filters`, and
   `[CHECK]` notes DOM-vs-query consistency.
5. Try **neither / one / both** set to confirm each combination reads correctly.

### Stat-filter group + rows (same panel — "Probe stat group")
Add ≥1 stat filter (manually or via Track A), then click **"Probe stat group"**. The console
logs the add-stat controls, the ancestor chain (to find the group container), and a `[ROWS]`
dump classifying each row (header / add-control / **STAT-ROW**) with its element tree.
Confirmed and recorded in **FINDINGS.md §3** (group anchor, `.filter.full-span` rows,
`.filter-title` stat label, `input.minmax`). DONE.

### What to record (→ FINDINGS.md §4)
- Search-bar selector + how the selected item appears in the DOM ↔ `query.name` / `query.type`.
- Type Filters group/category control selector + how the category appears ↔ the **real**
  `query.filters.type_filters` shape (dumped raw — don't assume the path).
- Whether DOM-first live detection is reliable (does the readout track changes correctly?).
- Any case where DOM and the captured query disagree.

## What to record — Spike 2 tracks (DONE → FINDINGS.md)
- Step 0: the captured query JSON + the real `stat_id` for the test mod.
- Per track: did it add a real stat row? Did it fire a search (counter delta)? How brittle?
- The add-stat box selector + the dropdown option selector (Track A).
- The scope path to the live query/stats (Track B), if found.
- Whether `?q=` hydrates the stat row + value, and the exact realm/league URL shape (Track C).
- Recommendation: which track wins for "add many, search once".
