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
h1 { font-size:18px; color:#8b5cf6; margin-bottom:12px; }
h2 { font-size:14px; color:#6366f1; margin:16px 0 8px; border-bottom:1px solid #1e1e2e; padding-bottom:4px; }
.grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:12px; margin-bottom:16px; }
.card { background:#12121a; border:1px solid #1e1e2e; border-radius:8px; padding:12px; }
.card .label { color:#888; font-size:11px; text-transform:uppercase; letter-spacing:1px; }
.card .value { font-size:24px; font-weight:700; margin-top:4px; }
.card .sub { font-size:11px; color:#666; margin-top:2px; }
.green { color:#22c55e; } .yellow { color:#eab308; } .red { color:#ef4444; } .purple { color:#8b5cf6; } .blue { color:#3b82f6; }
.bar-bg { background:#1e1e2e; border-radius:4px; height:8px; margin-top:6px; overflow:hidden; }
.bar-fill { height:100%; border-radius:4px; transition:width 0.5s; }
table { width:100%; border-collapse:collapse; font-size:12px; }
th { text-align:left; color:#888; font-size:11px; padding:6px 8px; border-bottom:1px solid #1e1e2e; }
td { padding:6px 8px; border-bottom:1px solid #111; }
tr:hover { background:#15151f; }
.tag { display:inline-block; padding:1px 6px; border-radius:3px; font-size:10px; font-weight:600; }
.savings { background:linear-gradient(135deg,#12121a,#1a1a2e); border:1px solid #22c55e33; }
.savings .value { color:#22c55e; }
#status-dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:6px; }
.log { max-height:300px; overflow-y:auto; background:#0d0d14; border:1px solid #1e1e2e; border-radius:6px; padding:8px; }
.log-entry { padding:3px 0; border-bottom:1px solid #111; display:grid; grid-template-columns:70px 180px 80px 80px 80px 80px 1fr; gap:4px; align-items:center; }
.log-entry:last-child { border:none; }
.mono { font-family:inherit; }
</style>
</head>
<body>
<h1><span id="status-dot"></span>Claude Rate Limiter</h1>

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
  <div class="card savings">
    <div class="label">Tokens Saved</div>
    <div class="value" id="v-saved">—</div>
    <div class="sub" id="v-stripped">— requests stripped</div>
  </div>
  <div class="card">
    <div class="label">Forwarded</div>
    <div class="value blue" id="v-forwarded">0</div>
    <div class="sub" id="v-429s">0 upstream 429s</div>
  </div>
  <div class="card">
    <div class="label">Queued / Rejected</div>
    <div class="value" id="v-queued">0 / 0</div>
    <div class="sub">Threshold: <span id="v-threshold">85%</span></div>
  </div>
</div>

<h2>Request Log</h2>
<div class="log" id="request-log">
  <div class="log-entry" style="font-weight:600;color:#888">
    <span>Time</span><span>Model</span><span>Status</span><span>Latency</span><span>In</span><span>Out</span><span>Path</span>
  </div>
</div>

<h2>By Model</h2>
<table id="model-table">
  <thead><tr><th>Model</th><th>Requests</th><th>Input Tokens</th><th>Output Tokens</th><th>Cache Read</th><th>Avg Latency</th><th>Est. Cost</th></tr></thead>
  <tbody id="model-body"></tbody>
</table>

<script>
const $ = id => document.getElementById(id);

function utilColor(v) { return v >= 0.85 ? '#ef4444' : v >= 0.6 ? '#eab308' : '#22c55e'; }
function fmt(n) { return n >= 1000000 ? (n/1000000).toFixed(1)+'M' : n >= 1000 ? (n/1000).toFixed(1)+'K' : String(n); }
function timeAgo(iso) {
  if (!iso) return '—';
  const ms = new Date(iso).getTime() - Date.now();
  if (ms < 0) return 'now';
  const s = Math.ceil(ms/1000);
  return s > 3600 ? Math.floor(s/3600)+'h '+Math.floor((s%3600)/60)+'m' : s > 60 ? Math.floor(s/60)+'m '+s%60+'s' : s+'s';
}

async function poll() {
  try {
    const [health, stats, reqs] = await Promise.all([
      fetch('/health').then(r=>r.json()),
      fetch('/stats').then(r=>r.json()),
      fetch('/requests').then(r=>r.json()),
    ]);

    // Status
    const h = health;
    const dot = $('status-dot');
    dot.style.background = h.status === 'allowed' ? '#22c55e' : h.status === 'rejected' ? '#ef4444' : '#888';
    $('v-status').textContent = h.status || 'unknown';
    $('v-status').className = 'value ' + (h.status === 'allowed' ? 'green' : h.status === 'rejected' ? 'red' : '');
    $('v-queue').textContent = 'Queue: ' + h.queue + (h.shouldQueue ? ' (queueing)' : '');

    // Utilization
    const u5 = h.rateLimit.fiveHour.utilization;
    const u7 = h.rateLimit.sevenDay.utilization;
    $('v-5h').textContent = (u5*100).toFixed(0) + '%';
    $('v-5h').className = 'value';
    $('v-5h').style.color = utilColor(u5);
    $('bar-5h').style.width = (u5*100)+'%';
    $('bar-5h').style.background = utilColor(u5);
    $('v-5h-reset').textContent = 'Resets in ' + timeAgo(h.rateLimit.fiveHour.resetsAt);

    $('v-7d').textContent = (u7*100).toFixed(0) + '%';
    $('v-7d').style.color = utilColor(u7);
    $('bar-7d').style.width = (u7*100)+'%';
    $('bar-7d').style.background = utilColor(u7);
    $('v-7d-reset').textContent = 'Resets in ' + timeAgo(h.rateLimit.sevenDay.resetsAt);

    // Savings
    $('v-saved').textContent = '~' + fmt(h.stats.tokensSaved);
    $('v-stripped').textContent = h.stats.requestsStripped + ' requests stripped';

    // Stats
    $('v-forwarded').textContent = h.stats.forwarded;
    $('v-429s').textContent = h.stats.upstream429s + ' upstream 429s';
    $('v-queued').textContent = h.stats.queued + ' / ' + h.stats.rejected;
    $('v-threshold').textContent = (h.threshold*100).toFixed(0) + '%';

    // Request log
    const log = $('request-log');
    const header = log.children[0];
    log.innerHTML = '';
    log.appendChild(header);
    for (const r of reqs.slice(0, 50)) {
      if (!r.path || r.path === '/') continue;
      const row = document.createElement('div');
      row.className = 'log-entry';
      const time = new Date(r.timestamp).toLocaleTimeString();
      const model = (r.model || '?').replace('claude-','').replace('-20251001','');
      const status = r.statusCode === 200 ? '<span class="green">200</span>' : r.statusCode === 429 ? '<span class="red">429</span>' : r.statusCode || '?';
      const latency = r.latencyMs ? r.latencyMs + 'ms' : '—';
      const inTok = r.inputTokens ? fmt(r.inputTokens) : '—';
      const outTok = r.outputTokens ? fmt(r.outputTokens) : '—';
      row.innerHTML = '<span>'+time+'</span><span>'+model+'</span><span>'+status+'</span><span>'+latency+'</span><span>'+inTok+'</span><span>'+outTok+'</span><span style="color:#666;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+r.path+'</span>';
      log.appendChild(row);
    }

    // Model table
    const tbody = $('model-body');
    tbody.innerHTML = '';
    for (const [model, s] of Object.entries(stats.byModel || {})) {
      const tr = document.createElement('tr');
      const name = model.replace('claude-','').replace('-20251001','');
      tr.innerHTML = '<td>'+name+'</td><td>'+s.count+'</td><td>'+fmt(s.inputTokens)+'</td><td>'+fmt(s.outputTokens)+'</td><td>'+fmt(s.cacheRead)+'</td><td>'+s.avgLatencyMs+'ms</td><td>—</td>';
      tbody.appendChild(tr);
    }
    if (stats.estimatedCostUsd > 0) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td colspan="6" style="text-align:right;color:#888">Estimated cost</td><td class="green">$'+stats.estimatedCostUsd.toFixed(4)+'</td>';
      tbody.appendChild(tr);
    }
  } catch(e) { console.error('Poll error:', e); }
}

poll();
setInterval(poll, 2000);
</script>
</body>
</html>`;
