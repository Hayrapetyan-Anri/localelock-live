import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type GeminiBackend = 'vertex-ai' | 'gemini-api';

export interface ClickHouseSettings {
  host: string;
  port: number;
  secure: boolean;
  verify: boolean;
  database: string;
  user: string;
  password: string;
  agentUser: string;
  agentPassword: string;
  agentFallback: boolean;
  url: string;
}

export interface AppConfig {
  mode: 'lambda' | 'local';
  region: string | null;
  functionName: string | null;
  workerFunctionName: string | null;
  ssmPrefix: string;
  clickhouse: ClickHouseSettings;
  gemini: {
    configured: boolean;
    backend: GeminiBackend | null;
    project: string | null;
    location: string;
    model: string;
    apiKey: string | null;
    credentialsPath: string | null;
  };
  demoAdminKey: string | null;
  resetRequiresKey: boolean;
  port: number;
  publicRepoUrl: string | null;
  appUrl: string | null;
  mcpServerCommand: string;
  backendRoot: string;
  sources: Record<string, string>;
}

const HERE = dirname(fileURLToPath(import.meta.url));

export function backendRoot(): string {
  return resolve(HERE, '..');
}

function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

function isLambda(): boolean {
  return !!process.env.AWS_LAMBDA_FUNCTION_NAME;
}

const SSM_KEYS = [
  'clickhouse-host',
  'clickhouse-user',
  'clickhouse-password',
  'clickhouse-agent-user',
  'clickhouse-agent-password',
  'gcp-sa-json',
  'demo-admin-key',
  'gemini-api-key',
] as const;

async function loadFromSsm(prefix: string): Promise<Record<string, string>> {
  const names = SSM_KEYS.map((n) => `${prefix}/${n}`);
  const { SSMClient, GetParametersCommand } = await import('@aws-sdk/client-ssm');
  const client = new SSMClient({});
  const res = await client.send(new GetParametersCommand({ Names: names, WithDecryption: true }));
  const out: Record<string, string> = {};
  for (const p of res.Parameters ?? []) {
    if (!p.Name || p.Value === undefined) continue;
    const key = p.Name.slice(prefix.length + 1);
    out[key] = p.Value;
  }
  return out;
}

function writeSaJson(json: string): string {
  const path = '/tmp/gcp-sa.json';
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, json, { mode: 0o600 });
  return path;
}

function parseBool(v: string | undefined, dflt: boolean): boolean {
  if (v === undefined || v === '') return dflt;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

function resolveMcpServerCommand(root: string, lambda: boolean): string {
  const explicit = process.env.MCP_CLICKHOUSE_BIN;
  if (explicit && explicit !== '') return explicit;
  const imagePaths = ['/usr/local/bin/mcp-clickhouse', '/var/lang/bin/mcp-clickhouse', '/usr/bin/mcp-clickhouse'];
  for (const p of imagePaths) if (existsSync(p)) return p;
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (!dir) continue;
    const p = join(dir, 'mcp-clickhouse');
    if (existsSync(p)) return p;
  }
  const venv = join(root, '.venv', 'bin', 'mcp-clickhouse');
  if (existsSync(venv)) return venv;
  return lambda ? imagePaths[0] : 'mcp-clickhouse';
}

let cached: Promise<AppConfig> | null = null;

export function getConfig(): Promise<AppConfig> {
  if (!cached)
    cached = resolveConfig().catch((err) => {
      cached = null;
      throw err;
    });
  return cached;
}

export function resetConfigCache(): void {
  cached = null;
}

async function resolveConfig(): Promise<AppConfig> {
  const lambda = isLambda();
  const sources: Record<string, string> = {};

  const fileValues: Record<string, string> = {};
  if (!lambda) {
    const primary = process.env.LOCALELOCK_ENV_FILE ?? join(homedir(), '.localelock', '.env');
    Object.assign(fileValues, parseEnvFile(primary));
    for (const [k, v] of Object.entries(parseEnvFile(resolve(process.cwd(), '.env')))) if (!(k in fileValues)) fileValues[k] = v;
  }

  const envHost = process.env.CLICKHOUSE_HOST;
  const hostOverridden = !!envHost && envHost !== '' && !!fileValues.CLICKHOUSE_HOST && fileValues.CLICKHOUSE_HOST !== envHost;

  const get = (key: string): string | undefined => {
    if (process.env[key] !== undefined && process.env[key] !== '') {
      sources[key] = 'env';
      return process.env[key];
    }
    if (hostOverridden && key.startsWith('CLICKHOUSE_')) {
      sources[key] = 'default:host-override';
      return undefined;
    }
    if (fileValues[key] !== undefined && fileValues[key] !== '') {
      sources[key] = 'file';
      return fileValues[key];
    }
    return undefined;
  };

  const ssmPrefix = get('SSM_PREFIX') ?? '/localelock-live';
  let chHost = get('CLICKHOUSE_HOST');
  let chUser = get('CLICKHOUSE_USER');
  let chPassword = get('CLICKHOUSE_PASSWORD');
  let chAgentUser = get('CLICKHOUSE_AGENT_USER');
  let chAgentPassword = get('CLICKHOUSE_AGENT_PASSWORD');
  let demoAdminKey = get('DEMO_ADMIN_KEY');
  let geminiApiKey = get('GEMINI_API_KEY');
  let credentialsPath = get('GOOGLE_APPLICATION_CREDENTIALS');
  let saLoaded = false;

  if (lambda && !chHost) {
    const ssm = await loadFromSsm(ssmPrefix);
    const take = (param: string, envName: string, current: string | undefined): string | undefined => {
      if (current || !ssm[param]) return current;
      sources[envName] = 'ssm';
      return ssm[param];
    };
    chHost = take('clickhouse-host', 'CLICKHOUSE_HOST', chHost);
    chUser = take('clickhouse-user', 'CLICKHOUSE_USER', chUser);
    chPassword = take('clickhouse-password', 'CLICKHOUSE_PASSWORD', chPassword);
    chAgentUser = take('clickhouse-agent-user', 'CLICKHOUSE_AGENT_USER', chAgentUser);
    chAgentPassword = take('clickhouse-agent-password', 'CLICKHOUSE_AGENT_PASSWORD', chAgentPassword);
    demoAdminKey = take('demo-admin-key', 'DEMO_ADMIN_KEY', demoAdminKey);
    geminiApiKey = take('gemini-api-key', 'GEMINI_API_KEY', geminiApiKey);
    if (ssm['gcp-sa-json']) {
      credentialsPath = writeSaJson(ssm['gcp-sa-json']);
      saLoaded = true;
      sources.GOOGLE_APPLICATION_CREDENTIALS = 'ssm';
    }
  }

  const saB64 = get('GOOGLE_SA_JSON_B64');
  if (saB64 && !saLoaded) {
    credentialsPath = writeSaJson(Buffer.from(saB64, 'base64').toString('utf8'));
    saLoaded = true;
    sources.GOOGLE_APPLICATION_CREDENTIALS = 'env:b64';
  }

  if (!chHost) throw new Error('CLICKHOUSE_HOST is not configured (env, env file, or SSM)');

  const secure = parseBool(get('CLICKHOUSE_SECURE'), true);
  if (!sources.CLICKHOUSE_SECURE) sources.CLICKHOUSE_SECURE = 'default';
  const portRaw = get('CLICKHOUSE_PORT');
  const port = portRaw ? Number(portRaw) : secure ? 8443 : 8123;
  if (!Number.isFinite(port) || port <= 0) throw new Error('CLICKHOUSE_PORT must be a positive number');
  if (!sources.CLICKHOUSE_PORT) sources.CLICKHOUSE_PORT = 'default';

  const database = get('CLICKHOUSE_DATABASE') ?? 'localelock';
  if (!sources.CLICKHOUSE_DATABASE) sources.CLICKHOUSE_DATABASE = 'default';
  const user = chUser ?? 'default';
  if (!sources.CLICKHOUSE_USER) sources.CLICKHOUSE_USER = 'default';
  const password = chPassword ?? '';
  if (!sources.CLICKHOUSE_PASSWORD) sources.CLICKHOUSE_PASSWORD = 'default';
  const verify = parseBool(get('CLICKHOUSE_VERIFY'), secure);
  if (!sources.CLICKHOUSE_VERIFY) sources.CLICKHOUSE_VERIFY = 'default';

  const agentFallback = !chAgentUser;
  const agentUser = chAgentUser ?? user;
  const agentPassword = chAgentUser ? chAgentPassword ?? '' : password;
  if (agentFallback) sources.CLICKHOUSE_AGENT_USER = `default:${sources.CLICKHOUSE_USER ?? 'default'}`;

  const project = get('GOOGLE_CLOUD_PROJECT') ?? null;
  const location = get('GOOGLE_CLOUD_LOCATION') ?? 'us-central1';
  const model = get('GEMINI_MODEL') ?? 'gemini-2.5-flash';

  const hasCreds = saLoaded || (!!credentialsPath && existsSync(credentialsPath));
  let backend: GeminiBackend | null = null;
  if (hasCreds && project) backend = 'vertex-ai';
  else if (geminiApiKey) backend = 'gemini-api';

  if (hasCreds && credentialsPath) {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialsPath;
  }
  if (project && !process.env.GOOGLE_CLOUD_PROJECT) process.env.GOOGLE_CLOUD_PROJECT = project;

  const root = backendRoot();
  const resetRequiresKey = /^(1|true|yes)$/i.test(get('RESET_REQUIRES_KEY') ?? '');

  return {
    mode: lambda ? 'lambda' : 'local',
    region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? null,
    functionName: process.env.AWS_LAMBDA_FUNCTION_NAME ?? null,
    workerFunctionName: get('WORKER_FUNCTION_NAME') ?? null,
    ssmPrefix,
    clickhouse: {
      host: chHost,
      port,
      secure,
      verify,
      database,
      user,
      password,
      agentUser,
      agentPassword,
      agentFallback,
      url: `${secure ? 'https' : 'http'}://${chHost}:${port}`,
    },
    gemini: {
      configured: backend !== null,
      backend,
      project: backend === 'vertex-ai' ? project : project ?? null,
      location,
      model,
      apiKey: backend === 'gemini-api' ? geminiApiKey ?? null : null,
      credentialsPath: hasCreds ? credentialsPath ?? null : null,
    },
    demoAdminKey: demoAdminKey ?? null,
    resetRequiresKey,
    port: Number(get('PORT') ?? 8787),
    publicRepoUrl: get('PUBLIC_REPO_URL') ?? null,
    appUrl: get('APP_URL') ?? null,
    mcpServerCommand: resolveMcpServerCommand(root, lambda),
    backendRoot: root,
    sources,
  };
}

export function hostHint(hostOrUrl: string | null | undefined): string | null {
  if (!hostOrUrl) return null;
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(hostOrUrl) ? hostOrUrl : `http://${hostOrUrl}`;
    const h = new URL(withScheme).hostname;
    return h || null;
  } catch {
    const first = hostOrUrl.split('/')[0];
    const bare = first.split('@').pop() ?? first;
    const name = bare.split(':')[0];
    return name || null;
  }
}

export const clickhouseHostHint = hostHint;

export interface BuildInfo {
  version: string;
  adk_version: string;
  genai_sdk_version: string;
  mcp_clickhouse_version: string;
  git_sha: string | null;
  built_at: string | null;
}

let buildInfoCache: BuildInfo | null = null;

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function venvMcpClickhouseVersion(root: string): string | null {
  const libRoot = join(root, '.venv', 'lib');
  try {
    for (const py of readdirSync(libRoot)) {
      const sp = join(libRoot, py, 'site-packages');
      if (!existsSync(sp)) continue;
      for (const entry of readdirSync(sp)) {
        const m = /^mcp_clickhouse-(.+)\.dist-info$/.exec(entry);
        if (m) return m[1];
      }
    }
  } catch {
  }
  return null;
}

export function getBuildInfo(): BuildInfo {
  if (buildInfoCache) return buildInfoCache;
  const root = backendRoot();
  const candidates = [join(HERE, 'build-info.json'), join(root, 'artifact', 'build-info.json'), join(root, 'build-info.json')];
  for (const c of candidates) {
    const j = readJson(c);
    if (j && typeof j.adk_version === 'string') {
      buildInfoCache = {
        version: String(j.version ?? '0.1.0'),
        adk_version: String(j.adk_version),
        genai_sdk_version: String(j.genai_sdk_version ?? 'unknown'),
        mcp_clickhouse_version: String(j.mcp_clickhouse_version ?? 'unknown'),
        git_sha: (j.git_sha as string | null) ?? null,
        built_at: (j.built_at as string | null) ?? null,
      };
      return buildInfoCache;
    }
  }
  const pkg = (p: string) => readJson(join(root, 'node_modules', p, 'package.json'));
  const own = readJson(join(root, 'package.json'));
  buildInfoCache = {
    version: String(own?.version ?? '0.1.0'),
    adk_version: String(pkg('@google/adk')?.version ?? 'unknown'),
    genai_sdk_version: String(pkg('@google/genai')?.version ?? 'unknown'),
    mcp_clickhouse_version: process.env.MCP_CLICKHOUSE_VERSION ?? venvMcpClickhouseVersion(root) ?? 'unknown',
    git_sha: null,
    built_at: null,
  };
  return buildInfoCache;
}
