import type {
  AgentTrace,
  ApprovalRecord,
  DatasetStats,
  Finding,
  FindingEvidence,
  LocalizationEvent,
  ProposedRepair,
  QueryId,
  ReleaseRun,
  RunError,
  RunPhase,
  RunPhaseRecord,
  SemanticReview,
  ToolTraceEntry,
} from '../domain/constants.js';
import { fromUInt8, parseJsonColumn, toIso, toJsonColumn, toUInt8 } from './clickhouse.js';

export type RunDoc = Omit<ReleaseRun, 'findings'> & {
  approval_lock?: { at: string; reviewer: string } | null;
  pipeline_lock?: { at: string; by: string } | null;
};

export type FindingDoc = Finding & { evidence_json: string };

export interface ApprovalDoc {
  approval_id: string;
  approval_batch_id: string;
  run_id: string;
  cue_id: number;
  finding_id: string;
  rule_id: string;
  decision: 'approve' | 'reject';
  reviewer: string;
  approved_at: string;
  patch_hash: string | null;
}

export interface DemoMetaDoc {
  id: 'demo';
  seeded_at: string;
  seed_version: string;
  last_reset_at: string | null;
  t0: string;
  release_at: string;
  dataset_stats: DatasetStats;
  seed_duration_ms: number;
}

const num = (v: unknown, fallback = 0): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : v == null ? fallback : String(v));
const nowIso = (): string => new Date().toISOString();

const orNull = (v: unknown): string | null => {
  const s = str(v);
  return s === '' ? null : s;
};

export function runToRow(run: RunDoc, updated_at = nowIso()): Record<string, unknown> {
  return {
    run_id: run.run_id,
    title_id: run.title_id,
    locale: run.locale,
    version: run.version,
    trigger: run.trigger,
    trigger_event_id: run.trigger_event_id ?? '',
    parent_run_id: run.parent_run_id ?? '',
    recheck_run_id: run.recheck_run_id ?? '',
    started_at: run.started_at,
    ended_at: toIso(run.ended_at),
    duration_ms: run.duration_ms ?? null,
    phase: run.phase,
    phases_json: toJsonColumn(run.phases ?? []),
    release_state: run.release_state,
    blocker_count: run.blocker_count,
    finding_count: run.finding_count,
    trace_json: toJsonColumn(run.trace ?? []),
    agent_json: run.agent ? toJsonColumn(run.agent) : '',
    semantic_review_json: run.semantic_review ? toJsonColumn(run.semantic_review) : '',
    semantic_candidates: run.semantic_candidates ?? null,
    approval_json: run.approval ? toJsonColumn(run.approval) : '',
    error_json: run.error ? toJsonColumn(run.error) : '',
    origin: run.origin,
    dataset_json: toJsonColumn(run.dataset ?? {}),
    pipeline_lock_json: run.pipeline_lock ? toJsonColumn(run.pipeline_lock) : '',
    approval_lock_json: run.approval_lock ? toJsonColumn(run.approval_lock) : '',
    updated_at,
  };
}

export function rowToRun(row: Record<string, unknown>): RunDoc {
  return {
    run_id: str(row.run_id),
    title_id: str(row.title_id),
    locale: str(row.locale),
    version: num(row.version),
    trigger: str(row.trigger) as RunDoc['trigger'],
    trigger_event_id: orNull(row.trigger_event_id),
    parent_run_id: orNull(row.parent_run_id),
    recheck_run_id: orNull(row.recheck_run_id),
    started_at: toIso(row.started_at as string) ?? nowIso(),
    ended_at: toIso(row.ended_at as string | null),
    duration_ms: row.duration_ms == null ? null : num(row.duration_ms),
    phase: str(row.phase) as RunPhase,
    phases: parseJsonColumn<RunPhaseRecord[]>(row.phases_json as string, []),
    release_state: str(row.release_state) as RunDoc['release_state'],
    blocker_count: num(row.blocker_count),
    finding_count: num(row.finding_count),
    trace: parseJsonColumn<ToolTraceEntry[]>(row.trace_json as string, []),
    agent: parseJsonColumn<AgentTrace | null>(row.agent_json as string, null),
    semantic_review: parseJsonColumn<SemanticReview | null>(row.semantic_review_json as string, null),
    semantic_candidates: row.semantic_candidates == null ? null : num(row.semantic_candidates),
    approval: parseJsonColumn<ApprovalRecord | null>(row.approval_json as string, null),
    error: parseJsonColumn<RunError | null>(row.error_json as string, null),
    origin: str(row.origin) as RunDoc['origin'],
    dataset: parseJsonColumn<RunDoc['dataset']>(row.dataset_json as string, { synthetic_rows_total: 0, disclaimer: '' }),
    pipeline_lock: parseJsonColumn<{ at: string; by: string } | null>(row.pipeline_lock_json as string, null),
    approval_lock: parseJsonColumn<{ at: string; reviewer: string } | null>(row.approval_lock_json as string, null),
  };
}

export function toPublicRun(doc: RunDoc, findings: Finding[]): ReleaseRun {
  const { approval_lock: _a, pipeline_lock: _p, ...rest } = doc;
  return { ...rest, findings };
}

export function findingToRow(f: Finding, updated_at = nowIso()): Record<string, unknown> {
  return {
    run_id: f.run_id,
    finding_id: f.finding_id,
    title_id: f.title_id,
    locale: f.locale,
    version: f.version,
    cue_id: f.cue_id,
    rule_id: f.rule_id,
    severity: f.severity,
    is_blocker: toUInt8(f.is_blocker),
    source: f.source,
    confidence: f.confidence,
    headline: f.headline,
    detail: f.detail,
    evidence_json: toJsonColumn(f.evidence),
    proposed_repair_json: f.proposed_repair ? toJsonColumn(f.proposed_repair) : '',
    evidence_ref_json: toJsonColumn(f.evidence_ref ?? { trace_step: null, query_id: null }),
    status: f.status,
    priority: f.priority,
    created_at: f.created_at,
    updated_at,
  };
}

export function rowToFinding(row: Record<string, unknown>): Finding {
  return {
    finding_id: str(row.finding_id),
    run_id: str(row.run_id),
    title_id: str(row.title_id),
    locale: str(row.locale),
    version: num(row.version),
    cue_id: num(row.cue_id),
    rule_id: str(row.rule_id) as Finding['rule_id'],
    severity: str(row.severity) as Finding['severity'],
    is_blocker: fromUInt8(row.is_blocker as number),
    source: str(row.source) as Finding['source'],
    confidence: num(row.confidence),
    headline: str(row.headline),
    detail: str(row.detail),
    evidence: parseJsonColumn<FindingEvidence>(row.evidence_json as string, {} as FindingEvidence),
    proposed_repair: parseJsonColumn<ProposedRepair | null>(row.proposed_repair_json as string, null),
    evidence_ref: parseJsonColumn<{ trace_step: number | null; query_id: QueryId | null }>(row.evidence_ref_json as string, {
      trace_step: null,
      query_id: null,
    }),
    status: str(row.status) as Finding['status'],
    created_at: toIso(row.created_at as string) ?? nowIso(),
    priority: num(row.priority),
  };
}

export function approvalToRow(a: ApprovalDoc, updated_at = nowIso()): Record<string, unknown> {
  return {
    approval_id: a.approval_id,
    approval_batch_id: a.approval_batch_id,
    run_id: a.run_id,
    cue_id: a.cue_id,
    finding_id: a.finding_id,
    rule_id: a.rule_id,
    decision: a.decision,
    reviewer: a.reviewer,
    approved_at: a.approved_at,
    patch_hash: a.patch_hash ?? '',
    updated_at,
  };
}

export function rowToApproval(row: Record<string, unknown>): ApprovalDoc {
  return {
    approval_id: str(row.approval_id),
    approval_batch_id: str(row.approval_batch_id),
    run_id: str(row.run_id),
    cue_id: num(row.cue_id),
    finding_id: str(row.finding_id),
    rule_id: str(row.rule_id),
    decision: str(row.decision) as ApprovalDoc['decision'],
    reviewer: str(row.reviewer),
    approved_at: toIso(row.approved_at as string) ?? nowIso(),
    patch_hash: orNull(row.patch_hash),
  };
}

export function eventToRow(e: LocalizationEvent): Record<string, unknown> {
  return {
    event_id: e.event_id,
    title_id: e.title_id,
    locale: e.locale,
    event_type: e.event_type,
    source_revision: e.source_revision,
    target_version: e.target_version ?? null,
    occurred_at: e.occurred_at,
    summary: e.summary,
    actor: e.actor ?? '',
    run_id: e.run_id ?? '',
  };
}

export function rowToEvent(row: Record<string, unknown>): LocalizationEvent {
  return {
    event_id: str(row.event_id),
    title_id: str(row.title_id),
    locale: str(row.locale),
    event_type: str(row.event_type) as LocalizationEvent['event_type'],
    source_revision: str(row.source_revision),
    target_version: row.target_version == null ? null : num(row.target_version),
    occurred_at: toIso(row.occurred_at as string) ?? nowIso(),
    summary: str(row.summary),
    actor: orNull(row.actor) ?? undefined,
    run_id: orNull(row.run_id) ?? undefined,
  };
}

export function metaToRow(m: DemoMetaDoc, updated_at = nowIso()): Record<string, unknown> {
  return {
    id: m.id,
    seeded_at: m.seeded_at,
    seed_version: m.seed_version,
    last_reset_at: toIso(m.last_reset_at),
    dataset_stats_json: toJsonColumn(m.dataset_stats),
    t0: m.t0,
    release_at: m.release_at,
    seed_duration_ms: m.seed_duration_ms,
    updated_at,
  };
}

export function rowToMeta(row: Record<string, unknown>): DemoMetaDoc {
  return {
    id: 'demo',
    seeded_at: toIso(row.seeded_at as string) ?? nowIso(),
    seed_version: str(row.seed_version),
    last_reset_at: toIso(row.last_reset_at as string | null),
    t0: toIso(row.t0 as string) ?? nowIso(),
    release_at: toIso(row.release_at as string) ?? nowIso(),
    dataset_stats: parseJsonColumn<DatasetStats>(row.dataset_stats_json as string, {
      synthetic_rows_total: 0,
      counts: {},
      titles: 0,
      locales: 0,
      disclaimer: '',
      computed_at: nowIso(),
    }),
    seed_duration_ms: num(row.seed_duration_ms),
  };
}
