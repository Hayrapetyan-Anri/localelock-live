#!/usr/bin/env bash
set -euo pipefail

SSM_PREFIX="${SSM_PREFIX:-/localelock-live}"
ENV_FILE="${LOCALELOCK_ENV_FILE:-$HOME/.localelock/.env}"

while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) SSM_PREFIX="$2"; shift 2 ;;
    --region) export AWS_REGION="$2"; export AWS_DEFAULT_REGION="$2"; shift 2 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

log() { printf '\n==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

command -v aws >/dev/null 2>&1 || die "aws CLI not found"
command -v node >/dev/null 2>&1 || die "node not found"

if [ -f "$ENV_FILE" ]; then
  log "Loading environment from $ENV_FILE"
  set -a
  source "$ENV_FILE"
  set +a
else
  log "No env file at $ENV_FILE (using the current environment only)"
fi

REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-$(aws configure get region 2>/dev/null || true)}}"
[ -n "$REGION" ] || die "no AWS region configured (set AWS_REGION or run: aws configure)"
export AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION"

[ -n "${CLICKHOUSE_HOST:-}" ] || die "CLICKHOUSE_HOST is not set in $ENV_FILE"
[ -n "${CLICKHOUSE_USER:-}" ] || die "CLICKHOUSE_USER is not set in $ENV_FILE"
[ -n "${CLICKHOUSE_PASSWORD:-}" ] || die "CLICKHOUSE_PASSWORD is not set in $ENV_FILE"
CLICKHOUSE_AGENT_USER="${CLICKHOUSE_AGENT_USER:-$CLICKHOUSE_USER}"
CLICKHOUSE_AGENT_PASSWORD="${CLICKHOUSE_AGENT_PASSWORD:-$CLICKHOUSE_PASSWORD}"
SA_FILE="${GOOGLE_APPLICATION_CREDENTIALS:-$HOME/.localelock/gcp-sa.json}"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

put_secret() {
  local name="$1" tier="$2" json="$TMP_DIR/param.json"
  ( umask 077; node -e '
      const fs = require("fs");
      const [name, tier, out] = process.argv.slice(1);
      const value = fs.readFileSync(0, "utf8").replace(/\r?\n$/, "");
      if (!value) { console.error("empty value for " + name); process.exit(1); }
      fs.writeFileSync(out, JSON.stringify({ Name: name, Type: "SecureString", Value: value, Overwrite: true, Tier: tier }), { mode: 0o600 });
    ' "$name" "$tier" "$json" )
  aws ssm put-parameter --cli-input-json "file://$json" --output text --query Version >/dev/null
  rm -f "$json"
  printf '   wrote %s (SecureString, %s tier)\n' "$name" "$tier"
}

param_exists() { aws ssm get-parameter --name "$1" --query Parameter.Name --output text >/dev/null 2>&1; }

log "Writing SecureString parameters under $SSM_PREFIX in $REGION"

printf '%s' "$CLICKHOUSE_HOST"           | put_secret "$SSM_PREFIX/clickhouse-host" Standard
printf '%s' "$CLICKHOUSE_USER"           | put_secret "$SSM_PREFIX/clickhouse-user" Standard
printf '%s' "$CLICKHOUSE_PASSWORD"       | put_secret "$SSM_PREFIX/clickhouse-password" Standard
printf '%s' "$CLICKHOUSE_AGENT_USER"     | put_secret "$SSM_PREFIX/clickhouse-agent-user" Standard
printf '%s' "$CLICKHOUSE_AGENT_PASSWORD" | put_secret "$SSM_PREFIX/clickhouse-agent-password" Standard

if [ -f "$SA_FILE" ]; then
  SA_BYTES=$(wc -c < "$SA_FILE" | tr -d ' ')
  TIER=Standard
  [ "$SA_BYTES" -le 4000 ] || TIER=Advanced
  node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$SA_FILE" \
    || die "$SA_FILE is not valid JSON"
  put_secret "$SSM_PREFIX/gcp-sa-json" "$TIER" < "$SA_FILE"
else
  echo "   skip gcp-sa-json: no service-account file at $SA_FILE (Vertex AI will be unconfigured)"
fi

if [ -n "${DEMO_ADMIN_KEY:-}" ]; then
  printf '%s' "$DEMO_ADMIN_KEY" | put_secret "$SSM_PREFIX/demo-admin-key" Standard
elif param_exists "$SSM_PREFIX/demo-admin-key"; then
  echo "   keep demo-admin-key: already in SSM and DEMO_ADMIN_KEY is unset (read it with:"
  echo "        aws ssm get-parameter --with-decryption --name $SSM_PREFIX/demo-admin-key --query Parameter.Value --output text)"
else
  GENERATED_KEY="$(node -e 'process.stdout.write(require("crypto").randomBytes(24).toString("hex"))')"
  printf '%s' "$GENERATED_KEY" | put_secret "$SSM_PREFIX/demo-admin-key" Standard
  echo
  echo "   Generated a new DEMO_ADMIN_KEY (shown once - add it to $ENV_FILE to keep using it):"
  echo "   DEMO_ADMIN_KEY=$GENERATED_KEY"
  echo
fi

if [ -n "${GEMINI_API_KEY:-}" ]; then
  printf '%s' "$GEMINI_API_KEY" | put_secret "$SSM_PREFIX/gemini-api-key" Standard
else
  echo "   skip gemini-api-key: GEMINI_API_KEY not set (Vertex AI is the primary backend)"
fi

log "Done. Parameters under $SSM_PREFIX:"
aws ssm describe-parameters \
  --parameter-filters "Key=Name,Option=BeginsWith,Values=$SSM_PREFIX/" \
  --query 'Parameters[].[Name,Type,Tier,LastModifiedDate]' --output table
