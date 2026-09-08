#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${LOCALELOCK_ENV_FILE:-$HOME/.localelock/.env}"
PORT="${E2E_PORT:-8790}"
E2E_DB="localelock_e2e"
CH_HOST="${E2E_CLICKHOUSE_HOST:-127.0.0.1}"
CH_PORT="${E2E_CLICKHOUSE_PORT:-8123}"
CH_USER="${E2E_CLICKHOUSE_USER:-default}"
CH_PASSWORD="${E2E_CLICKHOUSE_PASSWORD:-localdev}"
RUN_TIMEOUT="${E2E_RUN_TIMEOUT:-420}"
SERVER_ENTRY="${E2E_SERVER_ENTRY:-src/local/server.ts}"
SKIP_SEED=0 KEEP=0

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --timeout) RUN_TIMEOUT="$2"; shift 2 ;;
    --skip-seed) SKIP_SEED=1; shift ;;
    --keep) KEEP=1; shift ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

PASSED=0 WARNED=0 FAILED=0 SERVER_PID="" T_START=$(date +%s)
TMP_BASE="${TMPDIR:-/tmp}"; TMP_BASE="${TMP_BASE%/}"
WORK="$(mktemp -d "$TMP_BASE/localelock-e2e.XXXXXX")"
SERVER_LOG="$WORK/server.log"
SUMMARY=()

step() { printf '\n[STEP] %s\n' "$*"; }
pass() { PASSED=$((PASSED + 1)); printf '[PASS] %s\n' "$*"; }
warn() { WARNED=$((WARNED + 1)); printf '[WARN] %s\n' "$*"; }
fail() {
  local msg="$1" file="${2:-}"
  printf '[FAIL] %s\n' "$msg"
  if [ -n "$file" ] && [ -f "$file" ]; then
    printf '       response excerpt: %s\n' "$(head -c 900 "$file" | tr '\n' ' ')"
  fi
  FAILED=1
  exit 1
}

stop_server() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    pkill -P "$SERVER_PID" 2>/dev/null || true
    kill "$SERVER_PID" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$SERVER_PID" 2>/dev/null || break; sleep 0.5; done
    kill -9 "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
    printf '[STOP] local API (pid %s) stopped\n' "$SERVER_PID"
  fi
}

cleanup() {
  local code=$?
  trap - EXIT
  stop_server
  local elapsed=$(( $(date +%s) - T_START ))
  echo
  echo "================= e2e-local report ================="
  for line in "${SUMMARY[@]+"${SUMMARY[@]}"}"; do echo "  $line"; done
  if [ "$FAILED" -eq 1 ] || [ "$code" -ne 0 ]; then
    echo "  RESULT: FAILED after ${PASSED} passed check(s), ${WARNED} warning(s), ${elapsed}s"
    echo "  work dir kept: $WORK"
    if [ -f "$SERVER_LOG" ]; then
      echo "  --- last 60 lines of $SERVER_LOG ---"
      tail -n 60 "$SERVER_LOG" | sed 's/^/  | /'
    fi
    echo "===================================================="
    exit 1
  fi
  echo "  RESULT: PASSED - ${PASSED} checks, ${WARNED} warning(s), ${elapsed}s"
  echo "===================================================="
  if [ "$KEEP" -eq 1 ]; then echo "  work dir kept: $WORK"; else rm -rf "$WORK"; fi
  exit 0
}
trap cleanup EXIT
trap 'exit 130' INT TERM

jexpr() {
  node -e '
    const fs = require("fs");
    const [file, expr] = process.argv.slice(1);
    let d;
    try { d = JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (e) { console.error("not JSON: " + file + " (" + e.message + ")"); process.exit(2); }
    let v;
    try { v = Function("d", "return (" + expr + ");")(d); }
    catch (e) { console.error("expression failed: " + expr + " -> " + e.message); process.exit(2); }
    process.stdout.write(v === undefined ? "undefined" : (typeof v === "string" ? v : JSON.stringify(v)));
  ' "$1" "$2"
}

assert_json() {
  local label="$1" file="$2" expr="$3" out
  if out="$(jexpr "$file" "!!($expr)" 2>"$WORK/jexpr.err")" && [ "$out" = "true" ]; then
    pass "$label"
  else
    [ -s "$WORK/jexpr.err" ] && cat "$WORK/jexpr.err"
    fail "$label -- expected truthy: $expr" "$file"
  fi
}

HTTP_CODE=000
api() {
  local method="$1" path="$2" out="$3" body="${4:-}"
  local args=(-sS --max-time 120 -o "$out" -w '%{http_code}' -X "$method" -H 'accept: application/json')
  [ -n "$body" ] && args+=(-H 'content-type: application/json' --data "$body")
  case "$path" in /admin/*) [ -n "${DEMO_ADMIN_KEY:-}" ] && args+=(-H "X-Demo-Key: $DEMO_ADMIN_KEY") ;; esac
  HTTP_CODE="$(curl "${args[@]}" "$API$path" 2>>"$WORK/curl.err")" || HTTP_CODE=000
}

expect_code() { # expect_code <label> <expected> <file>
  if [ "$HTTP_CODE" = "$2" ]; then pass "$1 -> HTTP $2"; else fail "$1 -> HTTP $HTTP_CODE (expected $2)" "$3"; fi
}

sha256_of() { node -e 'process.stdout.write(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex"))' "$1"; }

port_free() { node -e 'const s=require("net").createServer();s.once("error",()=>process.exit(1));s.listen(+process.argv[1],"127.0.0.1",()=>s.close(()=>process.exit(0)))' "$1"; }

tcp_open() { node -e 'const s=require("net").connect({host:process.argv[1],port:+process.argv[2]});s.setTimeout(3000);s.on("connect",()=>{s.end();process.exit(0)});s.on("error",()=>process.exit(1));s.on("timeout",()=>process.exit(1))' "$1" "$2"; }

poll_run() {
  local run_id="$1" out="$2" label="$3" deadline=$(( $(date +%s) + RUN_TIMEOUT )) last="" line=""
  while :; do
    api GET "/runs/$run_id" "$out"
    if [ "$HTTP_CODE" = "200" ]; then
      line="$(jexpr "$out" 'd.phase + "  state=" + d.release_state + "  trace=" + (d.trace||[]).length + "  findings=" + d.finding_count')"
      if [ "$line" != "$last" ]; then printf '       %s  %s\n' "$(date +%H:%M:%S)" "$line"; last="$line"; fi
      case "$(jexpr "$out" 'd.phase')" in
        complete) return 0 ;;
        failed) fail "$label: run $run_id FAILED: $(jexpr "$out" 'JSON.stringify(d.error)')" "$out" ;;
      esac
    else
      printf '       poll -> HTTP %s\n' "$HTTP_CODE"
    fi
    [ "$(date +%s)" -lt "$deadline" ] || fail "$label: run $run_id did not complete within ${RUN_TIMEOUT}s (last: $last)" "$out"
    sleep 2
  done
}

step "Preflight"
for c in node npm curl; do command -v "$c" >/dev/null 2>&1 || fail "$c is required"; done
[ -f "$ROOT/backend/package.json" ] || fail "backend/package.json not found - the backend is not in place yet"
[ -d "$ROOT/backend/node_modules" ] || fail "backend dependencies missing - run: npm --prefix backend install"
[ -f "$ROOT/backend/node_modules/tsx/package.json" ] || fail "tsx missing in backend/node_modules - run: npm --prefix backend install"
[ -f "$ROOT/backend/$SERVER_ENTRY" ] || fail "backend/$SERVER_ENTRY not found (override with E2E_SERVER_ENTRY)"
MCP_BIN="${MCP_CLICKHOUSE_BIN:-$ROOT/backend/.venv/bin/mcp-clickhouse}"
[ -x "$MCP_BIN" ] \
  || fail "mcp-clickhouse missing at $MCP_BIN - run: python3 -m venv backend/.venv && backend/.venv/bin/pip install mcp-clickhouse==0.6.0"
export MCP_CLICKHOUSE_BIN="$MCP_BIN"

if [ -f "$ENV_FILE" ]; then
  set -a
  source "$ENV_FILE"
  set +a
  echo "       env loaded from $ENV_FILE (Gemini/Vertex settings)"
else
  warn "no env file at $ENV_FILE - Gemini will only work if GOOGLE_* / GEMINI_API_KEY are already exported"
fi
export CLICKHOUSE_HOST="$CH_HOST" CLICKHOUSE_PORT="$CH_PORT" CLICKHOUSE_SECURE="false"
export CLICKHOUSE_USER="$CH_USER" CLICKHOUSE_PASSWORD="$CH_PASSWORD"
export CLICKHOUSE_AGENT_USER="$CH_USER" CLICKHOUSE_AGENT_PASSWORD="$CH_PASSWORD"
export CLICKHOUSE_DATABASE="$E2E_DB"
export PORT="$PORT" LOCALELOCK_ENV_FILE="$ENV_FILE"

case "$CH_HOST" in 127.0.0.1|localhost|::1) ;; *) fail "E2E_CLICKHOUSE_HOST must point at a local ClickHouse (got host $CH_HOST)" ;; esac
tcp_open "$CH_HOST" "$CH_PORT" || fail "local ClickHouse not reachable at $CH_HOST:$CH_PORT (start it: docker run -d --name ll-ch -p 8123:8123 -e CLICKHOUSE_PASSWORD=localdev -e CLICKHOUSE_DB=localelock clickhouse/clickhouse-server:latest)"
pass "local ClickHouse reachable at $CH_HOST:$CH_PORT (db $E2E_DB)"

for _ in $(seq 1 20); do port_free "$PORT" && break; PORT=$((PORT + 1)); done
port_free "$PORT" || fail "no free port found near ${E2E_PORT:-8790}"
export PORT
API="http://127.0.0.1:$PORT"
echo "       API base: $API"

if [ "$SKIP_SEED" -eq 0 ]; then
  step "Seeding $E2E_DB on local ClickHouse (npm --prefix backend run seed -- --force)"
  T0=$(date +%s)
  npm --prefix "$ROOT/backend" run seed -- --force > "$WORK/seed.log" 2>&1 \
    || { tail -n 40 "$WORK/seed.log"; fail "seed failed (see $WORK/seed.log)"; }
  pass "seed --force finished in $(( $(date +%s) - T0 ))s"
else
  step "Skipping seed (--skip-seed): using the existing $E2E_DB"
fi

step "Starting local API: node --import tsx backend/$SERVER_ENTRY on $API (CLICKHOUSE_DATABASE=$E2E_DB)"
( cd "$ROOT/backend" && exec node --import tsx "$SERVER_ENTRY" ) > "$SERVER_LOG" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 60); do
  if curl -sS --max-time 5 -o "$WORK/health0.json" "$API/health" 2>/dev/null; then break; fi
  kill -0 "$SERVER_PID" 2>/dev/null || fail "server exited early (see $SERVER_LOG)"
  sleep 1
done
[ -s "$WORK/health0.json" ] || fail "server did not answer $API/health within 60s"
pass "server up (pid $SERVER_PID)"

step "GET /health?deep=1"
api GET "/health?deep=1" "$WORK/health.json"
expect_code "health deep" 200 "$WORK/health.json"
assert_json "health: service localelock-live" "$WORK/health.json" "d.service === 'localelock-live' && d.runtime.mode === 'local'"
assert_json "health: clickhouse ok and pointed at $E2E_DB on localhost" "$WORK/health.json" \
  "d.clickhouse.ok === true && d.clickhouse.database === '$E2E_DB' && ['127.0.0.1','localhost','::1'].includes(d.clickhouse.host_hint)"
assert_json "health: dataset >= 100,000 synthetic rows" "$WORK/health.json" "d.clickhouse.synthetic_rows_total >= 100000"
assert_json "health: mcp = official mcp-clickhouse, read-only, tools list_databases/list_tables/run_query" "$WORK/health.json" \
  "d.mcp.server === 'mcp-clickhouse' && d.mcp.read_only === true && ['list_databases','list_tables','run_query'].every(t => d.mcp.tools_allowed.includes(t))"
assert_json "health: mcp deep check ok (spawned + listed tools)" "$WORK/health.json" "d.mcp.ok === true"
if [ "$(jexpr "$WORK/health.json" 'd.gemini.configured')" != "true" ]; then
  fail "health: gemini not configured (need GOOGLE_APPLICATION_CREDENTIALS + GOOGLE_CLOUD_PROJECT in $ENV_FILE, or GEMINI_API_KEY)" "$WORK/health.json"
fi
if [ "$(jexpr "$WORK/health.json" 'd.gemini.ok')" != "true" ]; then
  fail "health: gemini ping failed: $(jexpr "$WORK/health.json" 'd.gemini.error') (HTTP 403 BILLING_DISABLED means billing is not enabled on the GCP project)" "$WORK/health.json"
fi
pass "health: gemini ok via $(jexpr "$WORK/health.json" 'd.gemini.backend + " " + d.gemini.model + " (adk " + d.adk.version + ")"')"
assert_json "health: adk agents release_gate_agent + semantic_reviewer" "$WORK/health.json" \
  "d.adk.framework === 'google-adk' && d.adk.agents.includes('release_gate_agent') && d.adk.agents.includes('semantic_reviewer')"
SUMMARY+=("health: clickhouse $E2E_DB ok · mcp-clickhouse read-only ok · gemini $(jexpr "$WORK/health.json" 'd.gemini.backend + "/" + d.gemini.model') ok")

step "GET /demo/state (seed baseline)"
api GET "/demo/state" "$WORK/state0.json"
expect_code "demo state" 200 "$WORK/state0.json"
assert_json "state: The Last Tram / es / v7, source r3" "$WORK/state0.json" \
  "d.title.title_id === 'tt_last_tram' && d.title.name === 'The Last Tram' && d.title.latest_source_revision === 'r3' && d.delivery.locale === 'es' && d.delivery.version === 7"
assert_json "state: RELEASE HELD - 4 blockers (seed_baseline)" "$WORK/state0.json" \
  "d.release.state === 'HELD' && d.release.blocker_count === 4 && d.release.origin === 'seed_baseline' && d.release.as_of_run_id === 'run_baseline_v7'"
assert_json "state: latest_run is run_baseline_v7 with 4 findings, no trace, agent null" "$WORK/state0.json" \
  "d.latest_run && d.latest_run.run_id === 'run_baseline_v7' && d.latest_run.findings.length === 4 && d.latest_run.trace.length === 0 && d.latest_run.agent === null && d.approved_version === null"
assert_json "state: incoming event is vendor_delivery v7" "$WORK/state0.json" \
  "d.incoming_event.event_type === 'vendor_delivery' && d.incoming_event.target_version === 7 && d.incoming_event.title_id === 'tt_last_tram'"
assert_json "state: dataset >= 100,000 synthetic rows with disclaimer" "$WORK/state0.json" \
  "d.dataset.synthetic_rows_total >= 100000 && typeof d.dataset.disclaimer === 'string' && d.dataset.disclaimer.includes('Synthetic')"
SUMMARY+=("baseline: HELD/4 (run_baseline_v7), $(jexpr "$WORK/state0.json" 'd.dataset.synthetic_rows_total') synthetic rows")

step "Error contract spot checks"
api GET "/does-not-exist" "$WORK/err404.json"
expect_code "unknown path" 404 "$WORK/err404.json"
assert_json "404 body is ApiError NOT_FOUND" "$WORK/err404.json" "d.error && d.error.code === 'NOT_FOUND'"
api POST "/runs/run_baseline_v7/recheck" "$WORK/err409.json" '{}'
expect_code "recheck before approval" 409 "$WORK/err409.json"
assert_json "409 body is ApiError NOT_APPROVED" "$WORK/err409.json" "d.error && d.error.code === 'NOT_APPROVED'"
api POST "/runs/run_baseline_v7/approvals" "$WORK/err409b.json" '{"reviewer":"e2e","decisions":[]}'
expect_code "approving the seeded baseline is refused" 409 "$WORK/err409b.json"
assert_json "409 body is ApiError RUN_NOT_COMPLETE for the baseline" "$WORK/err409b.json" "d.error && d.error.code === 'RUN_NOT_COMPLETE'"
api GET "/runs?limit=10" "$WORK/runs.json"
expect_code "list runs" 200 "$WORK/runs.json"
assert_json "runs list shape" "$WORK/runs.json" "Array.isArray(d.runs) && d.runs.length >= 1"

step "POST /runs (vendor_delivery, hero defaults)"
api POST "/runs" "$WORK/run-create.json" '{"trigger":"vendor_delivery"}'
expect_code "create run" 202 "$WORK/run-create.json"
assert_json "create run: {run_id, status queued, poll_url}" "$WORK/run-create.json" \
  "typeof d.run_id === 'string' && d.run_id.startsWith('run_') && d.status === 'queued' && typeof d.poll_url === 'string' && d.poll_url.includes(d.run_id)"
RUN_ID="$(jexpr "$WORK/run-create.json" 'd.run_id')"
echo "       run_id: $RUN_ID"

step "Polling GET /runs/$RUN_ID until complete (timeout ${RUN_TIMEOUT}s)"
poll_run "$RUN_ID" "$WORK/run.json" "release gate"
R="$WORK/run.json"
assert_json "run: complete, HELD, 4 blockers, 4 findings, origin release_gate, v7" "$R" \
  "d.phase === 'complete' && d.release_state === 'HELD' && d.blocker_count === 4 && d.finding_count === 4 && d.findings.length === 4 && d.origin === 'release_gate' && d.version === 7 && d.trigger === 'vendor_delivery' && d.title_id === 'tt_last_tram' && d.locale === 'es'"
assert_json "run: all five pipeline phases recorded with timings" "$R" \
  "['event_received','querying_clickhouse','deterministic_qc','gemini_semantic_review','producer_decision'].every(p => d.phases.some(x => x.phase === p && typeof x.started_at === 'string')) && typeof d.duration_ms === 'number'"
assert_json "run: agent trace is google-adk release_gate_agent with tool calls" "$R" \
  "d.agent && d.agent.framework === 'google-adk' && d.agent.agent_name === 'release_gate_agent' && ['vertex-ai','gemini-api'].includes(d.agent.backend) && d.agent.total_tool_calls >= 5 && d.agent.llm_turns >= 1 && typeof d.agent.adk_version === 'string'"
assert_json "trace: every entry is an mcp_tool_call on mcp-clickhouse" "$R" \
  "d.trace.length >= 5 && d.trace.every(t => t.kind === 'mcp_tool_call' && t.server === 'mcp-clickhouse' && typeof t.server_version === 'string' && ['list_databases','list_tables','run_query'].includes(t.tool))"
assert_json "trace: Q2..Q6 each have an exact-match, successful entry" "$R" \
  "['Q2_TIMING_OVERLAP','Q3_READING_SPEED','Q4_GLOSSARY_TERMS','Q5_GLOSSARY_DRIFT','Q6_SEMANTIC_CANDIDATES'].every(q => d.trace.some(t => t.query_id === q && t.matched_expected === true && t.ok === true))"
assert_json "trace: Q2/Q3/Q5/Q6 return exactly 1 row each, Q4 returns the 6 glossary terms" "$R" \
  "(function(){ const m = q => d.trace.filter(t => t.query_id === q && t.matched_expected && t.ok).pop(); return m('Q2_TIMING_OVERLAP').row_count === 1 && m('Q3_READING_SPEED').row_count === 1 && m('Q5_GLOSSARY_DRIFT').row_count === 1 && m('Q6_SEMANTIC_CANDIDATES').row_count === 1 && m('Q4_GLOSSARY_TERMS').row_count === 6; })()"
assert_json "trace: queries are sanitized (no connection strings) and previews are capped at 10 rows" "$R" \
  "d.trace.every(t => !JSON.stringify(t.query).toLowerCase().includes('password') && !JSON.stringify(t.query).includes('clickhouse.cloud') && t.rows_preview.length <= 10)"
if [ "$(jexpr "$R" 'd.trace.some(t => t.query_id === "Q1_LIST_TABLES")')" = "true" ]; then pass "trace: Q1 list_tables discovery present"; else warn "trace: no Q1 list_tables entry (discovery is optional)"; fi
FALLBACKS="$(jexpr "$R" 'd.trace.filter(t => t.initiator === "app_fallback").map(t => t.query_id).join(",")')"
if [ -n "$FALLBACKS" ]; then warn "trace: app_fallback used for $FALLBACKS (agent skipped/altered them; labelled, still real MCP)"; else pass "trace: all queries initiated by the ADK agent (no app_fallback)"; fi

assert_json "findings: all open blockers, priorities 1..4 in TIMING/READING/GLOSSARY/SEMANTIC order" "$R" \
  "d.findings.every(f => f.is_blocker === true && f.status === 'open' && f.run_id === d.run_id && f.version === 7 && f.proposed_repair && f.proposed_repair.requires_human_approval === true) && [...d.findings].sort((a,b) => a.priority - b.priority).map(f => f.rule_id).join(',') === 'TIMING_OVERLAP,READING_SPEED,GLOSSARY_DRIFT,SEMANTIC_REVERSAL'"
assert_json "finding 1: cue 118 overlaps cue 119 by 420 ms -> trim to 351,920" "$R" \
  "(function(){ const f = d.findings.find(x => x.rule_id === 'TIMING_OVERLAP'); const e = f.evidence, r = f.proposed_repair; return f.cue_id === 118 && f.source === 'deterministic_query' && f.confidence === 1 && f.headline === 'Cue 118 overlaps cue 119 by 420 ms' && e.next_cue_id === 119 && e.overlap_ms === 420 && e.cue_start_ms === 349000 && e.cue_end_ms === 352420 && e.next_start_ms === 352000 && e.min_gap_ms === 80 && r.kind === 'trim_out_time' && r.cue_id === 118 && r.before.end_ms === 352420 && r.after.end_ms === 351920 && r.origin === 'deterministic' && f.evidence_ref.query_id === 'Q2_TIMING_OVERLAP'; })()"
assert_json "finding 2: cue 204 at 24.6 CPS (59 chars / 2.4 s) -> extend to 614,200 (19.7 CPS)" "$R" \
  "(function(){ const f = d.findings.find(x => x.rule_id === 'READING_SPEED'); const e = f.evidence, r = f.proposed_repair; return f.cue_id === 204 && f.source === 'deterministic_query' && f.headline === 'Cue 204 reads at 24.6 CPS, above the 20 CPS limit' && e.cps === 24.6 && e.chars === 59 && e.duration_ms === 2400 && e.limit_cps === 20 && r.kind === 'extend_out_time' && r.before.end_ms === 613600 && r.after.end_ms === 614200 && r.after.start_ms === 611200 && Number(r.verification.cps) === 19.7 && f.evidence_ref.query_id === 'Q3_READING_SPEED'; })()"
assert_json "finding 3: glossary Mara Voss vs Maria Voss (cue 57, edit distance 1) -> replace_text" "$R" \
  "(function(){ const f = d.findings.find(x => x.rule_id === 'GLOSSARY_DRIFT'); const e = f.evidence, r = f.proposed_repair; return f.cue_id === 57 && f.source === 'deterministic_query' && f.headline === 'Glossary says \"Mara Voss\", delivery says \"Maria Voss\"' && e.source_term === 'Mara Voss' && e.approved_target_term === 'Mara Voss' && e.found_term === 'Maria Voss' && e.edit_distance === 1 && e.target_text === 'Maria Voss firmó el manifiesto ella misma.' && r.kind === 'replace_text' && r.after.text === 'Mara Voss firmó el manifiesto ella misma.' && f.evidence_ref.query_id === 'Q5_GLOSSARY_DRIFT'; })()"
assert_json "finding 4: cue 231 'Do not send it yet.' vs 'Envialo ahora.' -> Gemini MEANING_REVERSED (high, blocker)" "$R" \
  "(function(){ const f = d.findings.find(x => x.rule_id === 'SEMANTIC_REVERSAL'); const e = f.evidence, r = f.proposed_repair, v = e.review; return f.cue_id === 231 && f.source === 'gemini_semantic_review' && f.severity === 'high' && e.source_text === 'Do not send it yet.' && e.target_text === 'Envialo ahora.' && e.previous_source_text === 'Send it now.' && e.source_revision === 'r3' && e.target_version === 7 && v.framework === 'google-adk' && v.agent_name === 'semantic_reviewer' && v.output.verdict === 'MEANING_REVERSED' && v.output.severity === 'high' && v.output.confidence >= 0.5 && v.output.confidence <= 1 && v.input.cue_id === 231 && v.input.source_text === 'Do not send it yet.' && v.input.target_text === 'Envialo ahora.' && typeof v.latency_ms === 'number' && r.kind === 'replace_text' && typeof r.after.text === 'string' && r.after.text.length > 0 && r.after.text !== 'Envialo ahora.' && ['gemini_suggestion','deterministic'].includes(r.origin) && f.evidence_ref.query_id === 'Q6_SEMANTIC_CANDIDATES'; })()"
assert_json "run: semantic_review persisted on the run (1 candidate, MEANING_REVERSED)" "$R" \
  "d.semantic_candidates === 1 && d.semantic_review && d.semantic_review.output.verdict === 'MEANING_REVERSED' && d.semantic_review.input.cue_id === 231"
CUE231_FIX="$(jexpr "$R" 'd.findings.find(x => x.rule_id === "SEMANTIC_REVERSAL").proposed_repair.after.text')"
CUE231_ORIGIN="$(jexpr "$R" 'd.findings.find(x => x.rule_id === "SEMANTIC_REVERSAL").proposed_repair.origin')"
echo "       cue 231 proposed: \"$CUE231_FIX\" (origin $CUE231_ORIGIN, confidence $(jexpr "$R" 'd.semantic_review.output.confidence'))"
SUMMARY+=("release gate: $RUN_ID -> HELD/4 in $(jexpr "$R" 'Math.round(d.duration_ms/1000)')s, $(jexpr "$R" 'd.trace.length') MCP calls, cue 231 -> \"$CUE231_FIX\"")

api GET "/demo/state" "$WORK/state1.json"
expect_code "demo state after run" 200 "$WORK/state1.json"
assert_json "state: HELD/4 now attributed to the live run" "$WORK/state1.json" \
  "d.release.state === 'HELD' && d.release.blocker_count === 4 && d.release.origin === 'release_gate' && d.release.as_of_run_id === '$RUN_ID' && d.latest_run.run_id === '$RUN_ID'"

step "POST /runs/$RUN_ID/approvals with an incomplete decision set"
PARTIAL_BODY="$(jexpr "$R" 'JSON.stringify({reviewer: "e2e", decisions: d.findings.slice(0, 2).map(f => ({finding_id: f.finding_id, decision: "approve"}))})')"
api POST "/runs/$RUN_ID/approvals" "$WORK/err400.json" "$PARTIAL_BODY"
expect_code "approvals missing two decisions" 400 "$WORK/err400.json"
assert_json "400 body is ApiError DECISIONS_INCOMPLETE listing the missing findings" "$WORK/err400.json" \
  "d.error && d.error.code === 'DECISIONS_INCOMPLETE'"
api GET "/runs/$RUN_ID" "$WORK/run-after-partial.json"
assert_json "incomplete approval changed nothing (still HELD/4, findings open)" "$WORK/run-after-partial.json" \
  "d.release_state === 'HELD' && d.blocker_count === 4 && d.approval === null && d.findings.every(f => f.status === 'open')"

step "POST /runs/$RUN_ID/approvals (approve all four)"
APPROVAL_BODY="$(jexpr "$R" 'JSON.stringify({ reviewer: "e2e-local", decisions: d.findings.map(f => ({ finding_id: f.finding_id, decision: "approve" })) })')"
api POST "/runs/$RUN_ID/approvals" "$WORK/approval.json" "$APPROVAL_BODY"
expect_code "approvals" 200 "$WORK/approval.json"
A="$WORK/approval.json"
assert_json "approval: v8 approved, 4 decisions, not idempotent, 64-hex patch_hash" "$A" \
  "d.idempotent === false && d.approval.run_id === '$RUN_ID' && d.approval.reviewer === 'e2e-local' && d.approval.approved_version === 8 && d.approval.decisions.length === 4 && d.approval.decisions.every(x => x.decision === 'approve') && /^[0-9a-f]{64}$/.test(d.approval.patch_hash)"
assert_json "approval: srt {filename the-last-tram.es.v8.approved.srt, 240 cues, sha256 == patch_hash, url}" "$A" \
  "d.approval.srt.filename === 'the-last-tram.es.v8.approved.srt' && d.approval.srt.cue_count === 240 && d.approval.srt.sha256 === d.approval.patch_hash && d.approval.srt.bytes > 10000 && d.approval.srt.url.includes('/runs/$RUN_ID/export.srt')"
assert_json "approval: ingested 240 cues + 240 pairs + 1 event; run.approval set; findings approved" "$A" \
  "d.approval.ingested.subtitle_cues === 240 && d.approval.ingested.source_target_pairs === 240 && d.approval.ingested.localization_events === 1 && typeof d.approval.event_id === 'string' && d.run.approval && d.run.approval.approval_batch_id === d.approval.approval_batch_id && d.run.findings.every(f => f.status === 'approved')"
PATCH_HASH="$(jexpr "$A" 'd.approval.patch_hash')"
SRT_BYTES="$(jexpr "$A" 'd.approval.srt.bytes')"
BATCH_ID="$(jexpr "$A" 'd.approval.approval_batch_id')"
echo "       patch_hash: $PATCH_HASH ($SRT_BYTES bytes)"

api POST "/runs/$RUN_ID/approvals" "$WORK/approval2.json" "$APPROVAL_BODY"
expect_code "approvals (repeat click)" 200 "$WORK/approval2.json"
assert_json "approval: repeat is idempotent (same batch id and patch_hash, no second ingestion)" "$WORK/approval2.json" \
  "d.idempotent === true && d.approval.approval_batch_id === '$BATCH_ID' && d.approval.patch_hash === '$PATCH_HASH'"

step "GET /runs/$RUN_ID/export.srt"
HTTP_CODE="$(curl -sS --max-time 60 -D "$WORK/export.headers" -o "$WORK/export.srt" -w '%{http_code}' "$API/runs/$RUN_ID/export.srt")" || HTTP_CODE=000
expect_code "export.srt" 200 "$WORK/export.srt"
if grep -qi '^content-type: text/plain' "$WORK/export.headers"; then pass "export: content-type text/plain"; else fail "export: content-type is not text/plain: $(grep -i '^content-type' "$WORK/export.headers" | tr -d '\r')"; fi
if grep -qi '^content-disposition: attachment' "$WORK/export.headers"; then pass "export: Content-Disposition attachment"; else warn "export: Content-Disposition attachment header missing"; fi
FILE_HASH="$(sha256_of "$WORK/export.srt")"
FILE_BYTES="$(wc -c < "$WORK/export.srt" | tr -d ' ')"
if [ "$FILE_HASH" = "$PATCH_HASH" ]; then pass "export: sha256(file) == patch_hash ($FILE_HASH)"; else fail "export: sha256(file) $FILE_HASH != patch_hash $PATCH_HASH"; fi
if [ "$FILE_BYTES" = "$SRT_BYTES" ]; then pass "export: byte length matches approval.srt.bytes ($FILE_BYTES)"; else fail "export: $FILE_BYTES bytes, approval said $SRT_BYTES"; fi
if SRT_REPORT="$(node -e '
  const fs = require("fs");
  const buf = fs.readFileSync(process.argv[1]); const text = buf.toString("utf8");
  const errors = [];
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) errors.push("has a UTF-8 BOM");
  if (text.includes("\r")) errors.push("contains CR line endings");
  if (!text.endsWith("\n")) errors.push("missing trailing newline");
  if (text.endsWith("\n\n")) console.error("[WARN] export: file ends with a blank line (spec: single trailing newline)");
  const blocks = text.replace(/\n+$/, "").split("\n\n");
  if (blocks.length !== 240) errors.push("expected 240 blocks, got " + blocks.length);
  const toMs = s => { const m = /^(\d\d):(\d\d):(\d\d),(\d\d\d)$/.exec(s); return m ? ((+m[1] * 3600 + +m[2] * 60 + +m[3]) * 1000 + +m[4]) : NaN; };
  const cues = blocks.map((b, i) => { const l = b.split("\n"); const t = /^(.+) --> (.+)$/.exec(l[1] || ""); return { idx: l[0], pos: i + 1, start: t ? toMs(t[1]) : NaN, end: t ? toMs(t[2]) : NaN, text: l.slice(2).join("\n"), tc: l[1] }; });
  cues.forEach(c => { if (String(c.pos) !== c.idx) errors.push("block " + c.pos + " has index " + c.idx); if (isNaN(c.start) || isNaN(c.end)) errors.push("block " + c.idx + " bad timecode " + c.tc); });
  const by = n => cues.find(c => c.idx === String(n)) || {};
  const expectTc = (n, tc) => { if (by(n).tc !== tc) errors.push("cue " + n + " timecode " + JSON.stringify(by(n).tc) + " != " + JSON.stringify(tc)); };
  expectTc(57, "00:02:51,000 --> 00:02:53,800");
  expectTc(118, "00:05:49,000 --> 00:05:51,920");
  expectTc(119, "00:05:52,000 --> 00:05:54,600");
  expectTc(204, "00:10:11,200 --> 00:10:14,200");
  expectTc(231, "00:11:40,400 --> 00:11:42,600");
  if (by(57).text !== "Mara Voss firmó el manifiesto ella misma.") errors.push("cue 57 text " + JSON.stringify(by(57).text));
  if (by(204).text !== "Si el último tranvía se va sin nosotros, nadie sabrá dónde.") errors.push("cue 204 text " + JSON.stringify(by(204).text));
  if (!by(231).text || by(231).text === "Envialo ahora.") errors.push("cue 231 not repaired: " + JSON.stringify(by(231).text));
  if (text.includes("Maria Voss")) errors.push("still contains Maria Voss");
  // the repaired file must pass the deterministic rules everywhere
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i], n = cues[i + 1];
    if (n && c.end > n.start - 80) errors.push("cue " + c.idx + " ends " + c.end + " within 80 ms of cue " + n.idx + " start " + n.start);
    const chars = [...c.text.replace(/\n/g, "")].length; const cps = Math.round(chars / ((c.end - c.start) / 1000) * 10) / 10;
    if (cps > 20) errors.push("cue " + c.idx + " reads at " + cps + " CPS");
  }
  if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
  process.stdout.write("240 blocks, monotonic, gaps >= 80 ms, all cues <= 20 CPS; 118 -> 351,920; 204 -> 614,200; 57 = Mara Voss; 231 = " + JSON.stringify(by(231).text));
' "$WORK/export.srt")"; then pass "export: SRT content verified ($SRT_REPORT)"; else fail "export: SRT content check failed (see above)" "$WORK/export.srt"; fi
SUMMARY+=("approval: v8 ingested, patch ${PATCH_HASH:0:12}..., SRT $FILE_BYTES bytes verified")

step "POST /runs/$RUN_ID/recheck"
api POST "/runs/$RUN_ID/recheck" "$WORK/recheck-create.json" '{}'
expect_code "recheck" 202 "$WORK/recheck-create.json"
assert_json "recheck: {run_id != parent, parent_run_id, status queued, poll_url}" "$WORK/recheck-create.json" \
  "typeof d.run_id === 'string' && d.run_id !== '$RUN_ID' && d.parent_run_id === '$RUN_ID' && d.status === 'queued' && typeof d.poll_url === 'string'"
RECHECK_ID="$(jexpr "$WORK/recheck-create.json" 'd.run_id')"
echo "       recheck run_id: $RECHECK_ID"
api POST "/runs/$RUN_ID/recheck" "$WORK/recheck-create2.json" '{}'
if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "202" ]; then
  assert_json "recheck: repeat returns the existing recheck run" "$WORK/recheck-create2.json" "d.run_id === '$RECHECK_ID' && d.status === 'existing'"
else
  fail "recheck repeat -> HTTP $HTTP_CODE (expected 200/202 with status existing)" "$WORK/recheck-create2.json"
fi

step "Polling GET /runs/$RECHECK_ID until complete (timeout ${RUN_TIMEOUT}s)"
poll_run "$RECHECK_ID" "$WORK/recheck.json" "recheck"
C="$WORK/recheck.json"
assert_json "recheck: READY TO RELEASE - 0 blockers, 0 findings, v8, trigger recheck_after_approval" "$C" \
  "d.phase === 'complete' && d.release_state === 'READY' && d.blocker_count === 0 && d.finding_count === 0 && d.findings.length === 0 && d.version === 8 && d.trigger === 'recheck_after_approval' && d.parent_run_id === '$RUN_ID' && d.origin === 'release_gate'"
assert_json "recheck: real MCP proof - Q2/Q3/Q5 return 0 rows on v8, Q6 returns the corrected cue-231 pair" "$C" \
  "(function(){ const m = q => d.trace.filter(t => t.query_id === q && t.matched_expected && t.ok).pop(); return m('Q2_TIMING_OVERLAP').row_count === 0 && m('Q3_READING_SPEED').row_count === 0 && m('Q5_GLOSSARY_DRIFT').row_count === 0 && m('Q6_SEMANTIC_CANDIDATES').row_count === 1 && m('Q6_SEMANTIC_CANDIDATES').rows_preview[0].cue_id === 231 && m('Q6_SEMANTIC_CANDIDATES').rows_preview[0].target_text !== 'Envialo ahora.' && d.trace.every(t => t.database === '$E2E_DB'); })()"
assert_json "recheck: Gemini saw the corrected pair and returned MEANING_PRESERVED" "$C" \
  "d.semantic_candidates === 1 && d.semantic_review && d.semantic_review.output.verdict === 'MEANING_PRESERVED' && d.semantic_review.input.cue_id === 231 && d.semantic_review.input.target_version === 8 && d.semantic_review.input.source_text === 'Do not send it yet.'"
assert_json "recheck: agent trace present (google-adk)" "$C" "d.agent && d.agent.framework === 'google-adk' && d.agent.total_tool_calls >= 5"
api GET "/runs/$RUN_ID" "$WORK/parent.json"
expect_code "parent run" 200 "$WORK/parent.json"
assert_json "parent run links recheck_run_id and keeps its approval" "$WORK/parent.json" "d.recheck_run_id === '$RECHECK_ID' && d.approval && d.approval.patch_hash === '$PATCH_HASH'"
api GET "/demo/state" "$WORK/state2.json"
expect_code "demo state after recheck" 200 "$WORK/state2.json"
assert_json "state: READY/0 persisted, approved_version 8, attributed to the recheck run" "$WORK/state2.json" \
  "d.release.state === 'READY' && d.release.blocker_count === 0 && d.release.version === 8 && d.release.as_of_run_id === '$RECHECK_ID' && d.approved_version === 8 && d.latest_run.run_id === '$RECHECK_ID'"
SUMMARY+=("recheck: $RECHECK_ID -> READY/0 in $(jexpr "$C" 'Math.round(d.duration_ms/1000)')s (Q2/Q3/Q5 = 0 rows, Q6 -> MEANING_PRESERVED)")

step "POST /admin/reset"
api POST "/admin/reset" "$WORK/reset.json" '{}'
if [ "$HTTP_CODE" = "429" ]; then
  echo "       429 RATE_LIMITED (15 s cooldown) - retrying in 16 s"
  sleep 16
  api POST "/admin/reset" "$WORK/reset.json" '{}'
fi
expect_code "reset" 200 "$WORK/reset.json"
assert_json "reset: ok, removed counts, state back to HELD/4 seed baseline" "$WORK/reset.json" \
  "d.ok === true && typeof d.removed === 'object' && d.state.release.state === 'HELD' && d.state.release.blocker_count === 4 && d.state.release.origin === 'seed_baseline' && d.state.release.as_of_run_id === 'run_baseline_v7' && d.state.approved_version === null && d.state.latest_run.run_id === 'run_baseline_v7' && d.state.latest_run.findings.length === 4"
api GET "/demo/state" "$WORK/state3.json"
expect_code "demo state after reset" 200 "$WORK/state3.json"
assert_json "state: HELD/4 persisted after reset (reload-safe)" "$WORK/state3.json" \
  "d.release.state === 'HELD' && d.release.blocker_count === 4 && d.release.origin === 'seed_baseline' && d.approved_version === null && d.dataset.synthetic_rows_total >= 100000"
api GET "/runs/$RUN_ID" "$WORK/gone.json"
expect_code "live run removed by reset" 404 "$WORK/gone.json"
api GET "/runs/run_baseline_v7" "$WORK/baseline.json"
expect_code "baseline run restored" 200 "$WORK/baseline.json"
assert_json "baseline run: HELD/4, origin seed_baseline, no approval" "$WORK/baseline.json" \
  "d.release_state === 'HELD' && d.blocker_count === 4 && d.origin === 'seed_baseline' && d.approval === null && d.findings.length === 4"
SUMMARY+=("reset: removed $(jexpr "$WORK/reset.json" 'JSON.stringify(d.removed)') -> HELD/4 (run_baseline_v7)")
