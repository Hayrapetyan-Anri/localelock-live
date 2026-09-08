import { quoteLiteral } from '../db/clickhouse.js';
import { type GlossaryRow } from './rules.js';
import { QUERY_ORDER, type QueryId } from './constants.js';

export type McpToolName = 'list_databases' | 'list_tables' | 'run_query';

export interface QueryPlanEntry {
  query_id: QueryId;
  label: string;
  tool: McpToolName;
  collection: string | null;
  args: Record<string, unknown>;
  summary: string;
}

export interface QueryPlanInput {
  title_id: string;
  locale: string;
  version: number;
  source_revision: string;
  glossary?: GlossaryRow[];
  database: string;
  title_name?: string;
}

export type QueryPlan = QueryPlanEntry[];

export function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').replace(/;\s*$/, '').trim();
}

export function buildQueryPlan(input: QueryPlanInput): QueryPlan {
  const { title_id: T, locale: L, version: V, source_revision: R, database: DB } = input;
  const label = `${input.title_name ?? T} / ${L} / v${V}`;
  const t = quoteLiteral(T);
  const l = quoteLiteral(L);
  const scope = `title_id = ${t} AND locale = ${l}`;

  const q2 = normalizeSql(`
    SELECT cue_id, start_ms, end_ms, next_cue_id, next_start_ms, end_ms - next_start_ms AS overlap_ms
    FROM (
      SELECT cue_id, start_ms, end_ms,
             leadInFrame(cue_id)   OVER w AS next_cue_id,
             leadInFrame(start_ms) OVER w AS next_start_ms
      FROM ${DB}.subtitle_cues
      WHERE ${scope} AND version = ${V}
      WINDOW w AS (ORDER BY start_ms ASC ROWS BETWEEN CURRENT ROW AND 1 FOLLOWING)
    )
    WHERE next_cue_id != 0 AND end_ms > next_start_ms
    ORDER BY overlap_ms DESC`);

  const q3 = normalizeSql(`
    SELECT cue_id, start_ms, end_ms, text,
           lengthUTF8(replaceAll(text, '\\n', '')) AS chars,
           end_ms - start_ms AS duration_ms,
           round(chars / (duration_ms / 1000), 1) AS cps
    FROM ${DB}.subtitle_cues
    WHERE ${scope} AND version = ${V} AND cps > 20
    ORDER BY cps DESC`);

  const q4 = normalizeSql(`
    SELECT source_term, approved_target_term
    FROM ${DB}.glossary_terms
    WHERE ${scope}
    ORDER BY source_term
    LIMIT 50`);

  const q5 = normalizeSql(`
    SELECT p.cue_id AS cue_id, p.source_text AS source_text, p.target_text AS target_text
    FROM ${DB}.source_target_pairs AS p
    INNER JOIN ${DB}.glossary_terms AS g ON g.title_id = p.title_id AND g.locale = p.locale
    WHERE p.title_id = ${t} AND p.locale = ${l} AND p.target_version = ${V}
      AND position(p.source_text, g.source_term) > 0
      AND position(p.target_text, g.approved_target_term) = 0
    ORDER BY p.cue_id
    LIMIT 50`);

  const q6 = normalizeSql(`
    SELECT cue_id, source_text, target_text, previous_source_text, source_revision, target_version
    FROM ${DB}.source_target_pairs
    WHERE ${scope} AND target_version = ${V} AND source_revision = ${quoteLiteral(R)}
    ORDER BY cue_id
    LIMIT 50`);

  return [
    {
      query_id: 'Q1_LIST_TABLES',
      label: 'Q1',
      tool: 'list_tables',
      collection: null,
      args: { database: DB },
      summary: `Discover tables in ${DB}`,
    },
    {
      query_id: 'Q2_TIMING_OVERLAP',
      label: 'Q2',
      tool: 'run_query',
      collection: 'subtitle_cues',
      args: { query: q2 },
      summary: `Consecutive-cue overlap scan for ${label}`,
    },
    {
      query_id: 'Q3_READING_SPEED',
      label: 'Q3',
      tool: 'run_query',
      collection: 'subtitle_cues',
      args: { query: q3 },
      summary: `Reading-speed (characters per second) scan for ${label}`,
    },
    {
      query_id: 'Q4_GLOSSARY_TERMS',
      label: 'Q4',
      tool: 'run_query',
      collection: 'glossary_terms',
      args: { query: q4 },
      summary: `Approved glossary terms for ${input.title_name ?? T} / ${L}`,
    },
    {
      query_id: 'Q5_GLOSSARY_DRIFT',
      label: 'Q5',
      tool: 'run_query',
      collection: 'source_target_pairs',
      args: { query: q5 },
      summary: `Glossary drift scan (source term present, approved target term missing) for ${label}`,
    },
    {
      query_id: 'Q6_SEMANTIC_CANDIDATES',
      label: 'Q6',
      tool: 'run_query',
      collection: 'source_target_pairs',
      args: { query: q6 },
      summary: `Source/target pairs whose source changed in ${R} after translation, for ${label}`,
    },
  ];
}

export function canonicalize(tool: string, args: unknown): string {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  if (typeof a.query === 'string') return `${tool}::${normalizeSql(a.query)}`;
  if (typeof a.database === 'string') return `${tool}::db=${a.database}`;
  return `${tool}::${JSON.stringify(a)}`;
}

export function sanitizeToolArgs(args: unknown): Record<string, unknown> {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(a)) out[k] = typeof v === 'string' && k === 'query' ? normalizeSql(v) : v;
  return out;
}

export function mcpArgsFor(entry: QueryPlanEntry): Record<string, unknown> {
  return { ...entry.args };
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const A = bigrams(a);
  const B = bigrams(b);
  let inter = 0;
  for (const [g, n] of A) inter += Math.min(n, B.get(g) ?? 0);
  const total = Math.max(1, a.length - 1 + (b.length - 1));
  return (2 * inter) / total;
}

export interface TraceMatch {
  query_id: QueryId | null;
  matched_expected: boolean;
  summary: string;
  collection: string | null;
  entry: QueryPlanEntry | null;
}

export function matchTraceEntry(plan: QueryPlan, tool: string, args: unknown): TraceMatch {
  const canon = canonicalize(tool, args);
  for (const entry of plan) {
    if (canonicalize(entry.tool, entry.args) === canon) {
      return { query_id: entry.query_id, matched_expected: true, summary: entry.summary, collection: entry.collection, entry };
    }
  }
  let best: { entry: QueryPlanEntry; score: number } | null = null;
  for (const entry of plan) {
    if (entry.tool !== tool) continue;
    const score = similarity(canonicalize(entry.tool, entry.args), canon);
    if (!best || score > best.score) best = { entry, score };
  }
  if (best && best.score > 0.5) {
    return {
      query_id: best.entry.query_id,
      matched_expected: false,
      summary: `${best.entry.summary} (agent variant - differs from the expected query)`,
      collection: best.entry.collection,
      entry: best.entry,
    };
  }
  return { query_id: null, matched_expected: false, summary: `Unplanned ${tool} call`, collection: null, entry: null };
}

export function missingQueries(plan: QueryPlan, matchedIds: Iterable<QueryId | null>): QueryPlanEntry[] {
  const have = new Set([...matchedIds].filter((x): x is QueryId => x !== null));
  return QUERY_ORDER.map((id) => plan.find((p) => p.query_id === id)).filter((p): p is QueryPlanEntry => !!p && !have.has(p.query_id));
}

export function buildInstruction(plan: QueryPlan, database: string): string {
  const lines = plan.map((p) => `${p.label} ${p.tool}: ${JSON.stringify(p.args)}`);
  return [
    'You are the LocaleLock Live release-gate query executor. You have read-only ClickHouse tools provided by the official mcp-clickhouse server.',
    `Execute the following query plan EXACTLY, in order, one tool call per query, passing every argument verbatim. Do not modify, reformat, or re-order the SQL. Do not add LIMIT clauses. Do not run any other query. The database is "${database}".`,
    ...lines,
    'After Q6 has returned, reply with exactly one sentence: "Query plan complete: Q1-Q6 executed." Do not analyze, judge, summarize, or transform the rows - deterministic evaluation happens in the application, and semantic review is a separate step.',
  ].join('\n');
}
