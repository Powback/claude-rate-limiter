#!/bin/bash
set -e

# End-to-end benchmark: 10 real tasks, stripped vs passthrough
# Logs EVERY request/response for post-analysis

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

RUN_ID="$(date +%Y%m%d-%H%M%S)"
RESULTS="benchmark/results-$RUN_ID"
mkdir -p "$RESULTS/stripped" "$RESULTS/passthrough" "$RESULTS/output-stripped" "$RESULTS/output-passthrough"

PORT_S=3129
PORT_P=3130

echo "╔══════════════════════════════════════════════════════════╗"
echo "║  claude-rate-limiter benchmark — $RUN_ID  ║"
echo "╠══════════════════════════════════════════════════════════╣"
echo "║  10 tasks × 2 modes = 20 runs                          ║"
echo "║  Logging all requests + responses for analysis          ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# Start both proxies with full logging
LOG_DIR="$RESULTS/stripped" STRIP_BLOAT=true PORT=$PORT_S LOG_LEVEL=debug \
  npx tsx src/index.ts > "$RESULTS/proxy-stripped.log" 2>&1 &
PID_S=$!

LOG_DIR="$RESULTS/passthrough" STRIP_BLOAT=false PORT=$PORT_P LOG_LEVEL=debug \
  npx tsx src/index.ts > "$RESULTS/proxy-passthrough.log" 2>&1 &
PID_P=$!

sleep 3
echo "Proxies: stripped=:$PORT_S (pid=$PID_S) passthrough=:$PORT_P (pid=$PID_P)"
echo ""

cleanup() {
  kill $PID_S $PID_P 2>/dev/null
  echo "Proxies stopped."
}
trap cleanup EXIT

TASKS=$(python3 -c "import json; tasks=json.load(open('benchmark/tasks.json')); [print(t['id']) for t in tasks]")

run_task() {
  local task_id=$1
  local mode=$2  # stripped | passthrough
  local port=$3
  local outdir=$4

  local task=$(python3 -c "
import json
tasks=json.load(open('benchmark/tasks.json'))
t=[t for t in tasks if t['id']=='$task_id'][0]
print(t['prompt'])
")
  local max_turns=$(python3 -c "
import json
tasks=json.load(open('benchmark/tasks.json'))
t=[t for t in tasks if t['id']=='$task_id'][0]
print(t.get('maxTurns', 10))
")
  local validate=$(python3 -c "
import json
tasks=json.load(open('benchmark/tasks.json'))
t=[t for t in tasks if t['id']=='$task_id'][0]
print(t.get('validate', 'true'))
")

  local workdir="$outdir/$task_id"
  mkdir -p "$workdir"

  echo "  [$mode] $task_id — max $max_turns turns"

  local start_ms=$(($(date +%s%N)/1000000))

  # Snapshot proxy stats before
  curl -s "http://localhost:$port/stats" > "$workdir/stats-before.json" 2>/dev/null
  curl -s "http://localhost:$port/requests" > "$workdir/requests-before.json" 2>/dev/null

  # Run the task
  cd "$workdir"
  ANTHROPIC_BASE_URL="http://localhost:$port" \
    claude -p "$task" \
    --model haiku \
    --max-turns "$max_turns" \
    --permission-mode bypassPermissions \
    > output.txt 2>&1
  local exit_code=$?
  cd "$PROJECT_DIR"

  local end_ms=$(($(date +%s%N)/1000000))
  local duration_ms=$((end_ms - start_ms))

  # Snapshot proxy stats after
  curl -s "http://localhost:$port/stats" > "$workdir/stats-after.json" 2>/dev/null
  curl -s "http://localhost:$port/requests" > "$workdir/requests-after.json" 2>/dev/null
  curl -s "http://localhost:$port/health" > "$workdir/health.json" 2>/dev/null
  curl -s "http://localhost:$port/events" > "$workdir/events.json" 2>/dev/null

  # Validate output
  local valid=0
  if cd "$workdir" && eval "$validate" > /dev/null 2>&1; then
    valid=1
  fi
  cd "$PROJECT_DIR"

  # Count output file size
  local output_size=0
  if [ -d "$workdir" ]; then
    output_size=$(find "$workdir" -name "*.html" -o -name "*.mjs" -o -name "*.js" | head -1 | xargs wc -c 2>/dev/null | awk '{print $1}')
  fi

  # Write result
  python3 -c "
import json
# Diff stats before/after to get this task's usage
try:
    before = json.load(open('$workdir/stats-before.json'))
    after = json.load(open('$workdir/stats-after.json'))
    reqs_before = before['totals']['requests']
    reqs_after = after['totals']['requests']
    api_calls = reqs_after - reqs_before
    input_tokens = after['totals']['inputTokens'] - before['totals']['inputTokens']
    output_tokens = after['totals']['outputTokens'] - before['totals']['outputTokens']
    cache_read = after['totals']['cacheRead'] - before['totals']['cacheRead']
    cache_create = after['totals']['cacheCreation'] - before['totals']['cacheCreation']
except: api_calls=input_tokens=output_tokens=cache_read=cache_create=0

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
}

# Effective cost (haiku)
cost = (input_tokens * 0.8 + output_tokens * 4 + cache_create * 1 + cache_read * 0.08) / 1_000_000
result['cost_usd'] = round(cost, 6)

json.dump(result, open('$workdir/result.json', 'w'), indent=2)
print(f'    → {api_calls} calls, in={input_tokens} out={output_tokens} cache_r={cache_read} cache_c={cache_create} {$duration_ms}ms valid={bool($valid)} \${cost:.6f}')
"
}

# Run all tasks
for task_id in $TASKS; do
  echo ""
  echo "━━━ Task: $task_id ━━━"
  run_task "$task_id" "stripped" "$PORT_S" "$RESULTS/output-stripped"
  run_task "$task_id" "passthrough" "$PORT_P" "$RESULTS/output-passthrough"
done

# Generate summary
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "GENERATING SUMMARY..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

python3 << PYEOF
import json, os, glob

results_dir = "$RESULTS"
stripped_results = []
passthrough_results = []

for task_dir in sorted(glob.glob(f"{results_dir}/output-stripped/*/result.json")):
    stripped_results.append(json.load(open(task_dir)))
for task_dir in sorted(glob.glob(f"{results_dir}/output-passthrough/*/result.json")):
    passthrough_results.append(json.load(open(task_dir)))

print(f"\n{'TASK':20} {'MODE':12} {'CALLS':>6} {'IN':>7} {'OUT':>7} {'CACHE_R':>8} {'CACHE_C':>8} {'TIME':>8} {'COST':>10} {'VALID':>6}")
print("─" * 105)

for s, p in zip(stripped_results, passthrough_results):
    for r, mode in [(s, "stripped"), (p, "passthrough")]:
        print(f"{r['task_id']:20} {mode:12} {r['api_calls']:>6} {r['input_tokens']:>7} {r['output_tokens']:>7} {r['cache_read']:>8} {r['cache_creation']:>8} {r['duration_ms']:>7}ms \${r['cost_usd']:>9.6f} {'✓' if r['valid'] else '✗':>6}")
    # Diff line
    diff_cost = s['cost_usd'] - p['cost_usd']
    diff_time = s['duration_ms'] - p['duration_ms']
    diff_out = s['output_tokens'] - p['output_tokens']
    print(f"{'':20} {'DIFF':12} {'':>6} {'':>7} {diff_out:>+7} {'':>8} {'':>8} {diff_time:>+7}ms \${diff_cost:>+9.6f}")
    print()

# Totals
print("═" * 105)
print("TOTALS")
print("═" * 105)
s_total = {k: sum(r[k] for r in stripped_results) for k in ['api_calls','input_tokens','output_tokens','cache_read','cache_creation','duration_ms','cost_usd']}
p_total = {k: sum(r[k] for r in passthrough_results) for k in ['api_calls','input_tokens','output_tokens','cache_read','cache_creation','duration_ms','cost_usd']}
s_valid = sum(1 for r in stripped_results if r['valid'])
p_valid = sum(1 for r in passthrough_results if r['valid'])

print(f"{'STRIPPED':20} {'':12} {s_total['api_calls']:>6} {s_total['input_tokens']:>7} {s_total['output_tokens']:>7} {s_total['cache_read']:>8} {s_total['cache_creation']:>8} {s_total['duration_ms']:>7}ms \${s_total['cost_usd']:>9.6f} {s_valid}/10")
print(f"{'PASSTHROUGH':20} {'':12} {p_total['api_calls']:>6} {p_total['input_tokens']:>7} {p_total['output_tokens']:>7} {p_total['cache_read']:>8} {p_total['cache_creation']:>8} {p_total['duration_ms']:>7}ms \${p_total['cost_usd']:>9.6f} {p_valid}/10")
diff_cost = s_total['cost_usd'] - p_total['cost_usd']
diff_time = s_total['duration_ms'] - p_total['duration_ms']
pct_cost = (diff_cost / p_total['cost_usd'] * 100) if p_total['cost_usd'] else 0
pct_time = (diff_time / p_total['duration_ms'] * 100) if p_total['duration_ms'] else 0
print(f"{'DIFF':20} {'':12} {'':>6} {'':>7} {'':>7} {'':>8} {'':>8} {diff_time:>+7}ms \${diff_cost:>+9.6f}")
print(f"{'':20} {'':12} {'':>6} {'':>7} {'':>7} {'':>8} {'':>8} {pct_time:>+6.1f}%   {pct_cost:>+6.1f}%")

# Save full summary
summary = {
    'run_id': '$RUN_ID',
    'stripped': stripped_results,
    'passthrough': passthrough_results,
    'totals': {'stripped': s_total, 'passthrough': p_total},
    'savings': {'cost_pct': round(pct_cost, 2), 'time_pct': round(pct_time, 2), 'cost_usd': round(diff_cost, 6), 'time_ms': diff_time},
    'validity': {'stripped': s_valid, 'passthrough': p_valid},
}
json.dump(summary, open(f"{results_dir}/summary.json", 'w'), indent=2)
print(f"\nFull results saved to {results_dir}/summary.json")
PYEOF
