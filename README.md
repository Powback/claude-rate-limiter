# claude-rate-limiter

Rate-limit-aware reverse proxy for the Anthropic API. Prevents 429 errors in multi-agent setups by reading Anthropic's utilization headers and queuing requests before they get rejected.

## The Problem

When running multiple Claude agents concurrently, they hit Anthropic's rate limits and enter a death spiral: agent hits 429 → disconnects → reconnects → immediately hits 429 again. With 6+ agents this cascade makes the entire system unusable.

## The Solution

A transparent reverse proxy between Claude CLI and `api.anthropic.com`. Reads the actual rate limit headers from every response and queues requests when utilization is high.

```
Claude CLI --HTTP--> rate-limiter:3128 --HTTPS--> api.anthropic.com
                         |
                    📊 Reads utilization headers
                    ⏳ Queues when > 85% utilized
                    📈 Live dashboard + metrics
```

## Quick Start

```bash
# Install and run
cd claude-rate-limiter
npm install
npx tsx src/index.ts

# Route Claude through it
ANTHROPIC_BASE_URL=http://localhost:3128 claude ...
```

Dashboard at `http://localhost:3128/`

## What It Tracks

Anthropic uses a **unified utilization-based** rate limit system (not the `x-ratelimit-*` headers from their docs). The proxy reads the actual headers:

```
anthropic-ratelimit-unified-status: allowed | rejected
anthropic-ratelimit-unified-5h-utilization: 0.44    (44% of 5-hour window used)
anthropic-ratelimit-unified-7d-utilization: 0.06    (6% of 7-day window used)
anthropic-ratelimit-unified-5h-reset: 1774735200    (epoch seconds)
anthropic-ratelimit-unified-representative-claim: five_hour
```

Per request, it also tracks:
- Model, streaming mode, system prompt size, message count
- Input/output tokens and prompt cache usage (parsed from SSE stream)
- Latency, status code
- Rate limit events (429s, queuing, threshold crossings) with trigger reasons

## Benchmarks

Two isolated benchmark runs on 5 code generation tasks (Space Invaders, Snake, TODO API, chat UI, calculator) using Claude Haiku 3.5. Each mode ran against its own fresh proxy on a different port — no cache contamination.

### Passthrough mode (default — monitoring + queuing only)

| Metric | Per task (avg) | Total (5 tasks) |
|--------|---------------|-----------------|
| API calls | 3 | 15 |
| Input tokens | 18 | 90 |
| Output tokens | 3,808 | 19,041 |
| Cache creation | 9,094 | 45,468 |
| Cache read | 46,972 | 234,859 |
| Time | 24.3s | 121.5s |
| Cost | $0.028 | $0.1405 |
| **Task success** | **5/5** | |

### Stripped mode (`STRIP_BLOAT=true`)

| Metric | Per task (avg) | Total (5 tasks) |
|--------|---------------|-----------------|
| API calls | 3 | 15 |
| Input tokens | 18 | 90 |
| Output tokens | 3,878 | 19,389 |
| Cache creation | 9,201 | 46,005 |
| Cache read | 5,746 | 28,732 |
| Time | 26.0s | 130.0s |
| Cost | $0.025 | $0.1259 |
| **Task success** | **0/5** | |

### Key findings

**Stripping saves 11.6% cost but breaks correctness.** Stripped mode wrote files to absolute paths (`/workspace/`) instead of the task's working directory. The full Claude Code system prompt embeds actual CWD context that the slim prompt can't replicate — even with an explicit CWD instruction.

**`cache_read` does NOT count toward Anthropic utilization.** Both modes showed an identical +0.21 increase in 5-hour utilization despite an 8.2× difference in cache_read tokens (234,859 passthrough vs 28,732 stripped). Utilization is driven by `input + output + cache_creation` only. This means passthrough's heavy prompt caching does not accelerate rate limiting.

**Cache reads are nearly free.** At $0.08/M vs $0.80/M for input, each cached system-prompt read costs ~$0.004 — less than the overhead of regenerating context from scratch.

**Stripping is disabled by default.** See `benchmark/FINDINGS.md` for full analysis.

## Rate Limit Queuing

When 5-hour utilization exceeds the threshold (default 85%), incoming requests are held in a FIFO queue and released one at a time. This prevents the reconnect-429 death spiral that crashes multi-agent systems.

Rate limit events are logged with:
- Type (429, queued, rejected, threshold_crossed)
- Model that triggered it
- Utilization at time of event
- Queue depth
- Human-readable trigger reason

## Live Dashboard

`http://localhost:3128/` — auto-refreshes every 2 seconds:

- Rate limit status with color-coded utilization bars (5h + 7d windows)
- Request log with model, status, latency, input/output tokens per request
- By-model breakdown with cost estimation
- Rate limit event history with trigger reasons

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /` | Live dashboard |
| `GET /health` | Rate limit state, queue depth, stats |
| `GET /metrics` | Prometheus-format metrics |
| `GET /requests` | Recent request log (last 200) |
| `GET /stats` | Aggregate stats by model with cost estimation |
| `GET /events` | Rate limit event history |

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3128` | Listen port |
| `ANTHROPIC_API_URL` | `https://api.anthropic.com` | Upstream |
| `QUEUE_THRESHOLD` | `0.85` | Queue when utilization exceeds this |
| `MAX_QUEUE_SIZE` | `100` | Max queued requests |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `STRIP_BLOAT` | `false` | Enable prompt stripping (not recommended) |

## Docker Compose Integration

```yaml
services:
  rate-limiter:
    build: ../claude-rate-limiter
    restart: unless-stopped

  agents:
    environment:
      - ANTHROPIC_BASE_URL=http://rate-limiter:3128
    depends_on:
      - rate-limiter
```

## How It Works

1. Claude CLI sends request to proxy (via `ANTHROPIC_BASE_URL`)
2. Proxy strips `accept-encoding` so responses are uncompressed (needed to parse SSE)
3. Forwards request to `api.anthropic.com`
4. Reads `anthropic-ratelimit-unified-*` headers from response
5. Parses SSE stream for `message_start` (input tokens, cache) and `message_delta` (output tokens)
6. Streams response back to client
7. If utilization > threshold, queues subsequent requests until reset window

## Zero Dependencies

Node.js built-in `http` and `https` only. ~800 lines TypeScript.

## License

MIT
