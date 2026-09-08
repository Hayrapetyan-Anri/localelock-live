#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STACK_NAME="${STACK_NAME:-localelock-live}"
SSM_PREFIX="${SSM_PREFIX:-/localelock-live}"
ENV_FILE="${LOCALELOCK_ENV_FILE:-$HOME/.localelock/.env}"
SKIP_SECRETS=0 SKIP_BACKEND=0 SKIP_FRONTEND=0

while [ $# -gt 0 ]; do
  case "$1" in
    --stack) STACK_NAME="$2"; shift 2 ;;
    --region) export AWS_REGION="$2"; export AWS_DEFAULT_REGION="$2"; shift 2 ;;
    --skip-secrets) SKIP_SECRETS=1; shift ;;
    --skip-backend) SKIP_BACKEND=1; shift ;;
    --skip-frontend) SKIP_FRONTEND=1; shift ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

log() { printf '\n==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required but not installed"; }

need aws; need node; need npm
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "node >= 20 required (found $(node --version))"

if [ -f "$ENV_FILE" ]; then
  log "Loading environment from $ENV_FILE"
  set -a
  source "$ENV_FILE"
  set +a
else
  log "No env file at $ENV_FILE - using the current environment"
fi
[ -n "${CLICKHOUSE_HOST:-}" ] || die "CLICKHOUSE_HOST is not set"
[ -n "${CLICKHOUSE_PASSWORD:-}" ] || die "CLICKHOUSE_PASSWORD is not set"

REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-$(aws configure get region 2>/dev/null || true)}}"
[ -n "$REGION" ] || die "no AWS region configured (set AWS_REGION or run: aws configure)"
export AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
[ -n "$ACCOUNT" ] && [ "$ACCOUNT" != "None" ] || die "aws sts get-caller-identity failed - are you logged in?"
echo "    account: $ACCOUNT   region: $REGION   stack: $STACK_NAME   ssm prefix: $SSM_PREFIX"

CLICKHOUSE_DATABASE="${CLICKHOUSE_DATABASE:-localelock}"
CLICKHOUSE_PORT="${CLICKHOUSE_PORT:-8443}"
CLICKHOUSE_SECURE="${CLICKHOUSE_SECURE:-true}"
GOOGLE_CLOUD_PROJECT="${GOOGLE_CLOUD_PROJECT:-}"
GOOGLE_CLOUD_LOCATION="${GOOGLE_CLOUD_LOCATION:-us-central1}"
GEMINI_MODEL="${GEMINI_MODEL:-gemini-2.5-flash}"
RESET_REQUIRES_KEY="${RESET_REQUIRES_KEY:-false}"
if [ -z "${PUBLIC_REPO_URL:-}" ]; then
  PUBLIC_REPO_URL="$(git -C "$ROOT" remote get-url origin 2>/dev/null | sed -E 's#git@github\.com:#https://github.com/#; s#\.git$##')"
fi
PUBLIC_REPO_URL="${PUBLIC_REPO_URL:-}"
[ -n "$PUBLIC_REPO_URL" ] || echo "    WARNING: PUBLIC_REPO_URL is empty - /judge will not link the source repository"
STAGE="${STAGE:-prod}"
[ -n "$GOOGLE_CLOUD_PROJECT" ] || echo "    warning: GOOGLE_CLOUD_PROJECT is empty - Gemini/Vertex AI will report 'not configured'"

if [ "$SKIP_SECRETS" -eq 0 ]; then
  log "Writing secrets to SSM Parameter Store ($SSM_PREFIX/*)"
  SSM_PREFIX="$SSM_PREFIX" LOCALELOCK_ENV_FILE="$ENV_FILE" bash "$ROOT/scripts/put-secrets.sh"
else
  log "Skipping secrets (--skip-secrets)"
fi

if [ "$SKIP_BACKEND" -eq 0 ]; then
  log "Building backend artifact (backend/scripts/build.sh)"
  [ -f "$ROOT/backend/scripts/build.sh" ] || die "backend/scripts/build.sh not found"
  [ -d "$ROOT/backend/node_modules" ] || npm --prefix "$ROOT/backend" install
  bash "$ROOT/backend/scripts/build.sh"
else
  log "Skipping backend build (--skip-backend)"
fi
for f in api.mjs worker.mjs; do
  [ -f "$ROOT/backend/artifact/$f" ] || die "backend/artifact/$f missing - build failed?"
done
echo "    artifact size: $(du -sh "$ROOT/backend/artifact" | cut -f1)"

ECR_REPO="${ECR_REPO:-localelock-live}"
ECR_REGISTRY="${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com"
# The tag must reflect the CONTENT being deployed, not just the commit: with a
# dirty tree, a commit-only tag pushes different bytes to the same tag, the
# ImageUri parameter never changes, and CloudFormation leaves Lambda on the old
# image - a silent no-op deploy.
IMAGE_CONTENT_HASH="$(cat "$ROOT/backend/artifact/api.mjs" "$ROOT/backend/artifact/worker.mjs" "$ROOT/backend/Dockerfile" 2>/dev/null | shasum -a 256 | cut -c1-12)"
IMAGE_TAG="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo nogit)-${IMAGE_CONTENT_HASH}"
IMAGE_URI="${ECR_REGISTRY}/${ECR_REPO}:${IMAGE_TAG}"

log "Ensuring ECR repository $ECR_REPO"
aws ecr describe-repositories --repository-names "$ECR_REPO" --region "$REGION" >/dev/null 2>&1 \
  || aws ecr create-repository --repository-name "$ECR_REPO" --region "$REGION" \
       --image-scanning-configuration scanOnPush=true >/dev/null

log "Building and pushing $IMAGE_URI (linux/amd64)"
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$ECR_REGISTRY" >/dev/null 2>&1 \
  || die "docker login to ECR failed"
docker build --platform linux/amd64 --provenance=false --sbom=false -t "$IMAGE_URI" "$ROOT/backend" >/dev/null || die "docker build failed"
docker push "$IMAGE_URI" >/dev/null || die "docker push failed"
echo "    image: $IMAGE_URI ($(docker images "$IMAGE_URI" --format '{{.Size}}'))"

ARTIFACT_BUCKET="localelock-live-artifacts-${ACCOUNT}-${REGION}"
log "Ensuring artifact bucket s3://$ARTIFACT_BUCKET"
if aws s3api head-bucket --bucket "$ARTIFACT_BUCKET" >/dev/null 2>&1; then
  echo "    exists"
else
  if [ "$REGION" = "us-east-1" ]; then
    aws s3api create-bucket --bucket "$ARTIFACT_BUCKET" >/dev/null
  else
    aws s3api create-bucket --bucket "$ARTIFACT_BUCKET" \
      --create-bucket-configuration "LocationConstraint=$REGION" >/dev/null
  fi
  aws s3api put-public-access-block --bucket "$ARTIFACT_BUCKET" --public-access-block-configuration \
    'BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true'
  aws s3api put-bucket-encryption --bucket "$ARTIFACT_BUCKET" --server-side-encryption-configuration \
    '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
  aws s3api put-bucket-lifecycle-configuration --bucket "$ARTIFACT_BUCKET" --lifecycle-configuration \
    '{"Rules":[{"ID":"expire-old-artifacts","Status":"Enabled","Filter":{"Prefix":""},"Expiration":{"Days":30}}]}'
  echo "    created (private, encrypted, 30-day expiry)"
fi

log "Packaging infra/template.yaml -> infra/packaged.yaml"
aws cloudformation package \
  --template-file "$ROOT/infra/template.yaml" \
  --s3-bucket "$ARTIFACT_BUCKET" \
  --s3-prefix "$STACK_NAME" \
  --output-template-file "$ROOT/infra/packaged.yaml" >/dev/null

PARAMS_FILE="$(mktemp)"
trap 'rm -f "$PARAMS_FILE"' EXIT
node -e '
  const [out, ...kv] = process.argv.slice(1);
  const params = kv.map(s => { const i = s.indexOf("="); return { ParameterKey: s.slice(0, i), ParameterValue: s.slice(i + 1) }; });
  require("fs").writeFileSync(out, JSON.stringify(params));
' "$PARAMS_FILE" \
  "SsmPrefix=$SSM_PREFIX" \
  "ClickHouseDatabase=$CLICKHOUSE_DATABASE" \
  "ClickHousePort=$CLICKHOUSE_PORT" \
  "ClickHouseSecure=$CLICKHOUSE_SECURE" \
  "ImageUri=$IMAGE_URI" \
  "GoogleCloudProject=$GOOGLE_CLOUD_PROJECT" \
  "GoogleCloudLocation=$GOOGLE_CLOUD_LOCATION" \
  "GeminiModel=$GEMINI_MODEL" \
  "ResetRequiresKey=$RESET_REQUIRES_KEY" \
  "PublicRepoUrl=$PUBLIC_REPO_URL" \
  "Stage=$STAGE"

log "Deploying stack $STACK_NAME in $REGION (first run creates CloudFront: allow 5-10 min)"
aws cloudformation deploy \
  --template-file "$ROOT/infra/packaged.yaml" \
  --stack-name "$STACK_NAME" \
  --capabilities CAPABILITY_IAM CAPABILITY_AUTO_EXPAND \
  --no-fail-on-empty-changeset \
  --parameter-overrides "file://$PARAMS_FILE"

log "Reading stack outputs"
output() {
  aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}
API_URL="$(output ApiUrl)"
FRONTEND_URL="$(output FrontendUrl)"
FRONTEND_BUCKET="$(output FrontendBucket)"
DISTRIBUTION_ID="$(output DistributionId)"
WORKER_FUNCTION_NAME="$(output WorkerFunctionName)"
API_FUNCTION_NAME="$(output ApiFunctionName)"
for v in API_URL FRONTEND_URL FRONTEND_BUCKET DISTRIBUTION_ID; do
  [ -n "${!v}" ] && [ "${!v}" != "None" ] || die "stack output for $v is empty"
done
echo "    ApiUrl=$API_URL"
echo "    FrontendBucket=$FRONTEND_BUCKET  DistributionId=$DISTRIBUTION_ID"
echo "    ApiFunction=$API_FUNCTION_NAME  WorkerFunction=$WORKER_FUNCTION_NAME"

if [ "$SKIP_FRONTEND" -eq 0 ]; then
  log "Building frontend with VITE_API_BASE=/api (served through CloudFront; origin $API_URL)"
  [ -d "$ROOT/frontend/node_modules" ] || npm --prefix "$ROOT/frontend" install
  VITE_API_BASE="/api" npm --prefix "$ROOT/frontend" run build
  [ -f "$ROOT/frontend/dist/index.html" ] || die "frontend/dist/index.html missing - build failed?"

  log "Syncing frontend/dist -> s3://$FRONTEND_BUCKET"
  aws s3 sync "$ROOT/frontend/dist" "s3://$FRONTEND_BUCKET" --delete \
    --exclude index.html \
    --cache-control 'public,max-age=31536000,immutable'
  aws s3 cp "$ROOT/frontend/dist/index.html" "s3://$FRONTEND_BUCKET/index.html" \
    --cache-control 'no-cache' --content-type 'text/html; charset=utf-8'

  log "Invalidating CloudFront distribution $DISTRIBUTION_ID (/*)"
  INVALIDATION_ID="$(aws cloudfront create-invalidation --distribution-id "$DISTRIBUTION_ID" --paths '/*' \
    --query Invalidation.Id --output text)"
  echo "    invalidation: $INVALIDATION_ID (propagates in ~1-2 min)"
else
  log "Skipping frontend build/sync (--skip-frontend)"
fi

cat <<SUMMARY

==> Deployed

    App:    $FRONTEND_URL
    Judge:  $FRONTEND_URL/judge
    API:    $API_URL

    Next steps:
      1. Seed ClickHouse (once, ~1 min; requires DEMO_ADMIN_KEY):
           scripts/seed.sh --remote --api $API_URL
      2. Check runtime health (ClickHouse, mcp-clickhouse, Gemini/ADK):
           curl -s "$API_URL/health?deep=1" | node -p 'JSON.stringify(JSON.parse(require("fs").readFileSync(0,"utf8")),null,2)'
      3. Open the app and click "Run release gate". Reset between takes:
           scripts/reset-demo.sh --remote --api $API_URL
      4. Logs:
           aws logs tail /aws/lambda/$STACK_NAME-worker --follow
SUMMARY
