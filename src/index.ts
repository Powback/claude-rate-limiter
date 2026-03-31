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
import { createGunzip, createBrotliDecompress, createInflate } from 'node:zlib';
import { Transform } from 'node:stream';
import { DASHBOARD_HTML } from './dashboard.js';

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

  // Track threshold crossings
  const prevShouldQueue = shouldQueue();
  state.lastUpdated = Date.now();
  const nowShouldQueue = shouldQueue();
  if (nowShouldQueue && !prevShouldQueue) {
    const reason = state.overall === 'rejected'
      ? `Status changed to rejected`
      : `5h utilization crossed ${(THRESHOLD*100).toFixed(0)}% (now ${(state.fiveHour.utilization*100).toFixed(0)}%)`;
    recordRateLimitEvent('threshold_crossed', reason);
    log('warn', `⚠️ Threshold crossed — queueing enabled: ${reason}`);
  }

  const active = getActiveWindow();
  const symbol = active.utilization >= THRESHOLD ? '🔴' : active.utilization >= THRESHOLD * 0.7 ? '🟡' : '🟢';
  const rpmInfo = state.requests.limit < Infinity ? ` rpm=${state.requests.remaining}/${state.requests.limit}` : '';
  const tpmInfo = state.tokens.limit < Infinity ? ` tpm=${state.tokens.remaining}/${state.tokens.limit}` : '';
  log('info', `${symbol} Utilization: 5h=${(state.fiveHour.utilization * 100).toFixed(0)}% 7d=${(state.sevenDay.utilization * 100).toFixed(0)}%${rpmInfo}${tpmInfo} [${state.representativeClaim}] status=${state.overall}`);
}

// ── Request rewriting — strip bloat from system prompt + tools ──────────────

let STRIP_ENABLED = process.env.STRIP_BLOAT === 'true'; // off by default — toggleable via /config endpoint
const KEEP_TOOLS = new Set((process.env.KEEP_TOOLS || 'Bash,Read,Edit,Write,Glob,Grep,Agent,Skill,WebSearch,WebFetch').split(','));
// System prompt blocks larger than this are considered "default bloat" and replaced
const BLOAT_THRESHOLD = parseInt(process.env.BLOAT_THRESHOLD || '3000', 10);

// Stats
let totalTokensSaved = 0;
let totalRequestsStripped = 0;

// Slim system prompt — replaces the 51K Claude Code default (~21,500 tokens → ~477 tokens)
// v2: fixed output efficiency gap (+18% output tokens vs passthrough), tightened prose
const SLIM_SYSTEM = `You are Claude, an AI coding assistant.

# Tools
Prefer dedicated tools: Read>cat, Edit>sed, Write>echo, Glob>find, Grep>rg.
Call independent tools in parallel. Chain dependent calls with &&.

# Code
Read before modifying. Scope to what's asked. No speculation, no dead-error-handling,
no comments on unchanged code. Secure: prevent XSS, injection, SQLi.

# Safety
Confirm before: rm -rf, force-push, drop tables, killing procs, pushing, opening PRs.
No hook bypass without explicit ask.

# Output
IMPORTANT: Lead with action, not reasoning. No preamble, no trailing summary.
One sentence if possible. If you can say it in one sentence, don't use three.

# Format
file_path:line_number for code refs. owner/repo#N for PRs/issues.
Write files relative to CWD, never absolute paths.`;

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

      // Ultra-terse tool descriptions — preserve critical hints (unique string, offset/limit, modes)
      // v2: cut from 283 → ~90 tokens while keeping all load-bearing constraints
      const SLIM_TOOLS: Record<string, string> = {
        Bash: `Shell. Dir persists. 120s/600s timeout. run_in_background avail. Prefer Read/Edit/Write/Glob/Grep over shell equivalents.`,
        Read: `Read file. offset/limit for large files. Supports images, PDFs (pages param), notebooks.`,
        Edit: `Replace string in file. old_string must be unique. Read file first.`,
        Write: `Create or rewrite file. Prefer Edit for modifications.`,
        Glob: `Find files by glob pattern.`,
        Grep: `Regex search. output_mode: files_with_matches|content|count. -i for case-insensitive.`,
        Agent: `Subagent. types: general-purpose|Explore|Plan. run_in_background avail.`,
        Skill: `Run slash command. Only use skills listed in system messages.`,
        WebSearch: `Web search. Include sources in response.`,
        WebFetch: `Fetch URL and return content.`,
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
  originalSize?: number;
  strippedSize?: number;
  tokensSaved?: number;
  conversationId?: string;
  taskDescription?: string;
}

interface SessionStats {
  id: string;
  firstSeen: number;
  lastSeen: number;
  model: string;
  requestCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheRead: number;
  totalCacheCreation: number;
  totalLatencyMs: number;
  taskDescription?: string;
  requests: RequestLog[];
}

const cchSessions = new Map<string, SessionStats>();
const MAX_CCH_SESSIONS = 50;

// ── Conversation Content Tracking ────────────────────────────────────────────
// Stores full message content in-memory for conversation grid display.
// Content is extracted from proxied requests/responses – NOT persisted to disk.

const MAX_CONTENT_TEXT        = 50_000;  // max chars per text/tool_result block
const MAX_CONTENT_CONVS       = 100;     // max conversations with stored content
const MAX_CONTENT_MESSAGES    = 1_000;   // max messages stored per conversation

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  | { type: 'image'; source: unknown }
  | { type: 'document'; source: unknown }
  | { type: string; [key: string]: unknown };

interface ConversationMessage {
  role: 'user' | 'assistant';
  content: ContentBlock[];
  timestamp: number;
  model?: string;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheRead?: number;
  cacheCreation?: number;
  stopReason?: string;
}

interface ConversationContent {
  conversationId: string;
  messages: ConversationMessage[];
  /** True while the assistant response is being streamed */
  isStreaming: boolean;
  /** Partial blocks assembled during active SSE stream */
  streamingBlocks: ContentBlock[];
  lastUpdatedAt: number;
}

const conversationContents = new Map<string, ConversationContent>();
// Per-conversation SSE clients for real-time content updates
const contentSseClients = new Map<string, Set<ServerResponse>>();

function getOrCreateConvContent(conversationId: string): ConversationContent {
  if (conversationContents.has(conversationId)) return conversationContents.get(conversationId)!;
  const cc: ConversationContent = {
    conversationId, messages: [], isStreaming: false, streamingBlocks: [], lastUpdatedAt: Date.now(),
  };
  conversationContents.set(conversationId, cc);
  if (conversationContents.size > MAX_CONTENT_CONVS) {
    const oldest = [...conversationContents.values()].sort((a, b) => a.lastUpdatedAt - b.lastUpdatedAt)[0];
    if (oldest) conversationContents.delete(oldest.conversationId);
  }
  return cc;
}

function truncateBlock(text: string): string {
  if (text.length <= MAX_CONTENT_TEXT) return text;
  return text.slice(0, MAX_CONTENT_TEXT) + `\n…[truncated ${(text.length - MAX_CONTENT_TEXT).toLocaleString()} chars]`;
}

function extractBlocksFromContent(content: unknown): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  if (typeof content === 'string') {
    blocks.push({ type: 'text', text: truncateBlock(content) });
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (!block?.type) continue;
      if (block.type === 'text') {
        blocks.push({ type: 'text', text: truncateBlock(block.text || '') });
      } else if (block.type === 'tool_use') {
        blocks.push({ type: 'tool_use', id: block.id || '', name: block.name || '', input: block.input ?? {} });
      } else if (block.type === 'tool_result') {
        let resultText = '';
        if (typeof block.content === 'string') {
          resultText = truncateBlock(block.content);
        } else if (Array.isArray(block.content)) {
          resultText = truncateBlock(
            block.content.filter((b: any) => b.type === 'text').map((b: any) => b.text || '').join('\n')
          );
        }
        blocks.push({ type: 'tool_result', tool_use_id: block.tool_use_id || '', content: resultText, is_error: !!block.is_error });
      } else if (block.type === 'image') {
        // Don't embed base64 data — return source type + media_type only
        const src = block.source || {};
        blocks.push({ type: 'image', source: src.type === 'base64'
          ? { type: 'base64', media_type: src.media_type, data: '[base64 omitted]' }
          : src });
      } else {
        blocks.push({ type: block.type, ...block });
      }
    }
  }
  return blocks;
}

function extractMessagesFromBody(json: any, now: number): ConversationMessage[] {
  if (!Array.isArray(json.messages)) return [];
  return json.messages.map((msg: any) => ({
    role: msg.role as 'user' | 'assistant',
    content: extractBlocksFromContent(msg.content),
    timestamp: now,
  }));
}

/** Parse accumulated SSE text into assistant content blocks + metadata */
function parseSSEBlocks(text: string): { blocks: ContentBlock[]; stopReason: string; outputTokens: number } {
  const blocks: ContentBlock[] = [];
  let currentBlock: any = null;
  let jsonAccum = '';
  let stopReason = '';
  let outputTokens = 0;
  const dataRe = /^data: (.+)$/gm;
  let m;
  while ((m = dataRe.exec(text)) !== null) {
    try {
      const ev = JSON.parse(m[1]);
      if (ev.type === 'content_block_start') {
        const b = ev.content_block;
        if (b.type === 'text') { currentBlock = { type: 'text', text: '' }; jsonAccum = ''; }
        else if (b.type === 'tool_use') { currentBlock = { type: 'tool_use', id: b.id || '', name: b.name || '', input: {} }; jsonAccum = ''; }
        else { currentBlock = { ...b }; jsonAccum = ''; }
      } else if (ev.type === 'content_block_delta' && currentBlock) {
        if (ev.delta?.type === 'text_delta') currentBlock.text = (currentBlock.text || '') + (ev.delta.text || '');
        else if (ev.delta?.type === 'input_json_delta') jsonAccum += ev.delta.partial_json || '';
      } else if (ev.type === 'content_block_stop' && currentBlock) {
        if (currentBlock.type === 'tool_use' && jsonAccum) {
          try { currentBlock.input = JSON.parse(jsonAccum); } catch { currentBlock.input = jsonAccum; }
        }
        if (currentBlock.type === 'text') currentBlock.text = truncateBlock(currentBlock.text || '');
        blocks.push(currentBlock);
        currentBlock = null; jsonAccum = '';
      } else if (ev.type === 'message_delta') {
        if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
        if (ev.usage?.output_tokens) outputTokens = ev.usage.output_tokens;
      }
    } catch { /* malformed SSE line — skip */ }
  }
  return { blocks, stopReason, outputTokens };
}

function broadcastContentEvent(conversationId: string, eventData: object) {
  const clients = contentSseClients.get(conversationId);
  if (!clients?.size) return;
  const payload = `data: ${JSON.stringify(eventData)}\n\n`;
  for (const client of clients) {
    try { client.write(payload); } catch { clients.delete(client); }
  }
}

// ── Rate limit event tracking ───────────────────────────────────────────────

interface RateLimitEvent {
  timestamp: number;
  type: 'queued' | '429' | 'rejected' | 'threshold_crossed';
  model?: string;
  utilization5h: number;
  utilization7d: number;
  remainingRequests: number;
  remainingTokens: number;
  queueDepth: number;
  triggerReason: string;
}

const rateLimitEvents: RateLimitEvent[] = [];
const MAX_EVENTS = 500;

function recordRateLimitEvent(type: RateLimitEvent['type'], reason: string, model?: string) {
  const event: RateLimitEvent = {
    timestamp: Date.now(),
    type,
    model,
    utilization5h: state.fiveHour.utilization,
    utilization7d: state.sevenDay.utilization,
    remainingRequests: state.requests.remaining === Infinity ? -1 : state.requests.remaining,
    remainingTokens: state.tokens.remaining === Infinity ? -1 : state.tokens.remaining,
    queueDepth: queue.length,
    triggerReason: reason,
  };
  rateLimitEvents.push(event);
  if (rateLimitEvents.length > MAX_EVENTS) rateLimitEvents.shift();
}

const recentRequests: RequestLog[] = [];
const MAX_REQUEST_LOG = 200;

// ── Session & Conversation tracking ────────────────────────────────────────
// Aligned with session-types.ts: uses real session UUID from metadata.user_id,
// proper Turn/Conversation/Session hierarchy, smart conversation boundaries.

import { SESSION_INACTIVITY_MS, CONVERSATION_INACTIVITY_MS } from './session-types.js';
import type { Session, Conversation, Turn, UserMetadata, BillingHeader } from './session-types.js';

/** Session extended with internal boundary-detection state (never serialised) */
interface SessionTracked extends Session {
  _lastMessageCount: number;
  _lastContextHash: string;
  _currentConvIndex: number;
}

const sessions = new Map<string, SessionTracked>();
const conversationIndex = new Map<string, Conversation>();
const MAX_SESSIONS = 200;
const MAX_TURNS_PER_CONV = 500;

// SSE clients listening for real-time session/conversation updates
const sseClients = new Set<ServerResponse>();

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ── Request metadata extraction ─────────────────────────────────────────────

interface RequestMeta {
  sessionId: string;
  deviceId: string;
  accountUuid: string;
  ccVersion: string;
  ccEntrypoint: string;
  contextHash: string;
  messageCount: number;
  lastUserMessage: string;
  lastAssistantResponse: string;
}

function extractRequestMeta(body: Buffer): RequestMeta {
  const meta: RequestMeta = {
    sessionId: '', deviceId: '', accountUuid: '',
    ccVersion: '', ccEntrypoint: '', contextHash: '',
    messageCount: 0, lastUserMessage: '', lastAssistantResponse: '',
  };
  try {
    const json = JSON.parse(body.toString());

    // metadata.user_id → session/device/account IDs
    if (json.metadata?.user_id) {
      try {
        const uid: UserMetadata = JSON.parse(json.metadata.user_id);
        meta.sessionId   = uid.session_id   || '';
        meta.deviceId    = uid.device_id    || '';
        meta.accountUuid = uid.account_uuid || '';
      } catch { /* user_id not JSON — ok */ }
    }

    // system[0] billing header → cc_version, cc_entrypoint, cch
    const sysBlocks = Array.isArray(json.system) ? json.system : [];
    for (const block of sysBlocks) {
      const text: string = block?.text || '';
      if (!text.includes('cc_version')) continue;
      meta.ccVersion    = (text.match(/cc_version=([^;]+)/)    || [])[1]?.trim() || '';
      meta.ccEntrypoint = (text.match(/cc_entrypoint=([^;]+)/) || [])[1]?.trim() || '';
      meta.contextHash  = (text.match(/cch=([^;]+)/)           || [])[1]?.trim() || '';
      break;
    }

    // messages → count + previews
    if (Array.isArray(json.messages)) {
      meta.messageCount = json.messages.length;
      const textOf = (c: any): string => {
        if (typeof c === 'string') return c;
        if (Array.isArray(c)) return c.filter((b: any) => b.type === 'text').map((b: any) => b.text || '').join(' ');
        return '';
      };
      for (let i = json.messages.length - 1; i >= 0; i--) {
        const msg = json.messages[i];
        if (!meta.lastUserMessage && msg.role === 'user') meta.lastUserMessage = textOf(msg.content).slice(0, 300);
        if (!meta.lastAssistantResponse && msg.role === 'assistant') meta.lastAssistantResponse = textOf(msg.content).slice(0, 300);
        if (meta.lastUserMessage && meta.lastAssistantResponse) break;
      }
    }
  } catch { /* parse failure — return empty meta */ }
  return meta;
}

// ── Session / Conversation helpers ──────────────────────────────────────────

function getOrCreateSession(meta: RequestMeta, now: number): SessionTracked {
  const id = meta.sessionId || generateId();
  if (sessions.has(id)) return sessions.get(id)!;

  const session: SessionTracked = {
    id, deviceId: meta.deviceId, accountUuid: meta.accountUuid,
    entrypoint: meta.ccEntrypoint, ccVersion: meta.ccVersion,
    startedAt: now, lastActivityAt: now, durationMs: 0,
    conversations: [], conversationCount: 0, totalRequests: 0,
    totalInputTokens: 0, totalOutputTokens: 0,
    totalCacheRead: 0, totalCacheCreation: 0, totalTokensSaved: 0,
    models: [], isActive: true,
    _lastMessageCount: 0, _lastContextHash: '', _currentConvIndex: -1,
  };
  sessions.set(id, session);

  if (sessions.size > MAX_SESSIONS) {
    const oldest = [...sessions.values()].sort((a, b) => a.lastActivityAt - b.lastActivityAt)[0];
    if (oldest) sessions.delete(oldest.id);
  }
  log('info', `🗂 New session: ${id.slice(0, 8)}… entry=${meta.ccEntrypoint} v=${meta.ccVersion}`);
  return session;
}

function getOrCreateConversation(session: SessionTracked, meta: RequestMeta, now: number): Conversation {
  const last = session.conversations[session.conversations.length - 1];
  const isNew = !last
    || meta.messageCount <= session._lastMessageCount               // history reset (/clear or new task)
    || (meta.contextHash !== '' && meta.contextHash !== session._lastContextHash && session._lastContextHash !== '') // cch changed
    || (now - session.lastActivityAt) > CONVERSATION_INACTIVITY_MS; // >5-min gap

  if (!isNew) return last;

  const idx = session._currentConvIndex + 1;
  const conv: Conversation = {
    id: `${session.id}-conv-${idx}`, sessionId: session.id,
    conversationIndex: idx, startedAt: now, lastActivityAt: now,
    turns: [], turnCount: 0, initialContextHash: meta.contextHash,
    totalInputTokens: 0, totalOutputTokens: 0,
    totalCacheRead: 0, totalCacheCreation: 0,
    totalTokensSaved: 0, totalLatencyMs: 0,
    models: [], isActive: true,
  };
  session.conversations.push(conv);
  session._currentConvIndex = idx;
  session.conversationCount = session.conversations.length;
  conversationIndex.set(conv.id, conv);
  return conv;
}

function serializeSession(s: Session) {
  return {
    id: s.id, deviceId: s.deviceId, accountUuid: s.accountUuid,
    entrypoint: s.entrypoint, ccVersion: s.ccVersion,
    startedAt: s.startedAt, lastActivityAt: s.lastActivityAt, durationMs: s.durationMs,
    conversationCount: s.conversationCount, totalRequests: s.totalRequests,
    totalInputTokens: s.totalInputTokens, totalOutputTokens: s.totalOutputTokens,
    totalCacheRead: s.totalCacheRead, totalCacheCreation: s.totalCacheCreation,
    totalTokensSaved: s.totalTokensSaved, models: s.models, isActive: s.isActive,
  };
}

// ── Main recording function ─────────────────────────────────────────────────

function recordConversation(entry: RequestLog, meta: RequestMeta) {
  if (!entry.path.includes('/messages')) return;
  const now = entry.timestamp;
  const session = getOrCreateSession(meta, now);
  const conv = getOrCreateConversation(session, meta, now);

  const turnIndex = Math.floor(Math.max(0, meta.messageCount - 1) / 2);
  const turn: Turn = {
    id: `${conv.id}-t${turnIndex}`,
    conversationId: conv.id, sessionId: session.id,
    turnIndex, timestamp: now, logFile: '',
    model: entry.model || 'unknown',
    messageHistoryLength: meta.messageCount,
    contextHash: meta.contextHash,
    inputTokens: entry.inputTokens, outputTokens: entry.outputTokens,
    cacheRead: entry.cacheRead, cacheCreation: entry.cacheCreation,
    tokensSaved: entry.tokensSaved,
    latencyMs: entry.latencyMs, statusCode: entry.statusCode, streaming: entry.streaming,
  };

  if (conv.turns.length < MAX_TURNS_PER_CONV) conv.turns.push(turn);
  conv.turnCount = conv.turns.length;
  conv.lastActivityAt = now;
  conv.totalInputTokens  += entry.inputTokens  || 0;
  conv.totalOutputTokens += entry.outputTokens || 0;
  conv.totalCacheRead    += entry.cacheRead    || 0;
  conv.totalCacheCreation += entry.cacheCreation || 0;
  conv.totalTokensSaved  += entry.tokensSaved  || 0;
  conv.totalLatencyMs    += entry.latencyMs    || 0;
  if (entry.model && !conv.models.includes(entry.model)) conv.models.push(entry.model);
  conv.isActive = (Date.now() - conv.lastActivityAt) < CONVERSATION_INACTIVITY_MS;

  session.lastActivityAt = now;
  session.durationMs = now - session.startedAt;
  session.totalRequests++;
  session.totalInputTokens  += entry.inputTokens  || 0;
  session.totalOutputTokens += entry.outputTokens || 0;
  session.totalCacheRead    += entry.cacheRead    || 0;
  session.totalCacheCreation += entry.cacheCreation || 0;
  session.totalTokensSaved  += entry.tokensSaved  || 0;
  if (entry.model && !session.models.includes(entry.model)) session.models.push(entry.model);
  session.isActive = (Date.now() - session.lastActivityAt) < SESSION_INACTIVITY_MS;
  session._lastMessageCount = meta.messageCount;
  session._lastContextHash  = meta.contextHash;

  if (sseClients.size > 0) {
    const payload = JSON.stringify({
      type: 'turn', turn,
      conversation: { ...conv, turns: undefined },
      session: serializeSession(session),
    });
    for (const client of sseClients) {
      try { client.write(`data: ${payload}\n\n`); } catch { sseClients.delete(client); }
    }
  }
}

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

    // Extract conversation ID from billing header
    let conversationId: string | undefined;
    let taskDescription: string | undefined;
    if (Array.isArray(json.system)) {
      for (const block of json.system) {
        const text = block.text || '';
        const cchMatch = text.match(/cch=([a-zA-Z0-9]+)/);
        if (cchMatch) conversationId = cchMatch[1];
        // Short non-billing blocks may be task descriptions
        if (text.length > 10 && text.length < 500 &&
            !text.includes('billing-header') && !text.includes('You are Claude') &&
            !text.includes('interactive agent') && !text.includes('Claude agent')) {
          taskDescription = text.slice(0, 100);
        }
      }
    }
    if (conversationId) info.conversationId = conversationId;
    if (taskDescription) info.taskDescription = taskDescription;

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

function analyzeResponseText(text: string): Partial<RequestLog> {
  const info: Partial<RequestLog> = {};

  try {
    // Non-streaming: single JSON response
    const json = JSON.parse(text);
    return extractUsage(json);
  } catch {
    // Streaming SSE: find all "data: {json}" lines using regex
    // This handles any chunking/fragmentation since we have the full text
    const dataRegex = /^data: (.+)$/gm;
    let match;
    while ((match = dataRegex.exec(text)) !== null) {
      try {
        const parsed = JSON.parse(match[1]);
        if (parsed.type === 'message_start' && parsed.message?.usage) {
          info.inputTokens = parsed.message.usage.input_tokens;
          if (parsed.message.usage.cache_read_input_tokens) info.cacheRead = parsed.message.usage.cache_read_input_tokens;
          if (parsed.message.usage.cache_creation_input_tokens) info.cacheCreation = parsed.message.usage.cache_creation_input_tokens;
          log('debug', `📊 SSE message_start: in=${info.inputTokens} cache_read=${info.cacheRead || 0} cache_create=${info.cacheCreation || 0}`);
        }
        if (parsed.type === 'message_delta' && parsed.usage) {
          info.outputTokens = parsed.usage.output_tokens;
          log('debug', `📊 SSE message_delta: out=${info.outputTokens}`);
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
    // Forward accept-encoding as-is — we decompress server-side for token parsing
    if (value) headers[key] = Array.isArray(value) ? value.join(', ') : value;
  }
  headers['host'] = upstream.host;

  const startTime = Date.now();
  const originalSize = body.length;
  const reqInfo = analyzeRequestBody(body, path);
  const entry: RequestLog = { timestamp: startTime, method: req.method || 'POST', path, ...reqInfo, originalSize };

  // Capture session/conversation metadata before rewriting (rewrite may strip content)
  const reqMeta = extractRequestMeta(body);

  // ── Content capture: extract full messages before rewrite strips them ──────
  let capturedConvId: string | undefined;
  let capturedMessages: ConversationMessage[] | undefined;
  if (path.includes('/messages')) {
    try {
      const rawJson = JSON.parse(body.toString());
      capturedConvId = reqInfo.conversationId;
      if (capturedConvId) {
        capturedMessages = extractMessagesFromBody(rawJson, startTime);
        const cc = getOrCreateConvContent(capturedConvId);
        // Replace stored messages with full history snapshot from this request
        // (Anthropic resends full history each turn, so latest = complete history)
        if (capturedMessages.length > 0) {
          cc.messages = capturedMessages.slice(-MAX_CONTENT_MESSAGES);
          cc.isStreaming = rawJson.stream === true;
          cc.streamingBlocks = [];
          cc.lastUpdatedAt = startTime;
          broadcastContentEvent(capturedConvId, { type: 'request_start', conversationId: capturedConvId, messageCount: capturedMessages.length, isStreaming: cc.isStreaming });
        }
      }
    } catch { /* parse failure — skip content capture */ }
  }

  // Rewrite request — strip system prompt bloat + useless tools
  body = rewriteRequest(body);
  headers['content-length'] = String(body.length);
  entry.strippedSize = body.length;
  entry.tokensSaved = Math.round((originalSize - body.length) / 4);

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
        recordRateLimitEvent('429', `Upstream 429, retry-after=${retryAfter}s, 5h=${(state.fiveHour.utilization*100).toFixed(0)}%`, entry.model);

        if (retryAfter) {
          const resetMs = Date.now() + parseFloat(retryAfter) * 1000;
          state.fiveHour.reset = Math.max(state.fiveHour.reset, resetMs);
          state.fiveHour.utilization = 1.0;
          state.overall = 'rejected';
        }
      }

      state.totalForwarded++;
      entry.statusCode = proxyRes.statusCode;

      // Forward status + headers to client (original encoding preserved)
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);

      // Decompress for token parsing while forwarding original stream to client.
      // Client gets the compressed stream (fast), proxy reads decompressed for analysis.
      let responseText = '';
      const encoding = proxyRes.headers['content-encoding'];
      let decompressor: Transform | null = null;
      if (encoding === 'gzip') decompressor = createGunzip();
      else if (encoding === 'br') decompressor = createBrotliDecompress();
      else if (encoding === 'deflate') decompressor = createInflate();

      if (decompressor) {
        // Pipe to client AND decompress in parallel
        proxyRes.on('data', (chunk: Buffer) => {
          res.write(chunk); // forward compressed to client
          decompressor!.write(chunk); // decompress for parsing
        });
        decompressor.on('data', (chunk: Buffer) => {
          responseText += chunk.toString();
        });
      } else {
        // No compression — read directly
        proxyRes.on('data', (chunk: Buffer) => {
          responseText += chunk.toString();
          res.write(chunk);
        });
      }

      proxyRes.on('end', () => {
        if (decompressor) decompressor.end();
        res.end();
        entry.latencyMs = Date.now() - startTime;

        // Wait for decompressor to flush, then parse
        const finalize = () => {
          const resInfo = analyzeResponseText(responseText);
          Object.assign(entry, resInfo);

          recentRequests.push(entry);
          if (recentRequests.length > MAX_REQUEST_LOG) recentRequests.shift();

          // ── Capture assistant response content ────────────────────────────
          if (capturedConvId && entry.statusCode && entry.statusCode < 400) {
            const { blocks, stopReason } = parseSSEBlocks(responseText);
            const cc = getOrCreateConvContent(capturedConvId);
            if (blocks.length > 0) {
              const assistantMsg: ConversationMessage = {
                role: 'assistant',
                content: blocks,
                timestamp: startTime + (entry.latencyMs || 0),
                model: entry.model,
                latencyMs: entry.latencyMs,
                inputTokens: entry.inputTokens,
                outputTokens: entry.outputTokens,
                cacheRead: entry.cacheRead,
                cacheCreation: entry.cacheCreation,
                stopReason,
              };
              // Append to the stored messages (user messages already stored above)
              cc.messages.push(assistantMsg);
              if (cc.messages.length > MAX_CONTENT_MESSAGES) cc.messages = cc.messages.slice(-MAX_CONTENT_MESSAGES);
            }
            cc.isStreaming = false;
            cc.streamingBlocks = [];
            cc.lastUpdatedAt = Date.now();
            broadcastContentEvent(capturedConvId, { type: 'response_complete', conversationId: capturedConvId, blockCount: blocks.length, stopReason, model: entry.model });
          }

          // Update cch-based sessions store
          if (entry.conversationId) {
            const sid = entry.conversationId;
            if (!cchSessions.has(sid)) {
              cchSessions.set(sid, {
                id: sid,
                firstSeen: entry.timestamp,
                lastSeen: entry.timestamp,
                model: entry.model || 'unknown',
                requestCount: 0,
                totalInputTokens: 0,
                totalOutputTokens: 0,
                totalCacheRead: 0,
                totalCacheCreation: 0,
                totalLatencyMs: 0,
                taskDescription: entry.taskDescription,
                requests: [],
              });
              if (cchSessions.size > MAX_CCH_SESSIONS) {
                const oldest = cchSessions.keys().next().value;
                if (oldest) cchSessions.delete(oldest);
              }
            }
            const cchSession = cchSessions.get(sid)!;
            cchSession.lastSeen = entry.timestamp;
            cchSession.requestCount++;
            cchSession.totalInputTokens += entry.inputTokens || 0;
            cchSession.totalOutputTokens += entry.outputTokens || 0;
            cchSession.totalCacheRead += entry.cacheRead || 0;
            cchSession.totalCacheCreation += entry.cacheCreation || 0;
            cchSession.totalLatencyMs += entry.latencyMs || 0;
            if (!cchSession.taskDescription && entry.taskDescription) cchSession.taskDescription = entry.taskDescription;
            cchSession.requests.push({ ...entry });
            if (cchSession.requests.length > 200) cchSession.requests.shift();
          }

          recordConversation(entry, reqMeta);

          const model = entry.model || '?';
          const tokens = entry.inputTokens || entry.outputTokens
            ? `in=${entry.inputTokens || '?'} out=${entry.outputTokens || '?'}${entry.cacheRead ? ` cache_read=${entry.cacheRead}` : ''}${entry.cacheCreation ? ` cache_create=${entry.cacheCreation}` : ''}`
            : '';
          log('info', `📡 ${path} ${model} ${entry.latencyMs}ms ${tokens}`);

          if (queue.length > 0) drainQueue();
        };

        if (decompressor) {
          decompressor.on('end', finalize);
        } else {
          finalize();
        }
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

  // Dashboard
  if ((path === '/' || path === '/dashboard') && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(DASHBOARD_HTML);
    return;
  }

  // Health endpoint
  if (path === '/health' && req.method === 'GET') {
    const active = getActiveWindow();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      status: state.overall || 'unknown',
      stripEnabled: STRIP_ENABLED,
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

  // Rate limit events
  if (path === '/events' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(rateLimitEvents.slice(-100).reverse()));
    return;
  }

  // ── Session API ─────────────────────────────────────────────────────────────

  // SSE stream — real-time session/conversation updates
  if (path === '/sessions/stream' && req.method === 'GET') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
      'access-control-allow-origin': '*',
    });
    res.write('data: {"type":"connected"}\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // ── CCH Sessions API — cch-keyed sessions from billing headers ──────────────
  const pathname = path.split('?')[0];
  if (pathname === '/cch-sessions' && req.method === 'GET') {
    const sessionList = Array.from(cchSessions.values())
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .map(s => ({
        id: s.id,
        firstSeen: new Date(s.firstSeen).toISOString(),
        lastSeen: new Date(s.lastSeen).toISOString(),
        model: s.model,
        requestCount: s.requestCount,
        totalInputTokens: s.totalInputTokens,
        totalOutputTokens: s.totalOutputTokens,
        totalCacheRead: s.totalCacheRead,
        totalCacheCreation: s.totalCacheCreation,
        avgLatencyMs: s.requestCount > 0 ? Math.round(s.totalLatencyMs / s.requestCount) : 0,
        taskDescription: s.taskDescription,
        durationMs: s.lastSeen - s.firstSeen,
      }));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(sessionList));
    return;
  }

  if (path.startsWith('/cch-sessions/') && req.method === 'GET') {
    const sid = decodeURIComponent(path.slice('/cch-sessions/'.length));
    const session = cchSessions.get(sid);
    if (!session) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'session not found' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: session.id,
      firstSeen: new Date(session.firstSeen).toISOString(),
      lastSeen: new Date(session.lastSeen).toISOString(),
      model: session.model,
      requestCount: session.requestCount,
      taskDescription: session.taskDescription,
      requests: session.requests.map(r => ({ ...r, timestamp: new Date(r.timestamp).toISOString() })),
    }));
    return;
  }

  // ── Session API (/sessions, /sessions/:id, /sessions/:id/conversations, /conversations/:id)

  // GET /sessions[?offset=N&limit=N&model=X&since=<epochMs>&active=true]
  if (pathname === '/sessions' && req.method === 'GET') {
    const urlObj = new URL(path, `http://localhost`);
    const offset = Math.max(0, parseInt(urlObj.searchParams.get('offset') || '0', 10));
    const limit  = Math.min(100, Math.max(1, parseInt(urlObj.searchParams.get('limit') || '20', 10)));
    const modelFilter  = urlObj.searchParams.get('model');
    const since        = urlObj.searchParams.get('since') ? parseInt(urlObj.searchParams.get('since')!, 10) : 0;
    const activeOnly   = urlObj.searchParams.get('active') === 'true';
    const now = Date.now();

    let list = [...sessions.values()]
      .map(s => ({ ...s, isActive: (now - s.lastActivityAt) < SESSION_INACTIVITY_MS }))
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    if (modelFilter)  list = list.filter(s => s.models.some(m => m.includes(modelFilter)));
    if (since)        list = list.filter(s => s.lastActivityAt >= since);
    if (activeOnly)   list = list.filter(s => s.isActive);

    const total = list.length;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ total, offset, limit, sessions: list.slice(offset, offset + limit).map(serializeSession) }));
    return;
  }

  // GET /sessions/:id  or  GET /sessions/:id/conversations
  const sessionRouteMatch = pathname.match(/^\/sessions\/([^/]+)(\/conversations)?$/);
  if (sessionRouteMatch && req.method === 'GET') {
    const sessionId = decodeURIComponent(sessionRouteMatch[1]);
    const wantsConvList = !!sessionRouteMatch[2];
    const session = sessions.get(sessionId);
    if (!session) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'session_not_found', id: sessionId }));
      return;
    }
    if (wantsConvList) {
      const urlObj = new URL(path, `http://localhost`);
      const offset = Math.max(0, parseInt(urlObj.searchParams.get('offset') || '0', 10));
      const limit  = Math.min(100, Math.max(1, parseInt(urlObj.searchParams.get('limit') || '20', 10)));
      const convList = session.conversations;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ sessionId, total: convList.length, offset, limit, conversations: convList.slice(offset, offset + limit) }));
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ...serializeSession(session), conversations: session.conversations }));
    }
    return;
  }

  // GET /conversations/:id  — single conversation with all turns (+optional message preview)
  const convRouteMatch = pathname.match(/^\/conversations\/([^/]+)$/);
  if (convRouteMatch && req.method === 'GET') {
    const convId = decodeURIComponent(convRouteMatch[1]);
    const conv = conversationIndex.get(convId);
    if (!conv) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'conversation_not_found', id: convRouteMatch[1] }));
      return;
    }
    const urlParams = new URL(path, 'http://localhost').searchParams;
    const includeMessages = urlParams.get('messages') === 'true';
    const result: any = { ...conv };
    if (includeMessages) {
      const cc = conversationContents.get(convId);
      if (cc) {
        result.content = {
          messageCount: cc.messages.length,
          isStreaming: cc.isStreaming,
          lastUpdatedAt: new Date(cc.lastUpdatedAt).toISOString(),
          // Preview: last 2 messages (user prompt + assistant response)
          preview: cc.messages.slice(-2).map(m => ({
            role: m.role,
            model: m.model,
            timestamp: new Date(m.timestamp).toISOString(),
            blockCount: m.content.length,
            textPreview: m.content.filter(b => b.type === 'text').map(b => (b as any).text || '').join('').slice(0, 500),
            toolCalls: m.content.filter(b => b.type === 'tool_use').map(b => ({ name: (b as any).name, id: (b as any).id })),
            stopReason: m.stopReason,
            inputTokens: m.inputTokens,
            outputTokens: m.outputTokens,
          })),
        };
      }
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  // GET /conversations/:id/messages  — full message content for a conversation
  const convMessagesMatch = pathname.match(/^\/conversations\/([^/]+)\/messages$/);
  if (convMessagesMatch && req.method === 'GET') {
    const convId = decodeURIComponent(convMessagesMatch[1]);
    const urlParams = new URL(path, 'http://localhost').searchParams;
    const offset = Math.max(0, parseInt(urlParams.get('offset') || '0', 10));
    const limit  = Math.min(200, Math.max(1, parseInt(urlParams.get('limit') || '50', 10)));
    const rolesFilter = urlParams.get('roles');  // e.g. "user,assistant"
    const typesFilter = urlParams.get('types');  // e.g. "text,tool_use"

    const cc = conversationContents.get(convId);
    if (!cc) {
      // No content captured — check if conversation exists at all
      const convExists = conversationIndex.has(convId);
      res.writeHead(convExists ? 200 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify(convExists
        ? { conversationId: convId, total: 0, offset: 0, limit, isStreaming: false, messages: [], note: 'No content captured yet — messages are recorded as requests arrive.' }
        : { error: 'conversation_not_found', id: convId }
      ));
      return;
    }

    let msgs = cc.messages;
    if (rolesFilter) {
      const roles = new Set(rolesFilter.split(','));
      msgs = msgs.filter(m => roles.has(m.role));
    }

    // Optionally filter content blocks by type
    const typeSet = typesFilter ? new Set(typesFilter.split(',')) : null;
    const formatted = msgs.slice(offset, offset + limit).map(m => ({
      role: m.role,
      timestamp: new Date(m.timestamp).toISOString(),
      model: m.model,
      latencyMs: m.latencyMs,
      inputTokens: m.inputTokens,
      outputTokens: m.outputTokens,
      cacheRead: m.cacheRead,
      cacheCreation: m.cacheCreation,
      stopReason: m.stopReason,
      content: typeSet ? m.content.filter(b => typeSet.has(b.type)) : m.content,
    }));

    res.writeHead(200, {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
    });
    res.end(JSON.stringify({
      conversationId: convId,
      total: msgs.length,
      offset,
      limit,
      isStreaming: cc.isStreaming,
      streamingBlocks: cc.isStreaming ? cc.streamingBlocks : undefined,
      lastUpdatedAt: new Date(cc.lastUpdatedAt).toISOString(),
      messages: formatted,
    }));
    return;
  }

  // GET /conversations/:id/messages/stream  — SSE for real-time content updates
  const convStreamMatch = pathname.match(/^\/conversations\/([^/]+)\/messages\/stream$/);
  if (convStreamMatch && req.method === 'GET') {
    const convId = decodeURIComponent(convStreamMatch[1]);
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
      'access-control-allow-origin': '*',
    });

    // Send current state snapshot on connect
    const cc = conversationContents.get(convId);
    const snapshot = {
      type: 'snapshot',
      conversationId: convId,
      messageCount: cc?.messages.length ?? 0,
      isStreaming: cc?.isStreaming ?? false,
      lastUpdatedAt: cc ? new Date(cc.lastUpdatedAt).toISOString() : null,
    };
    res.write(`data: ${JSON.stringify(snapshot)}\n\n`);

    // Register SSE client
    if (!contentSseClients.has(convId)) contentSseClients.set(convId, new Set());
    contentSseClients.get(convId)!.add(res);

    req.on('close', () => {
      const clients = contentSseClients.get(convId);
      if (clients) {
        clients.delete(res);
        if (clients.size === 0) contentSseClients.delete(convId);
      }
    });
    return;
  }

  // GET /content  — list all conversations with captured content
  if (pathname === '/content' && req.method === 'GET') {
    const urlParams = new URL(path, 'http://localhost').searchParams;
    const limit = Math.min(100, Math.max(1, parseInt(urlParams.get('limit') || '20', 10)));
    const summary = [...conversationContents.values()]
      .sort((a, b) => b.lastUpdatedAt - a.lastUpdatedAt)
      .slice(0, limit)
      .map(cc => {
        const lastMsg = cc.messages[cc.messages.length - 1];
        const firstUserMsg = cc.messages.find(m => m.role === 'user');
        const promptPreview = firstUserMsg?.content
          .filter(b => b.type === 'text')
          .map(b => (b as any).text || '').join('').slice(0, 200) || '';
        return {
          conversationId: cc.conversationId,
          messageCount: cc.messages.length,
          isStreaming: cc.isStreaming,
          lastUpdatedAt: new Date(cc.lastUpdatedAt).toISOString(),
          lastModel: lastMsg?.model,
          promptPreview,
          // Include conversation metadata if we have it
          conversationMeta: conversationIndex.has(cc.conversationId) ? (() => {
            const c = conversationIndex.get(cc.conversationId)!;
            return { turnCount: c.turnCount, totalInputTokens: c.totalInputTokens, totalOutputTokens: c.totalOutputTokens };
          })() : undefined,
        };
      });
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify({ total: conversationContents.size, limit, conversations: summary }));
    return;
  }

  // Config toggle (runtime strip on/off)
  if (path === '/config' && req.method === 'POST') {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        if (body.strip === 'toggle') STRIP_ENABLED = !STRIP_ENABLED;
        else if (body.strip === true || body.strip === 'on') STRIP_ENABLED = true;
        else if (body.strip === false || body.strip === 'off') STRIP_ENABLED = false;
        if (body.threshold !== undefined) (globalThis as any).__QUEUE_THRESHOLD = parseFloat(body.threshold);
        log('info', `⚙️ Config updated: strip=${STRIP_ENABLED}`);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ stripEnabled: STRIP_ENABLED }));
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid json' }));
      }
    });
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
        // Extract model from body for tracking
        try { const j = JSON.parse(body.toString()); recordRateLimitEvent('rejected', `Queue full (${MAX_QUEUE}), 5h=${(state.fiveHour.utilization*100).toFixed(0)}%`, j.model); } catch { recordRateLimitEvent('rejected', `Queue full (${MAX_QUEUE})`); }
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
      const reason = state.overall === 'rejected'
        ? `Anthropic rejected, 5h=${(state.fiveHour.utilization*100).toFixed(0)}%`
        : state.requests.remaining <= 2
          ? `RPM exhausted (${state.requests.remaining}/${state.requests.limit})`
          : `5h utilization ${(active.utilization*100).toFixed(0)}% > ${(THRESHOLD*100).toFixed(0)}% threshold`;
      try { const j = JSON.parse(body.toString()); recordRateLimitEvent('queued', reason, j.model); } catch { recordRateLimitEvent('queued', reason); }
      log('info', `⏸ Queuing request (${reason}, ${queue.length + 1} in queue)`);
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
