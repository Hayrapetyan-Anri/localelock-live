export const TITLE_ID = 'tt_last_tram' as const;
export const TITLE_NAME = 'The Last Tram' as const;
export const HERO_LOCALE = 'es' as const;
export const HERO_LOCALE_NAME = 'Spanish (Latin America)' as const;
export const HERO_VERSION = 7 as const;
export const LATEST_SOURCE_REVISION = 'r3' as const;
export const CPS_LIMIT = 20 as const;
export const MIN_CUE_GAP_MS = 80 as const;
export const SYNTHETIC_DISCLAIMER =
  'Synthetic demo data - The Last Tram is original fictional content. No real studio, vendor, or customer data.' as const;

export type ReleaseState = 'HELD' | 'READY' | 'RUNNING' | 'FAILED';

export type RunPhase =
  | 'event_received'
  | 'querying_clickhouse'
  | 'deterministic_qc'
  | 'gemini_semantic_review'
  | 'producer_decision'
  | 'complete'
  | 'failed';

export const RUN_PHASE_ORDER: RunPhase[] = [
  'event_received',
  'querying_clickhouse',
  'deterministic_qc',
  'gemini_semantic_review',
  'producer_decision',
  'complete',
];

export type RunTrigger = 'vendor_delivery' | 'source_revision' | 'recheck_after_approval' | 'manual';

export type RuleId = 'TIMING_OVERLAP' | 'READING_SPEED' | 'GLOSSARY_DRIFT' | 'SEMANTIC_REVERSAL';

export type Severity = 'blocker' | 'high' | 'medium' | 'low' | 'info';

export type FindingStatus = 'open' | 'approved' | 'rejected' | 'resolved';

export type FindingSource = 'deterministic_query' | 'gemini_semantic_review';

export type QueryId =
  | 'Q1_LIST_TABLES'
  | 'Q2_TIMING_OVERLAP'
  | 'Q3_READING_SPEED'
  | 'Q4_GLOSSARY_TERMS'
  | 'Q5_GLOSSARY_DRIFT'
  | 'Q6_SEMANTIC_CANDIDATES';

export type EventType =
  | 'script_locked'
  | 'source_revision'
  | 'vendor_delivery'
  | 'release_scheduled'
  | 'release_gate_run'
  | 'approved_version_ingested';

export type SemanticVerdict = 'MEANING_PRESERVED' | 'MEANING_SHIFTED' | 'MEANING_REVERSED';

export interface SubtitleCue {
  title_id: string;
  locale: string;
  cue_id: number;
  version: number;
  start_ms: number;
  end_ms: number;
  text: string;
  source_revision: string;
}

export interface SourceTargetPair {
  title_id: string;
  cue_id: number;
  source_text: string;
  target_text: string;
  locale: string;
  source_revision: string;
  target_version: number;
  previous_source_text?: string;
}

export interface GlossaryTerm {
  title_id: string;
  locale: string;
  source_term: string;
  approved_target_term: string;
  note?: string;
}

export interface LocalizationEvent {
  event_id: string;
  title_id: string;
  locale: string;
  event_type: EventType;
  source_revision: string;
  target_version: number | null;
  occurred_at: string;
  summary: string;
  actor?: string;
  run_id?: string;
}

export interface ToolTraceEntry {
  step: number;
  kind: 'mcp_tool_call';
  initiator: 'adk_agent' | 'app_fallback';
  server: 'mcp-clickhouse';
  server_version: string;
  tool: string;
  query_id: QueryId | null;
  database: string;
  collection: string | null;
  query_summary: string;
  query: unknown;
  started_at: string;
  duration_ms: number;
  ok: boolean;
  error: string | null;
  row_count: number;
  rows_preview: unknown[];
  matched_expected: boolean;
}

export interface AgentTrace {
  framework: 'google-adk';
  adk_version: string;
  genai_sdk_version: string;
  model: string;
  backend: 'vertex-ai' | 'gemini-api';
  project: string | null;
  location: string | null;
  app_name: string;
  session_id: string;
  agent_name: string;
  llm_turns: number;
  total_tool_calls: number;
  started_at: string;
  duration_ms: number;
  final_text: string | null;
  warnings: string[];
}

export interface SemanticReviewInput {
  cue_id: number;
  locale: string;
  source_language: 'en';
  source_text: string;
  target_text: string;
  previous_source_text: string | null;
  source_revision: string;
  target_version: number;
}

export interface SemanticReviewOutput {
  verdict: SemanticVerdict;
  severity: 'low' | 'medium' | 'high';
  confidence: number;
  explanation: string;
  suggested_target_text: string | null;
}

export interface SemanticReview {
  framework: 'google-adk';
  agent_name: 'semantic_reviewer';
  model: string;
  backend: 'vertex-ai' | 'gemini-api';
  input: SemanticReviewInput;
  output: SemanticReviewOutput;
  raw_text: string | null;
  started_at: string;
  latency_ms: number;
}

export interface TimingOverlapEvidence {
  rule: 'TIMING_OVERLAP';
  cue_id: number;
  next_cue_id: number;
  cue_start_ms: number;
  cue_end_ms: number;
  next_start_ms: number;
  overlap_ms: number;
  min_gap_ms: number;
}

export interface ReadingSpeedEvidence {
  rule: 'READING_SPEED';
  cue_id: number;
  text: string;
  chars: number;
  duration_ms: number;
  cps: number;
  limit_cps: number;
}

export interface GlossaryDriftEvidence {
  rule: 'GLOSSARY_DRIFT';
  cue_id: number;
  source_term: string;
  approved_target_term: string;
  found_term: string;
  edit_distance: number;
  source_text: string;
  target_text: string;
}

export interface SemanticEvidence {
  rule: 'SEMANTIC_REVERSAL';
  cue_id: number;
  source_text: string;
  target_text: string;
  previous_source_text: string | null;
  source_revision: string;
  target_version: number;
  narrowing_rule: string;
  review: SemanticReview;
}

export type FindingEvidence =
  | TimingOverlapEvidence
  | ReadingSpeedEvidence
  | GlossaryDriftEvidence
  | SemanticEvidence;

export interface CueSnapshot {
  start_ms: number;
  end_ms: number;
  text: string;
}

export interface ProposedRepair {
  kind: 'trim_out_time' | 'extend_out_time' | 'replace_text';
  cue_id: number;
  summary: string;
  before: CueSnapshot;
  after: CueSnapshot;
  origin: 'deterministic' | 'gemini_suggestion';
  requires_human_approval: true;
  verification: Record<string, number | string | boolean>;
}

export interface Finding {
  finding_id: string;
  run_id: string;
  title_id: string;
  locale: string;
  version: number;
  cue_id: number;
  rule_id: RuleId;
  severity: Severity;
  is_blocker: boolean;
  source: FindingSource;
  confidence: number;
  headline: string;
  detail: string;
  evidence: FindingEvidence;
  proposed_repair: ProposedRepair | null;
  evidence_ref: { trace_step: number | null; query_id: QueryId | null };
  status: FindingStatus;
  created_at: string;
  priority: number;
}

export interface RunPhaseRecord {
  phase: RunPhase;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  note: string | null;
}

export interface RunError {
  phase: RunPhase;
  message: string;
  retryable: boolean;
  hint: string | null;
}

export interface ApprovalDecision {
  finding_id: string;
  cue_id: number;
  rule_id: RuleId;
  decision: 'approve' | 'reject';
}

export interface SrtExport {
  filename: string;
  bytes: number;
  sha256: string;
  cue_count: number;
  url: string;
}

export interface ApprovalRecord {
  approval_batch_id: string;
  run_id: string;
  reviewer: string;
  approved_at: string;
  decisions: ApprovalDecision[];
  approved_version: number;
  patch_hash: string;
  srt: SrtExport;
  ingested: {
    subtitle_cues: number;
    source_target_pairs: number;
    localization_events: number;
  };
  event_id: string;
}

export interface ReleaseRun {
  run_id: string;
  title_id: string;
  locale: string;
  version: number;
  trigger: RunTrigger;
  trigger_event_id: string | null;
  parent_run_id: string | null;
  recheck_run_id: string | null;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  phase: RunPhase;
  phases: RunPhaseRecord[];
  release_state: ReleaseState;
  blocker_count: number;
  finding_count: number;
  findings: Finding[];
  trace: ToolTraceEntry[];
  agent: AgentTrace | null;
  semantic_review: SemanticReview | null;
  semantic_candidates: number | null;
  approval: ApprovalRecord | null;
  error: RunError | null;
  origin: 'seed_baseline' | 'release_gate';
  dataset: { synthetic_rows_total: number; disclaimer: string };
}

export interface DatasetStats {
  synthetic_rows_total: number;
  counts: Record<string, number>;
  titles: number;
  locales: number;
  disclaimer: string;
  computed_at: string;
}

export interface DemoState {
  title: {
    title_id: string;
    name: string;
    runtime_min: number;
    logline: string;
    source_language: 'en';
    latest_source_revision: string;
  };
  delivery: {
    locale: string;
    locale_name: string;
    version: number;
    vendor: string;
    delivered_at: string;
    release_at: string;
    minutes_to_release: number;
    file: { filename: string; cue_count: number; url: string };
  };
  incoming_event: LocalizationEvent;
  recent_events: LocalizationEvent[];
  release: {
    state: ReleaseState;
    blocker_count: number;
    version: number;
    as_of_run_id: string | null;
    as_of: string;
    origin: 'seed_baseline' | 'release_gate';
  };
  latest_run: ReleaseRun | null;
  approved_version: number | null;
  dataset: DatasetStats;
  now: string;
}

export interface CreateRunRequest {
  title_id?: string;
  locale?: string;
  trigger?: RunTrigger;
}

export interface CreateRunResponse {
  run_id: string;
  status: 'queued';
  poll_url: string;
}

export interface ApprovalRequest {
  reviewer: string;
  decisions: Array<{ finding_id: string; decision: 'approve' | 'reject' }>;
}

export interface ApprovalResponse {
  approval: ApprovalRecord;
  run: ReleaseRun;
  idempotent: boolean;
}

export interface RecheckResponse {
  run_id: string;
  parent_run_id: string;
  status: 'queued' | 'existing';
  poll_url: string;
}

export interface ResetResponse {
  ok: true;
  removed: Record<string, number>;
  state: DemoState;
}

export interface CatalogQueryStat {
  label: string;
  sql: string;
  rows_read: number;
  bytes_read: number;
  elapsed_ms: number;
}

export interface LocaleRisk {
  locale: string;
  cues: number;
  reading_speed_risks: number;
  overlap_risks: number;
  risk_pct: number;
}

export interface RiskyDelivery {
  title_id: string;
  title_name: string;
  locale: string;
  version: number;
  cues: number;
  reading_speed_risks: number;
  max_cps: number;
  is_hero: boolean;
}

export interface DeliveryRiskCue {
  cue_id: number;
  start_ms: number;
  end_ms: number;
  text: string;
  chars: number;
  duration_ms: number;
  cps: number;
}

export interface DeliveryRisk {
  title_id: string;
  locale: string;
  version: number;
  cues: DeliveryRiskCue[];
  query: CatalogQueryStat;
}

export interface CatalogRisk {
  by_locale: LocaleRisk[];
  deliveries: RiskyDelivery[];
  totals: {
    titles: number;
    locales: number;
    versions: number;
    cues_scanned: number;
    reading_speed_risks: number;
    overlap_risks: number;
  };
  queries: CatalogQueryStat[];
  scanned_rows: number;
  elapsed_ms: number;
  hero: { title_id: string; locale: string };
  computed_at: string;
}

export interface ApiError {
  error: {
    code:
      | 'NOT_FOUND'
      | 'BAD_REQUEST'
      | 'RUN_NOT_COMPLETE'
      | 'RUN_NOT_HELD'
      | 'DECISIONS_INCOMPLETE'
      | 'REJECTED'
      | 'APPROVAL_IN_PROGRESS'
      | 'NOT_APPROVED'
      | 'UNAUTHORIZED'
      | 'RATE_LIMITED'
      | 'GEMINI_NOT_CONFIGURED'
      | 'INTERNAL';
    message: string;
    details?: unknown;
  };
}

export interface HealthResponse {
  ok: boolean;
  service: 'localelock-live';
  version: string;
  time: string;
  runtime: {
    mode: 'lambda' | 'local';
    node: string;
    region: string | null;
    function: string | null;
  };
  clickhouse: {
    ok: boolean;
    latency_ms: number | null;
    database: string;
    host_hint: string | null;
    version: string | null;
    counts: Record<string, number>;
    synthetic_rows_total: number;
    agent_user: string;
    agent_read_only: boolean;
    error: string | null;
  };
  gemini: {
    configured: boolean;
    backend: 'vertex-ai' | 'gemini-api' | null;
    project: string | null;
    location: string | null;
    model: string;
    ok: boolean | null;
    latency_ms: number | null;
    error: string | null;
  };
  mcp: {
    server: 'mcp-clickhouse';
    version: string;
    read_only: true;
    tools_allowed: string[];
    ok: boolean | null;
    latency_ms: number | null;
    error: string | null;
  };
  adk: { framework: 'google-adk'; version: string; agents: string[] };
  agent_db_boundary: string;
  demo: { reset_requires_key: boolean; seed_requires_key: true };
}

export interface JudgeStatus {
  health: HealthResponse;
  state: DemoState;
  links: { app: string; judge: string; repo: string | null; api: string };
  architecture: string[];
  test_steps: string[];
}
