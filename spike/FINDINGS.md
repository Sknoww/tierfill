# Spike findings — live trade2 DOM facts

> Filled in from the live spike run. Persists across context clears. Feeds CONTEXT.md.

## 1. Min-input selector — CONFIRMED
- Selector that matched: **`input[placeholder="min" i]`** → 39 inputs on the page.
- Min/max input class: **`form-control minmax`**.
- ⚠️ This selector grabs **everything**: indices [0]–[36] are built-in *property* filters
  (Item Level, Quality, Damage, DPS, Strength, Waystone…, Gold Fee). The added stat-mod
  filter was the **last** one. So the real extension must **scope to the stat-filter group**,
  not match `placeholder="min"` globally.

## 2. Write + trigger the search — SOLVED (Spike 1 + 1b)
- After **Write**, the value appeared in the box: **YES** (`"" → "17"`).
- The search **re-ran automatically**: **NO** — value shows but results don't refresh.
- Synthetic **Enter** on the input: **did NOT** trigger the search.
- **Clicking the Search button DID trigger it.** ✅
- **Search button selector: `button.search-btn`** (text "Search").
- Also captured: Live Search = `button.livesearch-btn`; toggle filters = `button.toggle-search-btn`.
- ⇒ Real flow: `setNativeValue(input, v)` → then `document.querySelector('button.search-btn').click()`.
- Note: when scanning controls, exclude our own namespaced buttons (our spike's "Find Search"
  / "Click Search" showed up in the candidate list).

## 3. Stat-filter group + row structure — CONFIRMED (Spike §11.4 leftover, live)

### Scoping: anchor on the add-stat control, NOT on class
The group classes (`filter-group`, `filter-group-body`, `filter`, `filter-body`, `expanded`)
are **generic and shared** with the property-filter groups (Item Level, Quality, …), so we
cannot select the Stats group by class. **Anchor on the add-stat control instead:**
```js
const statsGroup = document
  .querySelector('input.multiselect__input[placeholder="+ Add Stat Filter" i]')
  .closest('.filter-group');                 // → div.filter-group.expanded
```
- The Stats group is wrapped by **`div.search-advanced-pane.brown`**, which is a *separate*
  pane from the property filters (property min boxes are NOT under `.brown` — its `minmax`
  count stayed at just our stat rows). `.brown` may be usable as a coarse pane selector, but
  the add-stat-control anchor above is the robust one.
- Add controls: **`+ Add Stat Filter`** → `div.multiselect.filter-select.filter-select-mutate`;
  **`+ Add Stat Group`** → `div.multiselect.filter-select.filter-group-select`.

### Rows inside the Stats group (`statsGroup.querySelectorAll('.filter')`)
| Row | Selector | Notes |
| --- | --- | --- |
| Group header | `div.filter` (text "Stat Filters", no minmax) | skip |
| Add-stat control | `div.filter.filter-padded` (contains `.filter-select-mutate`) | skip |
| **Stat row** | **`div.filter.full-span`** (and NOT `.filter-property`) | the rows we act on |

Property filters are `div.filter.filter-property` and live in the other pane — never matched
by `.filter.full-span` inside the Stats group.

### Stat-row internal structure (per added mod)
```
div.filter.full-span
├ span.input-group-btn  › button.btn.toggle-btn      (enable/disable the filter)
├ span.filter-body
│  ├ div.filter-title.filter-title-clickable          ← stat label (see below)
│  ├ span.sep
│  ├ input.form-control.minmax                         ← MIN (1st .minmax in row)
│  ├ span.sep
│  └ input.form-control.minmax                         ← MAX (2nd .minmax in row)
└ span.input-group-btn  › button.btn.remove-btn       (remove the filter)
```
- ⚠️ **A stat row contains NO vue-multiselect.** The only `.multiselect` in the Stats group is
  the add-stat control. So read the selected stat from **`.filter-title` text**, not a
  `.multiselect__single`.
- **`.filter-title` text = `"<type tag> <stat template>"`**, e.g.
  `"explicit Adds # to # Physical Damage to Attacks"`, `"pseudo +#% total Elemental Resistance"`.
  Strip the leading type token (`explicit` / `implicit` / `pseudo` / `rune` / `crafted` / …) to
  get the **stat template** (with `#`) used to match our tier data.
- **Write the min** into the row's **first** `input.minmax` via the Spike-1 native-setter method
  (set value → dispatch `input`/`change`/`blur`).
- **Tier-UI injection point:** append a namespaced control into `span.filter-body` (additive-only,
  per §9 coexistence rules) — or after the row.

### Two ways this is used
1. **Picker adds the stat** (we choose the mod → we already know its template/`stat_id`; no
   read-back needed). Add via Track A (vue-multiselect) or Track C (`?q=`).
2. **Augment existing rows** the user added: enumerate `.filter.full-span` in the Stats group,
   read each `.filter-title`, strip the type tag, look up tiers, inject the control + fill min.

## 4. Item type / category exposure — CONFIRMED (Spike §11.4, live on Runes of Aldur)
Powers the item-aware affix picker (which mods are possible). **Two independent input modes**;
the picker reads whichever is set (neither / one / both) and scopes the mod list. **DOM-first**
detection works **live without firing a search**, validated against the captured query JSON.

### Mode 1 — specific item via the search bar
- Input: **`input[placeholder="Search Items..." i]`**, inside container **`.multiselect.search-select`**.
- ⚠️ **The committed item lives in the input's `.value`**, NOT in `.multiselect__single` (always
  null here) and NOT in the placeholder (static `"Search Items..."`). The widget gains a
  **`modified`** class when set. So: read `input.value`, gated by the `modified` class.
  - Caveat: `input.value` also reflects **mid-typing (uncommitted)** text → debounce, and/or only
    trust it once it matches a known base (or cross-check against the query after a search).
- Query mapping (captured POST body):
  | Search-bar selection | `query.name` | `query.type` |
  | --- | --- | --- |
  | Unique "Freedom of Faith" | `"Freedom of Faith"` | `"Ritual Tablet"` (its base) |
  | Base "Obliterator Bow" | `null` | `"Obliterator Bow"` |
  - ⇒ **`type` = base type (the mod-scoping key); `name` = unique (optional, narrows further).**

### Mode 2 — generic category via the Type Filters dropdown
- Group container: found by locating a leaf element whose text is exactly **"Type Filters"**, then
  climbing to the nearest ancestor containing a `.multiselect`. Inside it: two
  **`.multiselect.filter-select`** rows — **"Item Category"** and **"Item Rarity"**
  (labels recovered from preceding-sibling text).
- ⚠️ **filter-select renders the CHOSEN option as the input `placeholder`** (not `.multiselect__single`),
  plus a **`modified`** class. Unset = placeholder `"Any"` + no `modified`. So: read the placeholder,
  gated by the `modified` class. (This differs from the search bar, which uses `input.value`.)
- Query mapping → **`query.filters.type_filters.filters.category.option`**:
  | Category display | `category.option` |
  | --- | --- |
  | "Dagger" (specific) | `"weapon.dagger"` |
  | "Any Ranged Weapon" (group/parent) | `"weapon.ranged"` |
  - Categories are **hierarchical** (a parent group like `weapon.ranged` vs a specific `weapon.dagger`)
    — relevant when matching against a mod's `types`. Rarity → `filters.rarity.option` (same shape).
  - `query.filters.type_filters` is **`null`/absent** when no category/rarity is set.

### Cross-cutting facts
- **DOM is live; the captured query JSON is STALE until the next search.** (Saw DOM category =
  "Any Ranged Weapon" while the last-captured query still said `weapon.dagger`.) ⇒ the picker must
  read the **DOM** for live scoping; the query JSON is a post-search cross-check only.
- **`modified` class = the reliable "this control is set" signal** for both widget types.
- Other selected multiselects on the page (caught by the exploratory scan) are noise for scoping:
  league = `.multiselect.status-select` ("PoE2 - Runes of Aldur"), status = `.multiselect.status-select`
  ("Instant Buyout"). These use `.multiselect__single`. Scope to search-select + filter-select only.
- Probe tooling: `spike2.js` → `probeItemType()` / live "detected:" readout (debounced MutationObserver).

## 5. NEW SCOPE (user request) — add the stat, don't just fill it
The user wants to **not** add the stat manually first. Desired flow (like better-trading's
affix selector + our tier layer):
1. Detect the item type being searched.
2. Show the mods that can roll on that item type.
3. User picks a mod + a tier → extension **adds the stat filter AND fills the value**.

This requires **programmatically adding a stat** (harder than filling a value). Candidate
techniques for **Spike 2**:
- (A) **Drive the Angular autocomplete UI** — focus the "add stat" search box, set its value,
  trigger the typeahead, select the matching option. No page-world access needed; more brittle.
- (B) **Manipulate AngularJS scope/state directly** — `angular.element(node).scope()`, push to
  the stats array, `$apply()`. Needs a **MAIN-world** script (content scripts can't see the
  page's `angular` global). Fragile — depends on private app internals.
- **(C) Build a `?q=` URL and navigate — RECOMMENDED. ← the "how PoB does it" answer.**
  See §7. Sidesteps "add a stat" entirely; the site hydrates the stat row + value itself.

## 7. Technique C — `?q=` URL construction (research-confirmed, not yet live-tested)
The user's hint ("PoB bakes it into the URL?") checks out. Confirmed by reading
`PathOfBuildingCommunity/PathOfBuilding-PoE2` → `src/Classes/TradeQuery.lua`: PoB2 does **not**
drive the UI to add stats. It builds the full query JSON and opens:

```
https://www.pathofexile.com/trade2/search/{realm}/{league}?q=<urlEncoded JSON>
```
(matches our known live path `/trade2/search/poe2/<league>`; realm = `poe2`).

The JSON carries the entire query, stat filters included, with `min`/`max` baked in:
```jsonc
{
  "query": {
    "status": { "option": "online" },
    "stats": [
      { "type": "and",
        "filters": [
          { "id": "explicit.stat_xxxxx", "value": { "min": 17 } }
        ] }
    ]
  },
  "sort": { "price": "asc" }
}
```
Loading that URL makes the trade2 SPA **add the stat row AND fill the value on its own** — no
autocomplete-driving, no scope mutation. This is the cleanest path to the new scope.

**What better-trading does (and why it's NOT this):** `app/services/trade-location.ts` only
reads/replays the server-side **slug** URL `/trade/search/{league}/{slug}` — re-fetching a query
GGG already stored. It cannot construct a *new* search from arbitrary mods. So bookmarks ≠ the
mechanism we need; PoB's `?q=` is.

### Trade-offs of C
- ✅ Robust & version-stable (uses the site's own load path, exactly how PoB ships it).
- ✅ Adding the stat and filling the value happen in one step.
- ⚠️ **Full page reload.** To avoid wiping the user's in-progress filters, build the JSON from
  the *current* query + our new stat, then navigate. Reading current state options:
  read-only Angular-scope peek (MAIN world, safe), or reconstruct from DOM. (MVP could just
  build the whole query in our picker and skip the merge.)
- ⚠️ Need the real **trade stat id** (`explicit.stat_...`) per mod — this is CONTEXT.md's stat-id
  mapping task. Easiest discovery: run a manual single-stat search on the live site and copy
  the POST body to `/api/trade2/search/poe2/{league}` from devtools Network (no extra GGG hit
  beyond the user's own search).

## 8. Spike 2 LIVE RESULTS (run on Runes of Aldur league)

### Framework: trade2 is **Vue**, not AngularJS — CONFIRMED
- Widgets use **vue-multiselect** classes: `multiselect__input`, `multiselect__option`,
  `multiselect__element`. `window.angular` is **absent**.
- ⇒ Earlier "AngularJS" assumption (from the PoE1 site) was wrong. Value-write still works
  (native setter + `input`/`change` is framework-agnostic; Vue `v-model` listens to `input`).

### Track A — autocomplete add: ✅ VIABLE, rate-limit-safe
- Add-stat box: **`input.multiselect__input[placeholder="+ Add Stat Filter"]`**
  (also `"+ Add Stat Group"` for groups). Options render as **`.multiselect__option`**.
- ⚠️ **Selection requires `mousedown`, not `click`** — vue-multiselect suppresses click to keep
  the search input focused. With `.click()` the dropdown opened but **no stat was added**. Fixed
  in `spike2.js` to dispatch `pointerdown`/`mousedown`/`mouseup`/`click`.
- ✅ Selecting an option fires **ZERO searches** (monitor `count 2 → 2`). This is the in-place
  "stage many → search once via `button.search-btn`" path.
- Open detail: typing didn't visibly filter the option list (showed full list incl. a `pseudo`
  group); selection still works by matching option text. Filtering is polish, not a blocker.

### Track B — framework scope: ❌ DEAD
- `dumpScope` → `window.angular not found`. No AngularJS scope to push into. Dropped.

### Track C — `?q=` URL: schema confirmed; one-shot commit
- Monitor captured the real search payload. Confirmed schema:
  ```json
  {"query":{"status":{"option":"securable"},
    "stats":[{"type":"and","filters":[{"id":"explicit.stat_3032590688","value":{"min":17},"disabled":false}],"disabled":false}]},
    "sort":{"price":"asc"}}
  ```
  - `Adds # to # Physical Damage to Attacks` → **`explicit.stat_3032590688`**.
  - `status.option` was `"securable"` (the manual search's setting), filters carry `disabled:false`.
- URL shape built OK: `https://www.pathofexile.com/trade2/search/poe2/<league>?q=<urlEncoded JSON>`
  (league path segment is URL-encoded, e.g. `Runes%20of%20Aldur`).
- ✅ **Navigation confirmed:** loading the `?q=` URL hydrates the stat row with the min filled
  and runs exactly one search.

## 9. Verdict — SPIKE 2 CLOSED ✅
- Value-fill: **works.** Add-a-stat: **A works (zero searches) + C works (one-shot, hydration
  confirmed).** B is dead (Vue, no `angular`).
- Both survivors are **rate-limit-safe** (adding never searches; search is an explicit step).
- Ready for real implementation. Next: §11.4 read item type + available mods (item-aware picker);
  decide A-staging vs C-commit UX; stat-id mapping (the monitor/capture approach gives ids).

## 10. Picker-UI injection — live DOM facts (confirmed building the control)

Confirmed live in Firefox while building the per-row inline tier control:

- **The stat row's `span.filter-body` is `display: table`** (position: relative). Its children
  render as a table row. Inspected child layout of a stat row:
  | idx | node | computed display |
  | --- | --- | --- |
  | 0 | `div.filter-title.filter-title-clickable` | `table` |
  | 1 | `span.sep` | `table-cell` |
  | 2 | `input.form-control.minmax` (**MIN**) | `block` |
  | 3 | `span.sep` | `table-cell` |
  | 4 | `input.form-control.minmax` (**MAX**) | `block` |
- ⚠️ **Injected controls MUST be `display: table-cell`.** An `inline-flex` (or any non-cell)
  child of the table box gets swept into a **shared anonymous table-cell with the adjacent MIN
  `<input>`**, so it overlaps MIN instead of getting its own column. Fix: the control root is
  `display:table-cell` (its own column, inserted before the MIN input); inner content sits in a
  flex `.poe2tf-inner`; the dropdown panel is `position:fixed` (escapes table/row clipping).
- **MIN input confirmed:** `input.form-control.minmax`, `display:block`. Insert the control via
  `minInput.parentNode.insertBefore(control, minInput)`. (Note: a bare `input.minmax` query is
  fine; the row has no vue-multiselect — read the stat from `.filter-title`, per §3.)
- **Exact-match matters (mod identity, CONTEXT.md):** with `.filter-title` = "explicit Adds # to #
  Physical Damage **to Attacks**" the control correctly **does NOT** appear (that's the global
  `explicit.stat_3032590688`); adding the **local** "Adds # to # Physical Damage" on a weapon
  search **does** light it up. Match on the exact stripped template, never a contains.
- **Family auto-resolve (§11.6):** `resolveFamily()` matches the detected category/base text
  against each family's `types`; one hit → auto-select + hide toggle; zero/multiple → show the
  1H/2H toggle. This is a **heuristic first cut** — a precise `category.option → family` map is
  §11.7 data work.
- ⏭ **Verify next time the page is open:** does the MIN box accept **decimal** values (averaged
  tiers produce `.5`, e.g. 1H T2 = 28.5)? Assumed yes; confirm it isn't silently floored/rejected.

## 11. Full data pipeline — §11.7 (`tools/build-data.mjs`, built & shipped)

Generator: `node tools/build-data.mjs` → `assets/data-snapshot.json` (`--dry` report only, `--out <p>`
to preview without touching the live snapshot). Inputs in `tools/data-sources/`:
- `enhancer-mods2-data.json` — PoE2DB-derived, pre-tiered (`prefix`/`suffix`/`implicit` → `{stat text:
  [{level,values,types}]}`). Fetchable as static JSON.
- `ggg-trade2-stats.json` — **one-time browser capture** of `…/api/trade2/data/stats`
  (Cloudflare-blocked to server-side `curl`; readable from the authenticated browser). Authoritative
  display text + every `stat_id`. Shape: `{result:[{id,label,entries:[{id,text,type}]}]}` — 10 groups,
  **3006 explicit** entries.

**Decisions baked in (this session):**
- **Explicit only** — ingest `prefix`+`suffix` (both render as `explicit` on trade); **skip `implicit`**
  (implicits aren't tier-searched; also removes 54 implicit↔explicit text collisions). Content script
  now gates the control to `explicit` rows (`index.mjs`: keeps the type token, skips implicit/pseudo/…).
- **Family split = union-find by SHARED item type** (NOT exact `types` signature — that over-split
  caster ladders whose type coverage shrinks at higher tiers, e.g. cast speed wand/shield/…→wand).
  `family.types` = union of members. 138 stat texts → **172 ladders** (111 single, 20 two-, 7 three-family).
- **GGG join** on normalized text (lowercase, drop `+`, unify dashes). 160/172 matched directly; a
  curated **5-entry alias map** (`additional→added` ×4, `increased Duration→increased Skill Effect
  Duration`) recovers the wording gaps. 5 texts map to >1 explicit id (identical display, e.g.
  `#% increased Spirit`) → primary id kept, alternates in `_tradeStatIdAlts` for the future add-stat.
  7 stay unmatched **by design** (sign-flips like `reduced Attribute Requirements`↔`increased …`,
  non-numeric `Loads an additional bolt`) → no control, never a wrong fill.
- **Hybrids `|||||` (32) — RESOLVED as "skip" being correct.** GGG has **0** combined gear-hybrid
  entries (the 75 multi-line GGG entries are unique/meta mods); **32/32** hybrid halves resolve to
  standalone single-line stat_ids. ⇒ Trade searches each hybrid line via the SAME single-line stat the
  standalone affix uses; there is no separate searchable hybrid target. A `#% increased Physical Damage`
  row uses the one standalone ladder regardless of affix source (trade itself can't distinguish them).
- **Messy-data handling:** dedupe-per-level keeping the broadest-coverage variant (one stat,
  attack-speed, bridges weapon + quiver/gloves ladders via a shared low-level element). Logged.
- **Single-element value pair = FIXED sub-roll** (e.g. lightning low roll `["1"]` = always 1) →
  expand to `[1,1]`. (Was a generator bug that left `loMax=null`; fixed.)

**Tier-overlap finding (user-observed, real):** for averaged `… to Attacks` mods the **fire & lightning**
T3 max-average **reaches the T1 inclusive floor** (both 24.5) → a max-rolled T3 legitimately passes a T1
*inclusive* filter; physical/cold don't (T3 max 15.5/19.5 < floor 17/20.5). Not a bug — the §6 overlap,
worse where bands are wide. **Solution exists, deferred to milestone 8:** `strict` mode (already in
`compute.mjs`; fire T1 strict = 31.5, excludes all lower tiers) surfaced via an Inclusive/Strict/Exact-band
toggle, and §7b result post-filtering for true per-roll precision.

Validation: `node tools/validate.mjs` — compute self-tests + per-stat invariants (0 empty, 0 strict<floor,
0 null). Monotonic-min is a **warning not a failure** (sceptre `#% increased Spirit` genuinely rolls higher
at lvl-1 than lvl-11; forcing monotonicity would corrupt real data).

---

## 12. §9 — Results-list DOM (live, confirmed 2026-06-03)

Probed via the spike panel's **Probe results** button (`spike2.js`, finds an `Adds X to Y` line by
content, dumps class + ancestor chain). On an open search returning a fire-to-attacks item:

```
[HIT] mod line: span.s.lc  text="Adds 17 to 27 Fire damage to Attacks"
[CHAIN] ^0 span.s.lc
        ^1 div.item-mod.item-mod--explicit     ← THE mod-line node (read/inject here)
        ^2 div.item-popup__content
        ^3 div.item-popup.item-popup--magic.item-popup--poe2
        ^4 div.middle
        ^5 div.row                              ← ONE result listing
        ^6 div.resultset
        ^7 div.results
[SEL] leaf class ".s.lc" → 65 nodes page-wide   ← TOO generic; do NOT key off this
```

**Confirmed selectors for the §7b annotator:**
- **Explicit mod line = `div.item-mod--explicit`.** This is PoE2's equivalent of better-trading's PoE1
  `.explicitMod`. The `--explicit` BEM modifier is a built-in **explicit-only gate** — matches our
  explicit-only data exactly (other affixes render `item-mod--implicit` / `--crafted` / `--rune` / …).
  Read rolls from this node's `textContent`; inject the `≈T{n}` badge into it (prepend/append a child).
- **One result listing = `div.row`** (inside `div.resultset` inside `div.results`). Use for listing-level
  dim. The item card is `div.item-popup--poe2` (rarity modifier e.g. `--magic`).
- **Do NOT use `span.s.lc`** — it's the generic text span, 65 page-wide.
- **Mod text format = `"Adds 17 to 27 Fire damage to Attacks"`** (lowercase "damage"/"to attacks").
  Build the capture regex from our snapshot `display` by escaping it and replacing `#` →
  `([\+\-]?\d+)`, case-insensitive: extracts `[17, 27]`. Avg 22 → lands in **T2** (band 20.5–31), not the
  searched T1 → the lucky-roll case the annotator flags. Detect actual tier by testing both rolls against
  each tier's `ranges` sub-pairs (low∈ranges[0] ∧ high∈ranges[1]).
- `[class*="Mod" i]` matched 44 nodes = total `item-mod` lines across visible listings (case-insensitive
  "mod"); fine as a coarse count, but `.item-mod--explicit` is the precise gate.

Idempotency/coexistence (CONTEXT.md): annotate additively (append our own `poe2tf-` badge node, never edit
TFT/better-trading markup), re-apply on MutationObserver ticks (the results list re-renders on each search).

### 12b. GGG's authoritative tier data (live, confirmed 2026-06-03)

**Big finding:** GGG renders its OWN tier label + range on every result mod line, and our enhancer-derived
snapshot ranges DON'T match it. Same roll `22/35` on `Adds # to # Fire damage to Attacks`: GGG says **P2**,
our snapshot's bands classified it **T1** (ours are wider/overlap more). So §9 result annotation uses GGG's
tier, NOT our snapshot. (The core MIN-fill still uses the snapshot — a deferred accuracy audit, CONTEXT.md)

Source of the tier data = the **`/api/trade2/fetch/` response**, captured via the spike (`spike2-page.js`
`recordFetch`, "Dump fetch tiers" button). Per result item: `item.extended.mods.explicit[]`:
```json
{ "name": "of Valour", "tier": "S3", "level": 55,
  "magnitudes": [ { "hash": "explicit.stat_3695891184", "min": "41", "max": "53" } ] }
```
- **`tier`** = affix letter + rank: **`P`**refix / **`S`**uffix + number (`P2`, `S3`). Lower number = better.
- **`level`** = the mod's required item level (= our snapshot `ilvl`).
- **`magnitudes`** = the tier's range as `{hash,min,max}` per sub-roll. Averaged mods have TWO entries (same
  hash) = `[[lo,lo],[hi,hi]]`; single-value mods one. This is what the `[20—24 to 33—36]` bracket renders.
- `extended.hashes.explicit` = `[[stat_id,[idx]], …]` maps stat → magnitude index.

**Chosen §9 approach = parse from the DOM** (not fetch-intercept): GGG's label + bracket are already in the
`.item-mod--explicit` textContent, e.g. `P2 [20—24 to 33—36]Adds 22 to 35 Fire damage to Attacks`. Parsers
in `src/content/detect-tier.mjs` (`parseGggTier`, `parseGggRanges`, `rollQuality`), node-tested in
`tools/test-detect.mjs`. **No static GGG tier table exists** — tiers come only per-item via fetch — so this
can't (cheaply) re-source the whole filter-side snapshot; it's perfect for per-result annotation though.

---

## 13. §10 snapshot↔GGG tier-range audit — TOOLING BUILT (2026-06-03)

The core MIN-fill uses our snapshot's `tierFloor`; if a tier's snapshot band drifts from GGG's real band the
fill is off. Tooling to quantify that drift (spot-check first, per user):

**Key insight:** GGG's `magnitudes` ARE the full tier band (the `[lo—lo to hi—hi]` bracket), not a single
item's roll — so **one captured result item of a tier reveals that tier's whole range.** No aggregation needed.

**Capture (spike, additive):** `spike2-page.js` now accumulates every explicit-mod observation across ALL
items in every `/fetch` response into `state.audit`, deduped by `tier + stat-hashes + band` (so family-split
1H/2H bands stay distinct; identical bands on different bases collapse). Each entry = `{tier:"P2", level,
name, base, magnitudes:[{hash,min,max}]}`. Panel (§10 section) shows a running "GGG tier bands captured: N";
**Export audit** → downloads `ggg-audit-capture.json`; **Clear** resets the accumulator.

**Audit (offline):** `node tools/audit-ranges.mjs [--in <capture.json>] [--all] [--json] [--eps n]`.
Joins the dump to the snapshot on `(tradeStatId+alts, affix-letter P/S → prefix/suffix, rank → tier number)`,
routing family-ambiguous ids to the best-fit family. Reports **`fillDrift = snapshotMIN − gggMIN`** (the
headline: +ve = snapshot over-fills/leaks worse rolls, −ve = under-fills/hides valid items), plus per-sub-band
min/max deltas, ceil drift, and a summary (exact vs drifted, mean/median/max |fillDrift|, signed-mean bias,
unmatched obs). Default capture path = `tools/data-sources/ggg-audit-capture.json`. Self-validated against a
synthetic snapshot-derived capture (exact band → 0, shifted band → exact predicted drift).

**Workflow:** (1) load spike on the live trade page, (2) run varied searches so results load across item
types/ilvls (start with high-value mods: damage-to-attacks, resistances, life), (3) Export audit → drop the
file in `tools/data-sources/`, (4) `node tools/audit-ranges.mjs --all`, (5) read drift, decide remediation
(correct pipeline vs aggregate-from-fetch vs accept). Remediation decision waits for real numbers.

### 13a. AUDIT RESULTS — first capture (91 obs, Runes of Aldur, 2026-06-03)

**Headline: snapshot band VALUES are accurate; the alarming "drift" is a tier-LABEL artifact, not a data error.**
- Rank-joined fill drift looked scary (max +157, mean |∆| 21.8, biases HIGH) — but that join is **wrong** for
  multi-base stats. GGG's `P2`/`S3` rank is assigned **per item base** (smaller bases support fewer tiers, so a
  quiver's `P1` = our ilvl `T2`); our tier number is **per ilvl**. So rank≠tier for anything rolling on >1 base.
- **Rank-independent value match (the real test):** **62/81 bands exact** (residual 0). **30 rows = rank-label
  offset only** (value correct). **mean value residual = 2.53** (tiny). Verified exact-by-value across Accuracy,
  Fire/Cold/Lightning Resistance, maximum Life/Mana, ES, crit, attack speed, attributes, pierce, proj speed.
- **19 "true value drift" rows, but these split:**
  - **Base-coverage gaps (small, ~2–12):** our ONE ladder per stat carries one base-class's bands; other bases
    (quivers, bracers, gloves) have slightly different bands we don't model. E.g. Life on bracers 33–41 vs our
    nearest 30–39. Not wrong — just unmodeled per-base variants.
  - **Averaged elemental "Adds # to # X damage to Attacks" hi-sub-band MIN runs ~6–12 low** (lo-band + hi-MAX
    match exactly). Lowers the averaged fill floor by ~3–6 → minor leak of lower rolls. **Could be a generator
    bug OR quiver-vs-weapon base diff** — captured obs were quivers; needs ONE weapon-base capture to disambiguate.
  - **One real outlier — `# to # Physical Thorns damage` (residual 82):** GGG P3 on Avian Targe = 40–60/61–92,
    ABOVE our entire ladder (top T1 = 31–38/46–56). Our thorns values are systematically ~1.5× too low →
    genuine snapshot data error (niche mod). Targeted-fix candidate.
- **13 unmatched obs:** armour-base mods absent from our snapshot (stat_3639275092, _1692879867, buckler block
  stats _124859000/_53045048, etc.) + 4 **null-tier** Scout's Vest mods (GGG ships no tier for some mods — likely
  quality/unique/untiered). Coverage gaps, not errors.
- **Secondary design finding (NOT a fill-value bug):** because our picker offers **ilvl tiers** and GGG ranks
  **per base**, on a small base our high tiers can be **unreachable** (pick Life "T1"=200 on boots → fill 200 →
  zero results). Whether to scope offered tiers to the searched base (or surface GGG-style per-base ranks) is a
  picker-UX question, separate from data accuracy. Deferred to a milestone, user's call.

**Tooling fix during analysis:** `audit-ranges.mjs` fill-drift legend sign was backwards — corrected to
`+∆ ⇒ MIN too HIGH → hides valid; −∆ ⇒ MIN too LOW → leaks worse`. Added rank-independent value matching +
the BAND-VALUE ACCURACY summary (`val‼` column = true residual, `·` = exact-somewhere ⇒ label-only offset).

### 13b. GGG-override layer — BUILT (fixes Thorns + elemental hi-min; user-approved)

**Root cause (both fixes):** the enhancer/PoE2DB SOURCE data is wrong, NOT our generator (it transcribes the
source faithfully). Elemental "to Attacks" hi-sub-band MINs are ~1 tier too wide (confirmed SAME base, quiver/
gloves/ring — not a base diff); Thorns is ~2× too low at the same ilvl. GGG's structure differs (different tier
COUNT + breakpoints; `level` 75 vs our ilvl 76; tiers at lvl 60 AND 65 where source has one at 64), so a
per-tier patch can't work — must **replace the whole ladder** per stat from GGG's bands.

**Mechanism (full-ladder replacement, GGG-authoritative):**
- `tools/build-overrides.mjs --in <capture.json> [--in …] [--merge]` → builds reviewable
  `tools/data-sources/ggg-overrides.json`. Keys tiers by the **band itself** (base-independent; GGG rank/level
  are per-base noise), dedups distinct bands, sorts best→worst, numbers T1..Tn, keeps min observed `level` as
  ilvl. Targets only the known-broken stats (`--stats` substrings; default = the 3 elemental "to attacks" +
  Physical Thorns; Physical-to-Attacks EXCLUDED — it audited exact). Reports completeness `distinctTiers /
  sourceTierCount` with a ⚠ when incomplete. `--merge` unions tiers across multiple capture exports.
- `build-data.mjs` reads `ggg-overrides.json` and REPLACES matching ladders (by `tradeStatId`, optional
  `family`), re-ranking best→worst, marking `_src:"ggg-override"`. **SAFETY:** if an override has FEWER tiers
  than the source ladder it's skipped (kept source) unless the entry has `"force":true` — prevents an incomplete
  capture from silently dropping tiers. Verified end-to-end: forced-partial apply produced exact GGG lightning
  tiers; the layer is dormant/graceful when the file is absent. Live snapshot untouched (built to temp).

### 13c. FIX SHIPPED ✅ (v0.2.10, 2026-06-03)

Second capture (`tools/data-sources/ggg-audit-capture(1).json`, 35 targeted obs) gave COMPLETE ladders for all
four targets — `build-overrides` reported **7/7 (thorns), 9/9 (fire/cold/lightning) ✓**. Applied via
`build-data.mjs` → `assets/data-snapshot.json` (now carries `_src:"ggg-override"` on these 4 ladders).
Re-audit: **all four targets 0 true drift, every tier exact.** Thorns was the worst — source T1 `31-38/46-56`
vs GGG `101-151/152-220` (~3-4× too low across the whole ladder), now correct. Elemental hi-band mins fixed.
- `tools/validate.mjs` passes; `tools/test-detect.mjs` — 3 fire-tier expectations were pinned to the OLD
  ladder (17-27 was "T2"); updated to the corrected GGG tiers (17-27→T3, 5-9→T8). 16/16 pass.
- Remaining 79 "true drift" rows are all the **multi-base flat stats** (Life/Mana/ES/Armour/Evasion variants,
  rarity, flask/charm charges) — the base-coverage-gap category (one ladder/stat can't carry every base's
  variant), NOT fill-value errors. `Adds # to # Physical Damage to Attacks` T9 is off by 1pt (`3-3` vs `3-4`,
  weakest tier) — left as-is (negligible; wasn't a target). These are the natural next sweep if ever desired.
- Artifacts: `tools/data-sources/ggg-overrides.json` (the applied override, reviewable/re-runnable);
  `build-overrides.mjs` + `audit-ranges.mjs` reusable for future patches/leagues.
