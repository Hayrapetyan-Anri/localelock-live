import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, type StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';
import { getConfig, type AppConfig } from '../config.js';
import { MCP_SERVER_NAME } from '../domain/constants.js';

export const MCP_TOOLS_ALLOWED = ['list_databases', 'list_tables', 'run_query'] as const;
export type McpAllowedTool = (typeof MCP_TOOLS_ALLOWED)[number];

let cachedServerVersion = 'unknown';

export function mcpServerVersion(): string {
  return cachedServerVersion;
}

export function rememberServerVersion(v: string | undefined | null): void {
  if (v) cachedServerVersion = v;
}

export function buildMcpServerParams(config: AppConfig): StdioServerParameters & { stderr: 'pipe' } {
  const ch = config.clickhouse;
  return {
    command: config.mcpServerCommand,
    args: [],
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: '/tmp',
      CLICKHOUSE_HOST: ch.host,
      CLICKHOUSE_PORT: String(ch.port),
      CLICKHOUSE_USER: ch.agentUser,
      CLICKHOUSE_PASSWORD: ch.agentPassword,
      CLICKHOUSE_SECURE: ch.secure ? 'true' : 'false',
      CLICKHOUSE_VERIFY: ch.verify ? 'true' : 'false',
      CLICKHOUSE_DATABASE: ch.database,
      CLICKHOUSE_ALLOW_WRITE_ACCESS: 'false',
      CLICKHOUSE_MCP_SERVER_TRANSPORT: 'stdio',
    },
    stderr: 'pipe',
  };
}

export class StderrRing {
  private lines: string[] = [];
  constructor(private readonly max = 40) {}
  push(chunk: string): void {
    for (const line of chunk.split(/\r?\n/)) {
      const l = line.trim();
      if (!l) continue;
      this.lines.push(l.length > 400 ? `${l.slice(0, 400)}…` : l);
      if (this.lines.length > this.max) this.lines.shift();
    }
  }
  tail(n = 5): string[] {
    return this.lines.slice(-n);
  }
  get size(): number {
    return this.lines.length;
  }
}

export interface McpClientHandle {
  client: Client;
  transport: StdioClientTransport;
  stderr: StderrRing;
  pid: number | null;
  serverVersion: string;
  close(): Promise<void>;
}

export async function createMcpClient(config?: AppConfig): Promise<McpClientHandle> {
  const cfg = config ?? (await getConfig());
  const params = buildMcpServerParams(cfg);
  const transport = new StdioClientTransport(params);
  const stderr = new StderrRing();
  transport.stderr?.on('data', (d: Buffer | string) => stderr.push(d.toString()));
  const client = new Client({ name: 'localelock-live', version: '0.1.0' }, { capabilities: {} });
  try {
    await client.connect(transport);
  } catch (err) {
    await transport.close().catch(() => undefined);
    const tail = stderr.tail(3).join(' | ');
    throw new Error(`MCP server failed to start: ${(err as Error).message}${tail ? ` - stderr: ${tail}` : ''}`);
  }
  const serverVersion = client.getServerVersion()?.version ?? mcpServerVersion();
  rememberServerVersion(serverVersion);
  let closed = false;
  return {
    client,
    transport,
    stderr,
    pid: transport.pid,
    serverVersion,
    async close() {
      if (closed) return;
      closed = true;
      await client.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
    },
  };
}

export interface ParsedToolResult {
  rows: unknown[];
  count: number;
  isError: boolean;
  errorText: string | null;
}

function coerce(value: unknown): unknown {
  if (typeof value !== 'string' || value === '') return value;
  if (/^-?\d+(\.\d+)?$/.test(value)) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return value;
}

function zipRows(columns: unknown, rows: unknown): Record<string, unknown>[] {
  if (!Array.isArray(columns) || !Array.isArray(rows)) return [];
  const names = columns.map((c) => String(c));
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    if (Array.isArray(row)) {
      names.forEach((name, i) => {
        out[name] = coerce(row[i]);
      });
    } else if (row && typeof row === 'object') {
      for (const [k, v] of Object.entries(row as Record<string, unknown>)) out[k] = coerce(v);
    }
    return out;
  });
}

function shapePayload(payload: unknown): unknown[] | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  if ('columns' in p && 'rows' in p) return zipRows(p.columns, p.rows);
  if (Array.isArray(p.tables)) return p.tables as unknown[];
  if (Array.isArray(p.databases)) return (p.databases as unknown[]).map((d) => (typeof d === 'string' ? { name: d } : d));
  if (Array.isArray(p.result)) return p.result as unknown[];
  return null;
}

function parsePayloadString(text: string): unknown[] | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return shapePayload(JSON.parse(trimmed));
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return shapePayload(JSON.parse(trimmed.slice(start, end + 1)));
      } catch {
        return null;
      }
    }
    return null;
  }
}

export function parseMcpToolResult(result: unknown): ParsedToolResult {
  const r = (result ?? {}) as {
    content?: Array<{ type?: string; text?: string }>;
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  };
  const texts = (r.content ?? []).filter((c) => c.type === 'text' && typeof c.text === 'string').map((c) => c.text as string);
  if (r.isError) return { rows: [], count: 0, isError: true, errorText: texts.join('\n') || 'tool error' };

  const sc = r.structuredContent;
  if (sc && typeof sc === 'object') {
    if (typeof sc.result === 'string') {
      const rows = parsePayloadString(sc.result);
      if (rows) return { rows, count: rows.length, isError: false, errorText: null };
    }
    const direct = shapePayload(sc);
    if (direct) return { rows: direct, count: direct.length, isError: false, errorText: null };
  }
  for (const t of texts) {
    const rows = parsePayloadString(t);
    if (rows) return { rows, count: rows.length, isError: false, errorText: null };
  }
  return { rows: [], count: 0, isError: false, errorText: null };
}

export async function callMcpTool(handle: McpClientHandle, tool: string, args: Record<string, unknown>, timeoutMs = 60_000): Promise<{ raw: unknown; parsed: ParsedToolResult; duration_ms: number }> {
  const started = Date.now();
  const raw = await handle.client.callTool({ name: tool, arguments: { ...args } }, undefined, { timeout: timeoutMs });
  return { raw, parsed: parseMcpToolResult(raw), duration_ms: Date.now() - started };
}

export interface McpProbeResult {
  ok: boolean;
  version: string;
  tools: string[];
  latency_ms: number;
  error: string | null;
  server: typeof MCP_SERVER_NAME;
}

export async function probeMcpServer(opts: { timeoutMs?: number; config?: AppConfig } = {}): Promise<McpProbeResult> {
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const cfg = opts.config ?? (await getConfig());
  let handle: McpClientHandle | null = null;
  let timer: NodeJS.Timeout | null = null;
  try {
    const work = (async () => {
      handle = await createMcpClient(cfg);
      const list = await handle.client.listTools({}, { timeout: timeoutMs });
      return list.tools.map((t) => t.name).sort();
    })();
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`MCP probe timed out after ${timeoutMs} ms`)), timeoutMs);
    });
    const tools = await Promise.race([work, timeout]);
    const h = handle as McpClientHandle | null;
    return { ok: true, version: h?.serverVersion ?? mcpServerVersion(), tools, latency_ms: Date.now() - started, error: null, server: MCP_SERVER_NAME };
  } catch (err) {
    const h = handle as McpClientHandle | null;
    const tail = h?.stderr.tail(2).join(' | ');
    return {
      ok: false,
      version: mcpServerVersion(),
      tools: [],
      latency_ms: Date.now() - started,
      error: `${(err as Error).message}${tail ? ` - ${tail}` : ''}`,
      server: MCP_SERVER_NAME,
    };
  } finally {
    if (timer) clearTimeout(timer);
    const h = handle as McpClientHandle | null;
    if (h) await h.close();
  }
}
