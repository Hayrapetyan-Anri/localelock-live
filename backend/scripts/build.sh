#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

rm -rf artifact
mkdir -p artifact

echo "[build] bundling handlers with esbuild"
node esbuild.config.mjs

node - <<'NODE'
const fs = require('node:fs');
const { execSync } = require('node:child_process');
const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
let git_sha = null;
try { git_sha = execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null; } catch {}
const info = {
  version: read('package.json').version,
  adk_version: read('node_modules/@google/adk/package.json').version,
  genai_sdk_version: read('node_modules/@google/genai/package.json').version,
  mcp_clickhouse_version: process.env.MCP_CLICKHOUSE_VERSION || '0.6.0',
  clickhouse_client_version: read('node_modules/@clickhouse/client/package.json').version,
  mcp_sdk_version: read('node_modules/@modelcontextprotocol/sdk/package.json').version,
  node_target: 'nodejs22.x',
  git_sha,
  built_at: new Date().toISOString(),
};
fs.writeFileSync('artifact/build-info.json', JSON.stringify(info, null, 2) + '\n');
console.log('[build] build-info.json', JSON.stringify(info));
NODE

echo "[build] artifact sizes:"
du -sh artifact artifact/api.mjs artifact/worker.mjs
