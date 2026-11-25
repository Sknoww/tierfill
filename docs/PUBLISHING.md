# TierFill — store listing copy

> The **canonical store-listing copy** that stays
> the same across versions — name, summary, description, single-purpose statement,
> permission justification, and the fixed submission assets/links. Paste from here
> when a store listing field needs the standing copy.
>
> **Per-update steps** (version notes, changelog, reviewer notes, uploads) follow
> `submission-template.md` in this folder — that's the per-version workflow; this
> file is the unchanging listing copy it defers to.

---

## Ready-to-paste listing copy

**Name** (auto-filled from manifest): `TierFill — PoE2 Trade Tier Filter`

**Short summary** (Chrome max 132 chars):
```
Filter Path of Exile 2 trade mods by tier instead of raw numbers — pick a tier and it fills the correct minimum for you.
```

**Description:**
```
TierFill adds a small tier picker to each stat-filter row on the Path of Exile 2
trade site. Instead of looking up numeric breakpoints and typing them in, you pick
a mod the normal way, choose a tier (e.g. T1), and TierFill fills the correct
minimum value for you.

Features:
• Per-row tier picker — a compact "≈ TIER" control appears left of the MIN box on
  stat rows it has data for. Pick a tier; it fills the computed minimum.
• Handles averaged flat-damage mods (Adds X to Y) automatically — these are
  filtered against the average of the two rolls, and TierFill does the math.
• Inclusive / Strict modes — Inclusive never misses a tier; Strict only keeps
  results genuinely at the tier or better.
• Result tier badges — each searched mod on a result is annotated with its tier
  and roll quality, so you can see at a glance which results hit your target.
• Stays out of the way — it only fills the native inputs and lets the site run the
  search. It never automates searches or contacts Grinding Gear Games' servers.

Scope: TierFill works on explicit stat mods (the prefixes/suffixes that roll on
weapons, armour, jewellery, jewels, charms, and life and mana flasks). It does not
add a picker for pseudo mods, implicit/
rune/crafted/enchant mods, or mods on items outside that scope such as tablets —
those rows are left as the trade site's normal number boxes.

TierFill collects no data and makes no network requests — everything runs locally
in your browser. Open source (MIT): https://github.com/Sknoww/tierfill

Unofficial fan-made tool. Not affiliated with or endorsed by Grinding Gear Games.
```

**Single purpose** (Chrome asks for this):
```
TierFill adds a tier picker to the stat-filter rows on the Path of Exile 2 trade
site and fills the computed minimum value for the tier you choose.
```

**Permission justification** (host access to the trade site):
```
The extension runs a content script only on Path of Exile 2 trade pages
(www.pathofexile.com/trade2) to read the stat-filter rows and fill in tier values.
It needs access to those pages to add its controls. It makes no network requests
and accesses no other sites.
```

**Data collection:** select **"Does not collect user data."**

**Category:** Tools (or Productivity)  **Language:** English

---

## Fixed submission assets & links

- **Screenshots** (1280×800, upload to both listings):
  - `screenshots/store/01-tier-control.png`
  - `screenshots/store/02-result-badges.png`
- **Store icon:** taken from the manifest (128px) automatically.
- **Privacy policy URL:** https://github.com/Sknoww/tierfill/blob/main/PRIVACY.md
- **Source / repo:** https://github.com/Sknoww/tierfill
- **Data usage:** Does not collect user data.
- **Live listings:**
  - Firefox: https://addons.mozilla.org/en-US/firefox/addon/tierfill-poe2-trade/
  - Chrome: https://chromewebstore.google.com/detail/gglcnglencknfbdejeepmfibimnlicjd
