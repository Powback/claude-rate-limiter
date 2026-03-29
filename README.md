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

Tested with 10 real coding tasks (Space Invaders, Snake, TODO API, markdown editor, CSV analyzer, chat UI, regex tester, sorting visualizer, calculator, weather dashboard) on Claude Haiku:

### Passthrough mode (no stripping, just monitoring + queuing)

| Metric | Per task (avg) | Total (10 tasks) |
|--------|---------------|-------------------|
| API calls | 3 | 30 |
| Input tokens | 18 | 180 |
| Output tokens | 4,695 | 46,949 |
| Cache creation | 10,236 | 102,362 |
| Cache read | 47,871 | 478,705 |
| Time | 27.9s | 279s |
| Cost | $0.033 | $0.329 |
| **Task success** | **10/10** | |

### Key finding: prompt caching makes stripping unnecessary

We tested an aggressive stripping mode that replaced Anthropic's 51K system prompt with a 933-char slim version and removed unused tools. Results:

| Metric | Stripped | Passthrough | Winner |
|--------|---------|-------------|--------|
| Cost | $0.306 | $0.329 | Stripped (-6.8%) |
| Speed | 283s | 279s | Passthrough (-1.7%) |
| **Success rate** | **0/10** | **10/10** | **Passthrough** |

Stripping broke CWD awareness — agents wrote files to wrong paths. The 6.8% cost savings came from smaller cache entries, but Anthropic's prompt caching already prices cached tokens at $0.08/M (vs $0.80/M input). The bloated default prompt only costs ~$0.004 per turn after the first request.

**Stripping is disabled by default.** The proxy's value is in queuing and observability, not prompt surgery.

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
