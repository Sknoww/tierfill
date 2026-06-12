/*
 * refresh — one-command per-patch data refresh (PoE2DB-direct).
 *
 *   node tools/refresh.mjs            # re-scrape PoE2DB, rebuild snapshot, warn on new unjoined mods
 *   node tools/refresh.mjs --dry      # scrape report only — writes NOTHING, no rebuild
 *   node tools/refresh.mjs --no-fetch # skip the scrape, just rebuild + report (after a manual GGG re-capture)
 *
 * What it does (and deliberately does NOT do):
 *   • Re-scrapes every PoE2DB item-class page (tools/scrape-poe2db.mjs) → poe2db-mods.json,
 *     the authoritative per-patch input. Backs up the previous scrape first.
 *   • Runs build-data.mjs (which now DEFAULTS to this source) to regenerate
 *     assets/data-snapshot.json.
 *   • Reports which stat texts were added/removed this patch, and — the key signal —
 *     which NEWLY-ADDED mods did NOT join to a GGG stat id. Those are the ones that
 *     need a fresh GGG /api/trade2/data/stats capture (which can't be auto-downloaded:
 *     GGG is Cloudflare-blocked to server-side fetch; it's a manual browser capture).
 *   • Does NOT touch the GGG capture or the manifest version — those stay manual on
 *     purpose (ids/text rarely change; version bump is your call).
 */
import { readFile, copyFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, 'data-sources');
const POE2DB = join(SRC, 'poe2db-mods.json');
const BACKUP = `${POE2DB}.bak`;
const REPORT_TMP = join(SRC, '.refresh-report.tmp.json');

const DRY = process.argv.includes('--dry');
const NO_FETCH = process.argv.includes('--no-fetch');

// Spawn the PoE2DB scraper. With --dry it prints its report and writes nothing.
function runScrape(args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(here, 'scrape-poe2db.mjs'), ...args], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`scrape-poe2db.mjs exited ${code}`))));
  });
}

// prefix+suffix stat texts as a flat Set of "bucket:text" (build-data ingests only
// these two buckets; implicit is skipped, so we ignore it here for an honest diff).
function statKeys(data) {
  const keys = new Set();
  for (const bucket of ['prefix', 'suffix']) {
    for (const text of Object.keys(data[bucket] || {})) keys.add(`${bucket}:${text}`);
  }
  return keys;
}

function runBuild(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(here, 'build-data.mjs'), ...args], {
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`build-data.mjs exited ${code}`)),
    );
  });
}

async function main() {
  let added = new Set();
  let removed = new Set();

  if (NO_FETCH) {
    console.log('--no-fetch: skipping the scrape, rebuilding from the current source files.\n');
  } else if (DRY) {
    // Honest dry-run of the fetch step: the scraper prints what it found and writes nothing.
    console.log('--dry: scraping PoE2DB (writes nothing, no rebuild)…\n');
    await runScrape(['--dry']);
    console.log('\n--dry: source file and snapshot are unchanged.');
    return;
  } else {
    // 1. read the current scrape (for the diff + backup). Missing is fine (first run).
    let oldData = null;
    try {
      oldData = JSON.parse(await readFile(POE2DB, 'utf8'));
    } catch {
      console.log('(no existing poe2db-mods.json — treating every mod as new)');
    }
    if (oldData) await copyFile(POE2DB, BACKUP);

    // 2. re-scrape PoE2DB (writes poe2db-mods.json). The scraper validates per page and
    //    throws on a hard failure, so a broken run surfaces here before the rebuild.
    console.log('re-scraping PoE2DB…\n' + '─'.repeat(60));
    await runScrape();
    console.log('─'.repeat(60));

    const newData = JSON.parse(await readFile(POE2DB, 'utf8'));
    if (!newData.prefix || !newData.suffix) {
      throw new Error('scrape produced no prefix/suffix buckets — refusing to rebuild');
    }

    // 3. diff stat texts (prefix+suffix)
    const oldKeys = oldData ? statKeys(oldData) : new Set();
    const newKeys = statKeys(newData);
    added = new Set([...newKeys].filter((k) => !oldKeys.has(k)));
    removed = new Set([...oldKeys].filter((k) => !newKeys.has(k)));

    const fmt = (d) =>
      `prefix ${Object.keys(d.prefix || {}).length} · suffix ${Object.keys(d.suffix || {}).length}`;
    console.log(`\n  previous: ${oldData ? fmt(oldData) : '(none)'}`);
    console.log(`  scraped:  ${fmt(newData)}`);
    console.log(`  added stat texts:   ${added.size}`);
    console.log(`  removed stat texts: ${removed.size}`);
    if (added.size) {
      console.log('\n  + added:');
      for (const k of [...added].sort()) console.log(`      ${k}`);
    }
    if (removed.size) {
      console.log('\n  - removed:');
      for (const k of [...removed].sort()) console.log(`      ${k}`);
    }
    if (oldData) console.log(`\n  (backup: ${BACKUP})`);
  }

  // 5. rebuild the snapshot, capturing the machine-readable report
  console.log('\nrebuilding snapshot…\n' + '─'.repeat(60));
  await runBuild(['--report', REPORT_TMP]);

  // 6. surface NEW mods that didn't join to a GGG id (the re-capture signal)
  let report = null;
  try {
    report = JSON.parse(await readFile(REPORT_TMP, 'utf8'));
  } finally {
    await unlink(REPORT_TMP).catch(() => {});
  }

  console.log('\n' + '─'.repeat(60));
  if (report && !report.gggPresent) {
    console.log('⚠ No GGG capture present — display text/ids are unresolved for every mod.');
  } else if (report) {
    const unmatched = new Set(report.unmatchedGgg || []);
    const newlyUnmatched = [...added].filter((k) => unmatched.has(k));
    if (newlyUnmatched.length) {
      console.log(`⚠ ${newlyUnmatched.length} NEWLY-ADDED mod(s) did not join to a GGG id:`);
      for (const k of newlyUnmatched.sort()) console.log(`      ${k}`);
      console.log(
        '\n  These need a fresh GGG /api/trade2/data/stats capture to get a tier control.\n' +
          '  Re-capture it in the browser (PLAN §5 / FINDINGS §11), drop it at\n' +
          `      ${join(SRC, 'ggg-trade2-stats.json')}\n` +
          '  then re-run:  node tools/refresh.mjs --no-fetch',
      );
    } else {
      console.log(
        `✓ GGG join clean for new mods (${(report.unmatchedGgg || []).length} total unmatched, unchanged from this patch's additions).`,
      );
    }
  }

  console.log('\nDone. Next: bump the version in manifest.json and reload the extension.');
}

main().catch((e) => {
  console.error('\n✖ refresh failed:', e.message);
  console.error('  Nothing was changed if the failure was during download/validation.');
  process.exit(1);
});
