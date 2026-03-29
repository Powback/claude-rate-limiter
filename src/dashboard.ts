// Inline HTML dashboard — served at GET /
export const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Claude Rate Limiter</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body { background:#0a0a0f; color:#e0e0e0; font-family:'SF Mono',Consolas,monospace; font-size:13px; padding:16px; }
h1 { font-size:18px; color:#8b5cf6; margin-bottom:4px; }
h2 { font-size:14px; color:#6366f1; margin:16px 0 8px; border-bottom:1px solid #1e1e2e; padding-bottom:4px; }
.subtitle { font-size:11px; color:#666; margin-bottom:12px; }
.grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:10px; margin-bottom:16px; }
.card { background:#12121a; border:1px solid #1e1e2e; border-radius:8px; padding:10px; }
.card .label { color:#888; font-size:10px; text-transform:uppercase; letter-spacing:1px; }
.card .value { font-size:22px; font-weight:700; margin-top:2px; }
.card .sub { font-size:11px; color:#666; margin-top:2px; }
.green { color:#22c55e; } .yellow { color:#eab308; } .red { color:#ef4444; } .purple { color:#8b5cf6; } .blue { color:#3b82f6; } .cyan { color:#06b6d4; }
.bar-bg { background:#1e1e2e; border-radius:4px; height:6px; margin-top:4px; overflow:hidden; }
.bar-fill { height:100%; border-radius:4px; transition:width 0.5s; }
table { width:100%; border-collapse:collapse; font-size:12px; }
th { text-align:left; color:#888; font-size:11px; padding:5px 8px; border-bottom:1px solid #1e1e2e; }
td { padding:5px 8px; border-bottom:1px solid #111; }
tr:hover { background:#15151f; }
.savings { background:linear-gradient(135deg,#12121a,#1a1a2e); border:1px solid #22c55e33; }
.savings .value { color:#22c55e; }
#status-dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:6px; }
.log { max-height:280px; overflow-y:auto; background:#0d0d14; border:1px solid #1e1e2e; border-radius:6px; padding:6px; }
.log-entry { padding:2px 0; border-bottom:1px solid #111; display:grid; gap:4px; align-items:center; font-size:11px; }
.log-entry:last-child { border:none; }
.toggle { cursor:pointer; padding:3px 8px; border-radius:4px; font-size:11px; border:1px solid #333; background:#1a1a2e; color:#e0e0e0; }
.toggle.on { background:#22c55e22; border-color:#22c55e; color:#22c55e; }
.toggle.off { background:#12121a; border-color:#333; color:#888; }
.controls { display:flex; gap:8px; align-items:center; margin-bottom:12px; }
.controls label { font-size:11px; color:#888; }

/* ── Tab Navigation ──────────────────────────────────────────────────────── */
.tab-nav { display:flex; gap:2px; margin-bottom:16px; border-bottom:1px solid #1e1e2e; }
.tab-btn { padding:7px 16px; font-size:12px; font-family:inherit; background:none; border:none; border-bottom:2px solid transparent; color:#666; cursor:pointer; transition:all 0.15s; margin-bottom:-1px; }
.tab-btn:hover { color:#e0e0e0; }
.tab-btn.active { color:#8b5cf6; border-bottom-color:#8b5cf6; }
.tab-panel { display:none; }
.tab-panel.active { display:block; }

/* ── Session List ─────────────────────────────────────────────────────────── */
.sessions-toolbar { display:flex; gap:8px; align-items:center; margin-bottom:10px; flex-wrap:wrap; }
.search-input { background:#12121a; border:1px solid #1e1e2e; border-radius:5px; padding:5px 10px; color:#e0e0e0; font-family:inherit; font-size:12px; width:240px; outline:none; }
.search-input:focus { border-color:#8b5cf6; }
.search-input::placeholder { color:#444; }
.filter-btn { padding:4px 10px; border-radius:5px; font-size:11px; font-family:inherit; border:1px solid #1e1e2e; background:#12121a; color:#888; cursor:pointer; transition:all 0.15s; }
.filter-btn:hover { color:#e0e0e0; border-color:#333; }
.filter-btn.active { background:#8b5cf622; border-color:#8b5cf6; color:#8b5cf6; }
.session-count { font-size:11px; color:#555; margin-left:auto; }
.sessions-table-wrap { overflow-x:auto; }
.sessions-table { width:100%; border-collapse:collapse; font-size:12px; }
.sessions-table th { text-align:left; color:#555; font-size:10px; text-transform:uppercase; letter-spacing:0.8px; padding:6px 10px; border-bottom:1px solid #1e1e2e; white-space:nowrap; cursor:pointer; user-select:none; }
.sessions-table th:hover { color:#888; }
.sessions-table th .sort-arrow { opacity:0.4; margin-left:3px; }
.sessions-table th.sorted .sort-arrow { opacity:1; color:#8b5cf6; }
.sessions-table td { padding:7px 10px; border-bottom:1px solid #0f0f18; vertical-align:middle; }
.sessions-table tr { cursor:pointer; transition:background 0.1s; }
.sessions-table tr:hover td { background:#14141f; }
.sessions-table tr.selected td { background:#1a1a2e; border-bottom-color:#8b5cf633; }
.sessions-table tr.selected td:first-child { border-left:2px solid #8b5cf6; }
.session-id { font-family:'SF Mono',monospace; font-size:11px; color:#6366f1; }
.session-task { color:#e0e0e0; max-width:260px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.status-badge { display:inline-flex; align-items:center; gap:4px; padding:2px 7px; border-radius:10px; font-size:10px; font-weight:600; text-transform:uppercase; letter-spacing:0.5px; white-space:nowrap; }
.status-badge::before { content:''; width:5px; height:5px; border-radius:50%; display:inline-block; }
.badge-active { background:#22c55e18; color:#22c55e; border:1px solid #22c55e33; }
.badge-active::before { background:#22c55e; box-shadow:0 0 4px #22c55e; animation:pulse 1.5s infinite; }
.badge-working { background:#8b5cf618; color:#8b5cf6; border:1px solid #8b5cf633; }
.badge-working::before { background:#8b5cf6; box-shadow:0 0 4px #8b5cf6; animation:pulse 1.5s infinite; }
.badge-idle { background:#3b82f618; color:#3b82f6; border:1px solid #3b82f633; }
.badge-idle::before { background:#3b82f6; }
.badge-completed { background:#22c55e10; color:#4ade80; border:1px solid #22c55e22; }
.badge-completed::before { background:#4ade80; }
.badge-error { background:#ef444418; color:#ef4444; border:1px solid #ef444433; }
.badge-error::before { background:#ef4444; }
.badge-blocked { background:#eab30818; color:#eab308; border:1px solid #eab30833; }
.badge-blocked::before { background:#eab308; }
.badge-interrupted { background:#88888818; color:#888; border:1px solid #88888833; }
.badge-interrupted::before { background:#888; }
.badge-unknown { background:#33333318; color:#666; border:1px solid #33333333; }
.badge-unknown::before { background:#666; }
@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
.token-cell { font-size:11px; color:#888; white-space:nowrap; }
.token-cell .in { color:#3b82f6; }
.token-cell .out { color:#8b5cf6; }
.token-cell .cache { color:#06b6d4; }
.time-cell { font-size:11px; color:#555; white-space:nowrap; }
.sessions-empty { padding:32px; text-align:center; color:#333; font-size:13px; }
.sessions-empty .empty-icon { font-size:32px; margin-bottom:8px; opacity:0.4; }
.sessions-loading { padding:24px; text-align:center; color:#444; font-size:12px; }

/* ── Session Detail Panel ─────────────────────────────────────────────────── */
.sessions-layout { display:grid; grid-template-columns:1fr; gap:16px; transition:grid-template-columns 0.2s; }
.sessions-layout.panel-open { grid-template-columns:1fr 420px; }
.session-panel { display:none; background:#0d0d14; border:1px solid #1e1e2e; border-radius:8px; overflow:hidden; flex-direction:column; height:600px; }
.sessions-layout.panel-open .session-panel { display:flex; }
.panel-header { display:flex; align-items:flex-start; gap:8px; padding:12px 14px; border-bottom:1px solid #1e1e2e; background:#12121a; flex-shrink:0; }
.panel-header-info { flex:1; min-width:0; }
.panel-session-id { font-size:10px; color:#6366f1; font-family:monospace; margin-bottom:3px; }
.panel-task { font-size:13px; color:#e0e0e0; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.panel-meta { font-size:10px; color:#555; margin-top:3px; display:flex; gap:8px; flex-wrap:wrap; }
.panel-close { background:none; border:none; color:#555; cursor:pointer; font-size:16px; padding:2px 4px; border-radius:4px; flex-shrink:0; transition:color 0.1s; }
.panel-close:hover { color:#e0e0e0; background:#1e1e2e; }
.panel-stats { display:grid; grid-template-columns:repeat(3,1fr); gap:1px; background:#1e1e2e; border-bottom:1px solid #1e1e2e; flex-shrink:0; }
.panel-stat { background:#12121a; padding:7px 10px; text-align:center; }
.panel-stat .ps-label { font-size:9px; color:#555; text-transform:uppercase; letter-spacing:0.8px; }
.panel-stat .ps-value { font-size:14px; font-weight:700; margin-top:2px; }
.messages-container { flex:1; overflow-y:auto; padding:10px; display:flex; flex-direction:column; gap:8px; }
.message-bubble { border-radius:7px; padding:8px 10px; font-size:12px; line-height:1.5; max-width:100%; word-break:break-word; }
.msg-user { background:#1a1a2e; border:1px solid #2a2a4e; border-left:3px solid #6366f1; }
.msg-assistant { background:#0f1a0f; border:1px solid #1a2e1a; border-left:3px solid #22c55e; }
.msg-system { background:#1a1206; border:1px solid #2e2206; border-left:3px solid #eab308; font-size:11px; color:#888; }
.msg-tool { background:#0d0d1a; border:1px solid #1a1a2e; border-left:3px solid #06b6d4; font-size:11px; }
.msg-role { font-size:9px; text-transform:uppercase; letter-spacing:1px; font-weight:700; margin-bottom:4px; }
.role-user { color:#6366f1; }
.role-assistant { color:#22c55e; }
.role-system { color:#eab308; }
.role-tool { color:#06b6d4; }
.msg-meta { font-size:10px; color:#444; margin-top:4px; display:flex; justify-content:space-between; flex-wrap:wrap; gap:4px; }
.msg-content { white-space:pre-wrap; }
.msg-content-truncated { display:-webkit-box; -webkit-line-clamp:6; -webkit-box-orient:vertical; overflow:hidden; }
.msg-expand { background:none; border:none; color:#555; cursor:pointer; font-size:10px; margin-top:4px; font-family:inherit; padding:0; }
.msg-expand:hover { color:#888; }
.tool-block { background:#0a0a14; border:1px solid #1a1a2e; border-radius:5px; padding:5px 8px; margin-top:4px; font-size:11px; }
.tool-name { color:#06b6d4; font-weight:600; }
.tool-result { color:#888; }
.panel-search { display:flex; align-items:center; gap:6px; padding:7px 12px; border-bottom:1px solid #111; background:#0d0d14; flex-shrink:0; }
.panel-search-input { background:none; border:none; outline:none; color:#e0e0e0; font-family:inherit; font-size:11px; flex:1; }
.panel-search-input::placeholder { color:#333; }
.panel-empty { flex:1; display:flex; align-items:center; justify-content:center; color:#333; font-size:12px; flex-direction:column; gap:6px; }
.panel-loading { flex:1; display:flex; align-items:center; justify-content:center; color:#444; font-size:12px; }
.nav-jump { display:flex; gap:4px; padding:7px 12px; border-top:1px solid #111; background:#0d0d14; flex-shrink:0; }
.nav-btn { flex:1; padding:4px; background:#12121a; border:1px solid #1e1e2e; border-radius:4px; color:#666; cursor:pointer; font-family:inherit; font-size:11px; transition:all 0.1s; text-align:center; }
.nav-btn:hover { color:#e0e0e0; border-color:#333; }
.msg-highlight { background:#8b5cf622; outline:2px solid #8b5cf644; }
</style>
</head>
<body>
<h1><span id="status-dot"></span>Claude Rate Limiter</h1>
<div class="subtitle">Reverse proxy for Anthropic API — rate limit queuing + token tracking</div>

<!-- Tab Navigation -->
<div class="tab-nav">
  <button class="tab-btn active" onclick="switchTab('overview')">Overview</button>
  <button class="tab-btn" onclick="switchTab('sessions')" id="tab-sessions-btn">Sessions <span id="sessions-badge" style="display:none;font-size:10px;color:#8b5cf6;margin-left:4px"></span></button>
</div>

<!-- ── Tab: Overview ──────────────────────────────────────────────────────── -->
<div id="tab-overview" class="tab-panel active">

<div class="controls">
  <label>Strip bloat:</label>
  <button class="toggle" id="btn-strip" onclick="toggleStrip()">—</button>
  <label style="margin-left:12px">Threshold:</label>
  <span id="v-threshold" style="color:#8b5cf6">85%</span>
</div>

<div class="grid">
  <div class="card">
    <div class="label">Status</div>
    <div class="value" id="v-status">—</div>
    <div class="sub" id="v-queue">Queue: 0</div>
  </div>
  <div class="card">
    <div class="label">5h Utilization</div>
    <div class="value" id="v-5h">—</div>
    <div class="bar-bg"><div class="bar-fill" id="bar-5h" style="width:0;background:#22c55e"></div></div>
    <div class="sub" id="v-5h-reset">—</div>
  </div>
  <div class="card">
    <div class="label">7d Utilization</div>
    <div class="value" id="v-7d">—</div>
    <div class="bar-bg"><div class="bar-fill" id="bar-7d" style="width:0;background:#3b82f6"></div></div>
    <div class="sub" id="v-7d-reset">—</div>
  </div>
  <div class="card">
    <div class="label">Cache Hit Rate</div>
    <div class="value cyan" id="v-cache-rate">—</div>
    <div class="bar-bg"><div class="bar-fill" id="bar-cache" style="width:0;background:#06b6d4"></div></div>
    <div class="sub" id="v-cache-detail">—</div>
  </div>
  <div class="card">
    <div class="label">Forwarded</div>
    <div class="value blue" id="v-forwarded">0</div>
    <div class="sub" id="v-429s">0 upstream 429s</div>
  </div>
  <div class="card savings">
    <div class="label">Tokens Saved</div>
    <div class="value" id="v-saved">—</div>
    <div class="sub" id="v-stripped">—</div>
  </div>
  <div class="card">
    <div class="label">Queued / Rejected</div>
    <div class="value" id="v-queued">0 / 0</div>
    <div class="sub" id="v-cost">$0.00</div>
  </div>
</div>

<h2>Request Log</h2>
<div class="log" id="request-log">
  <div class="log-entry" style="font-weight:600;color:#888;grid-template-columns:65px 150px 50px 65px 65px 65px 70px 70px 60px">
    <span>Time</span><span>Model</span><span>Code</span><span>Latency</span><span>Input</span><span>Output</span><span>Cache R</span><span>Cache C</span><span>Saved</span>
  </div>
</div>

<h2>By Model</h2>
<table id="model-table">
  <thead><tr><th>Model</th><th>Reqs</th><th>Input</th><th>Output</th><th>Cache Read</th><th>Cache Create</th><th>Hit Rate</th><th>Avg Latency</th><th>Est. Cost</th></tr></thead>
  <tbody id="model-body"></tbody>
</table>

<h2>Rate Limit Events</h2>
<div class="log" id="events-log">
  <div class="log-entry" style="font-weight:600;color:#888;grid-template-columns:65px 100px 120px 55px 55px 1fr">
    <span>Time</span><span>Type</span><span>Model</span><span>5h</span><span>Queue</span><span>Reason</span>
  </div>
</div>

</div><!-- end tab-overview -->

<!-- ── Tab: Sessions ──────────────────────────────────────────────────────── -->
<div id="tab-sessions" class="tab-panel">

  <div class="sessions-toolbar">
    <input class="search-input" id="session-search" placeholder="Search sessions, tasks, models…" oninput="filterSessions()" />
    <button class="filter-btn active" id="filter-all" onclick="setFilter('all')">All</button>
    <button class="filter-btn" id="filter-active" onclick="setFilter('active')">Active</button>
    <button class="filter-btn" id="filter-idle" onclick="setFilter('idle')">Idle</button>
    <button class="filter-btn" id="filter-completed" onclick="setFilter('completed')">Done</button>
    <button class="filter-btn" id="filter-error" onclick="setFilter('error')">Error</button>
    <span class="session-count" id="session-count"></span>
  </div>

  <div class="sessions-layout" id="sessions-layout">
    <div>
      <div class="sessions-table-wrap">
        <table class="sessions-table" id="sessions-table">
          <thead>
            <tr>
              <th onclick="sortBy('id')">ID <span class="sort-arrow">↕</span></th>
              <th onclick="sortBy('task')">Task / Description <span class="sort-arrow">↕</span></th>
              <th onclick="sortBy('status')">Status <span class="sort-arrow">↕</span></th>
              <th onclick="sortBy('model')">Model <span class="sort-arrow">↕</span></th>
              <th onclick="sortBy('messageCount')">Msgs <span class="sort-arrow">↕</span></th>
              <th onclick="sortBy('inputTokens')">Tokens <span class="sort-arrow">↕</span></th>
              <th onclick="sortBy('lastActivity')">Last Active <span class="sort-arrow">↕</span></th>
            </tr>
          </thead>
          <tbody id="sessions-body">
            <tr><td colspan="7"><div class="sessions-loading">Loading sessions…</div></td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Session Detail Panel -->
    <div class="session-panel" id="session-panel">
      <div class="panel-header">
        <div class="panel-header-info">
          <div class="panel-session-id" id="panel-sid"></div>
          <div class="panel-task" id="panel-task"></div>
          <div class="panel-meta" id="panel-meta"></div>
        </div>
        <button class="panel-close" onclick="closePanel()" title="Close">✕</button>
      </div>
      <div class="panel-stats" id="panel-stats"></div>
      <div class="panel-search">
        <span style="color:#444;font-size:12px">⌕</span>
        <input class="panel-search-input" id="panel-search" placeholder="Search messages…" oninput="filterMessages()" />
      </div>
      <div class="messages-container" id="messages-container">
        <div class="panel-loading">Select a session to view conversation</div>
      </div>
      <div class="nav-jump" id="nav-jump" style="display:none">
        <button class="nav-btn" onclick="jumpTo('first')">⬆ First</button>
        <button class="nav-btn" onclick="jumpTo('prev')">↑ Prev</button>
        <span style="font-size:10px;color:#444;align-self:center;flex:none;padding:0 4px" id="nav-pos"></span>
        <button class="nav-btn" onclick="jumpTo('next')">↓ Next</button>
        <button class="nav-btn" onclick="jumpTo('last')">⬇ Last</button>
      </div>
    </div>
  </div>

</div><!-- end tab-sessions -->

<script>
const $ = id => document.getElementById(id);
function utilColor(v) { return v >= 0.85 ? '#ef4444' : v >= 0.6 ? '#eab308' : '#22c55e'; }
function fmt(n) { if (n == null) return '—'; return n >= 1000000 ? (n/1000000).toFixed(1)+'M' : n >= 1000 ? (n/1000).toFixed(1)+'K' : String(n); }
function timeAgo(iso) {
  if (!iso) return '—';
  const ms = new Date(iso).getTime() - Date.now();
  if (ms < 0) return 'now';
  const s = Math.ceil(ms/1000);
  return s > 3600 ? Math.floor(s/3600)+'h '+Math.floor((s%3600)/60)+'m' : s > 60 ? Math.floor(s/60)+'m '+s%60+'s' : s+'s';
}
function relTime(v) {
  if (!v) return '—';
  // accept epoch ms (number), ISO string, or Date
  const ts = typeof v === 'number' ? v : new Date(v).getTime();
  const ms = Date.now() - ts;
  if (ms < 0) return 'just now';
  const s = Math.floor(ms/1000);
  if (s < 5) return 'just now';
  if (s < 60) return s+'s ago';
  if (s < 3600) return Math.floor(s/60)+'m ago';
  if (s < 86400) return Math.floor(s/3600)+'h ago';
  return Math.floor(s/86400)+'d ago';
}

// Derive session status from lastActivity or lastSeen timestamp (epoch ms or ISO string)
function deriveStatus(s) {
  const lastTs = s.lastActivity || (s.lastSeen ? new Date(s.lastSeen).getTime() : 0);
  const idle = Date.now() - lastTs;
  if (idle < 60_000) return 'active';
  if (idle < 30 * 60_000) return 'idle';
  return 'completed';
}
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Tab switching ─────────────────────────────────────────────────────────
let activeTab = 'overview';
function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  $('tab-'+tab).classList.add('active');
  event.target.classList.add('active');
  if (tab === 'sessions') pollSessions();
}

// ── Overview polling ──────────────────────────────────────────────────────
async function toggleStrip() {
  await fetch('/config', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({strip: 'toggle'}) });
  poll();
}

async function poll() {
  try {
    const [health, stats, reqs, events] = await Promise.all([
      fetch('/health').then(r=>r.json()),
      fetch('/stats').then(r=>r.json()),
      fetch('/requests').then(r=>r.json()),
      fetch('/events').then(r=>r.json()),
    ]);

    const h = health;
    const dot = $('status-dot');
    dot.style.background = h.status === 'allowed' ? '#22c55e' : h.status === 'rejected' ? '#ef4444' : '#888';
    $('v-status').textContent = h.status || 'unknown';
    $('v-status').className = 'value ' + (h.status === 'allowed' ? 'green' : h.status === 'rejected' ? 'red' : '');
    $('v-queue').textContent = 'Queue: ' + h.queue + (h.shouldQueue ? ' (queueing)' : '');

    const btn = $('btn-strip');
    btn.textContent = h.stripEnabled ? 'ON' : 'OFF';
    btn.className = 'toggle ' + (h.stripEnabled ? 'on' : 'off');

    const u5 = h.rateLimit.fiveHour.utilization;
    const u7 = h.rateLimit.sevenDay.utilization;
    $('v-5h').textContent = (u5*100).toFixed(0) + '%';
    $('v-5h').style.color = utilColor(u5);
    $('bar-5h').style.width = (u5*100)+'%';
    $('bar-5h').style.background = utilColor(u5);
    $('v-5h-reset').textContent = 'Resets in ' + timeAgo(h.rateLimit.fiveHour.resetsAt);
    $('v-7d').textContent = (u7*100).toFixed(0) + '%';
    $('v-7d').style.color = utilColor(u7);
    $('bar-7d').style.width = (u7*100)+'%';
    $('bar-7d').style.background = utilColor(u7);
    $('v-7d-reset').textContent = 'Resets in ' + timeAgo(h.rateLimit.sevenDay.resetsAt);

    const t = stats.totals;
    const cacheTotal = (t.cacheRead || 0) + (t.cacheCreation || 0);
    const hitRate = cacheTotal > 0 ? (t.cacheRead || 0) / cacheTotal : 0;
    $('v-cache-rate').textContent = cacheTotal > 0 ? (hitRate * 100).toFixed(0) + '%' : '—';
    $('bar-cache').style.width = (hitRate * 100) + '%';
    $('v-cache-detail').textContent = 'Read: ' + fmt(t.cacheRead) + ' | Create: ' + fmt(t.cacheCreation);

    $('v-forwarded').textContent = h.stats.forwarded;
    $('v-429s').textContent = h.stats.upstream429s + ' upstream 429s';
    $('v-queued').textContent = h.stats.queued + ' / ' + h.stats.rejected;
    $('v-threshold').textContent = (h.threshold*100).toFixed(0) + '%';
    $('v-saved').textContent = h.stats.tokensSaved > 0 ? '~' + fmt(h.stats.tokensSaved) : '—';
    $('v-stripped').textContent = h.stats.requestsStripped > 0 ? h.stats.requestsStripped + ' stripped' : 'stripping off';
    $('v-cost').textContent = stats.estimatedCostUsd > 0 ? '$' + stats.estimatedCostUsd.toFixed(4) : '$0.00';

    const log = $('request-log');
    const header = log.children[0];
    log.innerHTML = '';
    log.appendChild(header);
    for (const r of reqs.slice(0, 50)) {
      if (!r.path || r.path === '/') continue;
      const row = document.createElement('div');
      row.className = 'log-entry';
      row.style.gridTemplateColumns = '65px 150px 50px 65px 65px 65px 70px 70px 60px';
      const time = new Date(r.timestamp).toLocaleTimeString().slice(0,-3);
      const model = (r.model || '?').replace('claude-','').replace('-20251001','').replace('-20250514','');
      const status = r.statusCode === 200 ? '<span class="green">200</span>' : r.statusCode === 429 ? '<span class="red">429</span>' : r.statusCode || '?';
      const latency = r.latencyMs ? (r.latencyMs/1000).toFixed(1)+'s' : '—';
      const cr = r.cacheRead ? '<span class="cyan">'+fmt(r.cacheRead)+'</span>' : '—';
      const cc = r.cacheCreation ? '<span class="yellow">'+fmt(r.cacheCreation)+'</span>' : '—';
      const saved = r.tokensSaved > 0 ? '<span class="green">-'+fmt(r.tokensSaved)+'</span>' : '—';
      row.innerHTML = '<span>'+time+'</span><span>'+model+'</span><span>'+status+'</span><span>'+latency+'</span><span>'+fmt(r.inputTokens||0)+'</span><span>'+fmt(r.outputTokens||0)+'</span><span>'+cr+'</span><span>'+cc+'</span><span>'+saved+'</span>';
      log.appendChild(row);
    }

    const tbody = $('model-body');
    tbody.innerHTML = '';
    for (const [model, s] of Object.entries(stats.byModel || {})) {
      const tr = document.createElement('tr');
      const name = model.replace('claude-','').replace('-20251001','').replace('-20250514','');
      const cTotal = (s.cacheRead || 0) + (s.cacheCreation || 0);
      const hr = cTotal > 0 ? ((s.cacheRead || 0) / cTotal * 100).toFixed(0) + '%' : '—';
      const hrColor = cTotal > 0 ? ((s.cacheRead||0)/cTotal >= 0.8 ? 'cyan' : (s.cacheRead||0)/cTotal >= 0.5 ? 'yellow' : 'red') : '';
      tr.innerHTML = '<td>'+name+'</td><td>'+s.count+'</td><td>'+fmt(s.inputTokens)+'</td><td>'+fmt(s.outputTokens)+'</td><td class="cyan">'+fmt(s.cacheRead)+'</td><td class="yellow">'+fmt(s.cacheCreation)+'</td><td class="'+hrColor+'">'+hr+'</td><td>'+s.avgLatencyMs+'ms</td><td>—</td>';
      tbody.appendChild(tr);
    }
    if (stats.estimatedCostUsd > 0) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td colspan="8" style="text-align:right;color:#888">Estimated cost</td><td class="green">$'+stats.estimatedCostUsd.toFixed(4)+'</td>';
      tbody.appendChild(tr);
    }

    const elog = $('events-log');
    const eheader = elog.children[0];
    elog.innerHTML = '';
    elog.appendChild(eheader);
    if (events.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'padding:12px;color:#444;text-align:center';
      empty.textContent = 'No rate limit events yet';
      elog.appendChild(empty);
    }
    for (const e of events.slice(0, 50)) {
      const row = document.createElement('div');
      row.className = 'log-entry';
      row.style.gridTemplateColumns = '65px 100px 120px 55px 55px 1fr';
      const time = new Date(e.timestamp).toLocaleTimeString().slice(0,-3);
      const typeColor = e.type === '429' ? 'red' : e.type === 'rejected' ? 'red' : e.type === 'threshold_crossed' ? 'yellow' : 'purple';
      const model = (e.model || '—').replace('claude-','').replace('-20251001','');
      row.innerHTML = '<span>'+time+'</span><span class="'+typeColor+'">'+e.type+'</span><span>'+model+'</span><span>'+(e.utilization5h*100).toFixed(0)+'%</span><span>'+e.queueDepth+'</span><span style="color:#888">'+e.triggerReason+'</span>';
      elog.appendChild(row);
    }
  } catch(e) { console.error('Poll error:', e); }
}

// ── Sessions state ────────────────────────────────────────────────────────
let allSessions = [];
let filteredSessions = [];
let sessionFilter = 'all';
let sessionSort = { key: 'lastActivity', dir: -1 };
let selectedSessionId = null;
let sessionMessages = [];
let sessionPollTimer = null;
let msgSearchTerm = '';
let matchedMsgIndices = [];
let matchNavPos = 0;

function statusBadge(status) {
  const s = (status || 'unknown').toLowerCase();
  const cls = 'badge-' + (['active','working','idle','completed','error','blocked','interrupted'].includes(s) ? s : 'unknown');
  return '<span class="status-badge '+cls+'">'+esc(s)+'</span>';
}

function shortModel(m) {
  return (m || '?').replace('claude-','').replace(/-2025\\d{4}$/,'').replace(/-\\d{8}$/,'');
}

function renderSessionRow(s) {
  const tr = document.createElement('tr');
  tr.dataset.id = s.id;
  if (s.id === selectedSessionId) tr.classList.add('selected');
  const shortId = s.id ? s.id.slice(0, 12) + (s.id.length > 12 ? '…' : '') : '—';
  // Support both old (startTime) and new (firstSeen) field names
  const startRef = s.startTime || s.firstSeen;
  const startLabel = startRef ? new Date(startRef).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '';
  const task = esc(s.task || s.title || s.description || s.taskDescription || (startLabel ? 'Session ' + startLabel : '(session)'));
  const inTok = s.totalInputTokens ?? s.inputTokens ?? 0;
  const outTok = s.totalOutputTokens ?? s.outputTokens ?? 0;
  const cacheR = s.totalCacheRead ?? s.cacheRead ?? 0;
  const tokenHtml = '<span class="in">'+fmt(inTok)+'</span><span style="color:#333"> / </span><span class="out">'+fmt(outTok)+'</span>'+(cacheR?'<br><span class="cache">⚡'+fmt(cacheR)+'</span>':'');
  const status = s.status || deriveStatus(s);
  const msgCount = s.requestCount ?? s.conversationCount ?? s.messageCount ?? 0;
  tr.innerHTML =
    '<td><span class="session-id" title="'+esc(s.id || '')+'">'+shortId+'</span></td>'+
    '<td><div class="session-task" title="'+task+'">'+task+'</div></td>'+
    '<td>'+statusBadge(status)+'</td>'+
    '<td style="color:#888;font-size:11px">'+esc(shortModel(s.model))+'</td>'+
    '<td style="text-align:right;color:#888;font-size:12px">'+msgCount+'</td>'+
    '<td class="token-cell">'+tokenHtml+'</td>'+
    '<td class="time-cell">'+relTime(s.lastActivity ?? s.updatedAt ?? s.startedAt ?? s.lastSeen)+'</td>';
  tr.onclick = () => openSession(s.id);
  return tr;
}

function applySort(arr) {
  return [...arr].sort((a, b) => {
    let av = a[sessionSort.key], bv = b[sessionSort.key];
    if (typeof av === 'string') av = av.toLowerCase(), bv = (bv || '').toLowerCase();
    if (av == null) av = -Infinity;
    if (bv == null) bv = -Infinity;
    return sessionSort.dir * (av < bv ? -1 : av > bv ? 1 : 0);
  });
}

function sortBy(key) {
  if (sessionSort.key === key) sessionSort.dir *= -1;
  else { sessionSort.key = key; sessionSort.dir = -1; }
  document.querySelectorAll('.sessions-table th').forEach(th => th.classList.remove('sorted'));
  event.target.closest('th').classList.add('sorted');
  renderSessionList();
}

function setFilter(f) {
  sessionFilter = f;
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  $('filter-'+f).classList.add('active');
  filterSessions();
}

function filterSessions() {
  const q = ($('session-search').value || '').toLowerCase();
  filteredSessions = allSessions.filter(s => {
    const status = (s.status || deriveStatus(s)).toLowerCase();
    const matchStatus = sessionFilter === 'all' || status.startsWith(sessionFilter);
    const matchSearch = !q ||
      (s.id || '').toLowerCase().includes(q) ||
      (s.task || s.title || s.description || s.taskDescription || '').toLowerCase().includes(q) ||
      (s.model || '').toLowerCase().includes(q);
    return matchStatus && matchSearch;
  });
  renderSessionList();
}

function renderSessionList() {
  const sorted = applySort(filteredSessions);
  const tbody = $('sessions-body');
  tbody.innerHTML = '';
  if (sorted.length === 0) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td colspan="7"><div class="sessions-empty"><div class="empty-icon">🗂️</div>No sessions found</div></td>';
    tbody.appendChild(tr);
  } else {
    for (const s of sorted) tbody.appendChild(renderSessionRow(s));
  }
  $('session-count').textContent = sorted.length + ' of ' + allSessions.length + ' sessions';
  // Update badge
  const activeCnt = allSessions.filter(s => ['active','working'].includes((s.status||deriveStatus(s)).toLowerCase())).length;
  const badge = $('sessions-badge');
  if (activeCnt > 0) { badge.textContent = activeCnt; badge.style.display = ''; }
  else badge.style.display = 'none';
}

async function pollSessions() {
  if (activeTab !== 'sessions') return;
  try {
    const resp = await fetch('/sessions');
    if (!resp.ok) {
      if (resp.status === 404) {
        $('sessions-body').innerHTML = '<tr><td colspan="7"><div class="sessions-empty"><div class="empty-icon">🔌</div>Session API not yet available<br><span style="font-size:11px;color:#444">Waiting for /sessions endpoint…</span></div></td></tr>';
        return;
      }
      throw new Error('HTTP ' + resp.status);
    }
    const data = await resp.json();
    // API returns { sessions: [...], total, offset, limit } or plain array
    allSessions = Array.isArray(data) ? data : (data.sessions || []);
    filterSessions();
    // Refresh open panel
    if (selectedSessionId) refreshPanel(selectedSessionId);
  } catch(e) {
    console.warn('Sessions poll error:', e);
  }
  sessionPollTimer = setTimeout(pollSessions, 3000);
}

// ── Session Detail Panel ──────────────────────────────────────────────────
async function openSession(id) {
  selectedSessionId = id;
  // Update row highlight
  document.querySelectorAll('.sessions-table tr').forEach(tr => {
    tr.classList.toggle('selected', tr.dataset.id === id);
  });
  $('sessions-layout').classList.add('panel-open');
  $('session-panel').style.display = 'flex';
  $('messages-container').innerHTML = '<div class="panel-loading">Loading conversation…</div>';
  $('nav-jump').style.display = 'none';
  $('panel-search').value = '';
  msgSearchTerm = '';
  await refreshPanel(id);
}

async function refreshPanel(id) {
  if (selectedSessionId !== id) return;
  try {
    const resp = await fetch('/sessions/' + encodeURIComponent(id));
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const session = await resp.json();
    renderPanel(session);
  } catch(e) {
    $('messages-container').innerHTML = '<div class="panel-empty"><span style="font-size:24px;opacity:0.3">💬</span><span>Could not load conversation</span></div>';
  }
}

function renderPanel(session) {
  // Header — support both old (startTime) and new (firstSeen) field names
  $('panel-sid').textContent = session.id || '';
  const startRef = session.startTime || session.firstSeen;
  const startLabel = startRef ? new Date(startRef).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '';
  $('panel-task').textContent = session.task || session.title || session.description || session.taskDescription || (startLabel ? 'Session ' + startLabel : '(session)');
  const status = session.status || deriveStatus(session);
  const metaParts = [];
  if (session.model) metaParts.push('<span style="color:#8b5cf6">'+esc(shortModel(session.model))+'</span>');
  if (startRef) metaParts.push('Started '+relTime(startRef));
  metaParts.push(statusBadge(status));
  $('panel-meta').innerHTML = metaParts.join('<span style="color:#333"> · </span>');

  // Stats bar — support both old (conversations) and new (requests) array field names
  const convs = session.conversations || session.messages || session.requests || [];
  const totalIn  = session.totalInputTokens  ?? session.inputTokens  ?? convs.reduce((a,c) => a+(c.inputTokens||0), 0);
  const totalOut = session.totalOutputTokens ?? session.outputTokens ?? convs.reduce((a,c) => a+(c.outputTokens||0), 0);
  const reqCount = session.requestCount ?? session.conversationCount ?? convs.length;
  const avgLat   = session.avgLatencyMs ? session.avgLatencyMs+'ms' : '—';
  $('panel-stats').innerHTML =
    '<div class="panel-stat"><div class="ps-label">Requests</div><div class="ps-value" style="color:#e0e0e0">'+reqCount+'</div></div>'+
    '<div class="panel-stat"><div class="ps-label">Input tok</div><div class="ps-value blue">'+fmt(totalIn)+'</div></div>'+
    '<div class="panel-stat"><div class="ps-label">Avg latency</div><div class="ps-value purple">'+avgLat+'</div></div>';

  // Convert conversations → synthetic message pairs for the thread view
  sessionMessages = conversationsToMessages(convs);
  renderMessages();
}

// Each ConversationEntry becomes two synthetic messages (user turn + assistant turn).
// For new RequestLog entries (cch-based sessions), show request metadata as a single bubble.
function conversationsToMessages(convs) {
  const msgs = [];
  for (const c of convs) {
    // New RequestLog format — no lastUserMessage, but has inputTokens/statusCode
    if (!c.lastUserMessage && !c.lastAssistantResponse) {
      const model = shortModel(c.model || '');
      const parts = [];
      if (model && model !== '?') parts.push('Model: ' + model);
      if (c.statusCode) parts.push('Status: ' + c.statusCode);
      if (c.inputTokens) parts.push('In: ' + fmt(c.inputTokens));
      if (c.outputTokens) parts.push('Out: ' + fmt(c.outputTokens));
      if (c.cacheRead) parts.push('Cache: ' + fmt(c.cacheRead));
      if (c.latencyMs) parts.push('Latency: ' + (c.latencyMs/1000).toFixed(1) + 's');
      if (c.messageCount) parts.push('Messages: ' + c.messageCount);
      if (parts.length > 0) {
        msgs.push({
          role: 'assistant', content: parts.join(' · '),
          timestamp: c.timestamp, inputTokens: c.inputTokens,
          outputTokens: c.outputTokens, latencyMs: c.latencyMs,
        });
      }
      continue;
    }
    // Old ConversationEntry format
    if (c.lastUserMessage) {
      msgs.push({
        role: 'user', content: c.lastUserMessage,
        timestamp: c.timestamp, inputTokens: c.inputTokens,
        _preview: true, _convId: c.id,
      });
    }
    if (c.lastAssistantResponse) {
      msgs.push({
        role: 'assistant', content: c.lastAssistantResponse,
        timestamp: c.timestamp, outputTokens: c.outputTokens,
        latencyMs: c.latencyMs, _preview: true, _convId: c.id,
        _msgCount: c.messageCount,
      });
    }
  }
  return msgs;
}

function renderMessages() {
  const container = $('messages-container');
  container.innerHTML = '';
  const query = msgSearchTerm.toLowerCase();
  matchedMsgIndices = [];

  if (sessionMessages.length === 0) {
    container.innerHTML = '<div class="panel-empty"><span style="font-size:24px;opacity:0.3">💬</span><span>No messages</span></div>';
    return;
  }

  sessionMessages.forEach((msg, idx) => {
    const role = (msg.role || 'user').toLowerCase();
    const content = extractContent(msg);
    const isMatch = query && content.toLowerCase().includes(query);
    if (isMatch) matchedMsgIndices.push(idx);

    const div = document.createElement('div');
    div.id = 'msg-'+idx;
    div.className = 'message-bubble msg-'+role + (isMatch ? ' msg-highlight' : '');
    const roleCls = 'role-'+role;
    const metaItems = [];
    if (msg.timestamp) metaItems.push(relTime(msg.timestamp));
    if (msg.inputTokens || msg.tokens) metaItems.push('<span class="in">'+fmt(msg.inputTokens||msg.tokens)+'</span> in');
    if (msg.outputTokens) metaItems.push('<span class="out">'+fmt(msg.outputTokens)+'</span> out');

    // Tool use blocks
    const toolBlocks = extractToolBlocks(msg);
    const toolHtml = toolBlocks.map(t =>
      '<div class="tool-block"><span class="tool-name">'+esc(t.name)+'</span>'+
      (t.input ? '<span style="color:#555"> '+esc(JSON.stringify(t.input).slice(0,80))+'</span>' : '')+
      (t.result ? '<div class="tool-result">→ '+esc(String(t.result).slice(0,120))+'</div>' : '')+
      '</div>'
    ).join('');

    const isTruncatable = content.length > 400;
    const displayContent = isTruncatable ? content.slice(0,400)+'…' : content;

    div.innerHTML =
      '<div class="msg-role '+roleCls+'">'+esc(role)+'</div>'+
      '<div class="msg-content'+(isTruncatable?' msg-content-truncated':'')+'" id="mc-'+idx+'">'+esc(displayContent)+'</div>'+
      (isTruncatable ? '<button class="msg-expand" onclick="expandMsg('+idx+', this)">Show more ('+content.length+' chars)</button>' : '')+
      toolHtml+
      (metaItems.length ? '<div class="msg-meta">'+metaItems.join(' · ')+'</div>' : '');

    container.appendChild(div);
  });

  // Show/hide nav
  if (matchedMsgIndices.length > 0) {
    matchNavPos = 0;
    $('nav-jump').style.display = 'flex';
    updateNavPos();
    scrollToMatch(0);
  } else {
    $('nav-jump').style.display = query ? 'flex' : 'none';
    $('nav-pos').textContent = query ? 'No matches' : '';
  }
}

function extractContent(msg) {
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter(b => b.type === 'text')
      .map(b => b.text || '')
      .join('\\n');
  }
  return JSON.stringify(msg.content || '');
}

function extractToolBlocks(msg) {
  if (!Array.isArray(msg.content)) return [];
  return msg.content
    .filter(b => b.type === 'tool_use' || b.type === 'tool_result')
    .map(b => ({
      name: b.name || b.tool_use_id || b.type,
      input: b.input,
      result: b.type === 'tool_result' ? (typeof b.content === 'string' ? b.content : JSON.stringify(b.content)) : null,
    }));
}

function expandMsg(idx, btn) {
  const mc = $('mc-'+idx);
  const msg = sessionMessages[idx];
  const full = extractContent(msg);
  mc.classList.remove('msg-content-truncated');
  mc.textContent = full;
  btn.remove();
}

function filterMessages() {
  msgSearchTerm = $('panel-search').value || '';
  renderMessages();
}

function updateNavPos() {
  $('nav-pos').textContent = matchedMsgIndices.length > 0
    ? (matchNavPos+1)+'/'+matchedMsgIndices.length
    : 'No matches';
}

function scrollToMatch(pos) {
  if (matchedMsgIndices.length === 0) return;
  const idx = matchedMsgIndices[pos];
  const el = $('msg-'+idx);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function jumpTo(dir) {
  if (matchedMsgIndices.length === 0) {
    // No search — jump to first/last/prev/next message
    const c = $('messages-container');
    if (dir === 'first') c.scrollTop = 0;
    else if (dir === 'last') c.scrollTop = c.scrollHeight;
    return;
  }
  if (dir === 'first') matchNavPos = 0;
  else if (dir === 'last') matchNavPos = matchedMsgIndices.length - 1;
  else if (dir === 'next') matchNavPos = Math.min(matchNavPos+1, matchedMsgIndices.length-1);
  else if (dir === 'prev') matchNavPos = Math.max(matchNavPos-1, 0);
  updateNavPos();
  scrollToMatch(matchNavPos);
}

function closePanel() {
  selectedSessionId = null;
  $('sessions-layout').classList.remove('panel-open');
  $('session-panel').style.display = 'none';
  document.querySelectorAll('.sessions-table tr').forEach(tr => tr.classList.remove('selected'));
}

// ── Init ──────────────────────────────────────────────────────────────────
poll();
setInterval(poll, 2000);
</script>
</body>
</html>`;
