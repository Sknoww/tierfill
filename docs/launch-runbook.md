# PoE2 1.0 launch-day data runbook

The ordered steps for shipping a data release on a major patch day. Written for
the 1.0 launch (2026-12-11, patch notes expected around 2026-12-04); it applies
to any league launch.

Times are relative to **T**, the moment the realm opens. Durations are rough.
The dry run (#21) measures them on the current patch, so update them afterwards.

All commands run from the repo root, on any of the three machines (Node only, no
dependencies). `tools/data-sources/` is gitignored and not synced, so do the
whole day on one machine. To use a fresh clone, run step 0 there first.

## Before the day

| When | Step | Command | Time |
| --- | --- | --- | --- |
| T−7d | Read the patch notes. List new item classes, removed or reworked mods, and anything that touches the [#22](https://github.com/Sknoww/tierfill/issues/22) disagreements. | — | 30 min |
| T−7d | Add each announced new item class to `tools/item-classes.json`. You can leave its `pages` empty until PoE2DB has the slug. | edit | 10 min |
| T−1d | **Step 0:** set up a baseline on the launch machine. Run a full refresh on the old patch, check that the gates pass, and keep that `patch-diff.md` to compare against. | `node tools/refresh.mjs` | ~5 min |
| T−1d | Copy the baseline report so launch day's diff reads against it. | `cp tools/data-sources/patch-diff.md tools/data-sources/patch-diff.baseline.md` | — |
| T−1d | Run the tests so launch day starts green. | `node tools/validate.mjs` and each `tools/test-*.mjs` | 1 min |
| T−1d | Open `docs/submission-1.0-launch.md` (the pre-drafted submission) and check that it's still current. | — | 5 min |

## Launch day

| When | Step | Command | Time |
| --- | --- | --- | --- |
| T−2h | The patch server comes up and PoE2DB starts updating its pages. Check one page that should change, for example a new class or a reworked mod. Scrape only once it shows the new data. | `node tools/scrape-poe2db.mjs --page Bows` (dry, one page) | 2 min |
| T−2h → T | **Scrape and rebuild.** The scraper fails fast on a 404'd, renamed or near-empty page. If a pool really halved in the patch notes, re-run with `--allow-drop`. | `node tools/refresh.mjs` | ~5 min |
| | If a gate fails on an unmapped GGG category, it's a new class. Add it to `tools/item-classes.json` (token, category, PoE2DB page slug, RePoE `item_class`, hand), then re-run. | edit, then `node tools/refresh.mjs` | 10 min |
| T | **GGG capture #1.** The trade lists only change when the realm opens. Print the snippet, paste it into devtools on `pathofexile.com/trade2`, then split the downloaded file. | `node tools/capture-ggg.mjs` then `node tools/capture-ggg.mjs --downloads` | 5 min |
| T | Rebuild against the fresh GGG stats without re-scraping. | `node tools/refresh.mjs --no-fetch` | 1 min |
| T → T+30m | **Review `tools/data-sources/patch-diff.md`** against the patch notes and the baseline. For each flagged ladder decide: expected (patch notes), source error, or our bug. Add new unjoined stats and new GGG explicit stats as `/idea` issues unless they're trivial. | read | 20–30 min |
| T+30m | **Live spot-check.** Pick about 5 ladders: a changed one, a new class, an averaged `Adds # to #`, Rarity, and a jewel. Search each on the live trade site with the TierFill MIN and confirm the results match the tier. Use `node tools/validate.mjs` for the computed MINs. Until #20 lands, this is done by hand. | `node tools/validate.mjs` | 15 min |
| T+1h | **GGG capture #2.** GGG often adjusts the stat list in the first hour. Capture again and rebuild. If `patch-diff.md` changed since the review, re-read only the new lines. | capture as above, then `node tools/refresh.mjs --no-fetch` | 10 min |
| T+1h | Run the tests. | `node tools/validate.mjs` and each `tools/test-*.mjs` | 1 min |
| T+1h | **Commit the data.** | `git add assets/data-snapshot.json tools/item-classes.json` then `git commit -m "Refresh the snapshot for PoE2 1.0"` | 2 min |
| T+1h | **Version and tag.** Bump `manifest.json` (minor for a patch-day data release). Push the tag; the workflow checks it against the manifest and attaches both zips to a GitHub Release. | edit `manifest.json`, commit, then `git tag vX.Y.Z` and `git push origin main vX.Y.Z` | 5 min |
| T+1h | Check the release has `tierfill-chrome.zip` and `tierfill-firefox.zip`. | `gh release view vX.Y.Z` | 3 min |
| T+1h | **Submit.** Copy `docs/submission-1.0-launch.md` to `docs/submission-X.Y.Z.md`, fill the version and notes, add the new changelog entry to `docs/submission-template.md` too, and follow its Chrome and Firefox steps. | — | 20 min |
| T+1h | Commit the submission file. | `git add docs/` then `git commit` and `git push` | 1 min |

Store review takes from hours to a few days, so submit as soon as the data is
trusted rather than waiting for day+1.

## Day +1: the RePoE cross-check

RePoE lagged 10–22h behind past launches, so this check only means something
the day after launch. Until then, a long RePoE section in `patch-diff.md` most
likely means RePoE is still a patch behind. The report says when the files were
fetched, and the download logs RePoE's own last-modified time.

| When | Step | Command | Time |
| --- | --- | --- | --- |
| T+1d | Download RePoE and re-run the checks against the committed snapshot. | `node tools/repoe.mjs` then `node tools/check-data.mjs` | 3 min |
| T+1d | Read the RePoE section against the baseline's. Anything new is either a PoE2DB error (fix, then hotfix release) or a RePoE gap (note it in #22's style as an issue). | read | 15 min |

If PoE2DB is broken or very late on launch day, RePoE is the fallback source.
No tooling builds a snapshot from it yet, so in that case ship nothing until
PoE2DB recovers. The 1.2.x snapshot keeps working for unchanged mods.

## First week: daily re-run

GGG ships hotfixes almost daily in launch week, and PoE2DB and RePoE follow
them. Once a day until the hotfixes slow down:

1. `node tools/refresh.mjs`. It also downloads RePoE and compares against the
   committed snapshot.
2. If `git diff --stat assets/data-snapshot.json` is empty, stop.
3. Otherwise review `patch-diff.md`, spot-check the changed ladders, and capture
   GGG again if new stats didn't join.
4. Ship a patch release (`X.Y.Z+1`) with the same commit, tag, submit steps as
   above. Batch small changes, because each submission goes through store review.

## If something goes wrong

- **A ladder is a source error and there's no time to fix it.** On the PoE2DB
  path there's no way to hold back one stat yet. The options are to ship
  anyway, delay the release, or fix the scrape. Choose based on how many users
  the stat affects. A hold-back list is [#23](https://github.com/Sknoww/tierfill/issues/23).
- **The scraper stops on a page.** Check that page on PoE2DB. If it was renamed,
  update its slug in `tools/item-classes.json`. If it's empty, PoE2DB is still
  updating, so wait and retry.
- **The tag doesn't match the manifest.** The workflow fails before it builds.
  Delete the tag (`git tag -d vX.Y.Z` then `git push origin :vX.Y.Z`), fix
  `manifest.json`, and tag again.
- **The GGG capture snippet fails.** A Cloudflare "Just a moment…" page also
  works. Wait for it to pass, then paste again.
