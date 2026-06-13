/*
 * viewer — dev-only mod/range inspector. NOT shipped with the extension.
 *
 *   node tools/viewer.mjs            # serve on http://localhost:7331 and open the browser
 *   node tools/viewer.mjs --port 8080
 *   node tools/viewer.mjs --no-open  # don't auto-open a browser
 *
 * Why this exists:
 *   When someone says "these values look wrong", pull this up, pick an item type
 *   and a mod, and eyeball its tier/ilvl/value ranges against PoE2DB — without
 *   having to ask Claude to dig through the snapshot.
 *
 * It serves a single static page that fetches the LIVE assets/data-snapshot.json
 * on every load, so it always reflects whatever the extension currently ships.
 * Refresh the data (tools/refresh.mjs), reload the page — done. Nothing here is
 * bundled into the extension; it reads the snapshot read-only.
 */
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT = join(here, '..', 'assets', 'data-snapshot.json');

const argv = process.argv.slice(2);
const NO_OPEN = argv.includes('--no-open');
const portIdx = argv.indexOf('--port');
const PORT = portIdx !== -1 ? Number(argv[portIdx + 1]) : 7331;

const server = createServer(async (req, res) => {
  const url = (req.url || '/').split('?')[0];
  try {
    if (url === '/' || url === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
      return;
    }
    if (url === '/data') {
      // Read fresh on every request so a data refresh shows up on reload.
      const raw = await readFile(SNAPSHOT, 'utf8');
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(raw);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end(String(err && err.message || err));
  }
});

server.listen(PORT, () => {
  const addr = `http://localhost:${PORT}`;
  console.log(`mod viewer  →  ${addr}`);
  console.log(`reading      ${SNAPSHOT}`);
  console.log('Ctrl+C to stop.');
  if (!NO_OPEN) openBrowser(addr);
});

function openBrowser(addr) {
  const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', addr] : [addr];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* best-effort; the URL is printed above */
  }
}

const PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PoE2 Mod / Range Inspector</title>
<style>
  :root {
    --bg: #14110d; --panel: #1d1812; --panel2: #241e16; --line: #3a3024;
    --ink: #e8dcc4; --muted: #9c8e74; --gold: #c8a45a; --prefix: #6fa8dc; --suffix: #d98b6f;
    --hl: #2c2417;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 14px/1.5 "Segoe UI", system-ui, sans-serif;
  }
  header {
    padding: 14px 20px; border-bottom: 1px solid var(--line);
    display: flex; gap: 16px; align-items: baseline; flex-wrap: wrap;
  }
  header h1 { font-size: 16px; margin: 0; color: var(--gold); font-weight: 600; letter-spacing: .3px; }
  header .meta { color: var(--muted); font-size: 12px; }
  .layout { display: grid; grid-template-columns: 320px 1fr; min-height: calc(100vh - 53px); }
  .sidebar { border-right: 1px solid var(--line); display: flex; flex-direction: column; min-height: 0; }
  .controls { padding: 12px; border-bottom: 1px solid var(--line); display: flex; flex-direction: column; gap: 8px; }
  select, input[type=search] {
    width: 100%; padding: 8px 10px; background: var(--panel2); color: var(--ink);
    border: 1px solid var(--line); border-radius: 6px; font: inherit;
  }
  input[type=search]::placeholder { color: var(--muted); }
  .modlist { overflow-y: auto; flex: 1; padding: 6px 0; min-height: 0; }
  .group-label {
    padding: 8px 14px 4px; font-size: 11px; text-transform: uppercase; letter-spacing: .8px;
    color: var(--muted); position: sticky; top: 0; background: var(--panel); border-bottom: 1px solid var(--line);
  }
  .group-label.prefix { color: var(--prefix); }
  .group-label.suffix { color: var(--suffix); }
  .modrow {
    padding: 7px 14px; cursor: pointer; border-left: 3px solid transparent; display: flex;
    justify-content: space-between; gap: 8px; align-items: center;
  }
  .modrow:hover { background: var(--hl); }
  .modrow.active { background: var(--hl); border-left-color: var(--gold); }
  .modrow .name { flex: 1; }
  .modrow .badge { font-size: 10px; color: var(--muted); white-space: nowrap; }
  .empty { padding: 24px 14px; color: var(--muted); }
  .detail { padding: 22px 26px; overflow-y: auto; }
  .detail h2 { margin: 0 0 4px; font-size: 20px; color: var(--gold); }
  .tags { display: flex; gap: 8px; flex-wrap: wrap; margin: 10px 0 18px; }
  .tag {
    font-size: 11px; padding: 3px 9px; border-radius: 999px; border: 1px solid var(--line);
    background: var(--panel2); color: var(--muted);
  }
  .tag.prefix { color: var(--prefix); border-color: #2f4759; }
  .tag.suffix { color: var(--suffix); border-color: #5c3a2e; }
  .kv { color: var(--muted); font-size: 12px; margin: 2px 0; }
  .kv b { color: var(--ink); font-weight: 500; }
  table { border-collapse: collapse; margin-top: 14px; width: auto; }
  th, td { padding: 7px 14px; text-align: right; border-bottom: 1px solid var(--line); white-space: nowrap; }
  th { color: var(--muted); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: .5px; }
  td.tier, th.tier { text-align: left; color: var(--gold); }
  tbody tr:hover { background: var(--hl); }
  .range { font-variant-numeric: tabular-nums; }
  .range .sep { color: var(--muted); }
  .hybrid-note { color: var(--muted); font-size: 12px; margin-top: 10px; }
  .actions { margin-top: 20px; display: flex; gap: 10px; flex-wrap: wrap; }
  a.btn {
    display: inline-block; padding: 8px 14px; border: 1px solid var(--line); border-radius: 6px;
    color: var(--gold); text-decoration: none; background: var(--panel2); font-size: 13px;
  }
  a.btn:hover { background: var(--hl); }
  .placeholder { color: var(--muted); padding: 40px 0; text-align: center; }
  code { background: var(--panel2); padding: 1px 5px; border-radius: 4px; color: var(--ink); font-size: 12px; }
</style>
</head>
<body>
<header>
  <h1>PoE2 Mod / Range Inspector</h1>
  <span class="meta" id="meta">loading…</span>
</header>
<div class="layout">
  <aside class="sidebar">
    <div class="controls">
      <select id="type"></select>
      <input type="search" id="search" placeholder="Filter mods…" autocomplete="off">
    </div>
    <div class="modlist" id="modlist"><div class="empty">Pick an item type.</div></div>
  </aside>
  <main class="detail" id="detail">
    <div class="placeholder">Select a mod to see its tiers and value ranges.</div>
  </main>
</div>
<script>
let STATS = [];          // [{key, ...stat}]
let CURRENT_TYPE = '';
let CURRENT_KEY = '';

const typeSel = document.getElementById('type');
const searchEl = document.getElementById('search');
const listEl = document.getElementById('modlist');
const detailEl = document.getElementById('detail');
const metaEl = document.getElementById('meta');

const prettyType = (t) => t.replace(/-/g, ' ').replace(/\\b\\w/g, c => c.toUpperCase());

async function load() {
  const res = await fetch('/data', { cache: 'no-store' });
  const data = await res.json();
  STATS = Object.entries(data.stats).map(([key, v]) => ({ key, ...v }));
  metaEl.textContent = STATS.length + ' mods · ' + data.version;

  const types = [...new Set(STATS.flatMap(s => s.types || []))].sort();
  typeSel.innerHTML = '<option value="">— select item type —</option>' +
    types.map(t => '<option value="' + t + '">' + prettyType(t) + '</option>').join('');

  // Restore last selection across reloads (handy when re-checking after a refresh).
  const saved = localStorage.getItem('poe2viewer.type');
  if (saved && types.includes(saved)) { typeSel.value = saved; CURRENT_TYPE = saved; }
  renderList();
}

typeSel.addEventListener('change', () => {
  CURRENT_TYPE = typeSel.value;
  CURRENT_KEY = '';
  localStorage.setItem('poe2viewer.type', CURRENT_TYPE);
  detailEl.innerHTML = '<div class="placeholder">Select a mod to see its tiers and value ranges.</div>';
  renderList();
});
searchEl.addEventListener('input', renderList);

function renderList() {
  if (!CURRENT_TYPE) { listEl.innerHTML = '<div class="empty">Pick an item type.</div>'; return; }
  const q = searchEl.value.trim().toLowerCase();
  const pool = STATS
    .filter(s => (s.types || []).includes(CURRENT_TYPE))
    .filter(s => !q || s.display.toLowerCase().includes(q) || (s.family || '').toLowerCase().includes(q));

  const groups = { prefix: [], suffix: [], other: [] };
  for (const s of pool) (groups[s.affix] || groups.other).push(s);
  for (const g of Object.values(groups)) g.sort((a, b) => a.display.localeCompare(b.display));

  if (!pool.length) { listEl.innerHTML = '<div class="empty">No mods match.</div>'; return; }

  const section = (label, cls, arr) => arr.length ? (
    '<div class="group-label ' + cls + '">' + label + ' · ' + arr.length + '</div>' +
    arr.map(s =>
      '<div class="modrow' + (s.key === CURRENT_KEY ? ' active' : '') + '" data-key="' + s.key + '">' +
        '<span class="name">' + esc(s.display) + '</span>' +
        '<span class="badge">' + (s.tiers ? s.tiers.length + 'T' : '') + '</span>' +
      '</div>'
    ).join('')
  ) : '';

  listEl.innerHTML =
    section('Prefixes', 'prefix', groups.prefix) +
    section('Suffixes', 'suffix', groups.suffix) +
    section('Other', '', groups.other);

  listEl.querySelectorAll('.modrow').forEach(row =>
    row.addEventListener('click', () => selectMod(row.dataset.key)));
}

function selectMod(key) {
  CURRENT_KEY = key;
  renderList();
  const s = STATS.find(x => x.key === key);
  if (!s) return;
  const cls = s.affix === 'prefix' ? 'prefix' : s.affix === 'suffix' ? 'suffix' : '';
  const hybrid = s.tiers && s.tiers.some(t => (t.ranges || []).length > 1);

  const rows = (s.tiers || []).map(t => {
    const ranges = (t.ranges || []).map(r =>
      '<span class="range">' + r[0] + ' <span class="sep">–</span> ' + r[1] + '</span>'
    ).join(' &nbsp;/&nbsp; ');
    return '<tr><td class="tier">T' + t.tier + '</td><td>' + (t.ilvl ?? '–') + '</td><td>' + ranges + '</td></tr>';
  }).join('');

  const poe2dbSearch = 'https://poe2db.tw/us/search?q=' + encodeURIComponent(s.display.replace(/#/g, '').trim());
  const tradeId = s.tradeStatId ? '<a class="btn" href="https://www.pathofexile.com/trade2" target="_blank" rel="noopener">Trade2</a>' : '';

  detailEl.innerHTML =
    '<h2>' + esc(s.display) + '</h2>' +
    '<div class="tags">' +
      '<span class="tag ' + cls + '">' + (s.affix || '?') + '</span>' +
      '<span class="tag">' + (s.affixType || '') + '</span>' +
      (s.isAveraged ? '<span class="tag">averaged</span>' : '') +
      (hybrid ? '<span class="tag">hybrid</span>' : '') +
    '</div>' +
    '<div class="kv"><b>Family:</b> ' + esc(s.family || '—') + '</div>' +
    '<div class="kv"><b>Applies to:</b> ' + (s.types || []).map(prettyType).join(', ') + '</div>' +
    '<div class="kv"><b>Trade stat id:</b> <code>' + esc(s.tradeStatId || '—') + '</code></div>' +
    '<div class="kv"><b>Snapshot key:</b> <code>' + esc(s.key) + '</code></div>' +
    '<table><thead><tr><th class="tier">Tier</th><th>iLvl</th><th>Value range</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table>' +
    (hybrid ? '<div class="hybrid-note">Hybrid mod — each tier rolls both ranges independently (e.g. Adds # to # …).</div>' : '') +
    '<div class="actions">' +
      '<a class="btn" href="' + poe2dbSearch + '" target="_blank" rel="noopener">Search on PoE2DB ↗</a>' + tradeId +
    '</div>';
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

load().catch(err => { metaEl.textContent = 'failed to load: ' + err.message; });
</script>
</body>
</html>`;
