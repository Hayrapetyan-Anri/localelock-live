import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { PooledMcpToolset } from '../src/agent/pooledToolset.js';
import { buildQueryPlan, mcpArgsFor } from '../src/domain/queries.js';
import { getConfig, type AppConfig } from '../src/config.js';
import { closeClickHouse, countWhere } from '../src/db/clickhouse.js';
import { HERO_LOCALE, HERO_VERSION, LATEST_SOURCE_REVISION, TITLE_ID } from '../src/domain/constants.js';

let config: AppConfig | null = null;
let ready = false;
let skipReason = '';

before(async () => {
  try {
    config = await getConfig();
  } catch (err) {
    skipReason = `config unavailable: ${(err as Error).message}`;
    return;
  }
  if (!existsSync(config.mcpServerCommand)) {
    skipReason = `mcp-clickhouse not found at ${config.mcpServerCommand} - set MCP_CLICKHOUSE_BIN or create backend/.venv`;
    return;
  }
  try {
    const cues = await countWhere(
      'subtitle_cues',
      'title_id = {title_id:String} AND locale = {locale:String} AND version = {version:UInt16}',
      { title_id: TITLE_ID, locale: HERO_LOCALE, version: HERO_VERSION },
    );
    if (cues === 0) {
      skipReason = `database ${config.clickhouse.database} has no hero cues - run: npm run seed -- --force`;
      return;
    }
    ready = true;
  } catch (err) {
    skipReason = `ClickHouse not reachable: ${(err as Error).message}`;
  }
});

after(async () => {
  await closeClickHouse().catch(() => undefined);
});

describe('PooledMcpToolset', () => {
  it('serves many ADK tool calls from a single mcp-clickhouse process', async (t) => {
    if (!ready || !config) return t.skip(skipReason || 'prerequisites missing');
    const pool = await PooledMcpToolset.create({ config });
    try {
      const { pid } = await pool.warmup();
      assert.ok(pid && pid > 0, 'expected a spawned mcp-clickhouse pid');

      const tools = await pool.toolset.getTools();
      assert.deepEqual(
        tools.map((tool) => tool.name).sort(),
        ['list_databases', 'list_tables', 'run_query'],
        'the official server exposes exactly these three tools',
      );

      const runQuery = tools.find((tool) => tool.name === 'run_query');
      assert.ok(runQuery, 'run_query should be exposed');
      const toolContext = { abortSignal: undefined } as unknown as Parameters<typeof runQuery.runAsync>[0]['toolContext'];
      for (let i = 0; i < 3; i++) {
        const res = (await runQuery.runAsync({
          args: { query: `SELECT count() AS n FROM ${config.clickhouse.database}.subtitle_cues` },
          toolContext,
        })) as { isError?: boolean };
        assert.notEqual(res.isError, true, 'ADK tool call through the pool should succeed');
      }

      assert.ok(pool.sessionRequests >= 4, `expected at least 4 session requests, got ${pool.sessionRequests}`);
      assert.equal(pool.pid, pid, 'pid must not change across calls');
    } finally {
      await pool.shutdown();
    }
  });

  it('refuses writes - the agent boundary is enforced by ClickHouse itself', async (t) => {
    if (!ready || !config) return t.skip(skipReason || 'prerequisites missing');
    const pool = await PooledMcpToolset.create({ config });
    try {
      const res = await pool.callTool('run_query', {
        query: `CREATE TABLE ${config.clickhouse.database}.should_not_exist (x UInt8) ENGINE = Memory`,
      });
      assert.equal(res.parsed.isError, true, 'a DDL statement must be refused');
      assert.match(
        String(res.parsed.errorText),
        /readonly|read-only|Not enough privileges|ACCESS_DENIED/i,
        'the refusal must come from ClickHouse (readonly session or missing grant)',
      );
      const leaked = await countWhere('subtitle_cues', '1 = 0');
      assert.equal(leaked, 0, 'sanity: the count query still works after the refusal');
    } finally {
      await pool.shutdown();
    }
  });
});

describe('query plan over MCP returns the hero evidence', () => {
  it('Q1..Q6 produce exactly the four hero rows', async (t) => {
    if (!ready || !config) return t.skip(skipReason || 'prerequisites missing');
    const plan = buildQueryPlan({
      title_id: TITLE_ID,
      locale: HERO_LOCALE,
      version: HERO_VERSION,
      source_revision: LATEST_SOURCE_REVISION,
      database: config.clickhouse.database,
    });
    const pool = await PooledMcpToolset.create({ config });
    try {
      const rows = new Map<string, unknown[]>();
      for (const entry of plan) {
        const res = await pool.callTool(entry.tool, mcpArgsFor(entry));
        assert.equal(res.parsed.isError, false, `${entry.label} failed: ${res.parsed.errorText}`);
        rows.set(entry.query_id, res.parsed.rows);
      }

      const q1 = rows.get('Q1_LIST_TABLES') as Array<{ name?: string }>;
      assert.ok(q1.some((c) => c.name === 'subtitle_cues'), 'Q1 should list subtitle_cues');

      const q2 = rows.get('Q2_TIMING_OVERLAP') as Array<{ cue_id: number; next_cue_id: number; overlap_ms: number }>;
      assert.equal(q2.length, 1, 'exactly one overlap in v7');
      assert.equal(Number(q2[0].cue_id), 118);
      assert.equal(Number(q2[0].next_cue_id), 119);
      assert.equal(Number(q2[0].overlap_ms), 420);

      const q3 = rows.get('Q3_READING_SPEED') as Array<{ cue_id: number; cps: number; chars: number }>;
      assert.equal(q3.length, 1, 'exactly one reading-speed violation in v7');
      assert.equal(Number(q3[0].cue_id), 204);
      assert.equal(Number(q3[0].cps), 24.6);
      assert.equal(Number(q3[0].chars), 59);

      const q4 = rows.get('Q4_GLOSSARY_TERMS') as Array<{ source_term: string }>;
      assert.ok(q4.some((g) => g.source_term === 'Mara Voss'), 'Q4 should return the approved glossary');

      const q5 = rows.get('Q5_GLOSSARY_DRIFT') as Array<{ cue_id: number; target_text: string }>;
      assert.equal(q5.length, 1, 'exactly one glossary drift in v7');
      assert.equal(Number(q5[0].cue_id), 57);
      assert.match(q5[0].target_text, /Maria Voss/);

      const q6 = rows.get('Q6_SEMANTIC_CANDIDATES') as Array<{ cue_id: number; source_text: string; target_text: string }>;
      assert.equal(q6.length, 1, 'exactly one narrowed semantic candidate');
      assert.equal(Number(q6[0].cue_id), 231);
      assert.equal(q6[0].source_text, 'Do not send it yet.');
      assert.equal(q6[0].target_text, 'Envialo ahora.');
    } finally {
      await pool.shutdown();
    }
  });
});
