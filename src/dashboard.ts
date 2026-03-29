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
</style>
</head>
<body>
<h1><span id="status-dot"></span>Claude Rate Limiter</h1>
<div class="subtitle">Reverse proxy for Anthropic API — rate limit queuing + token tracking</div>

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

async function toggleStrip() {
  const resp = await fetch('/config', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({strip: 'toggle'}) });
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

    // Strip toggle
    const btn = $('btn-strip');
    btn.textContent = h.stripEnabled ? 'ON' : 'OFF';
    btn.className = 'toggle ' + (h.stripEnabled ? 'on' : 'off');

    // Utilization
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

    // Cache hit rate
    const t = stats.totals;
    const cacheTotal = (t.cacheRead || 0) + (t.cacheCreation || 0);
    const hitRate = cacheTotal > 0 ? (t.cacheRead || 0) / cacheTotal : 0;
    $('v-cache-rate').textContent = cacheTotal > 0 ? (hitRate * 100).toFixed(0) + '%' : '—';
    $('bar-cache').style.width = (hitRate * 100) + '%';
    $('v-cache-detail').textContent = 'Read: ' + fmt(t.cacheRead) + ' | Create: ' + fmt(t.cacheCreation);

    // Stats
    $('v-forwarded').textContent = h.stats.forwarded;
    $('v-429s').textContent = h.stats.upstream429s + ' upstream 429s';
    $('v-queued').textContent = h.stats.queued + ' / ' + h.stats.rejected;
    $('v-threshold').textContent = (h.threshold*100).toFixed(0) + '%';
    $('v-saved').textContent = h.stats.tokensSaved > 0 ? '~' + fmt(h.stats.tokensSaved) : '—';
    $('v-stripped').textContent = h.stats.requestsStripped > 0 ? h.stats.requestsStripped + ' stripped' : 'stripping off';
    $('v-cost').textContent = stats.estimatedCostUsd > 0 ? '$' + stats.estimatedCostUsd.toFixed(4) : '$0.00';

    // Request log — now with cache columns
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

    // Model table — with cache create + hit rate
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

    // Events
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

poll();
setInterval(poll, 2000);
</script>
</body>
</html>`;
