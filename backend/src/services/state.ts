import { hostname } from 'node:os';
import {
  AGENT_DB_BOUNDARY,
  APP_NAME,
  HERO_LOCALE,
  HERO_LOCALE_NAME,
  HERO_TITLE_META,
  HERO_VENDOR,
  HERO_VERSION,
  LATEST_SOURCE_REVISION,
  MCP_SERVER_NAME,
  RELEASE_GATE_AGENT_NAME,
  SEMANTIC_REVIEWER_AGENT_NAME,
  SYNTHETIC_DISCLAIMER,
  TITLE_ID,
  TITLE_NAME,
  type DatasetStats,
  type DemoState,
  type HealthResponse,
  type JudgeStatus,
  type LocalizationEvent,
} from '../domain/constants.js';
import { datasetStats, readMeta } from '../domain/seed.js';
import { getBuildInfo, getConfig, hostHint } from '../config.js';
import { clickhouseVersion, ensureSchema, pingClickHouse, query } from '../db/clickhouse.js';
import { slugifyTitle } from '../domain/srt.js';
import { HERO_CUE_COUNT } from '../domain/hero.js';
import { rowToEvent } from '../db/rows.js';
import { latestRun } from './runs.js';
import { geminiBackendInfo, probeGemini } from '../agent/gemini.js';
import { MCP_TOOLS_ALLOWED, mcpServerVersion, probeMcpServer } from '../agent/mcp.js';
import { heroReleaseAt } from '../domain/hero.js';

const STATS_TTL_MS = 60_000;
let statsCache: { at: number; value: DatasetStats } | null = null;

export async function cachedDatasetStats(): Promise<DatasetStats> {
  if (statsCache && Date.now() - statsCache.at < STATS_TTL_MS) return statsCache.value;
  const meta = await readMeta();
  const value = meta?.dataset_stats ?? (await datasetStats());
  statsCache = { at: Date.now(), value };
  return value;
}

export function invalidateStatsCache(): void {
  statsCache = null;
}

export async function getDemoState(): Promise<DemoState> {
  await ensureSchema();
  const now = new Date();
  const scope = { title_id: TITLE_ID, locale: HERO_LOCALE };
  const [meta, eventRows, run, dataset, approvedRow, lastCompleteRow] = await Promise.all([
    readMeta(),
    query<Record<string, unknown>>(
      'SELECT * FROM {db:Identifier}.localization_events WHERE title_id = {title_id:String} AND locale = {locale:String} ORDER BY occurred_at DESC LIMIT 12',
      scope,
      { final: true },
    ),
    latestRun(TITLE_ID, HERO_LOCALE),
    cachedDatasetStats(),
    query<{ v: string }>(
      "SELECT max(JSONExtractInt(approval_json, 'approved_version')) AS v FROM {db:Identifier}.release_runs WHERE title_id = {title_id:String} AND locale = {locale:String} AND approval_json != ''",
      scope,
      { final: true },
    ),
    query<{ blocker_count: string }>(
      "SELECT blocker_count FROM {db:Identifier}.release_runs WHERE title_id = {title_id:String} AND locale = {locale:String} AND release_state IN ('HELD', 'READY') ORDER BY started_at DESC LIMIT 1",
      scope,
      { final: true },
    ),
  ]);
  const events: LocalizationEvent[] = eventRows.map(rowToEvent);
  if (!meta || events.length === 0) {
    throw new Error('Demo dataset is not seeded - run `npm run seed` (or POST /admin/seed with X-Demo-Key)');
  }
  const incoming = events.find((e) => e.event_type === 'vendor_delivery' && e.target_version === HERO_VERSION);
  const T0 = new Date(meta.t0 ?? meta.seeded_at);
  const release_at = meta.release_at ? new Date(meta.release_at) : heroReleaseAt(T0);
  const approvedRaw = Number(approvedRow[0]?.v ?? 0);
  const approved_version = approvedRaw > 0 ? approvedRaw : null;

  let blocker_count = run?.blocker_count ?? 0;
  if (run && (run.release_state === 'RUNNING' || run.release_state === 'FAILED')) {
    blocker_count = lastCompleteRow.length ? Number(lastCompleteRow[0].blocker_count) : 0;
  }

  return {
    title: {
      title_id: TITLE_ID,
      name: TITLE_NAME,
      runtime_min: HERO_TITLE_META.runtime_min,
      logline: HERO_TITLE_META.logline,
      source_language: 'en',
      latest_source_revision: LATEST_SOURCE_REVISION,
    },
    delivery: {
      locale: HERO_LOCALE,
      locale_name: HERO_LOCALE_NAME,
      version: HERO_VERSION,
      vendor: HERO_VENDOR,
      delivered_at: incoming?.occurred_at ?? T0.toISOString(),
      release_at: release_at.toISOString(),
      minutes_to_release: Math.round((release_at.getTime() - now.getTime()) / 60_000),
      file: {
        filename: `${slugifyTitle(TITLE_NAME)}.${HERO_LOCALE}.v${HERO_VERSION}.delivered.srt`,
        cue_count: HERO_CUE_COUNT,
        url: `/deliveries/${TITLE_ID}/${HERO_LOCALE}/${HERO_VERSION}.srt`,
      },
    },
    incoming_event: (incoming ?? events[0]) as LocalizationEvent,
    recent_events: events.slice(0, 8) as LocalizationEvent[],
    release: {
      state: run?.release_state ?? 'HELD',
      blocker_count,
      version: run?.version ?? HERO_VERSION,
      as_of_run_id: run?.run_id ?? null,
      as_of: run?.ended_at ?? run?.started_at ?? now.toISOString(),
      origin: run?.origin ?? 'seed_baseline',
    },
    latest_run: run,
    approved_version,
    dataset,
    now: now.toISOString(),
  };
}

export async function getHealth(opts: { deep?: boolean } = {}): Promise<HealthResponse> {
  const cfg = await getConfig();
  const build = getBuildInfo();
  const gem = geminiBackendInfo(cfg);
  const ch: HealthResponse['clickhouse'] = {
    ok: false,
    latency_ms: null,
    database: cfg.clickhouse.database,
    host_hint: hostHint(cfg.clickhouse.host),
    version: null,
    counts: {},
    synthetic_rows_total: 0,
    agent_user: cfg.clickhouse.agentUser,
    agent_read_only: !cfg.clickhouse.agentFallback,
    error: null,
  };
  try {
    const ping = await pingClickHouse();
    ch.latency_ms = ping.latency_ms;
    ch.version = ping.version ?? (await clickhouseVersion());
    if (!ping.ok) throw new Error(ping.error ?? 'ClickHouse ping failed');
    const stats = await cachedDatasetStats();
    ch.counts = stats.counts;
    ch.synthetic_rows_total = stats.synthetic_rows_total;
    ch.ok = true;
  } catch (err) {
    ch.error = (err as Error).message.slice(0, 300);
  }

  const gemini: HealthResponse['gemini'] = { configured: gem.configured, backend: gem.backend, project: gem.project, location: gem.location, model: gem.model, ok: null, latency_ms: null, error: null };
  const mcp: HealthResponse['mcp'] = { server: MCP_SERVER_NAME, version: build.mcp_clickhouse_version && build.mcp_clickhouse_version !== 'unknown' ? build.mcp_clickhouse_version : mcpServerVersion(), read_only: true, tools_allowed: [...MCP_TOOLS_ALLOWED], ok: null, latency_ms: null, error: null };

  if (opts.deep) {
    const [g, m] = await Promise.all([probeGemini(8_000, cfg), probeMcpServer({ timeoutMs: 22_000, config: cfg })]);
    gemini.ok = g.ok;
    gemini.latency_ms = g.latency_ms;
    gemini.error = g.error;
    mcp.ok = m.ok;
    mcp.latency_ms = m.latency_ms;
    mcp.error = m.error;
    if (m.ok && m.version && m.version !== 'unknown') mcp.version = m.version;
    if (m.ok) {
      const missing = MCP_TOOLS_ALLOWED.filter((t) => !m.tools.includes(t));
      const writeTools = m.tools.filter((t) => /insert|update|delete|drop|create|rename|export/i.test(t));
      if (missing.length) mcp.error = `missing expected tools: ${missing.join(', ')}`;
      if (writeTools.length) mcp.error = `write tools are exposed despite --readOnly: ${writeTools.join(', ')}`;
      if (missing.length || writeTools.length) mcp.ok = false;
    }
  }

  const ok = ch.ok && (opts.deep ? mcp.ok === true && (gemini.ok === true || !gemini.configured) : true);
  return {
    ok,
    service: 'localelock-live',
    version: `${build.version}${build.git_sha ? `+${build.git_sha.slice(0, 7)}` : ''}`,
    time: new Date().toISOString(),
    runtime: { mode: cfg.mode, node: process.version, region: cfg.region, function: cfg.functionName ?? (cfg.mode === 'local' ? hostname() : null) },
    clickhouse: ch,
    gemini,
    mcp,
    adk: { framework: 'google-adk', version: build.adk_version, agents: [RELEASE_GATE_AGENT_NAME, SEMANTIC_REVIEWER_AGENT_NAME] },
    agent_db_boundary: AGENT_DB_BOUNDARY,
    demo: { reset_requires_key: cfg.resetRequiresKey, seed_requires_key: true },
  };
}

export async function getJudgeStatus(opts: { apiBase: string; appOrigin?: string | null }): Promise<JudgeStatus> {
  const cfg = await getConfig();
  const [health, state] = await Promise.all([getHealth({ deep: true }), getDemoState()]);
  const origin = (cfg.appUrl ?? opts.appOrigin ?? '').replace(/\/$/, '');
  const app = origin || '/';
  const judge = origin ? `${origin}/judge` : '/judge';
  return {
    health,
    state,
    links: { app, judge, repo: cfg.publicRepoUrl, api: opts.apiBase },
    architecture: [
      `A vendor delivery (${TITLE_NAME} / ${HERO_LOCALE_NAME} v${HERO_VERSION}) or a source revision triggers POST /runs; the API persists a release run and invokes the worker.`,
      `The worker runs a Google ADK LlmAgent (${RELEASE_GATE_AGENT_NAME}, ${health.gemini.model} on ${health.gemini.backend ?? 'Gemini'}) whose only tools come from the official ${MCP_SERVER_NAME} ${health.mcp.version}, started with CLICKHOUSE_ALLOW_WRITE_ACCESS=false and connected as a SELECT-only ClickHouse user.`,
      'The agent executes the fixed six-query plan through two tools - list_tables once for discovery, then five run_query calls; every MCP call is captured into the run trace with the exact SQL and returned rows.',
      'Deterministic rules (timing overlap, reading speed, glossary drift) are evaluated in the application from the MCP rows - Gemini never decides them.',
      `Only the pair whose source changed in ${LATEST_SOURCE_REVISION} is escalated to the ADK ${SEMANTIC_REVIEWER_AGENT_NAME} agent, which returns a structured verdict (meaning reversed / shifted / preserved) with a suggested line.`,
      'A producer approves each repair; the app applies them deterministically, exports the corrected SRT (sha256 patch hash), and ingests the approved version on its own write connection.',
      'A recheck run repeats the same MCP query plan on the approved version and persists READY / 0 blockers - the state survives refresh because it is a stored release run.',
      `${state.dataset.synthetic_rows_total.toLocaleString('en-US')} synthetic rows across ${state.dataset.titles} titles (44 generated catalog titles plus ${TITLE_NAME}) and ${state.dataset.locales} locales; release-gate queries always filter by title/locale/version, while the catalog view scans the whole table.`,
    ],
    test_steps: [
      `Open ${app === '/' ? 'the app' : app} - the catalog view scans every delivery in ClickHouse; ${TITLE_NAME} / ${HERO_LOCALE_NAME} / v${HERO_VERSION} is the one with a release window open. Click "Open release gate".`,
      `The banner shows the persisted state. From a fresh reset that is RELEASE HELD - 4 blockers; after a completed approval and recheck it is READY TO RELEASE - 0 blockers. Right now it is ${state.release.state === 'READY' ? 'READY TO RELEASE' : state.release.state === 'HELD' ? 'RELEASE HELD' : state.release.state} - ${state.release.blocker_count} blocker${state.release.blocker_count === 1 ? '' : 's'}; use "Reset demo" in the footer to return to the held starting point.`,
      'Click "Run release gate" and watch the phases and the MCP tool trace fill in (Q1-Q6, rows returned).',
      'Review the four evidence cards: cue 118 overlaps 119 by 420 ms, cue 204 at 24.6 CPS, "Maria Voss" vs glossary "Mara Voss", and the Gemini semantic reversal for cue 231.',
      'Approve the four repairs and click "Export corrected SRT and recheck"; download the SRT (its sha256 equals the patch hash).',
      'Wait for the recheck run to finish: READY TO RELEASE - 0 blockers. Refresh the page - the state is reloaded from ClickHouse.',
      'Use "Reset demo" in the footer (or POST /admin/reset) to return to HELD / 4 and repeat.',
    ],
  };
}

export { APP_NAME, SYNTHETIC_DISCLAIMER };
