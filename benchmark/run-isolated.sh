#!/bin/bash
# Isolated benchmark: stripped vs passthrough in SEPARATE runs (no cache contamination)
# Phase 2: stripped on port 3129
# Phase 3: 2-min wait
# Phase 4: passthrough on port 3130

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

RUN_ID="$(date +%Y%m%d-%H%M%S)"
RESULTS="benchmark/isolated-$RUN_ID"
mkdir -p "$RESULTS/isolated-stripped" "$RESULTS/isolated-passthrough"

# 5 tasks from the spec
TASK_IDS=("space-invaders" "snake-game" "todo-api" "chat-ui" "calculator")

echo "╔══════════════════════════════════════════════════════════╗"
echo "║  ISOLATED benchmark — $RUN_ID           ║"
echo "╠══════════════════════════════════════════════════════════╣"
echo "║  5 tasks × 2 modes = 10 runs (sequential, isolated)    ║"
echo "║  STRIP_BLOAT fixes: CWD awareness added to slim prompt  ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

get_task_prompt() {
  python3 -c "
import json
tasks=json.load(open('benchmark/tasks.json'))
t=[t for t in tasks if t['id']=='$1'][0]
print(t['prompt'])
"
}

get_task_validate() {
  python3 -c "
import json
tasks=json.load(open('benchmark/tasks.json'))
t=[t for t in tasks if t['id']=='$1'][0]
print(t.get('validate', 'true'))
"
}

run_task() {
  local task_id=$1
  local mode=$2
  local port=$3
  local outdir="$RESULTS/$mode/$task_id"
  mkdir -p "$outdir"

  local prompt=$(python3 -c "
import json
tasks=json.load(open('benchmark/tasks.json'))
t=[t for t in tasks if t['id']=='$task_id'][0]
print(t['prompt'])
")
  local validate=$(python3 -c "
import json
tasks=json.load(open('benchmark/tasks.json'))
t=[t for t in tasks if t['id']=='$task_id'][0]
print(t.get('validate', 'true'))
")

  echo "  [$mode] $task_id"

  local start_ms=$(($(date +%s%N)/1000000))

  # Stats before
  curl -s "http://localhost:$port/stats" > "$outdir/stats-before.json" 2>/dev/null
  curl -s "http://localhost:$port/requests" > "$outdir/requests-before.json" 2>/dev/null

  # Run task in its own workdir
  cd "$outdir"
  ANTHROPIC_BASE_URL="http://localhost:$port" \
    claude -p "$prompt" \
    --model haiku \
    --max-turns 10 \
    --permission-mode bypassPermissions \
    > output.txt 2>&1
  local exit_code=$?
  cd "$PROJECT_DIR"

  local end_ms=$(($(date +%s%N)/1000000))
  local duration_ms=$((end_ms - start_ms))

  # Stats after
  curl -s "http://localhost:$port/stats" > "$outdir/stats-after.json" 2>/dev/null
  curl -s "http://localhost:$port/requests" > "$outdir/requests-after.json" 2>/dev/null
  curl -s "http://localhost:$port/health" > "$outdir/health.json" 2>/dev/null
  curl -s "http://localhost:$port/events" > "$outdir/events.json" 2>/dev/null

  # Validate
  local valid=0
  if cd "$outdir" && eval "$validate" > /dev/null 2>&1; then
    valid=1
  fi
  cd "$PROJECT_DIR"

  # Output file size
  local output_size=$(find "$outdir" -name "*.html" -o -name "*.mjs" -o -name "*.js" 2>/dev/null | head -1 | xargs wc -c 2>/dev/null | awk '{print $1}' || echo 0)

  # Save result
  python3 -c "
import json
try:
    before = json.load(open('$outdir/stats-before.json'))
    after  = json.load(open('$outdir/stats-after.json'))
    api_calls      = after['totals']['requests']      - before['totals']['requests']
    input_tokens   = after['totals']['inputTokens']   - before['totals']['inputTokens']
    output_tokens  = after['totals']['outputTokens']  - before['totals']['outputTokens']
    cache_read     = after['totals']['cacheRead']      - before['totals']['cacheRead']
    cache_create   = after['totals']['cacheCreation']  - before['totals']['cacheCreation']
except Exception as e:
    print(f'  WARN: stats diff failed: {e}')
    api_calls=input_tokens=output_tokens=cache_read=cache_create=0

cost = (input_tokens * 0.8 + output_tokens * 4 + cache_create * 1 + cache_read * 0.08) / 1_000_000
result = {
  'task_id': '$task_id',
  'mode': '$mode',
  'exit_code': $exit_code,
  'valid': bool($valid),
  'duration_ms': $duration_ms,
  'api_calls': api_calls,
  'input_tokens': input_tokens,
  'output_tokens': output_tokens,
  'cache_read': cache_read,
  'cache_creation': cache_create,
  'output_file_bytes': int('${output_size:-0}' or 0),
  'cost_usd': round(cost, 6),
}
json.dump(result, open('$outdir/result.json', 'w'), indent=2)
print(f'    → calls={api_calls} in={input_tokens} out={output_tokens} cache_r={cache_read} cache_c={cache_create} {$duration_ms}ms valid={bool($valid)} \${cost:.6f}')
"
}

# ──────────────────────────────────────────────────────────
# PHASE 2: Stripped benchmark
# ──────────────────────────────────────────────────────────
echo "━━━ PHASE 2: STRIPPED (port 3129) ━━━"
LOG_DIR="$RESULTS/isolated-stripped-proxy" STRIP_BLOAT=true PORT=3129 LOG_LEVEL=debug \
  npx tsx src/index.ts > "$RESULTS/proxy-stripped.log" 2>&1 &
PROXY_STRIPPED_PID=$!
sleep 3
echo "Proxy PID=$PROXY_STRIPPED_PID"

for task_id in "${TASK_IDS[@]}"; do
  run_task "$task_id" "isolated-stripped" "3129"
done

kill $PROXY_STRIPPED_PID 2>/dev/null
wait $PROXY_STRIPPED_PID 2>/dev/null || true
echo "Stripped proxy stopped."
echo ""

# ──────────────────────────────────────────────────────────
# PHASE 3: Wait for cache expiry (2 min)
# ──────────────────────────────────────────────────────────
echo "━━━ PHASE 3: Waiting 120s for cache key separation ━━━"
echo "  (Different proxy instance = different cache key namespace)"
for i in $(seq 120 -10 10); do
  echo -n "  ${i}s remaining... "
  sleep 10
done
echo "Done."
echo ""

# ──────────────────────────────────────────────────────────
# PHASE 4: Passthrough benchmark
# ──────────────────────────────────────────────────────────
echo "━━━ PHASE 4: PASSTHROUGH (port 3130) ━━━"
LOG_DIR="$RESULTS/isolated-passthrough-proxy" STRIP_BLOAT=false PORT=3130 LOG_LEVEL=debug \
  npx tsx src/index.ts > "$RESULTS/proxy-passthrough.log" 2>&1 &
PROXY_PASSTHROUGH_PID=$!
sleep 3
echo "Proxy PID=$PROXY_PASSTHROUGH_PID"

for task_id in "${TASK_IDS[@]}"; do
  run_task "$task_id" "isolated-passthrough" "3130"
done

kill $PROXY_PASSTHROUGH_PID 2>/dev/null
wait $PROXY_PASSTHROUGH_PID 2>/dev/null || true
echo "Passthrough proxy stopped."
echo ""

# ──────────────────────────────────────────────────────────
# PHASE 5: Analysis
# ──────────────────────────────────────────────────────────
echo "━━━ PHASE 5: ANALYSIS ━━━"
python3 << PYEOF
import json, glob, os

results_dir = "$RESULTS"

stripped_results = []
passthrough_results = []

for r in sorted(glob.glob(f"{results_dir}/isolated-stripped/*/result.json")):
    stripped_results.append(json.load(open(r)))
for r in sorted(glob.glob(f"{results_dir}/isolated-passthrough/*/result.json")):
    passthrough_results.append(json.load(open(r)))

# Build lookup by task_id
s_by_id = {r['task_id']: r for r in stripped_results}
p_by_id = {r['task_id']: r for r in passthrough_results}

task_ids = [r['task_id'] for r in stripped_results]

print(f"\n{'TASK':20} {'MODE':12} {'CALLS':>6} {'IN':>7} {'OUT':>7} {'CACHE_R':>8} {'CACHE_C':>8} {'TIME':>8} {'COST':>10} {'VALID':>6}")
print("─" * 108)

for tid in task_ids:
    s = s_by_id.get(tid)
    p = p_by_id.get(tid)
    if s:
        print(f"{s['task_id']:20} {'stripped':12} {s['api_calls']:>6} {s['input_tokens']:>7} {s['output_tokens']:>7} {s['cache_read']:>8} {s['cache_creation']:>8} {s['duration_ms']:>7}ms \${s['cost_usd']:>9.6f} {'✓' if s['valid'] else '✗':>6}")
    if p:
        print(f"{'':20} {'passthrough':12} {p['api_calls']:>6} {p['input_tokens']:>7} {p['output_tokens']:>7} {p['cache_read']:>8} {p['cache_creation']:>8} {p['duration_ms']:>7}ms \${p['cost_usd']:>9.6f} {'✓' if p['valid'] else '✗':>6}")
    if s and p:
        diff_cost = s['cost_usd'] - p['cost_usd']
        diff_time = s['duration_ms'] - p['duration_ms']
        diff_out  = s['output_tokens'] - p['output_tokens']
        pct_cost  = (diff_cost / p['cost_usd'] * 100) if p['cost_usd'] else 0
        print(f"{'':20} {'DIFF':12} {'':>6} {'':>7} {diff_out:>+7} {'':>8} {'':>8} {diff_time:>+7}ms \${diff_cost:>+9.6f} ({pct_cost:>+.1f}%)")
    print()

print("═" * 108)
print("TOTALS")
print("═" * 108)
s_total = {k: sum(r[k] for r in stripped_results) for k in ['api_calls','input_tokens','output_tokens','cache_read','cache_creation','duration_ms','cost_usd']}
p_total = {k: sum(r[k] for r in passthrough_results) for k in ['api_calls','input_tokens','output_tokens','cache_read','cache_creation','duration_ms','cost_usd']}
s_valid = sum(1 for r in stripped_results if r['valid'])
p_valid = sum(1 for r in passthrough_results if r['valid'])

print(f"{'STRIPPED':20} {'':12} {s_total['api_calls']:>6} {s_total['input_tokens']:>7} {s_total['output_tokens']:>7} {s_total['cache_read']:>8} {s_total['cache_creation']:>8} {s_total['duration_ms']:>7}ms \${s_total['cost_usd']:>9.6f} {s_valid}/5")
print(f"{'PASSTHROUGH':20} {'':12} {p_total['api_calls']:>6} {p_total['input_tokens']:>7} {p_total['output_tokens']:>7} {p_total['cache_read']:>8} {p_total['cache_creation']:>8} {p_total['duration_ms']:>7}ms \${p_total['cost_usd']:>9.6f} {p_valid}/5")
diff_cost = s_total['cost_usd'] - p_total['cost_usd']
diff_time = s_total['duration_ms'] - p_total['duration_ms']
pct_cost  = (diff_cost / p_total['cost_usd'] * 100) if p_total['cost_usd'] else 0
pct_time  = (diff_time / p_total['duration_ms'] * 100) if p_total['duration_ms'] else 0
print(f"{'DIFF (S-P)':20} {'':12} {'':>6} {'':>7} {'':>7} {'':>8} {'':>8} {diff_time:>+7}ms \${diff_cost:>+9.6f} ({pct_cost:>+.1f}%)")

# Cache efficiency analysis
print("\n── Cache Analysis ──")
print(f"Stripped   — cache_create={s_total['cache_creation']:,} cache_read={s_total['cache_read']:,}  ratio={s_total['cache_read']/max(s_total['cache_creation'],1):.2f}x")
print(f"Passthrough— cache_create={p_total['cache_creation']:,} cache_read={p_total['cache_read']:,}  ratio={p_total['cache_read']/max(p_total['cache_creation'],1):.2f}x")

# Save summary
summary = {
    'run_id': '$RUN_ID',
    'method': 'isolated_sequential',
    'note': 'Separate proxy instances, 2-min gap between modes',
    'stripped': stripped_results,
    'passthrough': passthrough_results,
    'totals': {'stripped': s_total, 'passthrough': p_total},
    'savings': {'cost_pct': round(pct_cost, 2), 'time_pct': round(pct_time, 2), 'cost_usd': round(diff_cost, 6), 'time_ms': diff_time},
    'validity': {'stripped': s_valid, 'passthrough': p_valid},
}
json.dump(summary, open(f"{results_dir}/summary.json", 'w'), indent=2)
print(f"\nSaved to {results_dir}/summary.json")
PYEOF

echo ""
echo "Results in: $RESULTS"
echo "Run isolated session test: benchmark/run-session.sh"
