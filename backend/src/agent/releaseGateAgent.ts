import { InMemoryRunner, LlmAgent, getFunctionCalls } from '@google/adk';
import type { Event } from '@google/adk';
import { APP_NAME, RELEASE_GATE_AGENT_NAME, MCP_SERVER_NAME, type AgentTrace, type QueryId, type ToolTraceEntry } from '../domain/constants.js';
import {
  buildInstruction,
  matchTraceEntry,
  mcpArgsFor,
  missingQueries,
  sanitizeToolArgs,
  type QueryPlan,
  type QueryPlanEntry,
} from '../domain/queries.js';
import type { AppConfig } from '../config.js';
import { getBuildInfo } from '../config.js';
import { makeGeminiModel, summarizeGeminiError } from './gemini.js';
import { parseMcpToolResult } from './mcp.js';
import type { PooledMcpToolset } from './pooledToolset.js';

const MAX_ROWS_PREVIEW = 10;

export interface GateAgentOptions {
  plan: QueryPlan;
  database: string;
  config: AppConfig;
  pool: PooledMcpToolset;
  onTrace?: (entry: ToolTraceEntry) => Promise<void> | void;
  timeoutMs?: number;
}

export interface GateAgentResult {
  agent: AgentTrace;
  entries: ToolTraceEntry[];
  rowsByQuery: Map<QueryId, unknown[]>;
}

export function rowsFor(result: GateAgentResult, id: QueryId): unknown[] {
  return result.rowsByQuery.get(id) ?? [];
}

export async function executeQueryPlanWithAgent(opts: GateAgentOptions): Promise<GateAgentResult> {
  const { plan, database, config, pool } = opts;
  const build = getBuildInfo();
  const backend = config.gemini.backend ?? 'vertex-ai';
  const started = new Date();
  const entries: ToolTraceEntry[] = [];
  const warnings: string[] = [];
  let step = 0;

  const fullRows = new Map<number, unknown[]>();

  const push = async (entry: ToolTraceEntry, rows: unknown[]): Promise<void> => {
    entries.push(entry);
    fullRows.set(entry.step, rows);
    await opts.onTrace?.(entry);
  };

  const { serverVersion } = await pool.warmup();

  const pending = new Map<string, number>();
  const keyOf = (tool: string, args: unknown): string => `${tool}:${JSON.stringify(args ?? {})}`;

  const agent = new LlmAgent({
    name: RELEASE_GATE_AGENT_NAME,
    description: 'Executes the LocaleLock deterministic release-gate query plan through the official ClickHouse MCP server.',
    model: makeGeminiModel(config),
    instruction: buildInstruction(plan, database),
    tools: [pool.toolset],
    generateContentConfig: { temperature: 0 },
    beforeToolCallback: ({ tool, args }) => {
      pending.set(keyOf(tool.name, args), Date.now());
      return undefined;
    },
    afterToolCallback: ({ tool, args, response }) => {
      const key = keyOf(tool.name, args);
      const startedAt = pending.get(key) ?? Date.now();
      pending.delete(key);
      const { entry, rows } = buildTraceEntry({
        step: ++step,
        initiator: 'adk_agent',
        tool: tool.name,
        args,
        response,
        startedAtMs: startedAt,
        plan,
        database,
        serverVersion,
      });
      void Promise.resolve(push(entry, rows)).catch(() => undefined);
      return undefined;
    },
  });

  const runner = new InMemoryRunner({ agent, appName: APP_NAME });
  const session = await runner.sessionService.createSession({ appName: APP_NAME, userId: 'release-gate' });

  let llmTurns = 0;
  let finalText: string | null = null;
  const agentStarted = Date.now();
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for await (const ev of runner.runAsync({
      userId: 'release-gate',
      sessionId: session.id,
      newMessage: { role: 'user', parts: [{ text: 'Execute the release-gate query plan now.' }] },
      abortSignal: controller.signal,
    })) {
      const e = ev as Event;
      if (e.author !== agent.name) continue;
      const text = (e.content?.parts ?? []).map((p) => p.text ?? '').join('').trim();
      if (text || getFunctionCalls(e).length > 0) llmTurns += 1;
      if (text) finalText = text;
    }
  } catch (err) {
    const message = controller.signal.aborted
      ? `Release-gate agent timed out after ${timeoutMs} ms`
      : summarizeGeminiError(err);
    warnings.push(`Agent turn failed: ${message}. The application executed the query plan directly over the same MCP connection.`);
  } finally {
    clearTimeout(timer);
  }

  await new Promise((r) => setImmediate(r));

  const matched = entries.filter((e) => e.matched_expected).map((e) => e.query_id);
  const missing = missingQueries(plan, matched);
  for (const entry of missing) {
    const startedAtMs = Date.now();
    let response: unknown;
    try {
      const res = await pool.callTool(entry.tool, entry.args);
      response = res.raw;
    } catch (err) {
      response = { isError: true, content: [{ type: 'text', text: (err as Error).message }] };
    }
    const built = buildTraceEntry({
      step: ++step,
      initiator: 'app_fallback',
      tool: entry.tool,
      args: mcpArgsFor(entry),
      response,
      startedAtMs,
      plan,
      database,
      serverVersion,
    });
    await push(built.entry, built.rows);
    warnings.push(`${entry.label} (${entry.query_id}) was not executed exactly by the agent; the application ran it over the same official MCP connection.`);
  }

  const rowsByQuery = collectRows(entries, fullRows, plan);

  const agentTrace: AgentTrace = {
    framework: 'google-adk',
    adk_version: build.adk_version,
    genai_sdk_version: build.genai_sdk_version,
    model: config.gemini.model,
    backend,
    project: backend === 'vertex-ai' ? config.gemini.project : null,
    location: backend === 'vertex-ai' ? config.gemini.location : null,
    app_name: APP_NAME,
    session_id: session.id,
    agent_name: RELEASE_GATE_AGENT_NAME,
    llm_turns: llmTurns,
    total_tool_calls: entries.length,
    started_at: started.toISOString(),
    duration_ms: Date.now() - agentStarted,
    final_text: finalText,
    warnings,
  };

  return { agent: agentTrace, entries, rowsByQuery };
}

interface BuildTraceInput {
  step: number;
  initiator: 'adk_agent' | 'app_fallback';
  tool: string;
  args: unknown;
  response: unknown;
  startedAtMs: number;
  plan: QueryPlan;
  database: string;
  serverVersion: string;
}

export function buildTraceEntry(input: BuildTraceInput): { entry: ToolTraceEntry; rows: unknown[] } {
  const parsed = parseMcpToolResult(input.response);
  const match = matchTraceEntry(input.plan, input.tool, input.args);
  const sanitized = sanitizeToolArgs(input.args);
  const collection = typeof sanitized.collection === 'string' ? sanitized.collection : match.collection;
  const entry: ToolTraceEntry = {
    step: input.step,
    kind: 'mcp_tool_call',
    initiator: input.initiator,
    server: MCP_SERVER_NAME,
    server_version: input.serverVersion,
    tool: input.tool,
    query_id: match.query_id,
    database: typeof sanitized.database === 'string' ? sanitized.database : input.database,
    collection,
    query_summary: match.summary,
    query: sanitized,
    started_at: new Date(input.startedAtMs).toISOString(),
    duration_ms: Math.max(0, Date.now() - input.startedAtMs),
    ok: !parsed.isError,
    error: parsed.isError ? (parsed.errorText ?? 'tool error') : null,
    row_count: parsed.count,
    rows_preview: parsed.rows.slice(0, MAX_ROWS_PREVIEW),
    matched_expected: match.matched_expected,
  };
  return { entry, rows: parsed.rows };
}

export function collectRows(entries: ToolTraceEntry[], fullRows: Map<number, unknown[]>, plan: QueryPlan): Map<QueryId, unknown[]> {
  const out = new Map<QueryId, unknown[]>();
  const byId = new Map<QueryId, ToolTraceEntry>();
  for (const e of entries) {
    if (!e.query_id || !e.ok || !e.matched_expected) continue;
    const prev = byId.get(e.query_id);
    if (!prev || e.step > prev.step) byId.set(e.query_id, e);
  }
  for (const p of plan as QueryPlanEntry[]) {
    const e = byId.get(p.query_id);
    if (e) out.set(p.query_id, fullRows.get(e.step) ?? e.rows_preview);
  }
  return out;
}
