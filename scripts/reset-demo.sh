#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${LOCALELOCK_ENV_FILE:-$HOME/.localelock/.env}"
STACK_NAME="${STACK_NAME:-localelock-live}"
SSM_PREFIX="${SSM_PREFIX:-/localelock-live}"
MODE=env API_URL="${LOCALELOCK_API_URL:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --local) MODE=local; shift ;;
    --remote) MODE=remote; shift ;;
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
      log "Resetting hero demo on local ClickHouse (db $CLICKHOUSE_DATABASE)"
    else
      [ -n "${CLICKHOUSE_HOST:-}" ] || die "CLICKHOUSE_HOST is not set"
      log "Resetting hero demo on $CLICKHOUSE_HOST (db ${CLICKHOUSE_DATABASE:-localelock})"
    fi
    npm --prefix "$ROOT/backend" run reset
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
    HEADERS=(-H 'content-type: application/json')
    [ -n "$KEY" ] && HEADERS+=(-H "X-Demo-Key: $KEY")

    log "POST $API_URL/admin/reset"
    BODY="$(mktemp)"; trap 'rm -f "$BODY"' EXIT
    CODE="$(curl -sS -o "$BODY" -w '%{http_code}' -X POST "${HEADERS[@]}" --data '{}' "$API_URL/admin/reset")"
    case "$CODE" in
      200)
        node -e '
          const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
          const r = d.state && d.state.release || {};
          console.log("    release: " + r.state + " / " + r.blocker_count + " blockers (origin " + r.origin + ", run " + r.as_of_run_id + ")");
          console.log("    removed: " + JSON.stringify(d.removed));
          console.log("    release_at: " + (d.state && d.state.delivery && d.state.delivery.release_at));
        ' "$BODY"
        ;;
      429) echo "    HTTP 429 RATE_LIMITED - reset cooldown is 15 s; try again shortly"; exit 1 ;;
      401) echo "    HTTP 401 UNAUTHORIZED - RESET_REQUIRES_KEY=true on this stack; set DEMO_ADMIN_KEY in $ENV_FILE"; exit 1 ;;
      *) echo "    HTTP $CODE: $(head -c 400 "$BODY")"; exit 1 ;;
    esac
    ;;
esac
