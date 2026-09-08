#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${LOCALELOCK_ENV_FILE:-$HOME/.localelock/.env}"
STACK_NAME="${STACK_NAME:-localelock-live}"
SSM_PREFIX="${SSM_PREFIX:-/localelock-live}"
MODE=env FORCE=0 API_URL="${LOCALELOCK_API_URL:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --local) MODE=local; shift ;;
    --remote) MODE=remote; shift ;;
    --force) FORCE=1; shift ;;
    --api) API_URL="$2"; shift 2 ;;
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

log() { printf '\n==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

if [ -f "$ENV_FILE" ]; then
  set -a
  source "$ENV_FILE"
  set +a
fi

case "$MODE" in
  env|local)
    command -v npm >/dev/null 2>&1 || die "npm is required"
    [ -d "$ROOT/backend/node_modules" ] || die "backend dependencies missing - run: npm --prefix backend install"
    if [ "$MODE" = local ]; then
      export CLICKHOUSE_HOST="127.0.0.1"
      export CLICKHOUSE_PORT="8123"
      export CLICKHOUSE_SECURE="false"
      export CLICKHOUSE_USER="default"
      export CLICKHOUSE_PASSWORD="${CLICKHOUSE_LOCAL_PASSWORD:-localdev}"
      export CLICKHOUSE_AGENT_USER="default"
      export CLICKHOUSE_AGENT_PASSWORD="${CLICKHOUSE_LOCAL_PASSWORD:-localdev}"
      export CLICKHOUSE_DATABASE="${CLICKHOUSE_DB_LOCAL:-localelock}"
      log "Seeding local ClickHouse (db $CLICKHOUSE_DATABASE)"
    else
      [ -n "${CLICKHOUSE_HOST:-}" ] || die "CLICKHOUSE_HOST is not set"
      log "Seeding ClickHouse host '$CLICKHOUSE_HOST' (db ${CLICKHOUSE_DATABASE:-localelock})"
    fi
    ARGS=()
    [ "$FORCE" -eq 1 ] && ARGS+=(--force)
    START=$(date +%s)
    if [ ${#ARGS[@]} -gt 0 ]; then
      npm --prefix "$ROOT/backend" run seed -- "${ARGS[@]}"
    else
      npm --prefix "$ROOT/backend" run seed
    fi
    echo "    seed finished in $(( $(date +%s) - START )) s"
    ;;

  remote)
    command -v curl >/dev/null 2>&1 || die "curl is required"
    command -v node >/dev/null 2>&1 || die "node is required"
    if [ -z "$API_URL" ]; then
      command -v aws >/dev/null 2>&1 || die "pass --api URL (aws CLI not available to read stack outputs)"
      API_URL="$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
        --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" --output text 2>/dev/null || true)"
      [ -n "$API_URL" ] && [ "$API_URL" != "None" ] || die "could not resolve the API URL - pass --api URL"
    fi
    API_URL="${API_URL%/}"
    KEY="${DEMO_ADMIN_KEY:-}"
    if [ -z "$KEY" ] && command -v aws >/dev/null 2>&1; then
      KEY="$(aws ssm get-parameter --with-decryption --name "$SSM_PREFIX/demo-admin-key" \
        --query Parameter.Value --output text 2>/dev/null || true)"
      [ "$KEY" != "None" ] || KEY=""
    fi
    [ -n "$KEY" ] || die "DEMO_ADMIN_KEY not set and not found in SSM ($SSM_PREFIX/demo-admin-key) - run scripts/put-secrets.sh"

    log "POST $API_URL/admin/seed"
    STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    BODY="$(mktemp)"; trap 'rm -f "$BODY"' EXIT
    CODE="$(curl -sS -o "$BODY" -w '%{http_code}' -X POST -H "X-Demo-Key: $KEY" -H 'content-type: application/json' \
      --data '{}' "$API_URL/admin/seed")"
    if [ "$CODE" != "202" ]; then
      echo "    HTTP $CODE: $(head -c 400 "$BODY")"
      [ "$CODE" = "401" ] && echo "    hint: the key in ~/.localelock/.env must match SSM $SSM_PREFIX/demo-admin-key (redeploy after changing it)"
      [ "$CODE" = "503" ] && echo "    hint: no demo key configured on the API - run scripts/put-secrets.sh and redeploy"
      exit 1
    fi
    echo "    queued on the worker (seed started after $STARTED_AT)"

    log "Polling $API_URL/admin/seed/status (up to 10 min)"
    DEADLINE=$(( $(date +%s) + 600 ))
    while :; do
      sleep 5
      if curl -sS -o "$BODY" "$API_URL/admin/seed/status"; then
        STATUS="$(node -e '
          const fs = require("fs");
          const [file, since] = process.argv.slice(1);
          let d; try { d = JSON.parse(fs.readFileSync(file, "utf8")); } catch { process.stdout.write("pending"); process.exit(0); }
          const meta = (d && (d.demo_meta || d.meta || d)) || {};
          const seededAt = meta.seeded_at || null;
          const total = meta.dataset_stats && meta.dataset_stats.synthetic_rows_total;
          if (seededAt && seededAt >= since) process.stdout.write("done " + seededAt + " rows=" + (total ?? "?") + " seed_version=" + (meta.seed_version ?? "?"));
          else process.stdout.write("pending" + (seededAt ? " (last seeded_at " + seededAt + ")" : ""));
        ' "$BODY" "$STARTED_AT")"
      else
        STATUS="pending (status endpoint unreachable)"
      fi
      printf '    %s  %s\n' "$(date +%H:%M:%S)" "$STATUS"
      case "$STATUS" in done*) break ;; esac
      [ "$(date +%s)" -lt "$DEADLINE" ] || die "seed did not finish within 10 minutes - check: aws logs tail /aws/lambda/$STACK_NAME-worker"
    done
    log "Seed complete. Verify with: curl -s '$API_URL/demo/state' | node -p 'const d=JSON.parse(require(\"fs\").readFileSync(0,\"utf8\")); d.release.state+\" / \"+d.release.blocker_count+\" blockers, rows=\"+d.dataset.synthetic_rows_total'"
    ;;
esac
