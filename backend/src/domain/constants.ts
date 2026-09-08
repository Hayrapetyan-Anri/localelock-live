export * from '../../../shared/types.js';
import type { RuleId, QueryId } from '../../../shared/types.js';

export const RULE_PRIORITY: Record<RuleId, number> = {
  TIMING_OVERLAP: 1,
  READING_SPEED: 2,
  GLOSSARY_DRIFT: 3,
  SEMANTIC_REVERSAL: 4,
};

export const RULE_QUERY: Record<RuleId, QueryId> = {
  TIMING_OVERLAP: 'Q2_TIMING_OVERLAP',
  READING_SPEED: 'Q3_READING_SPEED',
  GLOSSARY_DRIFT: 'Q5_GLOSSARY_DRIFT',
  SEMANTIC_REVERSAL: 'Q6_SEMANTIC_CANDIDATES',
};

export const QUERY_ORDER: QueryId[] = [
  'Q1_LIST_TABLES',
  'Q2_TIMING_OVERLAP',
  'Q3_READING_SPEED',
  'Q4_GLOSSARY_TERMS',
  'Q5_GLOSSARY_DRIFT',
  'Q6_SEMANTIC_CANDIDATES',
];

export const SEMANTIC_FALLBACK_TARGET_TEXT = 'No lo envíes todavía.';

export const HERO_TITLE_META = {
  runtime_min: 12,
  logline:
    'On the night the road closes, dispatcher Mara Voss signs for the last tram up the hill so driver Teo Aldana can carry a girl and a crate of medicine to the hospital before the storm turns.',
  source_language: 'en' as const,
};

export const HERO_VENDOR = 'Synthetic vendor: Meridian Subs (fictional)';
export const HERO_DIRECTOR_ACTOR = "Director's office";
export const BASELINE_RUN_ID = 'run_baseline_v7';

export const SEED_VERSION = 'v7-hero-2026-09-07-1';
export const PRNG_SEED = 20260907;
export const RESET_COOLDOWN_MS = 15_000;
export const RUN_DEDUPE_WINDOW_MS = 3 * 60_000;
export const INSERT_BATCH_SIZE = 5_000;

export const COLLECTION_NAMES = [
  'subtitle_cues',
  'source_target_pairs',
  'glossary_terms',
  'localization_events',
  'qc_findings',
  'release_runs',
  'approvals',
  'demo_meta',
] as const;
export type CollectionName = (typeof COLLECTION_NAMES)[number];

export const SYNTHETIC_ROW_COLLECTIONS: CollectionName[] = [
  'subtitle_cues',
  'source_target_pairs',
  'glossary_terms',
  'localization_events',
  'qc_findings',
  'release_runs',
];

export const APP_NAME = 'localelock-live';
export const RELEASE_GATE_AGENT_NAME = 'release_gate_agent';
export const SEMANTIC_REVIEWER_AGENT_NAME = 'semantic_reviewer';
export const MCP_SERVER_NAME = 'mcp-clickhouse' as const;

export const AGENT_DB_BOUNDARY =
  'The Google ADK agent reaches ClickHouse only through the official mcp-clickhouse server, started with CLICKHOUSE_ALLOW_WRITE_ACCESS=false and connected as the dedicated localelock_agent user, which holds only GRANT SELECT on the localelock database and runs with readonly=1. Two independent layers refuse writes. All writes - findings, approvals, corrected-version ingestion, events - are performed by the application on its own connection, after explicit human approval.';
