# TierFill — Context

Durable facts and decisions. Task status lives in the repo's issues and milestones
(https://github.com/Sknoww/tierfill/issues). Live trade-site DOM facts live in
`spike/FINDINGS.md`.

## Goal

The PoE2 trade site's stat filters are raw `min`/`max` boxes. TierFill adds a tier
picker to each stat row: pick a tier, and it fills the right MIN. It also badges the
searched mods on results with their real tier.

**Non-goals:** PoE1 for now, automating searches, or calling GGG endpoints.

## How to work

- Start with `/next` (next milestone task) or `/grab` (top of the Queue), or name an
  issue as `#n`. File new ideas with `/idea` and sort the inbox with `/triage`. The
  format is in `~/.claude/rules/roadmap.md`.
- Commit with `#n` in the message and close the issue once its Done-when is met.
- Everything in this repo is public except the gitignored `tools/data-sources/`.

## Locked decisions

| Decision | Choice |
| --- | --- |
| Platform | Manifest V3 for Firefox and Chrome, one codebase, no polyfill |
| Game scope | PoE2 only (`/trade2/`) |
| Form factor | Per-row control left of MIN; the user adds the stat the normal way |
| Search | Never automatic; we fill MIN and the user clicks Search |
| Coverage | Explicit mods only; rows without data get no control rather than a guess |
| Matching | Exact stat text, because local `Adds # to # Physical Damage` and global `... to Attacks` are different mods |
| Data delivery | Bundled snapshot only; refreshed offline per patch and shipped in a release |
| Data source | PoE2DB scrape joined to GGG's trade stat list |
| Tier label | Always "≈ T{n}", because tier overlap can't be fully eliminated |
| Privacy | No data collection and no network requests; any change must be called out in the store privacy practices |

**Dropped on purpose:**
- **Background refresh worker:** needs a service worker, a cache, new host permissions
  and the Cloudflare-blocked GGG fetch, which isn't worth it for a per-patch update.
- **Exact-band mode:** it writes MAX too; the two MIN-only modes cover the lucky-roll case.

## Architecture

Everything runs as a content script on the trade page, with no background script.

- `src/content/loader.js` — classic content script that dynamically imports the ESM
  app, since manifest content scripts can't be modules.
- `src/content/index.mjs` — watches stat rows and injects controls.
- `src/content/detect.mjs` — reads the searched item type or category.
- `src/content/affix.mjs` — prefix/suffix ladder handling, such as combined Rarity.
- `src/ui/tier-control.mjs` — the picker and its Inclusive/Strict bar.
- `src/tiers/compute.mjs` — tier-to-value math.
- `src/content/results.mjs`, `detect-tier.mjs`, `store.mjs` — result badges and the
  shared selection store.
- `assets/data-snapshot.json` — generated tier data.
- `tools/` — data pipeline, tests, packaging, and the dev-only `viewer.mjs`.

The stat row's `span.filter-body` is `display:table`, so the control must be
`display:table-cell` or it overlaps the MIN input.

## Tier computation

- **Single-value mods:** `min = tier floor`.
- **Averaged mods (`Adds # to #`):** the trade MIN compares against the average of the
  two rolls, so `min = (loMin + hiMin) / 2`. Confirmed live: `Adds 14 to 26` averages
  20, so min 19 shows it and min 21 hides it. Worked example: T1
  `Adds (12–19) to (22–32)` gives min 17.
- **Overlap:** the two rolls are independent, so a lucky lower-tier roll can beat a
  higher tier's floor. No single MIN isolates a tier.
- **Inclusive (default):** the formula above. Never misses the tier but can leak lucky
  lower-tier rolls.
- **Strict:** just above the highest average any lower tier can reach. Every result is
  at the tier or better, but low-rolled items of that tier drop out.
- **Jewels:** one wide range and no ladder, so the picker offers percentile presets
  (Min/25/50/75/90/Max) and results show where the roll sits in its range.
- **Rarity:** rolls as both prefix and suffix and trade sums them, so the combined
  ladder's floors are per-tier sums.

## Result badges

- Read from GGG's own tier and range text on each `.item-mod--explicit` line, not from
  the snapshot, so they're accurate even if the snapshot drifts.
- Badge shows tier and roll quality: green at or above the target, amber below.
- On by default, with a toggle docked beside the site's Clear button.
- Applies only to listings on the current page; it refines results and never re-queries.

## Data pipeline

```
PoE2DB item-class pages -> tools/scrape-poe2db.mjs -> data-sources/poe2db-mods.json ─┐
GGG /api/trade2/data/stats (browser fetch) -> data-sources/ggg-trade2-stats.json ────┤
                                                                                     v
                                  tools/build-data.mjs -> assets/data-snapshot.json
```

- **Per patch:** `node tools/refresh.mjs` re-scrapes and rebuilds, and warns about newly
  added mods that didn't join to a GGG id. `--dry` writes nothing; `--no-fetch` rebuilds
  after a fresh GGG fetch.
- **GGG lists** (`/api/trade2/data/stats`, `/items`, `/filters`) are fetched from a
  browser on the trade site, with no login; server-side fetches are Cloudflare-blocked.
  `node tools/capture-ggg.mjs` prints a console snippet that downloads all three, then
  splits that file into `tools/data-sources/`. The trade page's CSP blocks posting to a
  local server, so the download step is needed. `tools/data-sources/` is gitignored and
  not backed up, so a fresh clone re-fetches and re-scrapes.
- **Item families:** one stat can have different ladders per item type. They're split by
  union-find on shared `types`, and a toggle appears when the item type is ambiguous.
- **Snapshot entries** hold `tradeStatId`, `display`, `affix`, `isAveraged`, `family`,
  `types`, and `tiers` (`tier`, `ilvl`, `ranges`). One range pair means a single value;
  two mean averaged. T1 is best.
- **Legacy:** `build-data.mjs --base` still runs the old enhancer path; removing it is milestone
  04 Pipeline cleanup.

## Writing to the site

trade2 is Vue, not AngularJS. To fill MIN, call the native value setter, then dispatch
`input`, `change` and `blur`. This doesn't trigger a search. Clicking `button.search-btn`
does, and synthetic Enter doesn't.

Held in reserve for adding a stat automatically (`FINDINGS §8–9`):
- Drive `input.multiselect__input` and select with `mousedown`; this runs zero searches.
- Navigate to a `?q=` URL, which hydrates the row and runs one search.

## Coexistence

Primary target is `Vali-98/better-trading`; secondary is TFT's PoE Trade Extension.

- Fill native inputs only, so other extensions' bookmarks and history capture our values.
- Keep changes additive and idempotent, namespace everything `poe2tf-`, and never edit
  native nodes.
- The results list is the main overlap risk, since all three extensions decorate it.
- No global hotkeys.

## ToS stance

Client-side tools that improve the trade website are the established norm. We drive only
the UI the user is already using, take game data only from community sources, and never
automate searches or add load to GGG's servers.

## Testing and release

- **Tests:** `node tools/validate.mjs`, plus `tools/test-affix.mjs`, `test-detect.mjs`,
  `test-family-label.mjs` and `test-jewel.mjs`. There are no dependencies or `package.json`.
- **Release:** bump `manifest.json`, tag `vX.Y.Z` and push. The workflow checks the tag
  against the manifest and attaches both store zips to a GitHub Release.
- **Store submission:** follow `docs/submission-template.md`; standing listing copy is in
  `docs/PUBLISHING.md`.
- **Listings:** [Firefox](https://addons.mozilla.org/en-US/firefox/addon/tierfill-poe2-trade/),
  [Chrome](https://chromewebstore.google.com/detail/gglcnglencknfbdejeepmfibimnlicjd).
