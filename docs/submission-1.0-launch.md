# TierFill — submission draft for the PoE2 1.0 data release (Chrome + Firefox)

> Pre-drafted from `docs/submission-template.md` for the 1.0 launch
> (`docs/launch-runbook.md`). On launch day, copy it to `docs/submission-X.Y.Z.md`
> and fill the placeholders:
>
> - `{{VERSION}}`: the new version, e.g. `1.3.0`.
> - `{{WHATS_NEW_BULLETS}}`: the patch-specific bullets from `patch-diff.md`
>   (new classes, notable ladder changes), or delete the line. It appears twice:
>   in the changelog and in the release notes.
>
> Everything else is filled for 1.2.1 → this release. Add the new entry to the
> living changelog in `docs/submission-template.md` too, and delete this note.
> If `manifest.json` changed beyond the version, update the manifest note and
> the reviewer block.

---

## Living changelog (paste into both store descriptions)

```
Changelog

v{{VERSION}}
• Updated for Path of Exile 2 1.0: every tier ladder rebuilt from the 1.0 game
  data.
• Talismans now get a tier picker and result badges.
{{WHATS_NEW_BULLETS}}

v1.2.1
• Fixed scrambled tier numbers on several ladders where PoE2DB had mixed in
  tiers belonging to other item bases. Affected "Level of all Spell Skills"
  and "Level of all Minion Skills", the Remnants collection range, and Belt
  mana regeneration — these now show the correct tiers in the right order.

v1.2.0
• Rebuilt every mod's tier data directly from PoE2DB. Many weapon mods had been
  showing values that were too low — most noticeably caster staves, which were
  sharing the wand tiers for Spell Damage, Critical Spell Damage Bonus, Gain #%
  of Damage as Extra Fire/Cold/Lightning, and maximum Mana. Those now use the
  correct (higher) staff tiers.
• Around 230 more mods now have a tier picker and result badges.
• Corrected an over-inflated Block ladder, removed some phantom tiers, and fixed
  understated charm recovery.

v1.1.1
• Bows and crossbows now use their own added-damage tiers for "Adds # to #"
  Physical / Fire / Cold / Lightning Damage. They had been using the lower
  one-handed values, so tier picks filled minimums that were too low — now
  corrected tier-for-tier from PoE2DB.

v1.1.0
• Life and Mana flask mods now get a tier picker and result badges.
• Jewels: set a minimum by roll percentile (Min / 25% / 50% / 75% / 90% / Max);
  results show how high each roll sits in its range.
• Item-type selector is now a labelled dropdown (One-Handed, Caster, Jewellery, …).
• "Increased Rarity of Items found": corrected tier data and a combined,
  item-type-aware prefix+suffix ladder.

v1.0.2
• Tier picker and badges now work on desecrated and fractured mods.
• Added the deflection mod "Gain Deflection Rating equal to #% of Evasion Rating".
• "Increased Rarity of Items found" ladders labelled by prefix/suffix, with live
  item-type re-resolution when you change the item category or base.

v1.0.1
• Firefox submission fixes: declared no data collection and switched to safe DOM
  building (no innerHTML).

v1.0.0
• Initial release — filter PoE2 trade stat mods by tier instead of raw numbers,
  with a per-row tier picker that fills the computed MIN value.
```

---

## At a glance

- **Version:** {{VERSION}} (manifest matches; GitHub release `v{{VERSION}}` has both zips)
- **Manifest change vs 1.2.1:** the version bump only. Privacy practices are
  unchanged: **collects no data, no network requests.**
- **Zips to upload** (download from the GitHub release, or `node tools/package.mjs`):
  - Chrome Web Store → `dist/tierfill-chrome.zip`
  - Firefox AMO → `dist/tierfill-firefox.zip`

---

## Release notes (user-facing — paste into the version notes field)

```
What's new in {{VERSION}}

• Updated for Path of Exile 2 1.0: every tier ladder rebuilt from the 1.0 game
  data.
• Talismans now get a tier picker and result badges.
{{WHATS_NEW_BULLETS}}
```

---

## Changelog for the store descriptions (paste into both listings)

Append the **Living changelog** block above to the end of each store description
(same text for Chrome and Firefox) so the listing shows the full version history.

---

## 1. Chrome Web Store (update)

1. Go to https://chrome.google.com/webstore/devconsole and open the existing
   **TierFill** item.
2. **Package** → upload **`dist/tierfill-chrome.zip`** (version {{VERSION}}).
3. Listing, privacy practices, and permissions carry over unchanged — nothing to
   re-enter. (Re-confirm **"Does not collect user data"** if prompted.)
4. There is no separate "what's new" field; the version is taken from the
   manifest. Paste the **Living changelog** block into the description so the
   listing shows the version history.
5. **Submit for review.** No new permissions were added, so review is typically
   faster than the first submission.

---

## 2. Firefox Add-ons / AMO (update)

1. Go to https://addons.mozilla.org/developers/ → the existing **TierFill**
   listing → **Upload New Version**.
2. Upload **`dist/tierfill-firefox.zip`** (version {{VERSION}}). Automated
   validation runs.
3. **Release notes for this version** → paste the release-notes block above.
4. Add the **Living changelog** block to the listing description so it shows on
   the public listing.
5. **Notes for reviewer** → paste the block below:

```
TierFill is a content script for the Path of Exile 2 trade site
(https://www.pathofexile.com/trade2). It collects no data and makes no network
requests. Source: https://github.com/Sknoww/tierfill

This version is a data update for Path of Exile 2 1.0: the bundled tier data
snapshot is rebuilt from the 1.0 game data, and Talismans are added as an item
class. No new host or API access; the manifest changed only in its version
number.

About account access: the trade site is operated by Grinding Gear Games and
requires a free Path of Exile account to view. TierFill itself needs no account
or login of its own — it only needs the trade page to be open. A free account
can be registered at https://www.pathofexile.com/ (I can't provide credentials
for a third-party game service). If a live account is impractical, the
extension's behaviour is shown in the listing screenshots, the README, and the
short demo video linked below.

To test:
1. Log in to a free Path of Exile account and open
   https://www.pathofexile.com/trade2, then start a search (any league).
2. Add a stat filter such as "Adds # to # Physical Damage to Attacks".
3. A small tier picker appears left of the MIN box; selecting a tier fills the
   computed minimum value. No search is triggered automatically.

Re: the "unsafe call to import" warning (loader.js line 12):
Content scripts are not ES modules, so loader.js bootstraps the module-based app
via import(browser.runtime.getURL('src/content/index.mjs')). The argument is
always a fixed, packaged extension file resolved through runtime.getURL — never
built from user input, page content, or any remote source. No remote code is
loaded.

Demo video (free to view, no account needed): https://youtu.be/OHfvw7xyXPM
```

6. Source code: the add-on is **not minified** (plain JS/CSS/JSON loaded as-is),
   so no source upload is required. If a field insists, point to
   https://github.com/Sknoww/tierfill.
7. **Submit.** Mozilla signs and reviews the new version.

---

## After both are approved

- Listing copy didn't change other than the appended changelog, so no README
  listing edits are needed beyond the store links already added.
- The `v{{VERSION}}` GitHub Release already exists (the tag built and attached
  both zips automatically).
