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
| Output tokens | 3,631 | 18,153 |
| Cache creation | 9,420 | 47,099 |
| Cache read | 47,507 | 237,536 |
| Time | 26.3s | 131.6s |
| Cost | $0.028 | $0.13879 |
| **Task success** | **5/5** | |

### Stripped mode (`STRIP_BLOAT=true`)

> Slim prompt includes CWD instruction added 2026-03-29. Previous run (without CWD fix) showed 0/5 validity.

| Metric | Per task (avg) | Total (5 tasks) |
|--------|---------------|-----------------|
| API calls | 3 | 15 |
| Output tokens | 4,305 | 21,524 |
| Cache creation | 9,890 | 49,452 |
| Cache read | 6,037 | 30,183 |
| Time | 27.3s | 136.6s |
| Cost | $0.028 | $0.13803 |
| **Task success** | **5/5** | |

### Session test: 10-turn conversation

| Mode | API calls | Cache read | Cache create | Total cost |
|------|----------:|-----------:|-------------:|-----------:|
| Stripped | 39 | 109,743 | 88,426 | **$0.143** |
| Passthrough | 39 | 764,707 | 119,893 | **$0.232** |
| **Savings** | | | | **−$0.089 (−38%)** |

### Key findings

**Single isolated tasks: essentially equal cost (−0.5%).** Anthropic permanently pre-caches the 51K default system prompt in a shared global cache. Passthrough mode gets those tokens at $0.08/MTok (cache_read rate), which nearly offsets the bandwidth savings from stripping. Neither mode has a meaningful cost advantage for one-off tasks.

**Multi-turn sessions: stripped saves 38%.** In sessions where the same workdir grows over turns, passthrough carries the 51K system prompt into every cache entry — compounding into both higher cache_creation (~$0.003/turn extra) and cache_read (~$0.005/turn extra). Over 10 turns this adds up to ~$0.089.

**`cache_read` does NOT count toward Anthropic utilization.** Both modes show the same utilization increase despite 8.2× difference in cache_read volume. Rate limits are driven by `input + output + cache_creation` only. Heavy prompt caching doesn't accelerate rate limiting.

**Stripped produces ~15% more output tokens.** The full 51K system prompt's detailed behavioral instructions produce more concise responses. For large code generation tasks, this can offset the cache savings.

See `benchmark/FINDINGS.md` for full per-task and per-turn analysis.

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
