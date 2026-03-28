// ============================================================================
// claude-rate-limiter — Rate-limit-aware reverse proxy for the Anthropic API
// ============================================================================
//
// Sits between Claude CLI/SDK and api.anthropic.com. Reads Anthropic's unified
// rate limit headers and queues requests when utilization is high.
//
// Usage:
//   ANTHROPIC_BASE_URL=http://localhost:3128 claude ...
//
// Anthropic's unified rate limit system uses:
//   anthropic-ratelimit-unified-status: allowed | rejected
//   anthropic-ratelimit-unified-5h-utilization: 0.0–1.0
//   anthropic-ratelimit-unified-5h-reset: <epoch seconds>
//   anthropic-ratelimit-unified-7d-utilization: 0.0–1.0
//   anthropic-ratelimit-unified-7d-reset: <epoch seconds>
//   anthropic-ratelimit-unified-representative-claim: five_hour | seven_day
//   anthropic-ratelimit-unified-fallback-percentage: 0.0–1.0

import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';

// ── Config ──────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '3128', 10);
const UPSTREAM = process.env.ANTHROPIC_API_URL || 'https://api.anthropic.com';
const THRESHOLD = parseFloat(process.env.QUEUE_THRESHOLD || '0.85'); // queue when utilization > 85%
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const MAX_QUEUE = parseInt(process.env.MAX_QUEUE_SIZE || '100', 10);

const upstream = new URL(UPSTREAM);

// ── Rate limit state ────────────────────────────────────────────────────────

interface WindowState {
  utilization: number;  // 0.0–1.0
  reset: number;        // epoch ms
  status: string;       // allowed | rejected
}

interface MinuteState {
  limit: number;        // max per minute
  remaining: number;    // remaining in current window
  reset: number;        // epoch ms
}

interface RateLimitState {
  // Unified (5h / 7d utilization-based)
  overall: string;                    // allowed | rejected
  fiveHour: WindowState;
  sevenDay: WindowState;
  representativeClaim: string;        // five_hour | seven_day
  fallbackPercentage: number;         // 0.0–1.0

  // Per-minute (classic RPM / TPM)
  requests: MinuteState;
  tokens: MinuteState;

  // Stats
  totalForwarded: number;
  totalQueued: number;
  totalRejected: number;
  total429s: number;
  lastUpdated: number;
}

const state: RateLimitState = {
  overall: 'unknown',
  fiveHour: { utilization: 0, reset: 0, status: 'unknown' },
  sevenDay: { utilization: 0, reset: 0, status: 'unknown' },
  representativeClaim: '',
  fallbackPercentage: 0,
  requests: { limit: Infinity, remaining: Infinity, reset: 0 },
  tokens: { limit: Infinity, remaining: Infinity, reset: 0 },
  totalForwarded: 0,
  totalQueued: 0,
  totalRejected: 0,
  total429s: 0,
  lastUpdated: 0,
};

// ── Queue ───────────────────────────────────────────────────────────────────

interface QueuedRequest {
  req: IncomingMessage;
  res: ServerResponse;
  body: Buffer;
  resolve: () => void;
  queuedAt: number;
}

const queue: QueuedRequest[] = [];
let drainTimer: ReturnType<typeof setTimeout> | null = null;

function getActiveWindow(): WindowState {
  // Use the representative claim to determine which window is limiting
  return state.representativeClaim === 'seven_day' ? state.sevenDay : state.fiveHour;
}

function shouldQueue(): boolean {
  // If we've never seen headers, let it through
  if (state.lastUpdated === 0) return false;

  // If Anthropic said "rejected", definitely queue
  if (state.overall === 'rejected') return true;

  // Check unified utilization windows
  const active = getActiveWindow();
  if (active.utilization >= THRESHOLD) return true;
  const other = state.representativeClaim === 'seven_day' ? state.fiveHour : state.sevenDay;
  if (other.utilization >= THRESHOLD) return true;

  // Check per-minute limits (RPM / TPM)
  const now = Date.now();
  if (state.requests.remaining <= 2 && now < state.requests.reset) return true;
  if (state.tokens.remaining <= 1000 && now < state.tokens.reset) return true;

  return false;
}

function getResetDelay(): number {
  const now = Date.now();

  // Per-minute resets are shorter — prefer those if active
  if (state.requests.remaining <= 2 && state.requests.reset > now) {
    return state.requests.reset - now;
  }
  if (state.tokens.remaining <= 1000 && state.tokens.reset > now) {
    return state.tokens.reset - now;
  }

  // Fall back to unified window reset
  const active = getActiveWindow();
  if (active.reset > now) return active.reset - now;
  return 30_000;
}

function scheduleDrain() {
  if (drainTimer || queue.length === 0) return;

  // When utilization is high, wait for a fraction of the reset window
  // Don't wait for the full reset — trickle requests through
  const resetDelay = getResetDelay();
  // Release one request every few seconds to gradually bring utilization down
  const delay = Math.min(resetDelay, Math.max(2000, resetDelay / Math.max(queue.length, 1)));

  log('info', `⏳ Queue: ${queue.length} waiting, next release in ${(delay / 1000).toFixed(1)}s (reset in ${(resetDelay / 1000).toFixed(0)}s)`);

  drainTimer = setTimeout(() => {
    drainTimer = null;
    drainQueue();
  }, delay);
}

function drainQueue() {
  // Release one at a time — the response will update our utilization state
  if (queue.length > 0) {
    const item = queue.shift()!;
    state.totalQueued++;
    const waitedMs = Date.now() - item.queuedAt;
    log('info', `▶ Releasing queued request (waited ${(waitedMs / 1000).toFixed(1)}s, ${queue.length} remaining)`);
    item.resolve();
  }
  // Schedule next drain if there are more
  if (queue.length > 0) scheduleDrain();
}

// ── Header parsing ──────────────────────────────────────────────────────────

function updateStateFromHeaders(headers: Record<string, string | string[] | undefined>) {
  const get = (name: string): string | undefined => {
    const v = headers[name];
    return Array.isArray(v) ? v[0] : v;
  };

  const overallStatus = get('anthropic-ratelimit-unified-status');
  if (!overallStatus) return; // Not an Anthropic rate-limited response

  state.overall = overallStatus;

  // 5-hour window
  const h5Status = get('anthropic-ratelimit-unified-5h-status');
  const h5Util = get('anthropic-ratelimit-unified-5h-utilization');
  const h5Reset = get('anthropic-ratelimit-unified-5h-reset');
  if (h5Status) state.fiveHour.status = h5Status;
  if (h5Util) state.fiveHour.utilization = parseFloat(h5Util);
  if (h5Reset) state.fiveHour.reset = parseInt(h5Reset, 10) * 1000; // epoch seconds → ms

  // 7-day window
  const d7Status = get('anthropic-ratelimit-unified-7d-status');
  const d7Util = get('anthropic-ratelimit-unified-7d-utilization');
  const d7Reset = get('anthropic-ratelimit-unified-7d-reset');
  if (d7Status) state.sevenDay.status = d7Status;
  if (d7Util) state.sevenDay.utilization = parseFloat(d7Util);
  if (d7Reset) state.sevenDay.reset = parseInt(d7Reset, 10) * 1000;

  // Meta
  const claim = get('anthropic-ratelimit-unified-representative-claim');
  const fallback = get('anthropic-ratelimit-unified-fallback-percentage');
  if (claim) state.representativeClaim = claim;
  if (fallback) state.fallbackPercentage = parseFloat(fallback);

  // Per-minute limits (classic RPM / TPM)
  const rl = get('anthropic-ratelimit-requests-limit');
  const rr = get('anthropic-ratelimit-requests-remaining');
  const rrr = get('anthropic-ratelimit-requests-reset');
  const tl = get('anthropic-ratelimit-tokens-limit');
  const tr = get('anthropic-ratelimit-tokens-remaining');
  const trr = get('anthropic-ratelimit-tokens-reset');

  if (rl) state.requests.limit = parseInt(rl, 10);
  if (rr) state.requests.remaining = parseInt(rr, 10);
  if (rrr) {
    const d = new Date(rrr);
    state.requests.reset = isNaN(d.getTime()) ? Date.now() + parseFloat(rrr) * 1000 : d.getTime();
  }
  if (tl) state.tokens.limit = parseInt(tl, 10);
  if (tr) state.tokens.remaining = parseInt(tr, 10);
  if (trr) {
    const d = new Date(trr);
    state.tokens.reset = isNaN(d.getTime()) ? Date.now() + parseFloat(trr) * 1000 : d.getTime();
  }

  state.lastUpdated = Date.now();

  const active = getActiveWindow();
  const symbol = active.utilization >= THRESHOLD ? '🔴' : active.utilization >= THRESHOLD * 0.7 ? '🟡' : '🟢';
  const rpmInfo = state.requests.limit < Infinity ? ` rpm=${state.requests.remaining}/${state.requests.limit}` : '';
  const tpmInfo = state.tokens.limit < Infinity ? ` tpm=${state.tokens.remaining}/${state.tokens.limit}` : '';
  log('info', `${symbol} Utilization: 5h=${(state.fiveHour.utilization * 100).toFixed(0)}% 7d=${(state.sevenDay.utilization * 100).toFixed(0)}%${rpmInfo}${tpmInfo} [${state.representativeClaim}] status=${state.overall}`);
}

// ── Request rewriting — strip bloat from system prompt + tools ──────────────

const STRIP_ENABLED = process.env.STRIP_BLOAT !== 'false'; // on by default
const KEEP_TOOLS = new Set((process.env.KEEP_TOOLS || 'Bash,Read,Edit,Write,Glob,Grep,Agent,Skill,WebSearch,WebFetch').split(','));
// System prompt blocks larger than this are considered "default bloat" and replaced
const BLOAT_THRESHOLD = parseInt(process.env.BLOAT_THRESHOLD || '3000', 10);

// Stats
let totalTokensSaved = 0;
let totalRequestsStripped = 0;

// Minimal system prompt — replaces the 51K Claude Code default
const SLIM_SYSTEM = `You are Claude, an AI coding assistant. Be concise and direct.

# Tools
Use dedicated tools over Bash when possible: Read (not cat), Edit (not sed), Write (not echo), Glob (not find), Grep (not grep/rg).
Call multiple independent tools in parallel. Chain dependent calls sequentially with &&.

# Code
- Read before modifying. Don't add features beyond what's asked.
- No speculative abstractions, unnecessary error handling, or backwards-compat hacks.
- Don't add comments/docstrings to unchanged code.
- Avoid security vulnerabilities (injection, XSS, etc).

# Safety
- Confirm before destructive ops (rm -rf, force-push, drop tables, deleting branches).
- Don't push, create PRs, or send messages without explicit permission.
- Never skip git hooks or bypass signing unless asked.

# Style
- No emojis unless asked. Short responses. Lead with action, not reasoning.
- Reference code as file_path:line_number. PRs as owner/repo#123.`;

function rewriteRequest(body: Buffer): Buffer {
  if (!STRIP_ENABLED) return body;

  try {
    const json = JSON.parse(body.toString());
    if (!json.messages) return body; // Not a messages API call
    let stripped = false;
    const origSize = body.length;

    // 1. Replace system prompt with slim version
    if (json.system) {
      const blocks = Array.isArray(json.system) ? json.system : [{ type: 'text', text: json.system }];

      // Keep billing header (block 0) and any user-appended system prompts
      // Replace the massive Claude Code instructions with our slim version
      const newBlocks: any[] = [];
      let replacedDefault = false;
      for (const block of blocks) {
        const text = block.text || '';
        // Keep billing/metadata headers (short, start with x- or contain version info)
        if (text.includes('x-anthropic-billing-header') || text.includes('billing-header')) {
          newBlocks.push(block);
          continue;
        }
        // Keep short blocks — these are user/app system prompts, persona prompts, etc.
        if (text.length < BLOAT_THRESHOLD) {
          newBlocks.push(block);
          continue;
        }
        // Large block — this is default Claude Code / SDK bloat.
        // Detection: any block over BLOAT_THRESHOLD chars that we haven't already
        // replaced is assumed to be default instructions. This works regardless of
        // prompt version because Anthropic's default is always massive (10K+ chars)
        // while user system prompts are typically short.
        if (!replacedDefault) {
          const slim: any = { type: 'text', text: SLIM_SYSTEM };
          if (block.cache_control) slim.cache_control = block.cache_control;
          newBlocks.push(slim);
          replacedDefault = true;
          stripped = true;
          log('debug', `✂️ Replaced default system block: ${text.length} → ${SLIM_SYSTEM.length} chars`);
        } else {
          // Additional large blocks (auto memory, environment dump, etc.) — drop entirely
          stripped = true;
          log('debug', `✂️ Dropped system block: ${text.length} chars (${text.slice(0, 40)}...)`);
        }
      }
      json.system = newBlocks;
    }

    // 2. Strip useless tools
    if (Array.isArray(json.tools)) {
      const origCount = json.tools.length;
      json.tools = json.tools.filter((t: any) => KEEP_TOOLS.has(t.name));

      // Replace ALL tool descriptions with minimal versions
      const SLIM_TOOLS: Record<string, string> = {
        Bash: `Execute bash commands. Working dir persists. Timeout: 120s default, 600s max. Use run_in_background for long commands. Use && to chain. Prefer dedicated tools (Read/Edit/Write/Glob/Grep) over shell equivalents.`,
        Read: `Read file contents. Supports images, PDFs (use pages param), notebooks. Use offset/limit for large files.`,
        Edit: `Replace exact strings in files. old_string must be unique. Read the file first. Preserves indentation.`,
        Write: `Create new files or full rewrites. Read existing files first. Prefer Edit for modifications.`,
        Glob: `Find files by pattern (e.g. "**/*.ts", "src/**/*.tsx"). Returns paths sorted by modification time.`,
        Grep: `Search file contents with regex. Modes: files_with_matches (default), content, count. Use -i for case insensitive. Use glob/type params to filter.`,
        Agent: `Launch subagent for complex tasks. Types: general-purpose (default), Explore (codebase search), Plan (architecture). Use run_in_background:true for independent work.`,
        Skill: `Execute a skill/slash command (e.g. "commit", "review-pr"). Only use for skills listed in system messages.`,
        WebSearch: `Search the web. Returns links and summaries. Include sources in response.`,
        WebFetch: `Fetch a URL and return its content.`,
      };

      for (const tool of json.tools) {
        const slim = SLIM_TOOLS[tool.name];
        if (slim && tool.description && tool.description.length > slim.length * 1.5) {
          tool.description = slim;
          stripped = true;
        }
      }

      if (json.tools.length < origCount) stripped = true;
    }

    // 3. Strip system-reminder bloat from user messages
    if (Array.isArray(json.messages)) {
      for (const msg of json.messages) {
        if (msg.role !== 'user') continue;
        if (typeof msg.content === 'string') {
          const before = msg.content.length;
          // Remove task tool nag reminders
          msg.content = msg.content.replace(/<system-reminder>\s*The task tools haven't been used recently[\s\S]*?<\/system-reminder>/g, '');
          // Remove verbose MCP server instructions
          msg.content = msg.content.replace(/<system-reminder>\s*# MCP Server Instructions[\s\S]*?<\/system-reminder>/g, '');
          // Remove skill availability reminders (keep the list, strip the verbose preamble)
          msg.content = msg.content.replace(/The following skills are available[\s\S]*?(?=\n- \w)/g, 'Skills: ');
          if (msg.content.length < before) stripped = true;
        } else if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type !== 'text' || !block.text) continue;
            const before = block.text.length;
            block.text = block.text.replace(/<system-reminder>\s*The task tools haven't been used recently[\s\S]*?<\/system-reminder>/g, '');
            block.text = block.text.replace(/<system-reminder>\s*# MCP Server Instructions[\s\S]*?<\/system-reminder>/g, '');
            block.text = block.text.replace(/The following skills are available[\s\S]*?(?=\n- \w)/g, 'Skills: ');
            if (block.text.length < before) stripped = true;
          }
        }
      }
    }

    if (stripped) {
      const newBody = Buffer.from(JSON.stringify(json));
      const saved = origSize - newBody.length;
      const savedTokens = Math.round(saved / 4);
      totalTokensSaved += savedTokens;
      totalRequestsStripped++;
      log('info', `✂️ Stripped ${(saved / 1024).toFixed(1)}KB (~${savedTokens} tokens): ${origSize} → ${newBody.length} chars [total saved: ~${totalTokensSaved} tokens across ${totalRequestsStripped} requests]`);
      return newBody;
    }
    return body;
  } catch {
    return body; // Parse error — forward as-is
  }
}

// ── Proxy ───────────────────────────────────────────────────────────────────

// ── Request analysis ────────────────────────────────────────────────────────

interface RequestLog {
  timestamp: number;
  method: string;
  path: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreation?: number;
  cacheRead?: number;
  statusCode?: number;
  latencyMs?: number;
  streaming?: boolean;
  systemPromptLength?: number;
  messageCount?: number;
}

const recentRequests: RequestLog[] = [];
const MAX_REQUEST_LOG = 200;

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';

const LOG_DIR = process.env.LOG_DIR || './logs';
if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });

function analyzeRequestBody(body: Buffer, path: string): Partial<RequestLog> {
  try {
    const json = JSON.parse(body.toString());
    const info: Partial<RequestLog> = {};
    if (json.model) info.model = json.model;
    if (json.stream !== undefined) info.streaming = json.stream;
    if (json.system) {
      info.systemPromptLength = typeof json.system === 'string'
        ? json.system.length
        : JSON.stringify(json.system).length;

      // Dump system prompt to file for analysis
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const promptFile = `${LOG_DIR}/system-prompt-${ts}.txt`;
      const content = typeof json.system === 'string'
        ? json.system
        : Array.isArray(json.system)
          ? json.system.map((b: any) => b.text || JSON.stringify(b)).join('\n---\n')
          : JSON.stringify(json.system, null, 2);
      writeFileSync(promptFile, content);
      log('debug', `📝 System prompt saved: ${promptFile} (${info.systemPromptLength} chars)`);
    }
    if (Array.isArray(json.messages)) info.messageCount = json.messages.length;

    // Dump full request for analysis (redact API key)
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const reqFile = `${LOG_DIR}/request-${ts}.json`;
    const redacted = { ...json };
    // Don't save full message content — just metadata
    if (Array.isArray(redacted.messages)) {
      redacted.messages = redacted.messages.map((m: any) => ({
        role: m.role,
        contentLength: typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length,
        contentPreview: typeof m.content === 'string' ? m.content.slice(0, 100) : '(structured)',
      }));
    }
    writeFileSync(reqFile, JSON.stringify(redacted, null, 2));

    return info;
  } catch { return {}; }
}

function analyzeResponseChunks(chunks: Buffer[]): Partial<RequestLog> {
  const full = Buffer.concat(chunks).toString();
  const info: Partial<RequestLog> = {};

  try {
    // Non-streaming: single JSON response
    const json = JSON.parse(full);
    return extractUsage(json);
  } catch {
    // Streaming SSE: parse all events to find usage data
    const lines = full.split('\n');
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      try {
        const event = JSON.parse(line.slice(6));
        // message_start has input token usage
        if (event.type === 'message_start' && event.message?.usage) {
          info.inputTokens = event.message.usage.input_tokens;
          if (event.message.usage.cache_read_input_tokens) info.cacheRead = event.message.usage.cache_read_input_tokens;
          if (event.message.usage.cache_creation_input_tokens) info.cacheCreation = event.message.usage.cache_creation_input_tokens;
        }
        // message_delta has output token usage (comes at the end)
        if (event.type === 'message_delta' && event.usage) {
          info.outputTokens = event.usage.output_tokens;
        }
      } catch {}
    }
    return info;
  }
}

function extractUsage(json: any): Partial<RequestLog> {
  const info: Partial<RequestLog> = {};
  if (json.usage) {
    if (json.usage.input_tokens) info.inputTokens = json.usage.input_tokens;
    if (json.usage.output_tokens) info.outputTokens = json.usage.output_tokens;
    if (json.usage.cache_creation_input_tokens) info.cacheCreation = json.usage.cache_creation_input_tokens;
    if (json.usage.cache_read_input_tokens) info.cacheRead = json.usage.cache_read_input_tokens;
  }
  return info;
}

function forwardRequest(req: IncomingMessage, res: ServerResponse, body: Buffer) {
  const path = req.url || '/';
  const headers: Record<string, string> = {};

  for (const [key, value] of Object.entries(req.headers)) {
    if (key === 'host' || key === 'connection') continue;
    if (value) headers[key] = Array.isArray(value) ? value.join(', ') : value;
  }
  headers['host'] = upstream.host;

  const startTime = Date.now();
  const reqInfo = analyzeRequestBody(body, path);
  const entry: RequestLog = { timestamp: startTime, method: req.method || 'POST', path, ...reqInfo };

  // Rewrite request — strip system prompt bloat + useless tools
  body = rewriteRequest(body);
  headers['content-length'] = String(body.length);

  const proxyReq = httpsRequest(
    {
      hostname: upstream.hostname,
      port: upstream.port || 443,
      path,
      method: req.method,
      headers,
    },
    (proxyRes) => {
      updateStateFromHeaders(proxyRes.headers as Record<string, string | string[] | undefined>);

      if (proxyRes.statusCode === 429) {
        state.total429s++;
        const retryAfter = proxyRes.headers['retry-after'];
        log('warn', `🚫 429 from Anthropic! retry-after=${retryAfter}s queue=${queue.length}`);

        if (retryAfter) {
          const resetMs = Date.now() + parseFloat(retryAfter) * 1000;
          state.fiveHour.reset = Math.max(state.fiveHour.reset, resetMs);
          state.fiveHour.utilization = 1.0;
          state.overall = 'rejected';
        }
      }

      state.totalForwarded++;
      entry.statusCode = proxyRes.statusCode;

      // Forward status + headers to client
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);

      // Capture response body for analysis while streaming to client
      const resChunks: Buffer[] = [];
      proxyRes.on('data', (chunk: Buffer) => {
        resChunks.push(chunk);
        res.write(chunk);
      });

      proxyRes.on('end', () => {
        res.end();
        entry.latencyMs = Date.now() - startTime;

        // Extract usage from response
        const resInfo = analyzeResponseChunks(resChunks);
        Object.assign(entry, resInfo);

        // Log the request
        recentRequests.push(entry);
        if (recentRequests.length > MAX_REQUEST_LOG) recentRequests.shift();

        const model = entry.model || '?';
        const tokens = entry.inputTokens || entry.outputTokens
          ? `in=${entry.inputTokens || '?'} out=${entry.outputTokens || '?'}${entry.cacheRead ? ` cache_read=${entry.cacheRead}` : ''}${entry.cacheCreation ? ` cache_create=${entry.cacheCreation}` : ''}`
          : '';
        log('info', `📡 ${path} ${model} ${entry.latencyMs}ms ${tokens}`);

        if (queue.length > 0) drainQueue();
      });
    },
  );

  proxyReq.on('error', (err) => {
    log('error', `Upstream error: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'upstream_error', message: err.message }));
    }
  });

  if (body.length > 0) proxyReq.write(body);
  proxyReq.end();
}

// ── HTTP server ─────────────────────────────────────────────────────────────

const server = createServer((req, res) => {
  const path = req.url || '/';

  // Health endpoint
  if (path === '/health' && req.method === 'GET') {
    const active = getActiveWindow();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      status: state.overall || 'unknown',
      upstream: UPSTREAM,
      queue: queue.length,
      threshold: THRESHOLD,
      shouldQueue: shouldQueue(),
      rateLimit: {
        fiveHour: {
          utilization: state.fiveHour.utilization,
          status: state.fiveHour.status,
          resetsAt: state.fiveHour.reset ? new Date(state.fiveHour.reset).toISOString() : null,
        },
        sevenDay: {
          utilization: state.sevenDay.utilization,
          status: state.sevenDay.status,
          resetsAt: state.sevenDay.reset ? new Date(state.sevenDay.reset).toISOString() : null,
        },
        representativeClaim: state.representativeClaim,
        fallbackPercentage: state.fallbackPercentage,
        perMinute: {
          requests: { remaining: state.requests.remaining === Infinity ? null : state.requests.remaining, limit: state.requests.limit === Infinity ? null : state.requests.limit, resetsAt: state.requests.reset ? new Date(state.requests.reset).toISOString() : null },
          tokens: { remaining: state.tokens.remaining === Infinity ? null : state.tokens.remaining, limit: state.tokens.limit === Infinity ? null : state.tokens.limit, resetsAt: state.tokens.reset ? new Date(state.tokens.reset).toISOString() : null },
        },
      },
      stats: {
        forwarded: state.totalForwarded,
        queued: state.totalQueued,
        rejected: state.totalRejected,
        upstream429s: state.total429s,
        tokensSaved: totalTokensSaved,
        requestsStripped: totalRequestsStripped,
      },
      lastUpdated: state.lastUpdated ? new Date(state.lastUpdated).toISOString() : null,
    }));
    return;
  }

  // Metrics (Prometheus-style)
  if (path === '/metrics' && req.method === 'GET') {
    const lines = [
      `# HELP claude_proxy_forwarded_total Total requests forwarded`,
      `# TYPE claude_proxy_forwarded_total counter`,
      `claude_proxy_forwarded_total ${state.totalForwarded}`,
      `# HELP claude_proxy_queued_total Total requests delayed by queue`,
      `# TYPE claude_proxy_queued_total counter`,
      `claude_proxy_queued_total ${state.totalQueued}`,
      `# HELP claude_proxy_rejected_total Total requests rejected (queue full)`,
      `# TYPE claude_proxy_rejected_total counter`,
      `claude_proxy_rejected_total ${state.totalRejected}`,
      `# HELP claude_proxy_upstream_429s_total 429 responses from Anthropic`,
      `# TYPE claude_proxy_upstream_429s_total counter`,
      `claude_proxy_upstream_429s_total ${state.total429s}`,
      `# HELP claude_proxy_queue_depth Current queue depth`,
      `# TYPE claude_proxy_queue_depth gauge`,
      `claude_proxy_queue_depth ${queue.length}`,
      `# HELP claude_proxy_utilization_5h Current 5-hour utilization (0–1)`,
      `# TYPE claude_proxy_utilization_5h gauge`,
      `claude_proxy_utilization_5h ${state.fiveHour.utilization}`,
      `# HELP claude_proxy_utilization_7d Current 7-day utilization (0–1)`,
      `# TYPE claude_proxy_utilization_7d gauge`,
      `claude_proxy_utilization_7d ${state.sevenDay.utilization}`,
    ];
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(lines.join('\n') + '\n');
    return;
  }

  // Recent requests log
  if (path === '/requests' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(recentRequests.slice(-50).reverse()));
    return;
  }

  // Aggregate stats
  if (path === '/stats' && req.method === 'GET') {
    const byModel: Record<string, { count: number; inputTokens: number; outputTokens: number; cacheRead: number; cacheCreation: number; avgLatencyMs: number; totalLatencyMs: number }> = {};
    const byPath: Record<string, number> = {};
    let totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCacheCreation = 0;

    for (const r of recentRequests) {
      // By model
      const m = r.model || 'unknown';
      if (!byModel[m]) byModel[m] = { count: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreation: 0, avgLatencyMs: 0, totalLatencyMs: 0 };
      byModel[m].count++;
      byModel[m].inputTokens += r.inputTokens || 0;
      byModel[m].outputTokens += r.outputTokens || 0;
      byModel[m].cacheRead += r.cacheRead || 0;
      byModel[m].cacheCreation += r.cacheCreation || 0;
      byModel[m].totalLatencyMs += r.latencyMs || 0;

      // By path
      byPath[r.path] = (byPath[r.path] || 0) + 1;

      totalInput += r.inputTokens || 0;
      totalOutput += r.outputTokens || 0;
      totalCacheRead += r.cacheRead || 0;
      totalCacheCreation += r.cacheCreation || 0;
    }

    for (const m of Object.values(byModel)) {
      m.avgLatencyMs = m.count > 0 ? Math.round(m.totalLatencyMs / m.count) : 0;
    }

    // Estimate cost (Anthropic pricing March 2026)
    const PRICING: Record<string, { input: number; output: number; cacheRead: number; cacheCreation: number }> = {
      'claude-opus-4-6': { input: 15, output: 75, cacheRead: 1.5, cacheCreation: 18.75 },
      'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheCreation: 3.75 },
      'claude-haiku-4-5-20251001': { input: 0.8, output: 4, cacheRead: 0.08, cacheCreation: 1 },
    };
    let estimatedCost = 0;
    for (const [model, stats] of Object.entries(byModel)) {
      const p = Object.entries(PRICING).find(([k]) => model.includes(k))?.[1]
        || (model.includes('opus') ? PRICING['claude-opus-4-6'] : model.includes('haiku') ? PRICING['claude-haiku-4-5-20251001'] : PRICING['claude-sonnet-4-6']);
      estimatedCost += (stats.inputTokens / 1_000_000) * p.input
        + (stats.outputTokens / 1_000_000) * p.output
        + (stats.cacheRead / 1_000_000) * p.cacheRead
        + (stats.cacheCreation / 1_000_000) * p.cacheCreation;
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      window: `last ${recentRequests.length} requests`,
      byModel,
      byPath,
      totals: { requests: recentRequests.length, inputTokens: totalInput, outputTokens: totalOutput, cacheRead: totalCacheRead, cacheCreation: totalCacheCreation },
      estimatedCostUsd: Math.round(estimatedCost * 10000) / 10000,
    }));
    return;
  }

  // Proxy all other requests
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(chunks);

    if (shouldQueue()) {
      if (queue.length >= MAX_QUEUE) {
        state.totalRejected++;
        const resetDelay = getResetDelay();
        log('warn', `🚫 Queue full (${MAX_QUEUE}), rejecting request`);
        res.writeHead(429, {
          'content-type': 'application/json',
          'retry-after': String(Math.ceil(resetDelay / 1000)),
        });
        res.end(JSON.stringify({
          type: 'error',
          error: { type: 'rate_limit_error', message: `Rate limiter queue full (${MAX_QUEUE}). Retry after reset window.` },
        }));
        return;
      }

      const active = getActiveWindow();
      log('info', `⏸ Queuing request (utilization=${(active.utilization * 100).toFixed(0)}% > ${(THRESHOLD * 100).toFixed(0)}% threshold, ${queue.length + 1} in queue)`);
      new Promise<void>((resolve) => {
        queue.push({ req, res, body, resolve, queuedAt: Date.now() });
        scheduleDrain();
      }).then(() => {
        forwardRequest(req, res, body);
      });
      return;
    }

    forwardRequest(req, res, body);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  log('info', `🚀 claude-rate-limiter listening on :${PORT}`);
  log('info', `   Upstream: ${UPSTREAM}`);
  log('info', `   Queue threshold: ${(THRESHOLD * 100).toFixed(0)}% utilization`);
  log('info', `   Max queue: ${MAX_QUEUE}`);
  log('info', ``);
  log('info', `   Usage: ANTHROPIC_BASE_URL=http://localhost:${PORT} claude ...`);
});

// ── Logging ─────────────────────────────────────────────────────────────────

const LEVELS: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function log(level: string, msg: string) {
  if ((LEVELS[level] ?? 1) < (LEVELS[LOG_LEVEL] ?? 1)) return;
  const ts = new Date().toISOString().slice(11, 19);
  const prefix = level === 'error' ? '\x1b[31m' : level === 'warn' ? '\x1b[33m' : level === 'debug' ? '\x1b[90m' : '';
  const reset = prefix ? '\x1b[0m' : '';
  console.log(`${prefix}[${ts}] ${msg}${reset}`);
}
