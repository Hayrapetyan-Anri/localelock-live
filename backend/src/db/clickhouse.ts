import { createClient, type ClickHouseClient } from '@clickhouse/client';
import { getConfig } from '../config.js';

export const TABLE_NAMES = [
  'subtitle_cues',
  'source_target_pairs',
  'glossary_terms',
  'localization_events',
  'qc_findings',
  'release_runs',
  'approvals',
  'demo_meta',
  'run_budget_log',
] as const;
export type TableName = (typeof TABLE_NAMES)[number];

export const MUTABLE_TABLES: readonly TableName[] = ['release_runs', 'qc_findings', 'approvals', 'demo_meta'];

export const CH_INSERT_BATCH_SIZE = 20_000;

export const TABLE_DDL: Record<TableName, string> = {
  subtitle_cues: `CREATE TABLE IF NOT EXISTS {db}.subtitle_cues (
  title_id String, locale LowCardinality(String), cue_id UInt32, version UInt16,
  start_ms UInt32, end_ms UInt32, text String, source_revision LowCardinality(String),
  ingested_at DateTime64(3) DEFAULT now64(3)
) ENGINE = ReplacingMergeTree(ingested_at) ORDER BY (title_id, locale, version, cue_id)`,

  source_target_pairs: `CREATE TABLE IF NOT EXISTS {db}.source_target_pairs (
  title_id String, cue_id UInt32, source_text String, target_text String,
  locale LowCardinality(String), source_revision LowCardinality(String), target_version UInt16,
  previous_source_text String DEFAULT '', ingested_at DateTime64(3) DEFAULT now64(3)
) ENGINE = ReplacingMergeTree(ingested_at) ORDER BY (title_id, locale, target_version, cue_id)`,

  glossary_terms: `CREATE TABLE IF NOT EXISTS {db}.glossary_terms (
  title_id String, locale LowCardinality(String), source_term String,
  approved_target_term String, note String DEFAULT ''
) ENGINE = ReplacingMergeTree ORDER BY (title_id, locale, source_term)`,

  localization_events: `CREATE TABLE IF NOT EXISTS {db}.localization_events (
  event_id String, title_id String, locale LowCardinality(String),
  event_type LowCardinality(String), source_revision LowCardinality(String),
  target_version Nullable(UInt16), occurred_at DateTime64(3),
  summary String, actor String DEFAULT '', run_id String DEFAULT ''
) ENGINE = ReplacingMergeTree ORDER BY event_id`,

  qc_findings: `CREATE TABLE IF NOT EXISTS {db}.qc_findings (
  run_id String, finding_id String, title_id String, locale LowCardinality(String),
  version UInt16, cue_id UInt32, rule_id LowCardinality(String),
  severity LowCardinality(String), is_blocker UInt8, source LowCardinality(String),
  confidence Float64, headline String, detail String,
  evidence_json String, proposed_repair_json String, evidence_ref_json String,
  status LowCardinality(String), priority UInt8,
  created_at DateTime64(3), updated_at DateTime64(3) DEFAULT now64(3)
) ENGINE = ReplacingMergeTree(updated_at) ORDER BY finding_id`,

  release_runs: `CREATE TABLE IF NOT EXISTS {db}.release_runs (
  run_id String, title_id String, locale LowCardinality(String), version UInt16,
  trigger LowCardinality(String), trigger_event_id String DEFAULT '',
  parent_run_id String DEFAULT '', recheck_run_id String DEFAULT '',
  started_at DateTime64(3), ended_at Nullable(DateTime64(3)), duration_ms Nullable(UInt32),
  phase LowCardinality(String), phases_json String DEFAULT '[]',
  release_state LowCardinality(String), blocker_count UInt16, finding_count UInt16,
  trace_json String DEFAULT '[]', agent_json String DEFAULT '',
  semantic_review_json String DEFAULT '', semantic_candidates Nullable(UInt16),
  approval_json String DEFAULT '', error_json String DEFAULT '',
  origin LowCardinality(String), dataset_json String DEFAULT '{}',
  pipeline_lock_json String DEFAULT '', approval_lock_json String DEFAULT '',
  updated_at DateTime64(3) DEFAULT now64(3)
) ENGINE = ReplacingMergeTree(updated_at) ORDER BY run_id`,

  approvals: `CREATE TABLE IF NOT EXISTS {db}.approvals (
  approval_id String, approval_batch_id String, run_id String, cue_id UInt32,
  finding_id String, rule_id LowCardinality(String), decision LowCardinality(String),
  reviewer String, approved_at DateTime64(3), patch_hash String DEFAULT '',
  updated_at DateTime64(3) DEFAULT now64(3)
) ENGINE = ReplacingMergeTree(updated_at) ORDER BY (run_id, finding_id)`,

  run_budget_log: `CREATE TABLE IF NOT EXISTS {db}.run_budget_log (
  run_id String, title_id String, locale LowCardinality(String),
  trigger LowCardinality(String), started_at DateTime64(3) DEFAULT now64(3)
) ENGINE = MergeTree ORDER BY started_at TTL toDateTime(started_at) + INTERVAL 7 DAY`,

  demo_meta: `CREATE TABLE IF NOT EXISTS {db}.demo_meta (
  id String, seeded_at DateTime64(3), seed_version String,
  last_reset_at Nullable(DateTime64(3)), dataset_stats_json String DEFAULT '{}',
  t0 DateTime64(3), release_at DateTime64(3), seed_duration_ms UInt32 DEFAULT 0,
  updated_at DateTime64(3) DEFAULT now64(3)
) ENGINE = ReplacingMergeTree(updated_at) ORDER BY id`,
};

export interface QueryOptions {
  final?: boolean;
  settings?: Record<string, unknown>;
  abortSignal?: AbortSignal;
}

export type QueryParams = Record<string, unknown>;

let clientPromise: Promise<ClickHouseClient> | null = null;
let schemaEnsured: Promise<void> | null = null;
let cachedDatabase: string | null = null;

async function buildClient(): Promise<ClickHouseClient> {
  const cfg = await getConfig();
  cachedDatabase = cfg.clickhouse.database;
  return createClient({
    url: cfg.clickhouse.url,
    username: cfg.clickhouse.user,
    password: cfg.clickhouse.password,
    database: cfg.clickhouse.database,
    application: 'localelock-app',
    request_timeout: 60_000,
    max_open_connections: 10,
    compression: { response: true, request: false },
    clickhouse_settings: {
      date_time_input_format: 'best_effort',
    },
  });
}

export function getClient(): Promise<ClickHouseClient> {
  if (!clientPromise) {
    clientPromise = buildClient().catch((err) => {
      clientPromise = null;
      throw err;
    });
  }
  return clientPromise;
}

export async function databaseName(): Promise<string> {
  if (cachedDatabase) return cachedDatabase;
  const cfg = await getConfig();
  cachedDatabase = cfg.clickhouse.database;
  return cachedDatabase;
}

export async function qualified(table: TableName): Promise<string> {
  return `${await databaseName()}.${table}`;
}

async function withDb(params?: QueryParams): Promise<QueryParams> {
  return { db: await databaseName(), ...(params ?? {}) };
}

function settingsFor(opts?: QueryOptions): Record<string, unknown> | undefined {
  const s: Record<string, unknown> = {};
  if (opts?.final) s.final = 1;
  if (opts?.settings) Object.assign(s, opts.settings);
  return Object.keys(s).length ? s : undefined;
}

export async function query<T = Record<string, unknown>>(sql: string, params?: QueryParams, opts?: QueryOptions): Promise<T[]> {
  const client = await getClient();
  const rs = await client.query({
    query: sql,
    format: 'JSONEachRow',
    query_params: await withDb(params),
    clickhouse_settings: settingsFor(opts) as never,
    abort_signal: opts?.abortSignal,
  });
  return (await rs.json<T>()) as T[];
}

export async function queryOne<T = Record<string, unknown>>(sql: string, params?: QueryParams, opts?: QueryOptions): Promise<T | null> {
  const rows = await query<T>(sql, params, opts);
  return rows.length ? rows[0] : null;
}

export async function queryScalar<T = unknown>(sql: string, params?: QueryParams, opts?: QueryOptions): Promise<T | null> {
  const row = await queryOne<Record<string, T>>(sql, params, opts);
  if (!row) return null;
  const keys = Object.keys(row);
  return keys.length ? row[keys[0]] : null;
}

export async function command(sql: string, params?: QueryParams, opts?: QueryOptions): Promise<void> {
  const client = await getClient();
  await client.command({
    query: sql,
    query_params: await withDb(params),
    clickhouse_settings: settingsFor(opts) as never,
    abort_signal: opts?.abortSignal,
  });
}

export async function insertRows(table: TableName, rows: ReadonlyArray<Record<string, unknown>>): Promise<number> {
  if (rows.length === 0) return 0;
  const client = await getClient();
  for (let i = 0; i < rows.length; i += CH_INSERT_BATCH_SIZE) {
    const chunk = rows.slice(i, i + CH_INSERT_BATCH_SIZE);
    await client.insert({
      table,
      values: chunk,
      format: 'JSONEachRow',
      clickhouse_settings: { date_time_input_format: 'best_effort' },
    });
  }
  return rows.length;
}

export async function deleteWhere(table: TableName, whereSql: string, params?: QueryParams): Promise<void> {
  const db = await databaseName();
  await command(`DELETE FROM ${db}.${table} WHERE ${whereSql}`, params);
}

export async function countWhere(table: TableName, whereSql = '1', params?: QueryParams): Promise<number> {
  const db = await databaseName();
  const fin = MUTABLE_TABLES.includes(table) ? ' FINAL' : '';
  const row = await queryOne<{ n: string | number }>(`SELECT count() AS n FROM ${db}.${table}${fin} WHERE ${whereSql}`, params);
  return row ? Number(row.n) : 0;
}

async function bootstrapDatabase(db: string): Promise<void> {
  const cfg = await getConfig();
  const boot = createClient({
    url: cfg.clickhouse.url,
    username: cfg.clickhouse.user,
    password: cfg.clickhouse.password,
    application: 'localelock-app-bootstrap',
    request_timeout: 30_000,
  });
  try {
    await boot.command({ query: `CREATE DATABASE IF NOT EXISTS ${db}` });
  } catch (err) {
    const rs = await boot
      .query({ query: `SELECT count() AS n FROM system.databases WHERE name = {db:String}`, format: 'JSONEachRow', query_params: { db } })
      .then((r) => r.json<{ n: string | number }>())
      .catch(() => [] as Array<{ n: string | number }>);
    const exists = rs.length > 0 && Number(rs[0].n) > 0;
    if (!exists) throw err;
  } finally {
    await boot.close().catch(() => undefined);
  }
}

export function ensureSchema(force = false): Promise<void> {
  if (schemaEnsured && !force) return schemaEnsured;
  schemaEnsured = (async () => {
    const db = await databaseName();
    await bootstrapDatabase(db);
    for (const table of TABLE_NAMES) {
      await command(TABLE_DDL[table].replace(/\{db\}/g, db));
    }
  })().catch((err) => {
    schemaEnsured = null;
    throw err;
  });
  return schemaEnsured;
}

export async function truncateAll(): Promise<void> {
  const db = await databaseName();
  for (const table of TABLE_NAMES) {
    await command(`TRUNCATE TABLE IF EXISTS ${db}.${table}`);
  }
}

export async function tableCounts(): Promise<Record<TableName, number>> {
  const db = await databaseName();
  const parts = TABLE_NAMES.map((t) => {
    const fin = MUTABLE_TABLES.includes(t) ? ' FINAL' : '';
    return `SELECT '${t}' AS table, toUInt64(count()) AS rows FROM ${db}.${t}${fin}`;
  });
  const rows = await query<{ table: TableName; rows: string | number }>(parts.join(' UNION ALL '));
  const out = {} as Record<TableName, number>;
  for (const t of TABLE_NAMES) out[t] = 0;
  for (const r of rows) out[r.table] = Number(r.rows);
  return out;
}

export async function clickhouseVersion(): Promise<string> {
  const row = await queryOne<{ v: string }>('SELECT version() AS v');
  return row?.v ?? 'unknown';
}

export interface ClickHousePing {
  ok: boolean;
  latency_ms: number | null;
  version: string | null;
  error: string | null;
}

export async function pingClickHouse(): Promise<ClickHousePing> {
  const started = Date.now();
  try {
    const row = await queryOne<{ v: string }>('SELECT version() AS v');
    return { ok: true, latency_ms: Date.now() - started, version: row?.v ?? null, error: null };
  } catch (err) {
    return { ok: false, latency_ms: Date.now() - started, version: null, error: errorMessage(err) };
  }
}

export async function closeClickHouse(): Promise<void> {
  const p = clientPromise;
  clientPromise = null;
  schemaEnsured = null;
  cachedDatabase = null;
  if (!p) return;
  try {
    await (await p).close();
  } catch {
  }
}

export function resetClickHouseCache(): void {
  clientPromise = null;
  schemaEnsured = null;
  cachedDatabase = null;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function parseJsonColumn<T>(raw: string | null | undefined, fallback: T): T {
  if (raw === null || raw === undefined || raw === '') return fallback;
  try {
    const v = JSON.parse(raw) as T;
    return v === null ? fallback : v;
  } catch {
    return fallback;
  }
}

export function toJsonColumn(value: unknown): string {
  if (value === null || value === undefined) return '';
  return JSON.stringify(value);
}

export function quoteLiteral(value: string | number | boolean): string {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('quoteLiteral: non-finite number');
    return String(value);
  }
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value !== 'string') {
    throw new TypeError(`quoteLiteral: unsupported value type ${value === null ? 'null' : typeof value}`);
  }
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

export function toUInt8(value: boolean): number {
  return value ? 1 : 0;
}

export function fromUInt8(value: number | string | boolean | null | undefined): boolean {
  return value === 1 || value === '1' || value === true;
}

export function toIso(value: string | number | Date | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number') return new Date(value).toISOString();
  const normalised = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(value) ? `${value.replace(' ', 'T')}Z` : value;
  const d = new Date(normalised);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
