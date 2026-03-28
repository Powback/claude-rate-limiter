# claude-rate-limiter

Rate-limit-aware reverse proxy for the Anthropic API. Strips bloat from Claude Code's default system prompt, queues requests when approaching limits, and provides a live dashboard.

**Saves ~21K tokens per request (83% reduction) and prevents 429 errors in multi-agent setups.**

## The Problem

Claude Code sends ~31K tokens of overhead with every API request:
- 51K char system prompt (auto memory instructions, git commit rules, tool docs nobody reads)
- 23 tool definitions when agents only need ~10
- Each tool has 1-10K chars of description

With 6 concurrent agents making ~1 turn/min, that's **1.8M wasted tokens/hour** (~$27/hr for Opus).

Anthropic's unified rate limiter uses a 5-hour utilization window. Once you hit ~85%, all requests get rejected until the window resets.

## The Solution

A transparent reverse proxy that sits between Claude CLI and `api.anthropic.com`:

```
Claude CLI --HTTP--> rate-limiter:3128 --HTTPS--> api.anthropic.com
                         |
                    ✂️ Strips 83% of request bloat
                    📊 Reads rate limit headers
                    ⏳ Queues when near limit
                    📈 Live dashboard
```

## Quick Start

```bash
# Standalone
npx tsx src/index.ts
# Then run Claude through it:
ANTHROPIC_BASE_URL=http://localhost:3128 claude ...

# Docker
docker compose up -d
ANTHROPIC_BASE_URL=http://localhost:3128 claude ...
```

Dashboard at `http://localhost:3128/`

## What It Does

### 1. Request Stripping (83% reduction)

| Component | Before | After | Saved |
|-----------|--------|-------|-------|
| System prompt | 51K chars | 933 chars | 98% |
| Tool definitions | 70K chars (23 tools) | 12K chars (10 tools) | 83% |
| Tool descriptions | 45K chars | 2K chars | 96% |
| **Total per request** | **~123K chars (~31K tokens)** | **~18K chars (~4.5K tokens)** | **83%** |

**Detection is size-based, not content-based** — any system prompt block over 3K chars gets replaced with a minimal version. Works regardless of Anthropic changing their default prompt.

What gets stripped:
- Auto memory instructions (38K chars) — agents don't persist memories
- Git commit formatting rules (10K chars in Bash tool) — agents rarely commit
- TodoWrite (9K chars), EnterPlanMode (4K), CronCreate/Delete/List, NotebookEdit, etc.
- Verbose tool descriptions replaced with 1-3 line versions

What's preserved:
- Billing headers (required by Anthropic)
- User/app system prompts (< 3K chars)
- Persona prompts
- Essential tools: Bash, Read, Edit, Write, Glob, Grep, Agent, Skill, WebSearch, WebFetch

### 2. Rate Limit Tracking

Reads Anthropic's actual response headers:

```
anthropic-ratelimit-unified-status: allowed | rejected
anthropic-ratelimit-unified-5h-utilization: 0.0–1.0
anthropic-ratelimit-unified-5h-reset: <epoch seconds>
anthropic-ratelimit-unified-7d-utilization: 0.0–1.0
anthropic-ratelimit-unified-7d-reset: <epoch seconds>
```

Also tracks per-minute RPM/TPM headers when present.

### 3. Request Queuing

When utilization exceeds threshold (default 85%), requests are held in a FIFO queue and released one at a time after the reset window. Prevents the cascade where agents hit 429 → disconnect → reconnect → immediately hit 429 again.

### 4. Live Dashboard

`http://localhost:3128/` shows:
- Rate limit status with color-coded utilization bars (5h + 7d)
- Tokens saved counter (cumulative)
- Request log with model, status, latency, tokens, savings per request
- By-model breakdown with cost estimation
- Rate limit events (429s, queued, threshold crossings) with trigger reasons

### 5. Token & Cost Tracking

Per-request tracking:
- Model used, streaming mode
- Input/output/cache tokens (parsed from SSE stream)
- System prompt size, message count
- Before/after request size, tokens saved
- Latency

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /` | Live dashboard |
| `GET /health` | Rate limit state, queue depth, stats |
| `GET /metrics` | Prometheus-format metrics |
| `GET /requests` | Recent request log (last 200) |
| `GET /stats` | Aggregate stats by model with cost estimation |
| `GET /events` | Rate limit event history (429s, queues, threshold crossings) |

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3128` | Proxy listen port |
| `ANTHROPIC_API_URL` | `https://api.anthropic.com` | Upstream API URL |
| `QUEUE_THRESHOLD` | `0.85` | Queue when utilization exceeds this (0.0–1.0) |
| `MAX_QUEUE_SIZE` | `100` | Max queued requests before rejecting |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `STRIP_BLOAT` | `true` | Enable request stripping (`false` to disable) |
| `KEEP_TOOLS` | `Bash,Read,Edit,Write,Glob,Grep,Agent,Skill,WebSearch,WebFetch` | Tools to keep |
| `BLOAT_THRESHOLD` | `3000` | System prompt blocks larger than this get replaced |

## Docker Compose Integration

Add to your existing docker-compose.yml:

```yaml
services:
  rate-limiter:
    build: ../claude-rate-limiter  # or image: ghcr.io/powback/claude-rate-limiter
    restart: unless-stopped
    environment:
      - PORT=3128
      - QUEUE_THRESHOLD=0.85

  agents:
    environment:
      - ANTHROPIC_BASE_URL=http://rate-limiter:3128
    depends_on:
      - rate-limiter
```

That's it. All Claude CLI processes spawned in the agents container will route through the proxy.

## Cost Impact

For 6 concurrent Opus agents (~1 turn/min each):

| Scenario | Tokens/hr | Cost/hr | Cost/month |
|----------|-----------|---------|------------|
| No proxy | 1.8M | $27.70 | $19,947 |
| **With proxy** | **250K** | **$3.75** | **$2,700** |
| Savings | — | — | **~$17,000/month** |

## How It Works

1. Claude CLI sends request to proxy (via `ANTHROPIC_BASE_URL`)
2. Proxy parses request JSON, replaces bloated system prompt with 933-char slim version
3. Removes unused tool definitions, trims kept tool descriptions
4. Strips system-reminder nag messages from user content
5. Forwards stripped request to `api.anthropic.com` (uncompressed for token parsing)
6. Reads rate limit headers from response
7. Parses SSE stream for token usage (input/output/cache)
8. Streams response back to client
9. If utilization > threshold, queues subsequent requests until reset

## Zero Dependencies

Built with Node.js built-in `http` and `https` modules only. TypeScript for development, compiles to plain JS.

## License

MIT
